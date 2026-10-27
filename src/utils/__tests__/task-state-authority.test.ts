import {
  writeArtifact,
  linkSpec,
  DEFAULT_SESSION_ID,
  createProject,
  runController,
  runHook,
  expectSuccess,
  currentExpected,
  startTask,
  hookOutput,
} from './task-state-fixtures'
import { describe, expect, it } from 'vitest'

import type { JsonObject } from './task-state-fixtures'

function foregroundResults(wrapperCommand: string) {
  return [
    {
      event: 'PostToolUse',
      toolName: 'Agent',
      toolInput: { name: 'reviewer', prompt: 'Review changes' },
      extra: { tool_response: { result: 'Agent completed' } },
    },
    {
      event: 'PostToolUse',
      toolName: 'Bash',
      toolInput: { command: wrapperCommand },
      extra: { tool_response: { stdout: 'Review completed', exitCode: 0 } },
    },
    {
      event: 'PostToolUse',
      toolName: 'TaskOutput',
      toolInput: { task_id: 'task-1', block: true },
      extra: { tool_response: { status: 'completed', output: 'External result' } },
    },
    {
      event: 'PostToolUseFailure',
      toolName: 'Agent',
      toolInput: { name: 'reviewer', prompt: 'Review changes' },
      extra: { error: 'Agent failed' },
    },
    {
      event: 'PostToolUseFailure',
      toolName: 'Bash',
      toolInput: { command: wrapperCommand },
      extra: { error: 'Wrapper failed' },
    },
  ]
}

function preparePromptArtifacts(root: string): void {
  linkSpec(root, {
    path: 'docs/integration.md',
    section: 'Implementation rules',
    purpose: 'Current implementation authority',
  })
  writeArtifact(root, {
    kind: 'plan',
    content: '# Plan\n\nSTALE_PLAN_SENTINEL: merge module-beta.\n',
  })
  expectSuccess(
    runController(root, 'checkpoint', {
      expected: currentExpected(root, true),
      currentPhase: 'implementation',
      nextAction: 'Follow the exact linked specification',
      gate: null,
      progress: '# Progress\n\nSTALE_PROGRESS_SENTINEL\n',
    })
  )
  writeArtifact(root, {
    kind: 'research',
    name: 'stale.md',
    content: '# Research\n\nSTALE_RESEARCH_SENTINEL\n',
  })
}

function prepareStaleArtifacts(root: string): void {
  const snapshot = expectSuccess(runController(root, 'snapshot', undefined, ['--mode', 'authority', '--role', 'all']))
  expect(snapshot.documents).toEqual({
    requirements: expect.stringContaining('Complete prompt-authority-task'),
  })
  expect(snapshot.research).toEqual([])
}

describe('session and sub-agent Hooks', () => {
  it('prefers Hook input cwd over a conflicting project environment variable', async () => {
    const inputRoot = await createProject()
    const environmentRoot = await createProject()
    startTask(inputRoot, 'input-cwd-task')
    startTask(environmentRoot, 'environment-task')
    const env = { CLAUDE_PROJECT_DIR: environmentRoot }

    const session = hookOutput(runHook(environmentRoot, 'session-start.js', { cwd: inputRoot, source: 'resume' }, env))
    expect(session.additionalContext).toContain('input-cwd-task')
    expect(session.additionalContext).not.toContain('environment-task')

    const breadcrumb = hookOutput(
      runHook(environmentRoot, 'workflow-state.js', { cwd: inputRoot, session_id: 'cwd-test' }, env)
    )
    expect(breadcrumb.additionalContext).toContain('input-cwd-task')
    expect(breadcrumb.additionalContext).not.toContain('environment-task')

    const agent = hookOutput(
      runHook(
        environmentRoot,
        'subagent-context.js',
        {
          cwd: inputRoot,
          tool_name: 'Agent',
          tool_input: { name: 'implementer', prompt: 'Implement assigned files' },
        },
        env
      )
    )
    expect((agent.updatedInput as JsonObject).prompt).toContain('input-cwd-task')
    expect((agent.updatedInput as JsonObject).prompt).not.toContain('environment-task')
  })

  it('restores one session across startup, resume, compact, and clear without inheriting on fork', async () => {
    const root = await createProject()
    startTask(root, 'restore-task')
    writeArtifact(root, {
      kind: 'plan',
      content: '# Plan\n\nDo not merge module-beta.\n',
    })
    linkSpec(root, {
      path: 'docs/integration.md',
      section: 'Implementation rules',
      purpose: 'Implementation authority',
      roles: ['implement'],
    })

    const contexts = ['startup', 'resume', 'compact', 'clear'].map((source) => {
      const output = hookOutput(
        runHook(root, 'session-start.js', { cwd: root, source, session_id: DEFAULT_SESSION_ID })
      )
      return output.additionalContext as string
    })
    expect(new Set(contexts).size).toBe(1)
    expect(contexts[0]).toContain('Default (frontend=claude, backend=claude)')
    expect(contexts[0]).toContain('Complete restore-task')
    expect(contexts[0]).toContain('Do not merge module-beta')
    expect(contexts[0]).toContain('module-beta is referenced by the build system and does not merge')

    const fork = hookOutput(
      runHook(root, 'session-start.js', { cwd: root, source: 'fork', session_id: 'forked-session' })
    )
    expect(fork.additionalContext).toContain('SELECTION_REQUIRED')
    expect(fork.additionalContext).not.toContain('Complete restore-task')
  })

  it('refreshes exact authority on every user prompt without stale task artifacts', async () => {
    const root = await createProject()
    startTask(root, 'prompt-authority-task')
    preparePromptArtifacts(root)

    prepareStaleArtifacts(root)

    const output = hookOutput(
      runHook(root, 'workflow-state.js', {
        cwd: root,
        hook_event_name: 'UserPromptSubmit',
        session_id: DEFAULT_SESSION_ID,
        prompt: 'Continue',
      })
    )
    const context = output.additionalContext as string
    expect(output.hookEventName).toBe('UserPromptSubmit')
    expect(context).toContain('<ccg-authority>')
    expect(context).toContain('module-beta is referenced by the build system and does not merge')
    expect(context).toContain('Complete prompt-authority-task')
    expect(context).toContain('allowed actions, prohibited actions, exclusions, stop conditions')
    expect(context).toContain(
      'system and developer instructions, current user instructions, project CLAUDE.md, then global CLAUDE.md'
    )
    expect(context).toContain('reference material, not authorization')
    expect(context).not.toContain('Authority order: linked spec sections')
    expect(context).not.toContain('STALE_PLAN_SENTINEL')
    expect(context).not.toContain('STALE_PROGRESS_SENTINEL')
    expect(context).not.toContain('STALE_RESEARCH_SENTINEL')
  })

  it('refreshes the latest authority after foreground external results and failures', async () => {
    const root = await createProject()
    startTask(root, 'result-authority-task')
    linkSpec(root, {
      path: 'docs/integration.md',
      section: 'Review rules',
      purpose: 'Review authority',
    })

    const wrapperCommand = `codeagent-wrapper --backend codex - "${root}" <<'EOF'\nCCG_ROLE: review\nReview.\nEOF`
    const cases = foregroundResults(wrapperCommand)

    const launch = runHook(root, 'workflow-state.js', {
      cwd: root,
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: wrapperCommand, run_in_background: true },
      tool_response: { task_id: 'task-1', status: 'running' },
    })
    expect(launch.stdout).toBe('')

    expectSuccess(
      runController(root, 'update-requirements', {
        expected: currentExpected(root, true),
        content: '# Requirements\n\nLATEST_REQUIREMENTS_SENTINEL\n',
      })
    )
    for (const testCase of cases) {
      const output = hookOutput(
        runHook(root, 'workflow-state.js', {
          cwd: root,
          hook_event_name: testCase.event,
          tool_name: testCase.toolName,
          tool_input: testCase.toolInput,
          ...testCase.extra,
        })
      )
      expect(output.hookEventName).toBe(testCase.event)
      expect(output.additionalContext).toContain('LATEST_REQUIREMENTS_SENTINEL')
      expect(output.additionalContext).toContain(
        'Reject any plan that merges module-alpha, module-beta, or module-gamma'
      )
    }
  })

  it('skips authority refresh for ordinary tools and background launch acknowledgements', async () => {
    const root = await createProject()
    startTask(root, 'background-authority-task')

    const inputs: JsonObject[] = [
      {
        cwd: root,
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'git status --short' },
        tool_response: { stdout: '', exitCode: 0 },
      },
      {
        cwd: root,
        hook_event_name: 'PostToolUse',
        tool_name: 'Agent',
        tool_input: { name: 'reviewer', prompt: 'Review changes', run_in_background: true },
        tool_response: { agentId: 'agent-1', status: 'running' },
      },
      {
        cwd: root,
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: {
          command: `codeagent-wrapper --backend codex - "${root}" <<'EOF'\nReview.\nEOF`,
          run_in_background: true,
        },
        tool_response: { task_id: 'task-1', status: 'running' },
      },
    ]

    for (const input of inputs) {
      const result = runHook(root, 'workflow-state.js', input)
      expect(result.status).toBe(0)
      expect(result.stdout).toBe('')
      expect(result.stderr).toBe('')
    }
  })
})
