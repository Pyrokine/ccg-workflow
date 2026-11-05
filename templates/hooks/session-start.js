#!/usr/bin/env node
// CCG Session Start Hook — SessionStart
// Restores project and active-task context for every session start source.

'use strict';

const path = require('path');
const fs = require('fs');
const {
  findProjectRoot,
  readFileSafe,
  readHookInput,
  deriveSessionKey,
  buildTaskSnapshot,
  renderTaskSnapshot,
  detectTechStack,
  getGitInfo,
  outputHook,
  escapeXml,
  truncateUtf8,
  SESSION_CONTEXT_LIMIT,
  SESSION_TASK_CONTEXT_LIMIT,
} = require('./task-utils.js');

function renderSession(sections) {
  return `<ccg-session>\n${sections.join('\n\n')}\n</ccg-session>`;
}

function openEnvironmentFile(envPath) {
  try {
    const stat = fs.lstatSync(envPath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error('Invalid environment file');
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw Object.assign(new Error('Invalid environment file'), { code: 'CLAUDE_ENV_FILE_INVALID' });
    }
  }
  const flags =
    fs.constants.O_RDWR |
    fs.constants.O_APPEND |
    fs.constants.O_CREAT |
    (fs.constants.O_NOFOLLOW || 0) |
    (fs.constants.O_NONBLOCK || 0);
  const descriptor = fs.openSync(envPath, flags, 0o600);
  try {
    if (!fs.fstatSync(descriptor).isFile()) {
      throw Object.assign(new Error('Invalid environment file'), { code: 'CLAUDE_ENV_FILE_INVALID' });
    }
    return descriptor;
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
}

function appendSessionKey(envPath, sessionKey) {
  const descriptor = openEnvironmentFile(envPath);
  try {
    const content = fs.readFileSync(descriptor, 'utf8');
    const assignment = `export CCG_SESSION_KEY='${sessionKey}'`;
    const previous = content
      .split(/\r?\n/u)
      .filter((line) => /^(?:export\s+)?CCG_SESSION_KEY=/u.test(line))
      .at(-1);
    if (previous !== assignment) {
      const separator = content && !content.endsWith('\n') ? '\n' : '';
      fs.writeFileSync(descriptor, `${separator}${assignment}\n`, 'utf8');
    }
    return { ok: true };
  } finally {
    fs.closeSync(descriptor);
  }
}

function releaseEnvironmentLock(lockPath, descriptor) {
  try {
    const owned = fs.fstatSync(descriptor);
    const current = fs.lstatSync(lockPath);
    if (!current.isFile() || current.isSymbolicLink() || owned.dev !== current.dev || owned.ino !== current.ino) {
      throw new Error('Environment lock identity changed');
    }
    fs.unlinkSync(lockPath);
  } finally {
    fs.closeSync(descriptor);
  }
}

function exportSessionKey(sessionKey) {
  const envPath = process.env.CLAUDE_ENV_FILE;
  if (!envPath) {
    return { ok: false, code: 'CLAUDE_ENV_FILE_MISSING' };
  }
  const lockPath = envPath + '.ccg.lock';
  let lock;
  let result;
  try {
    lock = fs.openSync(lockPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    fs.writeFileSync(lock, `${process.pid}\n`, 'utf8');
    result = appendSessionKey(envPath, sessionKey);
  } catch (error) {
    const code = lock === undefined && error?.code === 'EEXIST' ? 'CLAUDE_ENV_FILE_BUSY' : error?.code;
    result = { ok: false, code: /^CLAUDE_ENV_FILE_/u.test(code) ? code : 'CLAUDE_ENV_FILE_WRITE_FAILED' };
  } finally {
    if (lock !== undefined) {
      try {
        releaseEnvironmentLock(lockPath, lock);
      } catch {
        result = { ok: false, code: 'CLAUDE_ENV_FILE_LOCK_RELEASE_FAILED' };
      }
    }
  }
  return result;
}

function main() {
  const input = readHookInput();
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const root = findProjectRoot(cwd);
  if (!root) {
    return;
  }

  const sessionKey = deriveSessionKey('claude', input.session_id);
  const supplemental = [];
  if (sessionKey) {
    const exported = exportSessionKey(sessionKey);
    if (!exported.ok) {
      supplemental.push(`<session-env>Diagnostic: ${exported.code}</session-env>`);
    }
  } else {
    supplemental.push('<session-env>Diagnostic: SESSION_KEY_REQUIRED</session-env>');
  }
  const git = getGitInfo(root);
  supplemental.push(`<project>
Tech: ${escapeXml(detectTechStack(root))}
Branch: ${escapeXml(git.branch)}
Dirty files: ${git.dirtyCount}
Root: ${escapeXml(root)}
</project>`);

  const configPath = path.join(root, '.ccg', 'config.toml');
  if (fs.existsSync(configPath)) {
    const configRaw = readFileSafe(configPath, 16 * 1024);
    const models =
      configRaw && /primary\s*=\s*"[\w-]+"/.test(configRaw)
        ? 'Configured (see .ccg/config.toml)'
        : 'Default (frontend=claude, backend=claude)';
    supplemental.push(`<models>${models}</models>`);
  } else {
    supplemental.push('<models>Default (frontend=claude, backend=claude)</models>');
  }

  supplemental.push(`<commands>
Key commands: /ccg:go (smart entry), /ccg:commit, /ccg:review
All /ccg:* commands available. Use /ccg:go for intelligent routing.
</commands>`);

  const snapshot = buildTaskSnapshot(root, { mode: 'session', role: 'all', sessionKey });
  const sections = [renderTaskSnapshot(snapshot, 'session', 'all', SESSION_TASK_CONTEXT_LIMIT)];
  for (const section of supplemental) {
    if (Buffer.byteLength(renderSession([...sections, section]), 'utf-8') <= SESSION_CONTEXT_LIMIT) {
      sections.push(section);
    }
  }

  outputHook('SessionStart', truncateUtf8(renderSession(sections), SESSION_CONTEXT_LIMIT));
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  outputHook('SessionStart', `<ccg-session-error>CCG_HOOK_ERROR\n${escapeXml(message)}</ccg-session-error>`);
}
