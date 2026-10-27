import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import fs from 'fs-extra'
import { describe, expect, it } from 'vitest'
import {
  cleanupPaths,
  DEFAULT_SESSION_KEY,
  createProject,
  runController,
  runHook,
  expectSuccess,
  expectFailure,
  resolve,
  taskInput,
  startTask,
  hookOutput,
} from './task-state-fixtures'
import type { JsonObject, TaskValue } from './task-state-fixtures'

async function interruptCheckpoint(root: string) {
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
  return { task, progressPath }
}

describe('persistent task state controller', () => {
  it('recovers an interrupted multi-file task transaction before allowing more mutations', async () => {
    const root = await createProject()
    const { task, progressPath } = await interruptCheckpoint(root)

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
          bindingRevision: current.bindingRevision,
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
          bindingRevision: current.bindingRevision,
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

  it('recovers a start transaction before state.json has been created', async () => {
    const root = await createProject()
    startTask(root, 'start-recovery-task')
    const taskDir = join(root, '.ccg', 'tasks', 'start-recovery-task')
    const stateContent = await fs.readFile(join(root, '.ccg', 'state.json'), 'utf-8')
    const bindingContent = await fs.readFile(join(root, '.ccg', 'sessions', `${DEFAULT_SESSION_KEY}.json`), 'utf-8')
    const taskContent = await fs.readFile(join(taskDir, 'task.json'), 'utf-8')
    const requirements = await fs.readFile(join(taskDir, 'requirements.md'), 'utf-8')
    const progress = await fs.readFile(join(taskDir, 'progress.md'), 'utf-8')

    await fs.remove(join(root, '.ccg'))
    await fs.ensureDir(join(root, '.ccg'))
    await fs.writeJson(join(root, '.ccg', 'transaction.json'), {
      schemaVersion: 1,
      transactionId: randomUUID(),
      operation: 'start',
      taskId: 'start-recovery-task',
      sessionKey: DEFAULT_SESSION_KEY,
      createdAt: new Date().toISOString(),
      writes: [
        { path: '.ccg/tasks/start-recovery-task/requirements.md', content: requirements },
        { path: '.ccg/tasks/start-recovery-task/progress.md', content: progress },
        { path: '.ccg/tasks/start-recovery-task/task.json', content: taskContent },
        { path: '.ccg/state.json', content: stateContent },
        { path: `.ccg/sessions/${DEFAULT_SESSION_KEY}.json`, content: bindingContent },
      ],
    })

    const current = resolve(root)
    expect(current).toMatchObject({
      kind: 'recovery-required',
      reasonCode: 'INCOMPLETE_TRANSACTION',
      stateId: null,
      stateRevision: 0,
      bindingRevision: 0,
    })
    const recovered = expectSuccess(
      runController(root, 'recover', {
        expected: {
          stateId: null,
          stateRevision: 0,
          bindingRevision: 0,
          activeTaskId: null,
        },
      })
    )
    expect(recovered).toMatchObject({
      recoveredReason: 'INCOMPLETE_TRANSACTION',
      resumedTaskId: 'start-recovery-task',
    })
    expect(resolve(root)).toMatchObject({ kind: 'active', activeTaskId: 'start-recovery-task' })
  })

  it('allows task migration in a project that is not inside a Git worktree', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'ccg-non-git-task-state-'))
    cleanupPaths.add(root)
    await fs.writeJson(join(root, 'package.json'), { name: 'non-git-fixture', private: true })
    const orphanDir = join(root, '.ccg', 'tasks', 'historical-export')
    await fs.ensureDir(orphanDir)
    await fs.writeFile(join(orphanDir, 'payload.bin'), 'preserve\n')

    const quarantined = expectSuccess(
      runController(root, 'quarantine-orphans', {
        expected: { stateId: null, stateRevision: 0, bindingRevision: 0, activeTaskId: null },
      })
    )

    expect(quarantined.quarantined).toEqual(['historical-export'])
    expect(await fs.pathExists(orphanDir)).toBe(false)
    expect(
      await fs.pathExists(join(root, '.ccg', 'historical-artifacts', 'orphans', 'historical-export', 'payload.bin'))
    ).toBe(true)
  })

  it('preserves an oversized Git exclude file instead of replacing it with truncated content', async () => {
    const root = await createProject()
    const excludePath = join(root, '.git', 'info', 'exclude')
    const original = `# LARGE_EXCLUDE_SENTINEL\n${'/generated-*\n'.repeat(24_000)}`
    await fs.writeFile(excludePath, original)

    expectFailure(
      runController(root, 'start', {
        expected: { stateId: null, stateRevision: 0, bindingRevision: 0, activeTaskId: null },
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
