'use strict';

const {
  requireExpected,
  requireString,
  VALID_START_MODES,
  fail,
  validateTaskInput,
  validateTextContent,
  REQUIREMENTS_LIMIT,
  ARTIFACT_LIMIT,
} = require('./task-state-core.js');
const {
  withStateLock,
  jsonContent,
  taskForWrite,
  bindingForWrite,
  runTaskTransaction,
  writeBinding,
  assertRuntimePath,
} = require('./task-state-store.js');
const {
  ensureTaskRuntimeIgnored,
  generatedProgress,
  makeState,
  makeBinding,
  readCurrentStateAndBinding,
  assertExpectedState,
  assertExpectedBinding,
  assertTaskReadable,
  assertOpenTask,
  assertTaskRevision,
  assertTaskAvailableForSession,
  currentClaims,
  claimOwnersForSession,
  assertActiveMutation,
  findReturnTarget,
  bumpTask,
  assertStateReadable,
} = require('./task-state-model.js');
const path = require('path');
const {
  getTaskPath,
  getStatePath,
  getBindingPath,
  isValidTaskId,
  readTask,
  inspectReturnChain,
  readState,
  readBinding,
  listTasks,
  getGitInfo,
  TASK_SCHEMA_VERSION,
} = require('./task-utils.js');

function operationStart(projectRoot, sessionKey, request) {
  const expected = requireExpected(request, false);
  const mode = requireString(request, 'mode', 16);
  if (!VALID_START_MODES.has(mode)) fail('INVALID_REQUEST', 'mode must be activate, interrupt, replace, or inactive');
  const taskInput = validateTaskInput(request.task);
  const requirements = validateTextContent(request.requirements, 'requirements', REQUIREMENTS_LIMIT, true);
  return withStateLock(projectRoot, () => {
    ensureTaskRuntimeIgnored(projectRoot);
    const { stateResult, bindingResult } = readStartState(projectRoot, sessionKey, expected);
    const activeTask = readStartActiveTask(projectRoot, bindingResult.binding, mode);
    const task = createTask(projectRoot, taskInput, mode, activeTask);
    const progress =
      validateTextContent(request.progress, 'progress', ARTIFACT_LIMIT, false) ||
      generatedProgress(task, 'Task created');
    const state = makeState(stateResult.state);
    const binding = mode === 'inactive' ? bindingResult.binding : makeBinding(state, bindingResult.binding, task.id);
    const taskDir = path.join(projectRoot, '.ccg', 'tasks', task.id);
    const writes = [
      { path: path.join(taskDir, 'requirements.md'), content: requirements },
      { path: path.join(taskDir, 'progress.md'), content: progress },
      { path: getTaskPath(projectRoot, task.id), content: jsonContent(taskForWrite(task)) },
      { path: getStatePath(projectRoot), content: jsonContent(state) },
    ];
    if (mode !== 'inactive') {
      writes.push({ path: getBindingPath(projectRoot, sessionKey), content: jsonContent(bindingForWrite(binding)) });
    }
    runTaskTransaction(projectRoot, 'start', task.id, writes, { sessionKey });
    return { state, binding, task, effectiveStatus: mode === 'inactive' ? 'suspended' : 'in_progress' };
  });
}

function operationActivate(projectRoot, sessionKey, request) {
  const expected = requireExpected(request, true);
  const taskId = requireString(request, 'taskId', 80);
  if (!isValidTaskId(taskId)) fail('INVALID_REQUEST', 'taskId is invalid');
  return withStateLock(projectRoot, () => {
    const { stateResult, bindingResult } = readCurrentStateAndBinding(projectRoot, sessionKey);
    assertExpectedState(stateResult, expected);
    assertExpectedBinding(bindingResult, expected, stateResult.state);
    const task = assertTaskReadable(readTask(projectRoot, taskId));
    assertOpenTask(task);
    assertTaskRevision(task, expected.taskRevision);
    const chain = inspectReturnChain(projectRoot, task.returnToTaskId);
    if (!chain.ok) fail(chain.code, chain.message);
    assertTaskAvailableForSession(projectRoot, stateResult.state, sessionKey, task);
    if (bindingResult.binding.activeTaskId === taskId) {
      return { state: stateResult.state, binding: bindingResult.binding, task, changed: false };
    }
    const binding = makeBinding(stateResult.state, bindingResult.binding, taskId);
    writeBinding(projectRoot, sessionKey, binding);
    return { state: stateResult.state, binding, task, changed: true, effectiveStatus: 'in_progress' };
  });
}

function operationTakeover(projectRoot, sessionKey, request) {
  const expected = requireExpected(request, true);
  const taskId = requireString(request, 'taskId', 80);
  if (!isValidTaskId(taskId)) fail('INVALID_REQUEST', 'taskId is invalid');
  return withStateLock(projectRoot, () => {
    const { stateResult, bindingResult } = readCurrentStateAndBinding(projectRoot, sessionKey);
    assertExpectedState(stateResult, expected);
    assertExpectedBinding(bindingResult, expected, stateResult.state);
    const task = assertTaskReadable(readTask(projectRoot, taskId));
    assertOpenTask(task);
    assertTaskRevision(task, expected.taskRevision);
    const chain = inspectReturnChain(projectRoot, task.returnToTaskId);
    if (!chain.ok) fail(chain.code, chain.message);

    const { bindings, claims } = currentClaims(projectRoot, stateResult.state);
    const ownerKeys = claimOwnersForSession(projectRoot, task, claims, sessionKey);
    const writes = [];
    for (const ownerKey of ownerKeys) {
      const owner = bindings.find((binding) => binding.sessionKey === ownerKey);
      if (!owner) continue;
      const released = makeBinding(stateResult.state, owner, null);
      writes.push({ path: getBindingPath(projectRoot, ownerKey), content: jsonContent(bindingForWrite(released)) });
    }
    const binding =
      bindingResult.binding.activeTaskId === taskId
        ? bindingResult.binding
        : makeBinding(stateResult.state, bindingResult.binding, taskId);
    if (binding !== bindingResult.binding) {
      writes.push({ path: getBindingPath(projectRoot, sessionKey), content: jsonContent(bindingForWrite(binding)) });
    }
    if (writes.length === 0) {
      return { state: stateResult.state, binding, task, changed: false, transferredBindings: 0 };
    }
    runTaskTransaction(projectRoot, 'takeover', task.id, writes, { sessionKey });
    return {
      state: stateResult.state,
      binding,
      task,
      changed: true,
      transferredBindings: ownerKeys.size,
      effectiveStatus: 'in_progress',
    };
  });
}

function operationFinish(projectRoot, sessionKey, request) {
  const status = requireString(request, 'status', 16);
  if (status !== 'completed' && status !== 'cancelled')
    fail('INVALID_REQUEST', 'status must be completed or cancelled');
  const progress = validateTextContent(request.progress, 'progress', ARTIFACT_LIMIT, false);
  return withStateLock(projectRoot, () => {
    const { state, binding, task } = assertActiveMutation(projectRoot, sessionKey, request);
    if (task.gate !== null) fail('GATE_OPEN', `Task gate is still open: ${task.gate}`);
    if (task.specEvolution === 'pending')
      fail('SPEC_EVOLUTION_PENDING', 'Record the spec evolution result before finishing');
    const returnTask = findReturnTarget(projectRoot, task.returnToTaskId);
    if (returnTask) assertTaskAvailableForSession(projectRoot, state, sessionKey, returnTask.id);
    const now = new Date().toISOString();
    const nextTask = bumpTask(task, { status, gate: null, finishedAt: now });
    const nextBinding = makeBinding(state, binding, returnTask ? returnTask.id : null);
    const writes = [];
    if (progress !== null) writes.push({ path: path.join(task.dir, 'progress.md'), content: progress });
    writes.push(
      { path: getTaskPath(projectRoot, task.id), content: jsonContent(taskForWrite(nextTask)) },
      { path: getBindingPath(projectRoot, sessionKey), content: jsonContent(bindingForWrite(nextBinding)) }
    );
    runTaskTransaction(projectRoot, 'finish', task.id, writes, { sessionKey });
    return {
      state,
      binding: nextBinding,
      task: nextTask,
      resumedTaskId: returnTask ? returnTask.id : null,
    };
  });
}

function readStartState(projectRoot, sessionKey, expected) {
  const stateResult = assertStateReadable(readState(projectRoot));
  assertExpectedState(stateResult, expected);
  const bindingResult = assertStateReadable(readBinding(projectRoot, sessionKey, stateResult.state.stateId));
  if (!stateResult.exists && bindingResult.exists)
    fail('BINDING_INVALID', 'A session binding exists without task state');
  assertExpectedBinding(bindingResult, expected, stateResult.state);
  if (!stateResult.exists) {
    const existing = listTasks(projectRoot, { allowLegacy: true });
    if (!existing.ok) fail(existing.code, existing.message);
    if (existing.tasks.length > 0 || existing.orphans.length > 0)
      fail('TASK_MIGRATION_REQUIRED', 'Existing task directories require explicit migration');
  }
  return { stateResult, bindingResult };
}

function readStartActiveTask(projectRoot, binding, mode) {
  let activeTask = null;
  if (binding.activeTaskId) {
    activeTask = assertTaskReadable(readTask(projectRoot, binding.activeTaskId));
    assertOpenTask(activeTask);
    const chain = inspectReturnChain(projectRoot, activeTask.returnToTaskId);
    if (!chain.ok) fail(chain.code, chain.message);
  }
  if (mode === 'activate' && activeTask) fail('ACTIVE_TASK_CONFLICT', 'activate mode requires no active task');
  if ((mode === 'interrupt' || mode === 'replace') && !activeTask)
    fail('ACTIVE_TASK_CONFLICT', `${mode} mode requires an active task`);
  return activeTask;
}

function createTask(projectRoot, taskInput, mode, activeTask) {
  const destination = assertRuntimePath(projectRoot, `.ccg/tasks/${taskInput.id}`, {
    allowMissing: true,
    kind: 'directory',
  });
  if (destination.exists) fail('TASK_EXISTS', `Task already exists: ${taskInput.id}`);
  const now = new Date().toISOString();
  const git = getGitInfo(projectRoot);
  return {
    schemaVersion: TASK_SCHEMA_VERSION,
    revision: 1,
    ...taskInput,
    status: 'open',
    returnToTaskId: mode === 'interrupt' ? activeTask.id : null,
    specRefs: [],
    branchAtCreation: git.branch === 'unknown' || git.branch === 'HEAD' ? null : git.branch,
    headAtCreation: git.commit,
    createdAt: now,
    updatedAt: now,
    finishedAt: null,
  };
}

module.exports = { operationStart, operationActivate, operationTakeover, operationFinish };
