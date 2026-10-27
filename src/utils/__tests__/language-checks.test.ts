import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  loadModule,
  root,
  distributions,
  limits,
  fixture,
  write,
  dependency,
  fakeEslint,
  files,
} from './language-checks-fixtures'
import type { Analyze } from './language-checks-fixtures'

function runTypeScriptCli(directory: string) {
  return spawnSync(
    process.execPath,
    [
      join(directory, 'node_modules/typescript/bin/tsc'),
      '--project',
      join(directory, 'tsconfig.json'),
      '--noEmit',
      '--tsBuildInfoFile',
      join(fixture(), 'typecheck.tsbuildinfo'),
      '--pretty',
      'false',
    ],
    { encoding: 'utf8' }
  )
}

describe.each(distributions)('%s language tool execution', (distribution) => {
  const { runLanguageChecks } = loadModule(join(root, distribution, 'lib/language-checks.js')) as {
    runLanguageChecks: Analyze
  }

  it('uses real local ESLint AST rules, project rules and pnpm-compatible dependency symlinks', () => {
    const directory = fixture()
    dependency(directory, 'eslint')
    write(directory, 'package.json', '{}')
    write(directory, 'eslint.config.cjs', `module.exports = [{ rules: { 'no-debugger': 'error' } }];`)
    const source = write(
      directory,
      'source file.js',
      'export function branch(a,b,c) {\n if(a) return b;\n if(b) return c;\n return 0;\n}\ndebugger;\n'
    )
    const before = files(directory)
    const result = runLanguageChecks([source, source], limits)
    expect(result.checks).toEqual([expect.objectContaining({ tool: 'eslint', status: 'failed', files: [source] })])
    expect(result.uncovered).toEqual([])
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rule_id: 'complexity', severity: 'warning' }),
        expect.objectContaining({ rule_id: 'max-params', severity: 'warning' }),
        expect.objectContaining({ rule_id: 'max-lines-per-function', severity: 'warning' }),
        expect.objectContaining({ rule_id: 'no-debugger', severity: 'error', line_number: 6 }),
      ])
    )
    expect(files(directory)).toEqual(before)
    expect(readFileSync(source, 'utf8')).toContain('debugger;')
  })

  it('keeps warnings non-blocking and reports partial and total ESLint ignores', () => {
    const directory = fixture()
    dependency(directory, 'eslint')
    write(directory, 'eslint.config.cjs', `module.exports = [{ ignores: ['ignored.js'] }];`)
    const clean = write(directory, 'clean.js', 'export const answer = 42;\n')
    const ignored = write(directory, 'ignored.js', 'debugger;\n')
    const result = runLanguageChecks([clean, ignored], limits)
    expect(result.checks).toEqual([
      expect.objectContaining({ status: 'passed', files: [clean], skipped_files: [ignored] }),
    ])
    expect(result.uncovered).toContainEqual(expect.objectContaining({ path: ignored }))
    expect(runLanguageChecks([ignored], limits).checks[0].status).toBe('unavailable')
    write(directory, 'eslint.config.cjs', `module.exports = [{}];`)
    writeFileSync(clean, 'export function many(a,b,c) { return a+b+c; }\n')
    expect(runLanguageChecks([clean], limits).checks[0].status).toBe('passed')
  })

  it('uses workspace configuration with a package-local ESLint dependency', () => {
    const directory = fixture()
    write(directory, 'package.json', JSON.stringify({ workspaces: ['packages/*'] }))
    write(directory, 'eslint.config.cjs', 'module.exports = [{}];')
    const workspacePackage = join(directory, 'packages', 'library')
    write(workspacePackage, 'package.json', '{}')
    dependency(workspacePackage, 'eslint')
    const source = write(workspacePackage, 'src/source.js', 'export const value = 1;\n')
    const result = runLanguageChecks([source], limits)
    expect(result.checks[0]).toMatchObject({ tool: 'eslint', status: 'passed', files: [source] })
    expect(result.uncovered).toEqual([])
  })

  it.each(['package', 'repository'])(
    'does not inherit non-workspace ancestor resources across a %s boundary',
    (kind) => {
      const outer = fixture()
      dependency(outer, 'eslint')
      write(outer, 'eslint.config.cjs', "throw new Error('outer configuration executed');")
      write(outer, 'tsconfig.json', '{"compilerOptions":{"allowJs":true}}')
      const inner = join(outer, 'independent')
      if (kind === 'package') write(inner, 'package.json', '{}')
      else mkdirSync(join(inner, '.git'), { recursive: true })
      const source = write(inner, 'source.js', 'export const value = 1;\n')
      const result = runLanguageChecks([source], limits)
      expect(result.checks).toHaveLength(1)
      expect(result.checks[0]).toMatchObject({
        tool: 'eslint',
        status: 'unavailable',
        reason: 'Project-local tool dependency was not found',
      })
      dependency(inner, 'eslint')
      expect(runLanguageChecks([source], limits).checks[0].reason).toBe('No project ESLint configuration was found')
    }
  )

  it.each(['npm', 'pnpm'])('uses declared %s workspace dependencies and configuration', (kind) => {
    const directory = fixture()
    dependency(directory, 'eslint')
    if (kind === 'npm') write(directory, 'package.json', JSON.stringify({ workspaces: ['packages/*'] }))
    else write(directory, 'pnpm-workspace.yaml', "packages:\n  - 'packages/*'\n")
    write(directory, 'eslint.config.cjs', 'module.exports = [{}];')
    const child = join(directory, 'packages', 'library')
    write(child, 'package.json', '{}')
    const source = write(child, 'source.js', 'export const value = 1;\n')
    expect(runLanguageChecks([source], limits).checks[0]).toMatchObject({
      tool: 'eslint',
      status: 'passed',
      files: [source],
    })
  })

  it.each([false, true])(
    'checks JavaScript types only when the TypeScript program manages it: allowJs=%s',
    (allowJs) => {
      const directory = fixture()
      dependency(directory, 'eslint')
      dependency(directory, 'typescript')
      write(directory, 'eslint.config.cjs', 'module.exports = [{}];')
      write(
        directory,
        'tsconfig.json',
        JSON.stringify({ compilerOptions: { allowJs, checkJs: true, types: [] }, include: ['managed/**/*'] })
      )
      write(directory, 'managed/typed.ts', 'export const value = 1;\n')
      const source = write(directory, 'managed/source.js', '/** @type {number} */\nexport const value = "wrong";\n')
      const excluded = write(directory, 'outside.js', 'export const value = 1;\n')
      const result = runLanguageChecks([source, excluded], limits)
      expect(result.uncovered).toEqual([])
      const checks = result.checks.filter((check) => check.tool === 'typescript')
      if (allowJs) expect(checks).toEqual([expect.objectContaining({ status: 'failed', files: [source] })])
      else expect(checks).toEqual([])
    },
    20000
  )

  it('redacts credential-shaped rule IDs while preserving ordinary plugin IDs', () => {
    const directory = fixture()
    fakeEslint(directory)
    const credential = 'ghp_' + 'syntheticCredential1234567890'
    write(
      directory,
      'node_modules/eslint/index.cjs',
      'module.exports = { ESLint: class { async isPathIgnored() { return false } ' +
        'async calculateConfigForFile() { return {} } async lintFiles(files) { ' +
        "return [{filePath:files[0], messages: [{severity:2, line:1, ruleId:'" +
        credential +
        "', message:'hidden'}, {severity:1, line:1, ruleId:'@fixture/plugin-rule', " +
        "message:'hidden'}]}] } } };"
    )
    const source = write(directory, 'source.js', '')
    const result = runLanguageChecks([source], limits)
    expect(JSON.stringify(result)).not.toContain(credential)
    expect(result.issues).toContainEqual(expect.objectContaining({ rule_id: '@fixture/plugin-rule' }))
  })

  it('reports missing local dependencies and does not use the gate dependency tree', () => {
    const directory = fixture()
    const source = write(directory, 'source.js', 'debugger;\n')
    const result = runLanguageChecks([source], limits)
    expect(result.checks[0]).toMatchObject({ tool: 'eslint', status: 'unavailable', files: [] })
    expect(result.issues).toEqual([])
    expect(result.uncovered[0].path).toBe(source)
  })

  it('reports invalid ESLint config without exposing diagnostic or exception text', () => {
    const directory = fixture()
    dependency(directory, 'eslint')
    const secret = 'fixture_private_value_A1b2C3d4E5f6'
    write(directory, 'eslint.config.cjs', `throw new Error(${JSON.stringify(secret)});`)
    const source = write(directory, 'source.js', `export const token = '${secret}';\n`)
    const result = runLanguageChecks([source], limits)
    expect(result.checks[0].status).toBe('unavailable')
    expect(JSON.stringify(result)).not.toContain(secret)
    expect(result.issues).toEqual([])
  })

  it('redacts external ESLint source, suggestions and messages', () => {
    const directory = fixture()
    dependency(directory, 'eslint')
    const secret = 'synthetic_credential_9z8y7x6w5v4u'
    write(
      directory,
      'eslint.config.cjs',
      "console.log('" +
        secret +
        "'); module.exports = [{ plugins: { fixture: { rules: { leak: { " +
        "create(context) { return { Program(node) { context.report({ node, message: '" +
        secret +
        "' }); } }; } } } } }, rules: { 'fixture/leak': 'warn' } }];"
    )
    const source = write(directory, 'source.js', `export const token = '${secret}';\n`)
    const result = runLanguageChecks([source], limits)
    expect(result.checks[0].status).toBe('passed')
    expect(result.issues[0]).toMatchObject({ rule_id: 'fixture/leak', line_content: '[redacted]' })
    expect(JSON.stringify(result)).not.toContain(secret)
  })

  it('checks TypeScript project scope with real no-emit diagnostics matching the local CLI', () => {
    const directory = fixture()
    dependency(directory, 'eslint')
    dependency(directory, 'typescript')
    dependency(directory, 'typescript-eslint')
    write(
      directory,
      'eslint.config.cjs',
      "const ts = require('typescript-eslint'); module.exports = [{ files: " +
        "['**/*.ts'], languageOptions: { parser: ts.parser } }];"
    )
    write(
      directory,
      'tsconfig.json',
      JSON.stringify({
        compilerOptions: { strict: true, composite: true, incremental: true, types: [], target: 'ES2020' },
        include: ['src/**/*.ts'],
      })
    )
    const source = write(directory, 'src/main.ts', 'export const answer: number = 42;\n')
    const other = write(directory, 'src/other.ts', `export const secret: number = 'synthetic_credential_abcd1234';\n`)
    const before = files(directory)
    const result = runLanguageChecks([source], limits)
    expect(result.checks.find((check) => check.tool === 'typescript')).toMatchObject({
      status: 'failed',
      files: [source],
      project_root: directory,
      reason: expect.stringContaining('compiler API'),
    })
    expect(result.issues).toContainEqual(
      expect.objectContaining({ tool: 'typescript', rule_id: 'TS2322', file_path: other })
    )
    expect(JSON.stringify(result)).not.toContain('synthetic_credential_abcd1234')
    expect(files(directory)).toEqual(before)
    const cli = runTypeScriptCli(directory)
    expect(cli.status).toBe(2)
    expect(cli.stdout).toContain('TS2322')
  }, 20000)

  it('covers solution project references and reports files excluded from all TypeScript programs', () => {
    const directory = fixture()
    dependency(directory, 'typescript')
    fakeEslint(directory)
    write(directory, 'tsconfig.json', JSON.stringify({ files: [], references: [{ path: './library' }] }))
    write(
      directory,
      'library/tsconfig.json',
      JSON.stringify({ compilerOptions: { composite: true, types: [] }, files: ['main.ts'] })
    )
    const source = write(directory, 'library/main.ts', 'export const value = 1;\n')
    const outside = write(directory, 'outside.ts', 'export const outside = 1;\n')
    const result = runLanguageChecks([outside, source], limits)
    const typeChecks = result.checks.filter((check) => check.tool === 'typescript')
    expect(typeChecks).toHaveLength(1)
    expect(typeChecks[0]).toMatchObject({ status: 'passed', files: [source], project_root: join(directory, 'library') })
    expect(result.uncovered).toContainEqual(expect.objectContaining({ path: outside }))
    expect(files(directory).some((file) => /tsbuildinfo|main\.js|main\.d\.ts/u.test(file))).toBe(false)
  }, 20000)

  it.each(['{"compilerOptions":{"unknownSetting":true}}', '{invalid json'])(
    'reports TypeScript configuration failure without source errors',
    (config) => {
      const directory = fixture()
      dependency(directory, 'typescript')
      fakeEslint(directory)
      write(directory, 'tsconfig.json', config)
      const source = write(directory, 'source.ts', 'export const value = 1;\n')
      const result = runLanguageChecks([source], limits)
      expect(result.checks.find((check) => check.tool === 'typescript')?.status).toBe('unavailable')
      expect(result.issues).toEqual([])
    }
  )

  it('preserves tool output write callbacks while keeping diagnostics private', () => {
    const directory = fixture()
    fakeEslint(
      directory,
      `this.lintFiles = async (files) => {
      await new Promise(done => process.stdout.write('synthetic_callback_credential_12345', done));
      return files.map(filePath => ({filePath, messages: []}));
    };`
    )
    write(directory, 'eslint.config.cjs', 'module.exports = [{}];')
    const source = write(directory, 'source.js', '')
    const cp = loadModule('node:child_process') as typeof import('node:child_process')
    const nativeSpawn = cp.spawnSync
    vi.spyOn(cp, 'spawnSync').mockImplementation((command, args, options) =>
      nativeSpawn(command, args, { ...options, timeout: 1000 })
    )
    const result = runLanguageChecks([source], limits)
    expect(result.checks[0].status).toBe('passed')
    expect(JSON.stringify(result)).not.toContain('synthetic_callback_credential_12345')
  })

  it('enforces process timeout and output bounds with explicit argv', () => {
    const directory = fixture()
    fakeEslint(directory)
    const source = write(directory, 'source.js', '')
    const cp = loadModule('node:child_process') as typeof import('node:child_process')
    const spy = vi.spyOn(cp, 'spawnSync').mockReturnValueOnce({
      error: Object.assign(new Error('synthetic-secret'), { code: 'ETIMEDOUT' }),
      status: null,
      signal: 'SIGKILL',
      pid: 0,
      output: [],
      stdout: '',
      stderr: '',
    })
    const result = runLanguageChecks([source], limits)
    expect(result.checks[0]).toMatchObject({ status: 'unavailable', reason: 'Analysis timed out' })
    expect(spy).toHaveBeenCalledWith(
      process.execPath,
      [expect.any(String), '--language-check-worker'],
      expect.objectContaining({ timeout: 30000, maxBuffer: 8 * 1024 * 1024, shell: false, killSignal: 'SIGKILL' })
    )
    expect(JSON.stringify(result)).not.toContain('synthetic-secret')
  })

  it.each(['process.exit(2)', "process.kill(process.pid, 'SIGTERM')"])(
    'reports Node worker abnormal termination: %s',
    (termination) => {
      const directory = fixture()
      fakeEslint(directory, termination)
      const source = write(directory, 'source.js', '')
      expect(runLanguageChecks([source], limits).checks[0].status).toBe('unavailable')
    }
  )

  it('keeps both distribution modules byte-identical', () => {
    expect(readFileSync(join(root, distributions[0], 'lib/language-checks.js'), 'utf8')).toBe(
      readFileSync(join(root, distributions[1], 'lib/language-checks.js'), 'utf8')
    )
  })
})
