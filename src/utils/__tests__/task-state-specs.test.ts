import {
  linkSpec,
  writeArtifact,
  cleanupPaths,
  git,
  createProject,
  runController,
  runHook,
  expectSuccess,
  expectFailure,
  currentExpected,
  startTask,
  hookOutput,
} from './task-state-fixtures'
import { join } from 'node:path'
import fs from 'fs-extra'
import { describe, expect, it } from 'vitest'

import type { JsonObject } from './task-state-fixtures'

async function prepareAuthorityDocuments(root: string): Promise<void> {
  await fs.writeFile(
    join(root, 'docs', 'authority-order.md'),
    `# Authority\n\n## Exact rules\n\nSPEC_SENTINEL\n${'s'.repeat(3400)}\n`
  )
  git(root, ['add', 'docs/authority-order.md'])
  expectSuccess(
    runController(root, 'update-requirements', {
      expected: currentExpected(root, true),
      content: `# Requirements\n\nCONTRACT_SENTINEL\n${'r'.repeat(7000)}\n`,
    })
  )
  linkSpec(root, {
    path: 'docs/authority-order.md',
    section: 'Exact rules',
    purpose: 'Verify context ordering',
    roles: ['implement'],
  })
}

describe('spec references and snapshots', () => {
  it('injects only public and role-matched exact spec sections', async () => {
    const root = await createProject()
    startTask(root, 'spec-task')

    const refs = [
      {
        path: 'docs/integration.md',
        section: 'Shared rules',
        purpose: 'Shared authority',
      },
      {
        path: 'docs/integration.md',
        section: 'Implementation rules',
        purpose: 'Implementation authority',
        roles: ['implement'],
      },
      {
        path: 'docs/integration.md',
        section: 'Review rules',
        purpose: 'Review authority',
        roles: ['review'],
      },
    ]
    for (const specRef of refs) {
      linkSpec(root, specRef)
    }

    const implement = expectSuccess(
      runController(root, 'snapshot', undefined, ['--mode', 'agent', '--role', 'implement'])
    )
    const review = expectSuccess(runController(root, 'snapshot', undefined, ['--mode', 'agent', '--role', 'review']))
    const unknown = expectSuccess(runController(root, 'snapshot', undefined, ['--mode', 'agent', '--role', 'unknown']))

    expect((implement.specs as JsonObject[]).map((item) => (item.ref as JsonObject).section)).toEqual([
      'Implementation rules',
      'Shared rules',
    ])
    expect((review.specs as JsonObject[]).map((item) => (item.ref as JsonObject).section)).toEqual([
      'Review rules',
      'Shared rules',
    ])
    expect((unknown.specs as JsonObject[]).map((item) => (item.ref as JsonObject).section)).toEqual(['Shared rules'])
  })

  it('accepts a staged Markdown spec with an exact heading', async () => {
    const root = await createProject()
    startTask(root, 'staged-spec-task')
    await fs.writeFile(join(root, 'docs', 'staged.md'), '# Staged spec\n\n## Exact heading\n\nStaged authority.\n')
    git(root, ['add', 'docs/staged.md'])

    const linked = linkSpec(root, {
      path: 'docs/staged.md',
      section: 'Exact heading',
      purpose: 'Staged specification',
      roles: ['research'],
    })
    expect(linked.linked).toBe(true)
  })

  it('rejects duplicated exact headings', async () => {
    const root = await createProject()
    startTask(root, 'duplicate-heading-task')
    await fs.writeFile(join(root, 'docs', 'duplicate.md'), '# Duplicate\n\n## Rules\n\nFirst.\n\n## Rules\n\nSecond.\n')
    git(root, ['add', 'docs/duplicate.md'])

    expectFailure(
      runController(root, 'link-spec', {
        expected: currentExpected(root, true),
        specRef: { path: 'docs/duplicate.md', section: 'Rules', purpose: 'Ambiguous rules' },
      }),
      'SPEC_SECTION_AMBIGUOUS'
    )
  })

  it('ignores heading examples inside fenced Markdown code blocks', async () => {
    const root = await createProject()
    startTask(root, 'fenced-heading-task')
    await fs.writeFile(
      join(root, 'docs', 'fenced.md'),
      '# Fenced headings\n\n## Rules\n\nActual authority.\n\n```md\n## Rules\nExample ' +
        'only.\n```\n\n## Next\n\nNot part of Rules.\n'
    )
    git(root, ['add', 'docs/fenced.md'])

    linkSpec(root, { path: 'docs/fenced.md', section: 'Rules', purpose: 'Actual rules' })
    const snapshot = expectSuccess(runController(root, 'snapshot', undefined, ['--mode', 'agent', '--role', 'all']))
    const content = ((snapshot.specs as JsonObject[])[0] as JsonObject).content as string
    expect(content).toContain('Actual authority')
    expect(content).toContain('Example only')
    expect(content).not.toContain('Not part of Rules')
  })

  it('checks Git tracking with a literal pathspec', async () => {
    const root = await createProject()
    startTask(root, 'literal-pathspec-task')
    await fs.writeFile(join(root, 'docs', 'a.md'), '# Tracked\n\n## Rules\n\nTracked file.\n')
    git(root, ['add', 'docs/a.md'])
    git(root, ['commit', '-qm', 'test: add pathspec fixture'])
    await fs.writeFile(join(root, 'docs', '[a].md'), '# Literal\n\n## Rules\n\nUntracked literal file.\n')

    expectFailure(
      runController(root, 'link-spec', {
        expected: currentExpected(root, true),
        specRef: { path: 'docs/[a].md', section: 'Rules', purpose: 'Must be tracked literally' },
      }),
      'SPEC_NOT_TRACKED'
    )
  })

  it('rejects oversized sections and spec files that exceed the source scan limit', async () => {
    const root = await createProject()
    startTask(root, 'oversized-spec-task')
    await fs.writeFile(join(root, 'docs', 'large-section.md'), `# Large\n\n## Rules\n\n${'x'.repeat(5000)}\n`)
    await fs.writeFile(
      join(root, 'docs', 'large-source.md'),
      `# Large source\n\n## Rules\n\nSmall rule.\n\n## Other\n\n${'y'.repeat(300 * 1024)}\n`
    )
    git(root, ['add', 'docs/large-section.md', 'docs/large-source.md'])

    for (const specPath of ['docs/large-section.md', 'docs/large-source.md']) {
      expectFailure(
        runController(root, 'link-spec', {
          expected: currentExpected(root, true),
          specRef: { path: specPath, section: 'Rules', purpose: 'Oversized authority' },
        }),
        'SPEC_SECTION_TOO_LARGE'
      )
    }
  })

  it.each([
    ['absolute path', '/tmp/spec.md', 'Shared rules', 'PATH_INVALID'],
    ['parent traversal', '../outside.md', 'Shared rules', 'PATH_INVALID'],
    ['untracked file', 'docs/untracked.md', 'Rules', 'SPEC_NOT_TRACKED'],
    ['missing heading', 'docs/integration.md', 'Missing heading', 'SPEC_SECTION_NOT_FOUND'],
    ['non-Markdown file', 'package.json', 'name', 'PATH_INVALID'],
  ])('rejects an unsafe or invalid spec reference: %s', async (_name, specPath, section, code) => {
    const root = await createProject()
    startTask(root, 'invalid-spec-task')
    if (specPath === 'docs/untracked.md') await fs.writeFile(join(root, specPath), '# Rules\n')

    expectFailure(
      runController(root, 'link-spec', {
        expected: currentExpected(root, true),
        specRef: { path: specPath, section, purpose: 'Invalid reference' },
      }),
      code
    )
  })

  it('rejects symlinked spec paths even when the symlink is tracked', async () => {
    const root = await createProject()
    startTask(root, 'symlink-spec-task')
    await fs.symlink('integration.md', join(root, 'docs', 'linked.md'))
    git(root, ['add', 'docs/linked.md'])

    expectFailure(
      runController(root, 'link-spec', {
        expected: currentExpected(root, true),
        specRef: {
          path: 'docs/linked.md',
          section: 'Shared rules',
          purpose: 'Symlink must fail',
        },
      }),
      'PATH_INVALID'
    )
  })

  it('marks changed linked specs invalid and denies downstream tools', async () => {
    const root = await createProject()
    startTask(root, 'changed-spec-task')
    linkSpec(root, {
      path: 'docs/integration.md',
      section: 'Implementation rules',
      purpose: 'Implementation authority',
      roles: ['implement'],
    })
    await fs.writeFile(
      join(root, 'docs', 'integration.md'),
      '# Integration contract\n\n## Different rules\n\nChanged.\n'
    )

    const snapshot = expectSuccess(
      runController(root, 'snapshot', undefined, ['--mode', 'agent', '--role', 'implement'])
    )
    expect(snapshot).toMatchObject({ kind: 'invalid', code: 'SPEC_SECTION_NOT_FOUND' })

    const hook = hookOutput(
      runHook(root, 'subagent-context.js', {
        cwd: root,
        tool_name: 'Agent',
        tool_input: { name: 'dev-1', prompt: 'Implement the task' },
      })
    )
    expect(hook).toMatchObject({
      permissionDecision: 'deny',
      permissionDecisionReason: expect.stringContaining('SPEC_SECTION_NOT_FOUND'),
    })
    expect(hook.updatedInput).toBeUndefined()
  })

  it('rejects role-matched spec sets that exceed the rendered context budget', async () => {
    const root = await createProject()
    startTask(root, 'spec-budget-task')
    const sections = Array.from(
      { length: 4 },
      (_, index) => `## Rules ${index + 1}\n\n${String(index + 1).repeat(3400)}\n`
    )
    await fs.writeFile(join(root, 'docs', 'spec-budget.md'), `# Spec budget\n\n${sections.join('\n')}`)
    git(root, ['add', 'docs/spec-budget.md'])
    for (let index = 0; index < sections.length - 1; index++) {
      linkSpec(root, {
        path: 'docs/spec-budget.md',
        section: `Rules ${index + 1}`,
        purpose: `Authority ${index + 1}`,
        roles: ['implement'],
      })
    }

    expectFailure(
      runController(root, 'link-spec', {
        expected: currentExpected(root, true),
        specRef: {
          path: 'docs/spec-budget.md',
          section: `Rules ${sections.length}`,
          purpose: `Authority ${sections.length}`,
          roles: ['implement'],
        },
      }),
      'SPEC_CONTEXT_TOO_LARGE'
    )
    const snapshot = expectSuccess(
      runController(root, 'snapshot', undefined, ['--mode', 'agent', '--role', 'implement'])
    )
    expect(snapshot.kind).not.toBe('invalid')
    expect(snapshot.specs).toHaveLength(3)
  })

  it('marks a snapshot invalid when the required task contract disappears', async () => {
    const root = await createProject()
    startTask(root, 'missing-contract-task')
    await fs.remove(join(root, '.ccg', 'tasks', 'missing-contract-task', 'requirements.md'))

    const snapshot = expectSuccess(runController(root, 'snapshot', undefined, ['--mode', 'session', '--role', 'all']))
    expect(snapshot).toMatchObject({ kind: 'invalid', code: 'TASK_CONTRACT_MISSING' })

    const hook = hookOutput(
      runHook(root, 'subagent-context.js', {
        cwd: root,
        tool_name: 'Agent',
        tool_input: { name: 'dev-1', prompt: 'Implement the task' },
      })
    )
    expect(hook.permissionDecision).toBe('deny')
    expect(hook.permissionDecisionReason).toContain('TASK_CONTRACT_MISSING')
  })

  it('rejects a task contract that cannot fit after XML escaping', async () => {
    const root = await createProject()
    startTask(root, 'escaped-contract-budget-task')
    expectSuccess(
      runController(root, 'update-requirements', {
        expected: currentExpected(root, true),
        content: `# Requirements\n\n${'&'.repeat(2000)}\n`,
      })
    )

    const snapshot = expectSuccess(
      runController(root, 'snapshot', undefined, ['--mode', 'agent', '--role', 'implement'])
    )
    expect(snapshot).toMatchObject({ kind: 'invalid', code: 'TASK_CONTRACT_CONTEXT_TOO_LARGE' })
    const hook = hookOutput(
      runHook(root, 'subagent-context.js', {
        cwd: root,
        tool_name: 'Agent',
        tool_input: { name: 'implementer', prompt: 'Implement assigned files' },
      })
    )
    expect(hook.permissionDecision).toBe('deny')
    expect(hook.permissionDecisionReason).toContain('TASK_CONTRACT_CONTEXT_TOO_LARGE')
  })

  it('rejects symbolic-link parents for task research artifacts', async () => {
    const root = await createProject()
    startTask(root, 'research-symlink-task')
    const outside = `${root}-outside`
    cleanupPaths.add(outside)
    await fs.ensureDir(outside)
    await fs.writeFile(join(outside, 'leak.md'), 'OUTSIDE_SENTINEL\n')
    await fs.symlink(outside, join(root, '.ccg', 'tasks', 'research-symlink-task', 'research'))

    expectFailure(
      runController(root, 'write-artifact', {
        expected: currentExpected(root, true),
        kind: 'research',
        name: 'result.md',
        content: '# Result\n',
      }),
      'PATH_INVALID'
    )
    const snapshot = expectSuccess(runController(root, 'snapshot', undefined, ['--mode', 'session', '--role', 'all']))
    expect(snapshot.diagnostics).toContain('PATH_INVALID:research')
    expect(JSON.stringify(snapshot)).not.toContain('OUTSIDE_SENTINEL')
  })

  it('escapes task and spec content before placing it in Hook XML', async () => {
    const root = await createProject()
    startTask(root, 'xml-task')
    expectSuccess(
      runController(root, 'update-requirements', {
        expected: currentExpected(root, true),
        content: '# Requirements\n\nUse <unsafe> & preserve "quotes".\n',
      })
    )
    linkSpec(root, {
      path: 'docs/integration.md',
      section: 'Shared rules',
      purpose: 'Contract <authority>',
    })

    const session = hookOutput(runHook(root, 'session-start.js', { cwd: root, source: 'startup' }))
    expect(session.additionalContext).toContain('&lt;unsafe&gt; &amp; preserve &quot;quotes&quot;')
    expect(session.additionalContext).toContain('Contract &lt;authority&gt;')
    expect(session.additionalContext).not.toContain('Use <unsafe>')
  })

  it('keeps specs and the task contract ahead of bounded optional artifacts', async () => {
    const root = await createProject()
    startTask(root, 'authority-order-task')
    await prepareAuthorityDocuments(root)
    for (const [kind, marker, size] of [
      ['plan', 'PLAN_SENTINEL', 7000],
      ['analysis', 'ANALYSIS_SENTINEL', 7000],
      ['review', 'REVIEW_SENTINEL', 3500],
    ] as const) {
      writeArtifact(root, {
        kind,
        content: `# ${kind}\n\n${marker}\n${kind[0].repeat(size)}\n`,
      })
    }

    const sessionOutput = hookOutput(runHook(root, 'session-start.js', { cwd: root, source: 'compact' }))
    const sessionContext = sessionOutput.additionalContext as string
    expect(Buffer.byteLength(sessionContext, 'utf-8')).toBeLessThanOrEqual(32 * 1024)
    expect(sessionContext).toContain('SPEC_SENTINEL')
    expect(sessionContext).toContain('CONTRACT_SENTINEL')
    expect(sessionContext).toContain('PLAN_SENTINEL')
    expect(sessionContext).toContain('reference material, not authorization')
    expect(sessionContext.indexOf('SPEC_SENTINEL')).toBeLessThan(sessionContext.indexOf('CONTRACT_SENTINEL'))
    expect(sessionContext.indexOf('CONTRACT_SENTINEL')).toBeLessThan(sessionContext.indexOf('PLAN_SENTINEL'))

    const agentOutput = hookOutput(
      runHook(root, 'subagent-context.js', {
        cwd: root,
        tool_name: 'Agent',
        tool_input: { name: 'implementer', prompt: 'Implement assigned files' },
      })
    )
    const agentPrompt = (agentOutput.updatedInput as JsonObject).prompt as string
    expect(agentPrompt).toContain('SPEC_SENTINEL')
    expect(agentPrompt).toContain('CONTRACT_SENTINEL')
    expect(agentPrompt).toContain('reference material, not authorization')
    expect(agentPrompt.indexOf('SPEC_SENTINEL')).toBeLessThan(agentPrompt.indexOf('CONTRACT_SENTINEL'))
  })
})
