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

function main() {
  const input = readHookInput();
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const root = findProjectRoot(cwd);
  if (!root) return;

  const supplemental = [];
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
      configRaw && /primary\s*=\s*"([\w-]+)"/.test(configRaw)
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

  const snapshot = buildTaskSnapshot(root, { mode: 'session', role: 'all' });
  const sections = [renderTaskSnapshot(snapshot, 'session', 'all', SESSION_TASK_CONTEXT_LIMIT)];
  for (const section of supplemental) {
    if (Buffer.byteLength(renderSession([...sections, section]), 'utf-8') <= SESSION_CONTEXT_LIMIT)
      sections.push(section);
  }

  outputHook('SessionStart', truncateUtf8(renderSession(sections), SESSION_CONTEXT_LIMIT));
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  outputHook('SessionStart', `<ccg-session-error>CCG_HOOK_ERROR\n${escapeXml(message)}</ccg-session-error>`);
}
