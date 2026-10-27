import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, expect } from 'vitest'

export const packageRoot = resolve(import.meta.dirname, '../../..')
export const distributions = ['templates/skills/tools', 'dsh-ccg/skills']
export const scripts = {
  quality: 'verify-quality/scripts/quality_checker.js',
  security: 'verify-security/scripts/security_scanner.js',
  change: 'verify-change/scripts/change_analyzer.js',
  module: 'verify-module/scripts/module_scanner.js',
}
export type Gate = keyof typeof scripts
interface Change {
  path: string
  old_path?: string
  type: string
  additions: number
  deletions: number
}
export interface Report {
  passed: boolean
  complete: boolean
  error?: string
  files_scanned?: number
  total_additions?: number
  total_deletions?: number
  repository_root?: string
  scan_errors?: Array<{ path: string; code: string }>
  changes?: Change[]
  findings?: Array<{ severity: string; line_content: string; line_number: number; rule_id?: string; origin?: string }>
  issues?: Array<{ severity: string; message: string; rule_id?: string; origin?: string }>
  affected_modules?: string[]
  doc_sync?: Record<string, { exists: boolean; updated: boolean }>
  baseline?: Array<{ status: string; ref: string; repository_root?: string }>
  origin_counts?: Record<string, number>
  checks?: Array<{ tool: string; status: string; files: string[]; diagnostics?: number; reason?: string }>
  analysis_mode?: string
  uncovered?: Array<{ path: string; reason: string }>
  results?: Report[]
  repositories?: Report[]
}
const cleanup = new Set<string>()

export function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'ccg-quality-gates-'))
  cleanup.add(root)
  return root
}

export function write(root: string, name: string, content = 'export const value = 1\n'): string {
  const file = join(root, name)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content)
  return file
}

export function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

export function repository(): string {
  const root = fixture()
  git(root, 'init', '-q')
  git(root, 'config', 'user.name', 'CCG Test')
  git(root, 'config', 'user.email', 'test@example.invalid')
  git(root, 'config', 'commit.gpgsign', 'false')
  git(root, 'config', 'core.hooksPath', join(root, 'empty-hooks'))
  write(root, 'src/clean.ts')
  write(root, 'other/clean.ts')
  git(root, 'add', '.')
  git(root, 'commit', '-qm', 'test: initialize fixture')
  return root
}

export function run(
  distribution: string,
  gate: Gate,
  args: string[],
  cwd: string,
  preload?: string
): { status: number | null; output: Report; stdout: string; stderr: string } {
  const result = spawnSync(
    process.execPath,
    [...(preload ? ['--require', preload] : []), join(packageRoot, distribution, scripts[gate]), '--json', ...args],
    { cwd, encoding: 'utf8' }
  )
  expect(result.error).toBeUndefined()
  expect(result.signal).toBeNull()
  return {
    status: result.status,
    output: JSON.parse(result.stdout) as Report,
    stdout: result.stdout,
    stderr: result.stderr,
  }
}

export function deny(root: string, method: string, target: string): string {
  return write(
    root,
    'deny.cjs',
    `const fs = require('node:fs');
const original = fs[${JSON.stringify(method)}];
fs[${JSON.stringify(method)}] = function (target, ...args) {
  if (String(target) === ${JSON.stringify(target)}) {
    throw Object.assign(new Error('Injected read denial'), { code: 'EACCES' });
  }
  return original.call(this, target, ...args);
};\n`
  )
}

export function lintProject(): string {
  const root = fixture()
  write(root, 'package.json', '{"type":"module"}\n')
  write(root, 'eslint.config.cjs', 'module.exports = [{rules:{"no-debugger":"error"}}];\n')
  mkdirSync(join(root, 'node_modules'))
  symlinkSync(join(packageRoot, 'node_modules', 'eslint'), join(root, 'node_modules', 'eslint'), 'junction')
  return root
}

export function completeModule(root: string, name: string): string {
  const target = join(root, name)
  write(target, 'README.md', '# Module\n\nUsage: import the source module and call its public functions.\n')
  write(target, 'DESIGN.md', '# Design\n\nDecision: keep this module independent and use a small public interface.\n')
  write(target, 'src/index.ts')
  write(target, 'tests/index.test.ts')
  return target
}

afterEach(() => {
  for (const root of cleanup) rmSync(root, { recursive: true, force: true })
  cleanup.clear()
})
