'use strict';

const {
  validateSpecRef,
  collectSpecContext,
  isValidTaskId,
  listTasks,
  readTask,
  readFileBounded,
  validateCanonicalTask,
  readState,
  readBinding,
  atomicWriteJson,
  getGitInfo,
  normalizeLegacyTaskStatus,
  TASK_SCHEMA_VERSION,
  atomicWriteFile,
  readContextJsonl,
} = require('./task-utils.js');
const {
  fail,
  REQUIREMENTS_LIMIT,
  requireExpected,
  truncateUtf8ToBytes,
  VALID_SPEC_EVOLUTION,
} = require('./task-state-core.js');
const path = require('path');
const { backupLegacyTask } = require('./task-state-backup.js');
const { writeTask, withStateLock } = require('./task-state-store.js');
const {
  ensureTaskRuntimeIgnored,
  assertStateReadable,
  assertExpectedState,
  assertExpectedBinding,
  generatedProgress,
} = require('./task-state-model.js');
const { prepareLegacyManifest, applyManifestStateTransition } = require('./task-state-manifest.js');
const fs = require('fs');

function canonicalizeLegacySpecRefs(projectRoot, taskResult, diagnostics) {
  const refs = [];
  for (const ref of taskResult.task.specRefs || []) {
    const validated = validateSpecRef(projectRoot, ref, { requireSection: true });
    if (!validated.ok) {
      diagnostics.push(`LEGACY_SPEC_SKIPPED:${taskResult.task.id}:${validated.code}`);
      continue;
    }
    const collected = collectSpecContext(projectRoot, [...refs, validated.ref], 'all');
    if (!collected.ok) {
      diagnostics.push(`LEGACY_SPEC_SKIPPED:${taskResult.task.id}:${collected.code}`);
      continue;
    }
    refs.push(validated.ref);
  }
  collectLegacyContextRefs(projectRoot, taskResult, diagnostics, refs);
  return refs.slice(0, 32);
}

function validateLegacyReturnChains(taskResults) {
  const returnMap = new Map();
  const ids = new Set(taskResults.map((result) => result.task.id));
  for (const result of taskResults) {
    const rawValue = result.legacy ? result.raw.returnToTaskId : result.task.returnToTaskId;
    if (rawValue === undefined || rawValue === null || rawValue === '') {
      returnMap.set(result.task.id, null);
      continue;
    }
    if (!isValidTaskId(rawValue) || rawValue === result.task.id) {
      fail('RETURN_CHAIN_INVALID', `Legacy task has an invalid return target: ${result.task.id}`);
    }
    if (!ids.has(rawValue)) fail('RETURN_CHAIN_MISSING', `Legacy return target is missing: ${rawValue}`);
    returnMap.set(result.task.id, rawValue);
  }
  validateReturnMap(ids, returnMap);
  return returnMap;
}

function preflightLegacy(projectRoot) {
  const listed = listTasks(projectRoot, { allowLegacy: true });
  if (!listed.ok) fail(listed.code, listed.message);
  const taskResults = listed.tasks.map((task) => {
    const result = readTask(projectRoot, task.id, { allowLegacy: true });
    if (!result.ok) fail(result.code, result.message);
    return result;
  });
  validateLegacyReturnChains(taskResults);
  const tasks = taskResults.map((result) => {
    const requirements = readFileBounded(path.join(result.taskDir, 'requirements.md'), REQUIREMENTS_LIMIT);
    let contract = 'valid';
    if (!requirements.ok && requirements.code === 'NOT_FOUND') contract = 'missing';
    else if (!requirements.ok || requirements.truncated || !requirements.content.trim()) contract = 'blocked';
    return {
      id: result.task.id,
      legacy: result.legacy,
      status: result.task.status,
      contract,
    };
  });
  return { tasks, taskResults, orphans: listed.orphans };
}

function migrateOneTask(projectRoot, taskResult, diagnostics) {
  if (!taskResult.legacy) return taskResult.task;
  backupLegacyTask(projectRoot, taskResult);
  const task = canonicalizeLegacyTask(projectRoot, taskResult, diagnostics);
  const canonicalError = validateCanonicalTask(task, task.id);
  if (canonicalError) fail('TASK_INVALID', `${canonicalError}: ${task.id}`);
  prepareLegacyArtifacts(taskResult, task);
  writeTask(projectRoot, task);
  return task;
}

function operationPreflightLegacy(projectRoot) {
  const preflight = preflightLegacy(projectRoot);
  return {
    tasks: preflight.tasks,
    orphans: preflight.orphans,
    migrationRequired: preflight.tasks.some((task) => task.legacy),
    blockedTaskIds: preflight.tasks.filter((task) => task.contract === 'blocked').map((task) => task.id),
  };
}

function operationMigrateLegacy(projectRoot, sessionKey, request) {
  const expected = requireExpected(request, false);
  return withStateLock(projectRoot, () => {
    ensureTaskRuntimeIgnored(projectRoot);
    const stateResult = assertStateReadable(readState(projectRoot));
    assertExpectedState(stateResult, expected);
    const bindingResult = assertStateReadable(readBinding(projectRoot, sessionKey, stateResult.state.stateId));
    if (!stateResult.exists && bindingResult.exists)
      fail('BINDING_INVALID', 'A session binding exists without task state');
    assertExpectedBinding(bindingResult, expected, stateResult.state);
    const preflight = preflightLegacy(projectRoot);
    if (preflight.orphans.length > 0) {
      fail('ORPHAN_TASK_DIR', `Quarantine task directories without task.json first: ${preflight.orphans.join(', ')}`);
    }
    const blocked = preflight.tasks.filter((task) => task.legacy && task.contract === 'blocked');
    const legacyResults = preflight.taskResults.filter((result) => result.legacy);
    const prepared = prepareLegacyManifest(
      projectRoot,
      legacyResults.map((result) => result.task.id)
    );
    assertLegacyContracts(projectRoot, blocked, legacyResults);
    const diagnostics = [];
    const migratedTaskIds = migrateManifestTasks(projectRoot, prepared, diagnostics);
    const state =
      stateResult.exists && prepared.manifest.stateApplied
        ? assertStateReadable(readState(projectRoot)).state
        : applyManifestStateTransition(projectRoot, prepared);
    prepared.manifest.status = 'applied';
    prepared.manifest.updatedAt = new Date().toISOString();
    atomicWriteJson(prepared.path, prepared.manifest);

    const binding = assertStateReadable(readBinding(projectRoot, sessionKey, state.stateId)).binding;
    return { state, binding, migratedTaskIds, diagnostics };
  });
}

function canonicalizeLegacyTask(projectRoot, taskResult, diagnostics) {
  const raw = taskResult.raw;
  const now = new Date().toISOString();
  const git = getGitInfo(projectRoot);
  const status = normalizeLegacyTaskStatus(raw.status);
  if (!status) fail('TASK_INVALID', `Legacy task status is invalid: ${taskResult.task.id}`);
  const title = legacyText(raw.title, 240, taskResult.task.id);
  return {
    schemaVersion: TASK_SCHEMA_VERSION,
    revision: 1,
    id: taskResult.task.id,
    title,
    status,
    ...legacyTaskMetadata(raw, title),
    returnToTaskId: raw.returnToTaskId || null,
    specRefs: canonicalizeLegacySpecRefs(projectRoot, taskResult, diagnostics),
    branchAtCreation: legacyBranchAtCreation(taskResult.task, git),
    headAtCreation: /^[0-9a-f]{40}$/i.test(taskResult.task.headAtCreation || '')
      ? taskResult.task.headAtCreation
      : git.commit,
    createdAt: Number.isFinite(Date.parse(raw.createdAt)) ? raw.createdAt : now,
    updatedAt: now,
    finishedAt: legacyFinishedAt(raw, status, now),
  };
}

function prepareLegacyArtifacts(taskResult, task) {
  const requirementsPath = path.join(taskResult.taskDir, 'requirements.md');
  const requirements = readFileBounded(requirementsPath, REQUIREMENTS_LIMIT);
  if (!requirements.ok && requirements.code === 'NOT_FOUND') {
    atomicWriteFile(requirementsPath, `# Requirements\n\n## Objective\n\n${task.title}\n\n## Scope\n\n${task.scope}\n`);
  } else if (!requirements.ok || requirements.truncated || !requirements.content.trim()) {
    fail('TASK_CONTRACT_INVALID', `Legacy requirements.md is invalid: ${task.id}`);
  }
  const progressPath = path.join(taskResult.taskDir, 'progress.md');
  if (!fs.existsSync(progressPath)) atomicWriteFile(progressPath, generatedProgress(task, 'Legacy task migrated'));
}

function collectLegacyContextRefs(projectRoot, taskResult, diagnostics, refs) {
  const context = readContextJsonl(taskResult.taskDir);
  diagnostics.push(...context.diagnostics.map((item) => `${taskResult.task.id}:${item}`));
  for (const entry of context.entries) {
    if (typeof entry.file !== 'string' || entry.file.startsWith('.ccg/spec/') || !entry.section) {
      diagnostics.push(`LEGACY_CONTEXT_SKIPPED:${taskResult.task.id}:${entry.line}`);
      continue;
    }
    const candidate = legacyContextRef(entry);
    const validated = validateSpecRef(projectRoot, candidate, { requireSection: true });
    if (!validated.ok) {
      diagnostics.push(`LEGACY_CONTEXT_SKIPPED:${taskResult.task.id}:${entry.line}:${validated.code}`);
      continue;
    }
    if (refs.some((ref) => ref.path === validated.ref.path && ref.section === validated.ref.section)) continue;
    const collected = collectSpecContext(projectRoot, [...refs, validated.ref], 'all');
    if (!collected.ok) {
      diagnostics.push(`LEGACY_CONTEXT_SKIPPED:${taskResult.task.id}:${entry.line}:${collected.code}`);
      continue;
    }
    refs.push(validated.ref);
  }
}

function legacyContextRef(entry) {
  return {
    path: entry.file,
    section: entry.section,
    purpose: entry.purpose || entry.reason || 'Legacy task context',
    ...(Array.isArray(entry.roles) ? { roles: entry.roles.filter((role) => role !== 'all') } : {}),
  };
}

function validateReturnMap(ids, returnMap) {
  for (const id of ids) {
    const visited = new Set();
    let current = id;
    for (let depth = 0; current !== null; depth += 1) {
      if (depth >= 32) fail('RETURN_CHAIN_TOO_DEEP', `Task return chain exceeds 32 entries: ${id}`);
      if (visited.has(current)) fail('RETURN_CHAIN_CYCLE', `Task return chain cycles at ${current}`);
      visited.add(current);
      current = returnMap.get(current) || null;
    }
  }
}

function assertLegacyContracts(projectRoot, blocked, legacyResults) {
  if (blocked.length > 0) {
    for (const task of blocked) {
      const result = legacyResults.find((candidate) => candidate.task.id === task.id);
      if (result) backupLegacyTask(projectRoot, result);
    }
    fail(
      'TASK_CONTRACT_INVALID',
      `Legacy task contracts require manual repair: ${blocked.map((task) => task.id).join(', ')}`
    );
  }
}

function migrateManifestTasks(projectRoot, prepared, diagnostics) {
  const migratedTaskIds = [];
  for (const entry of prepared.manifest.tasks) {
    const result = readTask(projectRoot, entry.id, { allowLegacy: true });
    if (!result.ok) fail(result.code, result.message);
    if (!result.legacy) {
      entry.status = 'applied';
      continue;
    }
    migrateOneTask(projectRoot, result, diagnostics);
    entry.status = 'applied';
    entry.updatedAt = new Date().toISOString();
    prepared.manifest.updatedAt = entry.updatedAt;
    atomicWriteJson(prepared.path, prepared.manifest);
    migratedTaskIds.push(entry.id);
  }
  return migratedTaskIds;
}

function legacyText(value, maxBytes, defaultValue) {
  return typeof value === 'string' && value.trim() ? truncateUtf8ToBytes(value.trim(), maxBytes) : defaultValue;
}

function legacyBranchAtCreation(task, git) {
  const branch =
    typeof task.branchAtCreation === 'string' && task.branchAtCreation.trim()
      ? task.branchAtCreation.trim()
      : git.branch === 'HEAD' || git.branch === 'unknown'
        ? null
        : git.branch;
  return branch === null ? null : truncateUtf8ToBytes(branch, 512);
}

function legacyFinishedAt(raw, status, now) {
  if (status === 'open') return null;
  return Number.isFinite(Date.parse(raw.finishedAt || raw.completedAt)) ? raw.finishedAt || raw.completedAt : now;
}

function legacyTaskMetadata(raw, title) {
  return {
    strategy: legacyText(raw.strategy, 80, 'guided-develop'),
    complexity: ['S', 'M', 'L', 'XL'].includes(raw.complexity) ? raw.complexity : 'M',
    risk: ['low', 'medium', 'high'].includes(raw.risk) ? raw.risk : 'medium',
    domain: legacyText(raw.domain, 64, 'general'),
    scope: legacyText(raw.scope, 1024, title),
    currentPhase: truncateUtf8ToBytes(String(raw.currentPhase || '1').trim(), 64) || '1',
    nextAction: truncateUtf8ToBytes(String(raw.nextAction || 'Continue the task').trim(), 1024) || 'Continue the task',
    gate: legacyText(raw.gate, 256, null),
    specEvolution: VALID_SPEC_EVOLUTION.has(raw.specEvolution) ? raw.specEvolution : 'pending',
  };
}

module.exports = { operationPreflightLegacy, operationMigrateLegacy };
