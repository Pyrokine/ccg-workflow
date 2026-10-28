'use strict';

const { assertRuntimePath, writeState } = require('./task-state-store.js');
const { readJsonDetailed, atomicWriteJson, readState, STATE_SCHEMA_VERSION } = require('./task-utils.js');
const { fail } = require('./task-state-core.js');
const { randomUUID } = require('crypto');
const { assertStateReadable, makeState } = require('./task-state-model.js');

function readManifest(projectRoot, relativePath) {
  const location = assertRuntimePath(projectRoot, relativePath, { allowMissing: true, kind: 'file' });
  const parsed = readJsonDetailed(location.path, 256 * 1024);
  if (!parsed.ok) fail('MIGRATION_MANIFEST_INVALID', `Cannot read ${relativePath}`);
  if (!parsed.exists) return { path: location.path, manifest: null };
  if (!parsed.data || typeof parsed.data !== 'object' || Array.isArray(parsed.data)) {
    fail('MIGRATION_MANIFEST_INVALID', `${relativePath} must contain an object`);
  }
  return { path: location.path, manifest: parsed.data };
}

function prepareLegacyManifest(projectRoot, legacyIds) {
  const relativePath = '.ccg/migrations/v1/manifest.json';
  const existing = readManifest(projectRoot, relativePath);
  const now = new Date().toISOString();
  let manifest = existing.manifest;
  if (manifest === null) {
    manifest = {
      schemaVersion: 1,
      migrationId: randomUUID(),
      status: 'pending',
      createdAt: now,
      updatedAt: now,
      stateApplied: legacyIds.length === 0,
      stateTransition: null,
      tasks: legacyIds.map((id) => ({ id, status: 'pending' })),
    };
  } else {
    validateLegacyManifest(manifest);

    const known = new Set(manifest.tasks.map((entry) => entry && entry.id));
    let addedTask = false;
    for (const id of legacyIds) {
      if (!known.has(id)) {
        manifest.tasks.push({ id, status: 'pending' });
        addedTask = true;
      }
    }
    if (addedTask) {
      manifest.stateApplied = false;
      manifest.stateTransition = null;
    }
    manifest.status = 'pending';
    manifest.updatedAt = now;
  }
  atomicWriteJson(existing.path, manifest);
  return { path: existing.path, manifest };
}

function validateStateTransition(transition) {
  validateTransitionSource(transition);
  validateTransitionTarget(transition);
  const target = transition.targetState;
  if (Object.prototype.hasOwnProperty.call(target, 'activeTaskId'))
    fail('MIGRATION_MANIFEST_INVALID', 'Migration manifest state transition is invalid');
  if (!transition.sourceExists && (transition.sourceStateId !== null || transition.sourceStateRevision !== 0)) {
    fail('MIGRATION_MANIFEST_INVALID', 'Migration source state is invalid');
  }
  if (transition.sourceExists && transition.sourceStateId === null) {
    fail('MIGRATION_MANIFEST_INVALID', 'Migration source state identity is missing');
  }
  if (transition.sourceStateId !== null && target.stateId !== transition.sourceStateId) {
    fail('MIGRATION_MANIFEST_INVALID', 'Migration state identity changed unexpectedly');
  }
}

function matchesStateTransitionSource(stateResult, transition) {
  return (
    stateResult.exists === transition.sourceExists &&
    stateResult.state.stateId === transition.sourceStateId &&
    stateResult.state.revision === transition.sourceStateRevision
  );
}

function matchesStateTransitionTarget(stateResult, transition) {
  return (
    stateResult.exists &&
    stateResult.state.stateId === transition.targetState.stateId &&
    stateResult.state.revision === transition.targetState.revision
  );
}

function applyManifestStateTransition(projectRoot, prepared) {
  let transition = prepared.manifest.stateTransition;
  if (transition === null) {
    const source = assertStateReadable(readState(projectRoot));
    const targetState = makeState(source.state);
    transition = {
      sourceExists: source.exists,
      sourceStateId: source.state.stateId,
      sourceStateRevision: source.state.revision,
      targetState,
    };
    prepared.manifest.stateTransition = transition;
    prepared.manifest.updatedAt = new Date().toISOString();
    atomicWriteJson(prepared.path, prepared.manifest);
  } else {
    validateStateTransition(transition);
  }

  const current = assertStateReadable(readState(projectRoot));
  let state;
  if (matchesStateTransitionTarget(current, transition)) {
    state = current.state;
  } else if (matchesStateTransitionSource(current, transition)) {
    writeState(projectRoot, transition.targetState);
    state = transition.targetState;
  } else {
    fail('STATE_REVISION_CONFLICT', 'Task state changed during migration', {
      stateId: current.state.stateId,
      stateRevision: current.state.revision,
    });
  }

  prepared.manifest.stateApplied = true;
  prepared.manifest.stateRevision = state.revision;
  prepared.manifest.updatedAt = new Date().toISOString();
  atomicWriteJson(prepared.path, prepared.manifest);
  return state;
}

function validateTransitionSource(transition) {
  if (
    !transition ||
    typeof transition !== 'object' ||
    Array.isArray(transition) ||
    typeof transition.sourceExists !== 'boolean' ||
    (transition.sourceStateId !== null &&
      (typeof transition.sourceStateId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          transition.sourceStateId
        ))) ||
    !Number.isSafeInteger(transition.sourceStateRevision) ||
    transition.sourceStateRevision < 0
  )
    fail('MIGRATION_MANIFEST_INVALID', 'Migration manifest state transition is invalid');
}

function validateTransitionTarget(transition) {
  const target = transition.targetState;
  if (
    !target ||
    typeof target !== 'object' ||
    Array.isArray(target) ||
    target.schemaVersion !== STATE_SCHEMA_VERSION ||
    typeof target.stateId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(target.stateId) ||
    !Number.isSafeInteger(target.revision) ||
    target.revision !== transition.sourceStateRevision + 1 ||
    !Number.isFinite(Date.parse(target.updatedAt))
  )
    fail('MIGRATION_MANIFEST_INVALID', 'Migration manifest state transition is invalid');
}

function validateLegacyManifest(manifest) {
  if (manifest.schemaVersion !== 1 || typeof manifest.migrationId !== 'string' || !Array.isArray(manifest.tasks)) {
    fail('MIGRATION_MANIFEST_INVALID', 'Legacy migration manifest has an invalid structure');
  }
  if (manifest.stateApplied !== undefined && typeof manifest.stateApplied !== 'boolean') {
    fail('MIGRATION_MANIFEST_INVALID', 'Legacy migration manifest stateApplied is invalid');
  }
  if (manifest.stateTransition !== undefined && manifest.stateTransition !== null) {
    validateStateTransition(manifest.stateTransition);
  }
  if (manifest.stateApplied === undefined) manifest.stateApplied = manifest.status === 'applied';
  if (manifest.stateTransition === undefined) manifest.stateTransition = null;
}

module.exports = { readManifest, prepareLegacyManifest, validateStateTransition, applyManifestStateTransition };
