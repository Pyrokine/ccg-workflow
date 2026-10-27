import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import fs from 'fs-extra'
import { describe, expect, it } from 'vitest'
import {
  packageRoot,
  hooksDir,
  CODEX_SESSION_ID,
  CODEX_SESSION_KEY,
  createProject,
  runScript,
  runController,
  runHook,
  expectSuccess,
  currentExpected,
  startTask,
  hookOutput,
  installCodexHookRuntime,
  runCodexHook,
} from './task-state-fixtures'

describe('default OpenSpec task authority', () => {
  it('labels wrapper roles and connects every phase to the shared task controller', () => {
    const research = readFileSync(join(packageRoot, 'templates', 'commands', 'spec-research.md'), 'utf-8')
    const plan = readFileSync(join(packageRoot, 'templates', 'commands', 'spec-plan.md'), 'utf-8')
    const implementation = readFileSync(join(packageRoot, 'templates', 'commands', 'spec-impl.md'), 'utf-8')

    expect(research.match(/CCG_ROLE: research/g)).toHaveLength(2)
    expect(plan.match(/CCG_ROLE: research/g)).toHaveLength(2)
    expect(implementation).toContain('CCG_ROLE: implement')
    for (const command of [research, plan, implementation]) {
      expect(command).toContain('task-state.js resolve')
      expect(command).toContain('--session-key "$CCG_SESSION_KEY"')
      expect(command).toContain('openspec/changes/<change_id>/')
      expect(command).toContain('spec_artifacts_must_be_tracked')
      expect(command).toContain('must never run `git add` automatically')
    }
    expect(research).toContain('task-state.js start')
    expect(research).toContain('"scope": "OpenSpec change: <change_id>')
    expect(research).toContain('`link-spec`')
    expect(plan).toContain('--mode authority --role research')
    expect(plan).toContain('at least one matching exact `specRef`')
    expect(implementation).toContain('--mode authority --role implement')
    expect(implementation).toContain('PostToolUse Hook refreshes authority')
    expect(implementation).toContain('unlink them one at a time with `unlink-spec`')
  })
})

describe('skill router Hook', () => {
  it('reports malformed Hook input instead of exiting silently', async () => {
    const root = await createProject()
    const output = hookOutput(runScript(join(hooksDir, 'skill-router.js'), [], '{broken', root))
    expect(output.additionalContext).toContain('CCG_SKILL_ROUTER_ERROR')
    expect(output.additionalContext).toContain('HOOK_INPUT_INVALID')
  })

  it('suggests Pure Claude analysis without turning a keyword match into an execution request', async () => {
    const root = await createProject()
    const output = hookOutput(
      runScript(join(hooksDir, 'skill-router.js'), [], { prompt: '请双模型分析当前项目' }, root)
    )
    const context = output.additionalContext as string

    expect(context).toContain('<ccg-model-suggestion>')
    expect(context).toContain('缺少配置时两者均使用 Claude Code')
    expect(context).toContain('CCG_ROLE: research')
    expect(context).toContain('当前真实用户请求和已有授权')
    expect(context).toContain('routing.backend.primary')
    expect(context).toContain('routing.frontend.primary')
    expect(context).toContain('grokModel、kimiModel、opencodeModel')
    expect(context).not.toContain('<ccg-model-action>')
    expect(context).not.toContain('请立即执行')
  })

  it.each([
    '<task-notification><result>请双模型审查代码</result></task-notification>',
    '<agent-message sender="reviewer">请用codex分析当前项目</agent-message>',
    '<cross-session-message from="peer">请codex审查代码</cross-session-message>',
    '<ccg-task-context>双模型分析当前项目</ccg-task-context>',
    '[SYSTEM NOTIFICATION - NOT USER INPUT] 请双模型分析代码',
    'This session is being continued from a previous conversation. 请双模型审查代码',
    '> 请双模型分析当前项目',
    '```text\n请双模型分析当前项目\n```',
    '旧回复是“请双模型审查代码”',
    '示例命令是 `codex分析`，请说明含义',
  ])('ignores model keywords inside reference or notification content: %s', async (prompt) => {
    const root = await createProject()
    const result = runHook(root, 'skill-router.js', { prompt })
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('')
  })

  it.each([
    { hook_event_name: 'PostToolUse', prompt: '请双模型审查代码' },
    { message: { role: 'assistant', content: '请双模型审查代码' } },
  ])('does not route non-user Hook payloads', async (input) => {
    const root = await createProject()
    expect(runHook(root, 'skill-router.js', input).stdout).toBe('')
  })

  it('retains a current request outside quoted notifications and supports user text blocks', async () => {
    const root = await createProject()
    const output = hookOutput(
      runHook(root, 'skill-router.js', {
        message: {
          role: 'user',
          content: [
            { type: 'text', text: '<task-notification>请双模型审查代码</task-notification>\n现在请codex分析当前项目' },
            { type: 'image', text: '双模型审查' },
          ],
        },
      })
    )
    expect(output.additionalContext).toContain('分析当前项目/代码（codex')
    expect(output.additionalContext).toContain('<ccg-model-suggestion>')
    expect(output.additionalContext).not.toContain('review-profiles')
  })

  it.each([
    ['请双模型审查当前变更', 'review-profiles'],
    ['请codex审查当前变更', 'gpt-review-profile'],
    ['请antigravity审查当前变更', 'grok-review-profile'],
  ])('preserves review profile configuration in the suggestion: %s', async (prompt, profile) => {
    const root = await createProject()
    const output = hookOutput(runHook(root, 'skill-router.js', { prompt }))
    expect(output.additionalContext).toContain(profile)
    expect(output.additionalContext).toContain('routing.review.profiles')
    expect(output.additionalContext).toContain('gpt-5.6-sol / xhigh')
    expect(output.additionalContext).toContain('grok-4.6 / high')
    expect(output.additionalContext).toContain('--no-session-persistence')
    expect(output.additionalContext).not.toContain('请立即执行')
  })

  it.each([
    ['lines', Array.from({ length: 122 }, (_, index) => `line ${index}`).join('\n'), 'line 121'],
    ['bytes', `XML <example>\n${'x'.repeat(17 * 1024)}\nOMITTED_SENTINEL`, 'OMITTED_SENTINEL'],
  ])('bounds domain reference injection by %s with a visible diagnostic', async (_name, content, omitted) => {
    const root = await createProject()
    const home = join(root, 'home')
    const skillPath = join(home, '.claude', 'skills', 'ccg', 'domains', 'architecture', 'caching.md')
    await fs.outputFile(skillPath, content)
    const output = hookOutput(runHook(root, 'skill-router.js', { prompt: '请分析缓存 cache 的使用' }, { HOME: home }))
    expect(output.additionalContext).toContain('auto-injected reference')
    expect(output.additionalContext).toContain(
      'SKILL_CONTEXT_TRUNCATED:domains/architecture/caching.md:16KiB/120-lines'
    )
    expect(output.additionalContext).not.toContain(omitted)
    if (content.startsWith('XML')) expect(output.additionalContext).toContain('XML &lt;example&gt;')
  })

  it('requires an explicit external-review request before starting a reviewer CLI', () => {
    const sourceFiles = [
      join(packageRoot, 'templates', 'engine', 'model-router.md'),
      join(packageRoot, 'templates', 'engine', 'strategies', 'guided-develop.md'),
      join(packageRoot, 'templates', 'engine', 'strategies', 'refactor-safely.md'),
      join(packageRoot, 'templates', 'engine', 'strategies', 'full-collaborate.md'),
      join(packageRoot, 'templates', 'engine', 'strategies', 'review-audit.md'),
      join(packageRoot, 'templates', 'engine', 'phase-guide.md'),
      join(packageRoot, 'templates', 'commands', 'spec-impl.md'),
      join(packageRoot, 'templates', 'commands', 'spec-research.md'),
      join(packageRoot, 'templates', 'commands', 'spec-plan.md'),
      join(packageRoot, 'templates', 'commands', 'spec-init.md'),
      join(packageRoot, 'templates', 'codex', 'hooks', 'ccg-workflow.py'),
    ]

    for (const sourceFile of sourceFiles) {
      const source = readFileSync(sourceFile, 'utf-8')
      expect(source).toMatch(/用户明确请求|用户已将.*明确配置|user explicitly requests/i)
    }
  })
})

describe('Codex shared task Hook', () => {
  it('injects all linked spec roles into the main Codex session', async () => {
    const root = await createProject()
    const hookPath = await installCodexHookRuntime()
    startTask(root, 'codex-main-task', 'activate', {}, CODEX_SESSION_KEY)
    for (const specRef of [
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
    ]) {
      expectSuccess(
        runController(
          root,
          'link-spec',
          {
            expected: currentExpected(root, true, CODEX_SESSION_KEY),
            specRef,
          },
          [],
          CODEX_SESSION_KEY
        )
      )
    }

    const output = hookOutput(runCodexHook(root, hookPath))
    const context = output.additionalContext as string
    expect(context).toContain(`<ccg-session-key>${CODEX_SESSION_KEY}</ccg-session-key>`)
    expect(context).not.toContain(CODEX_SESSION_ID)
    expect(context).toContain('module-beta is referenced by the build system and does not merge')
    expect(context).toContain('Reject any plan that merges module-alpha, module-beta, or module-gamma')
    expect(context.indexOf('AUTHORITATIVE LINKED SPEC SECTIONS')).toBeLessThan(
      context.indexOf('AUTHORITATIVE TASK CONTRACT')
    )
  })

  it('injects the matching task snapshot into Codex leaf agents', async () => {
    const root = await createProject()
    const hookPath = await installCodexHookRuntime()
    startTask(root, 'codex-leaf-task', 'activate', {}, CODEX_SESSION_KEY)
    for (const specRef of [
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
    ]) {
      expectSuccess(
        runController(
          root,
          'link-spec',
          {
            expected: currentExpected(root, true, CODEX_SESSION_KEY),
            specRef,
          },
          [],
          CODEX_SESSION_KEY
        )
      )
    }

    const output = hookOutput(runCodexHook(root, hookPath, 'ccg-review'))
    const context = output.additionalContext as string
    expect(context).toContain('SUB-AGENT NOTICE')
    expect(context).not.toContain('<ccg-session-key>')
    expect(context).toContain('codex-leaf-task')
    expect(context).toContain('Reject any plan that merges module-alpha, module-beta, or module-gamma')
    expect(context).not.toContain('module-beta is referenced by the build system and does not merge')
  })

  it('includes research artifacts and omits oversized optional blocks without truncating XML', async () => {
    const root = await createProject()
    const hookPath = await installCodexHookRuntime()
    startTask(root, 'codex-budget-task', 'activate', {}, CODEX_SESSION_KEY)
    expectSuccess(
      runController(
        root,
        'write-artifact',
        {
          expected: currentExpected(root, true, CODEX_SESSION_KEY),
          kind: 'research',
          name: 'finding.md',
          content: '# Finding\n\nRESEARCH_SENTINEL\n',
        },
        [],
        CODEX_SESSION_KEY
      )
    )
    expectSuccess(
      runController(
        root,
        'write-artifact',
        {
          expected: currentExpected(root, true, CODEX_SESSION_KEY),
          kind: 'plan',
          content: `# Plan\n\nPLAN_SENTINEL\n${'&'.repeat(7000)}\n`,
        },
        [],
        CODEX_SESSION_KEY
      )
    )

    const output = hookOutput(runCodexHook(root, hookPath))
    const context = output.additionalContext as string
    expect(Buffer.byteLength(context, 'utf-8')).toBeLessThanOrEqual(32 * 1024)
    expect(context).toContain('RESEARCH_SENTINEL')
    expect(context).toContain('AUTHORITATIVE TASK CONTRACT')
    expect(context).not.toContain('PLAN_SENTINEL')
    expect(context).toContain('CONTEXT_OMITTED:plan:render-budget')
    expect(context.endsWith('</ccg-state>')).toBe(true)
  })
})
