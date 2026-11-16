import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Gate } from './quality-gates-fixtures'
import {
  completeModule,
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

    it.each(['pl', 'pm', 'cu', 'cuh', 'inc'])('reports coverage for %s source inside directories', (ext) => {
      const root = fixture()
      write(root, 'src/clean.ts')
      const unsupported = write(root, `src/fragment.${ext}`, 'SOURCE_FRAGMENT\n')
      const result = run(distribution, gate, [join(root, 'src')], root)
      if (gate === 'quality' && ['pl', 'pm'].includes(ext)) {
        expect(result.status).toBe(2)
        expect(result.output.scan_errors).toContainEqual(
          expect.objectContaining({ path: unsupported, code: 'UNSUPPORTED_TYPE' })
        )
      } else {
        expect(result.status).toBe(0)
        expect(result.output).toMatchObject({ complete: true, passed: true, files_scanned: 2, scan_errors: [] })
      }
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
    it('classifies Python signature failures with function and line instead of a read error', () => {
      const root = fixture()
      const source = write(root, 'legacy.py', 'value = 1\ndef legacy((left, right)):\n    pass\n')
      const result = run(distribution, 'quality', [source], root)
      expect(result.status).toBe(2)
      expect(result.output.scan_errors).toContainEqual(
        expect.objectContaining({
          path: source,
          code: 'PARSE_FAILED',
          message: expect.stringContaining('legacy at line 2'),
        })
      )
    })

    it('counts nested Python defaults without treating their commas as parameters', () => {
      const root = fixture()
      const source = write(
        root,
        'defaults.py',
        'def example(value=(1, 2, 3, 4, 5, 6), callback=lambda a, b: (a, b)):\n    return value\n'
      )
      const result = run(distribution, 'quality', [source], root)
      expect(result.output.complete).toBe(true)
      expect(result.output.issues?.filter((issue) => issue.rule_id === 'FUNCTION_PARAMETERS')).toEqual([])
    })

    it.each(['sh', 'bash', 'json'])('checks %s syntax without executing inputs', (ext) => {
      const root = fixture()
      const valid = ext === 'json' ? '{"answer":42}\n' : '#!/bin/bash\nexit 97\n'
      const source = write(root, `source.${ext}`, valid)
      const args = [source, '--language-checks']
      const clean = run(distribution, 'quality', args, root)
      expect(clean.status).toBe(0)
      expect(clean.output).toMatchObject({ complete: true, passed: true })
      write(root, `source.${ext}`, ext === 'json' ? '{broken\n' : '#!/bin/bash\nif then\n')
      const invalid = run(distribution, 'quality', args, root)
      expect(invalid.status).toBe(1)
      expect(invalid.output).toMatchObject({ complete: true, passed: false })
      expect(invalid.output.issues).toContainEqual(expect.objectContaining({ rule_id: 'syntax-error' }))
    })

    it.each(['pl', 'pm', 'ps1', 'inc'])('scans credentials in %s files without disclosing their value', (ext) => {
      const root = fixture()
      const source = write(root, `source.${ext}`, 'password = "synthetic-credential-12345"\n')
      const result = run(distribution, 'security', [source], root)
      expect(result.status).toBe(1)
      expect(result.output.findings).toContainEqual(expect.objectContaining({ rule_id: 'HARDCODED_SECRET' }))
      expect(result.stdout).not.toContain('synthetic-credential-12345')
    })

    it('recognizes PowerShell input and reports its actual syntax analyzer coverage', () => {
      const root = fixture()
      const source = write(root, 'source.ps1', 'exit 97\n')
      const text = run(distribution, 'quality', [source], root)
      expect(text.status).toBe(0)
      const result = run(distribution, 'quality', [source, '--language-checks'], root)
      expect(result.output.scan_errors).toEqual([])
      expect(result.output.checks).toContainEqual(expect.objectContaining({ tool: 'powershell-syntax' }))
    })

    it('routes an include fragment to C++ language coverage', () => {
      const root = fixture()
      const source = write(root, 'catalog.inc', 'CATALOG_ENTRY(example)\n')
      const result = run(distribution, 'quality', [source, '--language-checks'], root)
      expect(result.status).toBe(2)
      expect(result.output.scan_errors).toEqual([])
      expect(result.output.checks).toContainEqual(
        expect.objectContaining({ tool: 'clang-tidy', status: 'unavailable' })
      )
    })

    it('accepts private PascalCase Python classes and still reports malformed names', () => {
      const root = fixture()
      const names = ['ChainObj', '_ChainObj', '__ChainObj', 'badName', '_bad', 'Bad_Name', '_']
      const source = write(root, 'classes.py', names.map((name) => `class ${name}:\n    pass\n`).join('\n'))
      const result = run(distribution, 'quality', [source], root)
      expect(result.status).toBe(0)
      const findings = result.output.issues?.filter((issue) => issue.rule_id === 'CLASS_NAME_STYLE')
      expect(findings).toHaveLength(4)
      for (const name of names.slice(3)) {
        expect(findings).toContainEqual(expect.objectContaining({ message: expect.stringContaining(`'${name}'`) }))
      }
    })

    it('distinguishes GDB debugger commands from dynamic SQL calls', () => {
      const root = fixture()
      const source = write(
        root,
        'debugger.py',
        [
          'import gdb',
          "gdb.execute('hbreak *' + hex(address), to_string=True)",
          "gdb.execute('condition 1 ' + condition, to_string=True)",
          'gdb.execute(f"hbreak *{map_address}", to_string=True)',
          'gdb . execute("hbreak *%s" % address, to_string=True)',
          'gdb.execute("hbreak *{}".format(address), to_string=True)',
          'gdb.execute("hbreak *" + address); gdb.execute("condition 1 " + condition)',
          '',
        ].join('\n')
      )
      const result = run(distribution, 'security', [source], root)
      expect(result.status).toBe(0)
      expect(result.output).toMatchObject({ complete: true, passed: true, files_scanned: 1 })
      expect(result.output.findings).toEqual([])
    })

    it.each([
      ['py', 'cursor.execute(f"SELECT * FROM records WHERE id = {value}")'],
      ['py', 'connection.execute("SELECT * FROM records WHERE id = " + value)'],
      ['py', 'session.execute("SELECT * FROM records WHERE id = %s" % value)'],
      ['py', 'execute("SELECT * FROM records WHERE id = {}".format(value))'],
      ['py', 'gdb.execute("SELECT * FROM records WHERE id = " + value)'],
      ['py', '# import gdb\ngdb.execute("SELECT * FROM records WHERE id = " + value)'],
      ['py', 'text = "import gdb"\ngdb.execute("SELECT * FROM records WHERE id = " + value)'],
      ['py', 'import gdb; gdb.query("SELECT * FROM records WHERE id = " + value)'],
      ['py', 'import gdb; gdb.raw("SELECT * FROM records WHERE id = " + value)'],
      ['py', 'import gdb; gdb.Execute("SELECT * FROM records WHERE id = " + value)'],
      ['py', 'import gdb; other.gdb.execute("SELECT * FROM records WHERE id = " + value)'],
      ['py', 'import gdb; δgdb.execute("SELECT * FROM records WHERE id = " + value)'],
      ['js', 'gdb.execute("SELECT * FROM records WHERE id = " + value)'],
      ['ts', 'db.query("SELECT * FROM records WHERE id = " + value)'],
      ['go', 'db.query("SELECT * FROM records WHERE id = " + value)'],
      ['java', 'db.execute("SELECT * FROM records WHERE id = " + value)'],
      ['php', 'query("SELECT * FROM records WHERE id = " + value)'],
      [
        'py',
        'import gdb; gdb.execute("hbreak *" + address); cursor.execute("SELECT * FROM records WHERE id = " + value)',
      ],
      [
        'py',
        'import gdb; gdb.execute("hbreak *" + address); ' +
          'gdb.execute("condition 1 " + condition); raw("SELECT " + value)',
      ],
      [
        'py',
        'import gdb; cursor.execute("SELECT * FROM records WHERE id = " + value); gdb.execute("hbreak *" + address)',
      ],
    ])('retains dynamic SQL detection in %s: %s', (ext, content) => {
      const root = fixture()
      const source = write(root, `query.${ext}`, `${content}\n`)
      const result = run(distribution, 'security', [source], root)
      expect(result.status).toBe(1)
      expect(result.output).toMatchObject({ complete: true, passed: false })
      expect(result.output.findings).toContainEqual(
        expect.objectContaining({
          rule_id: 'SQL_INJECTION_DYNAMIC',
          severity: 'critical',
          line_number: content.split('\n').length,
        })
      )
    })

    it('keeps parameterized SQL safe and other security findings beside GDB calls', () => {
      const root = fixture()
      const safe = write(
        root,
        'parameterized.py',
        'import gdb\ngdb.execute("hbreak *" + hex(address))\n' +
          'cursor.execute("SELECT * FROM records WHERE id = ?", (value,))\n'
      )
      expect(run(distribution, 'security', [safe], root).output.findings).toEqual([])
      const unsafe = write(
        root,
        'process.py',
        'import gdb\ngdb.execute("hbreak *" + hex(address))\nsubprocess.run(command, shell=True)\n'
      )
      const result = run(distribution, 'security', [unsafe], root)
      expect(result.status).toBe(1)
      expect(result.output.findings).toContainEqual(
        expect.objectContaining({ rule_id: 'COMMAND_INJECTION', severity: 'critical', line_number: 3 })
      )
      expect(result.output.findings?.some((finding) => finding.rule_id === 'SQL_INJECTION_DYNAMIC')).toBe(false)
    })

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
    it('recognizes C++ contract files as tests in module and change analysis', () => {
      const root = repository()
      const target = completeModule(root, 'cpp-module')
      rmSync(join(target, 'tests'), { recursive: true })
      write(target, 'src/source.cc', 'int value = 1;\n')
      write(target, 'src/source_contract.cc', 'int main() { return 0; }\n')
      const module = run(distribution, 'module', [target], root)
      expect(module.output.issues?.some((issue) => issue.message.includes('未找到测试目录或测试文件'))).toBe(false)
      const change = run(distribution, 'change', [target], root)
      expect(change.output.changes).toContainEqual(
        expect.objectContaining({ is_test: true, path: 'cpp-module/src/source_contract.cc' })
      )
    })

    it('recognizes English command examples and shared validation rationale', () => {
      const root = fixture()
      const target = completeModule(root, 'catalog-validator')
      write(
        target,
        'README.md',
        '# Catalog validator\n\nRun from the repository root\n\n' +
          '```sh\ngo run ./cmd/validate --file ./catalog.json\n```\n'
      )
      write(
        target,
        'DESIGN.md',
        '# Catalog validation\n\nThe registry shares this validator with its catalog loader, ' +
          'so local acceptance uses the same rules as publication.\n'
      )
      const result = run(distribution, 'module', [target], root)
      expect(result.status).toBe(0)
      expect(result.output.issues?.filter((issue) => issue.severity === 'info')).toEqual([])
    })

    it('retains documentation hints when usage and design rationale are absent', () => {
      const root = fixture()
      const target = completeModule(root, 'catalog-validator')
      write(target, 'README.md', '# Runtime\n\nThis module validates local catalogs and reports invalid entries.\n')
      write(
        target,
        'DESIGN.md',
        '# Catalog validation\n\nThe module reads catalog files and reports invalid entries.\n'
      )
      const result = run(distribution, 'module', [target], root)
      expect(result.status).toBe(0)
      expect(result.output.issues?.filter((issue) => issue.severity === 'info')).toEqual([
        expect.objectContaining({ message: 'README.md 建议添加使用说明或示例' }),
        expect.objectContaining({ message: 'DESIGN.md 建议记录设计决策和权衡' }),
      ])
    })

    it.each([
      ['test attribute', '#[test]\nfn works() {}\n', true],
      ['test module', '#[cfg(test)]\nmod checks { fn works() {} }\n', true],
      ['comments', '// #[test]\n/* #[cfg(test)] mod tests {} */\nfn works() {}\n', false],
      ['strings', 'const A: &str = "#[test]";\nconst B: &str = r#"#[cfg(test)] mod tests {}"#;\n', false],
      ['no tests', 'pub fn works() {}\n', false],
      ['plain tests module', 'mod tests { fn helper() {} }\n', false],
    ])('recognizes Rust inline tests: %s', (_name, content, found) => {
      const root = fixture()
      const target = completeModule(root, 'rust-module')
      rmSync(join(target, 'tests'), { recursive: true })
      write(target, 'src/lib.rs', content)
      const result = run(distribution, 'module', [target], root)
      expect(result.status).toBe(0)
      expect(result.output.issues?.some((issue) => issue.message.includes('未找到测试目录或测试文件'))).toBe(!found)
    })

    it('keeps existing Rust change classification for a plain tests module', () => {
      const root = fixture()
      write(root, 'src/lib.rs', 'mod tests { fn helper() {} }\n')
      const change = { path: 'src/lib.rs', type: 'added', is_test: false }
      const { identifyInlineTests } = createRequire(import.meta.url)(
        join(packageRoot, distribution, 'lib/change-tests.js')
      ) as {
        identifyInlineTests: (changes: object[], mode: string, root: string) => void
      }
      identifyInlineTests([change], 'working', root)
      expect(change).toMatchObject({ has_test_changes: true, test_only: true })
    })

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
