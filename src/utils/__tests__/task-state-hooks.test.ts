import { spawn, spawnSync } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import fs from 'fs-extra'
import { afterEach, describe, expect, it } from 'vitest'

type JsonObject = Record<string, unknown>

interface CommandResult {
  status: number | null
  output: JsonObject
  stdout: string
  stderr: string
}

interface StateValue {
  stateId: string | null
  revision: number
  activeTaskId: string | null
}

interface TaskValue {
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

const packageRoot = findPackageRoot()
const hooksDir = join(packageRoot, 'templates', 'hooks')
const controllerPath = join(hooksDir, 'task-state.js')
const codexHookSource = join(packageRoot, 'templates', 'codex', 'hooks', 'ccg-workflow.py')
const cleanupPaths = new Set<string>()

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

async function createProject(): Promise<string> {
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
      'module-beta is referenced by Planning build system and does not merge.',
      '',
      '## Review rules',
      '',
      'Reject any plan that merges Planning, module-beta, or module-gamma.',
      '',
    ].join('\n')
  )
  git(root, ['add', 'package.json', 'docs/integration.md'])
  git(root, ['commit', '-qm', 'test: initialize fixture'])
  return root
}

function runScript(
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
    env: { ...process.env, CLAUDE_PROJECT_DIR: '', ...envOverrides },
  })
  const stdout = result.stdout || ''
  const output = stdout.trim() ? (JSON.parse(stdout) as JsonObject) : {}
  return { status: result.status, output, stdout, stderr: result.stderr || '' }
}

function runController(root: string, operation: string, request?: JsonObject, options: string[] = []): CommandResult {
  return runScript(controllerPath, [operation, '--root', root, ...options], request, root)
}

function runHook(
  root: string,
  hookName: string,
  input: JsonObject,
  envOverrides: NodeJS.ProcessEnv = {}
): CommandResult {
  return runScript(join(hooksDir, hookName), [], input, root, envOverrides)
}

function expectSuccess(result: CommandResult): JsonObject {
  expect(result.stderr).toBe('')
  expect(result.status).toBe(0)
  expect(result.output.ok).not.toBe(false)
  return result.output
}

function expectFailure(result: CommandResult, code: string): JsonObject {
  expect(result.status).not.toBe(0)
  expect(result.output).toMatchObject({ ok: false, code })
  return result.output
}

function resolve(root: string): JsonObject {
  return expectSuccess(runController(root, 'resolve'))
}

function currentExpected(root: string, includeTask = false): JsonObject {
  const current = resolve(root)
  const expected: JsonObject = {
    stateId: current.stateId,
    stateRevision: current.stateRevision,
    activeTaskId: current.activeTaskId,
  }
  if (includeTask) expected.taskRevision = current.taskRevision
  return expected
}

function taskInput(id: string, overrides: JsonObject = {}): JsonObject {
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

function startTask(root: string, id: string, mode = 'activate', overrides: JsonObject = {}): JsonObject {
  return expectSuccess(
    runController(root, 'start', {
      expected: currentExpected(root),
      mode,
      task: taskInput(id, overrides),
      requirements: `# Requirements\n\n## Objective\n\nComplete ${id}.\n\n## Constraints\n\nFollow the linked specification.\n`,
    })
  )
}

function finishActive(root: string, status = 'completed'): JsonObject {
  return expectSuccess(
    runController(root, 'finish', {
      expected: currentExpected(root, true),
      status,
      progress: `# Progress\n\n${status}\n`,
    })
  )
}

function hookOutput(result: CommandResult): JsonObject {
  expect(result.status).toBe(0)
  expect(result.stderr).toBe('')
  return result.output.hookSpecificOutput as JsonObject
}

async function installCodexHookRuntime(): Promise<string> {
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

function runCodexHook(root: string, hookPath: string, agentType = ''): CommandResult {
  const result = spawnSync('python3', [hookPath], {
    cwd: root,
    input: JSON.stringify({ cwd: root, session_id: 'codex-test' }),
    encoding: 'utf-8',
    env: {
      ...process.env,
      CODEX_AGENT_TYPE: agentType,
      CODEX_FORK_TURNS: '',
      CODEX_PROJECT_DIR: '',
    },
  })
  const stdout = result.stdout || ''
  const output = stdout.trim() ? (JSON.parse(stdout) as JsonObject) : {}
  return { status: result.status, output, stdout, stderr: result.stderr || '' }
}

function asyncController(root: string, operation: string, request: JsonObject): Promise<CommandResult> {
  return new Promise((resolveChild, reject) => {
    const child = spawn(process.execPath, [controllerPath, operation, '--root', root], {
      cwd: root,
      env: { ...process.env, CLAUDE_PROJECT_DIR: '' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
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
    child.stdin.end(JSON.stringify(request))
  })
}

afterEach(async () => {
  await Promise.all([...cleanupPaths].map((path) => fs.remove(path)))
  cleanupPaths.clear()
})

describe('persistent task state controller', () => {
  it('requires explicit selection when open tasks remain without an active pointer', async () => {
    const root = await createProject()
    startTask(root, 'zeta-task')
    startTask(root, 'alpha-task', 'inactive')
    finishActive(root)

    const current = resolve(root)
    expect(current).toMatchObject({
      kind: 'selection-required',
      code: 'SELECTION_REQUIRED',
      activeTaskId: null,
    })
    expect(current.candidates).toEqual([{ id: 'alpha-task', title: 'Task alpha-task', revision: 1 }])
    expect(await fs.pathExists(join(root, '.ccg', 'tasks', 'zeta-task', 'task.json'))).toBe(true)

    const activated = expectSuccess(
      runController(root, 'activate', {
        expected: { ...currentExpected(root), taskRevision: 1 },
        taskId: 'alpha-task',
      })
    )
    expect((activated.state as StateValue).activeTaskId).toBe('alpha-task')
  })

  it('returns through nested interrupted tasks without moving task directories', async () => {
    const root = await createProject()
    startTask(root, 'parent-task')
    startTask(root, 'child-task', 'interrupt')
    startTask(root, 'grandchild-task', 'interrupt')

    expect((finishActive(root).state as StateValue).activeTaskId).toBe('child-task')
    expect((finishActive(root).state as StateValue).activeTaskId).toBe('parent-task')
    expect((finishActive(root).state as StateValue).activeTaskId).toBeNull()

    for (const id of ['parent-task', 'child-task', 'grandchild-task']) {
      const task = await fs.readJson(join(root, '.ccg', 'tasks', id, 'task.json'))
      expect(task.status).toBe('completed')
      expect(await fs.pathExists(join(root, '.ccg', 'tasks', id))).toBe(true)
    }
  })

  it('recovers an active pointer left on a terminal interrupted task', async () => {
    const root = await createProject()
    startTask(root, 'parent-task')
    startTask(root, 'child-task', 'interrupt')

    const taskPath = join(root, '.ccg', 'tasks', 'child-task', 'task.json')
    const child = (await fs.readJson(taskPath)) as TaskValue & JsonObject
    child.status = 'completed'
    child.finishedAt = new Date().toISOString()
    child.revision += 1
    await fs.writeJson(taskPath, child, { spaces: 2 })

    const current = resolve(root)
    expect(current).toMatchObject({
      kind: 'recovery-required',
      code: 'RECOVERY_REQUIRED',
      activeTaskId: 'child-task',
      taskRevision: 2,
    })

    const recovered = expectSuccess(
      runController(root, 'recover', {
        expected: {
          stateId: current.stateId,
          stateRevision: current.stateRevision,
          activeTaskId: current.activeTaskId,
          taskRevision: current.taskRevision,
        },
      })
    )
    expect((recovered.state as StateValue).activeTaskId).toBe('parent-task')
  })

  it('recovers a missing active target using state CAS only', async () => {
    const root = await createProject()
    startTask(root, 'missing-active-task')
    await fs.remove(join(root, '.ccg', 'tasks', 'missing-active-task'))

    const current = resolve(root)
    expect(current).toMatchObject({
      kind: 'recovery-required',
      reasonCode: 'ACTIVE_TASK_MISSING',
      activeTaskId: 'missing-active-task',
      taskRevision: null,
    })

    const recovered = expectSuccess(
      runController(root, 'recover', {
        expected: {
          stateId: current.stateId,
          stateRevision: current.stateRevision,
          activeTaskId: current.activeTaskId,
        },
      })
    )
    expect(recovered).toMatchObject({ task: null, recoveredReason: 'ACTIVE_TASK_MISSING' })
    expect((recovered.state as StateValue).activeTaskId).toBeNull()
    expect(resolve(root)).toMatchObject({ kind: 'none', activeTaskId: null })
  })

  it('reports corrupted state instead of selecting another task', async () => {
    const root = await createProject()
    startTask(root, 'active-task')
    await fs.writeFile(join(root, '.ccg', 'state.json'), '{broken', 'utf-8')

    expect(resolve(root)).toMatchObject({ kind: 'invalid', code: 'STATE_INVALID' })
    const session = hookOutput(runHook(root, 'session-start.js', { cwd: root, source: 'compact' }))
    expect(session.additionalContext).toContain('STATE_INVALID')
    expect(session.additionalContext).not.toContain('Complete active-task')
  })

  it('allows only one concurrent checkpoint for the same expected revision', async () => {
    const root = await createProject()
    startTask(root, 'concurrent-task')
    const expected = currentExpected(root, true)
    const request = (suffix: string): JsonObject => ({
      expected,
      currentPhase: `2-${suffix}`,
      nextAction: `Continue ${suffix}`,
      gate: null,
      progress: `# Progress\n\n${suffix}\n`,
    })

    const results = await Promise.all([
      asyncController(root, 'checkpoint', request('first')),
      asyncController(root, 'checkpoint', request('second')),
    ])
    expect(results.filter((result) => result.output.ok === true)).toHaveLength(1)
    expect(results.filter((result) => result.output.code === 'REVISION_CONFLICT')).toHaveLength(1)
    expect(resolve(root).taskRevision as number).toBe(2)
  })

  it('rejects stale mutations after state identity is recreated', async () => {
    const root = await createProject()
    startTask(root, 'first-task')
    const stale = currentExpected(root, true)

    await fs.remove(join(root, '.ccg'))
    startTask(root, 'replacement-task')

    expectFailure(
      runController(root, 'checkpoint', {
        expected: stale,
        currentPhase: 'stale',
        nextAction: 'Must fail',
        gate: null,
      }),
      'STATE_ID_CONFLICT'
    )
  })

  it('does not remove a stale-looking lock owned by a live process', async () => {
    const root = await createProject()
    startTask(root, 'locked-task')
    const lockPath = join(root, '.ccg', 'state.lock')
    const nonce = randomUUID()
    await fs.writeJson(lockPath, { pid: process.pid, nonce, createdAt: new Date(0).toISOString() })
    const oldTime = new Date(Date.now() - 31_000)
    await fs.utimes(lockPath, oldTime, oldTime)

    const hook = hookOutput(
      runHook(root, 'subagent-context.js', {
        cwd: root,
        tool_name: 'Agent',
        tool_input: { name: 'implementer', prompt: 'Implement assigned files' },
      })
    )
    expect(hook.permissionDecision).toBe('deny')
    expect(hook.permissionDecisionReason).toContain('STATE_LOCKED')

    expectFailure(
      runController(root, 'checkpoint', {
        expected: currentExpected(root, true),
        currentPhase: 'locked',
        nextAction: 'Wait',
        gate: null,
      }),
      'LOCK_TIMEOUT'
    )
    expect((await fs.readJson(lockPath)).nonce).toBe(nonce)
  })

  it('migrates legacy tasks only after an explicit active-task choice', async () => {
    const root = await createProject()
    const legacyDir = join(root, '.ccg', 'tasks', 'legacy-task')
    await fs.ensureDir(legacyDir)
    await fs.writeJson(join(legacyDir, 'task.json'), {
      id: 'legacy-task',
      title: 'Legacy task',
      status: 'active',
      strategy: 'guided-develop',
      complexity: 'M',
      risk: 'medium',
      domain: 'test',
      scope: 'Legacy scope',
      currentPhase: 'research',
      nextAction: 'Continue migration',
    })
    await fs.writeFile(
      join(legacyDir, 'context.jsonl'),
      [
        JSON.stringify({
          file: 'docs/integration.md',
          section: 'Shared rules',
          purpose: 'Integration authority',
          roles: ['implement'],
        }),
        JSON.stringify({
          file: '.ccg/spec/backend/index.md',
          section: 'API',
          purpose: 'Obsolete implicit spec',
        }),
        '',
      ].join('\n')
    )

    expect(resolve(root)).toMatchObject({ kind: 'migration-required', code: 'TASK_MIGRATION_REQUIRED' })
    expectFailure(
      runController(root, 'migrate-legacy', {
        expected: { stateId: null, stateRevision: 0, activeTaskId: null },
      }),
      'INVALID_REQUEST'
    )

    const migrated = expectSuccess(
      runController(root, 'migrate-legacy', {
        expected: { stateId: null, stateRevision: 0, activeTaskId: null },
        activeTaskId: 'legacy-task',
      })
    )
    expect((migrated.state as StateValue).activeTaskId).toBe('legacy-task')
    const task = (await fs.readJson(join(legacyDir, 'task.json'))) as TaskValue
    expect(task).toMatchObject({ schemaVersion: 1, revision: 1, status: 'open' })
    expect(task.specRefs).toEqual([
      {
        path: 'docs/integration.md',
        section: 'Shared rules',
        purpose: 'Integration authority',
        roles: ['implement'],
      },
    ])
    expect(await fs.pathExists(join(legacyDir, 'requirements.md'))).toBe(true)
    expect(await fs.pathExists(join(root, '.ccg', 'migrations', 'v1', 'legacy-task', 'task.json'))).toBe(true)
    expect(await fs.pathExists(join(root, '.ccg', 'migrations', 'v1', 'legacy-task', 'context.jsonl'))).toBe(true)
  })

  it('keeps runtime state local to a linked Git worktree', async () => {
    const root = await createProject()
    const linked = `${root}-linked`
    cleanupPaths.add(linked)
    git(root, ['worktree', 'add', '-q', '-b', 'linked-test', linked])
    expect(lstatSync(join(linked, '.git')).isFile()).toBe(true)

    startTask(linked, 'linked-task')
    expect(await fs.pathExists(join(linked, '.ccg', 'state.json'))).toBe(true)
    expect(await fs.pathExists(join(root, '.ccg', 'state.json'))).toBe(false)
    expect(git(linked, ['status', '--porcelain', '--', '.ccg'])).toBe('')

    const nested = join(linked, 'src', 'nested')
    await fs.ensureDir(nested)
    const session = hookOutput(runHook(nested, 'session-start.js', { cwd: nested, source: 'resume' }))
    expect(session.additionalContext).toContain(`Root: ${linked}`)
    expect(session.additionalContext).toContain('linked-task')
  })

  it('rejects a symlinked .ccg runtime root before reading or writing external files', async () => {
    const root = await createProject()
    const outside = `${root}-outside`
    cleanupPaths.add(outside)
    await fs.ensureDir(outside)
    await fs.symlink(outside, join(root, '.ccg'))

    expect(resolve(root)).toMatchObject({ kind: 'invalid', code: 'STATE_PATH_INVALID' })
    expectFailure(
      runController(root, 'start', {
        expected: { stateId: null, stateRevision: 0, activeTaskId: null },
        mode: 'activate',
        task: taskInput('external-runtime-task'),
        requirements: '# Requirements\n',
      }),
      'PATH_INVALID'
    )
    expect(await fs.readdir(outside)).toEqual([])
  })

  it.each(['tasks', 'tmp'])('rejects a symlinked .ccg/%s runtime directory', async (directory) => {
    const root = await createProject()
    const outside = `${root}-${directory}-outside`
    cleanupPaths.add(outside)
    await fs.ensureDir(join(root, '.ccg'))
    await fs.ensureDir(outside)
    await fs.symlink(outside, join(root, '.ccg', directory))

    expectFailure(
      runController(root, 'start', {
        expected: { stateId: null, stateRevision: 0, activeTaskId: null },
        mode: 'activate',
        task: taskInput(`${directory}-symlink-task`),
        requirements: '# Requirements\n',
      }),
      'PATH_INVALID'
    )
    expect(await fs.readdir(outside)).toEqual([])
  })

  it('rejects symlinked migration and turn-state directories', async () => {
    const root = await createProject()
    const turnOutside = `${root}-turns-outside`
    cleanupPaths.add(turnOutside)
    await fs.ensureDir(turnOutside)
    startTask(root, 'turn-symlink-task')
    await fs.symlink(turnOutside, join(root, '.ccg', 'tasks', 'turn-symlink-task', '.turns'))
    expectFailure(
      runController(root, 'record-turn', {
        expected: currentExpected(root, true),
        sessionId: 'turn-session',
      }),
      'PATH_INVALID'
    )
    expect(await fs.readdir(turnOutside)).toEqual([])

    const migrationRoot = await createProject()
    const migrationOutside = `${migrationRoot}-migration-outside`
    cleanupPaths.add(migrationOutside)
    const legacyDir = join(migrationRoot, '.ccg', 'tasks', 'legacy-symlink-task')
    await fs.ensureDir(legacyDir)
    await fs.writeJson(join(legacyDir, 'task.json'), {
      id: 'legacy-symlink-task',
      title: 'Legacy symlink task',
      status: 'active',
    })
    await fs.ensureDir(migrationOutside)
    await fs.symlink(migrationOutside, join(migrationRoot, '.ccg', 'migrations'))
    expectFailure(
      runController(migrationRoot, 'migrate-legacy', {
        expected: { stateId: null, stateRevision: 0, activeTaskId: null },
        activeTaskId: 'legacy-symlink-task',
      }),
      'PATH_INVALID'
    )
    expect(await fs.readdir(migrationOutside)).toEqual([])
  })

  it('recovers an interrupted multi-file task transaction before allowing more mutations', async () => {
    const root = await createProject()
    startTask(root, 'transaction-task')
    const taskPath = join(root, '.ccg', 'tasks', 'transaction-task', 'task.json')
    const progressPath = join(root, '.ccg', 'tasks', 'transaction-task', 'progress.md')
    const task = (await fs.readJson(taskPath)) as TaskValue & JsonObject
    const nextTask = {
      ...task,
      revision: task.revision + 1,
      currentPhase: '2-implementation',
      nextAction: 'Resume after transaction recovery',
      updatedAt: new Date().toISOString(),
    }
    const progress = '# Progress\n\nTRANSACTION_PROGRESS_SENTINEL\n'
    await fs.writeFile(progressPath, progress)
    await fs.writeJson(join(root, '.ccg', 'transaction.json'), {
      schemaVersion: 1,
      transactionId: randomUUID(),
      operation: 'checkpoint',
      taskId: 'transaction-task',
      createdAt: new Date().toISOString(),
      writes: [
        { path: '.ccg/tasks/transaction-task/progress.md', content: progress },
        { path: '.ccg/tasks/transaction-task/task.json', content: `${JSON.stringify(nextTask, null, 2)}\n` },
      ],
    })

    const current = resolve(root)
    expect(current).toMatchObject({ kind: 'recovery-required', reasonCode: 'INCOMPLETE_TRANSACTION' })
    const hook = hookOutput(
      runHook(root, 'subagent-context.js', {
        cwd: root,
        tool_name: 'Agent',
        tool_input: { name: 'implementer', prompt: 'Must wait for recovery' },
      })
    )
    expect(hook.permissionDecision).toBe('deny')
    expect(hook.permissionDecisionReason).toContain('INCOMPLETE_TRANSACTION')
    expectFailure(runController(root, 'list'), 'RECOVERY_REQUIRED')
    expectFailure(
      runController(root, 'checkpoint', {
        expected: {
          stateId: current.stateId,
          stateRevision: current.stateRevision,
          activeTaskId: current.activeTaskId,
          taskRevision: task.revision,
        },
        currentPhase: 'must-not-run',
        nextAction: 'Must not run',
        gate: null,
      }),
      'RECOVERY_REQUIRED'
    )

    const recovered = expectSuccess(
      runController(root, 'recover', {
        expected: {
          stateId: current.stateId,
          stateRevision: current.stateRevision,
          activeTaskId: current.activeTaskId,
        },
      })
    )
    expect(recovered).toMatchObject({ recoveredReason: 'INCOMPLETE_TRANSACTION' })
    expect((recovered.task as TaskValue).revision).toBe(2)
    expect(await fs.readFile(progressPath, 'utf-8')).toContain('TRANSACTION_PROGRESS_SENTINEL')
    expect(await fs.pathExists(join(root, '.ccg', 'transaction.json'))).toBe(false)
    expect(resolve(root)).toMatchObject({ kind: 'active', taskRevision: 2 })
  })

  it('preserves an oversized Git exclude file instead of replacing it with truncated content', async () => {
    const root = await createProject()
    const excludePath = join(root, '.git', 'info', 'exclude')
    const original = `# LARGE_EXCLUDE_SENTINEL\n${'/generated-*\n'.repeat(24_000)}`
    await fs.writeFile(excludePath, original)

    expectFailure(
      runController(root, 'start', {
        expected: { stateId: null, stateRevision: 0, activeTaskId: null },
        mode: 'activate',
        task: taskInput('exclude-preservation-task'),
        requirements: '# Requirements\n',
      }),
      'GIT_EXCLUDE_TOO_LARGE'
    )
    expect(await fs.readFile(excludePath, 'utf-8')).toBe(original)
    expect(await fs.pathExists(join(root, '.ccg', 'state.json'))).toBe(false)
  })
})

describe('spec references and snapshots', () => {
  it('injects only public and role-matched exact spec sections', async () => {
    const root = await createProject()
    startTask(root, 'spec-task')

    const refs = [
      {
        path: 'docs/integration.md',
        section: 'Shared rules',
        purpose: 'Shared authority',
      },
      {
        path: 'docs/integration.md',
        section: 'Implementation rules',
        purpose: 'Implementation authority',
        roles: ['implement'],
      },
      {
        path: 'docs/integration.md',
        section: 'Review rules',
        purpose: 'Review authority',
        roles: ['review'],
      },
    ]
    for (const specRef of refs) {
      expectSuccess(
        runController(root, 'link-spec', {
          expected: currentExpected(root, true),
          specRef,
        })
      )
    }

    const implement = expectSuccess(
      runController(root, 'snapshot', undefined, ['--mode', 'agent', '--role', 'implement'])
    )
    const review = expectSuccess(runController(root, 'snapshot', undefined, ['--mode', 'agent', '--role', 'review']))
    const unknown = expectSuccess(runController(root, 'snapshot', undefined, ['--mode', 'agent', '--role', 'unknown']))

    expect((implement.specs as JsonObject[]).map((item) => (item.ref as JsonObject).section)).toEqual([
      'Implementation rules',
      'Shared rules',
    ])
    expect((review.specs as JsonObject[]).map((item) => (item.ref as JsonObject).section)).toEqual([
      'Review rules',
      'Shared rules',
    ])
    expect((unknown.specs as JsonObject[]).map((item) => (item.ref as JsonObject).section)).toEqual(['Shared rules'])
  })

  it('accepts a staged Markdown spec with an exact heading', async () => {
    const root = await createProject()
    startTask(root, 'staged-spec-task')
    await fs.writeFile(join(root, 'docs', 'staged.md'), '# Staged spec\n\n## Exact heading\n\nStaged authority.\n')
    git(root, ['add', 'docs/staged.md'])

    const linked = expectSuccess(
      runController(root, 'link-spec', {
        expected: currentExpected(root, true),
        specRef: {
          path: 'docs/staged.md',
          section: 'Exact heading',
          purpose: 'Staged specification',
          roles: ['research'],
        },
      })
    )
    expect(linked.linked).toBe(true)
  })

  it('rejects duplicated exact headings', async () => {
    const root = await createProject()
    startTask(root, 'duplicate-heading-task')
    await fs.writeFile(join(root, 'docs', 'duplicate.md'), '# Duplicate\n\n## Rules\n\nFirst.\n\n## Rules\n\nSecond.\n')
    git(root, ['add', 'docs/duplicate.md'])

    expectFailure(
      runController(root, 'link-spec', {
        expected: currentExpected(root, true),
        specRef: { path: 'docs/duplicate.md', section: 'Rules', purpose: 'Ambiguous rules' },
      }),
      'SPEC_SECTION_AMBIGUOUS'
    )
  })

  it('ignores heading examples inside fenced Markdown code blocks', async () => {
    const root = await createProject()
    startTask(root, 'fenced-heading-task')
    await fs.writeFile(
      join(root, 'docs', 'fenced.md'),
      '# Fenced headings\n\n## Rules\n\nActual authority.\n\n```md\n## Rules\nExample only.\n```\n\n## Next\n\nNot part of Rules.\n'
    )
    git(root, ['add', 'docs/fenced.md'])

    expectSuccess(
      runController(root, 'link-spec', {
        expected: currentExpected(root, true),
        specRef: { path: 'docs/fenced.md', section: 'Rules', purpose: 'Actual rules' },
      })
    )
    const snapshot = expectSuccess(runController(root, 'snapshot', undefined, ['--mode', 'agent', '--role', 'all']))
    const content = ((snapshot.specs as JsonObject[])[0] as JsonObject).content as string
    expect(content).toContain('Actual authority')
    expect(content).toContain('Example only')
    expect(content).not.toContain('Not part of Rules')
  })

  it('checks Git tracking with a literal pathspec', async () => {
    const root = await createProject()
    startTask(root, 'literal-pathspec-task')
    await fs.writeFile(join(root, 'docs', 'a.md'), '# Tracked\n\n## Rules\n\nTracked file.\n')
    git(root, ['add', 'docs/a.md'])
    git(root, ['commit', '-qm', 'test: add pathspec fixture'])
    await fs.writeFile(join(root, 'docs', '[a].md'), '# Literal\n\n## Rules\n\nUntracked literal file.\n')

    expectFailure(
      runController(root, 'link-spec', {
        expected: currentExpected(root, true),
        specRef: { path: 'docs/[a].md', section: 'Rules', purpose: 'Must be tracked literally' },
      }),
      'SPEC_NOT_TRACKED'
    )
  })

  it('rejects oversized sections and spec files that exceed the source scan limit', async () => {
    const root = await createProject()
    startTask(root, 'oversized-spec-task')
    await fs.writeFile(join(root, 'docs', 'large-section.md'), `# Large\n\n## Rules\n\n${'x'.repeat(5000)}\n`)
    await fs.writeFile(
      join(root, 'docs', 'large-source.md'),
      `# Large source\n\n## Rules\n\nSmall rule.\n\n## Other\n\n${'y'.repeat(300 * 1024)}\n`
    )
    git(root, ['add', 'docs/large-section.md', 'docs/large-source.md'])

    for (const specPath of ['docs/large-section.md', 'docs/large-source.md']) {
      expectFailure(
        runController(root, 'link-spec', {
          expected: currentExpected(root, true),
          specRef: { path: specPath, section: 'Rules', purpose: 'Oversized authority' },
        }),
        'SPEC_SECTION_TOO_LARGE'
      )
    }
  })

  it.each([
    ['absolute path', '/tmp/spec.md', 'Shared rules', 'PATH_INVALID'],
    ['parent traversal', '../outside.md', 'Shared rules', 'PATH_INVALID'],
    ['untracked file', 'docs/untracked.md', 'Rules', 'SPEC_NOT_TRACKED'],
    ['missing heading', 'docs/integration.md', 'Missing heading', 'SPEC_SECTION_NOT_FOUND'],
    ['non-Markdown file', 'package.json', 'name', 'PATH_INVALID'],
  ])('rejects an unsafe or invalid spec reference: %s', async (_name, specPath, section, code) => {
    const root = await createProject()
    startTask(root, 'invalid-spec-task')
    if (specPath === 'docs/untracked.md') await fs.writeFile(join(root, specPath), '# Rules\n')

    expectFailure(
      runController(root, 'link-spec', {
        expected: currentExpected(root, true),
        specRef: { path: specPath, section, purpose: 'Invalid reference' },
      }),
      code
    )
  })

  it('rejects symlinked spec paths even when the symlink is tracked', async () => {
    const root = await createProject()
    startTask(root, 'symlink-spec-task')
    await fs.symlink('integration.md', join(root, 'docs', 'linked.md'))
    git(root, ['add', 'docs/linked.md'])

    expectFailure(
      runController(root, 'link-spec', {
        expected: currentExpected(root, true),
        specRef: {
          path: 'docs/linked.md',
          section: 'Shared rules',
          purpose: 'Symlink must fail',
        },
      }),
      'PATH_INVALID'
    )
  })

  it('marks changed linked specs invalid and denies downstream tools', async () => {
    const root = await createProject()
    startTask(root, 'changed-spec-task')
    expectSuccess(
      runController(root, 'link-spec', {
        expected: currentExpected(root, true),
        specRef: {
          path: 'docs/integration.md',
          section: 'Implementation rules',
          purpose: 'Implementation authority',
          roles: ['implement'],
        },
      })
    )
    await fs.writeFile(
      join(root, 'docs', 'integration.md'),
      '# Integration contract\n\n## Different rules\n\nChanged.\n'
    )

    const snapshot = expectSuccess(
      runController(root, 'snapshot', undefined, ['--mode', 'agent', '--role', 'implement'])
    )
    expect(snapshot).toMatchObject({ kind: 'invalid', code: 'SPEC_SECTION_NOT_FOUND' })

    const hook = hookOutput(
      runHook(root, 'subagent-context.js', {
        cwd: root,
        tool_name: 'Agent',
        tool_input: { name: 'dev-1', prompt: 'Implement the task' },
      })
    )
    expect(hook).toMatchObject({
      permissionDecision: 'deny',
      permissionDecisionReason: expect.stringContaining('SPEC_SECTION_NOT_FOUND'),
    })
    expect(hook.updatedInput).toBeUndefined()
  })

  it('rejects role-matched spec sets that exceed the rendered context budget', async () => {
    const root = await createProject()
    startTask(root, 'spec-budget-task')
    const sections = Array.from(
      { length: 4 },
      (_, index) => `## Rules ${index + 1}\n\n${String(index + 1).repeat(3400)}\n`
    )
    await fs.writeFile(join(root, 'docs', 'spec-budget.md'), `# Spec budget\n\n${sections.join('\n')}`)
    git(root, ['add', 'docs/spec-budget.md'])
    for (let index = 0; index < sections.length - 1; index++) {
      expectSuccess(
        runController(root, 'link-spec', {
          expected: currentExpected(root, true),
          specRef: {
            path: 'docs/spec-budget.md',
            section: `Rules ${index + 1}`,
            purpose: `Authority ${index + 1}`,
            roles: ['implement'],
          },
        })
      )
    }

    expectFailure(
      runController(root, 'link-spec', {
        expected: currentExpected(root, true),
        specRef: {
          path: 'docs/spec-budget.md',
          section: `Rules ${sections.length}`,
          purpose: `Authority ${sections.length}`,
          roles: ['implement'],
        },
      }),
      'SPEC_CONTEXT_TOO_LARGE'
    )
    const snapshot = expectSuccess(
      runController(root, 'snapshot', undefined, ['--mode', 'agent', '--role', 'implement'])
    )
    expect(snapshot.kind).not.toBe('invalid')
    expect(snapshot.specs).toHaveLength(3)
  })

  it('marks a snapshot invalid when the required task contract disappears', async () => {
    const root = await createProject()
    startTask(root, 'missing-contract-task')
    await fs.remove(join(root, '.ccg', 'tasks', 'missing-contract-task', 'requirements.md'))

    const snapshot = expectSuccess(runController(root, 'snapshot', undefined, ['--mode', 'session', '--role', 'all']))
    expect(snapshot).toMatchObject({ kind: 'invalid', code: 'TASK_CONTRACT_MISSING' })

    const hook = hookOutput(
      runHook(root, 'subagent-context.js', {
        cwd: root,
        tool_name: 'Agent',
        tool_input: { name: 'dev-1', prompt: 'Implement the task' },
      })
    )
    expect(hook.permissionDecision).toBe('deny')
    expect(hook.permissionDecisionReason).toContain('TASK_CONTRACT_MISSING')
  })

  it('rejects a task contract that cannot fit after XML escaping', async () => {
    const root = await createProject()
    startTask(root, 'escaped-contract-budget-task')
    expectSuccess(
      runController(root, 'update-requirements', {
        expected: currentExpected(root, true),
        content: `# Requirements\n\n${'&'.repeat(2000)}\n`,
      })
    )

    const snapshot = expectSuccess(
      runController(root, 'snapshot', undefined, ['--mode', 'agent', '--role', 'implement'])
    )
    expect(snapshot).toMatchObject({ kind: 'invalid', code: 'TASK_CONTRACT_CONTEXT_TOO_LARGE' })
    const hook = hookOutput(
      runHook(root, 'subagent-context.js', {
        cwd: root,
        tool_name: 'Agent',
        tool_input: { name: 'implementer', prompt: 'Implement assigned files' },
      })
    )
    expect(hook.permissionDecision).toBe('deny')
    expect(hook.permissionDecisionReason).toContain('TASK_CONTRACT_CONTEXT_TOO_LARGE')
  })

  it('rejects symbolic-link parents for task research artifacts', async () => {
    const root = await createProject()
    startTask(root, 'research-symlink-task')
    const outside = `${root}-outside`
    cleanupPaths.add(outside)
    await fs.ensureDir(outside)
    await fs.writeFile(join(outside, 'leak.md'), 'OUTSIDE_SENTINEL\n')
    await fs.symlink(outside, join(root, '.ccg', 'tasks', 'research-symlink-task', 'research'))

    expectFailure(
      runController(root, 'write-artifact', {
        expected: currentExpected(root, true),
        kind: 'research',
        name: 'result.md',
        content: '# Result\n',
      }),
      'PATH_INVALID'
    )
    const snapshot = expectSuccess(runController(root, 'snapshot', undefined, ['--mode', 'session', '--role', 'all']))
    expect(snapshot.diagnostics).toContain('PATH_INVALID:research')
    expect(JSON.stringify(snapshot)).not.toContain('OUTSIDE_SENTINEL')
  })

  it('escapes task and spec content before placing it in Hook XML', async () => {
    const root = await createProject()
    startTask(root, 'xml-task')
    expectSuccess(
      runController(root, 'update-requirements', {
        expected: currentExpected(root, true),
        content: '# Requirements\n\nUse <unsafe> & preserve "quotes".\n',
      })
    )
    expectSuccess(
      runController(root, 'link-spec', {
        expected: currentExpected(root, true),
        specRef: {
          path: 'docs/integration.md',
          section: 'Shared rules',
          purpose: 'Contract <authority>',
        },
      })
    )

    const session = hookOutput(runHook(root, 'session-start.js', { cwd: root, source: 'startup' }))
    expect(session.additionalContext).toContain('&lt;unsafe&gt; &amp; preserve &quot;quotes&quot;')
    expect(session.additionalContext).toContain('Contract &lt;authority&gt;')
    expect(session.additionalContext).not.toContain('Use <unsafe>')
  })

  it('keeps specs and the task contract ahead of bounded optional artifacts', async () => {
    const root = await createProject()
    startTask(root, 'authority-order-task')
    await fs.writeFile(
      join(root, 'docs', 'authority-order.md'),
      `# Authority\n\n## Exact rules\n\nSPEC_SENTINEL\n${'s'.repeat(3400)}\n`
    )
    git(root, ['add', 'docs/authority-order.md'])
    expectSuccess(
      runController(root, 'update-requirements', {
        expected: currentExpected(root, true),
        content: `# Requirements\n\nCONTRACT_SENTINEL\n${'r'.repeat(7000)}\n`,
      })
    )
    expectSuccess(
      runController(root, 'link-spec', {
        expected: currentExpected(root, true),
        specRef: {
          path: 'docs/authority-order.md',
          section: 'Exact rules',
          purpose: 'Verify context ordering',
          roles: ['implement'],
        },
      })
    )
    for (const [kind, marker, size] of [
      ['plan', 'PLAN_SENTINEL', 7000],
      ['analysis', 'ANALYSIS_SENTINEL', 7000],
      ['review', 'REVIEW_SENTINEL', 3500],
    ] as const) {
      expectSuccess(
        runController(root, 'write-artifact', {
          expected: currentExpected(root, true),
          kind,
          content: `# ${kind}\n\n${marker}\n${kind[0].repeat(size)}\n`,
        })
      )
    }

    const sessionOutput = hookOutput(runHook(root, 'session-start.js', { cwd: root, source: 'compact' }))
    const sessionContext = sessionOutput.additionalContext as string
    expect(Buffer.byteLength(sessionContext, 'utf-8')).toBeLessThanOrEqual(32 * 1024)
    expect(sessionContext).toContain('SPEC_SENTINEL')
    expect(sessionContext).toContain('CONTRACT_SENTINEL')
    expect(sessionContext).toContain('PLAN_SENTINEL')
    expect(sessionContext.indexOf('SPEC_SENTINEL')).toBeLessThan(sessionContext.indexOf('CONTRACT_SENTINEL'))
    expect(sessionContext.indexOf('CONTRACT_SENTINEL')).toBeLessThan(sessionContext.indexOf('PLAN_SENTINEL'))

    const agentOutput = hookOutput(
      runHook(root, 'subagent-context.js', {
        cwd: root,
        tool_name: 'Agent',
        tool_input: { name: 'implementer', prompt: 'Implement assigned files' },
      })
    )
    const agentPrompt = (agentOutput.updatedInput as JsonObject).prompt as string
    expect(agentPrompt).toContain('SPEC_SENTINEL')
    expect(agentPrompt).toContain('CONTRACT_SENTINEL')
    expect(agentPrompt.indexOf('SPEC_SENTINEL')).toBeLessThan(agentPrompt.indexOf('CONTRACT_SENTINEL'))
  })
})

describe('session and sub-agent Hooks', () => {
  it('prefers Hook input cwd over a conflicting project environment variable', async () => {
    const inputRoot = await createProject()
    const environmentRoot = await createProject()
    startTask(inputRoot, 'input-cwd-task')
    startTask(environmentRoot, 'environment-task')
    const env = { CLAUDE_PROJECT_DIR: environmentRoot }

    const session = hookOutput(runHook(environmentRoot, 'session-start.js', { cwd: inputRoot, source: 'resume' }, env))
    expect(session.additionalContext).toContain('input-cwd-task')
    expect(session.additionalContext).not.toContain('environment-task')

    const breadcrumb = hookOutput(
      runHook(environmentRoot, 'workflow-state.js', { cwd: inputRoot, session_id: 'cwd-test' }, env)
    )
    expect(breadcrumb.additionalContext).toContain('input-cwd-task')
    expect(breadcrumb.additionalContext).not.toContain('environment-task')

    const agent = hookOutput(
      runHook(
        environmentRoot,
        'subagent-context.js',
        {
          cwd: inputRoot,
          tool_name: 'Agent',
          tool_input: { name: 'implementer', prompt: 'Implement assigned files' },
        },
        env
      )
    )
    expect((agent.updatedInput as JsonObject).prompt).toContain('input-cwd-task')
    expect((agent.updatedInput as JsonObject).prompt).not.toContain('environment-task')
  })

  it('restores the same complete task context for startup, resume, compact, clear, and fork', async () => {
    const root = await createProject()
    startTask(root, 'restore-task')
    expectSuccess(
      runController(root, 'write-artifact', {
        expected: currentExpected(root, true),
        kind: 'plan',
        content: '# Plan\n\nDo not merge module-beta.\n',
      })
    )
    expectSuccess(
      runController(root, 'link-spec', {
        expected: currentExpected(root, true),
        specRef: {
          path: 'docs/integration.md',
          section: 'Implementation rules',
          purpose: 'Implementation authority',
          roles: ['implement'],
        },
      })
    )

    const contexts = ['startup', 'resume', 'compact', 'clear', 'fork'].map((source) => {
      const output = hookOutput(
        runHook(root, 'session-start.js', { cwd: root, source, session_id: `session-${source}` })
      )
      return output.additionalContext as string
    })
    expect(new Set(contexts).size).toBe(1)
    expect(contexts[0]).toContain('Default (frontend=claude, backend=claude)')
    expect(contexts[0]).toContain('Complete restore-task')
    expect(contexts[0]).toContain('Do not merge module-beta')
    expect(contexts[0]).toContain('module-beta is referenced by Planning build system and does not merge')
  })

  it('refreshes exact authority on every user prompt without stale task artifacts', async () => {
    const root = await createProject()
    startTask(root, 'prompt-authority-task')
    expectSuccess(
      runController(root, 'link-spec', {
        expected: currentExpected(root, true),
        specRef: {
          path: 'docs/integration.md',
          section: 'Implementation rules',
          purpose: 'Current implementation authority',
        },
      })
    )
    expectSuccess(
      runController(root, 'write-artifact', {
        expected: currentExpected(root, true),
        kind: 'plan',
        content: '# Plan\n\nSTALE_PLAN_SENTINEL: merge module-beta.\n',
      })
    )
    expectSuccess(
      runController(root, 'checkpoint', {
        expected: currentExpected(root, true),
        currentPhase: 'implementation',
        nextAction: 'Follow the exact linked specification',
        gate: null,
        progress: '# Progress\n\nSTALE_PROGRESS_SENTINEL\n',
      })
    )
    expectSuccess(
      runController(root, 'write-artifact', {
        expected: currentExpected(root, true),
        kind: 'research',
        name: 'stale.md',
        content: '# Research\n\nSTALE_RESEARCH_SENTINEL\n',
      })
    )

    const snapshot = expectSuccess(runController(root, 'snapshot', undefined, ['--mode', 'authority', '--role', 'all']))
    expect(snapshot.documents).toEqual({
      requirements: expect.stringContaining('Complete prompt-authority-task'),
    })
    expect(snapshot.research).toEqual([])

    const output = hookOutput(
      runHook(root, 'workflow-state.js', {
        cwd: root,
        hook_event_name: 'UserPromptSubmit',
        session_id: 'authority-prompt',
        prompt: 'Continue',
      })
    )
    const context = output.additionalContext as string
    expect(output.hookEventName).toBe('UserPromptSubmit')
    expect(context).toContain('<ccg-authority>')
    expect(context).toContain('module-beta is referenced by Planning build system and does not merge')
    expect(context).toContain('Complete prompt-authority-task')
    expect(context).toContain('allowed actions, prohibited actions, exclusions, stop conditions')
    expect(context).not.toContain('STALE_PLAN_SENTINEL')
    expect(context).not.toContain('STALE_PROGRESS_SENTINEL')
    expect(context).not.toContain('STALE_RESEARCH_SENTINEL')
  })

  it('refreshes the latest authority after foreground external results and failures', async () => {
    const root = await createProject()
    startTask(root, 'result-authority-task')
    expectSuccess(
      runController(root, 'link-spec', {
        expected: currentExpected(root, true),
        specRef: {
          path: 'docs/integration.md',
          section: 'Review rules',
          purpose: 'Review authority',
        },
      })
    )

    const wrapperCommand = `codeagent-wrapper --backend codex - "${root}" <<'EOF'\nCCG_ROLE: review\nReview.\nEOF`
    const cases: Array<{ event: string; toolName: string; toolInput: JsonObject; extra?: JsonObject }> = [
      {
        event: 'PostToolUse',
        toolName: 'Agent',
        toolInput: { name: 'reviewer', prompt: 'Review changes' },
        extra: { tool_response: { result: 'Agent completed' } },
      },
      {
        event: 'PostToolUse',
        toolName: 'Bash',
        toolInput: { command: wrapperCommand },
        extra: { tool_response: { stdout: 'Review completed', exitCode: 0 } },
      },
      {
        event: 'PostToolUse',
        toolName: 'TaskOutput',
        toolInput: { task_id: 'task-1', block: true },
        extra: { tool_response: { status: 'completed', output: 'External result' } },
      },
      {
        event: 'PostToolUseFailure',
        toolName: 'Agent',
        toolInput: { name: 'reviewer', prompt: 'Review changes' },
        extra: { error: 'Agent failed' },
      },
      {
        event: 'PostToolUseFailure',
        toolName: 'Bash',
        toolInput: { command: wrapperCommand },
        extra: { error: 'Wrapper failed' },
      },
    ]

    const launch = runHook(root, 'workflow-state.js', {
      cwd: root,
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: wrapperCommand, run_in_background: true },
      tool_response: { task_id: 'task-1', status: 'running' },
    })
    expect(launch.stdout).toBe('')

    expectSuccess(
      runController(root, 'update-requirements', {
        expected: currentExpected(root, true),
        content: '# Requirements\n\nLATEST_REQUIREMENTS_SENTINEL\n',
      })
    )
    for (const testCase of cases) {
      const output = hookOutput(
        runHook(root, 'workflow-state.js', {
          cwd: root,
          hook_event_name: testCase.event,
          tool_name: testCase.toolName,
          tool_input: testCase.toolInput,
          ...testCase.extra,
        })
      )
      expect(output.hookEventName).toBe(testCase.event)
      expect(output.additionalContext).toContain('LATEST_REQUIREMENTS_SENTINEL')
      expect(output.additionalContext).toContain('Reject any plan that merges Planning, module-beta, or module-gamma')
    }
  })

  it('skips authority refresh for ordinary tools and background launch acknowledgements', async () => {
    const root = await createProject()
    startTask(root, 'background-authority-task')

    const inputs: JsonObject[] = [
      {
        cwd: root,
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'git status --short' },
        tool_response: { stdout: '', exitCode: 0 },
      },
      {
        cwd: root,
        hook_event_name: 'PostToolUse',
        tool_name: 'Agent',
        tool_input: { name: 'reviewer', prompt: 'Review changes', run_in_background: true },
        tool_response: { agentId: 'agent-1', status: 'running' },
      },
      {
        cwd: root,
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: {
          command: `codeagent-wrapper --backend codex - "${root}" <<'EOF'\nReview.\nEOF`,
          run_in_background: true,
        },
        tool_response: { task_id: 'task-1', status: 'running' },
      },
    ]

    for (const input of inputs) {
      const result = runHook(root, 'workflow-state.js', input)
      expect(result.status).toBe(0)
      expect(result.stdout).toBe('')
      expect(result.stderr).toBe('')
    }
  })

  it('prepends all linked authority to generic Agent prompts while preserving all fields', async () => {
    const root = await createProject()
    startTask(root, 'agent-task')
    expectSuccess(
      runController(root, 'link-spec', {
        expected: currentExpected(root, true),
        specRef: {
          path: 'docs/integration.md',
          section: 'Implementation rules',
          purpose: 'Implementation authority',
          roles: ['implement'],
        },
      })
    )

    const output = hookOutput(
      runHook(root, 'subagent-context.js', {
        cwd: root,
        tool_name: 'Agent',
        tool_use_id: 'tool-1',
        tool_input: {
          name: 'worker-1',
          description: 'Implement one file group',
          subagent_type: 'general-purpose',
          team_name: 'fixture-team',
          prompt: 'Task: agent-task@2\nModify src/example.ts',
        },
      })
    )
    const updated = output.updatedInput as JsonObject
    expect(updated).toMatchObject({
      name: 'worker-1',
      description: 'Implement one file group',
      subagent_type: 'general-purpose',
      team_name: 'fixture-team',
    })
    expect(updated.prompt).toContain('<ccg-injected-context>')
    expect(updated.prompt).toContain('Implementation authority')
    expect(updated.prompt).toContain('Task: agent-task@2')
    expect((updated.prompt as string).indexOf('<ccg-injected-context>')).toBeLessThan(
      (updated.prompt as string).indexOf('Task: agent-task@2')
    )
  })

  it('injects context into serial and every parallel wrapper task body', async () => {
    const root = await createProject()
    startTask(root, 'wrapper-task')
    expectSuccess(
      runController(root, 'link-spec', {
        expected: currentExpected(root, true),
        specRef: {
          path: 'docs/integration.md',
          section: 'Implementation rules',
          purpose: 'Implementation authority',
          roles: ['implement'],
        },
      })
    )

    const serialCommand = `"/tmp/codeagent-wrapper" --backend codex - "${root}" <<'SERIAL_EOF'\nROLE_FILE: /tmp/builder.md\n<TASK>\nImplement.\n</TASK>\nSERIAL_EOF`
    const serial = hookOutput(
      runHook(root, 'subagent-context.js', {
        cwd: root,
        tool_name: 'Bash',
        tool_input: { command: serialCommand, timeout: 1000 },
      })
    )
    const serialUpdated = serial.updatedInput as JsonObject
    expect(serialUpdated.timeout).toBe(1000)
    expect(serialUpdated.command).toContain('<ccg-injected-context>')
    expect((serialUpdated.command as string).indexOf('<ccg-injected-context>')).toBeLessThan(
      (serialUpdated.command as string).indexOf('ROLE_FILE:')
    )

    const parallelCommand = `"/tmp/codeagent-wrapper" --parallel --backend codex - "${root}" <<'PARALLEL_EOF'\n---TASK---\nid: first\nworkdir: ${root}\n---CONTENT---\nROLE_FILE: /tmp/builder.md\n<TASK>first</TASK>\n---TASK---\nid: second\nworkdir: ${root}\n---CONTENT---\nROLE_FILE: /tmp/builder.md\n<TASK>second</TASK>\nPARALLEL_EOF`
    const parallel = hookOutput(
      runHook(root, 'subagent-context.js', {
        cwd: root,
        tool_name: 'Bash',
        tool_input: { command: parallelCommand },
      })
    )
    const parallelCommandUpdated = (parallel.updatedInput as JsonObject).command as string
    expect(parallelCommandUpdated.match(/<ccg-injected-context>/g)).toHaveLength(2)
    expect(parallelCommandUpdated.match(/Implementation authority/g)).toHaveLength(2)
  })

  it('recognizes env wrapper invocations and rejects a heredoc owned by another command', async () => {
    const root = await createProject()
    startTask(root, 'wrapper-binding-task')

    const envCommand = `env CCG_TEST=1 codeagent-wrapper --backend codex --label "safe&value" - "${root}" <<'EOF'\nCCG_ROLE: implement\n<TASK>Implement.</TASK>\nEOF`
    const envOutput = hookOutput(
      runHook(root, 'subagent-context.js', {
        cwd: root,
        tool_name: 'Bash',
        tool_input: { command: envCommand },
      })
    )
    expect((envOutput.updatedInput as JsonObject).command).toContain('<ccg-injected-context>')

    const unrelatedHeredoc = `codeagent-wrapper --version; cat <<'EOF'\nnot wrapper input\nEOF`
    const denied = hookOutput(
      runHook(root, 'subagent-context.js', {
        cwd: root,
        tool_name: 'Bash',
        tool_input: { command: unrelatedHeredoc },
      })
    )
    expect(denied.permissionDecision).toBe('deny')
    expect(denied.permissionDecisionReason).toContain('does not belong to the codeagent-wrapper command')
    expect(denied.updatedInput).toBeUndefined()
  })

  it('changes a colliding heredoc delimiter and rejects ambiguous shell structures', async () => {
    const root = await createProject()
    startTask(root, 'heredoc-task')
    expectSuccess(
      runController(root, 'update-requirements', {
        expected: currentExpected(root, true),
        content: '# Requirements\n\nEOF\n',
      })
    )

    const colliding = hookOutput(
      runHook(root, 'subagent-context.js', {
        cwd: root,
        tool_name: 'Bash',
        tool_input: {
          command: `"/tmp/codeagent-wrapper" --backend codex - "${root}" <<'EOF'\nROLE_FILE: /tmp/builder.md\nEOF`,
        },
      })
    )
    const command = (colliding.updatedInput as JsonObject).command as string
    expect(command).not.toContain("<<'EOF'")
    expect(command).toMatch(/<<'CCG_CONTEXT_[A-F0-9]+'/)

    const tabStripped = hookOutput(
      runHook(root, 'subagent-context.js', {
        cwd: root,
        tool_name: 'Bash',
        tool_input: {
          command: `"/tmp/codeagent-wrapper" --backend codex - "${root}" <<-'EOF'\r\n\tROLE_FILE: /tmp/builder.md\r\n\tEOF\r\n`,
        },
      })
    )
    const tabStrippedCommand = (tabStripped.updatedInput as JsonObject).command as string
    const tabStrippedDelimiter = tabStrippedCommand.match(/<<-'(CCG_CONTEXT_[A-F0-9]+)'/)?.[1]
    expect(tabStrippedDelimiter).toBeTruthy()
    expect(tabStrippedCommand).toContain(`\t${tabStrippedDelimiter}\r\n`)
    expect(tabStrippedCommand).not.toContain(`\tE${tabStrippedDelimiter}`)

    const ambiguous = hookOutput(
      runHook(root, 'subagent-context.js', {
        cwd: root,
        tool_name: 'Bash',
        tool_input: {
          command: `"/tmp/codeagent-wrapper" --backend codex - "${root}" <<'ONE'\none\nONE\ncat <<'TWO'\ntwo\nTWO`,
        },
      })
    )
    expect(ambiguous.additionalContext).toContain('CONTEXT_NOT_INJECTED')
    expect(ambiguous.permissionDecision).toBe('deny')
    expect(ambiguous.permissionDecisionReason).toContain('Expected exactly one quoted heredoc')
    expect(ambiguous.updatedInput).toBeUndefined()
  })

  it('keeps loop telemetry separate by session and authority output bounded', async () => {
    const root = await createProject()
    startTask(root, 'loop-task')

    const contexts: string[] = []
    for (let turn = 0; turn < 3; turn++) {
      const output = hookOutput(
        runHook(root, 'workflow-state.js', {
          cwd: root,
          session_id: 'session-a',
          prompt: `Turn ${turn}`,
        })
      )
      contexts.push(output.additionalContext as string)
    }
    expect(contexts[0]).not.toContain('Loop:')
    expect(contexts[2]).toContain('Loop: phase and next action repeated 3 turns')
    expect(contexts[2]).toContain('Complete loop-task')
    expect(Buffer.byteLength(contexts[2], 'utf-8')).toBeLessThanOrEqual(32 * 1024)

    const otherSession = hookOutput(
      runHook(root, 'workflow-state.js', {
        cwd: root,
        session_id: 'session-b',
        prompt: 'Independent session',
      })
    )
    expect(otherSession.additionalContext).not.toContain('Loop:')

    const missingSession = hookOutput(runHook(root, 'workflow-state.js', { cwd: root, prompt: 'No session id' }))
    expect(missingSession.additionalContext).toContain('SESSION_ID_MISSING')
  })
})

describe('default OpenSpec task authority', () => {
  it('labels wrapper roles and connects every phase to the shared task controller', () => {
    const research = readFileSync(join(packageRoot, 'templates', 'commands', 'spec-research.md'), 'utf-8')
    const plan = readFileSync(join(packageRoot, 'templates', 'commands', 'spec-plan.md'), 'utf-8')
    const implementation = readFileSync(join(packageRoot, 'templates', 'commands', 'spec-impl.md'), 'utf-8')

    expect(research.match(/CCG_ROLE: research/g)).toHaveLength(2)
    expect(plan.match(/CCG_ROLE: research/g)).toHaveLength(2)
    expect(implementation).toContain('CCG_ROLE: implement')
    for (const command of [research, plan, implementation]) {
      expect(command).toContain('task-state.js resolve')
      expect(command).toContain('openspec/changes/<change_id>/')
      expect(command).toContain('spec_artifacts_must_be_tracked')
      expect(command).toContain('must never run `git add` automatically')
    }
    expect(research).toContain('task-state.js start')
    expect(research).toContain('"scope": "OpenSpec change: <change_id>')
    expect(research).toContain('`link-spec`')
    expect(plan).toContain('--mode authority --role research')
    expect(plan).toContain('at least one matching exact `specRef`')
    expect(implementation).toContain('--mode authority --role implement')
    expect(implementation).toContain('PostToolUse Hook refreshes authority')
    expect(implementation).toContain('unlink them one at a time with `unlink-spec`')
  })
})

describe('skill router Hook', () => {
  it('reports malformed Hook input instead of exiting silently', async () => {
    const root = await createProject()
    const output = hookOutput(runScript(join(hooksDir, 'skill-router.js'), [], '{broken', root))
    expect(output.additionalContext).toContain('CCG_SKILL_ROUTER_ERROR')
    expect(output.additionalContext).toContain('HOOK_INPUT_INVALID')
  })

  it('uses independent Claude Code Agents for a dual analysis without routing configuration', async () => {
    const root = await createProject()
    const output = hookOutput(
      runScript(join(hooksDir, 'skill-router.js'), [], { prompt: '请双模型分析当前项目' }, root)
    )
    const context = output.additionalContext as string

    expect(context).toContain('缺少配置时两者均使用 Claude Code')
    expect(context).toContain('CCG_ROLE: research')
    expect(context).toContain('不得调用 codeagent-wrapper 或任何外部 CLI')
    expect(context).not.toContain('缺少配置时分别使用 codex 与 antigravity')
  })

  it('requires an explicit external-review request before starting a reviewer CLI', () => {
    const sourceFiles = [
      join(packageRoot, 'templates', 'engine', 'model-router.md'),
      join(packageRoot, 'templates', 'engine', 'strategies', 'guided-develop.md'),
      join(packageRoot, 'templates', 'engine', 'strategies', 'refactor-safely.md'),
      join(packageRoot, 'templates', 'engine', 'strategies', 'full-collaborate.md'),
      join(packageRoot, 'templates', 'engine', 'strategies', 'review-audit.md'),
      join(packageRoot, 'templates', 'engine', 'phase-guide.md'),
      join(packageRoot, 'templates', 'commands', 'spec-impl.md'),
      join(packageRoot, 'templates', 'commands', 'spec-research.md'),
      join(packageRoot, 'templates', 'commands', 'spec-plan.md'),
      join(packageRoot, 'templates', 'commands', 'spec-init.md'),
    ]

    for (const sourceFile of sourceFiles) {
      const source = readFileSync(sourceFile, 'utf-8')
      expect(source).toMatch(/用户明确请求|用户已将.*明确配置|user explicitly requests/i)
    }
  })
})

describe('Codex shared task Hook', () => {
  it('injects all linked spec roles into the main Codex session', async () => {
    const root = await createProject()
    const hookPath = await installCodexHookRuntime()
    startTask(root, 'codex-main-task')
    for (const specRef of [
      {
        path: 'docs/integration.md',
        section: 'Implementation rules',
        purpose: 'Implementation authority',
        roles: ['implement'],
      },
      {
        path: 'docs/integration.md',
        section: 'Review rules',
        purpose: 'Review authority',
        roles: ['review'],
      },
    ]) {
      expectSuccess(
        runController(root, 'link-spec', {
          expected: currentExpected(root, true),
          specRef,
        })
      )
    }

    const output = hookOutput(runCodexHook(root, hookPath))
    const context = output.additionalContext as string
    expect(context).toContain('module-beta is referenced by Planning build system and does not merge')
    expect(context).toContain('Reject any plan that merges Planning, module-beta, or module-gamma')
    expect(context.indexOf('AUTHORITATIVE LINKED SPEC SECTIONS')).toBeLessThan(
      context.indexOf('AUTHORITATIVE TASK CONTRACT')
    )
  })

  it('injects the matching task snapshot into Codex leaf agents', async () => {
    const root = await createProject()
    const hookPath = await installCodexHookRuntime()
    startTask(root, 'codex-leaf-task')
    for (const specRef of [
      {
        path: 'docs/integration.md',
        section: 'Implementation rules',
        purpose: 'Implementation authority',
        roles: ['implement'],
      },
      {
        path: 'docs/integration.md',
        section: 'Review rules',
        purpose: 'Review authority',
        roles: ['review'],
      },
    ]) {
      expectSuccess(
        runController(root, 'link-spec', {
          expected: currentExpected(root, true),
          specRef,
        })
      )
    }

    const output = hookOutput(runCodexHook(root, hookPath, 'ccg-review'))
    const context = output.additionalContext as string
    expect(context).toContain('SUB-AGENT NOTICE')
    expect(context).toContain('codex-leaf-task')
    expect(context).toContain('Reject any plan that merges Planning, module-beta, or module-gamma')
    expect(context).not.toContain('module-beta is referenced by Planning build system and does not merge')
  })

  it('includes research artifacts and omits oversized optional blocks without truncating XML', async () => {
    const root = await createProject()
    const hookPath = await installCodexHookRuntime()
    startTask(root, 'codex-budget-task')
    expectSuccess(
      runController(root, 'write-artifact', {
        expected: currentExpected(root, true),
        kind: 'research',
        name: 'finding.md',
        content: '# Finding\n\nRESEARCH_SENTINEL\n',
      })
    )
    expectSuccess(
      runController(root, 'write-artifact', {
        expected: currentExpected(root, true),
        kind: 'plan',
        content: `# Plan\n\nPLAN_SENTINEL\n${'&'.repeat(7000)}\n`,
      })
    )

    const output = hookOutput(runCodexHook(root, hookPath))
    const context = output.additionalContext as string
    expect(Buffer.byteLength(context, 'utf-8')).toBeLessThanOrEqual(32 * 1024)
    expect(context).toContain('RESEARCH_SENTINEL')
    expect(context).toContain('AUTHORITATIVE TASK CONTRACT')
    expect(context).not.toContain('PLAN_SENTINEL')
    expect(context).toContain('CONTEXT_OMITTED:plan:render-budget')
    expect(context.endsWith('</ccg-state>')).toBe(true)
  })
})
