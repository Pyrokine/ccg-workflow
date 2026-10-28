'use strict';

const { fail, requireExpected } = require('./task-state-core.js');
const {
  readState,
  readBinding,
  readTask,
  STATE_SCHEMA_VERSION,
  BINDING_SCHEMA_VERSION,
  TASK_SCHEMA_VERSION,
  ensureLocalCcgExclude,
  listBindings,
  collectTaskClaims,
  claimOwnersForTask,
  inspectReturnChain,
} = require('./task-utils.js');
const { randomUUID } = require('crypto');
const { taskForWrite } = require('./task-state-store.js');

function assertStateReadable(stateResult) {
  if (!stateResult.ok) fail(stateResult.code, stateResult.message);
  return stateResult;
}

function assertTaskReadable(taskResult) {
  if (!taskResult.ok) fail(taskResult.code, taskResult.message);
  return taskResult.task;
}

function currentStateFields(state, binding) {
  return {
    stateId: state.stateId,
    stateRevision: state.revision,
    bindingRevision: binding.revision,
    activeTaskId: binding.activeTaskId,
  };
}

function assertExpectedState(stateResult, expected) {
  const state = stateResult.state;
  if (expected.stateId !== state.stateId) {
    fail('STATE_ID_CONFLICT', 'Task state identity changed', {
      stateId: state.stateId,
      stateRevision: state.revision,
    });
  }
  if (expected.stateRevision !== state.revision) {
    fail('STATE_REVISION_CONFLICT', 'Task state revision changed', {
      stateId: state.stateId,
      stateRevision: state.revision,
    });
  }
}

function assertExpectedBinding(bindingResult, expected, state) {
  const binding = bindingResult.binding;
  if (expected.bindingRevision !== binding.revision) {
    fail('BINDING_REVISION_CONFLICT', 'Session binding revision changed', currentStateFields(state, binding));
  }
  if (expected.activeTaskId !== binding.activeTaskId) {
    fail('ACTIVE_TASK_CONFLICT', 'Active task changed for this session', currentStateFields(state, binding));
  }
}

function assertTaskRevision(task, expectedRevision) {
  if (task.revision !== expectedRevision) {
    fail('TASK_REVISION_CONFLICT', 'Task revision changed', { taskId: task.id, taskRevision: task.revision });
  }
}

function assertOpenTask(task) {
  if (task.status !== 'open')
    fail('TASK_NOT_OPEN', `Task is not open: ${task.id}`, { taskId: task.id, status: task.status });
}

function readCurrentStateAndBinding(projectRoot, sessionKey) {
  const stateResult = assertStateReadable(readState(projectRoot));
  if (!stateResult.exists) fail('TASK_MIGRATION_REQUIRED', 'Initialize task state before mutation');
  const bindingResult = assertStateReadable(readBinding(projectRoot, sessionKey, stateResult.state.stateId));
  return { stateResult, bindingResult };
}

function assertActiveMutation(projectRoot, sessionKey, request) {
  const expected = requireExpected(request, true);
  const { stateResult, bindingResult } = readCurrentStateAndBinding(projectRoot, sessionKey);
  assertExpectedState(stateResult, expected);
  assertExpectedBinding(bindingResult, expected, stateResult.state);
  if (!bindingResult.binding.activeTaskId) fail('ACTIVE_TASK_CONFLICT', 'No task is active for this session');
  const task = assertTaskReadable(readTask(projectRoot, bindingResult.binding.activeTaskId));
  assertOpenTask(task);
  assertTaskRevision(task, expected.taskRevision);
  return { state: stateResult.state, binding: bindingResult.binding, task, expected };
}

function makeState(previousState) {
  if (previousState.revision >= Number.MAX_SAFE_INTEGER)
    fail('STATE_REVISION_CONFLICT', 'Task state revision overflow');
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    stateId: previousState.stateId || randomUUID(),
    revision: previousState.revision + 1,
    updatedAt: new Date().toISOString(),
  };
}

function makeBinding(state, previousBinding, activeTaskId) {
  if (previousBinding.revision >= Number.MAX_SAFE_INTEGER) {
    fail('BINDING_REVISION_CONFLICT', 'Session binding revision overflow');
  }
  const now = new Date().toISOString();
  return {
    schemaVersion: BINDING_SCHEMA_VERSION,
    stateId: state.stateId,
    revision: previousBinding.revision + 1,
    activeTaskId,
    createdAt: previousBinding.createdAt || now,
    updatedAt: now,
  };
}

function bumpTask(task, patch) {
  if (task.revision >= Number.MAX_SAFE_INTEGER) fail('TASK_REVISION_CONFLICT', `Task revision overflow: ${task.id}`);
  return {
    ...taskForWrite(task),
    ...patch,
    schemaVersion: TASK_SCHEMA_VERSION,
    revision: task.revision + 1,
    updatedAt: new Date().toISOString(),
  };
}

function generatedProgress(task, note) {
  return (
    `# Progress\n\nUpdated: ${new Date().toISOString()}\n\n## Current\n\n- ${note || task.nextAction}\n\n` +
    `## Next\n\n- ${task.nextAction}\n`
  );
}

function ensureTaskRuntimeIgnored(projectRoot) {
  const result = ensureLocalCcgExclude(projectRoot);
  if (!result.ok) fail(result.code, 'Cannot exclude .ccg runtime state from Git', null, 3);
}

function currentClaims(projectRoot, state) {
  const bindings = listBindings(projectRoot, state.stateId);
  if (!bindings.ok) fail(bindings.code, bindings.message);
  return { bindings: bindings.bindings, claims: collectTaskClaims(projectRoot, bindings.bindings) };
}

function claimOwnersForSession(projectRoot, task, claims, sessionKey) {
  const ownership = claimOwnersForTask(projectRoot, task, claims);
  if (!ownership.ok) fail(ownership.code, ownership.message);
  return new Set(ownership.owners.filter((owner) => owner !== sessionKey));
}

function assertTaskAvailableForSession(projectRoot, state, sessionKey, task) {
  const { claims } = currentClaims(projectRoot, state);
  const otherOwners = claimOwnersForSession(projectRoot, task, claims, sessionKey);
  if (otherOwners.size > 0) {
    fail('TASK_CLAIMED', `Task or its return chain is claimed by another session: ${task.id}`, {
      taskId: task.id,
      claimed: true,
    });
  }
}

function findReturnTarget(projectRoot, startTaskId) {
  const chain = inspectReturnChain(projectRoot, startTaskId);
  if (!chain.ok) fail(chain.code, chain.message);
  return chain.chain.find((task) => task.status === 'open') || null;
}

module.exports = {
  assertStateReadable,
  assertTaskReadable,
  assertExpectedState,
  assertExpectedBinding,
  assertTaskRevision,
  assertOpenTask,
  readCurrentStateAndBinding,
  assertActiveMutation,
  makeState,
  makeBinding,
  bumpTask,
  generatedProgress,
  ensureTaskRuntimeIgnored,
  currentClaims,
  claimOwnersForSession,
  assertTaskAvailableForSession,
  findReturnTarget,
};
