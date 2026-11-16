import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Report } from './quality-gates-fixtures'
import {
  deny,
  distributions,
  fixture,
  git,
  packageRoot,
  repository,
  run,
  scripts,
  write,
} from './quality-gates-fixtures'

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

    it.each(['inc', 'cu', 'cuh', 'pl', 'pm'])('classifies changed %s fragments as code', (ext) => {
      const root = repository()
      const source = write(root, `src/fragment.${ext}`, 'REGISTER_ITEM(value)\n')
      const result = run(distribution, 'change', [source], root)
      expect(result.output.changes).toContainEqual(
        expect.objectContaining({ path: `src/fragment.${ext}`, is_code: true })
      )
    })

    it.each(['working', 'staged', 'committed'])('classifies dotfile configuration changes in %s mode', (mode) => {
      const root = repository()
      const configs = ['.editorconfig', '.prettierrc', 'nested/.EDITORCONFIG', '.prettierrc.json']
      for (const name of [...configs, 'src/tool']) {
        write(root, name, 'value\n')
      }
      if (mode !== 'working') {
        git(root, 'add', '.')
      }
      if (mode === 'committed') {
        git(root, 'commit', '-qm', 'test: configuration changes')
      }
      const result = run(distribution, 'change', [root, '--mode', mode], tmpdir())
      expect(result.status).toBe(0)
      for (const name of configs) {
        expect(result.output.changes).toContainEqual(expect.objectContaining({ path: name, is_config: true }))
      }
      expect(result.output.changes).toContainEqual(expect.objectContaining({ path: 'src/tool', is_config: false }))
      expect(result.output.issues).toContainEqual(
        expect.objectContaining({
          severity: 'info',
          message: '配置文件有变更，请确认是否需要更新文档',
          related_files: expect.arrayContaining(configs),
        })
      )
    })

    it('limits the missing-test notice to the requested paths', () => {
      const root = repository()
      const source = write(
        root,
        'src/clean.ts',
        Array.from({ length: 35 }, (_, index) => `export const value${index} = ${index}`).join('\n') + '\n'
      )
      const test = write(root, 'tests/clean.test.ts', 'test("value", () => {})\n')
      const scoped = run(distribution, 'change', [source], root)
      expect(scoped.output.requested_paths).toEqual([source])
      expect(scoped.output.issues).toContainEqual(
        expect.objectContaining({
          severity: 'warning',
          message: expect.stringContaining('本次检查范围内代码变更'),
        })
      )
      expect(scoped.output.issues).toContainEqual(
        expect.objectContaining({
          message: expect.stringContaining('将测试目录加入检查范围'),
        })
      )
      const combined = run(distribution, 'change', [source, test], root)
      expect(combined.output.issues?.some((issue) => issue.message.includes('未包含测试变更'))).toBe(false)
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
      for (const name of unusual) {
        write(root, name, 'before\n')
      }
      write(root, 'src/x.ts', 'before\n')
      git(root, 'add', '.')
      git(root, 'commit', '-qm', 'test: unusual names')
      for (const name of unusual) {
        write(root, name, 'after\n')
      }
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

    it('uses explicit historical refs for source, linked documents and Rust inline tests', () => {
      const root = repository()
      const source = 'module/src/lib.rs'
      write(
        root,
        source,
        'pub fn value() -> i32 { 1 }\n#[cfg(test)]\nmod tests {\n    #[test]\n    fn value_test() {}\n}\n'
      )
      write(root, 'module/README.md', '# Module\n\n[Details](docs/details.md)\n')
      write(root, 'module/docs/details.md', '# Details\n\nInitial\n')
      git(root, 'add', '.')
      git(root, 'commit', '-qm', 'test: historical module')
      const base = git(root, 'rev-parse', 'HEAD')
      write(
        root,
        source,
        'pub fn value() -> i32 {\n' +
          '    let _ = 1;\n'.repeat(60) +
          '    2\n}\n#[cfg(test)]\nmod tests {\n    #[test]\n    fn updated_test() {}\n}\n'
      )
      write(root, 'module/docs/details.md', '# Details\n\nUpdated\n')
      git(root, 'add', '.')
      git(root, 'commit', '-qm', 'test: compared target')
      const target = git(root, 'rev-parse', 'HEAD')
      git(root, 'rm', '-qr', 'module')
      git(root, 'commit', '-qm', 'test: unrelated current tree')
      const result = run(
        distribution,
        'change',
        [join(root, source), '--mode', 'committed', '--base', base, '--target-ref', target],
        tmpdir()
      )
      expect(result.status).toBe(0)
      expect(result.output).toMatchObject({ complete: true, affected_modules: ['module'] })
      expect(result.output.changes).toEqual([
        expect.objectContaining({
          path: source,
          has_test_changes: true,
          test_only: false,
        }),
      ])
      expect(result.output.doc_sync).toMatchObject({
        'module/README.md': { exists: true, updated: false },
        'module/docs/details.md': { exists: true, updated: true },
      })
      expect(result.output.issues?.some((entry) => entry.message.includes('相关文档未更新'))).toBe(false)
    })

    it.each([
      ['--base', 'HEAD'],
      ['--target-ref', 'HEAD'],
      ['--mode', 'working', '--base', 'HEAD', '--target-ref', 'HEAD'],
      ['--mode', 'committed', '--base', 'HEAD', '--base', 'HEAD', '--target-ref', 'HEAD'],
      ['--mode', 'committed', '--base', 'HEAD', '--target-ref', 'HEAD^{tree}'],
      ['--mode', 'committed', '--base', 'missing-reference', '--target-ref', 'HEAD'],
    ])('rejects an invalid explicit ref contract: %j', (...args) => {
      const root = repository()
      const result = run(distribution, 'change', [root, ...args], root)
      expect(result.status).toBe(2)
      expect(result.output).toMatchObject({ complete: false, passed: false })
    })

    it.each([false, true])(
      'keeps valid results when an explicit ref is absent in another repository (reversed=%s)',
      (reversed) => {
        const first = repository()
        const second = repository()
        git(first, 'tag', 'comparison-target')
        const targets = reversed ? [second, first] : [first, second]
        const result = run(
          distribution,
          'change',
          [...targets, '--mode', 'committed', '--base', 'HEAD', '--target-ref', 'comparison-target'],
          tmpdir()
        )
        expect(result.status).toBe(2)
        expect(result.output).toMatchObject({
          complete: false,
          passed: false,
          error: expect.stringContaining('comparison-target'),
          coverage: targets.map((target) => ({ path: target, complete: target === first, passed: target === first })),
        })
        expect(result.output.repositories).toContainEqual(
          expect.objectContaining({
            repository_root: first,
            complete: true,
            passed: true,
            changes: [],
          })
        )
        expect(result.output.repositories).toContainEqual(
          expect.objectContaining({
            repository_root: second,
            complete: false,
            passed: false,
            error: expect.any(String),
          })
        )
      }
    )

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

    it.each(['working', 'staged', 'committed'])(
      'keeps valid repository results with non-Git targets in %s mode',
      (mode) => {
        const root = repository()
        const source = write(root, 'src/clean.ts', 'updated\n')
        const outside = write(fixture(), 'outside file.ts')
        if (mode !== 'working') {
          git(root, 'add', 'src/clean.ts')
        }
        if (mode === 'committed') {
          git(root, 'commit', '-qm', 'test: update source')
        }
        for (const targets of [
          [source, outside],
          [outside, source],
        ]) {
          const result = run(distribution, 'change', [...targets, '--mode', mode], tmpdir())
          expect(result.status).toBe(2)
          expect(result.output).toMatchObject({
            complete: false,
            passed: false,
            error: expect.any(String),
            repositories: [
              {
                repository_root: root,
                requested_paths: [source],
                complete: true,
                passed: true,
                changes: [expect.objectContaining({ path: 'src/clean.ts', additions: 1, deletions: 1 })],
              },
            ],
            coverage: targets.map((target) =>
              target === source
                ? { path: source, repository_root: root, complete: true, passed: true }
                : { path: outside, complete: false, passed: false, error: expect.any(String) }
            ),
          })
        }
      }
    )

    it('keeps literal paths after -- when a non-Git target fails', () => {
      const root = repository()
      write(root, '--source.ts', 'updated\n')
      const outside = write(fixture(), 'outside file.ts')
      const result = run(distribution, 'change', ['--', '--source.ts', outside], root)
      expect(result.status).toBe(2)
      expect(result.output).toMatchObject({
        complete: false,
        passed: false,
        repositories: [
          {
            repository_root: root,
            complete: true,
            changes: [expect.objectContaining({ path: '--source.ts', additions: 1 })],
          },
        ],
        coverage: [
          { path: join(root, '--source.ts'), complete: true },
          { path: outside, complete: false, error: expect.any(String) },
        ],
      })
    })

    it('rejects targets outside the repository returned by Git', () => {
      const root = fixture()
      const source = write(root, 'source.ts')
      const outside = fixture()
      const preload = write(
        root,
        'repository-boundary.cjs',
        `
const cp = require('node:child_process');
const original = cp.execFileSync;
cp.execFileSync = function(file, args, options) {
  if (file === 'git' && args.includes('--show-toplevel')) return ${JSON.stringify(outside + '\n')};
  return original.call(this, file, args, options);
};\n`
      )
      const result = run(distribution, 'change', [source], root, preload)
      expect(result.status).toBe(2)
      expect(result.output).toMatchObject({
        complete: false,
        passed: false,
        repositories: [],
        error: 'Target is outside the resolved repository: ' + source,
      })
    })

    it('reports every non-Git target without substituting the cwd repository', () => {
      const root = repository()
      const outside = fixture()
      const targets = [outside, write(outside, 'outside.ts')]
      const result = run(distribution, 'change', targets, root)
      expect(result.status).toBe(2)
      expect(result.output).toMatchObject({
        complete: false,
        passed: false,
        error: expect.any(String),
        repositories: [],
        coverage: targets.map((target) => ({
          path: target,
          complete: false,
          passed: false,
          error: expect.any(String),
        })),
      })
    })

    it.each(['read', 'git'])('keeps other repository results after a %s failure', (failure) => {
      const first = repository()
      const source = write(first, 'src/clean.ts', 'updated\n')
      const second = repository()
      const denied = write(second, 'src/unreadable.ts')
      const preload =
        failure === 'read'
          ? deny(second, 'readFileSync', denied)
          : write(
              second,
              'git-denial.cjs',
              `
const cp = require('node:child_process');
const original = cp.execFileSync;
cp.execFileSync = function(file, args, options) {
  if (file === 'git' && options.cwd === ${JSON.stringify(second)} && args.includes('status')) {
    throw new Error('Injected Git denial');
  }
  return original.call(this, file, args, options);
};\n`
            )
      const error = failure === 'read' ? 'Injected read denial' : 'Injected Git denial'
      for (const targets of [
        [source, denied],
        [denied, source],
      ]) {
        const result = run(distribution, 'change', targets, tmpdir(), preload)
        expect(result.status).toBe(2)
        expect(result.output).toMatchObject({
          complete: false,
          passed: false,
          error,
          coverage: targets.map((target) =>
            target === source
              ? { path: source, repository_root: first, complete: true, passed: true }
              : { path: denied, repository_root: second, complete: false, passed: false, error }
          ),
        })
        expect(result.output.repositories).toContainEqual(
          expect.objectContaining({
            repository_root: first,
            complete: true,
            passed: true,
            changes: [expect.objectContaining({ path: 'src/clean.ts' })],
          })
        )
        expect(result.output.repositories).toContainEqual(
          expect.objectContaining({
            repository_root: second,
            complete: false,
            passed: false,
            error,
          })
        )
      }
    })

    it('prints the failed target and retains the valid text report', () => {
      const root = repository()
      const outside = write(fixture(), 'outside file.ts')
      const script = join(packageRoot, distribution, scripts.change)
      const result = spawnSync(process.execPath, [script, outside, root], { cwd: tmpdir(), encoding: 'utf8' })
      expect(result.status).toBe(2)
      expect(result.stdout).toContain('Repository: ' + root)
      expect(result.stderr).toContain(outside)
      expect(result.stderr).toContain('rev-parse --show-toplevel')
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

    it('includes explicitly requested Git-ignored files without expanding directory scans', () => {
      const root = repository()
      write(root, '.gitignore', 'generated/\n')
      git(root, 'add', '.gitignore')
      git(root, 'commit', '-qm', 'test: ignore generated files')
      const source = write(root, 'generated/replay [sample].cpp', 'int first;\nint second;\n')
      write(root, 'generated/unrequested.cpp', 'int excluded;\n')
      const before = git(root, 'status', '--porcelain=v1')
      const implicit = run(distribution, 'change', [root], root)
      expect(implicit.output.changes).toEqual([])
      const explicit = run(distribution, 'change', [source], root)
      expect(explicit.status).toBe(0)
      expect(explicit.output.changes).toEqual([
        expect.objectContaining({
          path: 'generated/replay [sample].cpp',
          type: 'added',
          additions: 2,
          deletions: 0,
          is_code: true,
          is_ignored: true,
        }),
      ])
      expect(explicit.output.issues).toContainEqual(
        expect.objectContaining({
          severity: 'info',
          message: expect.stringContaining('显式指定的 Git 忽略文件'),
        })
      )
      const combined = run(distribution, 'change', [root, source, source], root)
      expect(combined.output.changes).toEqual(explicit.output.changes)
      expect(run(distribution, 'change', [join(root, 'generated')], root).status).toBe(2)
      expect(run(distribution, 'change', [source, '--mode', 'staged'], root).status).toBe(2)
      expect(run(distribution, 'change', [source, '--mode', 'committed'], root).status).toBe(2)
      expect(git(root, 'status', '--porcelain=v1')).toBe(before)
    })

    it('keeps staged deletions and the current ignored replacement in one record', () => {
      const root = repository()
      const source = write(root, 'generated/replay.cpp', 'int old;\n')
      git(root, 'add', 'generated/replay.cpp')
      git(root, 'commit', '-qm', 'test: track generated source')
      git(root, 'rm', '--cached', 'generated/replay.cpp')
      write(root, '.gitignore', 'generated/\n')
      write(root, 'generated/replay.cpp', 'int first;\nint second;\n')
      const before = git(root, 'status', '--porcelain=v1')
      const result = run(distribution, 'change', [source], root)
      expect(result.status).toBe(0)
      expect(result.output.changes).toEqual([
        expect.objectContaining({
          path: 'generated/replay.cpp',
          type: 'modified',
          additions: 2,
          deletions: 1,
          is_ignored: true,
        }),
      ])
      expect(git(root, 'status', '--porcelain=v1')).toBe(before)
    })

    it('counts an explicitly selected ignored module document as updated', () => {
      const root = repository()
      write(root, '.gitignore', 'generated/\n')
      const source = write(root, 'generated/example.cpp', 'int value;\n'.repeat(60))
      const readme = write(root, 'generated/README.md', '# Generated module\n\nCurrent usage.\n')
      const result = run(distribution, 'change', [source, readme], root)
      expect(result.status).toBe(0)
      expect(result.output.doc_sync?.['generated/README.md']).toEqual({ exists: true, updated: true })
    })

    it('reports unreadable explicitly requested Git-ignored files', () => {
      const root = repository()
      write(root, '.gitignore', 'generated/\n')
      const source = write(root, 'generated/replay.cpp', 'int value;\n')
      const result = run(distribution, 'change', [source], root, deny(root, 'readFileSync', source))
      expect(result.status).toBe(2)
      expect(result.output).toMatchObject({ complete: false, passed: false, error: 'Injected read denial' })
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

    it('keeps existing fixture findings when adjacent lines change', () => {
      const root = repository()
      const source = write(root, 'tests/fixture.test.ts', '// Previous setup\n' + bad + '// Previous assertions\n')
      git(root, 'add', '.')
      git(root, 'commit', '-qm', 'test: record fixture baseline')
      write(root, 'tests/fixture.test.ts', '// Updated setup\n\n' + bad + '// Updated assertions\n')
      const result = run(distribution, gate, [source], root)
      expect(result.output.origin_counts).toEqual({ existing: 1, new: 0, unclassified: 0 })
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
      if (initialized) {
        git(root, 'init', '-q')
      }
      const source = write(root, 'source.ts', bad)
      const result = run(distribution, gate, [source], root)
      expect(result.output).toMatchObject({ complete: true, files_scanned: 1, origin_counts: { unclassified: 1 } })
      expect(result.output.baseline?.every((entry) => entry.status === 'unavailable')).toBe(true)
      expect(run(distribution, gate, [source, '--base', 'HEAD'], root).status).toBe(2)
    })

    it('records every file after a cached repository lookup failure', () => {
      const root = fixture()
      const sources = [write(root, 'first.ts', bad), write(root, 'second.ts', bad)]
      const result = run(distribution, gate, sources, root)
      expect(result.output).toMatchObject({
        complete: true,
        files_scanned: 2,
        origin_counts: { new: 0, existing: 0, unclassified: 2 },
      })
      expect(result.output.baseline).toEqual(
        sources.map((source) => expect.objectContaining({ path: source, status: 'unavailable', ref: 'HEAD' }))
      )
      const explicit = run(distribution, gate, [...sources, '--base', 'HEAD'], root)
      expect(explicit.status).toBe(2)
      expect(explicit.output.scan_errors).toEqual(
        sources.map((source) => expect.objectContaining({ path: source, code: 'BASELINE_UNAVAILABLE' }))
      )
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
