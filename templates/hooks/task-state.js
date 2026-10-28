#!/usr/bin/env node
// CCG Persistent Task State Controller
// All task lifecycle mutations pass through this script.

'use strict';

const {
  resolveTaskState,
  buildTaskSnapshot,
  readPendingTransaction,
  readState,
  readBinding,
  listTasks,
  trackTurn,
  detectLoop,
} = require('./task-utils.js');
const {
  fail,
  requireExpected,
  resolveRoot,
  resolveSessionKey,
  TaskStateError,
  parseArgs,
  readRequest,
} = require('./task-state-core.js');
const {
  assertStateReadable,
  currentClaims,
  claimOwnersForSession,
  assertTaskRevision,
} = require('./task-state-model.js');
const { operationMigrateState, operationRepairStatus } = require('./task-state-migration.js');
const { taskForWrite } = require('./task-state-store.js');
const { operationStart, operationActivate, operationTakeover, operationFinish } = require('./task-state-lifecycle.js');
const {
  operationUpdateRequirements,
  operationCheckpoint,
  operationWriteArtifact,
  operationLinkSpec,
  operationUnlinkSpec,
  operationSetSpecEvolution,
} = require('./task-state-artifacts.js');
const { operationRecover } = require('./task-state-recovery.js');
const { operationPreflightLegacy, operationMigrateLegacy } = require('./task-state-legacy.js');
const { operationQuarantineOrphans, operationRestoreOrphans } = require('./task-state-orphans.js');

function operationResolve(projectRoot, sessionKey) {
  return resolveTaskState(projectRoot, sessionKey);
}

function operationSnapshot(projectRoot, sessionKey, options) {
  const mode = options.mode || 'session';
  if (!['breadcrumb', 'authority', 'session', 'agent'].includes(mode))
    fail('INVALID_REQUEST', `Unsupported snapshot mode: ${mode}`);
  return buildTaskSnapshot(projectRoot, { mode, role: options.role || 'unknown', sessionKey });
}

function operationList(projectRoot, sessionKey) {
  const pending = readPendingTransaction(projectRoot);
  if (!pending.ok) fail(pending.code, pending.message);
  if (pending.exists)
    fail('RECOVERY_REQUIRED', 'An incomplete task transaction must be recovered before listing tasks');
  const stateResult = assertStateReadable(readState(projectRoot));
  if (!stateResult.exists) fail('TASK_MIGRATION_REQUIRED', 'Initialize task state before listing tasks');
  const bindingResult = assertStateReadable(readBinding(projectRoot, sessionKey, stateResult.state.stateId));
  const tasks = listTasks(projectRoot);
  if (!tasks.ok) fail(tasks.code, tasks.message);
  if (tasks.orphans.length > 0)
    fail('ORPHAN_TASK_DIR', `Task directories without task.json: ${tasks.orphans.join(', ')}`);
  const { claims } = currentClaims(projectRoot, stateResult.state);
  return {
    state: stateResult.state,
    binding: bindingResult.binding,
    tasks: tasks.tasks.map((task) => ({
      id: task.id,
      title: task.title,
      revision: task.revision,
      status: task.status,
      effectiveStatus:
        task.status === 'open'
          ? task.id === bindingResult.binding.activeTaskId
            ? 'in_progress'
            : 'suspended'
          : task.status,
      claimed: task.status === 'open' && claimOwnersForSession(projectRoot, task, claims, sessionKey).size > 0,
    })),
    orphans: [],
  };
}

function operationRecordTurn(projectRoot, sessionKey, request) {
  const expected = requireExpected(request, true);
  const resolution = resolveTaskState(projectRoot, sessionKey);
  if (resolution.kind !== 'active')
    fail(resolution.code || 'ACTIVE_TASK_CONFLICT', resolution.message || 'No active task');
  if (
    resolution.stateId !== expected.stateId ||
    resolution.stateRevision !== expected.stateRevision ||
    resolution.bindingRevision !== expected.bindingRevision ||
    resolution.activeTaskId !== expected.activeTaskId
  ) {
    fail('REVISION_CONFLICT', 'Task state or session binding changed before recording the turn');
  }
  assertTaskRevision(resolution.task, expected.taskRevision);
  const tracked = trackTurn(
    resolution.task.dir,
    sessionKey,
    resolution.task.currentPhase,
    resolution.task.nextAction,
    resolution.task.revision
  );
  if (!tracked.ok) fail(tracked.code, 'Cannot record session turn', null, 3);
  return {
    state: resolution.state,
    binding: resolution.binding,
    task: resolution.task,
    loop: detectLoop(tracked.turns, 3),
    observation: 'Recorded task state only; unchanged records do not prove that work has stalled',
  };
}

function execute(operation, options, request) {
  const projectRoot = resolveRoot(options);
  const sessionKey = resolveSessionKey(options);
  if (operation === 'snapshot') return operationSnapshot(projectRoot, sessionKey, options);
  if (operation === 'migrate-state') return operationMigrateState(projectRoot, request);
  const handler = OPERATIONS[operation];
  if (!handler) fail('INVALID_REQUEST', `Unknown operation: ${operation}`);
  return handler(projectRoot, sessionKey, request);
}

function operationRequiresRequest(operation) {
  return !['resolve', 'snapshot', 'list', 'preflight-legacy'].includes(operation);
}

function outputSuccess(operation, result) {
  const output = result && typeof result === 'object' ? { ...result } : { value: result };
  if (output.task) output.task = taskForWrite(output.task);
  output.diagnostics = Array.isArray(output.diagnostics) ? output.diagnostics : [];
  process.stdout.write(`${JSON.stringify({ ok: true, operation, ...output })}\n`);
}

function outputFailure(error) {
  const taskError =
    error instanceof TaskStateError
      ? error
      : new TaskStateError('IO_ERROR', error instanceof Error ? error.message : String(error), null, 3);
  const output = {
    ok: false,
    code: taskError.code,
    message: taskError.message,
    current: taskError.current,
    diagnostics: [taskError.code],
  };
  process.stdout.write(`${JSON.stringify(output)}\n`);
  process.exitCode = taskError.exitCode;
}

function main() {
  try {
    const args = process.argv.slice(2);
    if (args.includes('--help') || args.includes('-h')) {
      process.stdout.write(
        [
          'Usage: task-state.js <operation> [--root path] --session-key key [--mode mode] [--role role]',
          'Read-only operations (no stdin): resolve, snapshot, list, preflight-legacy',
          'JSON request on stdin: start (create), activate, takeover, update-requirements, checkpoint,',
          '  write-artifact, link-spec, unlink-spec, set-spec-evolution, finish, recover, migrate-state,',
          '  migrate-legacy (migrate), repair-status, quarantine-orphans, restore-orphans, record-turn',
          'Help: --help, -h (no project, session or stdin required)',
          '',
        ].join('\n')
      );
      return;
    }
    const { operation, options } = parseArgs(args);
    const request = operationRequiresRequest(operation) ? readRequest() : {};
    outputSuccess(operation, execute(operation, options, request));
  } catch (error) {
    outputFailure(error);
  }
}

const OPERATIONS = Object.assign(Object.create(null), {
  resolve: operationResolve,
  list: operationList,
  start: operationStart,
  create: operationStart,
  activate: operationActivate,
  takeover: operationTakeover,
  'update-requirements': operationUpdateRequirements,
  checkpoint: operationCheckpoint,
  'write-artifact': operationWriteArtifact,
  'link-spec': operationLinkSpec,
  'unlink-spec': operationUnlinkSpec,
  'set-spec-evolution': operationSetSpecEvolution,
  finish: operationFinish,
  recover: operationRecover,
  'preflight-legacy': operationPreflightLegacy,
  'migrate-legacy': operationMigrateLegacy,
  migrate: operationMigrateLegacy,
  'repair-status': operationRepairStatus,
  'quarantine-orphans': operationQuarantineOrphans,
  'restore-orphans': operationRestoreOrphans,
  'record-turn': operationRecordTurn,
});

if (require.main === module) main();

module.exports = {
  TaskStateError,
  parseArgs,
  execute,
  operationResolve,
  operationSnapshot,
  operationList,
  operationStart,
  operationActivate,
  operationTakeover,
  operationUpdateRequirements,
  operationCheckpoint,
  operationWriteArtifact,
  operationLinkSpec,
  operationUnlinkSpec,
  operationSetSpecEvolution,
  operationFinish,
  operationRecover,
  operationPreflightLegacy,
  operationMigrateState,
  operationMigrateLegacy,
  operationRepairStatus,
  operationQuarantineOrphans,
  operationRestoreOrphans,
  operationRecordTurn,
};
