import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { distributions, fakeExecutable, fixture, limits, loadModule, root, write } from './language-checks-fixtures'
import type { Analyze } from './language-checks-fixtures'

function rustProject(): string {
  const directory = fixture()
  write(directory, 'Cargo.toml', '[package]\nname = "checks"\nversion = "0.1.0"\nedition = "2021"\n')
  write(directory, 'Cargo.lock', 'version = 3\n\n[[package]]\nname = "checks"\nversion = "0.1.0"\n')
  return directory
}

function fakeCargo(directory: string, sources: string[], body = '', status = 0): string {
  const manifest = join(directory, 'Cargo.toml')
  const capture = join(directory, 'calls.jsonl')
  const project = { workspace_root: directory, packages: [{ id: 'checks', manifest_path: manifest }] }
  fakeExecutable(
    directory,
    'cargo',
    `
    const fs = require('node:fs'), path = require('node:path');
    const args = process.argv.slice(2);
    const keys = ['RUSTUP_AUTO_INSTALL','RUSTUP_NO_UPDATE_CHECK',
      'CARGO_NET_OFFLINE','CARGO_INCREMENTAL','CARGO_TARGET_DIR'];
    const env = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    fs.appendFileSync(${JSON.stringify(capture)}, JSON.stringify({args, env}) + '\\n');
    if (args[0] === 'metadata') console.log(${JSON.stringify(JSON.stringify(project))});
    else {
      const target = args[args.indexOf('--target-dir') + 1];
      fs.mkdirSync(path.join(target, 'debug/deps'), {recursive:true});
      const escaped = ${JSON.stringify(sources)}.map(file => file.replace(/([ \\\\#$:])/g, '\\\\$1'));
      fs.writeFileSync(path.join(target, 'debug/deps/checks.d'), 'artifact: ' + escaped.join(' ') + '\\n');
      ${body}
      console.log(JSON.stringify({reason:'build-finished', success:${status === 0}}));
      process.exit(${status});
    }
  `
  )
  return capture
}

function rustDiagnostic(source: string, level: string, code: string): string {
  return `console.log(JSON.stringify({reason:'compiler-message', package_id:'checks', message:{
    level:${JSON.stringify(level)}, code:{code:${JSON.stringify(code)}},
    message:'sentinel-sensitive-diagnostic', rendered:'sentinel-sensitive-source',
    spans:[{is_primary:true, file_name:${JSON.stringify(source)}, line_start:2}]
  }}));`
}

describe.each(distributions)('%s Cargo and Clippy analysis', (distribution) => {
  const { runLanguageChecks } = loadModule(join(root, distribution, 'lib/language-checks.js')) as {
    runLanguageChecks: Analyze
  }

  it('uses fresh dependency inventory, including spaces, while preserving cfg exclusions', () => {
    const directory = rustProject()
    const source = write(directory, 'src/lib.rs', 'pub fn value() -> i32 { 42 }\n')
    const module = write(directory, 'src/module with # space.rs', 'pub fn work() {}\n')
    const ignored = write(directory, 'src/disabled.rs', 'not Rust\n')
    const capture = fakeCargo(directory, [source, module])
    const result = runLanguageChecks([source, module, ignored], limits)
    expect(result.checks).toMatchObject([
      {
        tool: 'clippy',
        status: 'passed',
        files: [source, module],
        skipped_files: [ignored],
      },
    ])
    expect(result.uncovered).toContainEqual(expect.objectContaining({ path: ignored }))
    const calls = readFileSync(capture, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(calls.map((call) => call.args[0])).toEqual(['metadata', 'clippy'])
    expect(calls[1].args).toEqual(
      expect.arrayContaining([
        '--manifest-path',
        join(directory, 'Cargo.toml'),
        '--frozen',
        '--offline',
        '--all-targets',
        '--no-deps',
        '--message-format=json',
        '--target-dir',
      ])
    )
    expect(calls[1].env).toMatchObject({
      RUSTUP_AUTO_INSTALL: '0',
      RUSTUP_NO_UPDATE_CHECK: '1',
      CARGO_NET_OFFLINE: 'true',
      CARGO_INCREMENTAL: '0',
    })
    expect(existsSync(calls[1].env.CARGO_TARGET_DIR)).toBe(false)
    expect(existsSync(join(directory, 'target'))).toBe(false)
    expect(readFileSync(join(directory, 'Cargo.lock'), 'utf8')).toContain('version = 3')
  })

  it.each(['warning', 'error'])('preserves %s diagnostics and Clippy rule identifiers', (severity) => {
    const directory = rustProject()
    const source = write(directory, 'src/lib.rs', 'pub fn work() {}\n')
    fakeCargo(
      directory,
      [source],
      rustDiagnostic(source, severity, 'clippy::useless_vec'),
      severity === 'error' ? 101 : 0
    )
    const result = runLanguageChecks([source], limits)
    expect(result.checks[0]).toMatchObject({ status: severity === 'error' ? 'failed' : 'passed', files: [source] })
    expect(result.issues[0]).toMatchObject({ rule_id: 'clippy::useless_vec', severity, line_number: 2 })
    expect(JSON.stringify(result)).not.toContain('sentinel-sensitive')
  })

  it('retains source compiler errors while reporting missing coverage separately', () => {
    const directory = rustProject()
    const source = write(directory, 'src/lib.rs', 'pub fn work() {}\n')
    fakeCargo(directory, [], rustDiagnostic(source, 'error', 'E0308'), 101)
    const result = runLanguageChecks([source], limits)
    expect(result.checks[0].status).toBe('unavailable')
    expect(result.uncovered).toContainEqual(expect.objectContaining({ path: source }))
    expect(result.issues[0]).toMatchObject({ severity: 'error', rule_id: 'E0308' })
  })

  it('requires the existing workspace lockfile before executing Clippy', () => {
    const directory = rustProject()
    const source = write(directory, 'src/lib.rs', 'pub fn work() {}\n')
    rmSync(join(directory, 'Cargo.lock'))
    const capture = fakeCargo(directory, [source])
    const result = runLanguageChecks([source], limits)
    expect(result.checks[0]).toMatchObject({ status: 'unavailable', reason: expect.stringContaining('Cargo.lock') })
    expect(readFileSync(capture, 'utf8').trim().split('\n')).toHaveLength(1)
    expect(existsSync(join(directory, 'Cargo.lock'))).toBe(false)
  })

  it.each(['invalid-json', 'missing-cache', 'unknown-reason', 'invalid-completion', 'missing-dep-info'])(
    'keeps %s analysis incomplete without leaking tool output',
    (failure) => {
      const directory = rustProject()
      const source = write(directory, 'src/lib.rs', 'pub fn work() {}\n')
      const scripts: Record<string, string> = {
        'invalid-json': 'console.log("sentinel-sensitive-output");',
        'missing-cache': 'console.error("sentinel-sensitive-output"); process.exit(101);',
        'unknown-reason': 'console.log(JSON.stringify({reason:"sentinel-sensitive-output"}));',
        'invalid-completion': 'console.log(JSON.stringify({reason:"build-finished", success:false}));',
        'missing-dep-info': 'fs.rmSync(target,{recursive:true,force:true});',
      }
      fakeCargo(directory, [source], scripts[failure])
      const result = runLanguageChecks([source], limits)
      expect(result.checks[0].status).toBe('unavailable')
      expect(result.uncovered).toContainEqual(expect.objectContaining({ path: source }))
      expect(JSON.stringify(result)).not.toContain('sentinel-sensitive-output')
    }
  )
})
