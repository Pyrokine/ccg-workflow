import { spawnSync } from 'node:child_process'
import { readFileSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { distributions, fixture, git, packageRoot, repository, run, write } from './quality-gates-fixtures'

const tools = 'templates/skills/tools'

describe.each(distributions)('%s feedback regressions', (distribution) => {
  it.each(['quality', 'security'] as const)('excludes build caches and third-party trees from %s', (gate) => {
    const root = fixture()
    const source = write(root, 'src/main.rs', 'pub fn work() {}\n')
    for (const directory of ['target', 'vendor', 'third_party', 'third-party']) {
      write(root, `${directory}/registry/dependency.kt`, 'val answer = 42\n')
    }
    const result = run(distribution, gate, [root], root)
    expect(result.status).toBe(0)
    expect(result.output).toMatchObject({ complete: true, files_scanned: 1, scan_errors: [] })
    const explicit = write(root, 'target/generated.rs', readFileSync(source, 'utf8'))
    expect(run(distribution, gate, [explicit], root).output.files_scanned).toBe(1)
  })

  it('scans Rust credential assignments and shell interpreter calls', () => {
    const root = fixture()
    const source = write(
      root,
      'main.rs',
      'const API_KEY: &str = "synthetic-rust-credential";\n' +
        'let child = std::process::Command::new("sh").arg("-c").arg(input);\n'
    )
    const result = run(distribution, 'security', [source], root)
    expect(result.status).toBe(1)
    expect(result.output).toMatchObject({ complete: true, files_scanned: 1, scan_errors: [] })
    expect(result.output.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rule_id: 'HARDCODED_SECRET', severity: 'high', line_number: 1 }),
        expect.objectContaining({ rule_id: 'RUST_SHELL_COMMAND', severity: 'critical', line_number: 2 }),
      ])
    )
    expect(result.stdout).not.toContain('synthetic-rust-credential')
  })

  it.each(['#!/bin/sh', '#!/usr/bin/env bash', '#!/usr/bin/env -S bash -eu', '#!/usr/bin/dash'])(
    'recognizes extensionless Shell scripts with %s',
    (shebang) => {
      const root = fixture()
      const source = write(root, 'scripts/launcher', `${shebang}\neval "$input"\n`)
      const result = run(distribution, 'security', [root], root)
      expect(result.status).toBe(1)
      expect(result.output).toMatchObject({ complete: true, files_scanned: 1 })
      expect(result.output.findings).toContainEqual(expect.objectContaining({ rule_id: 'SHELL_DYNAMIC_EXEC' }))
      write(root, 'scripts/launcher', `${shebang}\nprintf '%s\\n' "$input"\n`)
      expect(run(distribution, 'security', [source], root).output).toMatchObject({ complete: true, passed: true })
    }
  )

  it('keeps named Shell scripts covered and unknown extensionless inputs incomplete', () => {
    const root = fixture()
    const script = write(root, 'main.sh', '#!/bin/sh\nsh -c "$input"\n')
    expect(run(distribution, 'security', [script], root).status).toBe(1)
    const unknown = write(root, 'opaque', 'not a supported source file\n')
    expect(run(distribution, 'security', [unknown], root).output).toMatchObject({
      complete: false,
      passed: false,
      files_scanned: 0,
      scan_errors: [expect.objectContaining({ code: 'UNSUPPORTED_TYPE' })],
    })
  })

  it('distinguishes readlink comparisons from input-driven file operations', () => {
    const root = fixture()
    const source = write(
      root,
      'test_links.py',
      'assert Path(os.readlink(params)) == cached_params\n' +
        'open(request.args["file"]).read()\n' +
        'Path(request.args["file"]).read_text()\n'
    )
    const result = run(distribution, 'security', [source], root)
    expect(result.status).toBe(1)
    expect(result.output.findings?.map((finding) => finding.line_number).sort()).toEqual([2, 3])
  })

  it('labels privacy markers and fixture literals while retaining severity and redaction', () => {
    const root = fixture()
    const source = write(
      root,
      'tests/privacy.test.ts',
      'const secret = "sentinel-sensitive-input";\n' +
        'const fixture = "document.body.innerHTML = input";\n' +
        'document.body.innerHTML = input;\n'
    )
    const result = run(distribution, 'security', [source], root)
    expect(result.status).toBe(1)
    expect(result.output).toMatchObject({ complete: true, passed: false })
    expect(result.output.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rule_id: 'HARDCODED_SECRET', context: 'test_code', review_required: true }),
        expect.objectContaining({
          rule_id: 'XSS_INNERHTML',
          line_number: 2,
          context: 'test_fixture',
          severity: 'high',
        }),
        expect.objectContaining({ rule_id: 'XSS_INNERHTML', line_number: 3, context: 'test_code', severity: 'high' }),
      ])
    )
    expect(result.stdout + result.stderr).not.toContain('sentinel-sensitive-input')
  })

  it.each(['working', 'staged', 'committed'])('recognizes changed Rust inline tests in %s mode', (mode) => {
    const root = repository()
    write(root, 'README.md', '# Module\n')
    write(root, 'src/lib.rs', 'pub fn work() {}\n')
    git(root, 'add', '.')
    git(root, 'commit', '-qm', 'test: Rust source')
    const source = write(
      root,
      'src/lib.rs',
      'pub fn work() {}\n\n#[cfg(test)]\nmod tests {\n' +
        '#[cfg(windows)]\n#[test]\nfn verifies_output() {\n' +
        '    assert_eq!("{", "{");\n'.repeat(55) +
        '}\n}\n'
    )
    if (mode !== 'working') git(root, 'add', '.')
    if (mode === 'committed') git(root, 'commit', '-qm', 'test: Rust inline tests')
    if (mode === 'staged') write(root, 'src/lib.rs', 'pub fn different_worktree() {}\n')
    const result = run(distribution, 'change', [source, '--mode', mode], root)
    expect(result.status).toBe(0)
    expect(result.output.changes).toContainEqual(
      expect.objectContaining({
        path: 'src/lib.rs',
        is_test: false,
        has_test_changes: true,
        test_only: true,
      })
    )
    expect(result.output.issues?.filter((issue) => /测试更新|文档/.test(issue.message))).toEqual([])
  })

  it('does not count untouched inline tests as a test update', () => {
    const root = repository()
    const tests = '#[cfg(test)]\nmod tests {\n#[test]\nfn validates() {}\n}\n'
    write(root, 'src/lib.rs', 'pub fn work() {\n}\n' + tests)
    git(root, 'add', '.')
    git(root, 'commit', '-qm', 'test: existing Rust tests')
    const source = write(root, 'src/lib.rs', 'pub fn work() {\n' + '    do_work();\n'.repeat(35) + '}\n' + tests)
    const result = run(distribution, 'change', [source], root)
    expect(result.output.changes).toContainEqual(expect.objectContaining({ has_test_changes: false, test_only: false }))
    expect(result.output.issues).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining('没有对应的测试更新') })
    )
  })

  it('preserves missing staged additions and avoids following Rust file symlinks', () => {
    const root = repository()
    const missing = write(root, 'missing.rs', '#[test]\nfn validates() {}\n')
    git(root, 'add', 'missing.rs')
    rmSync(missing)
    const source = write(root, 'outside.txt', '#[test]\nfn validates() {}\n')
    symlinkSync(source, join(root, 'alias.rs'))
    const result = run(distribution, 'change', [root], root)
    expect(result.status).toBe(0)
    expect(result.output.changes).toContainEqual(
      expect.objectContaining({ path: 'missing.rs', has_test_changes: false })
    )
    expect(result.output.changes).toContainEqual(expect.objectContaining({ path: 'alias.rs', is_test: false }))
  })

  it('ends cfg(test) constants before subsequent production code', () => {
    const root = repository()
    write(root, 'src/lib.rs', '#[cfg(test)]\nconst TEST_VALUE: i32 = 1;\npub fn work() {\n}\n')
    git(root, 'add', '.')
    git(root, 'commit', '-qm', 'test: Rust test-only constant')
    const source = write(
      root,
      'src/lib.rs',
      '#[cfg(test)]\nconst TEST_VALUE: i32 = 1;\npub fn work() {\n' + '    do_work();\n'.repeat(35) + '}\n'
    )
    const result = run(distribution, 'change', [source], root)
    expect(result.output.changes).toContainEqual(expect.objectContaining({ has_test_changes: false, test_only: false }))
  })

  it('recognizes new Rust inline tests before the first commit', () => {
    const root = fixture()
    git(root, 'init', '-q')
    const source = write(root, 'src/lib.rs', '#[test]\nfn validates() {}\n')
    expect(run(distribution, 'change', [source], root).output.changes).toContainEqual(
      expect.objectContaining({ has_test_changes: true, test_only: true })
    )
  })

  it('recognizes bounded smoke self-test filenames', async () => {
    const analyzer = await import(join(packageRoot, distribution, 'verify-change/scripts/change_analyzer.js'))
    for (const name of ['scripts/smoke_build_records.py', 'scripts/smoke.version.py', 'scripts/records_smoke.py']) {
      expect(analyzer.classifyFile(name)).toMatchObject({ is_code: true, is_test: true })
    }
    for (const name of ['scripts/smokehouse.py', 'scripts/smokey.py', 'src/latest_version.py']) {
      expect(analyzer.classifyFile(name)).toMatchObject({ is_code: true, is_test: false })
    }
  })

  it('uses SKILL.md module boundaries and linked references with smoke self-tests', () => {
    const root = repository()
    const mod = 'SKILLS/helper'
    const original = '# Helper\n\n[Usage](references/usage.md#examples)\n'
    write(root, 'README.md', '# Repository\n')
    write(root, `${mod}/SKILL.md`, original)
    write(root, `${mod}/references/usage.md`, '# Usage\n')
    write(root, `${mod}/scripts/client.py`, 'value = 1\n')
    git(root, 'add', '.')
    git(root, 'commit', '-qm', 'test: skill module baseline')
    write(root, `${mod}/scripts/client.py`, 'value = 2\n'.repeat(60))
    write(root, `${mod}/SKILL.md`, original + '\nUpdated interface\n')
    write(root, `${mod}/references/usage.md`, '# Usage\n\nUpdated examples\n')
    for (const name of ['build_records', 'sa_report', 'version_search']) {
      write(root, `${mod}/scripts/smoke_${name}.py`, 'assert True\n')
    }
    const result = run(distribution, 'change', [join(root, mod)], root)
    expect(result.status).toBe(0)
    expect(result.output.affected_modules).toEqual([mod])
    expect(result.output.doc_sync).toEqual({
      [`${mod}/SKILL.md`]: { exists: true, updated: true },
      [`${mod}/references/usage.md`]: { exists: true, updated: true },
    })
    const smokeChanges = result.output.changes?.filter((item) => item.path.includes('/smoke_')) || []
    expect(smokeChanges).toHaveLength(3)
    expect(smokeChanges.every((change) => 'is_test' in change && change.is_test === true)).toBe(true)
    expect(result.output.issues?.filter((issue) => /测试更新|文档/.test(issue.message))).toEqual([])
  })

  it('keeps unlinked references from satisfying SKILL.md document synchronization', () => {
    const root = repository()
    const mod = 'SKILLS/helper'
    write(root, `${mod}/SKILL.md`, '# Helper\n\n[Usage](references/usage.md)\n')
    write(root, `${mod}/references/usage.md`, '# Usage\n')
    write(root, `${mod}/references/unrelated.md`, '# Other\n')
    write(root, `${mod}/scripts/client.py`, 'value = 1\n')
    git(root, 'add', '.')
    git(root, 'commit', '-qm', 'test: linked skill documentation')
    write(root, `${mod}/scripts/client.py`, 'value = 2\n'.repeat(60))
    write(root, `${mod}/references/unrelated.md`, '# Other\n\nUnrelated update\n')
    const result = run(distribution, 'change', [join(root, mod)], root)
    expect(result.output.doc_sync).toEqual({
      [`${mod}/SKILL.md`]: { exists: true, updated: false },
      [`${mod}/references/usage.md`]: { exists: true, updated: false },
    })
    expect(result.output.issues).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining('相关文档未更新') })
    )
  })

  it('keeps custom build configuration and non-Git change inputs explicitly unsupported', () => {
    const root = fixture()
    const source = write(root, 'custom.build', 'target = "fixture"\n')
    expect(run(distribution, 'quality', [source], root).output).toMatchObject({
      complete: false,
      files_scanned: 0,
      scan_errors: [expect.objectContaining({ code: 'UNSUPPORTED_TYPE' })],
    })
    expect(run(distribution, 'change', [root], root).output).toMatchObject({ complete: false, passed: false })
  })
})

it.each([tools, 'dsh-ccg/skills'])('normalizes Rust crate identifiers through %s doc generation', (distribution) => {
  const root = fixture()
  const target = join(root, 'europium-terminal')
  write(target, 'src/lib.rs', 'pub fn work() {}\n')
  const result = spawnSync(
    process.execPath,
    [join(packageRoot, distribution, 'gen-docs/scripts/doc_generator.js'), target, '--json'],
    { cwd: root, encoding: 'utf8' }
  )
  expect(result.status).toBe(0)
  expect(readFileSync(join(target, 'README.md'), 'utf8')).toContain('use europium_terminal::*;')
})

it('keeps orchestration optional, bounded, leaf-only by default and commits user-authorized', () => {
  const text = readFileSync(join(packageRoot, 'templates/skills/orchestration/multi-agent/SKILL.md'), 'utf8')
  expect(text).toContain('新增 Agent 数量为 0')
  expect(text).toContain('最大深度')
  expect(text).toContain('叶子节点')
  expect(text).toContain('用户明确要求提交')
  expect(text).not.toMatch(/≥3 个独立文件\/模块？ → TeamCreate|统一 git add \+ commit|必须用 awaiter|优先 TeamCreate/)
})
