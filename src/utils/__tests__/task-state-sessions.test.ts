import { join } from 'node:path'
import fs from 'fs-extra'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SESSION_ID,
  deriveSessionKey,
  DEFAULT_SESSION_KEY,
  createProject,
  runController,
  runHook,
  expectSuccess,
  expectFailure,
  resolve,
  currentExpected,
  startTask,
  hookOutput,
} from './task-state-fixtures'
import type { JsonObject } from './task-state-fixtures'

function expectSessionTaskContext(root: string, sessionId: string, activeTask: string, otherTask: string): void {
  const output = hookOutput(runHook(root, 'session-start.js', { cwd: root, source: 'resume', session_id: sessionId }))
  expect(output.additionalContext).toContain(`Complete ${activeTask}`)
  expect(output.additionalContext).not.toContain(`Complete ${otherTask}`)
}

function activateSessionTask(root: string, taskId: string, sessionKey: string): void {
  expectSuccess(
    runController(
      root,
      'activate',
      { expected: { ...currentExpected(root, false, sessionKey), taskRevision: 1 }, taskId },
      [],
      sessionKey
    )
  )
}

describe('explicit task record observations', () => {
  it('uses task revisions, ignores legacy telemetry, and reports observations without stopping work', async () => {
    const root = await createProject()
    startTask(root, 'observation-task')
    const turnsDir = join(root, '.ccg', 'tasks', 'observation-task', '.turns')
    const turnsPath = join(turnsDir, `${DEFAULT_SESSION_KEY}.json`)
    await fs.ensureDir(turnsDir)
    await fs.writeJson(
      turnsPath,
      Array.from({ length: 3 }, () => ({ phase: '1-requirements', next: 'Continue observation-task' }))
    )
    const record = (): JsonObject =>
      expectSuccess(runController(root, 'record-turn', { expected: currentExpected(root, true) }))
    expect(record().loop).toBeNull()
    expect(record().loop).toBeNull()
    const observed = record()
    expect(observed.loop).toMatchObject({ kind: 'unchanged_task_records', count: 3 })
    expect(observed.observation).toContain('unchanged records do not prove that work has stalled')

    const stale = currentExpected(root, true)
    expectSuccess(
      runController(root, 'write-artifact', {
        expected: stale,
        kind: 'research',
        name: 'progress.md',
        content: '# Research\n\nNew evidence in the same phase\n',
      })
    )
    expect(record().loop).toBeNull()
    expectFailure(runController(root, 'record-turn', { expected: stale }), 'TASK_REVISION_CONFLICT')
    const before = await fs.readFile(turnsPath, 'utf-8')
    const otherSession = deriveSessionKey('claude', 'observation-other-session')
    expectFailure(
      runController(
        root,
        'record-turn',
        {
          expected: { ...currentExpected(root, false, otherSession), taskRevision: 2 },
        },
        [],
        otherSession
      ),
      'SELECTION_REQUIRED'
    )
    expect(await fs.readFile(turnsPath, 'utf-8')).toBe(before)
  })

  it('reports corrupt explicit telemetry without overwriting it during prompt refresh', async () => {
    const root = await createProject()
    startTask(root, 'corrupt-observation-task')
    const turnsDir = join(root, '.ccg', 'tasks', 'corrupt-observation-task', '.turns')
    const turnsPath = join(turnsDir, `${DEFAULT_SESSION_KEY}.json`)
    await fs.ensureDir(turnsDir)
    await fs.writeFile(turnsPath, '{broken')
    expectFailure(runController(root, 'record-turn', { expected: currentExpected(root, true) }), 'TURN_STATE_INVALID')
    const output = hookOutput(runHook(root, 'workflow-state.js', { cwd: root, prompt: 'Continue' }))
    expect(output.additionalContext).not.toContain('Loop:')
    expect(await fs.readFile(turnsPath, 'utf-8')).toBe('{broken')
  })
})

describe('session-scoped bindings and safe migrations', () => {
  it('keeps two sessions on separate tasks without cross-injecting task contracts', async () => {
    const root = await createProject()
    const sessionBId = 'claude-session-b'
    const sessionBKey = deriveSessionKey('claude', sessionBId)
    startTask(root, 'session-a-task')
    startTask(root, 'session-b-task', 'inactive', {}, sessionBKey)

    const beforeActivation = resolve(root, sessionBKey)
    expect(beforeActivation).toMatchObject({ kind: 'selection-required', bindingRevision: 0 })
    activateSessionTask(root, 'session-b-task', sessionBKey)

    expect(resolve(root)).toMatchObject({
      kind: 'active',
      activeTaskId: 'session-a-task',
      effectiveStatus: 'in_progress',
    })
    expect(resolve(root, sessionBKey)).toMatchObject({
      kind: 'active',
      activeTaskId: 'session-b-task',
      effectiveStatus: 'in_progress',
    })
    for (const id of ['session-a-task', 'session-b-task']) {
      expect((await fs.readJson(join(root, '.ccg', 'tasks', id, 'task.json'))).status).toBe('open')
    }

    const listed = expectSuccess(runController(root, 'list'))
    expect(listed.tasks).toContainEqual({
      id: 'session-b-task',
      title: 'Task session-b-task',
      revision: 1,
      status: 'open',
      effectiveStatus: 'suspended',
      claimed: true,
    })
    expect(JSON.stringify(listed)).not.toContain('Complete session-b-task')

    expectSessionTaskContext(root, DEFAULT_SESSION_ID, 'session-a-task', 'session-b-task')
    expectSessionTaskContext(root, sessionBId, 'session-b-task', 'session-a-task')

    const agentA = hookOutput(
      runHook(root, 'subagent-context.js', {
        cwd: root,
        session_id: DEFAULT_SESSION_ID,
        tool_name: 'Agent',
        tool_input: { name: 'implementer', prompt: 'Implement A' },
      })
    )
    expect((agentA.updatedInput as JsonObject).prompt).toContain('Complete session-a-task')
    expect((agentA.updatedInput as JsonObject).prompt).not.toContain('Complete session-b-task')
  })

  it('rejects a claimed task until an explicit takeover transfers the binding', async () => {
    const root = await createProject()
    const sessionBKey = deriveSessionKey('claude', 'takeover-session-b')
    startTask(root, 'claimed-task')
    const stateRevision = resolve(root).stateRevision
    const expectedB = { ...currentExpected(root, false, sessionBKey), taskRevision: 1 }
    const selection = hookOutput(
      runHook(root, 'session-start.js', {
        cwd: root,
        source: 'startup',
        session_id: 'takeover-session-b',
      })
    )
    expect(selection.additionalContext).toContain('claimed=true')
    expect(selection.additionalContext).not.toContain('Complete claimed-task')

    expectFailure(
      runController(root, 'activate', { expected: expectedB, taskId: 'claimed-task' }, [], sessionBKey),
      'TASK_CLAIMED'
    )
    const takeover = expectSuccess(
      runController(root, 'takeover', { expected: expectedB, taskId: 'claimed-task' }, [], sessionBKey)
    )
    expect(takeover).toMatchObject({ changed: true, transferredBindings: 1, effectiveStatus: 'in_progress' })
    expect(resolve(root, sessionBKey)).toMatchObject({ kind: 'active', activeTaskId: 'claimed-task' })
    expect(resolve(root)).toMatchObject({ kind: 'selection-required', activeTaskId: null })
    expect(resolve(root).stateRevision).toBe(stateRevision)

    expectFailure(
      runController(root, 'activate', { expected: expectedB, taskId: 'claimed-task' }, [], sessionBKey),
      'BINDING_REVISION_CONFLICT'
    )
  })

  it('claims a task together with its open return chain during activation and takeover', async () => {
    const root = await createProject()
    const sessionBKey = deriveSessionKey('claude', 'return-chain-session-b')
    const sessionCKey = deriveSessionKey('claude', 'return-chain-session-c')
    startTask(root, 'return-parent')
    startTask(root, 'return-child', 'interrupt')
    startTask(root, 'replacement-task', 'replace')

    const parentForB = resolve(root, sessionBKey)
    expectSuccess(
      runController(
        root,
        'activate',
        {
          expected: { ...currentExpected(root, false, sessionBKey), taskRevision: 1 },
          taskId: 'return-parent',
        },
        [],
        sessionBKey
      )
    )

    const childForC = resolve(root, sessionCKey)
    expect(childForC.candidates).toContainEqual({
      id: 'return-child',
      title: 'Task return-child',
      revision: 1,
      status: 'open',
      claimed: true,
    })
    const expectedC = { ...currentExpected(root, false, sessionCKey), taskRevision: 1 }
    expectFailure(
      runController(root, 'activate', { expected: expectedC, taskId: 'return-child' }, [], sessionCKey),
      'TASK_CLAIMED'
    )

    const takeover = expectSuccess(
      runController(root, 'takeover', { expected: expectedC, taskId: 'return-child' }, [], sessionCKey)
    )
    expect(takeover).toMatchObject({ changed: true, transferredBindings: 1 })
    expect(resolve(root, sessionCKey)).toMatchObject({ kind: 'active', activeTaskId: 'return-child' })
    expect(resolve(root, sessionBKey)).toMatchObject({ kind: 'selection-required', activeTaskId: null })
    expect(resolve(root)).toMatchObject({ kind: 'active', activeTaskId: 'replacement-task' })
    expect(parentForB.stateRevision).toBe(resolve(root, sessionCKey).stateRevision)
  })

  it('exports an opaque session key and never stores the raw Hook session id', async () => {
    const root = await createProject()
    startTask(root, 'opaque-session-task')
    const envFile = join(root, 'claude-env.sh')
    await fs.writeFile(envFile, '')

    const output = hookOutput(
      runHook(
        root,
        'session-start.js',
        { cwd: root, source: 'startup', session_id: DEFAULT_SESSION_ID },
        { CLAUDE_ENV_FILE: envFile }
      )
    )
    const envContent = await fs.readFile(envFile, 'utf-8')
    expect(envContent).toBe(`export CCG_SESSION_KEY='${DEFAULT_SESSION_KEY}'\n`)
    expect(envContent).not.toContain(DEFAULT_SESSION_ID)
    expect(JSON.stringify(output)).not.toContain(DEFAULT_SESSION_ID)

    hookOutput(
      runHook(root, 'workflow-state.js', {
        cwd: root,
        hook_event_name: 'UserPromptSubmit',
        session_id: DEFAULT_SESSION_ID,
        prompt: 'Continue',
      })
    )
    expect(await fs.pathExists(join(root, '.ccg', 'tasks', 'opaque-session-task', '.turns'))).toBe(false)
    expectSuccess(runController(root, 'record-turn', { expected: currentExpected(root, true) }))
    const sessionFiles = await fs.readdir(join(root, '.ccg', 'sessions'))
    const turnFiles = await fs.readdir(join(root, '.ccg', 'tasks', 'opaque-session-task', '.turns'))
    expect(sessionFiles).toEqual([`${DEFAULT_SESSION_KEY}.json`])
    expect(turnFiles).toEqual([`${DEFAULT_SESSION_KEY}.json`])
    expect(sessionFiles.join('\n')).not.toContain(DEFAULT_SESSION_ID)
    expect(turnFiles.join('\n')).not.toContain(DEFAULT_SESSION_ID)
  })

  it('refuses a symlinked Claude environment file without modifying its target', async () => {
    const root = await createProject()
    const target = join(root, 'env-target.sh')
    const envFile = join(root, 'claude-env.sh')
    await fs.writeFile(target, 'preserve\n')
    await fs.symlink(target, envFile)

    const output = hookOutput(
      runHook(
        root,
        'session-start.js',
        { cwd: root, source: 'startup', session_id: DEFAULT_SESSION_ID },
        { CLAUDE_ENV_FILE: envFile }
      )
    )

    expect(output.additionalContext).toContain('CLAUDE_ENV_FILE_INVALID')
    expect(await fs.readFile(target, 'utf-8')).toBe('preserve\n')
  })
})
