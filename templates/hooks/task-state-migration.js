'use strict';

const { fail, requireNullableTaskId, requireExpected, requireString } = require('./task-state-core.js');
const { withStateLock, writeState, ensureRuntimeDirectory } = require('./task-state-store.js');
const {
  ensureTaskRuntimeIgnored,
  assertStateReadable,
  assertExpectedState,
  makeState,
  assertExpectedBinding,
} = require('./task-state-model.js');
const {
  readState,
  atomicWriteJson,
  readBinding,
  getTaskPath,
  readJsonDetailed,
  isValidTaskId,
  validateCanonicalTask,
  readFileBounded,
  STATE_FILE_LIMIT,
  atomicWriteFile,
  TASK_SCHEMA_VERSION,
  normalizeLegacyTaskStatus,
} = require('./task-utils.js');
const { readManifest } = require('./task-state-manifest.js');
const path = require('path');
const fs = require('fs');

function requireLegacyActiveTaskExpectation(request, stateResult) {
  if (!stateResult.legacy) return;
  if (!Object.prototype.hasOwnProperty.call(request.expected || {}, 'legacyActiveTaskId')) {
    fail('INVALID_REQUEST', 'expected.legacyActiveTaskId is required for state schema v1');
  }
  const expected = requireNullableTaskId(request.expected.legacyActiveTaskId, 'expected.legacyActiveTaskId');
  if (expected !== stateResult.state.activeTaskId) {
    fail('ACTIVE_TASK_CONFLICT', 'Legacy active task changed', {
      stateId: stateResult.state.stateId,
      stateRevision: stateResult.state.revision,
      legacyActiveTaskId: stateResult.state.activeTaskId,
    });
  }
}

function operationMigrateState(projectRoot, request) {
  const expected = requireExpected(request, false);
  return withStateLock(projectRoot, () => {
    ensureTaskRuntimeIgnored(projectRoot);
    const stateResult = assertStateReadable(readState(projectRoot, { allowLegacy: true }));
    if (!stateResult.exists) fail('STATE_NOT_FOUND', 'state.json does not exist');
    assertExpectedState(stateResult, expected);
    if (!stateResult.legacy) {
      const existing = readManifest(projectRoot, '.ccg/migrations/state-v2/manifest.json');
      if (existing.manifest && existing.manifest.status === 'pending') {
        existing.manifest.status = 'applied';
        existing.manifest.updatedAt = new Date().toISOString();
        atomicWriteJson(existing.path, existing.manifest);
      }
      return { state: stateResult.state, legacyActiveTaskId: null, changed: false };
    }
    if (expected.bindingRevision !== 0 || expected.activeTaskId !== null) {
      fail('BINDING_REVISION_CONFLICT', 'State schema v1 cannot have a session binding');
    }
    requireLegacyActiveTaskExpectation(request, stateResult);
    const migrationDir = backupLegacyState(projectRoot, stateResult);
    const manifestPath = path.join(migrationDir, 'manifest.json');
    const now = new Date().toISOString();
    const manifest = {
      schemaVersion: 1,
      status: 'pending',
      stateId: stateResult.state.stateId,
      sourceRevision: stateResult.state.revision,
      legacyActiveTaskId: stateResult.state.activeTaskId,
      createdAt: now,
      updatedAt: now,
    };
    atomicWriteJson(manifestPath, manifest);
    const state = makeState(stateResult.state);
    writeState(projectRoot, state);
    manifest.status = 'applied';
    manifest.targetRevision = state.revision;
    manifest.updatedAt = new Date().toISOString();
    atomicWriteJson(manifestPath, manifest);
    return { state, legacyActiveTaskId: stateResult.state.activeTaskId, changed: true };
  });
}

function assertRepairExpected(projectRoot, sessionKey, request, stateResult, expected) {
  assertExpectedState(stateResult, expected);
  if (stateResult.legacy) {
    if (expected.bindingRevision !== 0 || expected.activeTaskId !== null) {
      fail('BINDING_REVISION_CONFLICT', 'State schema v1 cannot have a session binding');
    }
    requireLegacyActiveTaskExpectation(request, stateResult);
    return null;
  }
  const bindingResult = assertStateReadable(readBinding(projectRoot, sessionKey, stateResult.state.stateId));
  assertExpectedBinding(bindingResult, expected, stateResult.state);
  return bindingResult.binding;
}

function readTaskForRepair(projectRoot, taskId) {
  const taskPath = getTaskPath(projectRoot, taskId);
  if (!taskPath) fail('INVALID_REQUEST', 'taskId is invalid');
  const parsed = readJsonDetailed(taskPath, 64 * 1024);
  if (!parsed.ok || !parsed.exists || !parsed.data || typeof parsed.data !== 'object' || Array.isArray(parsed.data)) {
    fail('TASK_INVALID', `Cannot read task for repair: ${taskId}`);
  }
  return { taskPath, raw: parsed.data };
}

function operationRepairStatus(projectRoot, sessionKey, request) {
  const expected = requireExpected(request, true);
  const taskId = requireString(request, 'taskId', 80);
  if (!isValidTaskId(taskId)) fail('INVALID_REQUEST', 'taskId is invalid');
  const repair = requireString(request, 'repair', 64);
  return withStateLock(projectRoot, () => {
    const stateResult = assertStateReadable(readState(projectRoot, { allowLegacy: true }));
    if (!stateResult.exists) fail('STATE_NOT_FOUND', 'state.json does not exist');
    const binding = assertRepairExpected(projectRoot, sessionKey, request, stateResult, expected);
    const current = readTaskForRepair(projectRoot, taskId);
    if (!Number.isSafeInteger(current.raw.revision) || current.raw.revision !== expected.taskRevision) {
      fail('TASK_REVISION_CONFLICT', 'Task revision changed', {
        taskId,
        taskRevision: current.raw.revision,
      });
    }

    const status = resolveRepairedStatus(projectRoot, taskId, current, repair);

    const task = {
      ...current.raw,
      status,
      revision: current.raw.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    const validationError = validateCanonicalTask(task, taskId);
    if (validationError) fail('TASK_INVALID', `${validationError}: ${taskId}`);
    atomicWriteJson(current.taskPath, task);
    return { state: stateResult.state, binding, task, repair, changed: true };
  });
}

function backupLegacyState(projectRoot, stateResult) {
  const migrationDir = ensureRuntimeDirectory(projectRoot, '.ccg/migrations/state-v2');
  const backupPath = path.join(migrationDir, 'state.json');
  if (fs.existsSync(backupPath)) {
    const backup = readFileBounded(backupPath, STATE_FILE_LIMIT);
    if (!backup.ok || backup.truncated || backup.content !== stateResult.raw) {
      fail('MIGRATION_BACKUP_CONFLICT', 'Existing state v2 migration backup does not match state.json');
    }
  } else {
    atomicWriteFile(backupPath, stateResult.raw);
  }

  return migrationDir;
}

function resolveRepairedStatus(projectRoot, taskId, current, repair) {
  if (repair === 'canonical-in-progress') {
    if (current.raw.schemaVersion !== TASK_SCHEMA_VERSION || current.raw.status !== 'in_progress')
      fail('STATUS_REPAIR_NOT_APPLICABLE', `Task is not a schema v1 in_progress task: ${taskId}`);
    if (current.raw.finishedAt !== null)
      fail('STATUS_REPAIR_NOT_APPLICABLE', `in_progress task has a terminal timestamp: ${taskId}`);
    return 'open';
  }
  if (repair === 'superseded-completed') {
    if (current.raw.schemaVersion !== TASK_SCHEMA_VERSION || current.raw.status !== 'completed')
      fail('STATUS_REPAIR_NOT_APPLICABLE', `Task is not a schema v1 completed task: ${taskId}`);
    assertSupersededBackup(projectRoot, taskId);
    return 'cancelled';
  }
  fail('INVALID_REQUEST', 'repair must be canonical-in-progress or superseded-completed');
}

function assertSupersededBackup(projectRoot, taskId) {
  const backupPath = path.join(projectRoot, '.ccg', 'migrations', 'v1', taskId, 'task.json');
  const backup = readJsonDetailed(backupPath, 64 * 1024);
  if (
    !backup.ok ||
    !backup.exists ||
    !backup.data ||
    typeof backup.data !== 'object' ||
    backup.data.id !== taskId ||
    normalizeLegacyTaskStatus(backup.data.status) !== 'cancelled' ||
    String(backup.data.status || '')
      .trim()
      .toLowerCase() !== 'superseded'
  ) {
    fail('STATUS_REPAIR_EVIDENCE_MISSING', `Legacy superseded backup is missing: ${taskId}`);
  }
}

module.exports = { operationMigrateState, operationRepairStatus };
