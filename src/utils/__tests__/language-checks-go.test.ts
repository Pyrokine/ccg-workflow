import childProcess from 'node:child_process'
import fs, { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Analyze } from './language-checks-fixtures'
import {
  distributions,
  fakeExecutable,
  fixture,
  limits,
  loadModule,
  nativeClock,
  root,
  write,
} from './language-checks-fixtures'

function goProject(): string {
  vi.stubEnv('GOFLAGS', '')
  vi.stubEnv('GOWORK', '')
  vi.stubEnv('GOCACHE', '')
  vi.stubEnv('GOMODCACHE', '')
  const directory = fixture()
  vi.stubEnv('HOME', directory)
  vi.stubEnv('USERPROFILE', directory)
  vi.stubEnv('LOCALAPPDATA', join(directory, 'cache'))
  vi.stubEnv('XDG_CACHE_HOME', join(directory, 'cache'))
  write(directory, 'go.mod', 'module example.test/checks\n\ngo 1.22\n')
  return directory
}

function fakeGo(directory: string, inventory: object[], diagnostic = 'console.log("{}");', version = '1.22'): string {
  const capture = join(directory, 'calls.jsonl')
  const listing = inventory.map((entry) => JSON.stringify(entry)).join('\n')
  fakeExecutable(
    directory,
    'go',
    `
    const fs = require('node:fs');
    const args = process.argv.slice(2);
    const keys = [
      'GOCACHE','GOCACHEPROG','GOMODCACHE','GOTMPDIR','GOPROXY','GONOPROXY',
      'GOSUMDB','GOVCS','GOTOOLCHAIN','GOTELEMETRY','GOWORK','GOFLAGS'
    ];
    const env = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    fs.appendFileSync(${JSON.stringify(capture)}, JSON.stringify({args, env}) + '\\n');
    if (args[0] === 'env') console.log(JSON.stringify({
      GOMOD:${JSON.stringify(join(directory, 'go.mod'))}, GOWORK:process.env.GOWORK || '',
      GOFLAGS:process.env.GOFLAGS || '', GOMODCACHE:process.env.GOMODCACHE || ''
    }));
    else if (args[0] === 'list') console.log(${JSON.stringify(listing)});
    else if (args[0] === 'vet') { ${diagnostic} }
    else if (args[0] === 'mod') console.log(JSON.stringify({Go:${JSON.stringify(version)}}));
    else if (args.includes('-json')) console.log(JSON.stringify({Go:'1.22',Use:[{DiskPath:'./member'}],Replace:[]}));
  `
  )
  return capture
}

function goCache(directory: string): string {
  const base = process.platform === 'darwin' ? join(directory, 'Library', 'Caches') : join(directory, 'cache')
  return join(base, 'ccg', 'go-build')
}

function calls(file: string): Array<{ args: string[]; env: Record<string, string> }> {
  return readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
}

describe.each(distributions)('%s Go project analysis', (distribution) => {
  const { runLanguageChecks } = loadModule(join(root, distribution, 'lib/language-checks.js')) as {
    runLanguageChecks: Analyze
  }

  it('uses package and test inventories, preserving platform exclusions and private output', () => {
    const directory = goProject()
    vi.stubEnv('GOCACHEPROG', 'unrequested-cache-program')
    const source = write(directory, 'main.go', 'package checks\n')
    const test = write(directory, 'main_test.go', 'package checks\n')
    const ignored = write(directory, 'main_other.go', '//go:build never_enabled\npackage checks\n')
    const capture = fakeGo(directory, [{ Dir: directory, GoFiles: ['main.go'], TestGoFiles: ['main_test.go'] }])
    const result = runLanguageChecks([source, test, ignored], limits)
    expect(result.checks).toMatchObject([
      {
        tool: 'go-vet',
        status: 'passed',
        files: [source, test],
        skipped_files: [ignored],
      },
    ])
    expect(result.uncovered).toContainEqual(expect.objectContaining({ path: ignored }))
    const executed = calls(capture)
    expect(executed.map((call) => call.args[0])).toEqual(['env', 'list', 'vet'])
    expect(executed[1].args).toEqual(['list', '-mod=readonly', '-json', '-test', './'])
    expect(executed[2].args).toEqual(['vet', '-mod=readonly', '-json', './'])
    expect(executed[2].env).toMatchObject({
      GOPROXY: 'off',
      GONOPROXY: 'none',
      GOSUMDB: 'off',
      GOVCS: '*:off',
      GOTOOLCHAIN: 'local',
      GOCACHEPROG: '',
    })
    expect(result.checks[0].cache).toMatchObject({ mode: 'persistent', path: executed[2].env.GOCACHE })
    expect(existsSync(executed[2].env.GOCACHE)).toBe(true)
    expect(lstatSync(executed[2].env.GOCACHE).mode & 0o777).toBe(0o700)
    expect(existsSync(executed[2].env.GOMODCACHE)).toBe(false)
    expect(existsSync(executed[2].env.GOTMPDIR)).toBe(false)
    expect(readFileSync(join(directory, 'go.mod'), 'utf8')).toContain('go 1.22')
  })

  it('reuses build artifacts while executing new source and build conditions on every call', () => {
    const directory = goProject()
    const source = write(directory, 'main.go', 'package checks\n')
    const capture = fakeGo(
      directory,
      [{ Dir: directory, GoFiles: ['main.go'] }],
      `if (fs.readFileSync(${JSON.stringify(source)}, 'utf8').includes('broken')) {
        console.error(${JSON.stringify(`${source}:2:3: invalid source`)}); process.exit(1);
      } else console.log('{}');`
    )
    const first = runLanguageChecks([source], limits)
    expect(first.checks[0]).toMatchObject({
      status: 'passed',
      cache: { mode: 'persistent', path: goCache(directory) },
    })
    const artifact = write(goCache(directory), 'artifact', 'previous build')
    write(directory, 'main.go', 'package checks\nbroken\n')
    vi.stubEnv('GOFLAGS', '-tags=changed')
    const second = runLanguageChecks([source], limits)
    expect(second.checks[0]).toMatchObject({ status: 'failed', cache: { path: goCache(directory) } })
    expect(second.issues[0].rule_id).toBe('compile-error')
    expect(readFileSync(artifact, 'utf8')).toBe('previous build')
    const executed = calls(capture)
    expect(executed.map((call) => call.args[0])).toEqual(['env', 'list', 'vet', 'env', 'list', 'vet'])
    expect(new Set(executed.map((call) => call.env.GOCACHE))).toEqual(new Set([goCache(directory)]))
    expect(executed.at(-1)?.env.GOFLAGS).toBe('-tags=changed')
    expect(executed[2].env.GOTMPDIR).not.toBe(executed[5].env.GOTMPDIR)
    for (const call of executed.filter((entry) => entry.args[0] === 'vet')) {
      expect(existsSync(call.env.GOTMPDIR)).toBe(false)
      expect(existsSync(call.env.GOMODCACHE)).toBe(false)
    }
    rmSync(goCache(directory), { recursive: true })
    write(directory, 'main.go', 'package checks\n')
    expect(runLanguageChecks([source], limits).checks[0].status).toBe('passed')
    expect(existsSync(goCache(directory))).toBe(true)
    expect(calls(capture).filter((call) => call.args[0] === 'vet')).toHaveLength(3)
  })

  it('shares one private build cache across concurrent isolated invocations', async () => {
    const directory = goProject()
    const source = write(directory, 'main.go', 'package checks\n')
    const capture = fakeGo(directory, [{ Dir: directory, GoFiles: ['main.go'] }])
    const script = `const { runLanguageChecks } = require(${JSON.stringify(
      join(root, distribution, 'lib/language-checks.js')
    )}); console.log(JSON.stringify(runLanguageChecks(${JSON.stringify([source])}, ${JSON.stringify(limits)})));`
    const invoke = () =>
      new Promise<ReturnType<Analyze>>((resolve, reject) => {
        childProcess.execFile(
          process.execPath,
          ['-e', script],
          { cwd: directory, env: { ...process.env }, timeout: 10000 },
          (error, stdout) => {
            if (error) {
              reject(error)
              return
            }
            try {
              resolve(JSON.parse(stdout))
            } catch (error) {
              reject(error)
            }
          }
        )
      })
    const results = await Promise.all([invoke(), invoke()])
    for (const result of results) {
      expect(result.checks[0]).toMatchObject({
        status: 'passed',
        cache: { mode: 'persistent', path: goCache(directory) },
      })
    }
    const vetted = calls(capture).filter((call) => call.args[0] === 'vet')
    expect(vetted).toHaveLength(2)
    expect(new Set(vetted.map((call) => call.env.GOTMPDIR)).size).toBe(2)
    for (const call of vetted) {
      expect(call.env.GOCACHE).toBe(goCache(directory))
      expect(existsSync(call.env.GOTMPDIR)).toBe(false)
      expect(existsSync(call.env.GOMODCACHE)).toBe(false)
    }
    expect(existsSync(goCache(directory))).toBe(true)
  }, 15000)

  it('keeps the original build and module caches unchanged', () => {
    const directory = goProject()
    const source = write(directory, 'main.go', 'package checks\n')
    const originalCache = join(directory, 'original-cache')
    const marker = write(originalCache, 'marker', 'original build')
    const moduleCache = join(directory, 'original-modules')
    const module = write(moduleCache, 'example.test/dependency@v1.0.0/dep.go', 'package dependency\n')
    const download = write(moduleCache, 'cache/download/example.test/dependency/@v/list', 'v1.0.0\n')
    vi.stubEnv('GOCACHE', originalCache)
    vi.stubEnv('GOMODCACHE', moduleCache)
    const capture = fakeGo(
      directory,
      [{ Dir: directory, GoFiles: ['main.go'] }],
      `
      fs.writeFileSync(require('node:path').join(process.env.GOCACHE, 'artifact'), 'new build');
      fs.writeFileSync(require('node:path').join(process.env.GOMODCACHE,
        'cache/download/example.test/dependency/@v/list'), 'isolated list');
      console.log('{}');
    `
    )
    expect(runLanguageChecks([source], limits).checks[0].status).toBe('passed')
    expect(readFileSync(marker, 'utf8')).toBe('original build')
    expect(fs.readdirSync(originalCache)).toEqual(['marker'])
    expect(readFileSync(module, 'utf8')).toBe('package dependency\n')
    expect(readFileSync(download, 'utf8')).toBe('v1.0.0\n')
    const executed = calls(capture).at(-1)
    expect(executed?.env.GOCACHE).toBe(goCache(directory))
    expect(existsSync(executed?.env.GOMODCACHE || '')).toBe(false)
  })

  it.each(['root-symlink', 'cache-symlink', 'permissions', 'foreign-owner', 'read-only-home', 'unwritable'])(
    'uses an explicit temporary build cache for %s',
    (failure) => {
      const directory = goProject()
      const source = write(directory, 'main.go', 'package checks\n')
      const home = failure === 'read-only-home' ? fixture() : directory
      vi.stubEnv('HOME', home)
      vi.stubEnv('USERPROFILE', home)
      vi.stubEnv('XDG_CACHE_HOME', join(home, 'cache'))
      const persistent = goCache(home)
      const destination = fixture()
      const marker = write(destination, 'marker', 'untouched')
      const reasons: Record<string, string> = {
        'root-symlink': 'symlink',
        'cache-symlink': 'symlink',
        permissions: 'permissions are not private',
        'foreign-owner': 'belongs to another user',
        'read-only-home': 'not writable and searchable',
        unwritable: 'EACCES',
      }
      if (failure === 'root-symlink') {
        mkdirSync(dirname(dirname(persistent)), { recursive: true, mode: 0o700 })
        symlinkSync(destination, dirname(persistent), 'junction')
      } else if (failure === 'cache-symlink') {
        mkdirSync(dirname(persistent), { recursive: true, mode: 0o700 })
        symlinkSync(destination, persistent, 'junction')
      } else if (failure === 'read-only-home') {
        chmodSync(home, 0o500)
      } else {
        mkdirSync(persistent, { recursive: true, mode: 0o700 })
        if (failure === 'permissions') {
          chmodSync(persistent, 0o755)
        } else if (failure === 'foreign-owner') {
          vi.spyOn(process, 'geteuid').mockReturnValue(process.geteuid!() + 1)
        } else {
          const access = fs.accessSync
          vi.spyOn(fs, 'accessSync').mockImplementation((file, mode) => {
            if (String(file) === persistent) {
              throw Object.assign(new Error('denied'), { code: 'EACCES' })
            }
            return access(file, mode)
          })
        }
      }
      const capture = fakeGo(directory, [{ Dir: directory, GoFiles: ['main.go'] }])
      let result: ReturnType<Analyze>
      try {
        result = runLanguageChecks([source], limits)
      } finally {
        chmodSync(home, 0o700)
      }
      expect(result.checks[0]).toMatchObject({
        status: 'passed',
        cache: { mode: 'temporary', reason: expect.stringContaining(reasons[failure]) },
        reason: expect.stringContaining('Go build cache: temporary'),
      })
      const cache = result.checks[0].cache!
      expect(cache.path).not.toBe(persistent)
      expect(calls(capture).every((call) => call.env.GOCACHE === cache.path)).toBe(true)
      expect(existsSync(cache.path)).toBe(false)
      expect(readFileSync(marker, 'utf8')).toBe('untouched')
    }
  )

  it('uses a temporary cache when the dedicated location overlaps the original GOCACHE', () => {
    const directory = goProject()
    const source = write(directory, 'main.go', 'package checks\n')
    vi.stubEnv('GOCACHE', dirname(goCache(directory)))
    fakeGo(directory, [{ Dir: directory, GoFiles: ['main.go'] }])
    expect(runLanguageChecks([source], limits).checks[0]).toMatchObject({
      status: 'passed',
      cache: { mode: 'temporary', reason: expect.stringContaining('overlap the original GOCACHE') },
    })
    expect(existsSync(goCache(directory))).toBe(false)
  })

  it('keeps an original cache nested under the dedicated location unchanged', () => {
    const directory = goProject()
    const source = write(directory, 'main.go', 'package checks\n')
    const original = join(goCache(directory), 'original')
    const marker = write(original, 'preserved', 'original artifact')
    vi.stubEnv('GOCACHE', original)
    fakeGo(directory, [{ Dir: directory, GoFiles: ['main.go'] }])
    expect(runLanguageChecks([source], limits).checks[0]).toMatchObject({
      status: 'passed',
      cache: { mode: 'temporary', reason: expect.stringContaining('overlap the original GOCACHE') },
    })
    expect(readFileSync(marker, 'utf8')).toBe('original artifact')
  })

  it('preserves temporary-cache compatibility when ownership checks are unavailable', () => {
    const directory = goProject()
    const source = write(directory, 'main.go', 'package checks\n')
    fakeGo(directory, [{ Dir: directory, GoFiles: ['main.go'] }])
    vi.stubGlobal('process', { ...process, platform: 'win32' })
    try {
      expect(runLanguageChecks([source], limits).checks[0]).toMatchObject({
        status: 'passed',
        cache: { mode: 'temporary', reason: expect.stringContaining('ownership checks are unavailable') },
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('retains native analyzer diagnostics from stderr without their content', () => {
    const directory = goProject()
    const source = write(directory, 'main.go', 'package checks\n')
    const diagnostic = {
      'example.test/checks': {
        printf: [
          {
            posn: `${source}:2:3`,
            message: 'sentinel-sensitive-diagnostic',
          },
        ],
      },
    }
    fakeGo(
      directory,
      [{ Dir: directory, GoFiles: ['main.go'] }],
      `console.error('# example.test/checks\\n' + ${JSON.stringify(JSON.stringify(diagnostic))});`
    )
    const result = runLanguageChecks([source], limits)
    expect(result.checks[0]).toMatchObject({ status: 'failed', diagnostics: 1, files: [source] })
    expect(result.issues[0]).toMatchObject({ rule_id: 'printf', severity: 'error', line_number: 2 })
    expect(JSON.stringify(result)).not.toContain('sentinel-sensitive-diagnostic')
  })

  it.each(['', 'vet: '])('reports compiler failures as source errors after a valid package inventory: %s', (prefix) => {
    const directory = goProject()
    const source = write(directory, 'main.go', 'package checks\n')
    const output = JSON.stringify(`# example.test/checks\n${prefix}${source}:2:3: type mismatch`)
    fakeGo(directory, [{ Dir: directory, GoFiles: ['main.go'] }], `console.error(${output}); process.exit(1);`)
    const result = runLanguageChecks([source], limits)
    expect(result.checks[0]).toMatchObject({ status: 'failed', files: [source] })
    expect(result.issues[0]).toMatchObject({ rule_id: 'compile-error', severity: 'error', line_number: 2 })
  })

  it.each(['invalid-json', 'failed-tool', 'signal', 'missing-location'])(
    'keeps %s analysis incomplete and redacted',
    (failure) => {
      const directory = goProject()
      const source = write(directory, 'main.go', 'package checks\n')
      const scripts: Record<string, string> = {
        'invalid-json': 'console.log("sentinel-sensitive-output");',
        'failed-tool': 'console.error("sentinel-sensitive-output"); process.exit(2);',
        signal: 'process.kill(process.pid, "SIGTERM");',
        'missing-location': 'console.log(JSON.stringify({pkg:{printf:[{message:"sentinel-sensitive-output"}]}}));',
      }
      fakeGo(directory, [{ Dir: directory, GoFiles: ['main.go'] }], scripts[failure])
      const result = runLanguageChecks([source], limits)
      expect(result.checks[0]).toMatchObject({ status: 'unavailable', cache: { mode: 'persistent' } })
      expect(result.uncovered).toContainEqual(
        expect.objectContaining({ path: source, reason: expect.stringContaining('Go build cache: persistent') })
      )
      expect(result.issues).toEqual([])
      expect(JSON.stringify(result)).not.toContain('sentinel-sensitive-output')
    }
  )

  it('retains Go failure locations and redacts credentials in native stderr', () => {
    const directory = goProject()
    const source = write(directory, 'main.go', 'package checks\n')
    const secret = 'synthetic-go-credential-123456'
    const stderr = [
      'go: errors parsing go.mod:',
      `${directory}/go.mod:3: invalid go version '1.bad': token=${secret}`,
      `${source}:7:2: const internalValue = 42`,
      secret,
      '',
    ].join('\n')
    fakeExecutable(directory, 'go', `process.stderr.write(${JSON.stringify(stderr)}); process.exit(2);`)
    const result = runLanguageChecks([source], limits)
    const check = result.checks[0] as (typeof result.checks)[0] & { execution: { stderr: string } }
    expect(check.status).toBe('unavailable')
    expect(check.execution.stderr).toContain('go: errors parsing go.mod:')
    expect(check.execution.stderr).toContain(`${directory}/go.mod:3: invalid go version`)
    expect(check.execution.stderr).toContain(`${source}:7:2:`)
    expect(check.execution.stderr).not.toContain('internalValue')
    expect(check.execution.stderr).not.toContain('1.bad')
    expect(JSON.stringify(result)).not.toContain(secret)
  })

  it.each([1, 2])(
    'summarizes three-line Go vet failures without exposing package names or identifiers (exit %s)',
    (exitCode) => {
      const directory = goProject()
      const source = write(directory, 'main.go', 'package checks\n')
      const dependency = write(directory, 'dependency/dep.go', 'package dependency\n')
      const stderr = [
        '# example.test/private-package',
        '# example.test/private-package [example.test/private-package.test]',
        `vet: ${dependency}:7:2: undefined: internalValue`,
      ].join('\n')
      fakeGo(
        directory,
        [{ Dir: directory, GoFiles: ['main.go'] }],
        `console.error(${JSON.stringify(stderr)}); process.exit(${exitCode});`
      )
      const result = runLanguageChecks([source], limits)
      expect(result.checks[0]).toMatchObject({
        status: 'unavailable',
        execution: {
          args: expect.arrayContaining(['vet']),
          exit_code: exitCode,
          stderr: `# [redacted-package]\n# [redacted-package]\nvet: ${dependency}:7:2: undefined [redacted]`,
          stderr_redacted: true,
        },
      })
      expect(result.uncovered).toContainEqual(expect.objectContaining({ path: source }))
      expect(JSON.stringify(result)).not.toMatch(/private-package|internalValue/u)
    }
  )

  it.each([
    [
      'no required module provides package example.test/private-dependency; ' +
        'to add it: go get example.test/private-dependency',
      'no required module provides package',
    ],
    ['missing go.sum entry for module providing package example.test/private-dependency', 'missing go.sum entry'],
    ['syntax error: unexpected privateIdentifier, expected (', 'syntax error'],
    ["expected operand, found 'privateIdentifier'", 'expected'],
    [
      'cannot use internalValue (variable of type privateType) as string value in argument to privateFunc',
      'cannot use',
    ],
    ['could not import example.test/private-dependency (invalid package name: privateName)', 'could not import'],
  ])('retains only the Go failure category for %s', (diagnostic, category) => {
    const directory = goProject()
    const source = write(directory, 'main.go', 'package checks\n')
    const stderr = `${source}:4:8: ${diagnostic}`
    fakeGo(
      directory,
      [{ Dir: directory, GoFiles: ['main.go'] }],
      `console.error(${JSON.stringify(stderr)}); process.exit(2);`
    )
    const result = runLanguageChecks([source], limits)
    expect(result.checks[0]).toMatchObject({
      status: 'unavailable',
      execution: { stderr: `${source}:4:8: ${category} [redacted]`, stderr_redacted: true },
    })
    expect(JSON.stringify(result)).not.toMatch(
      /privateIdentifier|privateType|privateFunc|private-dependency|privateName|internalValue/u
    )
  })

  it('keeps unknown Go stderr and credential-shaped values private within output budgets', () => {
    const directory = goProject()
    const source = write(directory, 'main.go', 'package checks\n')
    const secrets = ['synthetic-opaque-credential', `ghp_${'x'.repeat(36)}`, `AKIA${'X'.repeat(16)}`]
    const stderr = [
      `vet: ${source}:3:5: cannot use ${secrets.join(' ')} as privateType`,
      `go: ${secrets.join(' ')} https://example.test/private-url`,
      `${source}:6:1: const internalValue = 42`,
      `${directory}/go.mod:8: const privateValue = 43`,
      ...secrets,
      ...Array.from({ length: 25 }, () => `unrecognized private text ${'x'.repeat(200)}`),
    ].join('\n')
    fakeExecutable(directory, 'go', `process.stderr.write(${JSON.stringify(stderr)}); process.exit(1);`)
    const result = runLanguageChecks([source], limits)
    const check = result.checks[0] as (typeof result.checks)[0] & { execution: { stderr: string } }
    expect(check).toMatchObject({ status: 'unavailable', execution: { exit_code: 1, stderr_redacted: true } })
    expect(check.execution.stderr).toContain(`vet: ${source}:3:5: cannot use [redacted]`)
    expect(check.execution.stderr).toContain(`${source}:6:1: [redacted]`)
    expect(check.execution.stderr).toContain(`${directory}/go.mod:8: [redacted]`)
    expect(check.execution.stderr.split('\n')).toHaveLength(20)
    expect(check.execution.stderr.length).toBeLessThanOrEqual(2000)
    for (const value of [
      ...secrets,
      'internalValue',
      'privateValue',
      'privateType',
      'private-url',
      'unrecognized private text',
    ]) {
      expect(JSON.stringify(result)).not.toContain(value)
    }
  })

  it('validates the existing overlay and retains vendor build mode', () => {
    const directory = goProject()
    const source = write(directory, 'main.go', 'package checks\n')
    const replacement = write(directory, 'overlay.txt', 'package checks\n')
    const overlay = write(directory, 'overlay.json', JSON.stringify({ Replace: { [source]: replacement } }))
    vi.stubEnv('GOFLAGS', `-mod=vendor '-overlay=${overlay}'`)
    const capture = fakeGo(directory, [{ Dir: directory, GoFiles: ['main.go'] }])
    expect(runLanguageChecks([source], limits).checks[0]).toMatchObject({ status: 'passed', files: [source] })
    expect(calls(capture)[1].args).toContain('-mod=vendor')
    write(directory, 'overlay.json', JSON.stringify({ Replace: { [source]: join(directory, 'missing.txt') } }))
    expect(runLanguageChecks([source], limits).checks[0].status).toBe('unavailable')
  })

  it.each(['1.13', '1.22'])('keeps native default vendor selection for Go %s', (version) => {
    const directory = goProject()
    const source = write(directory, 'main.go', 'package checks\n')
    write(directory, 'vendor/modules.txt', '# Cached dependency\n')
    const capture = fakeGo(directory, [{ Dir: directory, GoFiles: ['main.go'] }], 'console.log("{}");', version)
    expect(runLanguageChecks([source], limits).checks[0].status).toBe('passed')
    const executed = calls(capture)
    expect(executed.find((call) => call.args[0] === 'mod')?.args).toEqual([
      'mod',
      'edit',
      '-json',
      join(directory, 'go.mod'),
    ])
    expect(executed.find((call) => call.args[0] === 'vet')?.args).toContain(
      version === '1.13' ? '-mod=readonly' : '-mod=vendor'
    )
  })

  it('retains explicit readonly mode despite an automatic vendor directory', () => {
    const directory = goProject()
    const source = write(directory, 'main.go', 'package checks\n')
    write(directory, 'vendor/modules.txt', '# Cached dependency\n')
    vi.stubEnv('GOFLAGS', '-mod=readonly')
    const capture = fakeGo(directory, [{ Dir: directory, GoFiles: ['main.go'] }])
    expect(runLanguageChecks([source], limits).checks[0].status).toBe('passed')
    expect(calls(capture).find((call) => call.args[0] === 'vet')?.args).toContain('-mod=readonly')
  })

  it('copies workspace state to a temporary path and rebases module paths', () => {
    const directory = goProject()
    const workspace = write(directory, 'go.work', 'go 1.22\nuse ./member\n')
    const workspaceSum = write(directory, 'go.work.sum', 'workspace sums\n')
    const moduleSum = write(directory, 'go.sum', 'module sums\n')
    vi.stubEnv('GOWORK', workspace)
    const source = write(directory, 'main.go', 'package checks\n')
    const capture = fakeGo(directory, [{ Dir: directory, GoFiles: ['main.go'] }])
    expect(runLanguageChecks([source], limits).checks[0].status).toBe('passed')
    const executed = calls(capture)
    const edit = executed.find((call) => call.args.includes('-dropuse=./member'))
    expect(edit?.args).toContain('-use=' + join(directory, 'member'))
    expect(executed.at(-1)?.env.GOWORK).not.toBe(workspace)
    expect(readFileSync(workspace, 'utf8')).toBe('go 1.22\nuse ./member\n')
    expect(readFileSync(workspaceSum, 'utf8')).toBe('workspace sums\n')
    expect(readFileSync(moduleSum, 'utf8')).toBe('module sums\n')
    expect(existsSync(executed.at(-1)?.env.GOWORK || '')).toBe(false)
    expect(runLanguageChecks([source], limits).checks[0].status).toBe('passed')
    const repeated = calls(capture).filter((call) => call.args[0] === 'vet')
    expect(new Set(repeated.map((call) => call.env.GOCACHE))).toEqual(new Set([goCache(directory)]))
    expect(new Set(repeated.map((call) => call.env.GOWORK)).size).toBe(2)
    expect(repeated.every((call) => !existsSync(call.env.GOWORK))).toBe(true)
  })

  it('shares a 120 second group budget across Go setup, inventory and vet', () => {
    const directory = goProject()
    const source = write(directory, 'main.go', 'package checks\n')
    fakeGo(directory, [{ Dir: directory, GoFiles: ['main.go'] }])
    const spawn = nativeClock({ env: 45000, list: 45000 })
    const result = runLanguageChecks([source], limits)
    expect(result.checks[0]).toMatchObject({
      status: 'passed',
      timing: { budget_ms: 120000, elapsed_ms: 90000 },
    })
    const budgets = spawn.mock.calls.map((call) => call[2]?.timeout)
    expect(budgets).toEqual([120000, 75000, 30000])
  })

  it('keeps an exhausted Go group unavailable with the responsible stage', () => {
    const directory = goProject()
    const source = write(directory, 'main.go', 'package checks\n')
    fakeGo(directory, [{ Dir: directory, GoFiles: ['main.go'] }])
    nativeClock({ list: 120001 })
    const result = runLanguageChecks([source], limits)
    expect(result.checks[0]).toMatchObject({
      status: 'unavailable',
      reason: expect.stringContaining('Analysis timed out'),
      cache: { mode: 'persistent' },
      timing: { budget_ms: 120000, phase: 'list' },
    })
    expect(result.uncovered).toContainEqual(expect.objectContaining({ path: source }))
  })

  it.each(['ETIMEDOUT', 'ENOBUFS'])('bounds %s failures without disabling the process limits', (code) => {
    const directory = goProject()
    const source = write(directory, 'main.go', 'package checks\n')
    fakeGo(directory, [{ Dir: directory, GoFiles: ['main.go'] }])
    const spawn = vi.spyOn(childProcess, 'spawnSync').mockReturnValue({
      error: Object.assign(new Error('sentinel-sensitive-output'), { code }),
      status: null,
      signal: 'SIGKILL',
      pid: 0,
      output: [],
      stdout: '',
      stderr: '',
    })
    const result = runLanguageChecks([source], limits)
    expect(result.checks[0]).toMatchObject({
      status: 'unavailable',
      reason: expect.stringContaining(
        code === 'ETIMEDOUT' ? 'Analysis timed out' : 'Analysis output exceeded the limit'
      ),
    })
    expect(JSON.stringify(result)).not.toContain('sentinel-sensitive-output')
    expect(spawn.mock.calls[0][2]).toMatchObject({ shell: false, maxBuffer: 8 * 1024 * 1024 })
    expect(spawn.mock.calls[0][2]?.timeout).toBeGreaterThan(0)
    expect(spawn.mock.calls[0][2]?.timeout).toBeGreaterThan(30000)
    expect(spawn.mock.calls[0][2]?.timeout).toBeLessThanOrEqual(120000)
  })
})
