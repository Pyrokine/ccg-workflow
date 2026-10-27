import { mkdtempSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, vi } from 'vitest'

export const loadModule = createRequire(import.meta.url)
export const root = resolve(import.meta.dirname, '../../..')
export const distributions = ['templates/skills/tools', 'dsh-ccg/skills']
export const limits = { maxComplexity: 2, maxFunctionLength: 3, maxParameters: 2 }
interface Check {
  tool: string
  status: 'passed' | 'failed' | 'unavailable'
  files: string[]
  requested_files?: string[]
  skipped_files?: string[]
  project_root?: string
  diagnostics?: number
  reason?: string
}
interface Issue {
  severity: string
  message: string
  file_path: string
  line_number: number
  rule_id: string
  line_content: string
}
interface Result {
  checks: Check[]
  issues: Issue[]
  uncovered: Array<{ path: string; reason: string }>
}
export type Analyze = (files: string[], thresholds: typeof limits) => Result
const cleanup = new Set<string>()

export function fixture(): string {
  const directory = mkdtempSync(join(tmpdir(), 'ccg-language checks-'))
  cleanup.add(directory)
  return directory
}

export function write(directory: string, file: string, content: string, executable = false): string {
  const target = join(directory, file)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content, executable ? { mode: 0o755 } : undefined)
  return target
}

export function dependency(directory: string, name: string): void {
  const target = join(directory, 'node_modules', name)
  mkdirSync(dirname(target), { recursive: true })
  symlinkSync(join(root, 'node_modules', name), target)
}

export function fakeEslint(directory: string, body = ''): void {
  write(directory, 'package.json', '{}')
  write(directory, 'eslint.config.cjs', 'module.exports = [{}];')
  write(directory, 'node_modules/eslint/package.json', '{"main":"index.cjs"}')
  write(
    directory,
    'node_modules/eslint/index.cjs',
    `
    const fs = require('node:fs');
    class ESLint {
      constructor(options) { ${body} }
      async isPathIgnored(file) { return file.includes('ignored'); }
      async calculateConfigForFile() { return {}; }
      async lintFiles(files) { return files.map(filePath => ({ filePath, messages: [] })); }
    }
    module.exports = { ESLint };
  `
  )
}

export function fakeExecutable(directory: string, name: string, script: string): string {
  const bin = join(directory, 'bin')
  write(bin, name, `#!${process.execPath}\n${script}\n`, true)
  vi.stubEnv('PATH', bin)
  return bin
}

export function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      if (entry.isSymbolicLink()) return [entry.name]
      if (entry.isDirectory()) return files(join(directory, entry.name)).map((file) => `${entry.name}/${file}`)
      return [entry.name]
    })
    .sort()
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  for (const directory of cleanup) rmSync(directory, { recursive: true, force: true })
  cleanup.clear()
})
