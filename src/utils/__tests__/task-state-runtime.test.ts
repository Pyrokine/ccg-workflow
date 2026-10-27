import { randomUUID } from 'node:crypto'
import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import fs from 'fs-extra'
import { describe, expect, it } from 'vitest'
import {
  cleanupPaths,
  git,
  createProject,
  runController,
  runHook,
  expectSuccess,
  expectFailure,
  resolve,
  currentExpected,
  taskInput,
  startTask,
  hookOutput,
} from './task-state-fixtures'
import type { TaskValue } from './task-state-fixtures'

async function createLegacyTask(root: string) {
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
  return legacyDir
}

describe('persistent task state controller', () => {
  it('migrates legacy tasks without assigning them to a session', async () => {
    const root = await createProject()
    const legacyDir = await createLegacyTask(root)

    expect(resolve(root)).toMatchObject({ kind: 'migration-required', code: 'TASK_MIGRATION_REQUIRED' })
    const preflight = expectSuccess(runController(root, 'preflight-legacy'))
    expect(preflight).toMatchObject({ migrationRequired: true, blockedTaskIds: [] })

    const migrated = expectSuccess(
      runController(root, 'migrate-legacy', {
        expected: { stateId: null, stateRevision: 0, bindingRevision: 0, activeTaskId: null },
      })
    )
    expect(migrated.binding).toMatchObject({ revision: 0, activeTaskId: null })
    expect(resolve(root)).toMatchObject({ kind: 'selection-required', activeTaskId: null })
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

  it('requires migration for terminal legacy tasks even when no state file exists', async () => {
    const root = await createProject()
    const legacyDir = join(root, '.ccg', 'tasks', 'terminal-legacy-task')
    await fs.ensureDir(legacyDir)
    await fs.writeJson(join(legacyDir, 'task.json'), {
      id: 'terminal-legacy-task',
      title: 'Terminal legacy task',
      status: 'completed',
      completedAt: new Date().toISOString(),
    })

    const current = resolve(root)
    expect(current).toMatchObject({
      kind: 'migration-required',
      code: 'TASK_MIGRATION_REQUIRED',
      candidates: [],
    })
    expectSuccess(
      runController(root, 'migrate-legacy', {
        expected: { stateId: null, stateRevision: 0, bindingRevision: 0, activeTaskId: null },
      })
    )
    expect(resolve(root)).toMatchObject({ kind: 'none' })
    expect(await fs.readJson(join(legacyDir, 'task.json'))).toMatchObject({
      schemaVersion: 1,
      status: 'completed',
    })
  })

  it('reports explicit task migration when legacy tasks coexist with state schema v2', async () => {
    const root = await createProject()
    const legacyDir = join(root, '.ccg', 'tasks', 'state-v2-legacy-task')
    await fs.ensureDir(legacyDir)
    await fs.writeJson(join(legacyDir, 'task.json'), {
      id: 'state-v2-legacy-task',
      title: 'State v2 legacy task',
      status: 'active',
    })
    await fs.writeJson(join(root, '.ccg', 'state.json'), {
      schemaVersion: 2,
      stateId: randomUUID(),
      revision: 1,
      updatedAt: new Date().toISOString(),
    })

    const current = resolve(root)
    expect(current).toMatchObject({
      kind: 'migration-required',
      code: 'TASK_MIGRATION_REQUIRED',
      activeTaskId: null,
    })
    expect(current.candidates).toEqual([
      {
        id: 'state-v2-legacy-task',
        title: 'State v2 legacy task',
        revision: 0,
        status: 'open',
        claimed: false,
      },
    ])

    expectSuccess(
      runController(root, 'migrate-legacy', {
        expected: {
          stateId: current.stateId,
          stateRevision: current.stateRevision,
          bindingRevision: 0,
          activeTaskId: null,
        },
      })
    )
    expect(resolve(root)).toMatchObject({ kind: 'selection-required' })
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
        expected: { stateId: null, stateRevision: 0, bindingRevision: 0, activeTaskId: null },
        mode: 'activate',
        task: taskInput('external-runtime-task'),
        requirements: '# Requirements\n',
      }),
      'PATH_INVALID'
    )
    expect(await fs.readdir(outside)).toEqual([])
  })

  it.each(['tasks', 'sessions'])('rejects a symlinked .ccg/%s runtime directory', async (directory) => {
    const root = await createProject()
    const outside = `${root}-${directory}-outside`
    cleanupPaths.add(outside)
    await fs.ensureDir(join(root, '.ccg'))
    await fs.ensureDir(outside)
    await fs.symlink(outside, join(root, '.ccg', directory))

    expectFailure(
      runController(root, 'start', {
        expected: { stateId: null, stateRevision: 0, bindingRevision: 0, activeTaskId: null },
        mode: 'activate',
        task: taskInput(`${directory}-symlink-task`),
        requirements: '# Requirements\n',
      }),
      directory === 'sessions' ? 'BINDING_PATH_INVALID' : 'PATH_INVALID'
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
        expected: { stateId: null, stateRevision: 0, bindingRevision: 0, activeTaskId: null },
        activeTaskId: 'legacy-symlink-task',
      }),
      'PATH_INVALID'
    )
    expect(await fs.readdir(migrationOutside)).toEqual([])
  })
})
