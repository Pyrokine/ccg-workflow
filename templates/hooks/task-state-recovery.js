'use strict';

const { requireExpected, fail, requireSafeRevision } = require('./task-state-core.js');
const { withStateLock, applyTaskTransaction, writeBinding } = require('./task-state-store.js');
const {
  assertStateReadable,
  assertExpectedState,
  assertExpectedBinding,
  assertTaskReadable,
  makeBinding,
  assertTaskRevision,
  findReturnTarget,
  assertTaskAvailableForSession,
} = require('./task-state-model.js');
const { readState, readBinding, readTask } = require('./task-utils.js');

function operationRecover(projectRoot, sessionKey, request) {
  const expected = requireExpected(request, false);
  return withStateLock(
    projectRoot,
    (pending) => {
      const stateResult = assertStateReadable(readState(projectRoot));
      assertExpectedState(stateResult, expected);
      const bindingResult = assertStateReadable(readBinding(projectRoot, sessionKey, stateResult.state.stateId));
      assertExpectedBinding(bindingResult, expected, stateResult.state);
      if (pending.exists) return recoverTransaction(projectRoot, sessionKey, pending);
      return recoverActivePointer(projectRoot, sessionKey, request, stateResult, bindingResult);
    },
    { allowPendingTransaction: true }
  );
}

function recoverTransaction(projectRoot, sessionKey, pending) {
  const transaction = pending.transaction;
  applyTaskTransaction(projectRoot, pending);
  const recoveredState = assertStateReadable(readState(projectRoot));
  if (!recoveredState.exists) fail('TRANSACTION_INVALID', 'Recovered transaction did not initialize state.json');
  const recoveredBinding = assertStateReadable(readBinding(projectRoot, sessionKey, recoveredState.state.stateId));
  const task = assertTaskReadable(readTask(projectRoot, transaction.taskId));
  return {
    state: recoveredState.state,
    binding: recoveredBinding.binding,
    task,
    resumedTaskId: recoveredBinding.binding.activeTaskId,
    recoveredReason: 'INCOMPLETE_TRANSACTION',
    transactionId: transaction.transactionId,
  };
}

function recoverActivePointer(projectRoot, sessionKey, request, stateResult, bindingResult) {
  if (!stateResult.exists) fail('TASK_MIGRATION_REQUIRED', 'state.json does not exist');
  if (!bindingResult.binding.activeTaskId)
    fail('RECOVERY_REQUIRED', 'No active pointer can be recovered for this session');
  const taskResult = readTask(projectRoot, bindingResult.binding.activeTaskId);
  if (!taskResult.ok && taskResult.code === 'TASK_NOT_FOUND') {
    const binding = makeBinding(stateResult.state, bindingResult.binding, null);
    writeBinding(projectRoot, sessionKey, binding);
    return {
      state: stateResult.state,
      binding,
      task: null,
      resumedTaskId: null,
      recoveredReason: 'ACTIVE_TASK_MISSING',
    };
  }
  const task = assertTaskReadable(taskResult);
  const taskRevision = requireSafeRevision(request.expected.taskRevision, 'expected.taskRevision', 1);
  assertTaskRevision(task, taskRevision);
  if (!['completed', 'cancelled'].includes(task.status))
    fail('RECOVERY_REQUIRED', 'Recovery only advances a pointer left on a terminal task');
  const returnTask = findReturnTarget(projectRoot, task.returnToTaskId);
  if (returnTask) assertTaskAvailableForSession(projectRoot, stateResult.state, sessionKey, returnTask.id);
  const binding = makeBinding(stateResult.state, bindingResult.binding, returnTask ? returnTask.id : null);
  writeBinding(projectRoot, sessionKey, binding);
  return {
    state: stateResult.state,
    binding,
    task,
    resumedTaskId: returnTask ? returnTask.id : null,
    recoveredReason: 'ACTIVE_TASK_TERMINAL',
  };
}

module.exports = { operationRecover };
