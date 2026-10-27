import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import fs from 'fs-extra'
import { describe, expect, it } from 'vitest'
import {
  createProject,
  runController,
  expectSuccess,
  expectFailure,
  resolve,
  currentExpected,
  startTask,
  finishActive,
} from './task-state-fixtures'
import type { JsonObject, StateValue, TaskValue } from './task-state-fixtures'

describe('session-scoped bindings and safe migrations', () => {
  it('migrates state schema v1 without assigning its legacy pointer to a session', async () => {
    const root = await createProject()
    startTask(root, 'legacy-pointer-task')
    const currentState = (await fs.readJson(join(root, '.ccg', 'state.json'))) as StateValue
    await fs.remove(join(root, '.ccg', 'sessions'))
    const legacyState = `${JSON.stringify(
      {
        schemaVersion: 1,
        stateId: currentState.stateId,
        revision: currentState.revision,
        activeTaskId: 'legacy-pointer-task',
        updatedAt: new Date().toISOString(),
      },
      null,
      4
    )}\n`
    await fs.writeFile(join(root, '.ccg', 'state.json'), legacyState)

    const migration = resolve(root)
    expect(migration).toMatchObject({
      kind: 'migration-required',
      code: 'STATE_MIGRATION_REQUIRED',
      legacyActiveTaskId: 'legacy-pointer-task',
      activeTaskId: null,
    })
    const migrated = expectSuccess(
      runController(root, 'migrate-state', {
        expected: {
          stateId: migration.stateId,
          stateRevision: migration.stateRevision,
          bindingRevision: 0,
          activeTaskId: null,
          legacyActiveTaskId: 'legacy-pointer-task',
        },
      })
    )
    expect(migrated).toMatchObject({ changed: true, legacyActiveTaskId: 'legacy-pointer-task' })
    const state = await fs.readJson(join(root, '.ccg', 'state.json'))
    expect(state).toMatchObject({ schemaVersion: 2, stateId: currentState.stateId })
    expect(state).not.toHaveProperty('activeTaskId')
    expect(await fs.readFile(join(root, '.ccg', 'migrations', 'state-v2', 'state.json'), 'utf-8')).toBe(legacyState)
    expect(resolve(root)).toMatchObject({ kind: 'selection-required', activeTaskId: null })
  })

  it('repairs a schema v1 canonical in_progress task back to durable open', async () => {
    const root = await createProject()
    startTask(root, 'legacy-shape-task')
    const statePath = join(root, '.ccg', 'state.json')
    const state = await fs.readJson(statePath)
    await fs.remove(join(root, '.ccg', 'sessions'))
    await fs.writeJson(statePath, {
      schemaVersion: 1,
      stateId: state.stateId,
      revision: state.revision,
      activeTaskId: 'legacy-shape-task',
      updatedAt: new Date().toISOString(),
    })
    const taskPath = join(root, '.ccg', 'tasks', 'legacy-shape-task', 'task.json')
    const task = await fs.readJson(taskPath)
    task.status = 'in_progress'
    task.revision = 2
    await fs.writeJson(taskPath, task)

    const migration = resolve(root)
    const repaired = expectSuccess(
      runController(root, 'repair-status', {
        expected: {
          stateId: migration.stateId,
          stateRevision: migration.stateRevision,
          bindingRevision: 0,
          activeTaskId: null,
          legacyActiveTaskId: 'legacy-shape-task',
          taskRevision: 2,
        },
        taskId: 'legacy-shape-task',
        repair: 'canonical-in-progress',
      })
    )
    expect(repaired.task).toMatchObject({ status: 'open', revision: 3, finishedAt: null })
    expect((await fs.readJson(taskPath)).status).toBe('open')
  })

  it('repairs completed to cancelled only with a superseded migration backup', async () => {
    const root = await createProject()
    startTask(root, 'superseded-task')
    const finished = finishActive(root)
    const taskBefore = finished.task as TaskValue & JsonObject
    const finishedAt = taskBefore.finishedAt
    const backupDir = join(root, '.ccg', 'migrations', 'v1', 'superseded-task')
    await fs.ensureDir(backupDir)
    await fs.writeJson(join(backupDir, 'task.json'), { id: 'superseded-task', status: 'superseded' })

    const expected = { ...currentExpected(root), taskRevision: taskBefore.revision }
    const repaired = expectSuccess(
      runController(root, 'repair-status', {
        expected,
        taskId: 'superseded-task',
        repair: 'superseded-completed',
      })
    )
    expect(repaired.task).toMatchObject({ status: 'cancelled', revision: taskBefore.revision + 1, finishedAt })
  })

  it('rejects superseded repair evidence that names another task', async () => {
    const root = await createProject()
    startTask(root, 'evidence-target')
    const finished = finishActive(root)
    const taskBefore = finished.task as TaskValue & JsonObject
    const backupDir = join(root, '.ccg', 'migrations', 'v1', 'evidence-target')
    await fs.ensureDir(backupDir)
    await fs.writeJson(join(backupDir, 'task.json'), { id: 'different-task', status: 'superseded' })

    expectFailure(
      runController(root, 'repair-status', {
        expected: { ...currentExpected(root), taskRevision: taskBefore.revision },
        taskId: 'evidence-target',
        repair: 'superseded-completed',
      }),
      'STATUS_REPAIR_EVIDENCE_MISSING'
    )
    expect(await fs.readJson(join(root, '.ccg', 'tasks', 'evidence-target', 'task.json'))).toMatchObject({
      status: 'completed',
      revision: taskBefore.revision,
    })
  })

  it('maps unfinished legacy statuses to open and deleted or superseded to cancelled', async () => {
    const root = await createProject()
    const fixtures = [
      ['unfinished-task', 'in_progress'],
      ['deleted-task', 'deleted'],
      ['superseded-task', 'superseded'],
    ] as const
    let originalTask = ''
    for (const [id, status] of fixtures) {
      const taskDir = join(root, '.ccg', 'tasks', id)
      await fs.ensureDir(taskDir)
      const source = `{\n  "id": "${id}",\n  "title": "${id}",\n  "status": "${status}"\n}\n`
      await fs.writeFile(join(taskDir, 'task.json'), source)
      if (id === 'unfinished-task') originalTask = source
    }

    const migrated = expectSuccess(
      runController(root, 'migrate-legacy', {
        expected: { stateId: null, stateRevision: 0, bindingRevision: 0, activeTaskId: null },
      })
    )
    expect(migrated.migratedTaskIds).toEqual(fixtures.map(([id]) => id).sort())
    expect((await fs.readJson(join(root, '.ccg', 'tasks', 'unfinished-task', 'task.json'))).status).toBe('open')
    expect((await fs.readJson(join(root, '.ccg', 'tasks', 'deleted-task', 'task.json'))).status).toBe('cancelled')
    expect((await fs.readJson(join(root, '.ccg', 'tasks', 'superseded-task', 'task.json'))).status).toBe('cancelled')
    expect(await fs.readFile(join(root, '.ccg', 'migrations', 'v1', 'unfinished-task', 'task.json'), 'utf-8')).toBe(
      originalTask
    )
  })

  it('truncates multibyte legacy metadata by UTF-8 bytes', async () => {
    const root = await createProject()
    const taskDir = join(root, '.ccg', 'tasks', 'multibyte-legacy-task')
    await fs.ensureDir(taskDir)
    const repeated = '任'.repeat(1200)
    await fs.writeJson(join(taskDir, 'task.json'), {
      id: 'multibyte-legacy-task',
      title: repeated,
      status: 'active',
      strategy: repeated,
      domain: repeated,
      scope: repeated,
      currentPhase: repeated,
      nextAction: repeated,
      gate: repeated,
      branchAtCreation: repeated,
    })

    expectSuccess(
      runController(root, 'migrate-legacy', {
        expected: { stateId: null, stateRevision: 0, bindingRevision: 0, activeTaskId: null },
      })
    )
    const task = await fs.readJson(join(taskDir, 'task.json'))
    for (const [field, maxBytes] of [
      ['title', 240],
      ['strategy', 80],
      ['domain', 64],
      ['scope', 1024],
      ['currentPhase', 64],
      ['nextAction', 1024],
      ['gate', 256],
      ['branchAtCreation', 512],
    ] as const) {
      expect(Buffer.byteLength(task[field], 'utf-8')).toBeLessThanOrEqual(maxBytes)
      expect(task[field]).not.toContain('�')
    }
    expect(task).toMatchObject({ schemaVersion: 1, status: 'open' })
  })

  it('refuses to overwrite or reuse a mismatched legacy migration backup', async () => {
    const root = await createProject()
    const taskDir = join(root, '.ccg', 'tasks', 'backup-conflict-task')
    const source = '{"id":"backup-conflict-task","title":"Source","status":"active"}\n'
    await fs.ensureDir(taskDir)
    await fs.writeFile(join(taskDir, 'task.json'), source)
    const backupDir = join(root, '.ccg', 'migrations', 'v1', 'backup-conflict-task')
    await fs.ensureDir(backupDir)
    await fs.writeFile(join(backupDir, 'task.json'), source.replace('Source', 'Stale!'))

    expectFailure(
      runController(root, 'migrate-legacy', {
        expected: { stateId: null, stateRevision: 0, bindingRevision: 0, activeTaskId: null },
      }),
      'MIGRATION_BACKUP_CONFLICT'
    )
    expect(await fs.readFile(join(taskDir, 'task.json'), 'utf-8')).toBe(source)
  })

  it('resumes the legacy migration state transition without incrementing it twice', async () => {
    const root = await createProject()
    const stateId = randomUUID()
    const targetState = {
      schemaVersion: 2,
      stateId,
      revision: 2,
      updatedAt: new Date().toISOString(),
    }
    await fs.ensureDir(join(root, '.ccg', 'migrations', 'v1'))
    await fs.writeJson(join(root, '.ccg', 'state.json'), targetState)
    await fs.writeJson(join(root, '.ccg', 'migrations', 'v1', 'manifest.json'), {
      schemaVersion: 1,
      migrationId: randomUUID(),
      status: 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      stateApplied: false,
      stateTransition: {
        sourceExists: true,
        sourceStateId: stateId,
        sourceStateRevision: 1,
        targetState,
      },
      tasks: [],
    })

    const migrated = expectSuccess(
      runController(root, 'migrate-legacy', {
        expected: { stateId, stateRevision: 2, bindingRevision: 0, activeTaskId: null },
      })
    )
    expect((migrated.state as StateValue).revision).toBe(2)
    expect((await fs.readJson(join(root, '.ccg', 'state.json'))).revision).toBe(2)
    expect(await fs.readJson(join(root, '.ccg', 'migrations', 'v1', 'manifest.json'))).toMatchObject({
      status: 'applied',
      stateApplied: true,
      stateRevision: 2,
    })
  })

  it('backs up an invalid legacy contract before refusing to replace it', async () => {
    const root = await createProject()
    const taskDir = join(root, '.ccg', 'tasks', 'oversized-contract-task')
    await fs.ensureDir(taskDir)
    await fs.writeJson(join(taskDir, 'task.json'), {
      id: 'oversized-contract-task',
      title: 'Oversized contract task',
      status: 'active',
    })
    const oversized = `# Requirements\n\n${'x'.repeat(9 * 1024)}\n`
    await fs.writeFile(join(taskDir, 'requirements.md'), oversized)

    expectFailure(
      runController(root, 'migrate-legacy', {
        expected: { stateId: null, stateRevision: 0, bindingRevision: 0, activeTaskId: null },
      }),
      'TASK_CONTRACT_INVALID'
    )
    expect(
      await fs.readFile(join(root, '.ccg', 'migrations', 'v1', 'oversized-contract-task', 'requirements.md'), 'utf-8')
    ).toBe(oversized)
    expect((await fs.readJson(join(taskDir, 'task.json'))).schemaVersion).toBeUndefined()
  })

  it('quarantines and restores an orphan directory by rename without inventing task state', async () => {
    const root = await createProject()
    const name = 'user_messages_extract_history_search.json'
    const orphanDir = join(root, '.ccg', 'tasks', name)
    const payloadPath = join(orphanDir, 'history.bin')
    await fs.ensureDir(orphanDir)
    await fs.writeFile(payloadPath, Buffer.alloc(2 * 1024 * 1024, 7))

    const quarantined = expectSuccess(
      runController(root, 'quarantine-orphans', {
        expected: { stateId: null, stateRevision: 0, bindingRevision: 0, activeTaskId: null },
      })
    )
    expect(quarantined.quarantined).toEqual([name])
    const targetDir = join(root, '.ccg', 'historical-artifacts', 'orphans', name)
    expect(await fs.pathExists(orphanDir)).toBe(false)
    expect((await fs.stat(join(targetDir, 'history.bin'))).size).toBe(2 * 1024 * 1024)
    expect(await fs.pathExists(join(targetDir, 'task.json'))).toBe(false)

    const restored = expectSuccess(
      runController(root, 'restore-orphans', {
        expected: currentExpected(root),
        names: [name],
      })
    )
    expect(restored.restored).toEqual([name])
    expect(await fs.pathExists(orphanDir)).toBe(true)
    expect(await fs.pathExists(targetDir)).toBe(false)
    expect(
      expectSuccess(
        runController(root, 'restore-orphans', {
          expected: currentExpected(root),
          names: [name],
        })
      )
    ).toMatchObject({ changed: false, restored: [] })

    const requarantined = expectSuccess(
      runController(root, 'quarantine-orphans', {
        expected: currentExpected(root),
      })
    )
    expect(requarantined.quarantined).toEqual([name])
    expect(await fs.pathExists(orphanDir)).toBe(false)
    expect(await fs.pathExists(targetDir)).toBe(true)
  })

  it('rejects orphan manifest entries whose paths do not match their names', async () => {
    const root = await createProject()
    const orphanDir = join(root, '.ccg', 'tasks', 'safe-orphan')
    await fs.ensureDir(orphanDir)
    await fs.ensureDir(join(root, '.ccg', 'historical-artifacts', 'orphans'))
    const now = new Date().toISOString()
    await fs.writeJson(join(root, '.ccg', 'historical-artifacts', 'orphans', 'manifest.json'), {
      schemaVersion: 1,
      stateApplied: true,
      stateTransition: null,
      createdAt: now,
      updatedAt: now,
      entries: [
        {
          name: 'safe-orphan',
          source: '.ccg/tasks/another-directory',
          target: '.ccg/historical-artifacts/orphans/safe-orphan',
          status: 'pending',
        },
      ],
    })

    expectFailure(
      runController(root, 'quarantine-orphans', {
        expected: { stateId: null, stateRevision: 0, bindingRevision: 0, activeTaskId: null },
      }),
      'MIGRATION_MANIFEST_INVALID'
    )
    expect(await fs.pathExists(orphanDir)).toBe(true)
  })

  it('resumes orphan restoration after the directory rename', async () => {
    const root = await createProject()
    const name = 'interrupted-orphan'
    const orphanDir = join(root, '.ccg', 'tasks', name)
    const targetDir = join(root, '.ccg', 'historical-artifacts', 'orphans', name)
    await fs.ensureDir(orphanDir)
    await fs.writeFile(join(orphanDir, 'payload.txt'), 'preserve\n')
    expectSuccess(
      runController(root, 'quarantine-orphans', {
        expected: { stateId: null, stateRevision: 0, bindingRevision: 0, activeTaskId: null },
      })
    )

    const manifestPath = join(root, '.ccg', 'historical-artifacts', 'orphans', 'manifest.json')
    const manifest = await fs.readJson(manifestPath)
    manifest.stateApplied = false
    manifest.stateTransition = null
    manifest.updatedAt = new Date().toISOString()
    await fs.writeJson(manifestPath, manifest)
    await fs.rename(targetDir, orphanDir)

    const before = resolve(root)
    const restored = expectSuccess(
      runController(root, 'restore-orphans', {
        expected: {
          stateId: before.stateId,
          stateRevision: before.stateRevision,
          bindingRevision: before.bindingRevision,
          activeTaskId: before.activeTaskId,
        },
        names: [name],
      })
    )
    expect(restored).toMatchObject({ changed: true, restored: [name] })
    expect(await fs.readFile(join(orphanDir, 'payload.txt'), 'utf-8')).toBe('preserve\n')
    expect(await fs.pathExists(targetDir)).toBe(false)
    expect(await fs.readJson(manifestPath)).toMatchObject({ stateApplied: true })
  })
})
