import { spawnSync } from 'node:child_process'
import { existsSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { distributions, fixture, git, packageRoot, repository, run, scripts, write } from './quality-gates-fixtures'

const command = 'subprocess.run(command, shell=True)\n'

describe.each(distributions)('%s explicit Python security mode', (distribution) => {
  it('scans an extensionless file without executing it or exposing credentials', () => {
    const root = fixture()
    const secret = 'synthetic-security-credential-12345'
    const source = write(
      root,
      'config files/BUILD_CONFIG',
      'from pathlib import Path\nPath("executed").touch()\n' +
        `password = "${secret}"\n` +
        'cursor.execute(f"SELECT * FROM records WHERE id = {value}")\n' +
        command
    )
    const unsupported = run(distribution, 'security', [source], root)
    expect(unsupported.status).toBe(2)
    expect(unsupported.output.scan_errors).toContainEqual(
      expect.objectContaining({ path: source, code: 'UNSUPPORTED_TYPE' })
    )
    const args = [source, '--python-file', source]
    const result = run(distribution, 'security', args, root)
    expect(result.status).toBe(1)
    expect(result.output).toMatchObject({ complete: true, files_scanned: 1, python_file: source, scan_path: source })
    for (const rule_id of ['HARDCODED_SECRET', 'SQL_INJECTION_DYNAMIC', 'COMMAND_INJECTION']) {
      expect(result.output.findings).toContainEqual(expect.objectContaining({ rule_id, line_content: '[redacted]' }))
    }
    const text = spawnSync(process.execPath, [join(packageRoot, distribution, scripts.security), ...args], {
      cwd: root,
      encoding: 'utf8',
    })
    expect(text.status).toBe(1)
    expect(text.stdout).toContain(`Python 模式文件: ${source}`)
    expect(result.stdout + result.stderr + text.stdout + text.stderr).not.toContain(secret)
    expect(existsSync(join(root, 'executed'))).toBe(false)
  })

  it.each<[string[], string]>([
    [['BUILD_CONFIG', '--python-file'], 'requires'],
    [['BUILD_CONFIG', '--python-file='], 'requires'],
    [['BUILD_CONFIG', '--python-file', 'BUILD_CONFIG', '--python-file=BUILD_CONFIG'], 'once'],
    [['.', '--python-file', '.'], 'regular file'],
    [['.', '--python-file', 'BUILD_CONFIG'], 'explicitly requested file'],
    [['BUILD_CONFIG', '--python-file', 'missing'], 'ENOENT'],
  ])('rejects invalid explicit mode arguments %j', (args, message) => {
    const root = fixture()
    write(root, 'BUILD_CONFIG', command)
    const result = run(distribution, 'security', args, root)
    expect(result.status).toBe(2)
    expect(result.output).toMatchObject({ complete: false, passed: false, error: expect.stringContaining(message) })
  })

  it.each([false, true])('keeps mixed targets and directory overlap independent (file first=%s)', (fileFirst) => {
    const root = fixture()
    const source = write(root, 'src/BUILD_CONFIG', command)
    const native = write(root, 'src/native.cpp', 'void launch() { system(command); }\n// ' + command)
    const shell = write(root, 'src/launch', '#!/usr/bin/env -S bash\neval "$command"\n')
    write(root, 'src/OTHER_CONFIG', command)
    const targets = fileFirst ? [source, join(root, 'src')] : [join(root, 'src'), source]
    const result = run(distribution, 'security', ['--python-file=src/BUILD_CONFIG', ...targets], root)
    expect(result.status).toBe(1)
    expect(result.output).toMatchObject({ complete: true, files_scanned: 3, requested_paths: targets })
    expect(result.output.findings).toHaveLength(3)
    for (const [file_path, rule_id] of [
      [source, 'COMMAND_INJECTION'],
      [native, 'C_DYNAMIC_COMMAND'],
      [shell, 'SHELL_DYNAMIC_EXEC'],
    ]) {
      expect(result.output.findings).toContainEqual(expect.objectContaining({ file_path, rule_id }))
    }
  })

  it.each([false, true])(
    'prefers the exact Python path over a deduplicated symbolic alias (file first=%s)',
    (fileFirst) => {
      const root = fixture()
      const source = write(root, 'BUILD_CONFIG', command)
      const alias = join(root, 'alias.cpp')
      symlinkSync(source, alias)
      const targets = fileFirst ? [source, alias] : [alias, source]
      const result = run(distribution, 'security', [...targets, '--python-file', source], root)
      expect(result.status).toBe(1)
      expect(result.output).toMatchObject({ complete: true, files_scanned: 1, requested_paths: targets })
      expect(result.output.findings).toEqual([
        expect.objectContaining({ file_path: source, rule_id: 'COMMAND_INJECTION' }),
      ])
    }
  )

  it('accepts an explicitly selected file symlink and requires that exact requested path', () => {
    const root = fixture()
    const source = write(root, 'BUILD_CONFIG', command)
    const alias = join(root, 'script-module')
    symlinkSync(source, alias)
    const result = run(distribution, 'security', [alias, '--python-file', alias], root)
    expect(result.status).toBe(1)
    expect(result.output.findings).toContainEqual(
      expect.objectContaining({ file_path: alias, rule_id: 'COMMAND_INJECTION' })
    )
    const outside = run(distribution, 'security', [alias, '--python-file', source], root)
    expect(outside.status).toBe(2)
    expect(outside.output.error).toContain('explicitly requested file')
  })

  it('resolves option values relative to cwd and preserves literal paths after --', () => {
    const root = fixture()
    const source = write(root, '--python-file', command)
    const result = run(distribution, 'security', ['--python-file', './--python-file', '--', '--python-file'], root)
    expect(result.status).toBe(1)
    expect(result.output).toMatchObject({ python_file: source, scan_path: source, files_scanned: 1 })
    const ordinary = write(root, '--python-file.py', command)
    const literal = run(distribution, 'security', ['--', '--python-file.py'], root)
    expect(literal.status).toBe(1)
    expect(literal.output).toMatchObject({ python_file: null, scan_path: ordinary })
  })

  it('keeps default directory scanning and Shell shebang detection unchanged', () => {
    const root = fixture()
    write(root, 'BUILD_CONFIG', command)
    const shell = write(root, 'launch', '#!/bin/sh\neval "$command"\n')
    const result = run(distribution, 'security', [], root)
    expect(result.status).toBe(1)
    expect(result.output).toMatchObject({ complete: true, python_file: null, files_scanned: 1, scan_path: root })
    expect(result.output.findings).toEqual([
      expect.objectContaining({ file_path: shell, rule_id: 'SHELL_DYNAMIC_EXEC' }),
    ])
  })

  it('preserves the GDB exception while detecting actual SQL and command injection', () => {
    const root = fixture()
    const source = write(
      root,
      'BUILD_CONFIG',
      'import gdb\ngdb.execute("hbreak *" + address)\n' +
        'cursor.execute("SELECT * FROM records WHERE id = ?", (value,))\n'
    )
    expect(run(distribution, 'security', [source, '--python-file', source], root).output.findings).toEqual([])
    write(
      root,
      'BUILD_CONFIG',
      'import gdb\ngdb.execute("hbreak *" + address); cursor.execute("SELECT " + value)\n' + command
    )
    const result = run(distribution, 'security', [source, '--python-file', source], root)
    expect(result.status).toBe(1)
    expect(result.output.findings).toEqual([
      expect.objectContaining({ rule_id: 'SQL_INJECTION_DYNAMIC', line_number: 2 }),
      expect.objectContaining({ rule_id: 'COMMAND_INJECTION', line_number: 3 }),
    ])
  })

  it('uses explicit mode for the current file and baseline without changing other files', () => {
    const root = repository()
    const source = write(root, 'BUILD_CONFIG', command)
    const native = write(root, 'native.cpp', 'void launch() { system(command); }\n')
    git(root, 'add', '.')
    git(root, 'commit', '-qm', 'test: record explicit Python baseline')
    write(root, 'BUILD_CONFIG', '\n' + command.repeat(2))
    const result = run(distribution, 'security', [source, native, '--python-file', source, '--base', 'HEAD'], root)
    expect(result.status).toBe(1)
    expect(result.output).toMatchObject({ complete: true, origin_counts: { existing: 2, new: 1, unclassified: 0 } })
    expect(result.output.findings).toContainEqual(
      expect.objectContaining({ file_path: native, rule_id: 'C_DYNAMIC_COMMAND', origin: 'existing' })
    )
  })

  it('uses the current explicit mode when the baseline filename has another extension', () => {
    const root = repository()
    const content = '# retained build configuration\n'.repeat(10) + command
    write(root, 'old.cpp', content)
    git(root, 'add', '.')
    git(root, 'commit', '-qm', 'test: record renamed configuration')
    git(root, 'mv', 'old.cpp', 'BUILD_CONFIG')
    const source = write(root, 'BUILD_CONFIG', content + command)
    const result = run(distribution, 'security', [source, '--python-file', source], root)
    expect(result.status).toBe(1)
    expect(result.output).toMatchObject({ complete: true, origin_counts: { existing: 1, new: 1, unclassified: 0 } })
  })

  it('keeps status, counts and findings before complete long target lists', () => {
    const root = fixture()
    const source = write(root, 'BUILD_CONFIG', command)
    const paths = [
      source,
      ...Array.from({ length: 40 }, (_, index) => write(root, `native/translation-${index}.cpp`, 'int value;\n')),
    ]
    const result = run(distribution, 'security', [...paths, '--python-file', source], root)
    expect(result.status).toBe(1)
    expect(result.output).toMatchObject({
      complete: true,
      scan_path: `${paths.length} 个目标`,
      requested_paths: paths,
      files_scanned: paths.length,
      counts: { critical: 1 },
    })
    expect(result.output).toHaveProperty(
      'coverage',
      paths.map((path) => ({ path, eligible_files: 1 }))
    )
    for (const field of ['complete', 'passed', 'counts', 'findings']) {
      for (const list of ['requested_paths', 'coverage', 'baseline']) {
        expect(result.stdout.indexOf(`"${field}"`)).toBeLessThan(result.stdout.indexOf(`"${list}"`))
      }
    }
  })
})
