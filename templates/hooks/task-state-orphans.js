'use strict';

const { fail, requireExpected } = require('./task-state-core.js');
const { readManifest, validateStateTransition, applyManifestStateTransition } = require('./task-state-manifest.js');
const path = require('path');
const { withStateLock, assertRuntimePath, ensureRuntimeDirectory } = require('./task-state-store.js');
const {
  ensureTaskRuntimeIgnored,
  assertStateReadable,
  assertExpectedState,
  assertExpectedBinding,
  readCurrentStateAndBinding,
} = require('./task-state-model.js');
const { readState, readBinding, listTasks, atomicWriteJson, fsyncDirectory } = require('./task-utils.js');
const fs = require('fs');

function isSafeOrphanName(name) {
  return (
    typeof name === 'string' &&
    name !== '' &&
    name !== '.' &&
    name !== '..' &&
    !name.includes('/') &&
    !name.includes('\\') &&
    !name.includes('\0')
  );
}

function isValidManifestTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function validateOrphanManifestEntry(entry, names) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !isSafeOrphanName(entry.name)) {
    fail('MIGRATION_MANIFEST_INVALID', 'Orphan manifest contains an invalid entry');
  }
  if (names.has(entry.name))
    fail('MIGRATION_MANIFEST_INVALID', `Orphan manifest contains duplicate name: ${entry.name}`);
  names.add(entry.name);
  if (
    entry.source !== `.ccg/tasks/${entry.name}` ||
    entry.target !== `.ccg/historical-artifacts/orphans/${entry.name}`
  ) {
    fail('MIGRATION_MANIFEST_INVALID', `Orphan manifest paths do not match the entry name: ${entry.name}`);
  }
  if (!['pending', 'quarantined', 'restored'].includes(entry.status)) {
    fail('MIGRATION_MANIFEST_INVALID', `Orphan manifest status is invalid: ${entry.name}`);
  }
  validateOrphanTimestamps(entry);
}

function readOrphanManifest(projectRoot) {
  const relativePath = '.ccg/historical-artifacts/orphans/manifest.json';
  const existing = readManifest(projectRoot, relativePath);
  if (existing.manifest === null) {
    return {
      path: existing.path,
      manifest: {
        schemaVersion: 1,
        stateApplied: true,
        stateTransition: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        entries: [],
      },
    };
  }
  validateOrphanManifest(existing.manifest);
  const names = new Set();
  for (const entry of existing.manifest.entries) validateOrphanManifestEntry(entry, names);
  if (existing.manifest.stateTransition !== undefined && existing.manifest.stateTransition !== null) {
    validateStateTransition(existing.manifest.stateTransition);
  }
  if (existing.manifest.stateApplied === undefined) existing.manifest.stateApplied = true;
  if (existing.manifest.stateTransition === undefined) existing.manifest.stateTransition = null;
  return existing;
}

function operationQuarantineOrphans(projectRoot, sessionKey, request) {
  const expected = requireExpected(request, false);
  return withStateLock(projectRoot, () => {
    ensureTaskRuntimeIgnored(projectRoot);
    const stateResult = assertStateReadable(readState(projectRoot));
    assertExpectedState(stateResult, expected);
    const bindingResult = assertStateReadable(readBinding(projectRoot, sessionKey, stateResult.state.stateId));
    if (!stateResult.exists && bindingResult.exists)
      fail('BINDING_INVALID', 'A session binding exists without task state');
    assertExpectedBinding(bindingResult, expected, stateResult.state);
    const listed = listTasks(projectRoot, { allowLegacy: true });
    if (!listed.ok) fail(listed.code, listed.message);
    const manifestState = readOrphanManifest(projectRoot);
    prepareOrphanQuarantine(manifestState, listed.orphans);
    const quarantined = quarantineManifestEntries(projectRoot, manifestState);

    const stateTransitionPending = !manifestState.manifest.stateApplied;
    const state = stateTransitionPending
      ? applyManifestStateTransition(projectRoot, manifestState)
      : assertStateReadable(readState(projectRoot)).state;
    const binding = assertStateReadable(readBinding(projectRoot, sessionKey, state.stateId)).binding;
    return { state, binding, quarantined, changed: quarantined.length > 0 || stateTransitionPending };
  });
}

function operationRestoreOrphans(projectRoot, sessionKey, request) {
  const expected = requireExpected(request, false);
  const names = request.names;
  if (!Array.isArray(names) || names.length === 0 || names.some((name) => !isSafeOrphanName(name))) {
    fail('INVALID_REQUEST', 'names must contain safe orphan directory names');
  }
  return withStateLock(projectRoot, () => {
    const { stateResult, bindingResult } = readCurrentStateAndBinding(projectRoot, sessionKey);
    assertExpectedState(stateResult, expected);
    assertExpectedBinding(bindingResult, expected, stateResult.state);
    const manifestState = readOrphanManifest(projectRoot);
    const entries = [...new Set(names)].map((name) => {
      const entry = manifestState.manifest.entries.find((candidate) => candidate.name === name);
      if (!entry || !['quarantined', 'restored'].includes(entry.status)) {
        fail('ORPHAN_RESTORE_NOT_FOUND', `Quarantined orphan is not available: ${name}`);
      }
      return entry;
    });
    const pendingEntries = entries.filter((entry) => entry.status === 'quarantined');
    if (pendingEntries.length === 0 && manifestState.manifest.stateApplied) {
      return { state: stateResult.state, binding: bindingResult.binding, restored: [], changed: false };
    }
    if (pendingEntries.length > 0 && manifestState.manifest.stateApplied) {
      manifestState.manifest.stateApplied = false;
      manifestState.manifest.stateTransition = null;
      manifestState.manifest.updatedAt = new Date().toISOString();
      atomicWriteJson(manifestState.path, manifestState.manifest);
    }

    const restored = [];
    for (const entry of entries) {
      const source = assertRuntimePath(projectRoot, entry.source, { allowMissing: true, kind: 'directory' });
      const target = assertRuntimePath(projectRoot, entry.target, { allowMissing: true, kind: 'directory' });
      if (source.exists === target.exists) fail('ORPHAN_QUARANTINE_CONFLICT', `Cannot restore orphan: ${entry.name}`);
      if (target.exists) {
        ensureRuntimeDirectory(projectRoot, '.ccg/tasks');
        fs.renameSync(target.path, source.path);
        fsyncDirectory(path.dirname(source.path));
        fsyncDirectory(path.dirname(target.path));
      }
      entry.status = 'restored';
      entry.restoredAt = entry.restoredAt || new Date().toISOString();
      restored.push(entry.name);
    }
    manifestState.manifest.updatedAt = new Date().toISOString();
    const state = manifestState.manifest.stateApplied
      ? stateResult.state
      : applyManifestStateTransition(projectRoot, manifestState);
    return { state, binding: bindingResult.binding, restored, changed: true };
  });
}

function validateOrphanTimestamps(entry) {
  if (entry.quarantinedAt !== undefined && !isValidManifestTimestamp(entry.quarantinedAt)) {
    fail('MIGRATION_MANIFEST_INVALID', `Orphan quarantine timestamp is invalid: ${entry.name}`);
  }
  if (entry.restoredAt !== undefined && !isValidManifestTimestamp(entry.restoredAt)) {
    fail('MIGRATION_MANIFEST_INVALID', `Orphan restore timestamp is invalid: ${entry.name}`);
  }
  if (['quarantined', 'restored'].includes(entry.status) && !isValidManifestTimestamp(entry.quarantinedAt)) {
    fail('MIGRATION_MANIFEST_INVALID', `Orphan quarantine timestamp is missing: ${entry.name}`);
  }
  if (entry.status === 'restored' && !isValidManifestTimestamp(entry.restoredAt)) {
    fail('MIGRATION_MANIFEST_INVALID', `Orphan restore timestamp is missing: ${entry.name}`);
  }
}

function validateOrphanManifest(manifest) {
  if (
    manifest.schemaVersion !== 1 ||
    !Array.isArray(manifest.entries) ||
    !isValidManifestTimestamp(manifest.createdAt) ||
    !isValidManifestTimestamp(manifest.updatedAt) ||
    (manifest.stateApplied !== undefined && typeof manifest.stateApplied !== 'boolean')
  ) {
    fail('MIGRATION_MANIFEST_INVALID', 'Orphan manifest has an invalid structure');
  }
}

function prepareOrphanQuarantine(manifestState, orphans) {
  const known = new Map(manifestState.manifest.entries.map((entry) => [entry.name, entry]));
  for (const name of orphans) {
    if (!isSafeOrphanName(name)) fail('ORPHAN_TASK_DIR', `Unsafe orphan directory name: ${name}`);
    const existing = known.get(name);
    if (!existing) {
      const entry = {
        name,
        source: `.ccg/tasks/${name}`,
        target: `.ccg/historical-artifacts/orphans/${name}`,
        status: 'pending',
      };
      manifestState.manifest.entries.push(entry);
      known.set(name, entry);
    } else if (existing.status === 'restored') {
      existing.status = 'pending';
    } else if (existing.status === 'quarantined') {
      fail('ORPHAN_QUARANTINE_CONFLICT', `Quarantined orphan reappeared in tasks: ${name}`);
    }
  }
  if (orphans.length > 0) {
    manifestState.manifest.stateApplied = false;
    manifestState.manifest.stateTransition = null;
  }
  manifestState.manifest.updatedAt = new Date().toISOString();
  atomicWriteJson(manifestState.path, manifestState.manifest);
}

function quarantineManifestEntries(projectRoot, manifestState) {
  const quarantined = [];
  for (const entry of manifestState.manifest.entries) {
    if (entry.status !== 'pending') continue;
    if (!isSafeOrphanName(entry.name)) fail('MIGRATION_MANIFEST_INVALID', 'Orphan manifest contains an unsafe name');
    const source = assertRuntimePath(projectRoot, entry.source, { allowMissing: true, kind: 'directory' });
    const target = assertRuntimePath(projectRoot, entry.target, { allowMissing: true, kind: 'directory' });
    if (source.exists && target.exists) fail('ORPHAN_QUARANTINE_CONFLICT', `Both orphan paths exist: ${entry.name}`);
    if (source.exists) {
      ensureRuntimeDirectory(projectRoot, '.ccg/historical-artifacts/orphans');
      fs.renameSync(source.path, target.path);
      fsyncDirectory(path.dirname(source.path));
      fsyncDirectory(path.dirname(target.path));
    } else if (!target.exists) {
      fail('ORPHAN_QUARANTINE_CONFLICT', `Orphan path is missing: ${entry.name}`);
    }
    entry.status = 'quarantined';
    entry.quarantinedAt = new Date().toISOString();
    manifestState.manifest.updatedAt = entry.quarantinedAt;
    atomicWriteJson(manifestState.path, manifestState.manifest);
    quarantined.push(entry.name);
  }
  return quarantined;
}

module.exports = { operationQuarantineOrphans, operationRestoreOrphans };
