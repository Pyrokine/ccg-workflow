'use strict';

const {
  validateRuntimePath,
  readFileBounded,
  fsyncDirectory,
  readPendingTransaction,
  atomicWriteJson,
  getBindingPath,
  isValidTaskId,
  atomicWriteFile,
  TRANSACTION_FILE_LIMIT,
} = require('./task-utils.js');
const { fail, TaskStateError } = require('./task-state-core.js');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');

const LOCK_TIMEOUT_MS = 500;

const LOCK_STALE_MS = 30000;

const LOCK_RETRY_MS = 25;

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
  applyTaskTransaction(projectRoot, readWrittenTransaction(projectRoot, transaction));
}

function readWrittenTransaction(projectRoot, transaction) {
  const pending = readPendingTransaction(projectRoot);
  if (!pending.ok || !pending.exists) {
    fail(pending.code || 'TRANSACTION_INVALID', pending.message || 'Task transaction was not persisted', null, 3);
  }
  if (pending.transaction.transactionId !== transaction.transactionId)
    fail('TRANSACTION_CONFLICT', 'Task transaction identity changed before commit', null, 3);
  return pending;
}

module.exports = {
  assertRuntimePath,
  ensureRuntimeDirectory,
  withStateLock,
  writeState,
  bindingForWrite,
  writeBinding,
  taskForWrite,
  writeTask,
  jsonContent,
  applyTaskTransaction,
  runTaskTransaction,
};
