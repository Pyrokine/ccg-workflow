import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  loadModule,
  root,
  distributions,
  limits,
  fixture,
  write,
  fakeExecutable,
  files,
} from './language-checks-fixtures'
import type { Analyze } from './language-checks-fixtures'

describe.each(distributions)('%s language tool execution', (distribution) => {
  const { runLanguageChecks } = loadModule(join(root, distribution, 'lib/language-checks.js')) as {
    runLanguageChecks: Analyze
  }

  it('uses existing Ruff project rules without cache or source writes', ({ skip }) => {
    const available = spawnSync('ruff', ['--version'], { encoding: 'utf8' })
    if (available.error) return skip()
    const directory = fixture()
    write(directory, 'ruff.toml', 'lint.select = ["F821"]\n')
    const source = write(directory, 'source file.py', 'print(undefined_name)\n')
    const before = files(directory)
    vi.stubEnv('RUFF_OUTPUT_FILE', source)
    const result = runLanguageChecks([source], limits)
    expect(result.checks[0]).toMatchObject({ tool: 'ruff', status: 'failed', files: [source] })
    expect(result.issues[0]).toMatchObject({ rule_id: 'F821', severity: 'error', line_number: 1 })
    expect(files(directory)).toEqual(before)
    expect(readFileSync(source, 'utf8')).toBe('print(undefined_name)\n')
    writeFileSync(source, 'def invalid(:\n')
    expect(runLanguageChecks([source], limits).checks[0].status).toBe('failed')
  })

  it('passes an explicit Ruff target version to inventory and diagnostics', () => {
    const directory = fixture()
    const source = write(directory, 'source.py', 'answer = 42\n')
    const capture = join(directory, 'argv.jsonl')
    fakeExecutable(
      directory,
      'ruff',
      `
      require('node:fs').appendFileSync(${JSON.stringify(capture)}, JSON.stringify(process.argv.slice(2)) + '\\n');
      if (process.argv.includes('--show-files')) console.log(${JSON.stringify(source)});
      else console.log('[]');
    `
    )
    expect(runLanguageChecks([source], limits, 'py38').checks[0].status).toBe('passed')
    const calls = readFileSync(capture, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string[])
    expect(calls).toHaveLength(2)
    for (const args of calls)
      expect(args.slice(args.indexOf('--target-version'), args.indexOf('--target-version') + 2)).toEqual([
        '--target-version',
        'py38',
      ])
  })

  it('reports Ruff exclusions and configuration failure', ({ skip }) => {
    const available = spawnSync('ruff', ['--version'], { encoding: 'utf8' })
    if (available.error) return skip()
    const directory = fixture()
    write(directory, 'ruff.toml', 'exclude = ["ignored.py"]\n')
    const clean = write(directory, 'clean.py', 'answer = 42\n')
    const ignored = write(directory, 'ignored.py', 'undefined_name\n')
    const result = runLanguageChecks([clean, ignored], limits)
    expect(result.checks[0]).toMatchObject({ status: 'passed', files: [clean], skipped_files: [ignored] })
    expect(result.uncovered).toContainEqual(expect.objectContaining({ path: ignored }))
    expect(runLanguageChecks([ignored], limits).checks[0].status).toBe('unavailable')
    write(directory, 'ruff.toml', 'invalid config = [\n')
    expect(runLanguageChecks([clean], limits).checks[0].status).toBe('unavailable')
  })

  it.each(['exit', 'signal', 'json', 'overflow'])(
    'reports Ruff %s failure without leaking process output',
    (failure) => {
      const directory = fixture()
      const source = write(directory, 'source.py', 'answer = 42\n')
      const secret = 'synthetic_credential_failure_123456'
      const script =
        failure === 'exit'
          ? `console.error('${secret}'); process.exit(2);`
          : failure === 'signal'
            ? `process.kill(process.pid, 'SIGTERM');`
            : failure === 'overflow'
              ? `process.stdout.write('${secret}'.repeat(400000));`
              : `process.stdout.write('${secret}');`
      fakeExecutable(
        directory,
        'ruff',
        `if (process.argv.includes('--show-files')) console.log(${JSON.stringify(source)}); else { ${script} }`
      )
      const result = runLanguageChecks([source], limits)
      expect(result.checks[0].status).toBe('unavailable')
      expect(result.issues).toEqual([])
      expect(JSON.stringify(result)).not.toContain(secret)
    }
  )

  it('reports missing PATH tools, compilation databases and unsupported languages', () => {
    const directory = fixture()
    vi.stubEnv('PATH', '')
    const python = write(directory, 'main.py', '')
    const cpp = write(directory, 'main.cpp', '')
    const rust = write(directory, 'main.rs', '')
    const result = runLanguageChecks([python, cpp, rust], limits)
    expect(result.checks).toHaveLength(3)
    expect(result.checks.every((check) => check.status === 'unavailable')).toBe(true)
    expect(result.uncovered.map((entry) => entry.path).sort()).toEqual([python, cpp, rust].sort())
    expect(runLanguageChecks([], limits)).toEqual({ checks: [], issues: [], uncovered: [] })
  })

  it('passes the existing compilation database to clang-tidy and preserves missing-entry coverage', () => {
    const directory = fixture()
    const source = write(directory, 'source file.cpp', 'int main() { return 0; }\n')
    const missing = write(directory, 'header.hpp', '// Header\n')
    const database = write(
      directory,
      'build/compile_commands.json',
      JSON.stringify([{ directory, file: source, arguments: ['c++', '-DFIXTURE=1', '-std=c++20', '-c', source] }])
    )
    const capture = join(directory, 'argv.json')
    const secret = 'synthetic_credential_clang_123456'
    fakeExecutable(
      directory,
      'clang-tidy',
      "require('node:fs').writeFileSync(" +
        JSON.stringify(capture) +
        ', JSON.stringify(process.argv.slice(2))); console.log(' +
        JSON.stringify(`${source}:1:1: warning: ${secret} [readability-identifier-naming]`) +
        ');'
    )
    const result = runLanguageChecks([source, missing], limits)
    expect(result.checks[0]).toMatchObject({
      tool: 'clang-tidy',
      status: 'passed',
      files: [source],
      skipped_files: [missing],
    })
    expect(result.issues[0]).toMatchObject({ severity: 'warning', rule_id: 'readability-identifier-naming' })
    expect(JSON.parse(readFileSync(capture, 'utf8'))).toEqual(['-p', dirname(database), '--quiet', source])
    expect(result.uncovered).toContainEqual(expect.objectContaining({ path: missing }))
    expect(JSON.stringify(result)).not.toContain(secret)
    expect(JSON.parse(readFileSync(database, 'utf8'))[0].arguments).toContain('-DFIXTURE=1')
  })

  it.each(['database', 'missing-entry', 'invalid-output', 'error', 'warnings-as-errors'])(
    'handles clang-tidy %s states',
    (failure) => {
      const directory = fixture()
      const source = write(directory, 'source.cpp', 'int answer = 42;\n')
      write(
        directory,
        'compile_commands.json',
        failure === 'database'
          ? '{invalid'
          : JSON.stringify(
              failure === 'missing-entry' ? [] : [{ directory, file: source, arguments: ['c++', '-c', source] }]
            )
      )
      const diagnostic =
        '' +
        source +
        ':1:1: ' +
        (failure === 'error' ? 'error' : 'warning') +
        ': synthetic_credential [fixture-check' +
        (failure === 'warnings-as-errors' ? ',-warnings-as-errors' : '') +
        ']'
      fakeExecutable(
        directory,
        'clang-tidy',
        failure === 'invalid-output'
          ? "console.log('invalid output');"
          : `console.log(${JSON.stringify(diagnostic)}); process.exit(1);`
      )
      const result = runLanguageChecks([source], limits)
      expect(result.checks[0].status).toBe(['error', 'warnings-as-errors'].includes(failure) ? 'failed' : 'unavailable')
      if (failure === 'error' || failure === 'warnings-as-errors')
        expect(result.issues[0]).toMatchObject({ severity: 'error', rule_id: 'fixture-check' })
      else expect(result.issues).toEqual([])
      expect(JSON.stringify(result)).not.toContain('synthetic_credential')
    }
  )
})
