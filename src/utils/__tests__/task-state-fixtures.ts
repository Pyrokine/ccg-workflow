import { spawn, spawnSync, execFileSync } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import fs from 'fs-extra'
import { afterEach, expect } from 'vitest'

export type JsonObject = Record<string, unknown>

interface CommandResult {
  status: number | null
  output: JsonObject
  stdout: string
  stderr: string
}

export interface StateValue {
  stateId: string | null
  revision: number
}

export interface BindingValue {
  stateId: string | null
  revision: number
  activeTaskId: string | null
}

export interface TaskValue {
  id: string
  revision: number
  status: string
  returnToTaskId: string | null
  specRefs: Array<{ path: string; section: string; purpose: string; roles?: string[] }>
}

function findPackageRoot(): string {
  let dir = import.meta.dirname
  for (let depth = 0; depth < 10; depth++) {
    try {
      readFileSync(join(dir, 'package.json'))
      return dir
    } catch {
      dir = dirname(dir)
    }
  }
  throw new Error('Could not find package root')
}

export const packageRoot = findPackageRoot()
export const hooksDir = join(packageRoot, 'templates', 'hooks')
const controllerPath = join(hooksDir, 'task-state.js')
const codexHookSource = join(packageRoot, 'templates', 'codex', 'hooks', 'ccg-workflow.py')
export const cleanupPaths = new Set<string>()
export const DEFAULT_SESSION_ID = 'claude-test-session'

export function deriveSessionKey(namespace: 'claude' | 'codex', sessionId: string): string {
  const digest = createHash('sha256').update(`${namespace}\0${sessionId}`, 'utf-8').digest('hex')
  return `${namespace}-${digest}`
}

export const DEFAULT_SESSION_KEY = deriveSessionKey('claude', DEFAULT_SESSION_ID)
export const CODEX_SESSION_ID = 'codex-test'
export const CODEX_SESSION_KEY = deriveSessionKey('codex', CODEX_SESSION_ID)

export function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

export async function createProject(): Promise<string> {
  const root = await fs.mkdtemp(join(tmpdir(), 'ccg-task-state-'))
  cleanupPaths.add(root)
  git(root, ['init', '-q'])
  git(root, ['config', 'user.name', 'CCG Test'])
  git(root, ['config', 'user.email', 'ccg-test@example.invalid'])
  git(root, ['config', 'commit.gpgsign', 'false'])
  await fs.writeJson(join(root, 'package.json'), { name: 'fixture', private: true }, { spaces: 2 })
  await fs.ensureDir(join(root, 'docs'))
  await fs.writeFile(
    join(root, 'docs', 'integration.md'),
    [
      '# Integration contract',
      '',
      '## Shared rules',
      '',
      'Only module-alpha merges.',
      '',
      '## Implementation rules',
      '',
      'module-beta is referenced by the build system and does not merge.',
      '',
      '## Review rules',
      '',
      'Reject any plan that merges module-alpha, module-beta, or module-gamma.',
      '',
    ].join('\n')
  )
  git(root, ['add', 'package.json', 'docs/integration.md'])
  git(root, ['commit', '-qm', 'test: initialize fixture'])
  return root
}

export function runScript(
  script: string,
  args: string[],
  input?: JsonObject | string,
  cwd?: string,
  envOverrides: NodeJS.ProcessEnv = {}
): CommandResult {
  const encodedInput = typeof input === 'string' ? input : input === undefined ? '' : JSON.stringify(input)
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd,
    input: encodedInput,
    encoding: 'utf-8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: '', CLAUDE_ENV_FILE: '', ...envOverrides },
  })
  const stdout = result.stdout || ''
  const output = stdout.trim() ? (JSON.parse(stdout) as JsonObject) : {}
  return { status: result.status, output, stdout, stderr: result.stderr || '' }
}

export function runController(
  root: string,
  operation: string,
  request?: JsonObject,
  options: string[] = [],
  sessionKey = DEFAULT_SESSION_KEY
): CommandResult {
  return runScript(controllerPath, [operation, '--root', root, '--session-key', sessionKey, ...options], request, root)
}

export function runHook(
  root: string,
  hookName: string,
  input: JsonObject,
  envOverrides: NodeJS.ProcessEnv = {}
): CommandResult {
  const hookInput = Object.prototype.hasOwnProperty.call(input, 'session_id')
    ? input
    : { ...input, session_id: DEFAULT_SESSION_ID }
  return runScript(join(hooksDir, hookName), [], hookInput, root, envOverrides)
}

export function expectSuccess(result: CommandResult): JsonObject {
  expect(result.stderr).toBe('')
  expect(result.status).toBe(0)
  expect(result.output.ok).not.toBe(false)
  return result.output
}

export function expectFailure(result: CommandResult, code: string): JsonObject {
  expect(result.status).not.toBe(0)
  expect(result.output).toMatchObject({ ok: false, code })
  return result.output
}

export function resolve(root: string, sessionKey = DEFAULT_SESSION_KEY): JsonObject {
  return expectSuccess(runController(root, 'resolve', undefined, [], sessionKey))
}

export function currentExpected(root: string, includeTask = false, sessionKey = DEFAULT_SESSION_KEY): JsonObject {
  const current = resolve(root, sessionKey)
  const expected: JsonObject = {
    stateId: current.stateId,
    stateRevision: current.stateRevision,
    bindingRevision: current.bindingRevision,
    activeTaskId: current.activeTaskId,
  }
  if (includeTask) expected.taskRevision = current.taskRevision
  return expected
}

export function taskInput(id: string, overrides: JsonObject = {}): JsonObject {
  return {
    id,
    title: `Task ${id}`,
    strategy: 'guided-develop',
    complexity: 'M',
    risk: 'medium',
    domain: 'test',
    scope: `Scope for ${id}`,
    currentPhase: '1-requirements',
    nextAction: `Continue ${id}`,
    gate: null,
    specEvolution: 'not_applicable',
    ...overrides,
  }
}

export function startTask(
  root: string,
  id: string,
  mode = 'activate',
  overrides: JsonObject = {},
  sessionKey = DEFAULT_SESSION_KEY
): JsonObject {
  return expectSuccess(
    runController(
      root,
      'start',
      {
        expected: currentExpected(root, false, sessionKey),
        mode,
        task: taskInput(id, overrides),
        requirements:
          `# Requirements\n\n## Objective\n\nComplete ${id}.\n\n` +
          '## Constraints\n\nFollow the linked specification.\n',
      },
      [],
      sessionKey
    )
  )
}

export function finishActive(root: string, status = 'completed', sessionKey = DEFAULT_SESSION_KEY): JsonObject {
  return expectSuccess(
    runController(
      root,
      'finish',
      {
        expected: currentExpected(root, true, sessionKey),
        status,
        progress: `# Progress\n\n${status}\n`,
      },
      [],
      sessionKey
    )
  )
}

export function hookOutput(result: CommandResult): JsonObject {
  expect(result.status).toBe(0)
  expect(result.stderr).toBe('')
  return result.output.hookSpecificOutput as JsonObject
}

export async function installCodexHookRuntime(): Promise<string> {
  const runtimeDir = await fs.mkdtemp(join(tmpdir(), 'ccg-codex-hook-'))
  cleanupPaths.add(runtimeDir)
  const hookPath = join(runtimeDir, 'ccg-workflow.py')
  const runtimeHooksDir = join(runtimeDir, 'ccg')
  await fs.ensureDir(runtimeHooksDir)
  await fs.copyFile(codexHookSource, hookPath)
  for (const file of ['package.json', 'task-utils.js', 'task-state.js']) {
    await fs.copyFile(join(hooksDir, file), join(runtimeHooksDir, file))
  }
  return hookPath
}

export function runCodexHook(root: string, hookPath: string, agentType = ''): CommandResult {
  const result = spawnSync('python3', [hookPath], {
    cwd: root,
    input: JSON.stringify({
      cwd: root,
      session_id: CODEX_SESSION_ID,
      agent_id: agentType ? 'leaf-agent-id' : null,
      agent_type: agentType || null,
    }),
    encoding: 'utf-8',
    env: {
      ...process.env,
      CODEX_AGENT_TYPE: '',
      CODEX_FORK_TURNS: '',
      CODEX_PROJECT_DIR: '',
    },
  })
  const stdout = result.stdout || ''
  const output = stdout.trim() ? (JSON.parse(stdout) as JsonObject) : {}
  return { status: result.status, output, stdout, stderr: result.stderr || '' }
}

function collectControllerResult(child: ChildProcessWithoutNullStreams): Promise<CommandResult> {
  return new Promise((resolveChild, reject) => {
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf-8')
    child.stderr.setEncoding('utf-8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', (status) => {
      try {
        resolveChild({
          status,
          output: stdout.trim() ? (JSON.parse(stdout) as JsonObject) : {},
          stdout,
          stderr,
        })
      } catch (error) {
        reject(error)
      }
    })
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE') reject(error)
    })
  })
}

function sendControllerRequest(child: ChildProcessWithoutNullStreams, request: JsonObject, delayed: boolean): void {
  const encoded = JSON.stringify(request)
  if (delayed) {
    const first = setTimeout(() => child.stdin.write(encoded.slice(0, 32)), 40)
    const last = setTimeout(() => child.stdin.end(encoded.slice(32)), 100)
    child.on('close', () => {
      clearTimeout(first)
      clearTimeout(last)
    })
  } else {
    child.stdin.end(encoded)
  }
}

export function asyncController(
  root: string,
  operation: string,
  request: JsonObject,
  delayed = false
): Promise<CommandResult> {
  const args = [controllerPath, operation, '--root', root, '--session-key', DEFAULT_SESSION_KEY]
  const script =
    'process.stdin._handle.setBlocking(false); ' +
    `process.argv = [process.execPath, ...${JSON.stringify(args)}]; ` +
    "require('node:module').runMain();"
  const child = spawn(process.execPath, delayed ? ['-e', script] : args, {
    cwd: root,
    env: { ...process.env, CLAUDE_PROJECT_DIR: '' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const result = collectControllerResult(child)
  sendControllerRequest(child, request, delayed)
  return result
}

export function linkSpec(root: string, specRef: JsonObject): JsonObject {
  return expectSuccess(runController(root, 'link-spec', { expected: currentExpected(root, true), specRef }))
}

export function writeArtifact(root: string, artifact: JsonObject): JsonObject {
  return expectSuccess(runController(root, 'write-artifact', { expected: currentExpected(root, true), ...artifact }))
}

afterEach(async () => {
  await Promise.all([...cleanupPaths].map((path) => fs.remove(path)))
  cleanupPaths.clear()
})

export function updateRequirements(root: string, content: string): JsonObject {
  return expectSuccess(runController(root, 'update-requirements', { expected: currentExpected(root, true), content }))
}
