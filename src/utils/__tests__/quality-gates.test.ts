import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
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
  completeModule,
} from './quality-gates-fixtures'
import type { Gate } from './quality-gates-fixtures'

describe.each(distributions)('%s quality gates', (distribution) => {
  describe.each(['quality', 'security'] as const)('%s coverage', (gate) => {
    it('scans a single file, directories and overlapping targets once', () => {
      const root = fixture()
      const first = write(root, 'src/first.ts')
      write(root, 'src/nested/second.py', 'answer = 42\n')
      const single = run(distribution, gate, [first], root)
      expect(single.status).toBe(0)
      expect(single.output).toMatchObject({ complete: true, passed: true, files_scanned: 1, scan_errors: [] })
      const multiple = run(distribution, gate, [join(root, 'src'), first, join(root, 'src/nested')], root)
      expect(multiple.status).toBe(0)
      expect(multiple.output).toMatchObject({ complete: true, passed: true, files_scanned: 2, scan_errors: [] })
    })

    it.each(['empty', 'docs', 'missing', 'unsupported'])('reports incomplete coverage for %s targets', (kind) => {
      const root = fixture()
      const clean = write(root, 'clean.ts')
      let target: string
      let code: string
      if (kind === 'empty') {
        target = join(root, 'empty')
        mkdirSync(target)
        code = 'NO_SUPPORTED_FILES'
      } else if (kind === 'docs') {
        target = join(root, 'docs')
        write(target, 'README.md', '# Documentation\n')
        code = 'NO_SUPPORTED_FILES'
      } else if (kind === 'missing') {
        target = join(root, 'missing.ts')
        code = 'ENOENT'
      } else {
        target = write(root, 'source.kt', 'val value = 1\n')
        code = 'UNSUPPORTED_TYPE'
      }
      const result = run(distribution, gate, [clean, target], root)
      expect(result.status).toBe(2)
      expect(result.output).toMatchObject({ complete: false, passed: false, files_scanned: 1 })
      expect(result.output.scan_errors).toContainEqual(expect.objectContaining({ path: target, code }))
      const alone = run(distribution, gate, [target], root)
      expect(alone.status).toBe(2)
      expect(alone.output).toMatchObject({ complete: false, passed: false, files_scanned: 0 })
    })

    it('reports unsupported source files inside an otherwise covered directory', () => {
      const root = fixture()
      write(root, 'src/clean.ts')
      const unsupported = write(root, 'src/unhandled.kt', 'val answer = 42\n')
      const result = run(distribution, gate, [join(root, 'src')], root)
      expect(result.status).toBe(2)
      expect(result.output).toMatchObject({ complete: false, passed: false, files_scanned: 1 })
      expect(result.output.scan_errors).toContainEqual(
        expect.objectContaining({ path: unsupported, code: 'UNSUPPORTED_TYPE' })
      )
    })

    it.each(['readFileSync', 'readdirSync', 'statSync', 'realpathSync'])('reports %s failures', (method) => {
      const root = fixture()
      const source = write(root, 'src/blocked.ts')
      const target = method === 'readdirSync' ? dirname(source) : source
      const result = run(distribution, gate, [target], root, deny(root, method, target))
      expect(result.status).toBe(2)
      expect(result.output).toMatchObject({ complete: false, passed: false, files_scanned: 0 })
      expect(result.output.scan_errors).toContainEqual(expect.objectContaining({ path: target, code: 'EACCES' }))
    })

    it('preserves partial results when one file cannot be read', () => {
      const root = fixture()
      write(root, 'src/clean.ts')
      const blocked = write(root, 'src/blocked.py', 'value = 42\n')
      const result = run(distribution, gate, [dirname(blocked)], root, deny(root, 'readFileSync', blocked))
      expect(result.status).toBe(2)
      expect(result.output).toMatchObject({ complete: false, passed: false, files_scanned: 1 })
      expect(result.output.scan_errors).toContainEqual(expect.objectContaining({ path: blocked, code: 'EACCES' }))
    })

    it('honors directory exclusions and explicitly requested excluded files', () => {
      const root = fixture()
      const clean = write(root, 'src/clean.ts')
      const ignored = write(root, 'src/vendor/unhandled.kt')
      write(root, 'src/node_modules/unhandled.kt')
      const result = run(distribution, gate, [dirname(clean), '--exclude', 'vendor'], root)
      expect(result.status).toBe(0)
      expect(result.output.files_scanned).toBe(1)
      const explicit = run(distribution, gate, [ignored], root)
      expect(explicit.status).toBe(2)
    })

    it('accepts paths after -- and rejects unused flags', () => {
      const root = fixture()
      write(root, '-clean.ts')
      expect(run(distribution, gate, ['--', '-clean.ts'], root).status).toBe(0)
      for (const args of [['--unknown'], ['--mode'], ['--mode', 'working'], ['--exclude']]) {
        const result = run(distribution, gate, args, root)
        expect(result.status).toBe(2)
        expect(result.output).toMatchObject({ complete: false, passed: false, error: expect.any(String) })
      }
    })

    it('skips directory symlinks and deduplicates an explicit file symlink', () => {
      const root = fixture()
      const source = write(root, 'src/clean.ts')
      symlinkSync(join(root, 'src'), join(root, 'src/loop'))
      const alias = join(root, 'alias.ts')
      symlinkSync(source, alias)
      const result = run(distribution, gate, [dirname(source), alias], root)
      expect(result.status).toBe(0)
      expect(result.output.files_scanned).toBe(1)
    })
  })

  it('preserves findings while withholding source text from security output', () => {
    const root = fixture()
    const value = 'synthetic-credential-12345'
    const source = write(root, 'unsafe.ts', `const password = '${value}'; document.body.innerHTML = password\n`)
    const result = run(distribution, 'security', [source], root)
    expect(result.status).toBe(1)
    expect(result.output).toMatchObject({ complete: true, passed: false, files_scanned: 1 })
    expect(result.output.findings).toContainEqual(
      expect.objectContaining({ severity: 'high', line_content: '[redacted]', line_number: 1 })
    )
    expect(result.stdout + result.stderr).not.toContain(value)
    expect(readFileSync(source, 'utf8')).toContain(value)
  })

  it('keeps low severity findings distinct from incomplete scans', () => {
    const root = fixture()
    const source = write(root, 'debug.ts', 'debugger;\n')
    const result = run(distribution, 'security', [source], root)
    expect(result.status).toBe(0)
    expect(result.output).toMatchObject({ complete: true, passed: true, files_scanned: 1 })
    expect(result.output.findings).toContainEqual(expect.objectContaining({ severity: 'low' }))
  })

  it('accepts JSX, module files and C++ headers for generic quality checks', () => {
    const root = fixture()
    for (const extension of ['jsx', 'tsx', 'mjs', 'cjs', 'mts', 'cts', 'h', 'hpp', 'cc']) {
      write(root, `src/source.${extension}`, 'const value = 1\n')
    }
    const result = run(distribution, 'quality', [join(root, 'src')], root)
    expect(result.status).toBe(0)
    expect(result.output).toMatchObject({ complete: true, passed: true, files_scanned: 9 })
  })

  describe('analysis regressions', () => {
    it('leaves normal CLI output to the project lint policy', () => {
      const root = fixture()
      const source = write(root, 'cli.ts', 'console.log("done")\n')
      const result = run(distribution, 'security', [source], root)
      expect(result.status).toBe(0)
      expect(result.output.findings).toEqual([])
    })

    it.each(['js', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts'])('finds actual %s debugger statements only', (ext) => {
      const root = fixture()
      const source = write(
        root,
        `debug.${ext}`,
        'const text = "debugger;"\n// debugger;\n/* debugger; */\nif (ready) { debugger; }\ndebugger\n'
      )
      const result = run(distribution, 'security', [source], root)
      expect(result.status).toBe(0)
      expect(result.output.findings?.map((finding) => finding.line_number)).toEqual([4, 5])
      expect(result.output.findings?.every((finding) => finding.severity === 'low')).toBe(true)
    })

    it.each([
      'const pattern = /debugger;/;',
      'const pattern = /[{}]debugger;/g;',
      'const pattern = /"debugger;"/;',
      String.raw`const pattern = /https?:\/\/debugger;/;`,
      'function pattern() { return /debugger;/; }',
      'const pattern = /* example */ /debugger;/;',
    ])('ignores regular-expression literals: %s', (content) => {
      const root = fixture()
      const source = write(root, 'pattern.js', content + '\n')
      expect(spawnSync(process.execPath, ['--check', source], { encoding: 'utf8' }).status).toBe(0)
      const result = run(distribution, 'security', [source], root)
      expect(result.output.findings).toEqual([])
    })

    it.each([
      'const value = left / right; debugger; const other = left / right;',
      'const value = "text" / right; debugger; const other = left / right;',
      'const value = /pattern/ / right; debugger; const other = left / right;',
    ])('retains debugger statements after division: %s', (content) => {
      const root = fixture()
      const source = write(root, 'division.js', content + '\n')
      expect(spawnSync(process.execPath, ['--check', source], { encoding: 'utf8' }).status).toBe(0)
      const result = run(distribution, 'security', [source], root)
      expect(result.output.findings).toHaveLength(1)
      expect(result.output.findings?.[0]).toMatchObject({ rule_id: 'DEBUG_CODE', line_number: 1 })
    })

    it('keeps Python breakpoint calls without reporting quoted examples', () => {
      const root = fixture()
      const source = write(
        root,
        'debug.py',
        'example = "breakpoint()"\n# pdb.set_trace()\nbreakpoint()\npdb.set_trace()\n'
      )
      const result = run(distribution, 'security', [source], root)
      expect(result.output.findings?.map((finding) => finding.line_number)).toEqual([3, 4])
    })

    it('does not request implementation documentation for test-only changes', () => {
      const root = repository()
      write(root, 'README.md', '# Project\n')
      write(root, 'tests/behavior.test.ts', 'testCase()\n'.repeat(60))
      const result = run(distribution, 'change', [root], root)
      expect(result.output.issues?.filter((issue) => /DESIGN|README|文档/.test(issue.message))).toEqual([])
    })

    it('keeps implementation filenames containing test-like substrings in document checks', () => {
      const root = repository()
      write(root, 'README.md', '# Project\n')
      git(root, 'add', '.')
      git(root, 'commit', '-qm', 'test: existing documentation')
      write(root, 'src/latest_version.ts', 'doWork()\n'.repeat(60))
      const result = run(distribution, 'change', [root], root)
      expect(result.output.changes).toContainEqual(
        expect.objectContaining({ path: 'src/latest_version.ts', is_test: false })
      )
      expect(result.output.issues).toContainEqual(
        expect.objectContaining({ message: expect.stringContaining('相关文档未更新') })
      )
    })

    it('recognizes the nearest documented module', () => {
      const root = repository()
      write(root, 'packages/README.md', '# Packages\n')
      write(root, 'packages/feature/README.md', '# Feature\n')
      git(root, 'add', '.')
      git(root, 'commit', '-qm', 'test: document nested modules')
      write(root, 'packages/feature/src/worker.ts', 'doWork()\n'.repeat(60))
      const result = run(distribution, 'change', [root], root)
      expect(result.output.affected_modules).toContain('packages/feature')
      expect(result.output.affected_modules).not.toContain('packages')
    })

    it('accepts an updated existing README without inventing DESIGN documentation', () => {
      const root = repository()
      write(root, 'README.zh-CN.md', '# Project\n')
      git(root, 'add', '.')
      git(root, 'commit', '-qm', 'test: document project')
      write(root, 'src/clean.ts', 'doWork()\n'.repeat(60))
      write(root, 'README.zh-CN.md', '# Project\n\nUpdated usage\n')
      const result = run(distribution, 'change', [root], root)
      expect(result.output.issues?.filter((issue) => /DESIGN|README|文档/.test(issue.message))).toEqual([])
      expect(result.output.doc_sync).toMatchObject({ 'README.zh-CN.md': { exists: true, updated: true } })
      expect(Object.keys(result.output.doc_sync || {}).some((name) => name.includes('DESIGN'))).toBe(false)
    })
  })

  describe('module analysis', () => {
    it('handles complete modules, multiple targets and missing required documentation', () => {
      const root = fixture()
      const first = completeModule(root, 'first')
      const second = completeModule(root, 'second')
      expect(run(distribution, 'module', [first], root).output).toMatchObject({ complete: true, passed: true })
      const multiple = run(distribution, 'module', [first, second], root)
      expect(multiple.status).toBe(0)
      expect(multiple.output.results).toHaveLength(2)
      rmSync(join(second, 'DESIGN.md'))
      const missing = run(distribution, 'module', [second], root)
      expect(missing.status).toBe(1)
      expect(missing.output).toMatchObject({ complete: true, passed: false })
    })

    it('reports missing or non-directory targets as incomplete', () => {
      const root = fixture()
      const file = write(root, 'file.ts')
      for (const target of [file, join(root, 'missing')]) {
        const result = run(distribution, 'module', [target], root)
        expect(result.status).toBe(2)
        expect(result.output).toMatchObject({ complete: false, passed: false })
      }
    })

    it.each(['readdirSync', 'readFileSync', 'lstatSync'])('propagates %s failures', (method) => {
      const root = fixture()
      const target = completeModule(root, 'module')
      const blocked = method === 'readdirSync' ? join(target, 'src') : join(target, 'README.md')
      const result = run(distribution, 'module', [target], root, deny(root, method, blocked))
      expect(result.status).toBe(2)
      expect(result.output).toMatchObject({ complete: false, passed: false, error: 'Injected read denial' })
    })
  })

  it.each(Object.keys(scripts) as Gate[])('%s --help performs no scan', (gate) => {
    const root = fixture()
    const result = spawnSync(process.execPath, [join(packageRoot, distribution, scripts[gate]), '--help'], {
      cwd: root,
      encoding: 'utf8',
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Usage:')
    expect(result.stderr).toBe('')
  })
})
