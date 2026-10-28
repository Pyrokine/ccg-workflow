import { spawnSync } from 'node:child_process'
import { symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { packageRoot, distributions, scripts, fixture, write, run, lintProject } from './quality-gates-fixtures'

describe.each(distributions)('%s quality gates', (distribution) => {
  describe('language mode integration', () => {
    it('keeps the text-only contract and maps actual lint errors to exit 1', () => {
      const root = lintProject()
      const source = write(root, 'source.js', 'debugger;\n')
      const text = run(distribution, 'quality', [source], root)
      expect(text.status).toBe(0)
      expect(text.output).toMatchObject({ complete: true, analysis_mode: 'text', checks: [] })
      const language = run(distribution, 'quality', [source, '--language-checks'], root)
      expect(language.status).toBe(1)
      expect(language.output).toMatchObject({ complete: true, passed: false, analysis_mode: 'language' })
      expect(language.output.checks).toContainEqual(
        expect.objectContaining({ tool: 'eslint', status: 'failed', files: [source] })
      )
      expect(language.output.issues).toContainEqual(
        expect.objectContaining({ rule_id: 'no-debugger', origin: 'unclassified' })
      )
    })

    it('keeps AST threshold warnings non-blocking', () => {
      const root = lintProject()
      const source = write(
        root,
        'source.js',
        'export function work(a,b,c,d,e,f) {\n' + '  doWork();\n'.repeat(55) + '}\n'
      )
      const result = run(distribution, 'quality', [source, '--language-checks'], root)
      expect(result.status).toBe(0)
      expect(result.output).toMatchObject({ complete: true, passed: true })
      expect(result.output.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ rule_id: 'max-params', severity: 'warning' }),
          expect.objectContaining({ rule_id: 'max-lines-per-function', severity: 'warning' }),
        ])
      )
    })

    it.each(['missing-tool', 'ignored'])('maps %s analysis to incomplete exit 2', (kind) => {
      const root = kind === 'ignored' ? lintProject() : fixture()
      if (kind === 'ignored') write(root, 'eslint.config.cjs', 'module.exports = [{ignores:["source.js"]}];\n')
      const source = write(root, 'source.js', 'debugger;\n')
      const result = run(distribution, 'quality', [source, '--language-checks'], root)
      expect(result.status).toBe(2)
      expect(result.output).toMatchObject({ complete: false, passed: false, files_scanned: 1 })
      expect(result.output.checks).toContainEqual(expect.objectContaining({ status: 'unavailable', files: [] }))
      expect(result.output.uncovered).toContainEqual(expect.objectContaining({ path: source }))
    })

    it.each(['relative-root', 'missing-project'])(
      'separates %s parser configuration errors from source errors',
      (kind) => {
        const root = lintProject()
        for (const name of ['typescript', 'typescript-eslint']) {
          symlinkSync(join(packageRoot, 'node_modules', name), join(root, 'node_modules', name), 'junction')
        }
        const parserOptions =
          kind === 'relative-root'
            ? { project: true, tsconfigRootDir: '.' }
            : { project: './missing.json', tsconfigRootDir: root }
        write(
          root,
          'eslint.config.cjs',
          "const ts = require('typescript-eslint'); module.exports=[{files:['**/*.ts']," +
            'languageOptions:{parser:ts.parser,parserOptions:' +
            JSON.stringify(parserOptions) +
            '}}];\n'
        )
        write(root, 'tsconfig.json', '{"compilerOptions":{"strict":true,"types":[]},"include":["*.ts"]}')
        const source = write(root, 'source.ts', 'export const value: number = 42;\n')
        const result = run(distribution, 'quality', [source, '--language-checks'], root)
        expect(result.status).toBe(2)
        expect(result.output).toMatchObject({ complete: false, passed: false })
        expect(result.output.checks).toContainEqual(
          expect.objectContaining({ tool: 'eslint', status: 'unavailable', files: [] })
        )
        expect(result.output.issues?.filter((issue) => issue.rule_id === 'parse-error')).toEqual([])
      },
      20000
    )

    it('overrides Ruff target version through the public CLI only when requested', ({ skip }) => {
      if (spawnSync('ruff', ['--version']).error) return skip()
      const root = fixture()
      write(root, 'ruff.toml', 'target-version = "py311"\nlint.select = ["UP017"]\n')
      const source = write(
        root,
        'source.py',
        'from datetime import datetime, timezone\nvalue = datetime.now(timezone.utc)\n'
      )
      expect(run(distribution, 'quality', [source, '--language-checks'], root).status).toBe(1)
      for (const args of [['--target-version', 'py38'], ['--target-version=py38']]) {
        const result = run(distribution, 'quality', [source, '--language-checks', ...args], root)
        expect(result.status).toBe(0)
        expect(result.output).toMatchObject({ complete: true, passed: true })
      }
      const invalid = run(distribution, 'quality', [source, '--language-checks', '--target-version'], root)
      expect(invalid.status).toBe(2)
      expect(invalid.output.error).toContain('--target-version requires')
    })

    it.each(['quality', 'security'] as const)('groups %s baseline hints only in text output', (gate) => {
      const root = fixture()
      for (const name of ['one.js', 'nested/two.js', 'nested/three.js']) write(root, name, 'export const value = 1;\n')
      const json = run(distribution, gate, [root], root)
      expect(json.status).toBe(0)
      expect(json.output.baseline).toHaveLength(3)
      const text = spawnSync(process.execPath, [join(packageRoot, distribution, scripts[gate]), root], {
        cwd: root,
        encoding: 'utf8',
      })
      expect(text.status).toBe(json.status)
      expect(text.stdout.match(/Git repository is unavailable/g)).toHaveLength(1)
    })

    it('groups missing compilation databases by project and preserves JSON coverage', () => {
      const root = fixture()
      const sources = ['one.cpp', 'two.cpp', 'three.cpp'].map((name) => write(root, name, 'int value = 1;\n'))
      const json = run(distribution, 'quality', [...sources, '--language-checks'], root)
      expect(json.status).toBe(2)
      expect(json.output.uncovered).toHaveLength(3)
      const text = spawnSync(
        process.execPath,
        [join(packageRoot, distribution, scripts.quality), ...sources, '--language-checks'],
        {
          cwd: root,
          encoding: 'utf8',
        }
      )
      expect(text.status).toBe(2)
      expect(text.stdout.match(/No compilation database was found/g)).toHaveLength(1)
      expect(text.stdout).toContain('(3 个文件)')
    })

    it('retains real JavaScript syntax errors as completed failed analysis', () => {
      const root = lintProject()
      const source = write(root, 'source.js', 'const = ;\n')
      const result = run(distribution, 'quality', [source, '--language-checks'], root)
      expect(result.status).toBe(1)
      expect(result.output).toMatchObject({ complete: true, passed: false })
      expect(result.output.issues).toContainEqual(
        expect.objectContaining({ rule_id: 'parse-error', severity: 'error' })
      )
    })

    it('maps real compiler diagnostics without exposing source literals', () => {
      const root = lintProject()
      for (const name of ['typescript', 'typescript-eslint']) {
        symlinkSync(join(packageRoot, 'node_modules', name), join(root, 'node_modules', name), 'junction')
      }
      write(
        root,
        'eslint.config.cjs',
        'const ts = require("typescript-eslint"); module.exports=[{files:["**/*.ts"],' +
          'languageOptions:{parser:ts.parser}}];\n'
      )
      write(root, 'tsconfig.json', '{"compilerOptions":{"strict":true,"types":[]},"include":["*.ts"]}')
      const secret = 'synthetic_typecheck_credential_123456'
      const source = write(root, 'source.ts', `export const value: number = '${secret}';\n`)
      const result = run(distribution, 'quality', [source, '--language-checks'], root)
      expect(result.status).toBe(1)
      expect(result.output).toMatchObject({ complete: true, passed: false })
      expect(result.output.checks).toContainEqual(expect.objectContaining({ tool: 'typescript', status: 'failed' }))
      expect(result.output.issues).toContainEqual(
        expect.objectContaining({ rule_id: 'TS2322', origin: 'unclassified', change_scope: 'unknown' })
      )
      expect(result.stdout + result.stderr).not.toContain(secret)
    }, 20000)
  })
})
