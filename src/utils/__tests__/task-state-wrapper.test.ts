import { linkSpec, updateRequirements } from './task-state-fixtures'
import { join } from 'node:path'
import fs from 'fs-extra'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SESSION_ID, createProject, runHook, resolve, startTask, hookOutput } from './task-state-fixtures'
import type { JsonObject } from './task-state-fixtures'

function wrapperCommands(root: string) {
  return {
    serial: [
      `"/tmp/codeagent-wrapper" --backend codex - "${root}" <<'SERIAL_EOF'`,
      'ROLE_FILE: /tmp/builder.md',
      '<TASK>',
      'Implement.',
      '</TASK>',
      'SERIAL_EOF',
    ].join('\n'),
    parallel: [
      `"/tmp/codeagent-wrapper" --parallel --backend codex - "${root}" <<'PARALLEL_EOF'`,
      ...['first', 'second'].flatMap((id) => [
        '---TASK---',
        `id: ${id}`,
        `workdir: ${root}`,
        '---CONTENT---',
        'ROLE_FILE: /tmp/builder.md',
        `<TASK>${id}</TASK>`,
      ]),
      'PARALLEL_EOF',
    ].join('\n'),
  }
}

function prefixedWrapperCommand(root: string, prefix: string): string {
  return [
    `${prefix} codeagent-wrapper --backend codex - "${root}" <<'EOF'`,
    'CCG_ROLE: implement',
    '<TASK>Implement.</TASK>',
    `EOF${prefix.startsWith('if ') ? '\nfi' : ''}`,
  ].join('\n')
}

const wrapperPrefixes = [
  'command',
  'exec',
  'nohup',
  'time -p',
  'nice -n 5',
  'sudo -u root',
  'env -u CCG_OLD CCG_TEST=1',
  'if true; then',
]

describe('session and sub-agent Hooks', () => {
  it('prepends all linked authority to generic Agent prompts while preserving all fields', async () => {
    const root = await createProject()
    startTask(root, 'agent-task')
    linkSpec(root, {
      path: 'docs/integration.md',
      section: 'Implementation rules',
      purpose: 'Implementation authority',
      roles: ['implement'],
    })

    const output = hookOutput(
      runHook(root, 'subagent-context.js', {
        cwd: root,
        tool_name: 'Agent',
        tool_use_id: 'tool-1',
        tool_input: {
          name: 'worker-1',
          description: 'Implement one file group',
          subagent_type: 'general-purpose',
          team_name: 'fixture-team',
          prompt: 'Task: agent-task@2\nModify src/example.ts',
        },
      })
    )
    const updated = output.updatedInput as JsonObject
    expect(updated).toMatchObject({
      name: 'worker-1',
      description: 'Implement one file group',
      subagent_type: 'general-purpose',
      team_name: 'fixture-team',
    })
    expect(updated.prompt).toContain('<ccg-injected-context>')
    expect(updated.prompt).toContain('Implementation authority')
    expect(updated.prompt).toContain('Task: agent-task@2')
    expect((updated.prompt as string).indexOf('<ccg-injected-context>')).toBeLessThan(
      (updated.prompt as string).indexOf('Task: agent-task@2')
    )
  })

  it('injects context into serial and every parallel wrapper task body', async () => {
    const root = await createProject()
    startTask(root, 'wrapper-task')
    linkSpec(root, {
      path: 'docs/integration.md',
      section: 'Implementation rules',
      purpose: 'Implementation authority',
      roles: ['implement'],
    })

    const serialCommand = wrapperCommands(root).serial
    const serial = hookOutput(
      runHook(root, 'subagent-context.js', {
        cwd: root,
        tool_name: 'Bash',
        tool_input: { command: serialCommand, timeout: 1000 },
      })
    )
    const serialUpdated = serial.updatedInput as JsonObject
    expect(serialUpdated.timeout).toBe(1000)
    expect(serialUpdated.command).toContain('<ccg-injected-context>')
    expect((serialUpdated.command as string).indexOf('<ccg-injected-context>')).toBeLessThan(
      (serialUpdated.command as string).indexOf('ROLE_FILE:')
    )

    const parallelCommand = wrapperCommands(root).parallel
    const parallel = hookOutput(
      runHook(root, 'subagent-context.js', {
        cwd: root,
        tool_name: 'Bash',
        tool_input: { command: parallelCommand },
      })
    )
    const parallelCommandUpdated = (parallel.updatedInput as JsonObject).command as string
    expect(parallelCommandUpdated.match(/<ccg-injected-context>/g)).toHaveLength(2)
    expect(parallelCommandUpdated.match(/Implementation authority/g)).toHaveLength(2)
  })

  it('recognizes env wrapper invocations and rejects a heredoc owned by another command', async () => {
    const root = await createProject()
    startTask(root, 'wrapper-binding-task')

    const envCommand =
      'env CCG_TEST=1 codeagent-wrapper --backend codex --label "safe&value" - "' +
      root +
      "\" <<'EOF'\nCCG_ROLE: implement\n<TASK>Implement.</TASK>\nEOF"
    const envOutput = hookOutput(
      runHook(root, 'subagent-context.js', {
        cwd: root,
        tool_name: 'Bash',
        tool_input: { command: envCommand },
      })
    )
    expect((envOutput.updatedInput as JsonObject).command).toContain('<ccg-injected-context>')

    for (const prefix of wrapperPrefixes) {
      const prefixed = prefixedWrapperCommand(root, prefix)
      const output = hookOutput(
        runHook(root, 'subagent-context.js', {
          cwd: root,
          tool_name: 'Bash',
          tool_input: { command: prefixed },
        })
      )
      expect((output.updatedInput as JsonObject).command).toContain('<ccg-injected-context>')
    }

    const unrelatedHeredoc = `codeagent-wrapper --version; cat <<'EOF'\nnot wrapper input\nEOF`
    const denied = hookOutput(
      runHook(root, 'subagent-context.js', {
        cwd: root,
        tool_name: 'Bash',
        tool_input: { command: unrelatedHeredoc },
      })
    )
    expect(denied.permissionDecision).toBe('deny')
    expect(denied.permissionDecisionReason).toContain('does not belong to the codeagent-wrapper command')
    expect(denied.updatedInput).toBeUndefined()
  })

  it('ignores wrapper-looking arguments that are not executable command positions', async () => {
    const root = await createProject()
    startTask(root, 'wrapper-argument-task')

    for (const command of [
      'go -C codeagent-wrapper test ./...',
      'rg -n "codeagent-wrapper" .',
      'printf "%s\\n" codeagent-wrapper',
      'command -v codeagent-wrapper',
      'sudo -u codeagent-wrapper true',
    ]) {
      const result = runHook(root, 'subagent-context.js', {
        cwd: root,
        tool_name: 'Bash',
        tool_input: { command },
      })
      expect(result.status).toBe(0)
      expect(result.stdout).toBe('')
      expect(result.stderr).toBe('')
    }
  })

  it('changes a colliding heredoc delimiter and rejects ambiguous shell structures', async () => {
    const root = await createProject()
    startTask(root, 'heredoc-task')
    updateRequirements(root, '# Requirements\n\nEOF\n')

    const colliding = hookOutput(
      runHook(root, 'subagent-context.js', {
        cwd: root,
        tool_name: 'Bash',
        tool_input: {
          command: `"/tmp/codeagent-wrapper" --backend codex - "${root}" <<'EOF'\nROLE_FILE: /tmp/builder.md\nEOF`,
        },
      })
    )
    const command = (colliding.updatedInput as JsonObject).command as string
    expect(command).not.toContain("<<'EOF'")
    expect(command).toMatch(/<<'CCG_CONTEXT_[A-F0-9]+'/)

    const tabStripped = hookOutput(
      runHook(root, 'subagent-context.js', {
        cwd: root,
        tool_name: 'Bash',
        tool_input: {
          command:
            `"/tmp/codeagent-wrapper" --backend codex - "${root}" <<-'EOF'\r\n` +
            '\tROLE_FILE: /tmp/builder.md\r\n\tEOF\r\n',
        },
      })
    )
    const tabStrippedCommand = (tabStripped.updatedInput as JsonObject).command as string
    const tabStrippedDelimiter = tabStrippedCommand.match(/<<-'(CCG_CONTEXT_[A-F0-9]+)'/)?.[1]
    expect(tabStrippedDelimiter).toBeTruthy()
    expect(tabStrippedCommand).toContain(`\t${tabStrippedDelimiter}\r\n`)
    expect(tabStrippedCommand).not.toContain(`\tE${tabStrippedDelimiter}`)

    const ambiguous = hookOutput(
      runHook(root, 'subagent-context.js', {
        cwd: root,
        tool_name: 'Bash',
        tool_input: {
          command: `"/tmp/codeagent-wrapper" --backend codex - "${root}" <<'ONE'\none\nONE\ncat <<'TWO'\ntwo\nTWO`,
        },
      })
    )
    expect(ambiguous.additionalContext).toContain('CONTEXT_NOT_INJECTED')
    expect(ambiguous.permissionDecision).toBe('deny')
    expect(ambiguous.permissionDecisionReason).toContain('Expected exactly one quoted heredoc')
    expect(ambiguous.updatedInput).toBeUndefined()
  })

  it('keeps prompt refresh read-only during a long unchanged phase and bounds its output', async () => {
    const root = await createProject()
    startTask(root, 'loop-task')

    const contexts: string[] = []
    for (let turn = 0; turn < 3; turn++) {
      const output = hookOutput(
        runHook(root, 'workflow-state.js', {
          cwd: root,
          session_id: DEFAULT_SESSION_ID,
          prompt: `Turn ${turn}`,
        })
      )
      contexts.push(output.additionalContext as string)
    }
    expect(contexts.every((context) => !context.includes('Loop:'))).toBe(true)
    expect(new Set(contexts).size).toBe(1)
    expect(contexts[2]).toContain('Complete loop-task')
    expect(Buffer.byteLength(contexts[2], 'utf-8')).toBeLessThanOrEqual(32 * 1024)
    expect(await fs.pathExists(join(root, '.ccg', 'tasks', 'loop-task', '.turns'))).toBe(false)
    expect(resolve(root).taskRevision).toBe(1)

    const otherSession = hookOutput(
      runHook(root, 'workflow-state.js', {
        cwd: root,
        session_id: 'session-b',
        prompt: 'Independent session',
      })
    )
    expect(otherSession.additionalContext).not.toContain('Loop:')

    const missingSession = hookOutput(
      runHook(root, 'workflow-state.js', { cwd: root, session_id: '', prompt: 'No session id' })
    )
    expect(missingSession.additionalContext).toContain('SESSION_KEY_REQUIRED')
  })
})
