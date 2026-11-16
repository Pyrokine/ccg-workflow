import fs from 'fs-extra'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createInstallContext, workflowInstallConfig } from '../installer-context'
import { copyMdTemplates, installEngineFiles } from '../installer-files'
import { installHookScripts } from '../installer-hooks'
import { createProject, DEFAULT_SESSION_ID, hookOutput, runScript, startTask } from './task-state-fixtures'

const templates = join(__dirname, '../../../templates')
const strategies = [
  'quick-implement',
  'debug-investigate',
  'deep-research',
  'guided-develop',
  'full-collaborate',
  'refactor-safely',
  'review-audit',
]
let home: string
let installDir: string

function installed(path: string): Promise<string> {
  return fs.readFile(join(installDir, path), 'utf8')
}

beforeEach(async () => {
  home = await fs.mkdtemp(join(tmpdir(), 'ccg-workflow-policy-'))
  installDir = join(home, '.claude')
  const context = createInstallContext(installDir, true, workflowInstallConfig())
  await installEngineFiles(context)
  for (const [source, target] of [
    ['commands', 'commands/ccg'],
    ['rules', 'rules'],
    ['skills', 'skills/ccg'],
    ['skills/domains/orchestration', 'skills/ccg/domains/orchestration'],
    ['skills/orchestration/multi-agent', 'skills/ccg/orchestration/multi-agent'],
    ['skills/tools/verify-quality', 'skills/ccg/tools/verify-quality'],
    ['skills/tools/verify-security', 'skills/ccg/tools/verify-security'],
    ['skills/tools/verify-change', 'skills/ccg/tools/verify-change'],
  ]) {
    await copyMdTemplates(context, join(templates, source), join(installDir, target), { inject: true })
  }
  expect(context.result.errors).toEqual([])
})

afterEach(async () => {
  await fs.remove(home)
})

describe('installed workflow policies', () => {
  it('executes installed Hooks with full startup context and short repeated tool context', async () => {
    const context = createInstallContext(installDir, true, workflowInstallConfig())
    expect(await installHookScripts(context)).toBe(true)
    expect(context.result.errors).toEqual([])
    const root = await createProject()
    startTask(root, 'installed-context')
    const input = {
      cwd: root,
      session_id: DEFAULT_SESSION_ID,
      tool_name: 'Write',
      tool_input: { file_path: join(root, 'example.txt'), content: 'Example' },
    }
    const hook = join(installDir, 'hooks/ccg/subagent-context.js')
    const first = hookOutput(runScript(hook, [], input, root))
    const second = hookOutput(runScript(hook, [], input, root))
    expect(first.additionalContext).toContain('Complete installed-context')
    expect(second.additionalContext).toContain('<ccg-state>')
    expect(second.additionalContext).not.toContain('## Task contract')
    expect(Buffer.byteLength(second.additionalContext as string)).toBeLessThan(
      Buffer.byteLength(first.additionalContext as string)
    )
    const startup = hookOutput(
      runScript(
        join(installDir, 'hooks/ccg/session-start.js'),
        [],
        {
          cwd: root,
          session_id: DEFAULT_SESSION_ID,
          source: 'compact',
        },
        root,
        { CLAUDE_ENV_FILE: join(home, 'session.env') }
      )
    )
    expect(startup.additionalContext).toContain('Complete installed-context')
    expect(startup.additionalContext).not.toContain('CCG_HOOK_ERROR')
  })

  it('requires direct worktree lock checks before listing, removal and pruning', async () => {
    const command = await installed('commands/ccg/worktree.md')
    const locks = command.slice(command.indexOf('## 核对锁定状态'), command.indexOf('## list')).replace(/\s+/g, ' ')
    for (const required of [
      'git rev-parse --git-common-dir',
      'worktrees/<id>/gitdir',
      '`locked`',
      '空文件也表示锁定',
      '确认文件不存在时显示未锁定',
      '即使 porcelain 未报告锁定也保留该状态',
      '锁状态未验证',
      '用户明确授权后才执行',
      'git worktree unlock <path>',
    ]) {
      expect(locks).toContain(required)
    }
    for (const section of ['list', 'remove', 'prune']) {
      const body = command.split(`## ${section}\n`)[1]?.split('\n## ')[0]
      expect(body).toContain('按“核对锁定状态”')
    }
  })

  it('combines feature-stage triggers and keeps failure and coverage evidence', async () => {
    const rules = (await installed('rules/ccg-skills.md')).replace(/\s+/g, ' ')
    expect(rules).toContain('Code changes exceeding 30 lines in the feature stage')
    expect(rules).toContain('Authentication, authorization, encryption, input validation, or secrets management')
    expect(rules).toContain('Refactoring existing code')
    expect(rules).toContain('New module/package/directory with source code')
    expect(rules).toContain('candidate, inputs, toolchain, arguments, configuration, and coverage')
    expect(rules).toContain('rerun only affected checks')
    expect(rules).toContain('Run independent checks even if another check fails')
    expect(rules.replace(/\s+/g, ' ')).toContain('failed, unavailable, timed-out, unsupported, and incomplete results')
    expect(rules).toContain('targeted checks needed to reproduce a problem')
    expect(rules).not.toContain('skip if previous gate fails')

    for (const name of ['verify-quality', 'verify-security', 'verify-change']) {
      const skill = await installed(`skills/ccg/tools/${name}/SKILL.md`)
      expect(skill).toContain('完整功能阶段')
      expect(skill).toContain('候选、输入、工具链、参数、配置和覆盖')
      expect(skill).toContain('只复验受影响部分')
      expect(skill).toContain('独立检查继续完成')
      expect(skill).toContain('只读审查交付发现')
    }
  })

  it('removes fixed reviewer and confirmation loops from every applicable strategy', async () => {
    for (const name of strategies) {
      const strategy = await installed(`.ccg/engine/strategies/${name}.md`)
      expect(strategy).not.toMatch(/必须逐个调用 Skill|每轮默认创建|每轮新 reviewer/)
      expect(strategy).not.toMatch(/修复后再审一轮|需要再审一轮|Round N\+1|最多 3 轮/)
      expect(strategy).not.toMatch(/第一个动作必须是 TeamCreate|所有代码由 Team Builder 写/)
      expect(strategy).not.toContain('计划审批 + 执行模式选择')
    }
    const phase = await installed('.ccg/engine/phase-guide.md')
    expect(phase).toContain('Ralph Loop 按完整功能阶段组织一次集中验收')
    expect(phase).toContain('confirmed finding 连续修复')
    expect(phase).toContain('复审针对真实变化')
    expect(phase).toContain('只读审查直接报告发现')
  })

  it('directly implements low-risk work and retains conditional approval for complex choices', async () => {
    const quick = await installed('.ccg/engine/strategies/quick-implement.md')
    expect(quick).toContain('需求明确且低风险时直接进入实施')
    expect(quick).not.toContain('等待用户确认或调整')
    const debug = await installed('.ccg/engine/strategies/debug-investigate.md')
    expect(debug).toContain('证据明确、修复方向唯一且属于已有授权')
    expect(debug).toContain('授权缺口、高风险操作')
    expect(debug).toContain('user_approval_required')
    for (const name of ['guided-develop', 'full-collaborate']) {
      const strategy = (await installed(`.ccg/engine/strategies/${name}.md`)).replace(/\s+/g, ' ')
      expect(strategy).toContain('已有相同方案的批准')
      expect(strategy).toContain('默认由主会话实施')
      expect(strategy).toContain('user_approval_required')
      expect(strategy).toContain('HARD STOP')
    }
  })

  it('answers simple research without changing tasks or requiring fixed roles and files', async () => {
    const research = await installed('.ccg/engine/strategies/deep-research.md')
    const command = await installed('commands/ccg/go.md')
    expect(research).toContain('普通事实查询无需持久任务')
    expect(research).toContain('无需创建研究文件')
    expect(research).not.toContain('双模型探索必须并行')
    expect(command).toContain('普通即时问答保持当前任务、phase 和绑定')
    expect(command).toContain('用户明确插入临时工作且无并发写入冲突时，直接使用 `interrupt`')
    expect(command).toContain('用户要替换目标或存在并发写入风险时')
  })

  it('reads the resumed parent contract and uses fresh CAS after finish', async () => {
    const phase = await installed('.ccg/engine/phase-guide.md')
    const continuation = phase.slice(phase.indexOf('`finish` 或 `recover` 返回 `resumedTaskId`'))
    for (const required of [
      '重新 `resolve`',
      '`requirements.md`',
      '精确 spec',
      '`nextAction`',
      '`gate`',
      '父任务新返回的完整 CAS',
    ]) {
      expect(continuation).toContain(required)
    }
    expect(phase).toContain('UTF-8 原文和 XML 转义后的正文各自最多 8192 字节')
    expect(phase).toContain('`nextAction` 按 UTF-8 最多 1024 字节')
    expect(phase).toContain('写前拒绝并保留原文和 revision')
    expect(phase).toContain('用户新增或修正的有效约束同步到 requirements 或精确关联的规范')
  })

  it('deduplicates displayed contracts without weakening authority or delegation', async () => {
    const phase = await installed('.ccg/engine/phase-guide.md')
    expect(phase).toContain('每次调用都在 PreToolUse 重新读取并验证')
    expect(phase).toContain('已输出的合同正文和任务身份相同')
    expect(phase).toContain('同 revision 下手动修改 spec')
    expect(phase).toContain('新 Agent 和 wrapper 始终取得完整角色上下文')
    expect(phase).toContain('首次建立记录时输出全文，记录失效或读写失败时显示诊断并输出全文')
    expect(phase).toContain('Workflow 使用宿主实际 schema')
    expect(phase).toContain('只读能力经宿主确认前，沿用现有权限和 session 绑定检查')

    const routing = await installed('.ccg/engine/model-router.md')
    expect(routing).toContain('分析、规划、实施和常规审查默认由主会话完成')
    for (const path of [
      'skills/ccg/domains/orchestration/multi-agent.md',
      'skills/ccg/orchestration/multi-agent/SKILL.md',
    ]) {
      const policy = await installed(path)
      expect(policy).toContain('默认由主会话直接完成')
      expect(policy).toContain('最大深度')
      expect(policy).toContain('叶子')
      expect(policy).not.toContain('当犹豫时，优先 TeamCreate')
    }
  })
})
