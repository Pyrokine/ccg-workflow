import fs from 'fs-extra'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { BindingValue, JsonObject, TaskValue } from './task-state-fixtures'
import {
  asyncController,
  cleanupPaths,
  createProject,
  currentExpected,
  DEFAULT_SESSION_KEY,
  deriveSessionKey,
  expectFailure,
  expectSuccess,
  finishActive,
  hookOutput,
  resolve,
  runController,
  runHook,
  startTask,
  taskInput,
} from './task-state-fixtures'

async function finishFixture(overrides: JsonObject = {}): Promise<string> {
  const root = await fs.mkdtemp(join(tmpdir(), 'ccg-finish-'))
  cleanupPaths.add(root)
  const stateId = randomUUID()
  const now = new Date().toISOString()
  await fs.outputJson(join(root, '.ccg', 'state.json'), { schemaVersion: 2, stateId, revision: 1, updatedAt: now })
  await fs.outputJson(join(root, '.ccg', 'sessions', `${DEFAULT_SESSION_KEY}.json`), {
    schemaVersion: 1,
    stateId,
    revision: 1,
    activeTaskId: 'child-task',
    createdAt: now,
    updatedAt: now,
  })
  for (const id of ['parent-task', 'child-task']) {
    await fs.outputJson(join(root, '.ccg', 'tasks', id, 'task.json'), {
      schemaVersion: 1,
      revision: 1,
      ...taskInput(id, id === 'child-task' ? overrides : {}),
      status: 'open',
      returnToTaskId: id === 'child-task' ? 'parent-task' : null,
      specRefs: [],
      branchAtCreation: null,
      headAtCreation: null,
      createdAt: now,
      updatedAt: now,
      finishedAt: null,
    })
  }
  return root
}

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
    expect(current.candidates).toEqual([
      { id: 'alpha-task', title: 'Task alpha-task', revision: 1, status: 'open', claimed: false },
    ])
    expect(await fs.pathExists(join(root, '.ccg', 'tasks', 'zeta-task', 'task.json'))).toBe(true)

    const activated = expectSuccess(
      runController(root, 'activate', {
        expected: { ...currentExpected(root), taskRevision: 1 },
        taskId: 'alpha-task',
      })
    )
    expect((activated.binding as BindingValue).activeTaskId).toBe('alpha-task')
  })

  it('returns through nested interrupted tasks without moving task directories', async () => {
    const root = await createProject()
    startTask(root, 'parent-task')
    startTask(root, 'child-task', 'interrupt')
    startTask(root, 'grandchild-task', 'interrupt')

    expect((finishActive(root).binding as BindingValue).activeTaskId).toBe('child-task')
    expect((finishActive(root).binding as BindingValue).activeTaskId).toBe('parent-task')
    expect((finishActive(root).binding as BindingValue).activeTaskId).toBeNull()

    for (const id of ['parent-task', 'child-task', 'grandchild-task']) {
      const task = await fs.readJson(join(root, '.ccg', 'tasks', id, 'task.json'))
      expect(task.status).toBe('completed')
      expect(await fs.pathExists(join(root, '.ccg', 'tasks', id))).toBe(true)
    }
  })

  it.each([undefined, true])('resumes the open parent by default or explicit true: %s', async (value) => {
    const root = await finishFixture()
    const result = expectSuccess(
      runController(root, 'finish', {
        expected: currentExpected(root, true),
        status: 'completed',
        ...(value === undefined ? {} : { restorePreviousTask: value }),
      })
    )
    expect(result).toMatchObject({
      binding: { activeTaskId: 'parent-task', revision: 2 },
      resumedTaskId: 'parent-task',
      task: { status: 'completed', revision: 2 },
    })
  })

  it.each(['completed', 'cancelled'])('finishes without resuming and releases the parent claim: %s', async (status) => {
    const root = await finishFixture()
    const session = deriveSessionKey('claude', 'another-session')
    const candidate = { ...currentExpected(root, false, session), taskRevision: 1 }
    expectFailure(
      runController(root, 'activate', { expected: candidate, taskId: 'parent-task' }, [], session),
      'TASK_CLAIMED'
    )
    const result = expectSuccess(
      runController(root, 'finish', {
        expected: currentExpected(root, true),
        status,
        restorePreviousTask: false,
        progress: '# Progress\n\nFinished\n',
      })
    )
    expect(result).toMatchObject({
      binding: { activeTaskId: null },
      resumedTaskId: null,
      task: { status },
    })
    expect(resolve(root)).toMatchObject({ kind: 'selection-required', activeTaskId: null })
    expect(await fs.readFile(join(root, '.ccg', 'tasks', 'child-task', 'progress.md'), 'utf8')).toBe(
      '# Progress\n\nFinished\n'
    )
    const selected = expectSuccess(
      runController(
        root,
        'activate',
        {
          expected: { ...currentExpected(root, false, session), taskRevision: 1 },
          taskId: 'parent-task',
        },
        [],
        session
      )
    )
    expect(selected).toMatchObject({ binding: { activeTaskId: 'parent-task' } })
  })

  it.each([null, 0, 'false', {}])('rejects non-boolean restorePreviousTask before mutation: %j', async (value) => {
    const root = await finishFixture()
    const expected = currentExpected(root, true)
    expectFailure(
      runController(root, 'finish', { expected, status: 'completed', restorePreviousTask: value }),
      'INVALID_REQUEST'
    )
    expect(currentExpected(root, true)).toEqual(expected)
    expect(await fs.pathExists(join(root, '.ccg', 'transaction.json'))).toBe(false)
  })

  it.each([{ gate: 'approval' }, { specEvolution: 'pending' }])(
    'retains finish gates when return is disabled: %j',
    async (overrides) => {
      const root = await finishFixture(overrides)
      const expected = currentExpected(root, true)
      expectFailure(
        runController(root, 'finish', { expected, status: 'completed', restorePreviousTask: false }),
        overrides.gate ? 'GATE_OPEN' : 'SPEC_EVOLUTION_PENDING'
      )
      expect(currentExpected(root, true)).toEqual(expected)
    }
  )

  it('rejects invalid restore input before acquiring the state lock', async () => {
    const root = await finishFixture()
    const expected = currentExpected(root, true)
    await fs.outputJson(join(root, '.ccg', 'state.lock'), {
      pid: process.pid,
      nonce: randomUUID(),
      createdAt: new Date().toISOString(),
    })
    expectFailure(
      runController(root, 'finish', { expected, status: 'completed', restorePreviousTask: null }),
      'INVALID_REQUEST'
    )
    expect(await fs.pathExists(join(root, '.ccg', 'transaction.json'))).toBe(false)
  })

  it('retains return-chain validation when finishing without returning', async () => {
    const root = await finishFixture()
    const expected = currentExpected(root, true)
    await fs.remove(join(root, '.ccg', 'tasks', 'parent-task'))
    expectFailure(
      runController(root, 'finish', { expected, status: 'completed', restorePreviousTask: false }),
      'TASK_NOT_FOUND'
    )
    expect((await fs.readJson(join(root, '.ccg', 'tasks', 'child-task', 'task.json'))).status).toBe('open')
  })

  it('rejects stale revisions when finishing without returning', async () => {
    const root = await finishFixture()
    const expected = currentExpected(root, true)
    expectFailure(
      runController(root, 'finish', {
        expected: { ...expected, taskRevision: 2 },
        status: 'cancelled',
        restorePreviousTask: false,
      }),
      'TASK_REVISION_CONFLICT'
    )
    expect(currentExpected(root, true)).toEqual(expected)
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
          bindingRevision: current.bindingRevision,
          activeTaskId: current.activeTaskId,
          taskRevision: current.taskRevision,
        },
      })
    )
    expect((recovered.binding as BindingValue).activeTaskId).toBe('parent-task')
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
          bindingRevision: current.bindingRevision,
          activeTaskId: current.activeTaskId,
        },
      })
    )
    expect(recovered).toMatchObject({ task: null, recoveredReason: 'ACTIVE_TASK_MISSING' })
    expect((recovered.binding as BindingValue).activeTaskId).toBeNull()
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
    expect(results.filter((result) => result.output.code === 'TASK_REVISION_CONFLICT')).toHaveLength(1)
    expect(resolve(root).taskRevision as number).toBe(2)
  })

  it('applies a checkpoint once after delayed nonblocking stdin and preserves stale CAS rejection', async () => {
    const root = await createProject()
    startTask(root, 'segmented-checkpoint-task')
    const request = {
      expected: currentExpected(root, true),
      currentPhase: 'implementation',
      nextAction: 'Continue after segmented input',
      gate: null,
      progress: '# Progress\n\n分段读取完成\n',
    }
    const result = expectSuccess(await asyncController(root, 'checkpoint', request, true))
    expect(result.task).toMatchObject({ revision: 2, currentPhase: 'implementation' })
    expect(await fs.readFile(join(root, '.ccg', 'tasks', 'segmented-checkpoint-task', 'progress.md'), 'utf-8')).toBe(
      request.progress
    )
    expectFailure(runController(root, 'checkpoint', request), 'TASK_REVISION_CONFLICT')
    expect(resolve(root).taskRevision).toBe(2)
  })

  it('counts UTF-8 requirements and the final newline within the 8 KiB budget', async () => {
    const root = await createProject()
    const exact = `${'界'.repeat(2730)}a`
    expect(Buffer.byteLength(exact, 'utf-8')).toBe(8191)
    const rejected = runController(root, 'start', {
      expected: { stateId: null, stateRevision: 0, bindingRevision: 0, activeTaskId: null },
      mode: 'activate',
      task: taskInput('budget-task'),
      requirements: `${exact}b`,
    })
    expectFailure(rejected, 'INVALID_REQUEST')
    expect(await fs.pathExists(join(root, '.ccg', 'state.json'))).toBe(false)
    startTask(root, 'budget-task')
    const updated = expectSuccess(
      runController(root, 'update-requirements', {
        expected: currentExpected(root, true),
        content: exact,
      })
    )
    const requirements = await fs.readFile(join(root, '.ccg', 'tasks', 'budget-task', 'requirements.md'), 'utf-8')
    expect(Buffer.byteLength(requirements, 'utf-8')).toBe(8192)
    expect(requirements).toBe(`${exact}\n`)
    const snapshot = expectSuccess(runController(root, 'snapshot', undefined, ['--mode', 'authority', '--role', 'all']))
    expect(snapshot.kind).toBe('ok')
    expectFailure(
      runController(root, 'update-requirements', {
        expected: currentExpected(root, true),
        content: `${exact}b`,
      }),
      'INVALID_REQUEST'
    )
    expect(resolve(root).taskRevision).toBe((updated.task as TaskValue).revision)
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
})
