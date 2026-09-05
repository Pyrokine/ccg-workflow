#!/usr/bin/env node
// CCG SubAgent Context Hook — PreToolUse (Bash|Agent matcher)
// Injects task context into the actual Agent prompt or wrapper stdin.

'use strict';

const {
  findProjectRoot,
  readHookInput,
  buildTaskSnapshot,
  renderTaskSnapshot,
  renderResolution,
  findCodeagentWrapperCalls,
  injectIntoQuotedHeredoc,
  outputHook,
  escapeXml,
} = require('./task-utils.js');

const ROLE_FILE_MAP = {
  reviewer: 'review',
  analyzer: 'research',
  debugger: 'debug',
  tester: 'review',
  architect: 'implement',
  optimizer: 'implement',
  frontend: 'implement',
  builder: 'implement',
};

const AGENT_NAME_PATTERNS = [
  { pattern: /review|check|audit|qa/i, role: 'review' },
  { pattern: /research|scout|explore|analy|plan/i, role: 'research' },
  { pattern: /debug|diagnos/i, role: 'debug' },
  { pattern: /dev|builder|fix|impl|architect|frontend|optimizer/i, role: 'implement' },
];

let protectExecution = false;

function denyTool(code, message, additionalContext) {
  outputHook('PreToolUse', additionalContext, {
    permissionDecision: 'deny',
    permissionDecisionReason: `${code}: ${message}`,
  });
}

function explicitRole(value) {
  const match = String(value || '').match(/(?:^|\n|\s)CCG_ROLE\s*[:=]\s*(research|implement|review|debug)(?:\s|$)/i);
  return match ? match[1].toLowerCase() : null;
}

function detectRole(isCodeagentCall, command, toolInput) {
  const explicit = explicitRole(isCodeagentCall ? command : toolInput.prompt);
  if (explicit) return explicit;

  if (isCodeagentCall) {
    const roleMatch = command.match(/ROLE_FILE\s*:\s*[^\n\r]*[/\\]([\w-]+)\.md/i);
    return roleMatch ? ROLE_FILE_MAP[roleMatch[1].toLowerCase()] || 'unknown' : 'unknown';
  }

  const agentName = String(toolInput.name || toolInput.subagent_type || '');
  for (const { pattern, role } of AGENT_NAME_PATTERNS) {
    if (pattern.test(agentName)) return role;
  }
  // A generic Agent has no reliable role label. Supplying every linked section
  // is preferable to silently omitting role-scoped authority from its prompt.
  return 'all';
}

function main() {
  const input = readHookInput();
  const toolInput = input.tool_input || {};
  const command = typeof toolInput.command === 'string' ? toolInput.command : '';
  const isCodeagentCall = input.tool_name === 'Bash' && findCodeagentWrapperCalls(command).length > 0;
  const isAgentSpawn = input.tool_name === 'Agent' && typeof toolInput.prompt === 'string';
  if (!isCodeagentCall && !isAgentSpawn) return;
  protectExecution = true;

  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const root = findProjectRoot(cwd);
  if (!root) return;

  const role = detectRole(isCodeagentCall, command, toolInput);
  const snapshot = buildTaskSnapshot(root, { mode: 'agent', role });
  if (snapshot.resolution.kind === 'none') return;
  if (snapshot.resolution.kind !== 'active' || snapshot.kind === 'invalid') {
    const code =
      snapshot.resolution.kind === 'active'
        ? snapshot.code || 'TASK_CONTEXT_INVALID'
        : snapshot.resolution.reasonCode || snapshot.resolution.code || 'TASK_STATE_UNAVAILABLE';
    const message =
      snapshot.resolution.kind === 'active'
        ? snapshot.message || 'Task context is invalid'
        : snapshot.resolution.message || 'Resolve task state before continuing';
    const diagnostic =
      snapshot.resolution.kind === 'active'
        ? `<ccg-task-state>${escapeXml(code)}\n${escapeXml(message)}</ccg-task-state>`
        : renderResolution(snapshot.resolution, 'ccg-task-state');
    denyTool(code, message, diagnostic);
    return;
  }

  const injectedContext = `<ccg-injected-context>\n${renderTaskSnapshot(snapshot, 'agent', role)}\n</ccg-injected-context>`;
  if (isAgentSpawn) {
    outputHook('PreToolUse', null, {
      updatedInput: {
        ...toolInput,
        prompt: `${injectedContext}\n\n---\n\n${toolInput.prompt}`,
      },
    });
    return;
  }

  const rewritten = injectIntoQuotedHeredoc(command, injectedContext, {
    parallel: /(?:^|\s)--parallel(?:\s|$)/.test(command),
  });
  if (!rewritten.ok) {
    denyTool(
      'CONTEXT_NOT_INJECTED',
      rewritten.message,
      `<ccg-task-state>CONTEXT_NOT_INJECTED\n${escapeXml(rewritten.message)}\nThe wrapper request was blocked.</ccg-task-state>`
    );
    return;
  }

  outputHook('PreToolUse', null, {
    updatedInput: {
      ...toolInput,
      command: rewritten.command,
    },
  });
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const diagnostic = `<ccg-task-state>CCG_HOOK_ERROR\n${escapeXml(message)}</ccg-task-state>`;
  if (protectExecution) denyTool('CCG_HOOK_ERROR', message, diagnostic);
  else outputHook('PreToolUse', diagnostic);
}
