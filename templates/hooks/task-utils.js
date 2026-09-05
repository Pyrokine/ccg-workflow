#!/usr/bin/env node
// CCG Hook Shared Utilities
// Pure Node.js, zero external dependencies

'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { execFileSync } = require('child_process');

const STATE_SCHEMA_VERSION = 1;
const TASK_SCHEMA_VERSION = 1;
const HOOK_INPUT_LIMIT = 1024 * 1024;
const STATE_FILE_LIMIT = 256 * 1024;
const TASK_FILE_LIMIT = 64 * 1024;
const TRANSACTION_FILE_LIMIT = 1024 * 1024;
const LEGACY_CONTEXT_LIMIT = 64 * 1024;
const SESSION_CONTEXT_LIMIT = 32 * 1024;
const SESSION_TASK_CONTEXT_LIMIT = SESSION_CONTEXT_LIMIT - 64;
const BREADCRUMB_CONTEXT_LIMIT = 1024;
const AUTHORITY_CONTEXT_LIMIT = 32 * 1024;
const AGENT_CONTEXT_LIMIT = 32 * 1024;
const REQUIREMENTS_LIMIT = 8 * 1024;
const DOCUMENT_LIMIT = 8 * 1024;
const REVIEW_LIMIT = 4 * 1024;
const RESEARCH_FILE_LIMIT = 4 * 1024;
const RESEARCH_TOTAL_LIMIT = 16 * 1024;
const SPEC_SECTION_LIMIT = 4 * 1024;
const SPEC_TOTAL_LIMIT = 12 * 1024;
const SPEC_SOURCE_LIMIT = 256 * 1024;
const TASK_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const STATE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VALID_STATUSES = new Set(['open', 'completed', 'cancelled']);
const VALID_COMPLEXITIES = new Set(['S', 'M', 'L', 'XL']);
const VALID_RISKS = new Set(['low', 'medium', 'high']);
const VALID_SPEC_EVOLUTION = new Set(['pending', 'applied', 'skipped', 'not_applicable']);
const VALID_ROLES = new Set(['research', 'implement', 'review', 'debug']);
const LEGACY_OPEN_STATUSES = new Set([
  'open',
  'in_progress',
  'in-progress',
  'active',
  'pending',
  'paused',
  'suspended',
]);
const LEGACY_CANCELLED_STATUSES = new Set(['cancelled', 'canceled', 'abandoned']);
const LEGACY_COMPLETED_STATUSES = new Set([
  'completed',
  'complete',
  'done',
  'finished',
  'finish',
  'archived',
  'archive',
  'closed',
  'resolved',
]);

function byteLength(value) {
  return Buffer.byteLength(String(value || ''), 'utf-8');
}

function isNonEmptyString(value, maxBytes) {
  return typeof value === 'string' && value.trim().length > 0 && byteLength(value.trim()) <= maxBytes;
}

function isIsoTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function normalizeLegacyTaskStatus(status) {
  const normalized = String(status || '')
    .trim()
    .toLowerCase();
  if (LEGACY_CANCELLED_STATUSES.has(normalized)) return 'cancelled';
  if (LEGACY_COMPLETED_STATUSES.has(normalized)) return 'completed';
  if (LEGACY_OPEN_STATUSES.has(normalized)) return 'open';
  return null;
}

function normalizeTaskStatus(status) {
  return normalizeLegacyTaskStatus(status);
}

function isTerminalStatus(status) {
  return status === 'completed' || status === 'cancelled';
}

function isValidTaskId(taskId) {
  const value = String(taskId || '');
  return value.length <= 80 && TASK_ID_PATTERN.test(value);
}

function findProjectRoot(startDir) {
  let dir = path.resolve(startDir || process.cwd());
  let ccgFallback = null;
  for (let depth = 0; depth < 64; depth += 1) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    if (!ccgFallback && fs.existsSync(path.join(dir, '.ccg'))) ccgFallback = dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return ccgFallback;
}

function getStatePath(projectRoot) {
  return path.join(projectRoot, '.ccg', 'state.json');
}

function getTasksDir(projectRoot) {
  return path.join(projectRoot, '.ccg', 'tasks');
}

function getTaskDir(projectRoot, taskId) {
  if (!isValidTaskId(taskId)) return null;
  return path.join(getTasksDir(projectRoot), taskId);
}

function getTaskPath(projectRoot, taskId) {
  const taskDir = getTaskDir(projectRoot, taskId);
  return taskDir ? path.join(taskDir, 'task.json') : null;
}

function isPathInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function validateRuntimePath(projectRoot, relativePath, options) {
  const opts = options || {};
  const normalized = normalizeRelativeProjectPath(relativePath);
  if (!normalized || (normalized !== '.ccg' && !normalized.startsWith('.ccg/'))) {
    return { ok: false, code: 'RUNTIME_PATH_INVALID', message: `Invalid runtime path: ${relativePath}` };
  }
  const root = path.resolve(projectRoot);
  const candidate = path.resolve(root, ...normalized.split('/'));
  if (!isPathInside(root, candidate)) {
    return { ok: false, code: 'RUNTIME_PATH_INVALID', message: `Runtime path escapes project root: ${relativePath}` };
  }

  let rootReal;
  try {
    const rootStat = fs.statSync(root);
    if (!rootStat.isDirectory()) {
      return { ok: false, code: 'RUNTIME_PATH_INVALID', message: `Project root is not a directory: ${root}` };
    }
    rootReal = fs.realpathSync(root);
  } catch {
    return { ok: false, code: 'RUNTIME_PATH_INVALID', message: `Cannot inspect project root: ${root}` };
  }

  let current = root;
  const segments = normalized.split('/');
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (opts.allowMissing && error && error.code === 'ENOENT') {
        const parentReal = fs.realpathSync(path.dirname(current));
        if (!isPathInside(rootReal, parentReal)) {
          return {
            ok: false,
            code: 'RUNTIME_PATH_INVALID',
            message: `Runtime path escapes project root: ${relativePath}`,
          };
        }
        return { ok: true, path: candidate, exists: false, missingAt: segments.slice(0, index + 1).join('/') };
      }
      return { ok: false, code: 'RUNTIME_PATH_INVALID', message: `Runtime path does not exist: ${relativePath}` };
    }
    if (stat.isSymbolicLink()) {
      return {
        ok: false,
        code: 'RUNTIME_PATH_INVALID',
        message: `Runtime path contains a symbolic link: ${relativePath}`,
      };
    }
    if (index < segments.length - 1 && !stat.isDirectory()) {
      return {
        ok: false,
        code: 'RUNTIME_PATH_INVALID',
        message: `Runtime path parent is not a directory: ${relativePath}`,
      };
    }
    if (index === segments.length - 1) {
      if (opts.kind === 'directory' && !stat.isDirectory()) {
        return { ok: false, code: 'RUNTIME_PATH_INVALID', message: `Runtime path is not a directory: ${relativePath}` };
      }
      if (opts.kind === 'file' && !stat.isFile()) {
        return { ok: false, code: 'RUNTIME_PATH_INVALID', message: `Runtime path is not a file: ${relativePath}` };
      }
    }
  }

  try {
    const candidateReal = fs.realpathSync(candidate);
    if (!isPathInside(rootReal, candidateReal)) {
      return { ok: false, code: 'RUNTIME_PATH_INVALID', message: `Runtime path escapes project root: ${relativePath}` };
    }
  } catch {
    return { ok: false, code: 'RUNTIME_PATH_INVALID', message: `Cannot resolve runtime path: ${relativePath}` };
  }
  return { ok: true, path: candidate, exists: true };
}

function readFileBounded(filePath, maxBytes) {
  const limit = Number.isInteger(maxBytes) && maxBytes >= 0 ? maxBytes : DOCUMENT_LIMIT;
  let fd;
  try {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      return { ok: false, code: 'NOT_A_REGULAR_FILE', filePath };
    }
    fd = fs.openSync(filePath, 'r');
    const bytesToRead = Math.min(stat.size, limit + 1);
    const buffer = Buffer.alloc(bytesToRead);
    const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, 0);
    const truncated = stat.size > limit;
    const contentBuffer = truncated ? buffer.subarray(0, limit) : buffer.subarray(0, bytesRead);
    return {
      ok: true,
      content: contentBuffer.toString('utf-8'),
      truncated,
      size: stat.size,
      filePath,
    };
  } catch (error) {
    return {
      ok: false,
      code: error && error.code === 'ENOENT' ? 'NOT_FOUND' : 'READ_FAILED',
      filePath,
      error,
    };
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // The read result is already determined.
      }
    }
  }
}

function readFileSafe(filePath, maxBytes) {
  const result = readFileBounded(filePath, maxBytes);
  if (!result.ok) return null;
  return result.content + (result.truncated ? '\n...(truncated)' : '');
}

function readJsonDetailed(filePath, maxBytes) {
  const source = readFileBounded(filePath, maxBytes || DOCUMENT_LIMIT);
  if (!source.ok) {
    if (source.code === 'NOT_FOUND') return { ok: true, exists: false, data: null, raw: null };
    return { ok: false, code: 'READ_FAILED', filePath };
  }
  if (source.truncated) return { ok: false, code: 'FILE_TOO_LARGE', filePath };
  try {
    return { ok: true, exists: true, data: JSON.parse(source.content), raw: source.content };
  } catch (error) {
    return { ok: false, code: 'INVALID_JSON', filePath, raw: source.content, error };
  }
}

function readJsonSafe(filePath) {
  const result = readJsonDetailed(filePath);
  return result.ok && result.exists ? result.data : null;
}

function validateTransactionTarget(taskId, target, operation, index, writeCount) {
  if (target === '.ccg/state.json') return operation === 'finish' && index === writeCount - 1;
  const prefix = `.ccg/tasks/${taskId}/`;
  if (!target.startsWith(prefix)) return false;
  const relative = target.slice(prefix.length);
  if (relative === 'task.json') return true;
  if (['requirements.md', 'progress.md', 'analysis.md', 'plan.md', 'review.md'].includes(relative)) return true;
  return /^research\/[a-z0-9]+(?:[._-][a-z0-9]+)*\.md$/.test(relative) && !relative.includes('..');
}

function readPendingTransaction(projectRoot) {
  const location = validateRuntimePath(projectRoot, '.ccg/transaction.json', { allowMissing: true, kind: 'file' });
  if (!location.ok) return { ok: false, code: 'TRANSACTION_INVALID', message: location.message };
  const parsed = readJsonDetailed(location.path, TRANSACTION_FILE_LIMIT);
  if (!parsed.ok) {
    const code = parsed.code === 'FILE_TOO_LARGE' ? 'TRANSACTION_TOO_LARGE' : 'TRANSACTION_INVALID';
    return { ok: false, code, message: `Cannot read ${location.path}` };
  }
  if (!parsed.exists) return { ok: true, exists: false, path: location.path, transaction: null };
  const transaction = parsed.data;
  if (
    !transaction ||
    typeof transaction !== 'object' ||
    Array.isArray(transaction) ||
    transaction.schemaVersion !== 1 ||
    typeof transaction.transactionId !== 'string' ||
    !STATE_ID_PATTERN.test(transaction.transactionId) ||
    !['checkpoint', 'update-requirements', 'write-artifact', 'finish'].includes(transaction.operation) ||
    !isValidTaskId(transaction.taskId) ||
    !isIsoTimestamp(transaction.createdAt) ||
    !Array.isArray(transaction.writes) ||
    transaction.writes.length < 1 ||
    transaction.writes.length > 3
  ) {
    return { ok: false, code: 'TRANSACTION_INVALID', message: 'transaction.json has an invalid structure' };
  }
  const seen = new Set();
  let hasTaskWrite = false;
  let hasStateWrite = false;
  for (let index = 0; index < transaction.writes.length; index += 1) {
    const write = transaction.writes[index];
    const target = write && normalizeRelativeProjectPath(write.path);
    if (
      !target ||
      typeof write.content !== 'string' ||
      seen.has(target) ||
      !validateTransactionTarget(transaction.taskId, target, transaction.operation, index, transaction.writes.length)
    ) {
      return { ok: false, code: 'TRANSACTION_INVALID', message: 'transaction.json contains an invalid write' };
    }
    const targetLocation = validateRuntimePath(projectRoot, target, { allowMissing: true, kind: 'file' });
    if (!targetLocation.ok) return { ok: false, code: 'TRANSACTION_INVALID', message: targetLocation.message };
    if (target === `.ccg/tasks/${transaction.taskId}/task.json`) hasTaskWrite = true;
    if (target === '.ccg/state.json') hasStateWrite = true;
    seen.add(target);
  }
  if (!hasTaskWrite || (transaction.operation === 'finish' && !hasStateWrite)) {
    return { ok: false, code: 'TRANSACTION_INVALID', message: 'transaction.json is missing a required write' };
  }
  return { ok: true, exists: true, path: location.path, transaction };
}

function readState(projectRoot) {
  const location = validateRuntimePath(projectRoot, '.ccg/state.json', { allowMissing: true, kind: 'file' });
  if (!location.ok) {
    return { ok: false, code: 'STATE_PATH_INVALID', message: location.message, path: location.path || null };
  }
  const statePath = location.path;
  const parsed = readJsonDetailed(statePath, STATE_FILE_LIMIT);
  if (!parsed.ok) {
    const code =
      parsed.code === 'FILE_TOO_LARGE'
        ? 'STATE_TOO_LARGE'
        : parsed.code === 'INVALID_JSON'
          ? 'STATE_INVALID'
          : 'STATE_READ_FAILED';
    return { ok: false, code, message: `Cannot read ${statePath}`, path: statePath };
  }
  if (!parsed.exists) {
    return {
      ok: true,
      exists: false,
      state: {
        schemaVersion: STATE_SCHEMA_VERSION,
        stateId: null,
        revision: 0,
        activeTaskId: null,
        updatedAt: null,
      },
      path: statePath,
    };
  }

  const state = parsed.data;
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    return { ok: false, code: 'STATE_INVALID', message: 'state.json must contain an object', path: statePath };
  }
  if (state.schemaVersion !== STATE_SCHEMA_VERSION) {
    return {
      ok: false,
      code: 'UNSUPPORTED_STATE_SCHEMA',
      message: `Unsupported state schema version: ${state.schemaVersion}`,
      path: statePath,
    };
  }
  if (typeof state.stateId !== 'string' || !STATE_ID_PATTERN.test(state.stateId)) {
    return { ok: false, code: 'STATE_INVALID', message: 'stateId is invalid', path: statePath };
  }
  if (!Number.isSafeInteger(state.revision) || state.revision < 1) {
    return {
      ok: false,
      code: 'STATE_INVALID',
      message: 'state revision must be a positive safe integer',
      path: statePath,
    };
  }
  if (state.activeTaskId !== null && !isValidTaskId(state.activeTaskId)) {
    return { ok: false, code: 'STATE_INVALID', message: 'activeTaskId is invalid', path: statePath };
  }
  if (!isIsoTimestamp(state.updatedAt)) {
    return { ok: false, code: 'STATE_INVALID', message: 'updatedAt is invalid', path: statePath };
  }

  return {
    ok: true,
    exists: true,
    state: {
      schemaVersion: STATE_SCHEMA_VERSION,
      stateId: state.stateId,
      revision: state.revision,
      activeTaskId: state.activeTaskId,
      updatedAt: state.updatedAt,
    },
    path: statePath,
  };
}

function validateTaskDirectory(projectRoot, taskId) {
  if (!isValidTaskId(taskId)) return { ok: false, code: 'TASK_INVALID', message: `Invalid task id: ${taskId}` };
  const location = validateRuntimePath(projectRoot, `.ccg/tasks/${taskId}`, { allowMissing: true, kind: 'directory' });
  if (!location.ok) return { ok: false, code: 'PATH_INVALID', message: location.message };
  if (!location.exists) return { ok: false, code: 'TASK_NOT_FOUND', message: `Task not found: ${taskId}` };
  return { ok: true, taskDir: location.path, taskPath: path.join(location.path, 'task.json') };
}

function normalizeSpecRef(ref, allowLegacyRoles) {
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return null;
  if (!isNonEmptyString(ref.path, 1024) || !isNonEmptyString(ref.section, 240) || !isNonEmptyString(ref.purpose, 512)) {
    return null;
  }
  let roles;
  if (ref.roles === undefined || ref.roles === null || (allowLegacyRoles && ref.roles === 'all')) {
    roles = [];
  } else if (Array.isArray(ref.roles)) {
    roles = [...new Set(ref.roles.map((role) => String(role).trim()).filter(Boolean))];
    if (roles.length === 0 || roles.some((role) => !VALID_ROLES.has(role))) return null;
  } else {
    return null;
  }
  return {
    path: String(ref.path).trim().replace(/\\/g, '/'),
    section: String(ref.section).trim(),
    purpose: String(ref.purpose).trim(),
    ...(roles.length > 0 ? { roles } : {}),
  };
}

function validateCanonicalTask(rawTask, taskId) {
  if (rawTask.schemaVersion !== TASK_SCHEMA_VERSION) return `Unsupported task schema version: ${rawTask.schemaVersion}`;
  if (rawTask.id !== taskId || !isValidTaskId(rawTask.id)) return 'Task id does not match its directory';
  if (!Number.isSafeInteger(rawTask.revision) || rawTask.revision < 1)
    return 'Task revision must be a positive safe integer';
  if (!VALID_STATUSES.has(rawTask.status)) return 'Task status is invalid';
  if (!isNonEmptyString(rawTask.title, 240)) return 'Task title is invalid';
  if (!isNonEmptyString(rawTask.strategy, 80)) return 'Task strategy is invalid';
  if (!VALID_COMPLEXITIES.has(rawTask.complexity)) return 'Task complexity is invalid';
  if (!VALID_RISKS.has(rawTask.risk)) return 'Task risk is invalid';
  if (!isNonEmptyString(rawTask.domain, 64)) return 'Task domain is invalid';
  if (!isNonEmptyString(rawTask.scope, 1024)) return 'Task scope is invalid';
  if (!isNonEmptyString(rawTask.currentPhase, 64)) return 'Task currentPhase is invalid';
  if (!isNonEmptyString(rawTask.nextAction, 1024)) return 'Task nextAction is invalid';
  if (rawTask.gate !== null && !isNonEmptyString(rawTask.gate, 256)) return 'Task gate is invalid';
  if (rawTask.returnToTaskId !== null && !isValidTaskId(rawTask.returnToTaskId))
    return 'Task returnToTaskId is invalid';
  if (rawTask.returnToTaskId === rawTask.id) return 'Task cannot return to itself';
  if (!VALID_SPEC_EVOLUTION.has(rawTask.specEvolution)) return 'Task specEvolution is invalid';
  if (!Array.isArray(rawTask.specRefs) || rawTask.specRefs.length > 32) return 'Task specRefs is invalid';
  if (rawTask.branchAtCreation !== null && !isNonEmptyString(rawTask.branchAtCreation, 512))
    return 'Task branchAtCreation is invalid';
  if (
    rawTask.headAtCreation !== null &&
    (typeof rawTask.headAtCreation !== 'string' || !/^[0-9a-f]{40}$/i.test(rawTask.headAtCreation))
  ) {
    return 'Task headAtCreation is invalid';
  }
  if (!isIsoTimestamp(rawTask.createdAt) || !isIsoTimestamp(rawTask.updatedAt)) return 'Task timestamps are invalid';
  if (rawTask.finishedAt !== null && !isIsoTimestamp(rawTask.finishedAt)) return 'Task finishedAt is invalid';
  if (rawTask.status === 'open' && rawTask.finishedAt !== null) return 'Open task cannot have finishedAt';
  if (isTerminalStatus(rawTask.status) && rawTask.finishedAt === null) return 'Terminal task requires finishedAt';
  return null;
}

function readTask(projectRoot, taskId, options) {
  const opts = options || {};
  if (!isValidTaskId(taskId)) return { ok: false, code: 'TASK_INVALID', message: `Invalid task id: ${taskId}` };
  const location = validateTaskDirectory(projectRoot, taskId);
  if (!location.ok) return location;
  const parsed = readJsonDetailed(location.taskPath, TASK_FILE_LIMIT);
  if (!parsed.ok) {
    const code =
      parsed.code === 'FILE_TOO_LARGE'
        ? 'TASK_TOO_LARGE'
        : parsed.code === 'INVALID_JSON'
          ? 'TASK_INVALID'
          : 'TASK_READ_FAILED';
    return { ok: false, code, message: `Cannot read task: ${taskId}`, taskId, taskDir: location.taskDir };
  }
  if (!parsed.exists || !parsed.data || typeof parsed.data !== 'object' || Array.isArray(parsed.data)) {
    return { ok: false, code: 'TASK_INVALID', message: `task.json is invalid: ${taskId}` };
  }

  const rawTask = parsed.data;
  const legacy = rawTask.schemaVersion === undefined;
  if (legacy && !opts.allowLegacy) {
    return { ok: false, code: 'LEGACY_TASK', message: `Task requires explicit migration: ${taskId}` };
  }

  let status;
  if (legacy) {
    status = normalizeLegacyTaskStatus(rawTask.status);
    if (!status) return { ok: false, code: 'TASK_INVALID', message: `Legacy task status is invalid: ${taskId}` };
    if (rawTask.id !== taskId)
      return { ok: false, code: 'TASK_INVALID', message: `Task id does not match its directory: ${taskId}` };
  } else {
    const error = validateCanonicalTask(rawTask, taskId);
    if (error) {
      const code = error.startsWith('Unsupported') ? 'UNSUPPORTED_TASK_SCHEMA' : 'TASK_INVALID';
      return { ok: false, code, message: `${error}: ${taskId}` };
    }
    status = rawTask.status;
  }

  const specRefs = (Array.isArray(rawTask.specRefs) ? rawTask.specRefs : []).map((ref) =>
    normalizeSpecRef(ref, legacy)
  );
  if (specRefs.some((ref) => ref === null)) {
    return { ok: false, code: 'TASK_INVALID', message: `specRefs contains an invalid entry: ${taskId}` };
  }
  const duplicateKeys = new Set();
  for (const ref of specRefs) {
    const key = `${ref.path}\0${ref.section}`;
    if (duplicateKeys.has(key))
      return { ok: false, code: 'TASK_INVALID', message: `specRefs contains duplicates: ${taskId}` };
    duplicateKeys.add(key);
  }

  const task = legacy
    ? {
        ...rawTask,
        status,
        revision: 0,
        branchAtCreation: rawTask.branchAtCreation || rawTask.branch || null,
        headAtCreation: rawTask.headAtCreation || rawTask.baseCommitAtCreation || rawTask.baseCommit || null,
        returnToTaskId: rawTask.returnToTaskId || null,
        specRefs,
        dir: location.taskDir,
      }
    : { ...rawTask, specRefs, dir: location.taskDir };

  return {
    ok: true,
    task,
    taskDir: location.taskDir,
    taskPath: location.taskPath,
    legacy,
    raw: rawTask,
  };
}

function listTasks(projectRoot, options) {
  const opts = options || {};
  const location = validateRuntimePath(projectRoot, '.ccg/tasks', { allowMissing: true, kind: 'directory' });
  if (!location.ok) return { ok: false, code: 'PATH_INVALID', message: location.message };
  if (!location.exists) return { ok: true, tasks: [], orphans: [] };
  const tasksDir = location.path;
  let entries;
  try {
    entries = fs.readdirSync(tasksDir, { withFileTypes: true });
  } catch {
    return { ok: false, code: 'TASKS_READ_FAILED', message: `Cannot list ${tasksDir}` };
  }

  const tasks = [];
  const orphans = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name === 'archive') continue;
    if (entry.isSymbolicLink())
      return { ok: false, code: 'PATH_INVALID', message: `Task entry is a symlink: ${entry.name}` };
    if (!entry.isDirectory()) continue;
    const taskPath = path.join(tasksDir, entry.name, 'task.json');
    if (!fs.existsSync(taskPath)) {
      orphans.push(entry.name);
      continue;
    }
    const result = readTask(projectRoot, entry.name, { allowLegacy: opts.allowLegacy === true });
    if (!result.ok) return result;
    tasks.push(result.task);
  }
  return { ok: true, tasks, orphans };
}

function listOpenTasks(projectRoot, options) {
  const result = listTasks(projectRoot, options);
  if (!result.ok) return result;
  if (result.orphans.length > 0 && !(options && options.allowOrphans)) {
    return {
      ok: false,
      code: 'ORPHAN_TASK_DIR',
      message: `Task directories without task.json: ${result.orphans.join(', ')}`,
    };
  }
  return { ok: true, tasks: result.tasks.filter((task) => task.status === 'open'), orphans: result.orphans };
}

function getGitInfo(projectRoot) {
  try {
    const branch = execFileSync('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
      cwd: projectRoot,
      stdio: 'pipe',
      encoding: 'utf-8',
    }).trim();
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: projectRoot,
      stdio: 'pipe',
      encoding: 'utf-8',
    }).trim();
    const status = execFileSync('git', ['status', '--porcelain'], {
      cwd: projectRoot,
      stdio: 'pipe',
      encoding: 'utf-8',
    }).trim();
    return { branch, commit, dirtyCount: status ? status.split('\n').length : 0, detached: false };
  } catch {
    let commit = null;
    try {
      commit = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: projectRoot,
        stdio: 'pipe',
        encoding: 'utf-8',
      }).trim();
    } catch {
      // An unborn or non-Git project has no commit.
    }
    return { branch: commit ? 'HEAD' : 'unknown', commit, dirtyCount: 0, detached: Boolean(commit) };
  }
}

function inspectReturnChain(projectRoot, startTaskId) {
  const visited = new Set();
  const chain = [];
  let taskId = startTaskId;
  for (let depth = 0; taskId !== null; depth += 1) {
    if (depth >= 32)
      return { ok: false, code: 'RETURN_CHAIN_TOO_DEEP', message: 'Task return chain exceeds 32 entries' };
    if (visited.has(taskId))
      return { ok: false, code: 'RETURN_CHAIN_CYCLE', message: `Task return chain cycles at ${taskId}` };
    visited.add(taskId);
    const result = readTask(projectRoot, taskId);
    if (!result.ok) return { ok: false, code: result.code, message: result.message };
    chain.push(result.task);
    taskId = result.task.returnToTaskId;
  }
  return { ok: true, chain };
}

function resolutionBase(stateResult) {
  return {
    source: stateResult.exists ? 'state' : 'legacy',
    state: stateResult.state,
    stateId: stateResult.state.stateId,
    stateRevision: stateResult.state.revision,
    activeTaskId: stateResult.state.activeTaskId,
    diagnostics: [],
  };
}

function resolveTaskState(projectRoot) {
  const stateResult = readState(projectRoot);
  if (!stateResult.ok) {
    return {
      kind: 'invalid',
      source: 'state',
      stateId: null,
      stateRevision: null,
      activeTaskId: null,
      code: stateResult.code,
      message: stateResult.message,
      diagnostics: [stateResult.code],
    };
  }
  const base = resolutionBase(stateResult);
  const pendingTransaction = readPendingTransaction(projectRoot);
  if (!pendingTransaction.ok) {
    return {
      ...base,
      kind: 'invalid',
      code: pendingTransaction.code,
      message: pendingTransaction.message,
      diagnostics: [pendingTransaction.code],
    };
  }
  if (pendingTransaction.exists) {
    if (!stateResult.exists) {
      return {
        ...base,
        kind: 'invalid',
        code: 'TRANSACTION_INVALID',
        message: 'A task transaction exists without initialized state',
        diagnostics: ['TRANSACTION_INVALID'],
      };
    }
    return {
      ...base,
      kind: 'recovery-required',
      code: 'RECOVERY_REQUIRED',
      reasonCode: 'INCOMPLETE_TRANSACTION',
      transactionId: pendingTransaction.transaction.transactionId,
      taskRevision: null,
      proposedActiveTaskId: null,
      message: `Incomplete ${pendingTransaction.transaction.operation} transaction requires recovery`,
      diagnostics: ['RECOVERY_REQUIRED', 'INCOMPLETE_TRANSACTION'],
    };
  }

  if (!stateResult.exists) {
    const tasks = listTasks(projectRoot, { allowLegacy: true });
    if (!tasks.ok)
      return { ...base, kind: 'invalid', code: tasks.code, message: tasks.message, diagnostics: [tasks.code] };
    if (tasks.orphans.length > 0) {
      return {
        ...base,
        kind: 'invalid',
        code: 'ORPHAN_TASK_DIR',
        message: `Task directories without task.json: ${tasks.orphans.join(', ')}`,
        diagnostics: ['ORPHAN_TASK_DIR'],
      };
    }
    if (tasks.tasks.length === 0) return { ...base, kind: 'none' };
    return {
      ...base,
      kind: 'migration-required',
      code: 'TASK_MIGRATION_REQUIRED',
      message: 'Task directories exist without .ccg/state.json',
      candidates: tasks.tasks
        .filter((task) => task.status === 'open')
        .map((task) => ({
          id: task.id,
          title: task.title || task.id,
          revision: task.revision,
        })),
      diagnostics: ['TASK_MIGRATION_REQUIRED'],
    };
  }

  if (stateResult.state.activeTaskId) {
    const taskResult = readTask(projectRoot, stateResult.state.activeTaskId);
    if (!taskResult.ok) {
      if (taskResult.code === 'TASK_NOT_FOUND') {
        return {
          ...base,
          kind: 'recovery-required',
          code: 'RECOVERY_REQUIRED',
          reasonCode: 'ACTIVE_TASK_MISSING',
          taskRevision: null,
          proposedActiveTaskId: null,
          message: taskResult.message,
          diagnostics: ['RECOVERY_REQUIRED', 'ACTIVE_TASK_MISSING'],
        };
      }
      return {
        ...base,
        kind: 'invalid',
        code: taskResult.code,
        message: taskResult.message,
        diagnostics: [taskResult.code],
      };
    }
    const task = taskResult.task;
    if (task.status !== 'open') {
      return {
        ...base,
        kind: 'recovery-required',
        code: 'RECOVERY_REQUIRED',
        reasonCode: 'ACTIVE_TASK_TERMINAL',
        task,
        taskRevision: task.revision,
        proposedActiveTaskId: null,
        message: `Active task is terminal: ${task.id}`,
        diagnostics: ['RECOVERY_REQUIRED', 'ACTIVE_TASK_TERMINAL'],
      };
    }
    const returnChain = inspectReturnChain(projectRoot, task.returnToTaskId);
    if (!returnChain.ok) {
      return {
        ...base,
        kind: 'invalid',
        code: returnChain.code,
        message: returnChain.message,
        diagnostics: [returnChain.code],
      };
    }
    const git = getGitInfo(projectRoot);
    const diagnostics = [];
    if (
      task.branchAtCreation &&
      git.branch !== 'unknown' &&
      git.branch !== 'HEAD' &&
      task.branchAtCreation !== git.branch
    ) {
      diagnostics.push(`BRANCH_CHANGED:${task.branchAtCreation}->${git.branch}`);
    }
    return {
      ...base,
      kind: 'active',
      task,
      taskRevision: task.revision,
      effectiveStatus: 'active',
      diagnostics,
    };
  }

  const openTasks = listOpenTasks(projectRoot);
  if (!openTasks.ok)
    return {
      ...base,
      kind: 'invalid',
      code: openTasks.code,
      message: openTasks.message,
      diagnostics: [openTasks.code],
    };
  if (openTasks.tasks.length === 0) return { ...base, kind: 'none' };
  return {
    ...base,
    kind: 'selection-required',
    code: 'SELECTION_REQUIRED',
    message: 'Open tasks exist but none is active',
    candidates: openTasks.tasks.map((task) => ({ id: task.id, title: task.title, revision: task.revision })),
    diagnostics: ['SELECTION_REQUIRED'],
  };
}

function getActiveTask(projectRoot) {
  const resolution = resolveTaskState(projectRoot);
  return resolution.kind === 'active' ? resolution.task : null;
}

function readStdinBounded(maxBytes) {
  if (process.stdin.isTTY) return '';
  const limit = Number.isInteger(maxBytes) && maxBytes > 0 ? maxBytes : HOOK_INPUT_LIMIT;
  const chunks = [];
  let total = 0;
  while (true) {
    const buffer = Buffer.alloc(Math.min(64 * 1024, limit + 1 - total));
    if (buffer.length === 0) throw new Error('HOOK_INPUT_TOO_LARGE');
    const bytesRead = fs.readSync(0, buffer, 0, buffer.length, null);
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > limit) throw new Error('HOOK_INPUT_TOO_LARGE');
    chunks.push(buffer.subarray(0, bytesRead));
  }
  return Buffer.concat(chunks).toString('utf-8');
}

function readHookInput(maxBytes) {
  const raw = readStdinBounded(maxBytes || HOOK_INPUT_LIMIT);
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('HOOK_INPUT_INVALID');
    return parsed;
  } catch (error) {
    if (error && error.message === 'HOOK_INPUT_INVALID') throw error;
    throw new Error('HOOK_INPUT_INVALID');
  }
}

function normalizeRelativeProjectPath(relativePath) {
  const value = String(relativePath || '');
  if (!value || value.includes('\0') || path.isAbsolute(value) || value.includes('\\')) return null;
  const segments = value.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return null;
  return segments.join('/');
}

function resolveProjectFile(projectRoot, relativePath) {
  const normalized = normalizeRelativeProjectPath(relativePath);
  if (!normalized)
    return { ok: false, code: 'PATH_INVALID', message: `Invalid project-relative path: ${relativePath}` };
  const root = path.resolve(projectRoot);
  const candidate = path.resolve(root, ...normalized.split('/'));
  if (!isPathInside(root, candidate))
    return { ok: false, code: 'PATH_INVALID', message: `Path escapes project root: ${relativePath}` };
  let current = root;
  try {
    for (const segment of normalized.split('/')) {
      current = path.join(current, segment);
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink())
        return { ok: false, code: 'PATH_INVALID', message: `Symbolic links are not allowed: ${relativePath}` };
    }
    const stat = fs.lstatSync(candidate);
    if (!stat.isFile())
      return { ok: false, code: 'PATH_INVALID', message: `Referenced path is not a file: ${relativePath}` };
    const rootReal = fs.realpathSync(root);
    const candidateReal = fs.realpathSync(candidate);
    if (!isPathInside(rootReal, candidateReal))
      return { ok: false, code: 'PATH_INVALID', message: `Real path escapes project root: ${relativePath}` };
    return { ok: true, path: candidate, relativePath: normalized, size: stat.size };
  } catch {
    return { ok: false, code: 'PATH_INVALID', message: `Referenced file does not exist: ${relativePath}` };
  }
}

function normalizeHeading(value) {
  return String(value || '')
    .trim()
    .replace(/\s+#+\s*$/, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function parseMarkdownHeadings(lines) {
  const headings = [];
  let fence = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (fence) {
      const closing = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
      if (closing && closing[1][0] === fence.character && closing[1].length >= fence.length) fence = null;
      continue;
    }
    const opening = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (opening) {
      fence = { character: opening[1][0], length: opening[1].length };
      continue;
    }
    const heading = line.match(/^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*$/);
    if (heading) headings.push({ index, level: heading[1].length, text: heading[2] });
  }
  return headings;
}

function extractMarkdownSection(filePath, section, maxBytes) {
  const target = normalizeHeading(section);
  if (!target) return { ok: false, code: 'SPEC_SECTION_NOT_FOUND', message: 'Spec section is empty' };
  const source = readFileBounded(filePath, Math.min(maxBytes || SPEC_SOURCE_LIMIT, SPEC_SOURCE_LIMIT));
  if (!source.ok) return { ok: false, code: 'SPEC_READ_FAILED', message: `Cannot read ${filePath}` };
  const lines = source.content.split(/\r?\n/);
  const headings = parseMarkdownHeadings(lines);
  const matchingHeadings = headings.filter((heading) => normalizeHeading(heading.text) === target);
  if (matchingHeadings.length === 0) {
    return { ok: false, code: 'SPEC_SECTION_NOT_FOUND', message: `Section not found: ${section}` };
  }
  if (matchingHeadings.length > 1) {
    return { ok: false, code: 'SPEC_SECTION_AMBIGUOUS', message: `Section heading is duplicated: ${section}` };
  }

  const { index: start, level: startLevel } = matchingHeadings[0];
  const nextHeading = headings.find((heading) => heading.index > start && heading.level <= startLevel);
  const end = nextHeading ? nextHeading.index : lines.length;
  const content = lines.slice(start, end).join('\n').trim();
  return { ok: true, content, truncatedSource: source.truncated };
}

function validateSpecRef(projectRoot, specRef, options) {
  const normalized = normalizeSpecRef(specRef, false);
  if (!normalized)
    return {
      ok: false,
      code: 'INVALID_REQUEST',
      message: 'Spec references require valid path, section, purpose, and roles',
    };
  if (path.extname(normalized.path).toLowerCase() !== '.md') {
    return { ok: false, code: 'PATH_INVALID', message: 'Spec references must target Markdown files' };
  }
  const file = resolveProjectFile(projectRoot, normalized.path);
  if (!file.ok) return file;
  try {
    execFileSync('git', ['--literal-pathspecs', 'ls-files', '--error-unmatch', '--', normalized.path], {
      cwd: projectRoot,
      stdio: 'pipe',
      encoding: 'utf-8',
    });
  } catch {
    return { ok: false, code: 'SPEC_NOT_TRACKED', message: `Spec file is not tracked by git: ${normalized.path}` };
  }
  let section = null;
  if (!options || options.requireSection !== false) {
    section = extractMarkdownSection(file.path, normalized.section, SPEC_SOURCE_LIMIT);
    if (!section.ok) return section;
    if (section.truncatedSource || byteLength(section.content) > SPEC_SECTION_LIMIT) {
      return {
        ok: false,
        code: 'SPEC_SECTION_TOO_LARGE',
        message: `Spec section exceeds the ${SPEC_SECTION_LIMIT}-byte context limit: ${normalized.path}#${normalized.section}`,
      };
    }
  }
  return { ok: true, ref: normalized, file, section };
}

function collectSpecContext(projectRoot, specRefs, role) {
  const specs = [];
  const sortedRefs = [...specRefs].sort((left, right) =>
    `${left.path}#${left.section}`.localeCompare(`${right.path}#${right.section}`)
  );
  for (const specRef of sortedRefs) {
    if (!roleMatches(specRef.roles, role)) continue;
    const validated = validateSpecRef(projectRoot, specRef, { requireSection: true });
    if (!validated.ok) return { ...validated, specRef };
    const candidate = [...specs, { ref: specRef, content: validated.section.content }];
    if (byteLength(renderSpecBlock(candidate)) > SPEC_TOTAL_LIMIT) {
      return {
        ok: false,
        code: 'SPEC_CONTEXT_TOO_LARGE',
        message: `Linked spec sections exceed the ${SPEC_TOTAL_LIMIT}-byte rendered context limit`,
        specRef,
      };
    }
    specs.push(candidate[candidate.length - 1]);
  }
  return { ok: true, specs };
}

function readContextJsonl(taskDir) {
  const source = readFileBounded(path.join(taskDir, 'context.jsonl'), LEGACY_CONTEXT_LIMIT);
  if (!source.ok)
    return source.code === 'NOT_FOUND' ? { entries: [], diagnostics: [] } : { entries: [], diagnostics: [source.code] };
  const entries = [];
  const diagnostics = [];
  const lines = source.content.split(/\r?\n/).slice(0, 256);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry && !entry._example) entries.push({ ...entry, line: index + 1 });
    } catch {
      diagnostics.push(`LEGACY_CONTEXT_INVALID_LINE:${index + 1}`);
    }
  }
  if (source.truncated || source.content.split(/\r?\n/).length > 256) diagnostics.push('LEGACY_CONTEXT_TRUNCATED');
  return { entries, diagnostics };
}

function readTaskDocument(taskDir, relativePath, maxBytes, required) {
  const normalized = normalizeRelativeProjectPath(relativePath);
  if (!normalized) return { ok: false, code: 'PATH_INVALID', message: `Invalid task artifact path: ${relativePath}` };
  const taskRoot = path.resolve(taskDir);
  const segments = normalized.split('/');
  const candidate = path.resolve(taskRoot, ...segments);
  if (!isPathInside(taskRoot, candidate))
    return { ok: false, code: 'PATH_INVALID', message: `Task artifact escapes task directory: ${relativePath}` };

  let current = taskRoot;
  try {
    const rootStat = fs.lstatSync(taskRoot);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      return { ok: false, code: 'PATH_INVALID', message: `Task directory is invalid: ${taskDir}` };
    }
    for (let index = 0; index < segments.length; index += 1) {
      current = path.join(current, segments[index]);
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) {
        return {
          ok: false,
          code: 'PATH_INVALID',
          message: `Task artifact path contains a symbolic link: ${relativePath}`,
        };
      }
      if (index < segments.length - 1 && !stat.isDirectory()) {
        return { ok: false, code: 'PATH_INVALID', message: `Task artifact parent is not a directory: ${relativePath}` };
      }
    }
    const taskReal = fs.realpathSync(taskRoot);
    const candidateReal = fs.realpathSync(candidate);
    if (!isPathInside(taskReal, candidateReal)) {
      return { ok: false, code: 'PATH_INVALID', message: `Task artifact escapes task directory: ${relativePath}` };
    }
  } catch (error) {
    if (!required && error && error.code === 'ENOENT') return { ok: true, exists: false, content: '' };
    return {
      ok: false,
      code: required ? 'TASK_CONTRACT_MISSING' : 'READ_FAILED',
      message: `Cannot read task artifact: ${relativePath}`,
    };
  }

  const source = readFileBounded(candidate, maxBytes);
  if (!source.ok) {
    if (!required && source.code === 'NOT_FOUND') return { ok: true, exists: false, content: '' };
    return {
      ok: false,
      code: required ? 'TASK_CONTRACT_MISSING' : source.code,
      message: `Cannot read task artifact: ${relativePath}`,
    };
  }
  if (required && source.truncated)
    return { ok: false, code: 'TASK_CONTRACT_TOO_LARGE', message: `${relativePath} exceeds ${maxBytes} bytes` };
  if (required && !source.content.trim())
    return { ok: false, code: 'TASK_CONTRACT_EMPTY', message: `${relativePath} is empty` };
  return { ok: true, exists: true, content: source.content, truncated: source.truncated };
}

function roleMatches(roles, role) {
  if (!Array.isArray(roles) || roles.length === 0 || role === 'all') return true;
  if (!VALID_ROLES.has(role)) return false;
  return roles.includes(role);
}

function collectSnapshot(projectRoot, resolution, mode, role) {
  const task = resolution.task;
  if (mode === 'breadcrumb') {
    return {
      kind: 'ok',
      resolution,
      task,
      paths: {
        task: task.dir,
        requirements: path.join(task.dir, 'requirements.md'),
        progress: path.join(task.dir, 'progress.md'),
      },
      documents: {},
      research: [],
      specs: [],
      diagnostics: [...resolution.diagnostics],
      totalBytes: 0,
    };
  }

  const diagnostics = [...resolution.diagnostics];
  const documents = {};
  const requirements = readTaskDocument(task.dir, 'requirements.md', REQUIREMENTS_LIMIT, true);
  if (!requirements.ok) {
    return {
      kind: 'invalid',
      resolution,
      task,
      code: requirements.code,
      message: requirements.message,
      documents,
      research: [],
      specs: [],
      diagnostics: [...diagnostics, requirements.code],
      totalBytes: 0,
    };
  }
  documents.requirements = requirements.content;
  if (byteLength(escapeXml(requirements.content)) > REQUIREMENTS_LIMIT) {
    return {
      kind: 'invalid',
      resolution,
      task,
      code: 'TASK_CONTRACT_CONTEXT_TOO_LARGE',
      message: `requirements.md exceeds the ${REQUIREMENTS_LIMIT}-byte rendered context limit`,
      documents,
      research: [],
      specs: [],
      diagnostics: [...diagnostics, 'TASK_CONTRACT_CONTEXT_TOO_LARGE'],
      totalBytes: 0,
    };
  }

  const research = [];
  if (mode !== 'authority') {
    const documentSpecs = [
      ['progress', 'progress.md', DOCUMENT_LIMIT],
      ['plan', 'plan.md', DOCUMENT_LIMIT],
      ['analysis', 'analysis.md', DOCUMENT_LIMIT],
      ['review', 'review.md', REVIEW_LIMIT],
    ];
    for (const [name, relativePath, limit] of documentSpecs) {
      const result = readTaskDocument(task.dir, relativePath, limit, false);
      if (!result.ok) {
        diagnostics.push(`${result.code}:${relativePath}`);
        continue;
      }
      if (!result.exists) continue;
      if (result.truncated) {
        diagnostics.push(`CONTEXT_OMITTED:${relativePath}:too-large`);
        continue;
      }
      documents[name] = result.content;
    }

    const researchDir = path.join(task.dir, 'research');
    try {
      const stat = fs.lstatSync(researchDir);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        diagnostics.push('PATH_INVALID:research');
      } else {
        const files = fs
          .readdirSync(researchDir, { withFileTypes: true })
          .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith('.md'))
          .map((entry) => entry.name)
          .sort();
        let remaining = RESEARCH_TOTAL_LIMIT;
        for (const file of files.slice(0, 8)) {
          if (remaining <= 0) break;
          const source = readTaskDocument(
            task.dir,
            `research/${file}`,
            Math.min(RESEARCH_FILE_LIMIT, remaining),
            false
          );
          if (!source.ok || !source.exists) {
            diagnostics.push(`${source.code || 'RESEARCH_READ_FAILED'}:research/${file}`);
            continue;
          }
          if (source.truncated) {
            diagnostics.push(`CONTEXT_OMITTED:research/${file}:too-large`);
            continue;
          }
          research.push({ path: `research/${file}`, content: source.content });
          remaining -= byteLength(source.content);
        }
        if (files.length > 8) diagnostics.push(`CONTEXT_OMITTED:research:${files.length - 8}`);
      }
    } catch (error) {
      if (!error || error.code !== 'ENOENT') diagnostics.push('RESEARCH_READ_FAILED');
    }
  }

  const collectedSpecs = collectSpecContext(projectRoot, task.specRefs, role);
  if (!collectedSpecs.ok) {
    const specRef = collectedSpecs.specRef || { path: '?', section: '?' };
    return {
      kind: 'invalid',
      resolution,
      task,
      code: collectedSpecs.code,
      message: collectedSpecs.message,
      documents,
      research,
      specs: [],
      diagnostics: [...diagnostics, `${collectedSpecs.code}:${specRef.path}#${specRef.section}`],
      totalBytes: 0,
    };
  }
  const specs = collectedSpecs.specs;

  const mandatorySnapshot = { resolution, task, documents: { requirements: documents.requirements }, specs };
  const mandatoryParts = [
    renderTaskHeader(mandatorySnapshot, mode, role),
    renderSpecBlock(specs),
    renderTaskContext([{ heading: 'Task contract', content: documents.requirements }]),
  ].filter(Boolean);
  const contextLimit =
    mode === 'session'
      ? SESSION_TASK_CONTEXT_LIMIT
      : mode === 'authority'
        ? AUTHORITY_CONTEXT_LIMIT
        : AGENT_CONTEXT_LIMIT;
  if (byteLength(mandatoryParts.join('\n\n')) > contextLimit) {
    return {
      kind: 'invalid',
      resolution,
      task,
      code: 'TASK_CONTEXT_TOO_LARGE',
      message: `Authoritative task context exceeds the ${contextLimit}-byte context limit`,
      documents,
      research,
      specs,
      diagnostics: [...diagnostics, 'TASK_CONTEXT_TOO_LARGE'],
      totalBytes: 0,
    };
  }

  const totalBytes =
    Object.values(documents).reduce((sum, value) => sum + byteLength(value), 0) +
    research.reduce((sum, item) => sum + byteLength(item.content), 0) +
    specs.reduce((sum, item) => sum + byteLength(item.content), 0);
  return {
    kind: diagnostics.some((item) => item.startsWith('CONTEXT_')) ? 'partial' : 'ok',
    resolution,
    task,
    paths: {
      task: task.dir,
      requirements: path.join(task.dir, 'requirements.md'),
      progress: path.join(task.dir, 'progress.md'),
      plan: path.join(task.dir, 'plan.md'),
      analysis: path.join(task.dir, 'analysis.md'),
      review: path.join(task.dir, 'review.md'),
    },
    documents,
    research,
    specs,
    diagnostics,
    totalBytes,
  };
}

function snapshotFingerprint(resolution) {
  if (resolution.kind !== 'active')
    return JSON.stringify([resolution.kind, resolution.stateId, resolution.stateRevision, resolution.activeTaskId]);
  return JSON.stringify([
    resolution.kind,
    resolution.stateId,
    resolution.stateRevision,
    resolution.activeTaskId,
    resolution.taskRevision,
  ]);
}

function invalidSnapshot(code, message) {
  return {
    kind: 'invalid',
    resolution: {
      kind: 'invalid',
      source: 'state',
      stateId: null,
      stateRevision: null,
      activeTaskId: null,
      code,
      message,
      diagnostics: [code],
    },
    code,
    message,
    diagnostics: [code],
  };
}

function buildTaskSnapshot(projectRoot, options) {
  const opts = options || {};
  const mode = opts.mode || 'breadcrumb';
  const role = opts.role === 'all' ? 'all' : VALID_ROLES.has(opts.role) ? opts.role : 'unknown';
  const lockLocation = validateRuntimePath(projectRoot, '.ccg/state.lock', { allowMissing: true, kind: 'file' });
  if (!lockLocation.ok) return invalidSnapshot('STATE_PATH_INVALID', lockLocation.message);
  const lockPath = lockLocation.path;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (fs.existsSync(lockPath)) {
      return invalidSnapshot('STATE_LOCKED', 'Task state is being modified; retry after the mutation finishes');
    }
    const before = resolveTaskState(projectRoot);
    if (before.kind !== 'active')
      return {
        kind: before.kind === 'invalid' ? 'invalid' : 'ok',
        resolution: before,
        diagnostics: before.diagnostics || [],
      };
    const snapshot = collectSnapshot(projectRoot, before, mode, role);
    const after = resolveTaskState(projectRoot);
    if (fs.existsSync(lockPath)) continue;
    if (snapshotFingerprint(before) === snapshotFingerprint(after)) return snapshot;
  }
  return invalidSnapshot('STATE_CHANGED', 'Task state changed while building the context snapshot');
}

function escapeXml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function truncateUtf8(value, maxBytes) {
  const text = String(value || '');
  if (byteLength(text) <= maxBytes) return text;
  const marker = '\n...(truncated)';
  const bodyLimit = Math.max(0, maxBytes - byteLength(marker));
  const buffer = Buffer.from(text, 'utf-8').subarray(0, bodyLimit);
  let body = buffer.toString('utf-8');
  if (body.endsWith('�')) body = body.slice(0, -1);
  return body + marker;
}

function renderResolution(resolution, tagName) {
  const tag = tagName || 'ccg-state';
  if (resolution.kind === 'none') return `<${tag}>\nNo active task. Use /ccg:go to start.\n</${tag}>`;
  if (resolution.kind === 'selection-required' || resolution.kind === 'migration-required') {
    const candidates = (resolution.candidates || [])
      .map((candidate) => `- ${escapeXml(candidate.id)}: ${escapeXml(candidate.title)}`)
      .join('\n');
    return `<${tag}>\n${escapeXml(resolution.code)}\n${candidates}\nChoose a task explicitly before continuing.\n</${tag}>`;
  }
  if (resolution.kind === 'recovery-required' || resolution.kind === 'invalid') {
    const code = resolution.reasonCode || resolution.code;
    return `<${tag}>\n${escapeXml(code)}\n${escapeXml(resolution.message)}\nUse the task controller to resolve this state before continuing.\n</${tag}>`;
  }
  return '';
}

function renderBreadcrumb(snapshot) {
  if (!snapshot || snapshot.resolution.kind !== 'active') {
    return truncateUtf8(renderResolution(snapshot.resolution, 'ccg-state'), BREADCRUMB_CONTEXT_LIMIT);
  }
  const task = snapshot.task;
  const lines = [
    '<ccg-state>',
    `Task: ${escapeXml(task.title)} [${escapeXml(task.id)}]`,
    `Status: active`,
    `Strategy: ${escapeXml(task.strategy)}`,
    `Phase: ${escapeXml(task.currentPhase)}`,
    `Next: ${escapeXml(task.nextAction)}`,
    `Revision: state=${snapshot.resolution.stateRevision}, task=${task.revision}`,
  ];
  if (task.gate) lines.push(`Gate: ${escapeXml(task.gate)}`);
  for (const diagnostic of snapshot.diagnostics || []) lines.push(`Diagnostic: ${escapeXml(diagnostic)}`);
  lines.push(`Dir: ${escapeXml(task.dir)}`);
  lines.push('</ccg-state>');
  return truncateUtf8(lines.join('\n'), BREADCRUMB_CONTEXT_LIMIT);
}

function renderTaskHeader(snapshot, mode, role) {
  const tag = mode === 'session' ? 'active-task' : mode === 'authority' ? 'ccg-authority' : 'ccg-active-task';
  const task = snapshot.task;
  const parts = [
    `<${tag}>`,
    `Task: ${escapeXml(task.title)} [${escapeXml(task.id)}]`,
    'Status: active',
    `Strategy: ${escapeXml(task.strategy)}`,
    `Phase: ${escapeXml(task.currentPhase)}`,
    `Next: ${escapeXml(task.nextAction)}`,
    `Revision: state=${snapshot.resolution.stateRevision}, task=${task.revision}`,
    `Dir: ${escapeXml(task.dir)}`,
  ];
  if (role) parts.push(`Role: ${escapeXml(role)}`);
  if (task.gate) parts.push(`Gate: ${escapeXml(task.gate)}`);
  if (mode === 'authority') {
    parts.push(
      'Authority order: linked spec sections &gt; task contract &gt; current user instruction &gt; approved plan &gt; progress &gt; summaries and model inference.',
      'Before the next decision, compare entity names, versions, dependency directions, allowed actions, prohibited actions, exclusions, stop conditions, and acceptance criteria. If a lower source conflicts, stop and report the exact field.'
    );
  }
  parts.push(`</${tag}>`);
  return parts.join('\n');
}

function renderSpecBlock(specs) {
  if (!Array.isArray(specs) || specs.length === 0) return '';
  const sections = specs.map((item) => {
    const label = `${item.ref.path}#${item.ref.section} (${item.ref.purpose})`;
    return `## ${escapeXml(label)}\n${escapeXml(item.content)}`;
  });
  return `<ccg-specs>\n${sections.join('\n\n')}\n</ccg-specs>`;
}

function renderTaskContext(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return '';
  const sections = entries.map((entry) => `## ${escapeXml(entry.heading)}\n${escapeXml(entry.content)}`);
  return `<ccg-task-context>\n${sections.join('\n\n')}\n</ccg-task-context>`;
}

function renderDiagnostics(diagnostics) {
  if (!Array.isArray(diagnostics) || diagnostics.length === 0) return '';
  return `<ccg-context-diagnostics>\n${diagnostics.map((item) => `- ${escapeXml(item)}`).join('\n')}\n</ccg-context-diagnostics>`;
}

function renderTaskSnapshot(snapshot, mode, role, maxBytes) {
  const tag = mode === 'session' ? 'active-task' : mode === 'authority' ? 'ccg-authority' : 'ccg-active-task';
  if (!snapshot || snapshot.resolution.kind !== 'active') return renderResolution(snapshot.resolution, tag);
  if (snapshot.kind === 'invalid') {
    return `<${tag}>\n${escapeXml(snapshot.code)}\n${escapeXml(snapshot.message)}\n</${tag}>`;
  }

  const limit =
    Number.isSafeInteger(maxBytes) && maxBytes > 0
      ? maxBytes
      : mode === 'session'
        ? SESSION_TASK_CONTEXT_LIMIT
        : mode === 'authority'
          ? AUTHORITY_CONTEXT_LIMIT
          : AGENT_CONTEXT_LIMIT;
  const header = renderTaskHeader(snapshot, mode, role);
  const specs = renderSpecBlock(snapshot.specs);
  const contextEntries = [{ heading: 'Task contract', content: snapshot.documents.requirements }];
  const mandatoryParts = [header, specs, renderTaskContext(contextEntries)].filter(Boolean);
  const mandatory = mandatoryParts.join('\n\n');
  if (byteLength(mandatory) > limit) {
    return `<${tag}>\nTASK_CONTEXT_TOO_LARGE\nAuthoritative task context exceeds ${limit} bytes\n</${tag}>`;
  }

  const localDiagnostics = [...(snapshot.diagnostics || [])];
  const optionalEntries = [];
  if (mode !== 'authority') {
    const documentHeadings = {
      plan: 'Plan',
      progress: 'Progress',
      analysis: 'Analysis',
      review: 'Review',
    };
    for (const name of ['plan', 'progress', 'analysis', 'review']) {
      if (snapshot.documents && snapshot.documents[name]) {
        optionalEntries.push({ key: name, heading: documentHeadings[name], content: snapshot.documents[name] });
      }
    }
    for (const item of snapshot.research || []) {
      optionalEntries.push({ key: item.path, heading: `Research: ${item.path}`, content: item.content });
    }
  }

  for (const entry of optionalEntries) {
    const candidateEntries = [...contextEntries, entry];
    const candidateParts = [header, specs, renderTaskContext(candidateEntries)].filter(Boolean);
    if (byteLength(candidateParts.join('\n\n')) <= limit) {
      contextEntries.push(entry);
    } else {
      localDiagnostics.push(`CONTEXT_OMITTED:${entry.key}:render-budget`);
    }
  }

  const parts = [header, specs, renderTaskContext(contextEntries)].filter(Boolean);
  const diagnostics = renderDiagnostics(localDiagnostics);
  if (diagnostics && byteLength([...parts, diagnostics].join('\n\n')) <= limit) parts.push(diagnostics);
  return parts.join('\n\n');
}

function detectTechStack(projectRoot) {
  const indicators = [
    { file: 'package.json', stack: 'Node.js' },
    { file: 'go.mod', stack: 'Go' },
    { file: 'pyproject.toml', stack: 'Python' },
    { file: 'Cargo.toml', stack: 'Rust' },
    { file: 'pom.xml', stack: 'Java' },
    { file: 'build.gradle', stack: 'Java/Kotlin' },
  ];
  const found = indicators.filter(({ file }) => fs.existsSync(path.join(projectRoot, file))).map(({ stack }) => stack);
  return found.length > 0 ? found.join(' + ') : 'Unknown';
}

function outputHook(eventName, additionalContext, extra) {
  const hookSpecificOutput = { hookEventName: eventName, ...(extra || {}) };
  if (additionalContext) hookSpecificOutput.additionalContext = additionalContext;
  process.stdout.write(`${JSON.stringify({ hookSpecificOutput })}\n`);
}

let atomicCounter = 0;

function fsyncDirectory(directory) {
  if (process.platform === 'win32') return;
  let fd;
  try {
    fd = fs.openSync(directory, 'r');
    fs.fsyncSync(fd);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function atomicWriteFile(filePath, content, options) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  atomicCounter += 1;
  const tempPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${atomicCounter}.tmp`);
  const mode = options && options.mode ? options.mode : 0o600;
  let fd;
  try {
    fd = fs.openSync(tempPath, 'wx', mode);
    fs.writeFileSync(fd, content, 'utf-8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tempPath, filePath);
    fsyncDirectory(directory);
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // The original write error remains authoritative.
      }
    }
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // A successful rename removes the temporary path.
    }
  }
}

function atomicWriteJson(filePath, value) {
  atomicWriteFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function sanitizeSessionId(sessionId) {
  const value = String(sessionId || '').replace(/[^A-Za-z0-9._-]/g, '_');
  return value.slice(0, 128);
}

function getTurnsPath(taskDir, sessionId) {
  const safe = sanitizeSessionId(sessionId);
  return safe ? path.join(taskDir, '.turns', `${safe}.json`) : null;
}

function validateTaskSubdirectory(taskDir, name, allowMissing) {
  const taskRoot = path.resolve(taskDir);
  const directory = path.join(taskRoot, name);
  try {
    const rootStat = fs.lstatSync(taskRoot);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      return { ok: false, code: 'PATH_INVALID', message: `Task directory is invalid: ${taskDir}` };
    }
    const stat = fs.lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      return { ok: false, code: 'PATH_INVALID', message: `Task runtime directory is invalid: ${name}` };
    }
    const taskReal = fs.realpathSync(taskRoot);
    const directoryReal = fs.realpathSync(directory);
    if (!isPathInside(taskReal, directoryReal)) {
      return { ok: false, code: 'PATH_INVALID', message: `Task runtime directory escapes task root: ${name}` };
    }
    return { ok: true, exists: true, path: directory };
  } catch (error) {
    if (allowMissing && error && error.code === 'ENOENT') return { ok: true, exists: false, path: directory };
    return { ok: false, code: 'PATH_INVALID', message: `Cannot inspect task runtime directory: ${name}` };
  }
}

function readTurns(taskDir, sessionId) {
  const turnsPath = getTurnsPath(taskDir, sessionId);
  if (!turnsPath) return { ok: false, code: 'SESSION_ID_MISSING', turns: [] };
  const turnsDirectory = validateTaskSubdirectory(taskDir, '.turns', true);
  if (!turnsDirectory.ok) return { ok: false, code: turnsDirectory.code, turns: [] };
  const existing = readJsonDetailed(turnsPath, 16 * 1024);
  if (!existing.ok) return { ok: false, code: 'TURN_STATE_INVALID', turns: [] };
  if (!existing.exists) return { ok: true, turns: [], path: turnsPath };
  if (!Array.isArray(existing.data)) return { ok: false, code: 'TURN_STATE_INVALID', turns: [], path: turnsPath };
  const valid = existing.data.every(
    (turn) => turn && typeof turn === 'object' && typeof turn.phase === 'string' && typeof turn.next === 'string'
  );
  return valid
    ? { ok: true, turns: existing.data.slice(-10), path: turnsPath }
    : { ok: false, code: 'TURN_STATE_INVALID', turns: [], path: turnsPath };
}

function trackTurn(taskDir, sessionId, phase, nextAction) {
  const current = readTurns(taskDir, sessionId);
  if (!current.ok) return current;
  const turnsDirectory = validateTaskSubdirectory(taskDir, '.turns', true);
  if (!turnsDirectory.ok) return { ok: false, code: turnsDirectory.code, turns: [] };
  if (!turnsDirectory.exists) {
    try {
      fs.mkdirSync(turnsDirectory.path, { mode: 0o700 });
      fsyncDirectory(taskDir);
    } catch (error) {
      if (!error || error.code !== 'EEXIST') return { ok: false, code: 'TURN_STATE_WRITE_FAILED', turns: [] };
    }
  }
  const verifiedDirectory = validateTaskSubdirectory(taskDir, '.turns', false);
  if (!verifiedDirectory.ok) return { ok: false, code: verifiedDirectory.code, turns: [] };
  const turns = [
    ...current.turns,
    { phase: String(phase || ''), next: String(nextAction || ''), ts: new Date().toISOString() },
  ].slice(-10);
  atomicWriteJson(current.path, turns);
  return { ok: true, turns };
}

function detectLoop(turns, threshold) {
  const values = Array.isArray(turns) ? turns : turns && turns.turns;
  const count = threshold || 3;
  if (!Array.isArray(values) || values.length < count) return null;
  const recent = values.slice(-count);
  const key = `${recent[0].phase}|${recent[0].next}`;
  if (!recent.every((turn) => `${turn.phase}|${turn.next}` === key)) return null;
  return { phase: recent[0].phase, nextAction: recent[0].next, count };
}

function ensureLocalCcgExclude(projectRoot) {
  try {
    execFileSync('git', ['check-ignore', '-q', '.ccg/state.json'], {
      cwd: projectRoot,
      stdio: 'ignore',
    });
    return { ok: true, changed: false };
  } catch {
    // Add a worktree-local exclusion below.
  }
  try {
    const excludePathRaw = execFileSync('git', ['rev-parse', '--git-path', 'info/exclude'], {
      cwd: projectRoot,
      stdio: 'pipe',
      encoding: 'utf-8',
    }).trim();
    const excludePath = path.isAbsolute(excludePathRaw) ? excludePathRaw : path.resolve(projectRoot, excludePathRaw);
    const source = readFileBounded(excludePath, 256 * 1024);
    if (!source.ok && source.code !== 'NOT_FOUND') return { ok: false, code: 'GIT_EXCLUDE_UPDATE_FAILED' };
    if (source.ok && source.truncated) return { ok: false, code: 'GIT_EXCLUDE_TOO_LARGE' };
    const current = source.ok ? source.content : '';
    const lines = current.split(/\r?\n/).map((line) => line.trim());
    if (!lines.includes('/.ccg/')) {
      const prefix = current && !current.endsWith('\n') ? `${current}\n` : current;
      atomicWriteFile(excludePath, `${prefix}/.ccg/\n`);
      return { ok: true, path: excludePath, changed: true };
    }
    return { ok: true, path: excludePath, changed: false };
  } catch {
    return { ok: false, code: 'GIT_EXCLUDE_UPDATE_FAILED' };
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function chooseHeredocDelimiter(command, body, context) {
  let delimiter;
  do {
    delimiter = `CCG_CONTEXT_${randomUUID().replace(/-/g, '').toUpperCase()}`;
  } while (
    new RegExp(`^${escapeRegExp(delimiter)}$`, 'm').test(command) ||
    new RegExp(`^${escapeRegExp(delimiter)}$`, 'm').test(body) ||
    new RegExp(`^${escapeRegExp(delimiter)}$`, 'm').test(context)
  );
  return delimiter;
}

function findCodeagentWrapperCalls(command) {
  if (typeof command !== 'string') return [];
  const calls = [];
  const pattern =
    /(?:^|[\s;&|()])(?:(['"])((?:[^'"\r\n]*[/\\])?codeagent-wrapper(?:\.exe)?)\1|((?:[^\s"';&|()]*[/\\])?codeagent-wrapper(?:\.exe)?))(?=[\s;&|()]|$)/g;
  let match;
  while ((match = pattern.exec(command)) !== null) {
    const token = match[2] || match[3];
    const offset = match[0].lastIndexOf(token);
    const start = match.index + offset;
    calls.push({ start, end: start + token.length + (match[1] ? 1 : 0), token });
  }
  return calls;
}

function hasShellCommandBoundary(value) {
  let quote = null;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote === "'") {
      if (character === "'") quote = null;
      continue;
    }
    if (character === '"') {
      quote = quote === '"' ? null : quote || '"';
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (quote === '"') {
      if (character === '$' && value[index + 1] === '(') return true;
      if (character === '`') return true;
      continue;
    }
    if (character === "'") {
      quote = "'";
      continue;
    }
    if ('\r\n;|&()'.includes(character)) return true;
  }
  return false;
}

function injectIntoQuotedHeredoc(command, context, options) {
  if (typeof command !== 'string' || typeof context !== 'string') {
    return { ok: false, code: 'CONTEXT_NOT_INJECTED', message: 'Command and context must be strings' };
  }
  const wrapperCalls = findCodeagentWrapperCalls(command);
  if (wrapperCalls.length !== 1) {
    return { ok: false, code: 'CONTEXT_NOT_INJECTED', message: 'Expected exactly one codeagent-wrapper invocation' };
  }
  const matches = [...command.matchAll(/<<(-)?\s*(['"])([A-Za-z_][A-Za-z0-9_]*)\2/g)];
  if (matches.length !== 1) {
    return { ok: false, code: 'CONTEXT_NOT_INJECTED', message: 'Expected exactly one quoted heredoc' };
  }
  const match = matches[0];
  const openerStart = match.index;
  const openerEnd = openerStart + match[0].length;
  const wrapperCall = wrapperCalls[0];
  if (openerStart <= wrapperCall.end || hasShellCommandBoundary(command.slice(wrapperCall.end, openerStart))) {
    return {
      ok: false,
      code: 'CONTEXT_NOT_INJECTED',
      message: 'The quoted heredoc does not belong to the codeagent-wrapper command',
    };
  }
  const firstNewline = command.indexOf('\n', openerEnd);
  if (firstNewline < 0) return { ok: false, code: 'CONTEXT_NOT_INJECTED', message: 'Heredoc body is missing' };
  const oldDelimiter = match[3];
  const closingPattern = new RegExp(`^(${match[1] ? '\\t*' : ''})${escapeRegExp(oldDelimiter)}(\\r?)$`, 'gm');
  closingPattern.lastIndex = firstNewline + 1;
  const closings = [];
  let closing;
  while ((closing = closingPattern.exec(command)) !== null) closings.push(closing);
  if (closings.length !== 1)
    return { ok: false, code: 'CONTEXT_NOT_INJECTED', message: 'Expected exactly one heredoc closing delimiter' };

  const bodyStart = firstNewline + 1;
  const bodyEnd = closings[0].index;
  const body = command.slice(bodyStart, bodyEnd);
  let injectedBody;
  if (options && options.parallel) {
    const markers = [...body.matchAll(/^---CONTENT---\r?$/gm)];
    if (markers.length === 0)
      return { ok: false, code: 'CONTEXT_NOT_INJECTED', message: 'Parallel task content markers are missing' };
    injectedBody = body.replace(/^---CONTENT---\r?$/gm, (line) => `${line}\n${context}`);
  } else {
    injectedBody = `${context}\n\n${body}`;
  }

  let delimiter = oldDelimiter;
  if (new RegExp(`^${escapeRegExp(oldDelimiter)}$`, 'm').test(context)) {
    delimiter = chooseHeredocDelimiter(command, body, context);
  }
  const newOpener = `${match[0].slice(0, match[0].indexOf(match[2]))}${match[2]}${delimiter}${match[2]}`;
  const closingLine = `${closings[0][1]}${delimiter}${closings[0][2]}`;
  return {
    ok: true,
    command:
      command.slice(0, openerStart) +
      newOpener +
      command.slice(openerEnd, bodyStart) +
      injectedBody +
      command.slice(bodyEnd, closings[0].index) +
      closingLine +
      command.slice(closings[0].index + closings[0][0].length),
  };
}

module.exports = {
  STATE_SCHEMA_VERSION,
  TASK_SCHEMA_VERSION,
  HOOK_INPUT_LIMIT,
  STATE_FILE_LIMIT,
  TASK_FILE_LIMIT,
  TRANSACTION_FILE_LIMIT,
  LEGACY_CONTEXT_LIMIT,
  SESSION_CONTEXT_LIMIT,
  SESSION_TASK_CONTEXT_LIMIT,
  BREADCRUMB_CONTEXT_LIMIT,
  AUTHORITY_CONTEXT_LIMIT,
  AGENT_CONTEXT_LIMIT,
  VALID_ROLES,
  findProjectRoot,
  normalizeTaskStatus,
  normalizeLegacyTaskStatus,
  isTerminalStatus,
  isValidTaskId,
  getStatePath,
  getTasksDir,
  getTaskDir,
  getTaskPath,
  validateRuntimePath,
  readFileBounded,
  readFileSafe,
  readJsonDetailed,
  readJsonSafe,
  readPendingTransaction,
  readState,
  readTask,
  listTasks,
  listOpenTasks,
  resolveTaskState,
  getActiveTask,
  readStdinBounded,
  readHookInput,
  normalizeRelativeProjectPath,
  resolveProjectFile,
  extractMarkdownSection,
  validateSpecRef,
  collectSpecContext,
  readContextJsonl,
  buildTaskSnapshot,
  renderResolution,
  renderBreadcrumb,
  renderTaskSnapshot,
  escapeXml,
  truncateUtf8,
  detectTechStack,
  getGitInfo,
  outputHook,
  fsyncDirectory,
  atomicWriteFile,
  atomicWriteJson,
  readTurns,
  trackTurn,
  detectLoop,
  ensureLocalCcgExclude,
  findCodeagentWrapperCalls,
  injectIntoQuotedHeredoc,
  inspectReturnChain,
};
