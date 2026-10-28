'use strict';

const path = require('path');
const { findProjectRoot, isValidSessionKey, readStdinBounded, isValidTaskId } = require('./task-utils.js');
const fs = require('fs');

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

function readRequest() {
  const raw = readStdinBounded(REQUEST_LIMIT);
  if (!raw.trim()) fail('INVALID_REQUEST', 'A JSON request is required on stdin');
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

function validateTextContent(value, key, maxBytes, required) {
  if (typeof value !== 'string') {
    if (required) fail('INVALID_REQUEST', `${key} must be a string`);
    return null;
  }
  if (required && !value.trim()) fail('INVALID_REQUEST', `${key} must not be empty`);
  const content = value.endsWith('\n') ? value : `${value}\n`;
  if (Buffer.byteLength(content, 'utf-8') > maxBytes) fail('INVALID_REQUEST', `${key} exceeds ${maxBytes} bytes`);
  return content;
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
  const { complexity, risk } = validateTaskClassification(input);
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

function validateTaskClassification(input) {
  const complexity = requireString(input, 'complexity', 2);
  if (!['S', 'M', 'L', 'XL'].includes(complexity)) fail('INVALID_REQUEST', 'task.complexity must be S, M, L, or XL');
  const risk = requireString(input, 'risk', 6);
  if (!['low', 'medium', 'high'].includes(risk)) fail('INVALID_REQUEST', 'task.risk must be low, medium, or high');
  return { complexity, risk };
}

module.exports = {
  REQUIREMENTS_LIMIT,
  ARTIFACT_LIMIT,
  VALID_START_MODES,
  VALID_SPEC_EVOLUTION,
  VALID_ARTIFACTS,
  TaskStateError,
  fail,
  parseArgs,
  resolveRoot,
  resolveSessionKey,
  readRequest,
  requireString,
  requireNullableTaskId,
  requireSafeRevision,
  requireExpected,
  validateTextContent,
  truncateUtf8ToBytes,
  validateTaskInput,
};
