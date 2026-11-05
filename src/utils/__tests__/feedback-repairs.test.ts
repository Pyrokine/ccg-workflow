import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Analyze } from './language-checks-fixtures'
import { fakeExecutable, limits, loadModule, root } from './language-checks-fixtures'
import { distributions, fixture, repository, run, write } from './quality-gates-fixtures'

describe.each(distributions)('%s confirmed feedback repairs', (distribution) => {
  it.each(['subprocess.Popen(args)', 'reopen(args.path)', 'bread(input.path)'])(
    'keeps function-name suffixes out of PATH_TRAVERSAL: %s',
    (source) => {
      const directory = fixture()
      const file = write(directory, 'source.py', source + '\n')
      const result = run(distribution, 'security', [file], directory)
      expect(result.output.findings?.some((entry) => entry.rule_id === 'PATH_TRAVERSAL')).toBe(false)
    }
  )

  it.each(['open(args.path)', 'read(input.path)', 'os.path.join(request.path)'])(
    'keeps actual path input calls visible: %s',
    (source) => {
      const directory = fixture()
      const file = write(directory, 'source.py', source + '\n')
      const result = run(distribution, 'security', [file], directory)
      expect(result.output.findings).toContainEqual(expect.objectContaining({ rule_id: 'PATH_TRAVERSAL' }))
    }
  )

  it.each(['ignored.local.ts', 'build/nested.ts', 'build'])(
    'reports an explicit ignored target as incomplete: %s',
    (target) => {
      const directory = repository()
      write(directory, '.gitignore', '*.local.ts\nbuild/\nsrc/clean.ts\n')
      write(directory, 'ignored.local.ts', 'const value = 1\n')
      write(directory, 'build/nested.ts', 'const value = 2\n')
      const result = run(distribution, 'change', [join(directory, target)], directory)
      expect(result.status).toBe(2)
      expect(result.output).toMatchObject({
        complete: false,
        passed: false,
        error: expect.stringContaining('ignored by Git'),
      })
      const tracked = run(distribution, 'change', [join(directory, 'src/clean.ts')], directory)
      expect(tracked.status).toBe(0)
      expect(tracked.output).toMatchObject({ complete: true, passed: true, changes: [] })
    }
  )

  it.each([
    'self, first, second=(22, 24, 22), third="x,y", fourth={"key": (1, 2)}, fifth=None',
    'self, first, second, third, fourth, fifth=(22, 24, 22)',
    'self, first, second, third, fourth, fifth=lambda x, y: x + y',
    'self: "Owner", first, /, second=(1, 2), *, third=None, fourth=None, fifth=None',
    'cls: "Owner", first, second, third, *args, **kwargs',
    'self, first, second=lambda x, y: (x, y), third=None, fourth=None, fifth=None',
    [
      '',
      '    self,',
      '    first: tuple[int, int],',
      '    second=(1, 2), # default',
      '    third="x,y",',
      '    fourth=None,',
      '    fifth=None,',
      '',
    ].join('\n'),
  ])('counts Python syntax parameters without default-value separators: %s', (parameters) => {
    const directory = fixture()
    const source = write(directory, 'source.py', `def values(${parameters}):\n    return None\n`)
    const result = run(distribution, 'quality', [source], directory)
    expect(result.output.complete).toBe(true)
    expect(result.output.issues?.filter((entry) => entry.rule_id === 'FUNCTION_PARAMETERS')).toEqual([])
  })

  it('retains the Python six-parameter warning and reports incomplete signatures', () => {
    const directory = fixture()
    const source = write(directory, 'source.py', 'def values(self, a, b, c, d, e, f):\n    return None\n')
    const result = run(distribution, 'quality', [source], directory)
    expect(result.output.issues).toContainEqual(
      expect.objectContaining({
        rule_id: 'FUNCTION_PARAMETERS',
        message: expect.stringContaining('(6 > 5)'),
      })
    )
    write(directory, 'source.py', 'def values(first, second=(1, 2):\n    return None\n')
    const invalid = run(distribution, 'quality', [source], directory)
    expect(invalid.status).toBe(2)
    expect(invalid.output.complete).toBe(false)
  })

  it.each(['quality', 'security'] as const)('declares %s file type scopes without claiming TOML coverage', (gate) => {
    const directory = fixture()
    write(directory, 'source.ts', 'export const value = 1\n')
    const config = write(directory, 'permissions.toml', 'permissions = []\n')
    const supported = run(distribution, gate, [directory], directory)
    expect(supported.output).toMatchObject({
      complete: true,
      files_scanned: 1,
      supported_file_types: expect.arrayContaining(['.ts']),
    })
    const unsupported = run(distribution, gate, [config], directory)
    expect(unsupported.status).toBe(2)
    expect(unsupported.output.complete).toBe(false)
    expect(unsupported.output.scan_errors).toContainEqual(expect.objectContaining({ code: 'UNSUPPORTED_TYPE' }))
  })

  it.each(['metadata', 'clippy'])('preserves %s failure execution with sanitized Cargo stderr', (stage) => {
    const directory = fixture()
    const manifest = write(directory, 'Cargo.toml', '[package]\nname="checks"\nversion="0.1.0"\n')
    write(directory, 'Cargo.lock', 'version = 3\n')
    const source = write(directory, 'src/lib.rs', 'pub fn work() {}\n')
    const secret = 'synthetic-cargo-credential-123456'
    const stderr = [
      `error: failed to download \`cache-entry\` from https://user:${secret}@example.com/cache`,
      secret,
      '',
    ].join('\n')
    const metadata = { workspace_root: directory, packages: [{ id: 'checks', manifest_path: manifest }] }
    fakeExecutable(
      directory,
      'cargo',
      `
      if (process.argv[2] === ${JSON.stringify(stage)}) {
        process.stderr.write(${JSON.stringify(stderr)});
        process.exit(101);
      }
      console.log(${JSON.stringify(JSON.stringify(metadata))});
    `
    )
    const { runLanguageChecks } = loadModule(join(root, distribution, 'lib/language-checks.js')) as {
      runLanguageChecks: Analyze
    }
    const result = runLanguageChecks([source], limits)
    expect(result.checks[0]).toMatchObject({
      tool: 'clippy',
      status: 'unavailable',
      execution: {
        command: join(directory, 'bin/cargo'),
        args: expect.arrayContaining([stage, '--manifest-path', manifest, '--offline', '--frozen']),
        exit_code: 101,
        signal: null,
        stderr: expect.stringContaining('error: failed to download'),
        stderr_redacted: true,
      },
    })
    expect(JSON.stringify(result)).not.toContain(secret)
    expect(JSON.stringify(result)).toContain('[redacted-url]')
  })
})
