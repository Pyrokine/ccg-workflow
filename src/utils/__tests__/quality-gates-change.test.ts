import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  packageRoot,
  distributions,
  scripts,
  fixture,
  write,
  git,
  repository,
  run,
  deny,
} from './quality-gates-fixtures'
import type { Report } from './quality-gates-fixtures'

describe.each(distributions)('%s quality gates', (distribution) => {
  describe('change analysis', () => {
    it('allows genuine empty working and staged changes', () => {
      const root = repository()
      for (const mode of ['working', 'staged']) {
        const result = run(distribution, 'change', [root, '--mode', mode], tmpdir())
        expect(result.status).toBe(0)
        expect(result.output).toMatchObject({ complete: true, passed: true, changes: [], repository_root: root })
      }
    })

    it('resolves cwd, file scopes, multiple paths and untracked line counts', () => {
      const root = repository()
      const file = write(root, 'src/clean.ts', 'export const value = 2\nexport const extra = 3\n')
      write(root, 'src/new/nested.ts', 'one\ntwo\nthree')
      write(root, 'other/clean.ts', 'export const value = 4\n')
      const outside = fixture()
      const scoped = run(distribution, 'change', [join(root, 'src')], outside)
      expect(scoped.status).toBe(0)
      expect(scoped.output.changes?.map((change) => change.path).sort()).toEqual(['src/clean.ts', 'src/new/nested.ts'])
      expect(scoped.output.changes).toContainEqual(expect.objectContaining({ path: 'src/new/nested.ts', additions: 3 }))
      const single = run(distribution, 'change', [file], outside)
      expect(single.output.changes?.map((change) => change.path)).toEqual(['src/clean.ts'])
      const defaultScope = run(distribution, 'change', [], join(root, 'src'))
      expect(defaultScope.output.changes).toEqual(scoped.output.changes)
      const multiple = run(distribution, 'change', [file, join(root, 'other')], outside)
      expect(multiple.output.changes?.map((change) => change.path).sort()).toEqual(['other/clean.ts', 'src/clean.ts'])
    })

    it('counts staged and unstaged edits without reading a nonexistent staged file', () => {
      const root = repository()
      write(root, 'src/clean.ts', 'export const value = 2\n')
      git(root, 'add', 'src/clean.ts')
      write(root, 'src/clean.ts', 'export const value = 3\nexport const extra = 4\n')
      const staged = run(distribution, 'change', [root, '--mode=staged'], root)
      expect(staged.status).toBe(0)
      expect(staged.output).toMatchObject({ total_additions: 1, total_deletions: 1 })
      const working = run(distribution, 'change', [root], root)
      expect(working.status).toBe(0)
      expect(working.output).toMatchObject({ total_additions: 3, total_deletions: 2 })
      write(root, 'gone.ts', 'one\n')
      git(root, 'add', 'gone.ts')
      rmSync(join(root, 'gone.ts'))
      write(root, 'empty.ts', '')
      git(root, 'add', 'empty.ts')
      rmSync(join(root, 'empty.ts'))
      expect(run(distribution, 'change', [root], root).status).toBe(0)
    })

    it('preserves unusual names, literal pathspecs and rename statistics', () => {
      const root = repository()
      const unusual = [
        'src/ space.ts',
        'src/制表\tfile.ts',
        'src/line\nbreak.ts',
        'src/name -> target.ts',
        'src/[x].ts',
      ]
      for (const name of unusual) write(root, name, 'before\n')
      write(root, 'src/x.ts', 'before\n')
      git(root, 'add', '.')
      git(root, 'commit', '-qm', 'test: unusual names')
      for (const name of unusual) write(root, name, 'after\n')
      write(root, 'src/x.ts', 'after\n')
      const result = run(distribution, 'change', [join(root, 'src')], root)
      expect(result.status).toBe(0)
      expect(result.output.changes?.map((change) => change.path).sort()).toEqual([...unusual, 'src/x.ts'].sort())
      expect(result.output.changes?.every((change) => change.additions === 1 && change.deletions === 1)).toBe(true)
      const literal = run(distribution, 'change', [join(root, 'src/[x].ts')], root)
      expect(literal.output.changes?.map((change) => change.path)).toEqual(['src/[x].ts'])
      git(root, 'mv', 'src/clean.ts', 'src/renamed.ts')
      const staged = run(distribution, 'change', [root, '--mode', 'staged'], root)
      expect(staged.output.changes).toContainEqual(
        expect.objectContaining({
          path: 'src/renamed.ts',
          old_path: 'src/clean.ts',
          type: 'renamed',
          additions: 0,
          deletions: 0,
        })
      )
    })

    it('analyzes committed changes and deleted path scopes', () => {
      const root = repository()
      git(root, 'rm', '-q', 'src/clean.ts')
      write(root, 'other/clean.ts', 'export const value = 5\n')
      git(root, 'add', '.')
      git(root, 'commit', '-qm', 'test: change fixture')
      const result = run(distribution, 'change', [join(root, 'src/clean.ts'), '--mode', 'committed'], tmpdir())
      expect(result.status).toBe(0)
      expect(result.output.changes).toEqual([
        expect.objectContaining({ path: 'src/clean.ts', type: 'deleted', additions: 0, deletions: 1 }),
      ])
    })

    it('reports embedded repositories without traversing their metadata', () => {
      const root = repository()
      const nested = join(root, 'nested')
      mkdirSync(nested)
      git(nested, 'init', '-q')
      write(nested, 'source.ts')
      const result = run(distribution, 'change', [root], root)
      expect(result.status).toBe(0)
      expect(result.output.changes).toEqual([
        expect.objectContaining({ path: 'nested/', type: 'added', additions: 0, deletions: 0 }),
      ])
    })

    it('groups targets in different repositories', () => {
      const first = repository()
      const second = repository()
      write(first, 'src/clean.ts', 'first\n')
      write(second, 'other/clean.ts', 'second\n')
      const result = run(distribution, 'change', [join(first, 'src'), join(second, 'other')], tmpdir())
      expect(result.status).toBe(0)
      expect(result.output).toMatchObject({ complete: true, passed: true })
      expect(result.output.repositories?.map((report) => report.repository_root)).toEqual([first, second])
    })

    it('reports non-Git targets, missing paths, invalid modes and missing parent revisions', () => {
      const root = repository()
      const outside = fixture()
      const inputs = [[outside], [join(root, 'missing.ts')], [root, '--mode', 'invalid'], [root, '--mode', 'committed']]
      for (const args of inputs) {
        const result = run(distribution, 'change', args, root)
        expect(result.status).toBe(2)
        expect(result.output).toMatchObject({ complete: false, passed: false, error: expect.any(String) })
      }
    })

    it('propagates invalid explicit revisions through the existing Git helper', () => {
      const root = repository()
      const script = join(packageRoot, distribution, scripts.change)
      const result = spawnSync(
        process.execPath,
        ['-e', 'require(process.argv[1]).getGitChanges("invalid-revision", "HEAD", process.argv[2])', script, root],
        { encoding: 'utf8' }
      )
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('invalid-revision')
    })

    it('reports unreadable untracked files instead of zero additions', () => {
      const root = repository()
      const source = write(root, 'src/new.ts')
      const result = run(distribution, 'change', [source], root, deny(root, 'readFileSync', source))
      expect(result.status).toBe(2)
      expect(result.output).toMatchObject({ complete: false, passed: false, error: 'Injected read denial' })
    })
  })

  describe.each(['quality', 'security'] as const)('%s Git baseline', (gate) => {
    const bad = gate === 'quality' ? `const text = '${'x'.repeat(130)}'\n` : 'document.body.innerHTML = input\n'
    const findings = (report: Report) => report.findings || report.issues || []

    it('matches moved findings and counts newly duplicated occurrences', () => {
      const root = repository()
      const source = write(root, 'src/clean.ts', bad)
      git(root, 'add', '.')
      git(root, 'commit', '-qm', 'test: existing finding')
      write(root, 'src/clean.ts', '\n\n' + bad.repeat(2))
      const result = run(distribution, gate, [source], root)
      expect(result.output).toMatchObject({ complete: true, origin_counts: { existing: 1, new: 1, unclassified: 0 } })
      expect(result.output.baseline).toContainEqual(expect.objectContaining({ status: 'available', ref: 'HEAD' }))
      expect(result.status).toBe(gate === 'security' ? 1 : 0)
    })

    it('recognizes staged renames while preserving finding identity', () => {
      const root = repository()
      write(root, 'src/clean.ts', bad)
      git(root, 'add', '.')
      git(root, 'commit', '-qm', 'test: existing source')
      git(root, 'mv', 'src/clean.ts', 'src/renamed.ts')
      const source = write(root, 'src/renamed.ts', '\n' + bad)
      const result = run(distribution, gate, [source], root)
      expect(result.output.origin_counts).toEqual({ existing: 1, new: 0, unclassified: 0 })
      expect(findings(result.output)[0]?.origin).toBe('existing')
    })

    it('handles new literal filenames and explicit comparison revisions', () => {
      const root = repository()
      const source = write(root, 'src/[new]\t名\nfile.ts', bad)
      expect(run(distribution, gate, [source], root).output.origin_counts?.new).toBe(1)
      git(root, 'add', '.')
      git(root, 'commit', '-qm', 'test: add finding')
      expect(run(distribution, gate, [source], root).output.origin_counts?.existing).toBe(1)
      const previous = run(distribution, gate, [source, '--base', 'HEAD~1'], root)
      expect(previous.output.origin_counts?.new).toBe(1)
      const invalid = run(distribution, gate, [source, '--base=missing-reference'], root)
      expect(invalid.status).toBe(2)
      expect(invalid.output).toMatchObject({ complete: false, passed: false, files_scanned: 1 })
      expect(invalid.output.scan_errors).toContainEqual(expect.objectContaining({ code: 'BASELINE_UNAVAILABLE' }))
    })

    it.each([false, true])('scans without a baseline when Git HEAD is absent (repository=%s)', (initialized) => {
      const root = fixture()
      if (initialized) git(root, 'init', '-q')
      const source = write(root, 'source.ts', bad)
      const result = run(distribution, gate, [source], root)
      expect(result.output).toMatchObject({ complete: true, files_scanned: 1, origin_counts: { unclassified: 1 } })
      expect(result.output.baseline?.every((entry) => entry.status === 'unavailable')).toBe(true)
      expect(run(distribution, gate, [source, '--base', 'HEAD'], root).status).toBe(2)
    })

    it('keeps separate baselines for different repositories', () => {
      const first = repository()
      const old = write(first, 'src/clean.ts', bad)
      git(first, 'add', '.')
      git(first, 'commit', '-qm', 'test: old finding')
      const second = repository()
      const fresh = write(second, 'src/fresh.ts', bad)
      const result = run(distribution, gate, [old, fresh], tmpdir())
      expect(result.output.origin_counts).toEqual({ existing: 1, new: 1, unclassified: 0 })
      expect(result.output.baseline).toHaveLength(2)
    })

    it('does not expose source text from baseline keys or Git errors', () => {
      const root = repository()
      const secret = 'synthetic-baseline-credential-12345'
      const source = write(root, 'src/clean.ts', `${bad}const note = '${secret}'\n`)
      git(root, 'add', '.')
      git(root, 'commit', '-qm', 'test: redact baseline')
      const result = run(distribution, gate, [source], root)
      expect(result.stdout + result.stderr).not.toContain(secret)
      const preload = write(
        root,
        'git-failure.cjs',
        `
const cp = require('node:child_process');
const exec = cp.execFileSync;
cp.execFileSync = function(file, args, options) {
  if (file === 'git' && args.includes('cat-file')) throw new Error(${JSON.stringify(secret)});
  return exec.call(this, file, args, options);
};\n`
      )
      const failed = run(distribution, gate, [source, '--base', 'HEAD'], root, preload)
      expect(failed.status).toBe(2)
      expect(failed.stdout + failed.stderr).not.toContain(secret)
    })
  })

  it('keeps external diagnostics unclassified while reporting changed-line association', async () => {
    const root = repository()
    const source = write(root, 'src/clean.ts', 'first()\nsecond()\n')
    git(root, 'add', '.')
    git(root, 'commit', '-qm', 'test: baseline tool association')
    write(root, 'src/clean.ts', 'changed()\nsecond()\n')
    const library = await import(join(packageRoot, distribution, 'lib/git-baseline.js'))
    const issues = [1, 2].map((line) => ({
      tool: 'eslint',
      rule_id: 'sample',
      severity: 'error',
      file_path: source,
      line_number: line,
    }))
    const result = library.compareBaseline([source], issues, () => [])
    expect(result.origin_counts).toEqual({ new: 0, existing: 0, unclassified: 2 })
    expect(issues).toMatchObject([
      { origin: 'unclassified', change_scope: 'changed_lines' },
      { origin: 'unclassified', change_scope: 'unchanged_lines' },
    ])
  })
})
