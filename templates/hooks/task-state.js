#!/usr/bin/env node
// CCG Persistent Task State Controller
// All task lifecycle mutations pass through this script.

'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const {
  STATE_SCHEMA_VERSION,
  BINDING_SCHEMA_VERSION,
  TASK_SCHEMA_VERSION,
  STATE_FILE_LIMIT,
  TRANSACTION_FILE_LIMIT,
  findProjectRoot,
  isValidTaskId,
  isValidSessionKey,
  getStatePath,
  getBindingPath,
  getTaskPath,
  validateRuntimePath,
  readFileBounded,
  readJsonDetailed,
  readPendingTransaction,
  readState,
  readBinding,
  listBindings,
  readTask,
  validateCanonicalTask,
  listTasks,
  claimOwnersForTask,
  collectTaskClaims,
  resolveTaskState,
  buildTaskSnapshot,
  normalizeLegacyTaskStatus,
  validateSpecRef,
  collectSpecContext,
  readContextJsonl,
  getGitInfo,
  readStdinBounded,
  atomicWriteFile,
  atomicWriteJson,
  fsyncDirectory,
  ensureLocalCcgExclude,
  inspectReturnChain,
  trackTurn,
  detectLoop,
} = require('./task-utils.js');

const LOCK_TIMEOUT_MS = 500;
const LOCK_STALE_MS = 30000;
const LOCK_RETRY_MS = 25;
const REQUEST_LIMIT = 1024 * 1024;
const REQUIREMENTS_LIMIT = 8 * 1024;
const ARTIFACT_LIMIT = 256 * 1024;
const VALID_START_MODES = new Set(['activate', 'interrupt', 'replace', 'inactive']);
const VALID_SPEC_EVOLUTION = new Set(['pending', 'applied', 'skipped', 'not_applicable']);
const VALID_ARTIFACTS = new Map([
  ['analysis', 'analysis.md'],
  ['plan', 'plan.md'],
  ['review', 'review.md'],
]);

class TaskStateError extends Error {
  constructor(code, message, current, exitCode) {
    super(message);
    this.code = code;
    this.current = current || null;
    this.exitCode = exitCode || 2;
  }
}

function fail(code, message, current, exitCode) {
  throw new TaskStateError(code, message, current, exitCode);
}

function parseArgs(argv) {
  const operation = argv[0];
  if (!operation || operation.startsWith('--')) fail('INVALID_REQUEST', 'Missing operation');
  const options = {};
  const allowed = new Set(['root', 'mode', 'role', 'session-key']);
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) fail('INVALID_REQUEST', `Unexpected argument: ${token}`);
    const key = token.slice(2);
    if (!allowed.has(key)) fail('INVALID_REQUEST', `Unsupported command-line option: --${key}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) fail('INVALID_REQUEST', `Missing value for --${key}`);
    options[key] = value;
    index += 1;
  }
  return { operation, options };
}

function resolveRoot(options) {
  const requested = options.root;
  const root = requested ? path.resolve(requested) : findProjectRoot(process.cwd());
  if (!root || !fs.existsSync(root)) fail('INVALID_REQUEST', 'Project root does not exist');
  return root;
}

function resolveSessionKey(options) {
  const sessionKey = options['session-key'];
  if (sessionKey === undefined) fail('SESSION_KEY_REQUIRED', '--session-key is required');
  if (!isValidSessionKey(sessionKey))
    fail('SESSION_KEY_INVALID', '--session-key must be an opaque Claude or Codex session key');
  return sessionKey;
}

function readRequest(required) {
  const raw = readStdinBounded(REQUEST_LIMIT);
  if (!raw.trim()) {
    if (required) fail('INVALID_REQUEST', 'A JSON request is required on stdin');
    return {};
  }
  let request;
  try {
    request = JSON.parse(raw);
  } catch {
    fail('INVALID_REQUEST', 'stdin must contain one JSON object');
  }
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    fail('INVALID_REQUEST', 'stdin must contain one JSON object');
  }
  return request;
}

function requireString(object, key, maxBytes) {
  const value = object && object[key];
  if (typeof value !== 'string' || !value.trim()) fail('INVALID_REQUEST', `${key} must be a non-empty string`);
  const normalized = value.trim();
  if (Buffer.byteLength(normalized, 'utf-8') > maxBytes) fail('INVALID_REQUEST', `${key} exceeds ${maxBytes} bytes`);
  return normalized;
}

function requireNullableTaskId(value, key) {
  if (value === null) return null;
  if (!isValidTaskId(value)) fail('INVALID_REQUEST', `${key} must be null or a valid task id`);
  return value;
}

function requireSafeRevision(value, key, minimum) {
  if (!Number.isSafeInteger(value) || value < minimum)
    fail('INVALID_REQUEST', `${key} must be a safe integer >= ${minimum}`);
  return value;
}

function requireExpected(request, needsTaskRevision) {
  const expected = request.expected;
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) {
    fail('INVALID_REQUEST', 'expected is required');
  }
  const stateId = expected.stateId === null ? null : requireString(expected, 'stateId', 64);
  const stateRevision = requireSafeRevision(expected.stateRevision, 'expected.stateRevision', 0);
  const bindingRevision = requireSafeRevision(expected.bindingRevision, 'expected.bindingRevision', 0);
  const activeTaskId = requireNullableTaskId(expected.activeTaskId, 'expected.activeTaskId');
  const result = { stateId, stateRevision, bindingRevision, activeTaskId };
  if (needsTaskRevision) result.taskRevision = requireSafeRevision(expected.taskRevision, 'expected.taskRevision', 1);
  return result;
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function assertRuntimePath(projectRoot, relativePath, options) {
  const result = validateRuntimePath(projectRoot, relativePath, options);
  if (!result.ok) fail('PATH_INVALID', result.message, null, 3);
  return result;
}

function ensureRuntimeDirectory(projectRoot, relativePath) {
  const before = assertRuntimePath(projectRoot, `${relativePath}/.probe`, { allowMissing: true });
  const directory = path.dirname(before.path);
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  } catch (error) {
    fail(
      'IO_ERROR',
      `Cannot create runtime directory ${relativePath}: ${error instanceof Error ? error.message : String(error)}`,
      null,
      3
    );
  }
  const after = assertRuntimePath(projectRoot, relativePath, { kind: 'directory' });
  return after.path;
}

function processExists(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && error.code === 'EPERM');
  }
}

function readLockOwner(lockPath) {
  const source = readFileBounded(lockPath, 4096);
  if (!source.ok || source.truncated) return null;
  try {
    const value = JSON.parse(source.content);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

function removeStaleLock(lockPath) {
  try {
    const stat = fs.lstatSync(lockPath);
    if (!stat.isFile() || stat.isSymbolicLink() || Date.now() - stat.mtimeMs < LOCK_STALE_MS) return false;
    const owner = readLockOwner(lockPath);
    if (owner && processExists(owner.pid)) return false;
    const nonce = owner && owner.nonce;
    const current = readLockOwner(lockPath);
    if ((current && current.nonce) !== nonce) return false;
    fs.unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

function acquireLock(projectRoot) {
  const ccgDir = ensureRuntimeDirectory(projectRoot, '.ccg');
  const lockPath = assertRuntimePath(projectRoot, '.ccg/state.lock', { allowMissing: true, kind: 'file' }).path;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const nonce = randomUUID();
    let fd;
    try {
      fd = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeFileSync(
        fd,
        `${JSON.stringify({ pid: process.pid, nonce, createdAt: new Date().toISOString() })}\n`,
        'utf-8'
      );
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fsyncDirectory(ccgDir);
      return { lockPath, nonce };
    } catch (error) {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          // The lock acquisition error remains authoritative.
        }
      }
      if (!error || error.code !== 'EEXIST') {
        fail('IO_ERROR', `Cannot create task state lock: ${lockPath}`, null, 3);
      }
      if (!removeStaleLock(lockPath)) sleep(LOCK_RETRY_MS);
    }
  }
  fail('LOCK_TIMEOUT', `Task state is locked: ${lockPath}`, null, 3);
}

function releaseLock(lock) {
  try {
    const owner = readLockOwner(lock.lockPath);
    if (owner && owner.nonce === lock.nonce) {
      fs.unlinkSync(lock.lockPath);
      fsyncDirectory(path.dirname(lock.lockPath));
    }
  } catch {
    // A later operation will surface a lock that could not be released.
  }
}

function withStateLock(projectRoot, callback, options) {
  const lock = acquireLock(projectRoot);
  try {
    const pending = readPendingTransaction(projectRoot);
    if (!pending.ok) fail(pending.code, pending.message, null, 3);
    if (pending.exists && !(options && options.allowPendingTransaction)) {
      fail('RECOVERY_REQUIRED', 'An incomplete task transaction must be recovered before another mutation');
    }
    return callback(pending);
  } finally {
    releaseLock(lock);
  }
}

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

function writeState(projectRoot, state) {
  try {
    const statePath = assertRuntimePath(projectRoot, '.ccg/state.json', { allowMissing: true, kind: 'file' }).path;
    atomicWriteJson(statePath, state);
  } catch (error) {
    fail('IO_ERROR', `Cannot write state.json: ${error instanceof Error ? error.message : String(error)}`, null, 3);
  }
}

function bindingForWrite(binding) {
  const result = { ...binding };
  delete result.path;
  delete result.sessionKey;
  return result;
}

function writeBinding(projectRoot, sessionKey, binding) {
  const bindingPath = getBindingPath(projectRoot, sessionKey);
  if (!bindingPath) fail('SESSION_KEY_INVALID', 'Cannot write an invalid session binding');
  try {
    assertRuntimePath(projectRoot, `.ccg/sessions/${sessionKey}.json`, { allowMissing: true, kind: 'file' });
    atomicWriteJson(bindingPath, bindingForWrite(binding));
  } catch (error) {
    fail(
      'IO_ERROR',
      `Cannot write session binding: ${error instanceof Error ? error.message : String(error)}`,
      null,
      3
    );
  }
}

function taskForWrite(task) {
  const result = { ...task };
  delete result.dir;
  return result;
}

function writeTask(projectRoot, task) {
  if (!isValidTaskId(task.id)) fail('TASK_INVALID', `Invalid task id: ${task.id}`);
  const taskPath = assertRuntimePath(projectRoot, `.ccg/tasks/${task.id}/task.json`, {
    allowMissing: true,
    kind: 'file',
  }).path;
  try {
    atomicWriteJson(taskPath, taskForWrite(task));
  } catch (error) {
    fail(
      'IO_ERROR',
      `Cannot write task ${task.id}: ${error instanceof Error ? error.message : String(error)}`,
      null,
      3
    );
  }
}

function transactionWrite(projectRoot, targetPath, content) {
  const relativePath = path.relative(projectRoot, targetPath).replace(/\\/g, '/');
  assertRuntimePath(projectRoot, relativePath, { allowMissing: true, kind: 'file' });
  return { path: relativePath, content };
}

function jsonContent(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function applyTaskTransaction(projectRoot, pending) {
  const transaction = pending.transaction;
  try {
    for (const write of transaction.writes) {
      const location = assertRuntimePath(projectRoot, write.path, { allowMissing: true, kind: 'file' });
      atomicWriteFile(location.path, write.content);
    }
    fs.unlinkSync(pending.path);
    fsyncDirectory(path.dirname(pending.path));
  } catch (error) {
    if (error instanceof TaskStateError) throw error;
    fail(
      'IO_ERROR',
      `Cannot complete ${transaction.operation} transaction: ${error instanceof Error ? error.message : String(error)}`,
      null,
      3
    );
  }
}

function runTaskTransaction(projectRoot, operation, taskId, writes, options) {
  const preparedWrites = writes.map((write) => transactionWrite(projectRoot, write.path, write.content));
  const transaction = {
    schemaVersion: 1,
    transactionId: randomUUID(),
    operation,
    taskId,
    ...(options && options.sessionKey ? { sessionKey: options.sessionKey } : {}),
    createdAt: new Date().toISOString(),
    writes: preparedWrites.map(({ path: relativePath, content }) => ({ path: relativePath, content })),
  };
  const serialized = jsonContent(transaction);
  if (Buffer.byteLength(serialized, 'utf-8') > TRANSACTION_FILE_LIMIT) {
    fail('TRANSACTION_TOO_LARGE', `Task transaction exceeds ${TRANSACTION_FILE_LIMIT} bytes`);
  }
  const markerPath = assertRuntimePath(projectRoot, '.ccg/transaction.json', {
    allowMissing: true,
    kind: 'file',
  }).path;
  try {
    atomicWriteFile(markerPath, serialized);
  } catch (error) {
    fail(
      'IO_ERROR',
      `Cannot create task transaction: ${error instanceof Error ? error.message : String(error)}`,
      null,
      3
    );
  }
  const pending = readPendingTransaction(projectRoot);
  if (!pending.ok || !pending.exists) {
    fail(pending.code || 'TRANSACTION_INVALID', pending.message || 'Task transaction was not persisted', null, 3);
  }
  if (pending.transaction.transactionId !== transaction.transactionId) {
    fail('TRANSACTION_CONFLICT', 'Task transaction identity changed before commit', null, 3);
  }
  applyTaskTransaction(projectRoot, pending);
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
  return `# Progress\n\nUpdated: ${new Date().toISOString()}\n\n## Current\n\n- ${note || task.nextAction}\n\n## Next\n\n- ${task.nextAction}\n`;
}

function validateTextContent(value, key, maxBytes, required) {
  if (typeof value !== 'string') {
    if (required) fail('INVALID_REQUEST', `${key} must be a string`);
    return null;
  }
  if (required && !value.trim()) fail('INVALID_REQUEST', `${key} must not be empty`);
  if (Buffer.byteLength(value, 'utf-8') > maxBytes) fail('INVALID_REQUEST', `${key} exceeds ${maxBytes} bytes`);
  return value.endsWith('\n') ? value : `${value}\n`;
}

function truncateUtf8ToBytes(value, maxBytes) {
  const text = String(value || '');
  if (Buffer.byteLength(text, 'utf-8') <= maxBytes) return text;
  let result = '';
  let bytes = 0;
  for (const character of text) {
    const characterBytes = Buffer.byteLength(character, 'utf-8');
    if (bytes + characterBytes > maxBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

function validateTaskInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_REQUEST', 'task must be an object');
  const id = requireString(input, 'id', 80);
  if (!isValidTaskId(id)) fail('INVALID_REQUEST', 'task.id must use strict kebab-case and be at most 80 characters');
  const complexity = requireString(input, 'complexity', 2);
  if (!['S', 'M', 'L', 'XL'].includes(complexity)) fail('INVALID_REQUEST', 'task.complexity must be S, M, L, or XL');
  const risk = requireString(input, 'risk', 6);
  if (!['low', 'medium', 'high'].includes(risk)) fail('INVALID_REQUEST', 'task.risk must be low, medium, or high');
  const specEvolution = input.specEvolution === undefined ? 'pending' : requireString(input, 'specEvolution', 32);
  if (!VALID_SPEC_EVOLUTION.has(specEvolution)) fail('INVALID_REQUEST', 'task.specEvolution is invalid');
  const gate = input.gate === undefined || input.gate === null ? null : requireString(input, 'gate', 256);
  return {
    id,
    title: requireString(input, 'title', 240),
    strategy: requireString(input, 'strategy', 80),
    complexity,
    risk,
    domain: requireString(input, 'domain', 64),
    scope: requireString(input, 'scope', 1024),
    currentPhase: requireString(input, 'currentPhase', 64),
    nextAction: requireString(input, 'nextAction', 1024),
    gate,
    specEvolution,
  };
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

function operationStart(projectRoot, sessionKey, request) {
  const expected = requireExpected(request, false);
  const mode = requireString(request, 'mode', 16);
  if (!VALID_START_MODES.has(mode)) fail('INVALID_REQUEST', 'mode must be activate, interrupt, replace, or inactive');
  const taskInput = validateTaskInput(request.task);
  const requirements = validateTextContent(request.requirements, 'requirements', REQUIREMENTS_LIMIT, true);

  return withStateLock(projectRoot, () => {
    ensureTaskRuntimeIgnored(projectRoot);
    const stateResult = assertStateReadable(readState(projectRoot));
    assertExpectedState(stateResult, expected);
    const bindingResult = assertStateReadable(readBinding(projectRoot, sessionKey, stateResult.state.stateId));
    if (!stateResult.exists && bindingResult.exists)
      fail('BINDING_INVALID', 'A session binding exists without task state');
    assertExpectedBinding(bindingResult, expected, stateResult.state);
    if (!stateResult.exists) {
      const existing = listTasks(projectRoot, { allowLegacy: true });
      if (!existing.ok) fail(existing.code, existing.message);
      if (existing.tasks.length > 0 || existing.orphans.length > 0) {
        fail('TASK_MIGRATION_REQUIRED', 'Existing task directories require explicit migration');
      }
    }

    let activeTask = null;
    if (bindingResult.binding.activeTaskId) {
      activeTask = assertTaskReadable(readTask(projectRoot, bindingResult.binding.activeTaskId));
      assertOpenTask(activeTask);
      const chain = inspectReturnChain(projectRoot, activeTask.returnToTaskId);
      if (!chain.ok) fail(chain.code, chain.message);
    }
    if (mode === 'activate' && activeTask) fail('ACTIVE_TASK_CONFLICT', 'activate mode requires no active task');
    if ((mode === 'interrupt' || mode === 'replace') && !activeTask) {
      fail('ACTIVE_TASK_CONFLICT', `${mode} mode requires an active task`);
    }

    const destination = assertRuntimePath(projectRoot, `.ccg/tasks/${taskInput.id}`, {
      allowMissing: true,
      kind: 'directory',
    });
    if (destination.exists) fail('TASK_EXISTS', `Task already exists: ${taskInput.id}`);

    const now = new Date().toISOString();
    const git = getGitInfo(projectRoot);
    const task = {
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
    return {
      state,
      binding,
      task,
      effectiveStatus: mode === 'inactive' ? 'suspended' : 'in_progress',
    };
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

function operationCheckpoint(projectRoot, sessionKey, request) {
  const currentPhase = requireString(request, 'currentPhase', 64);
  const nextAction = requireString(request, 'nextAction', 1024);
  const gate = request.gate === null ? null : requireString(request, 'gate', 256);
  const progress = validateTextContent(request.progress, 'progress', ARTIFACT_LIMIT, false);
  return withStateLock(projectRoot, () => {
    const { state, binding, task } = assertActiveMutation(projectRoot, sessionKey, request);
    const nextTask = bumpTask(task, { currentPhase, nextAction, gate });
    if (progress !== null) {
      runTaskTransaction(projectRoot, 'checkpoint', task.id, [
        { path: path.join(task.dir, 'progress.md'), content: progress },
        { path: getTaskPath(projectRoot, task.id), content: jsonContent(taskForWrite(nextTask)) },
      ]);
    } else {
      writeTask(projectRoot, nextTask);
    }
    return { state, binding, task: nextTask };
  });
}

function operationUpdateRequirements(projectRoot, sessionKey, request) {
  const content = validateTextContent(request.content, 'content', REQUIREMENTS_LIMIT, true);
  return withStateLock(projectRoot, () => {
    const { state, binding, task } = assertActiveMutation(projectRoot, sessionKey, request);
    const nextTask = bumpTask(task, {});
    runTaskTransaction(projectRoot, 'update-requirements', task.id, [
      { path: path.join(task.dir, 'requirements.md'), content },
      { path: getTaskPath(projectRoot, task.id), content: jsonContent(taskForWrite(nextTask)) },
    ]);
    return { state, binding, task: nextTask };
  });
}

function ensureResearchDirectory(task) {
  const researchDir = path.join(task.dir, 'research');
  try {
    if (!fs.existsSync(researchDir)) {
      fs.mkdirSync(researchDir, { mode: 0o700 });
      fsyncDirectory(task.dir);
    }
    const stat = fs.lstatSync(researchDir);
    if (stat.isSymbolicLink() || !stat.isDirectory())
      fail('PATH_INVALID', 'Task research path must be a regular directory');
    const taskReal = fs.realpathSync(task.dir);
    const researchReal = fs.realpathSync(researchDir);
    const relative = path.relative(taskReal, researchReal);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      fail('PATH_INVALID', 'Task research path escapes the task directory');
    }
    return researchDir;
  } catch (error) {
    if (error instanceof TaskStateError) throw error;
    fail(
      'IO_ERROR',
      `Cannot prepare task research directory: ${error instanceof Error ? error.message : String(error)}`,
      null,
      3
    );
  }
}

function resolveArtifactPath(task, request) {
  const kind = requireString(request, 'kind', 64);
  if (VALID_ARTIFACTS.has(kind)) return path.join(task.dir, VALID_ARTIFACTS.get(kind));
  if (kind === 'research') {
    const name = requireString(request, 'name', 80);
    if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*\.md$/.test(name) || name.includes('..')) {
      fail('INVALID_REQUEST', 'research artifact name must be a safe Markdown filename');
    }
    return path.join(ensureResearchDirectory(task), name);
  }
  fail('INVALID_REQUEST', 'kind must be analysis, plan, review, or research');
}

function operationWriteArtifact(projectRoot, sessionKey, request) {
  const content = validateTextContent(request.content, 'content', ARTIFACT_LIMIT, true);
  return withStateLock(projectRoot, () => {
    const { state, binding, task } = assertActiveMutation(projectRoot, sessionKey, request);
    const target = resolveArtifactPath(task, request);
    const nextTask = bumpTask(task, {});
    runTaskTransaction(projectRoot, 'write-artifact', task.id, [
      { path: target, content },
      { path: getTaskPath(projectRoot, task.id), content: jsonContent(taskForWrite(nextTask)) },
    ]);
    return { state, binding, task: nextTask, path: path.relative(projectRoot, target).replace(/\\/g, '/') };
  });
}

function operationLinkSpec(projectRoot, sessionKey, request) {
  const specRef = request.specRef;
  return withStateLock(projectRoot, () => {
    const { state, binding, task } = assertActiveMutation(projectRoot, sessionKey, request);
    const validated = validateSpecRef(projectRoot, specRef, { requireSection: true });
    if (!validated.ok) fail(validated.code, validated.message);
    const duplicate = task.specRefs.some(
      (ref) => ref.path === validated.ref.path && ref.section === validated.ref.section
    );
    if (duplicate) return { state, binding, task, linked: false };
    if (task.specRefs.length >= 32) fail('INVALID_REQUEST', 'A task may link at most 32 spec sections');
    const specRefs = [...task.specRefs, validated.ref];
    const collected = collectSpecContext(projectRoot, specRefs, 'all');
    if (!collected.ok) fail(collected.code, collected.message);
    const nextTask = bumpTask(task, { specRefs });
    writeTask(projectRoot, nextTask);
    return { state, binding, task: nextTask, linked: true };
  });
}

function operationUnlinkSpec(projectRoot, sessionKey, request) {
  const specPath = requireString(request, 'path', 1024).replace(/\\/g, '/');
  const section = requireString(request, 'section', 240);
  return withStateLock(projectRoot, () => {
    const { state, binding, task } = assertActiveMutation(projectRoot, sessionKey, request);
    const specRefs = task.specRefs.filter((ref) => !(ref.path === specPath && ref.section === section));
    if (specRefs.length === task.specRefs.length) return { state, binding, task, unlinked: false };
    const nextTask = bumpTask(task, { specRefs });
    writeTask(projectRoot, nextTask);
    return { state, binding, task: nextTask, unlinked: true };
  });
}

function operationSetSpecEvolution(projectRoot, sessionKey, request) {
  const value = requireString(request, 'value', 32);
  if (!VALID_SPEC_EVOLUTION.has(value)) fail('INVALID_REQUEST', 'value is not a valid spec evolution result');
  return withStateLock(projectRoot, () => {
    const { state, binding, task } = assertActiveMutation(projectRoot, sessionKey, request);
    if (task.specEvolution === value) return { state, binding, task, changed: false };
    const nextTask = bumpTask(task, { specEvolution: value });
    writeTask(projectRoot, nextTask);
    return { state, binding, task: nextTask, changed: true };
  });
}

function findReturnTarget(projectRoot, startTaskId) {
  const chain = inspectReturnChain(projectRoot, startTaskId);
  if (!chain.ok) fail(chain.code, chain.message);
  return chain.chain.find((task) => task.status === 'open') || null;
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

function operationRecover(projectRoot, sessionKey, request) {
  const expected = requireExpected(request, false);
  return withStateLock(
    projectRoot,
    (pending) => {
      const stateResult = assertStateReadable(readState(projectRoot));
      assertExpectedState(stateResult, expected);
      const bindingResult = assertStateReadable(readBinding(projectRoot, sessionKey, stateResult.state.stateId));
      assertExpectedBinding(bindingResult, expected, stateResult.state);

      if (pending.exists) {
        const transaction = pending.transaction;
        applyTaskTransaction(projectRoot, pending);
        const recoveredState = assertStateReadable(readState(projectRoot));
        if (!recoveredState.exists) fail('TRANSACTION_INVALID', 'Recovered transaction did not initialize state.json');
        const recoveredBinding = assertStateReadable(
          readBinding(projectRoot, sessionKey, recoveredState.state.stateId)
        );
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
    },
    { allowPendingTransaction: true }
  );
}

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
  const context = readContextJsonl(taskResult.taskDir);
  diagnostics.push(...context.diagnostics.map((item) => `${taskResult.task.id}:${item}`));
  for (const entry of context.entries) {
    if (typeof entry.file !== 'string' || entry.file.startsWith('.ccg/spec/') || !entry.section) {
      diagnostics.push(`LEGACY_CONTEXT_SKIPPED:${taskResult.task.id}:${entry.line}`);
      continue;
    }
    const candidate = {
      path: entry.file,
      section: entry.section,
      purpose: entry.purpose || entry.reason || 'Legacy task context',
      ...(Array.isArray(entry.roles) ? { roles: entry.roles.filter((role) => role !== 'all') } : {}),
    };
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
  return refs.slice(0, 32);
}

function filesHaveSameBytes(leftPath, rightPath, size) {
  let left;
  let right;
  try {
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
    left = fs.openSync(leftPath, flags);
    right = fs.openSync(rightPath, flags);
    if (!fs.fstatSync(left).isFile() || !fs.fstatSync(right).isFile()) return false;
    const leftBuffer = Buffer.alloc(64 * 1024);
    const rightBuffer = Buffer.alloc(64 * 1024);
    for (let offset = 0; offset < size;) {
      const length = Math.min(leftBuffer.length, size - offset);
      const leftBytes = fs.readSync(left, leftBuffer, 0, length, offset);
      const rightBytes = fs.readSync(right, rightBuffer, 0, length, offset);
      if (
        leftBytes !== length ||
        rightBytes !== length ||
        !leftBuffer.subarray(0, length).equals(rightBuffer.subarray(0, length))
      ) {
        return false;
      }
      offset += length;
    }
    return true;
  } finally {
    if (left !== undefined) {
      try {
        fs.closeSync(left);
      } catch {
        // A read or comparison result is already available.
      }
    }
    if (right !== undefined) {
      try {
        fs.closeSync(right);
      } catch {
        // A read or comparison result is already available.
      }
    }
  }
}

function copyFileBackup(projectRoot, sourcePath, destinationPath) {
  let sourceStat;
  try {
    sourceStat = fs.lstatSync(sourcePath);
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    fail('MIGRATION_BACKUP_FAILED', `Cannot inspect migration source: ${sourcePath}`, null, 3);
  }
  if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) {
    fail('MIGRATION_BACKUP_FAILED', `Migration source is not a regular file: ${sourcePath}`, null, 3);
  }
  const relativeDestination = path.relative(projectRoot, destinationPath).replace(/\\/g, '/');
  assertRuntimePath(projectRoot, relativeDestination, { allowMissing: true, kind: 'file' });
  if (fs.existsSync(destinationPath)) {
    const destinationStat = fs.lstatSync(destinationPath);
    if (destinationStat.isSymbolicLink() || !destinationStat.isFile()) {
      fail('MIGRATION_BACKUP_FAILED', `Migration backup is not a regular file: ${destinationPath}`, null, 3);
    }
    if (destinationStat.size !== sourceStat.size || !filesHaveSameBytes(sourcePath, destinationPath, sourceStat.size)) {
      fail('MIGRATION_BACKUP_CONFLICT', `Existing migration backup does not match source: ${destinationPath}`, null, 3);
    }
    return false;
  }
  try {
    fs.copyFileSync(sourcePath, destinationPath, fs.constants.COPYFILE_EXCL);
    fsyncDirectory(path.dirname(destinationPath));
    return true;
  } catch (error) {
    fail(
      'MIGRATION_BACKUP_FAILED',
      `Cannot create migration backup: ${error instanceof Error ? error.message : String(error)}`,
      null,
      3
    );
  }
}

function backupLegacyTask(projectRoot, taskResult) {
  const backupDir = ensureRuntimeDirectory(projectRoot, `.ccg/migrations/v1/${taskResult.task.id}`);
  for (const name of ['task.json', 'context.jsonl', 'requirements.md', 'progress.md']) {
    copyFileBackup(projectRoot, path.join(taskResult.taskDir, name), path.join(backupDir, name));
  }
}

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
  const target = transition && transition.targetState;
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
    transition.sourceStateRevision < 0 ||
    !target ||
    typeof target !== 'object' ||
    Array.isArray(target) ||
    target.schemaVersion !== STATE_SCHEMA_VERSION ||
    typeof target.stateId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(target.stateId) ||
    !Number.isSafeInteger(target.revision) ||
    target.revision !== transition.sourceStateRevision + 1 ||
    !Number.isFinite(Date.parse(target.updatedAt)) ||
    Object.prototype.hasOwnProperty.call(target, 'activeTaskId')
  ) {
    fail('MIGRATION_MANIFEST_INVALID', 'Migration manifest state transition is invalid');
  }
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

function migrateOneTask(projectRoot, taskResult, diagnostics) {
  if (!taskResult.legacy) return taskResult.task;
  backupLegacyTask(projectRoot, taskResult);
  const raw = taskResult.raw;
  const now = new Date().toISOString();
  const git = getGitInfo(projectRoot);
  const status = normalizeLegacyTaskStatus(raw.status);
  if (!status) fail('TASK_INVALID', `Legacy task status is invalid: ${taskResult.task.id}`);
  const title =
    typeof raw.title === 'string' && raw.title.trim() ? truncateUtf8ToBytes(raw.title.trim(), 240) : taskResult.task.id;
  const returnToTaskId = raw.returnToTaskId || null;
  const legacyBranch =
    typeof taskResult.task.branchAtCreation === 'string' && taskResult.task.branchAtCreation.trim()
      ? taskResult.task.branchAtCreation.trim()
      : git.branch === 'HEAD' || git.branch === 'unknown'
        ? null
        : git.branch;
  const task = {
    schemaVersion: TASK_SCHEMA_VERSION,
    revision: 1,
    id: taskResult.task.id,
    title,
    status,
    strategy:
      typeof raw.strategy === 'string' && raw.strategy.trim()
        ? truncateUtf8ToBytes(raw.strategy.trim(), 80)
        : 'guided-develop',
    complexity: ['S', 'M', 'L', 'XL'].includes(raw.complexity) ? raw.complexity : 'M',
    risk: ['low', 'medium', 'high'].includes(raw.risk) ? raw.risk : 'medium',
    domain:
      typeof raw.domain === 'string' && raw.domain.trim() ? truncateUtf8ToBytes(raw.domain.trim(), 64) : 'general',
    scope: typeof raw.scope === 'string' && raw.scope.trim() ? truncateUtf8ToBytes(raw.scope.trim(), 1024) : title,
    currentPhase: truncateUtf8ToBytes(String(raw.currentPhase || '1').trim(), 64) || '1',
    nextAction: truncateUtf8ToBytes(String(raw.nextAction || 'Continue the task').trim(), 1024) || 'Continue the task',
    gate: typeof raw.gate === 'string' && raw.gate.trim() ? truncateUtf8ToBytes(raw.gate.trim(), 256) : null,
    returnToTaskId,
    specEvolution: VALID_SPEC_EVOLUTION.has(raw.specEvolution) ? raw.specEvolution : 'pending',
    specRefs: canonicalizeLegacySpecRefs(projectRoot, taskResult, diagnostics),
    branchAtCreation: legacyBranch === null ? null : truncateUtf8ToBytes(legacyBranch, 512),
    headAtCreation: /^[0-9a-f]{40}$/i.test(taskResult.task.headAtCreation || '')
      ? taskResult.task.headAtCreation
      : git.commit,
    createdAt: Number.isFinite(Date.parse(raw.createdAt)) ? raw.createdAt : now,
    updatedAt: now,
    finishedAt:
      status === 'open'
        ? null
        : Number.isFinite(Date.parse(raw.finishedAt || raw.completedAt))
          ? raw.finishedAt || raw.completedAt
          : now,
  };
  const canonicalError = validateCanonicalTask(task, task.id);
  if (canonicalError) fail('TASK_INVALID', `${canonicalError}: ${task.id}`);
  const requirementsPath = path.join(taskResult.taskDir, 'requirements.md');
  const requirements = readFileBounded(requirementsPath, REQUIREMENTS_LIMIT);
  if (!requirements.ok && requirements.code === 'NOT_FOUND') {
    atomicWriteFile(requirementsPath, `# Requirements\n\n## Objective\n\n${title}\n\n## Scope\n\n${task.scope}\n`);
  } else if (!requirements.ok || requirements.truncated || !requirements.content.trim()) {
    fail('TASK_CONTRACT_INVALID', `Legacy requirements.md is invalid: ${task.id}`);
  }
  const progressPath = path.join(taskResult.taskDir, 'progress.md');
  if (!fs.existsSync(progressPath)) atomicWriteFile(progressPath, generatedProgress(task, 'Legacy task migrated'));
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

    const diagnostics = [];
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

    let status;
    if (repair === 'canonical-in-progress') {
      if (current.raw.schemaVersion !== TASK_SCHEMA_VERSION || current.raw.status !== 'in_progress') {
        fail('STATUS_REPAIR_NOT_APPLICABLE', `Task is not a schema v1 in_progress task: ${taskId}`);
      }
      if (current.raw.finishedAt !== null) {
        fail('STATUS_REPAIR_NOT_APPLICABLE', `in_progress task has a terminal timestamp: ${taskId}`);
      }
      status = 'open';
    } else if (repair === 'superseded-completed') {
      if (current.raw.schemaVersion !== TASK_SCHEMA_VERSION || current.raw.status !== 'completed') {
        fail('STATUS_REPAIR_NOT_APPLICABLE', `Task is not a schema v1 completed task: ${taskId}`);
      }
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
      status = 'cancelled';
    } else {
      fail('INVALID_REQUEST', 'repair must be canonical-in-progress or superseded-completed');
    }

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
  if (
    existing.manifest.schemaVersion !== 1 ||
    !Array.isArray(existing.manifest.entries) ||
    !isValidManifestTimestamp(existing.manifest.createdAt) ||
    !isValidManifestTimestamp(existing.manifest.updatedAt) ||
    (existing.manifest.stateApplied !== undefined && typeof existing.manifest.stateApplied !== 'boolean')
  ) {
    fail('MIGRATION_MANIFEST_INVALID', 'Orphan manifest has an invalid structure');
  }
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
    const known = new Map(manifestState.manifest.entries.map((entry) => [entry.name, entry]));
    for (const name of listed.orphans) {
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
    if (listed.orphans.length > 0) {
      manifestState.manifest.stateApplied = false;
      manifestState.manifest.stateTransition = null;
    }
    manifestState.manifest.updatedAt = new Date().toISOString();
    atomicWriteJson(manifestState.path, manifestState.manifest);

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
  const tracked = trackTurn(resolution.task.dir, sessionKey, resolution.task.currentPhase, resolution.task.nextAction);
  if (!tracked.ok) fail(tracked.code, 'Cannot record session turn', null, 3);
  return {
    state: resolution.state,
    binding: resolution.binding,
    task: resolution.task,
    loop: detectLoop(tracked.turns, 3),
  };
}

function execute(operation, options, request) {
  const projectRoot = resolveRoot(options);
  const sessionKey = resolveSessionKey(options);
  switch (operation) {
    case 'resolve':
      return operationResolve(projectRoot, sessionKey);
    case 'snapshot':
      return operationSnapshot(projectRoot, sessionKey, options);
    case 'list':
      return operationList(projectRoot, sessionKey);
    case 'start':
    case 'create':
      return operationStart(projectRoot, sessionKey, request);
    case 'activate':
      return operationActivate(projectRoot, sessionKey, request);
    case 'takeover':
      return operationTakeover(projectRoot, sessionKey, request);
    case 'update-requirements':
      return operationUpdateRequirements(projectRoot, sessionKey, request);
    case 'checkpoint':
      return operationCheckpoint(projectRoot, sessionKey, request);
    case 'write-artifact':
      return operationWriteArtifact(projectRoot, sessionKey, request);
    case 'link-spec':
      return operationLinkSpec(projectRoot, sessionKey, request);
    case 'unlink-spec':
      return operationUnlinkSpec(projectRoot, sessionKey, request);
    case 'set-spec-evolution':
      return operationSetSpecEvolution(projectRoot, sessionKey, request);
    case 'finish':
      return operationFinish(projectRoot, sessionKey, request);
    case 'recover':
      return operationRecover(projectRoot, sessionKey, request);
    case 'preflight-legacy':
      return operationPreflightLegacy(projectRoot);
    case 'migrate-state':
      return operationMigrateState(projectRoot, request);
    case 'migrate-legacy':
    case 'migrate':
      return operationMigrateLegacy(projectRoot, sessionKey, request);
    case 'repair-status':
      return operationRepairStatus(projectRoot, sessionKey, request);
    case 'quarantine-orphans':
      return operationQuarantineOrphans(projectRoot, sessionKey, request);
    case 'restore-orphans':
      return operationRestoreOrphans(projectRoot, sessionKey, request);
    case 'record-turn':
      return operationRecordTurn(projectRoot, sessionKey, request);
    default:
      fail('INVALID_REQUEST', `Unknown operation: ${operation}`);
  }
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
  process.stdout.write(
    `${JSON.stringify({ ok: false, code: taskError.code, message: taskError.message, current: taskError.current, diagnostics: [taskError.code] })}\n`
  );
  process.exitCode = taskError.exitCode;
}

function main() {
  try {
    const { operation, options } = parseArgs(process.argv.slice(2));
    const request = readRequest(operationRequiresRequest(operation));
    outputSuccess(operation, execute(operation, options, request));
  } catch (error) {
    outputFailure(error);
  }
}

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
