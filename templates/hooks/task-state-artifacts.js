'use strict';

const {
  requireString,
  validateTextContent,
  ARTIFACT_LIMIT,
  REQUIREMENTS_LIMIT,
  fail,
  TaskStateError,
  VALID_ARTIFACTS,
  VALID_SPEC_EVOLUTION,
} = require('./task-state-core.js');
const { withStateLock, runTaskTransaction, jsonContent, taskForWrite, writeTask } = require('./task-state-store.js');
const { assertActiveMutation, bumpTask } = require('./task-state-model.js');
const path = require('path');
const { getTaskPath, fsyncDirectory, validateSpecRef, collectSpecContext } = require('./task-utils.js');
const fs = require('fs');

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

module.exports = {
  operationCheckpoint,
  operationUpdateRequirements,
  operationWriteArtifact,
  operationLinkSpec,
  operationUnlinkSpec,
  operationSetSpecEvolution,
};
