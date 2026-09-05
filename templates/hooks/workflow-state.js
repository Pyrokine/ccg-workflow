#!/usr/bin/env node
// CCG Workflow State Hook — authority refresh after prompts and external results

'use strict';

const {
  findProjectRoot,
  readHookInput,
  buildTaskSnapshot,
  renderTaskSnapshot,
  outputHook,
  trackTurn,
  detectLoop,
  findCodeagentWrapperCalls,
  truncateUtf8,
  escapeXml,
  AUTHORITY_CONTEXT_LIMIT,
} = require('./task-utils.js');

const SUPPORTED_EVENTS = new Set(['UserPromptSubmit', 'PostToolUse', 'PostToolUseFailure']);
let outputEventName = 'UserPromptSubmit';

function isWrapperCall(input) {
  const toolInput = input.tool_input || {};
  return (
    input.tool_name === 'Bash' &&
    typeof toolInput.command === 'string' &&
    findCodeagentWrapperCalls(toolInput.command).length > 0
  );
}

function isBackgroundLaunch(input) {
  const toolInput = input.tool_input || {};
  if (toolInput.run_in_background === true) return true;

  const response = input.tool_response;
  if (typeof response === 'string') {
    return /(?:running|started|launched) in (?:the )?background|background task (?:id|ID)|task (?:id|ID):/i.test(
      response
    );
  }
  if (!response || typeof response !== 'object' || Array.isArray(response)) return false;
  if (response.isAsync === true || response.background === true) return true;
  if (['pending', 'running'].includes(String(response.status || '').toLowerCase())) return true;

  const idKeys = ['task_id', 'taskId', 'agent_id', 'agentId', 'backgroundTaskId'];
  const hasTaskId = idKeys.some((key) => typeof response[key] === 'string' && response[key].trim());
  const resultKeys = ['result', 'output', 'content', 'stdout', 'stderr', 'error', 'exitCode', 'exit_code'];
  const hasResult = resultKeys.some(
    (key) => response[key] !== undefined && response[key] !== null && response[key] !== ''
  );
  return hasTaskId && !hasResult;
}

function shouldRefresh(input, eventName) {
  if (eventName === 'UserPromptSubmit') return true;
  if (eventName === 'PostToolUseFailure') return input.tool_name === 'Agent' || isWrapperCall(input);
  if (eventName !== 'PostToolUse') return false;
  if (input.tool_name === 'TaskOutput') return true;
  if (input.tool_name !== 'Agent' && !isWrapperCall(input)) return false;
  return !isBackgroundLaunch(input);
}

function appendSignal(context, lines) {
  if (lines.length === 0) return context;
  const signal = `<ccg-authority-signal>\n${lines.join('\n')}\n</ccg-authority-signal>`;
  const candidate = `${context}\n\n${signal}`;
  return Buffer.byteLength(candidate, 'utf-8') <= AUTHORITY_CONTEXT_LIMIT ? candidate : context;
}

function main() {
  const input = readHookInput();
  const requestedEvent = typeof input.hook_event_name === 'string' ? input.hook_event_name : 'UserPromptSubmit';
  outputEventName = SUPPORTED_EVENTS.has(requestedEvent) ? requestedEvent : 'UserPromptSubmit';
  if (!shouldRefresh(input, outputEventName)) return;

  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const root = findProjectRoot(cwd);
  if (!root) return;

  const snapshot = buildTaskSnapshot(root, { mode: 'authority', role: 'all' });
  if (snapshot.resolution.kind === 'none') return;

  let context = renderTaskSnapshot(snapshot, 'authority', 'all', AUTHORITY_CONTEXT_LIMIT);
  if (outputEventName === 'UserPromptSubmit' && snapshot.resolution.kind === 'active' && snapshot.kind !== 'invalid') {
    const additions = [];
    if (typeof input.session_id !== 'string' || !input.session_id.trim()) {
      additions.push('Diagnostic: SESSION_ID_MISSING: loop detection disabled');
    } else {
      const tracked = trackTurn(
        snapshot.task.dir,
        input.session_id,
        snapshot.task.currentPhase,
        snapshot.task.nextAction
      );
      if (!tracked.ok) {
        additions.push(`Diagnostic: ${escapeXml(tracked.code)}: loop detection disabled`);
      } else {
        const loop = detectLoop(tracked.turns, 3);
        if (loop) {
          additions.push(
            `Loop: phase and next action repeated ${loop.count} turns; change approach or report the blocker.`
          );
        }
      }
    }
    context = appendSignal(context, additions);
  }

  outputHook(outputEventName, context);
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  outputHook(
    outputEventName,
    truncateUtf8(`<ccg-authority>CCG_HOOK_ERROR\n${escapeXml(message)}</ccg-authority>`, AUTHORITY_CONTEXT_LIMIT)
  );
}
