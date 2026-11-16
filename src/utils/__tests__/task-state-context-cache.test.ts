import fs from 'fs-extra'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createProject,
  currentExpected,
  DEFAULT_SESSION_KEY,
  expectSuccess,
  finishActive,
  hookOutput,
  linkSpec,
  resolve,
  runController,
  runHook,
  startTask,
  updateRequirements,
} from './task-state-fixtures'

function ordinary(root: string, tool = 'Edit'): string {
  const output = hookOutput(runHook(root, 'subagent-context.js', { cwd: root, tool_name: tool, tool_input: {} }))
  expect(output.updatedInput).toBeUndefined()
  expect(output.permissionDecision).toBeUndefined()
  return output.additionalContext as string
}

function receipt(root: string): string {
  return join(root, '.ccg', 'context', `${DEFAULT_SESSION_KEY}.json`)
}

describe('authority output reuse', () => {
  it('shortens unchanged ordinary calls without changing lifecycle state', async () => {
    const root = await createProject()
    startTask(root, 'reuse-contract')
    const expected = currentExpected(root, true)
    expect(ordinary(root)).toContain('Complete reuse-contract')
    for (const tool of ['Edit', 'Bash', 'Write']) {
      const context = ordinary(root, tool)
      expect(context).toContain('<ccg-state>')
      expect(context).toContain('Task: reuse-contract')
      expect(context).toContain('Revision:')
      expect(context).not.toContain('Complete reuse-contract')
      expect(Buffer.byteLength(context)).toBeLessThanOrEqual(1024)
    }
    expect(currentExpected(root, true)).toEqual(expected)
    if (process.platform !== 'win32') {
      expect((await fs.stat(receipt(root))).mode & 0o777).toBe(0o600)
    }
    updateRequirements(root, '# Requirements\n\nKeep current deliveries.\n')
    expect(ordinary(root)).toContain('Keep current deliveries')
    expect(ordinary(root)).not.toContain('Keep current deliveries')
  })

  it('detects changed linked text without relying on the task revision', async () => {
    const root = await createProject()
    startTask(root, 'changed-spec')
    linkSpec(root, { path: 'docs/integration.md', section: 'Shared rules', purpose: 'Current module boundary' })
    expect(ordinary(root)).toContain('Only module-alpha merges')
    expect(ordinary(root)).not.toContain('Only module-alpha merges')
    const expected = currentExpected(root, true)
    const spec = join(root, 'docs', 'integration.md')
    await fs.writeFile(
      spec,
      (await fs.readFile(spec, 'utf8')).replace('Only module-alpha merges.', 'Keep all modules separate.')
    )
    expect(currentExpected(root, true)).toEqual(expected)
    expect(ordinary(root)).toContain('Keep all modules separate')
    await fs.remove(spec)
    const invalid = ordinary(root)
    expect(invalid).toContain('PATH_INVALID')
    expect(invalid).not.toContain('Keep all modules separate')
  })

  it.each(['startup', 'compact', 'resume', 'clear'])('restores full content on %s', async (source) => {
    const root = await createProject()
    startTask(root, 'restored-contract')
    ordinary(root)
    expect(ordinary(root)).not.toContain('Complete restored-contract')
    const output = hookOutput(runHook(root, 'session-start.js', { cwd: root, source }))
    expect(output.additionalContext).toContain('Complete restored-contract')
    expect(ordinary(root)).not.toContain('Complete restored-contract')
  })

  it('refreshes full content on user prompts and actual external returns', async () => {
    const root = await createProject()
    startTask(root, 'event-contract')
    ordinary(root)
    for (const event of ['UserPromptSubmit', 'PostToolUse', 'PostToolUseFailure']) {
      const output = hookOutput(
        runHook(root, 'workflow-state.js', {
          cwd: root,
          hook_event_name: event,
          tool_name: 'Agent',
          tool_response: { result: 'Finished' },
        })
      )
      expect(output.additionalContext).toContain('Complete event-contract')
      expect(ordinary(root)).not.toContain('Complete event-contract')
    }
    const agent = hookOutput(
      runHook(root, 'subagent-context.js', {
        cwd: root,
        tool_name: 'Agent',
        tool_input: { prompt: 'Inspect assigned files', subagent_type: 'Explore' },
      })
    )
    expect((agent.updatedInput as { prompt: string }).prompt).toContain('Complete event-contract')
  })

  it('repairs a malformed receipt with a visible diagnostic and preserves task state', async () => {
    const root = await createProject()
    startTask(root, 'receipt-repair')
    ordinary(root)
    const expected = currentExpected(root, true)
    await fs.writeFile(receipt(root), '{broken')
    const context = ordinary(root)
    expect(context).toContain('AUTHORITY_RECEIPT_INVALID')
    expect(context).toContain('Complete receipt-repair')
    expect(ordinary(root)).not.toContain('Complete receipt-repair')
    expect(currentExpected(root, true)).toEqual(expected)
  })

  it('preserves a linked receipt target and emits full authority with a diagnostic', async () => {
    const root = await createProject()
    startTask(root, 'receipt-link')
    ordinary(root)
    const outside = join(root, 'preserved.txt')
    await fs.writeFile(outside, 'PRESERVE_OUTSIDE_CONTENT\n')
    await fs.remove(receipt(root))
    await fs.symlink(outside, receipt(root))
    const context = ordinary(root)
    expect(context).toContain('AUTHORITY_RECEIPT_UNAVAILABLE')
    expect(context).toContain('Complete receipt-link')
    expect(await fs.readFile(outside, 'utf8')).toBe('PRESERVE_OUTSIDE_CONTENT\n')
  })

  it('keeps task identity and revision visible with a long escaped next action', async () => {
    const root = await createProject()
    startTask(root, 'long-next', 'activate', { nextAction: '&'.repeat(1024) })
    ordinary(root)
    const context = ordinary(root)
    expect(context).toContain('Task: long-next')
    expect(context).toContain('binding=1, task=1')
    expect(context).toContain(`Dir: ${root}/.ccg/tasks/long-next`)
    expect(context).toMatch(/<\/ccg-state>$/)
    expect(Buffer.byteLength(context)).toBeLessThanOrEqual(1024)
  })

  it('refreshes the parent contract and next action after an interrupted task finishes', async () => {
    const root = await createProject()
    startTask(root, 'return-parent', 'activate', { nextAction: 'Continue the original implementation' })
    ordinary(root)
    startTask(root, 'temporary-child', 'interrupt')
    expect(ordinary(root)).toContain('Complete temporary-child')
    expect(finishActive(root).resumedTaskId).toBe('return-parent')
    const context = ordinary(root)
    expect(context).toContain('Complete return-parent')
    expect(context).toContain('Continue the original implementation')
    expect(context).not.toContain('Complete temporary-child')
    expect(resolve(root).activeTaskId).toBe('return-parent')
  })

  it('keeps a progress-only revision as short state while preserving the current contract', async () => {
    const root = await createProject()
    startTask(root, 'progress-only')
    ordinary(root)
    expectSuccess(
      runController(root, 'checkpoint', {
        expected: currentExpected(root, true),
        currentPhase: 'implementation',
        nextAction: 'Write regression cases',
        gate: null,
        progress: '# Progress\n\nOne component completed.\n',
      })
    )
    const context = ordinary(root)
    expect(context).toContain('task=2')
    expect(context).toContain('Write regression cases')
    expect(context).not.toContain('Complete progress-only')
  })
})
