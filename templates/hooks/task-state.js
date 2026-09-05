#!/usr/bin/env node
// CCG Persistent Task State Controller
// All task lifecycle mutations pass through this script.

'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const {
  STATE_SCHEMA_VERSION,
  TASK_SCHEMA_VERSION,
  TRANSACTION_FILE_LIMIT,
  findProjectRoot,
  isValidTaskId,
  getStatePath,
  getTaskPath,
  validateRuntimePath,
  readFileBounded,
  readPendingTransaction,
  readState,
  readTask,
  listTasks,
  resolveTaskState,
  buildTaskSnapshot,
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
  const allowed = new Set(['root', 'mode', 'role']);
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
  const activeTaskId = requireNullableTaskId(expected.activeTaskId, 'expected.activeTaskId');
  const result = { stateId, stateRevision, activeTaskId };
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

function assertExpectedState(stateResult, expected) {
  const state = stateResult.state;
  if (expected.stateId !== state.stateId) {
    fail('STATE_ID_CONFLICT', 'Task state identity changed', {
      stateId: state.stateId,
      stateRevision: state.revision,
      activeTaskId: state.activeTaskId,
    });
  }
  if (expected.stateRevision !== state.revision) {
    fail('REVISION_CONFLICT', 'Task state revision changed', {
      stateId: state.stateId,
      stateRevision: state.revision,
      activeTaskId: state.activeTaskId,
    });
  }
  if (expected.activeTaskId !== state.activeTaskId) {
    fail('ACTIVE_TASK_CONFLICT', 'Active task changed', {
      stateId: state.stateId,
      stateRevision: state.revision,
      activeTaskId: state.activeTaskId,
    });
  }
}

function assertTaskRevision(task, expectedRevision) {
  if (task.revision !== expectedRevision) {
    fail('REVISION_CONFLICT', 'Task revision changed', { taskId: task.id, taskRevision: task.revision });
  }
}

function assertOpenTask(task) {
  if (task.status !== 'open')
    fail('TASK_NOT_OPEN', `Task is not open: ${task.id}`, { taskId: task.id, status: task.status });
}

function assertActiveMutation(projectRoot, request) {
  const expected = requireExpected(request, true);
  const stateResult = assertStateReadable(readState(projectRoot));
  if (!stateResult.exists) fail('TASK_MIGRATION_REQUIRED', 'Initialize task state before mutation');
  assertExpectedState(stateResult, expected);
  if (!stateResult.state.activeTaskId) fail('ACTIVE_TASK_CONFLICT', 'No task is active');
  const task = assertTaskReadable(readTask(projectRoot, stateResult.state.activeTaskId));
  assertOpenTask(task);
  assertTaskRevision(task, expected.taskRevision);
  return { state: stateResult.state, task, expected };
}

function writeState(projectRoot, state) {
  try {
    const statePath = assertRuntimePath(projectRoot, '.ccg/state.json', { allowMissing: true, kind: 'file' }).path;
    atomicWriteJson(statePath, state);
  } catch (error) {
    fail('IO_ERROR', `Cannot write state.json: ${error instanceof Error ? error.message : String(error)}`, null, 3);
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

function runTaskTransaction(projectRoot, operation, taskId, writes) {
  const preparedWrites = writes.map((write) => transactionWrite(projectRoot, write.path, write.content));
  const transaction = {
    schemaVersion: 1,
    transactionId: randomUUID(),
    operation,
    taskId,
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

function makeState(previousState, activeTaskId) {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    stateId: previousState.stateId || randomUUID(),
    revision: previousState.revision + 1,
    activeTaskId,
    updatedAt: new Date().toISOString(),
  };
}

function bumpTask(task, patch) {
  if (task.revision >= Number.MAX_SAFE_INTEGER) fail('REVISION_CONFLICT', `Task revision overflow: ${task.id}`);
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

function writeTaskStaging(projectRoot, task, requirements, progress) {
  const tasksDir = ensureRuntimeDirectory(projectRoot, '.ccg/tasks');
  const tempRoot = ensureRuntimeDirectory(projectRoot, '.ccg/tmp');
  const stageName = `${task.id}.${randomUUID()}`;
  const stageDir = assertRuntimePath(projectRoot, `.ccg/tmp/${stageName}`, { allowMissing: true }).path;
  const destinationResult = assertRuntimePath(projectRoot, `.ccg/tasks/${task.id}`, {
    allowMissing: true,
    kind: 'directory',
  });
  const destination = destinationResult.path;
  if (destinationResult.exists) fail('TASK_EXISTS', `Task already exists: ${task.id}`);
  let renamed = false;
  try {
    fs.mkdirSync(stageDir, { mode: 0o700 });
    assertRuntimePath(projectRoot, `.ccg/tmp/${stageName}`, { kind: 'directory' });
    atomicWriteFile(path.join(stageDir, 'requirements.md'), requirements);
    atomicWriteFile(path.join(stageDir, 'progress.md'), progress);
    atomicWriteJson(path.join(stageDir, 'task.json'), taskForWrite(task));
    fs.renameSync(stageDir, destination);
    renamed = true;
    assertRuntimePath(projectRoot, `.ccg/tasks/${task.id}`, { kind: 'directory' });
    fsyncDirectory(tasksDir);
  } catch (error) {
    if (error instanceof TaskStateError) throw error;
    fail(
      'IO_ERROR',
      `Cannot create task ${task.id}: ${error instanceof Error ? error.message : String(error)}`,
      null,
      3
    );
  } finally {
    if (!renamed) {
      try {
        fs.rmSync(stageDir, { recursive: true, force: true });
      } catch {
        // A failed staging cleanup is reported by orphan detection.
      }
    }
  }
}

function operationResolve(projectRoot) {
  return resolveTaskState(projectRoot);
}

function operationSnapshot(projectRoot, options) {
  const mode = options.mode || 'session';
  if (!['breadcrumb', 'authority', 'session', 'agent'].includes(mode))
    fail('INVALID_REQUEST', `Unsupported snapshot mode: ${mode}`);
  return buildTaskSnapshot(projectRoot, { mode, role: options.role || 'unknown' });
}

function operationList(projectRoot) {
  const pending = readPendingTransaction(projectRoot);
  if (!pending.ok) fail(pending.code, pending.message);
  if (pending.exists)
    fail('RECOVERY_REQUIRED', 'An incomplete task transaction must be recovered before listing tasks');
  const stateResult = assertStateReadable(readState(projectRoot));
  const tasks = listTasks(projectRoot, { allowLegacy: !stateResult.exists });
  if (!tasks.ok) fail(tasks.code, tasks.message);
  const activeTaskId = stateResult.state.activeTaskId;
  return {
    state: stateResult.state,
    tasks: tasks.tasks.map((task) => ({
      ...taskForWrite(task),
      effectiveStatus: task.status === 'open' ? (task.id === activeTaskId ? 'active' : 'suspended') : task.status,
    })),
    orphans: tasks.orphans,
  };
}

function operationStart(projectRoot, request) {
  const expected = requireExpected(request, false);
  const mode = requireString(request, 'mode', 16);
  if (!VALID_START_MODES.has(mode)) fail('INVALID_REQUEST', 'mode must be activate, interrupt, replace, or inactive');
  const taskInput = validateTaskInput(request.task);
  const requirements = validateTextContent(request.requirements, 'requirements', REQUIREMENTS_LIMIT, true);

  return withStateLock(projectRoot, () => {
    ensureTaskRuntimeIgnored(projectRoot);
    const stateResult = assertStateReadable(readState(projectRoot));
    assertExpectedState(stateResult, expected);
    if (!stateResult.exists) {
      const existing = listTasks(projectRoot, { allowLegacy: true });
      if (!existing.ok) fail(existing.code, existing.message);
      if (existing.tasks.length > 0 || existing.orphans.length > 0) {
        fail('TASK_MIGRATION_REQUIRED', 'Existing task directories require explicit migration');
      }
    }

    let activeTask = null;
    if (stateResult.state.activeTaskId) {
      activeTask = assertTaskReadable(readTask(projectRoot, stateResult.state.activeTaskId));
      assertOpenTask(activeTask);
      const chain = inspectReturnChain(projectRoot, activeTask.returnToTaskId);
      if (!chain.ok) fail(chain.code, chain.message);
    }
    if (mode === 'activate' && activeTask) fail('ACTIVE_TASK_CONFLICT', 'activate mode requires no active task');
    if ((mode === 'interrupt' || mode === 'replace') && !activeTask) {
      fail('ACTIVE_TASK_CONFLICT', `${mode} mode requires an active task`);
    }

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
    writeTaskStaging(projectRoot, task, requirements, progress);

    let state = stateResult.state;
    if (!stateResult.exists || mode !== 'inactive') {
      const activeTaskId = mode === 'inactive' ? null : task.id;
      state = makeState(stateResult.state, activeTaskId);
      writeState(projectRoot, state);
    }
    return { state, task, effectiveStatus: state.activeTaskId === task.id ? 'active' : 'suspended' };
  });
}

function operationActivate(projectRoot, request) {
  const expected = requireExpected(request, true);
  const taskId = requireString(request, 'taskId', 80);
  if (!isValidTaskId(taskId)) fail('INVALID_REQUEST', 'taskId is invalid');
  return withStateLock(projectRoot, () => {
    const stateResult = assertStateReadable(readState(projectRoot));
    if (!stateResult.exists) fail('TASK_MIGRATION_REQUIRED', 'Initialize task state before activation');
    assertExpectedState(stateResult, expected);
    const task = assertTaskReadable(readTask(projectRoot, taskId));
    assertOpenTask(task);
    assertTaskRevision(task, expected.taskRevision);
    const chain = inspectReturnChain(projectRoot, task.returnToTaskId);
    if (!chain.ok) fail(chain.code, chain.message);
    if (stateResult.state.activeTaskId === taskId) return { state: stateResult.state, task, changed: false };
    const state = makeState(stateResult.state, taskId);
    writeState(projectRoot, state);
    return { state, task, changed: true };
  });
}

function operationCheckpoint(projectRoot, request) {
  const currentPhase = requireString(request, 'currentPhase', 64);
  const nextAction = requireString(request, 'nextAction', 1024);
  const gate = request.gate === null ? null : requireString(request, 'gate', 256);
  const progress = validateTextContent(request.progress, 'progress', ARTIFACT_LIMIT, false);
  return withStateLock(projectRoot, () => {
    const { state, task } = assertActiveMutation(projectRoot, request);
    const nextTask = bumpTask(task, { currentPhase, nextAction, gate });
    if (progress !== null) {
      runTaskTransaction(projectRoot, 'checkpoint', task.id, [
        { path: path.join(task.dir, 'progress.md'), content: progress },
        { path: getTaskPath(projectRoot, task.id), content: jsonContent(taskForWrite(nextTask)) },
      ]);
    } else {
      writeTask(projectRoot, nextTask);
    }
    return { state, task: nextTask };
  });
}

function operationUpdateRequirements(projectRoot, request) {
  const content = validateTextContent(request.content, 'content', REQUIREMENTS_LIMIT, true);
  return withStateLock(projectRoot, () => {
    const { state, task } = assertActiveMutation(projectRoot, request);
    const nextTask = bumpTask(task, {});
    runTaskTransaction(projectRoot, 'update-requirements', task.id, [
      { path: path.join(task.dir, 'requirements.md'), content },
      { path: getTaskPath(projectRoot, task.id), content: jsonContent(taskForWrite(nextTask)) },
    ]);
    return { state, task: nextTask };
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

function operationWriteArtifact(projectRoot, request) {
  const content = validateTextContent(request.content, 'content', ARTIFACT_LIMIT, true);
  return withStateLock(projectRoot, () => {
    const { state, task } = assertActiveMutation(projectRoot, request);
    const target = resolveArtifactPath(task, request);
    const nextTask = bumpTask(task, {});
    runTaskTransaction(projectRoot, 'write-artifact', task.id, [
      { path: target, content },
      { path: getTaskPath(projectRoot, task.id), content: jsonContent(taskForWrite(nextTask)) },
    ]);
    return { state, task: nextTask, path: path.relative(projectRoot, target).replace(/\\/g, '/') };
  });
}

function operationLinkSpec(projectRoot, request) {
  const specRef = request.specRef;
  return withStateLock(projectRoot, () => {
    const { state, task } = assertActiveMutation(projectRoot, request);
    const validated = validateSpecRef(projectRoot, specRef, { requireSection: true });
    if (!validated.ok) fail(validated.code, validated.message);
    const duplicate = task.specRefs.some(
      (ref) => ref.path === validated.ref.path && ref.section === validated.ref.section
    );
    if (duplicate) return { state, task, linked: false };
    if (task.specRefs.length >= 32) fail('INVALID_REQUEST', 'A task may link at most 32 spec sections');
    const specRefs = [...task.specRefs, validated.ref];
    const collected = collectSpecContext(projectRoot, specRefs, 'all');
    if (!collected.ok) fail(collected.code, collected.message);
    const nextTask = bumpTask(task, { specRefs });
    writeTask(projectRoot, nextTask);
    return { state, task: nextTask, linked: true };
  });
}

function operationUnlinkSpec(projectRoot, request) {
  const specPath = requireString(request, 'path', 1024).replace(/\\/g, '/');
  const section = requireString(request, 'section', 240);
  return withStateLock(projectRoot, () => {
    const { state, task } = assertActiveMutation(projectRoot, request);
    const specRefs = task.specRefs.filter((ref) => !(ref.path === specPath && ref.section === section));
    if (specRefs.length === task.specRefs.length) return { state, task, unlinked: false };
    const nextTask = bumpTask(task, { specRefs });
    writeTask(projectRoot, nextTask);
    return { state, task: nextTask, unlinked: true };
  });
}

function operationSetSpecEvolution(projectRoot, request) {
  const value = requireString(request, 'value', 32);
  if (!VALID_SPEC_EVOLUTION.has(value)) fail('INVALID_REQUEST', 'value is not a valid spec evolution result');
  return withStateLock(projectRoot, () => {
    const { state, task } = assertActiveMutation(projectRoot, request);
    if (task.specEvolution === value) return { state, task, changed: false };
    const nextTask = bumpTask(task, { specEvolution: value });
    writeTask(projectRoot, nextTask);
    return { state, task: nextTask, changed: true };
  });
}

function findReturnTarget(projectRoot, startTaskId) {
  const chain = inspectReturnChain(projectRoot, startTaskId);
  if (!chain.ok) fail(chain.code, chain.message);
  return chain.chain.find((task) => task.status === 'open') || null;
}

function operationFinish(projectRoot, request) {
  const status = requireString(request, 'status', 16);
  if (status !== 'completed' && status !== 'cancelled')
    fail('INVALID_REQUEST', 'status must be completed or cancelled');
  const progress = validateTextContent(request.progress, 'progress', ARTIFACT_LIMIT, false);
  return withStateLock(projectRoot, () => {
    const { state, task } = assertActiveMutation(projectRoot, request);
    if (task.gate !== null) fail('GATE_OPEN', `Task gate is still open: ${task.gate}`);
    if (task.specEvolution === 'pending')
      fail('SPEC_EVOLUTION_PENDING', 'Record the spec evolution result before finishing');
    const returnTask = findReturnTarget(projectRoot, task.returnToTaskId);
    const now = new Date().toISOString();
    const nextTask = bumpTask(task, { status, gate: null, finishedAt: now });
    const nextState = makeState(state, returnTask ? returnTask.id : null);
    const writes = [];
    if (progress !== null) writes.push({ path: path.join(task.dir, 'progress.md'), content: progress });
    writes.push(
      { path: getTaskPath(projectRoot, task.id), content: jsonContent(taskForWrite(nextTask)) },
      { path: getStatePath(projectRoot), content: jsonContent(nextState) }
    );
    runTaskTransaction(projectRoot, 'finish', task.id, writes);
    return { state: nextState, task: nextTask, resumedTaskId: returnTask ? returnTask.id : null };
  });
}

function operationRecover(projectRoot, request) {
  const expected = requireExpected(request, false);
  return withStateLock(
    projectRoot,
    (pending) => {
      const stateResult = assertStateReadable(readState(projectRoot));
      if (!stateResult.exists) fail('TASK_MIGRATION_REQUIRED', 'state.json does not exist');
      assertExpectedState(stateResult, expected);

      if (pending.exists) {
        const transaction = pending.transaction;
        applyTaskTransaction(projectRoot, pending);
        const recoveredState = assertStateReadable(readState(projectRoot));
        if (!recoveredState.exists) fail('TRANSACTION_INVALID', 'Recovered transaction did not preserve state.json');
        const task = assertTaskReadable(readTask(projectRoot, transaction.taskId));
        return {
          state: recoveredState.state,
          task,
          resumedTaskId: transaction.operation === 'finish' ? recoveredState.state.activeTaskId : null,
          recoveredReason: 'INCOMPLETE_TRANSACTION',
          transactionId: transaction.transactionId,
        };
      }

      if (!stateResult.state.activeTaskId) fail('RECOVERY_REQUIRED', 'No active pointer can be recovered');
      const taskResult = readTask(projectRoot, stateResult.state.activeTaskId);
      if (!taskResult.ok && taskResult.code === 'TASK_NOT_FOUND') {
        const state = makeState(stateResult.state, null);
        writeState(projectRoot, state);
        return { state, task: null, resumedTaskId: null, recoveredReason: 'ACTIVE_TASK_MISSING' };
      }
      const task = assertTaskReadable(taskResult);
      const taskRevision = requireSafeRevision(request.expected.taskRevision, 'expected.taskRevision', 1);
      assertTaskRevision(task, taskRevision);
      if (!['completed', 'cancelled'].includes(task.status))
        fail('RECOVERY_REQUIRED', 'Recovery only advances a pointer left on a terminal task');
      const returnTask = findReturnTarget(projectRoot, task.returnToTaskId);
      const state = makeState(stateResult.state, returnTask ? returnTask.id : null);
      writeState(projectRoot, state);
      return { state, task, resumedTaskId: returnTask ? returnTask.id : null, recoveredReason: 'ACTIVE_TASK_TERMINAL' };
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

function backupLegacyTask(projectRoot, taskResult) {
  const backupDir = ensureRuntimeDirectory(projectRoot, `.ccg/migrations/v1/${taskResult.task.id}`);
  for (const name of ['task.json', 'context.jsonl']) {
    const sourcePath = path.join(taskResult.taskDir, name);
    const destination = path.join(backupDir, name);
    if (fs.existsSync(destination)) continue;
    const source = readFileBounded(sourcePath, name === 'task.json' ? 64 * 1024 : 64 * 1024);
    if (source.ok && !source.truncated) atomicWriteFile(destination, source.content);
  }
}

function migrateOneTask(projectRoot, taskResult, diagnostics) {
  if (!taskResult.legacy) return taskResult.task;
  backupLegacyTask(projectRoot, taskResult);
  const raw = taskResult.raw;
  const now = new Date().toISOString();
  const git = getGitInfo(projectRoot);
  const status = taskResult.task.status;
  const title = typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim().slice(0, 240) : taskResult.task.id;
  const task = {
    schemaVersion: TASK_SCHEMA_VERSION,
    revision: 1,
    id: taskResult.task.id,
    title,
    status,
    strategy:
      typeof raw.strategy === 'string' && raw.strategy.trim() ? raw.strategy.trim().slice(0, 80) : 'guided-develop',
    complexity: ['S', 'M', 'L', 'XL'].includes(raw.complexity) ? raw.complexity : 'M',
    risk: ['low', 'medium', 'high'].includes(raw.risk) ? raw.risk : 'medium',
    domain: typeof raw.domain === 'string' && raw.domain.trim() ? raw.domain.trim().slice(0, 64) : 'general',
    scope: typeof raw.scope === 'string' && raw.scope.trim() ? raw.scope.trim().slice(0, 1024) : title,
    currentPhase:
      String(raw.currentPhase || '1')
        .trim()
        .slice(0, 64) || '1',
    nextAction:
      String(raw.nextAction || 'Continue the task')
        .trim()
        .slice(0, 1024) || 'Continue the task',
    gate: typeof raw.gate === 'string' && raw.gate.trim() ? raw.gate.trim().slice(0, 256) : null,
    returnToTaskId:
      isValidTaskId(raw.returnToTaskId) && raw.returnToTaskId !== taskResult.task.id ? raw.returnToTaskId : null,
    specEvolution: VALID_SPEC_EVOLUTION.has(raw.specEvolution) ? raw.specEvolution : 'pending',
    specRefs: canonicalizeLegacySpecRefs(projectRoot, taskResult, diagnostics),
    branchAtCreation:
      taskResult.task.branchAtCreation || (git.branch === 'HEAD' || git.branch === 'unknown' ? null : git.branch),
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
  const requirementsPath = path.join(taskResult.taskDir, 'requirements.md');
  const requirements = readFileBounded(requirementsPath, REQUIREMENTS_LIMIT);
  if (!requirements.ok && requirements.code === 'NOT_FOUND') {
    atomicWriteFile(requirementsPath, `# Requirements\n\n## Objective\n\n${title}\n\n## Scope\n\n${task.scope}\n`);
  } else if (!requirements.ok || requirements.truncated || !requirements.content.trim()) {
    fail('TASK_CONTRACT_TOO_LARGE', `Legacy requirements.md is invalid: ${task.id}`);
  }
  const progressPath = path.join(taskResult.taskDir, 'progress.md');
  if (!fs.existsSync(progressPath)) atomicWriteFile(progressPath, generatedProgress(task, 'Legacy task migrated'));
  writeTask(projectRoot, task);
  return task;
}

function operationMigrateLegacy(projectRoot, request) {
  const expected = requireExpected(request, false);
  if (!Object.prototype.hasOwnProperty.call(request, 'activeTaskId')) {
    fail('INVALID_REQUEST', 'activeTaskId must be provided explicitly, including null');
  }
  const requestedActiveTaskId = requireNullableTaskId(request.activeTaskId, 'activeTaskId');
  return withStateLock(projectRoot, () => {
    ensureTaskRuntimeIgnored(projectRoot);
    const stateResult = assertStateReadable(readState(projectRoot));
    if (stateResult.exists) fail('STATE_ALREADY_INITIALIZED', 'state.json already exists');
    assertExpectedState(stateResult, expected);
    const listed = listTasks(projectRoot, { allowLegacy: true });
    if (!listed.ok) fail(listed.code, listed.message);
    if (listed.orphans.length > 0)
      fail('ORPHAN_TASK_DIR', `Task directories without task.json: ${listed.orphans.join(', ')}`);
    const diagnostics = [];
    const migrated = [];
    for (const candidate of listed.tasks) {
      const result = readTask(projectRoot, candidate.id, { allowLegacy: true });
      migrated.push(migrateOneTask(projectRoot, result, diagnostics));
    }
    if (requestedActiveTaskId !== null) {
      const activeTask = migrated.find((task) => task.id === requestedActiveTaskId);
      if (!activeTask) fail('TASK_NOT_FOUND', `Task not found: ${requestedActiveTaskId}`);
      assertOpenTask(activeTask);
    }
    const state = makeState(stateResult.state, requestedActiveTaskId);
    writeState(projectRoot, state);
    return { state, migratedTaskIds: migrated.map((task) => task.id), diagnostics };
  });
}

function operationRecordTurn(projectRoot, request) {
  const expected = requireExpected(request, true);
  const sessionId = requireString(request, 'sessionId', 256);
  const resolution = resolveTaskState(projectRoot);
  if (resolution.kind !== 'active')
    fail(resolution.code || 'ACTIVE_TASK_CONFLICT', resolution.message || 'No active task');
  if (
    resolution.stateId !== expected.stateId ||
    resolution.stateRevision !== expected.stateRevision ||
    resolution.activeTaskId !== expected.activeTaskId
  ) {
    fail('REVISION_CONFLICT', 'Task state changed before recording the turn');
  }
  assertTaskRevision(resolution.task, expected.taskRevision);
  const tracked = trackTurn(resolution.task.dir, sessionId, resolution.task.currentPhase, resolution.task.nextAction);
  if (!tracked.ok) fail(tracked.code, 'Cannot record session turn', null, 3);
  return { state: resolution.state, task: resolution.task, loop: detectLoop(tracked.turns, 3) };
}

function execute(operation, options, request) {
  const projectRoot = resolveRoot(options);
  switch (operation) {
    case 'resolve':
      return operationResolve(projectRoot);
    case 'snapshot':
      return operationSnapshot(projectRoot, options);
    case 'list':
      return operationList(projectRoot);
    case 'start':
    case 'create':
      return operationStart(projectRoot, request);
    case 'activate':
      return operationActivate(projectRoot, request);
    case 'update-requirements':
      return operationUpdateRequirements(projectRoot, request);
    case 'checkpoint':
      return operationCheckpoint(projectRoot, request);
    case 'write-artifact':
      return operationWriteArtifact(projectRoot, request);
    case 'link-spec':
      return operationLinkSpec(projectRoot, request);
    case 'unlink-spec':
      return operationUnlinkSpec(projectRoot, request);
    case 'set-spec-evolution':
      return operationSetSpecEvolution(projectRoot, request);
    case 'finish':
      return operationFinish(projectRoot, request);
    case 'recover':
      return operationRecover(projectRoot, request);
    case 'migrate-legacy':
    case 'migrate':
      return operationMigrateLegacy(projectRoot, request);
    case 'record-turn':
      return operationRecordTurn(projectRoot, request);
    default:
      fail('INVALID_REQUEST', `Unknown operation: ${operation}`);
  }
}

function operationRequiresRequest(operation) {
  return !['resolve', 'snapshot', 'list'].includes(operation);
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
  operationUpdateRequirements,
  operationCheckpoint,
  operationWriteArtifact,
  operationLinkSpec,
  operationUnlinkSpec,
  operationSetSpecEvolution,
  operationFinish,
  operationRecover,
  operationMigrateLegacy,
  operationRecordTurn,
};
