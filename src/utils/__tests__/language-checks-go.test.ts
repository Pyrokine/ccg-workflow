import childProcess from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { distributions, fakeExecutable, fixture, limits, loadModule, root, write } from './language-checks-fixtures'
import type { Analyze } from './language-checks-fixtures'

function goProject(): string {
  const directory = fixture()
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
    const keys = ['GOCACHE','GOMODCACHE','GOTMPDIR','GOPROXY','GONOPROXY','GOSUMDB','GOVCS','GOTOOLCHAIN','GOWORK'];
    const env = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    fs.appendFileSync(${JSON.stringify(capture)}, JSON.stringify({args, env}) + '\\n');
    if (args[0] === 'env') console.log(JSON.stringify({
      GOMOD:${JSON.stringify(join(directory, 'go.mod'))}, GOWORK:process.env.GOWORK || '',
      GOFLAGS:process.env.GOFLAGS || '', GOMODCACHE:''
    }));
    else if (args[0] === 'list') console.log(${JSON.stringify(listing)});
    else if (args[0] === 'vet') { ${diagnostic} }
    else if (args[0] === 'mod') console.log(JSON.stringify({Go:${JSON.stringify(version)}}));
    else if (args.includes('-json')) console.log(JSON.stringify({Go:'1.22',Use:[{DiskPath:'./member'}],Replace:[]}));
  `
  )
  return capture
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
    })
    expect(existsSync(executed[2].env.GOCACHE)).toBe(false)
    expect(existsSync(executed[2].env.GOMODCACHE)).toBe(false)
    expect(existsSync(executed[2].env.GOTMPDIR)).toBe(false)
    expect(readFileSync(join(directory, 'go.mod'), 'utf8')).toContain('go 1.22')
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
      expect(result.checks[0].status).toBe('unavailable')
      expect(result.uncovered).toContainEqual(expect.objectContaining({ path: source }))
      expect(result.issues).toEqual([])
      expect(JSON.stringify(result)).not.toContain('sentinel-sensitive-output')
    }
  )

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
    vi.stubEnv('GOWORK', workspace)
    const source = write(directory, 'main.go', 'package checks\n')
    const capture = fakeGo(directory, [{ Dir: directory, GoFiles: ['main.go'] }])
    expect(runLanguageChecks([source], limits).checks[0].status).toBe('passed')
    const executed = calls(capture)
    const edit = executed.find((call) => call.args.includes('-dropuse=./member'))
    expect(edit?.args).toContain('-use=' + join(directory, 'member'))
    expect(executed.at(-1)?.env.GOWORK).not.toBe(workspace)
    expect(readFileSync(workspace, 'utf8')).toBe('go 1.22\nuse ./member\n')
    expect(existsSync(executed.at(-1)?.env.GOWORK || '')).toBe(false)
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
      reason: code === 'ETIMEDOUT' ? 'Analysis timed out' : 'Analysis output exceeded the limit',
    })
    expect(JSON.stringify(result)).not.toContain('sentinel-sensitive-output')
    expect(spawn.mock.calls[0][2]).toMatchObject({ shell: false, maxBuffer: 8 * 1024 * 1024 })
    expect(spawn.mock.calls[0][2]?.timeout).toBeGreaterThan(0)
    expect(spawn.mock.calls[0][2]?.timeout).toBeLessThanOrEqual(30000)
  })
})
