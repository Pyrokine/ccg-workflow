import type { WorkflowConfig } from '../types'

export const TASK_STATE_RUNTIME_FILES = [
  'package.json',
  'task-utils.js',
  'task-state.js',
  'task-state-core.js',
  'task-state-store.js',
  'task-state-model.js',
  'task-state-lifecycle.js',
  'task-state-artifacts.js',
  'task-state-recovery.js',
  'task-state-backup.js',
  'task-state-manifest.js',
  'task-state-legacy.js',
  'task-state-migration.js',
  'task-state-orphans.js',
]

// ═══════════════════════════════════════════════════════
// Command builder — adding a new command = 1 function call
// ═══════════════════════════════════════════════════════

type CommandCategory = 'development' | 'init' | 'git' | 'spec'

/**
 * Create a WorkflowConfig with sensible defaults.
 * @param cmdOverride — Use when the slash command name differs from the id (e.g. 'init-project' → 'init')
 */
function cmd(
  id: string,
  order: number,
  category: CommandCategory,
  text: Pick<WorkflowConfig, 'name' | 'nameEn' | 'description' | 'descriptionEn'>,
  cmdOverride?: string
): WorkflowConfig {
  const { name, nameEn, description, descriptionEn } = text
  return {
    id,
    name,
    nameEn,
    category,
    commands: [cmdOverride ?? id],
    defaultSelected: true,
    order,
    description,
    descriptionEn,
  }
}

// ═══════════════════════════════════════════════════════
// V3 Core commands (always installed)
// Source: templates/commands/
// ═══════════════════════════════════════════════════════

const CORE_CONFIGS: WorkflowConfig[] = [
  // ── Smart Entry ──────────────────────────────────────
  cmd('go', 0, 'development', {
    name: 'CCG 智能入口',
    nameEn: 'CCG Smart Entry',
    description: '描述你要做什么，AI 自动选择最佳策略执行',
    descriptionEn: 'Describe what you want, AI picks the best strategy',
  }),

  // ── Independent Tools ────────────────────────────────
  cmd(
    'init-project',
    10,
    'init',
    {
      name: '项目初始化',
      nameEn: 'Project Init',
      description: '初始化项目 AI 上下文，生成 CLAUDE.md',
      descriptionEn: 'Initialize project AI context, generate CLAUDE.md',
    },
    'init'
  ),
  cmd('context', 11, 'development', {
    name: '项目上下文管理',
    nameEn: 'Project Context Manager',
    description: '初始化 .context 目录、记录决策日志、压缩归档、查看历史',
    descriptionEn: 'Init .context dir, log decisions, compress, view history',
  }),

  // ── Git ──────────────────────────────────────────────
  cmd('commit', 20, 'git', {
    name: 'Git 提交',
    nameEn: 'Git Commit',
    description: '智能生成 conventional commit 信息',
    descriptionEn: 'Smart conventional commit message generation',
  }),
  cmd('rollback', 21, 'git', {
    name: 'Git 回滚',
    nameEn: 'Git Rollback',
    description: '交互式回滚分支到历史版本',
    descriptionEn: 'Interactive rollback to historical version',
  }),
  cmd('clean-branches', 22, 'git', {
    name: 'Git 清理分支',
    nameEn: 'Git Clean Branches',
    description: '安全清理已合并或过期分支',
    descriptionEn: 'Safely clean merged or stale branches',
  }),
  cmd('worktree', 23, 'git', {
    name: 'Git Worktree',
    nameEn: 'Git Worktree',
    description: '管理 Git worktree',
    descriptionEn: 'Manage Git worktree',
  }),

  // ── Spec (OpenSpec / OPSX) ───────────────────────────
  cmd('spec-init', 30, 'spec', {
    name: 'OpenSpec 初始化',
    nameEn: 'OpenSpec Init',
    description: '初始化 OpenSpec 环境 + 验证多模型 MCP 工具',
    descriptionEn: 'Initialize OpenSpec environment with multi-model MCP validation',
  }),
  cmd('spec-research', 31, 'spec', {
    name: '需求研究',
    nameEn: 'Spec Research',
    description: '需求 → 约束集（并行探索 + OpenSpec 提案）',
    descriptionEn: 'Transform requirements into constraint sets via parallel exploration',
  }),
  cmd('spec-plan', 32, 'spec', {
    name: '零决策规划',
    nameEn: 'Spec Plan',
    description: '多模型分析 → 消除歧义 → 零决策可执行计划',
    descriptionEn: 'Refine proposals into zero-decision executable plans',
  }),
  cmd('spec-impl', 33, 'spec', {
    name: '规范驱动实现',
    nameEn: 'Spec Implementation',
    description: '按规范执行 + 多模型协作 + 归档',
    descriptionEn: 'Execute changes via multi-model collaboration with spec compliance',
  }),
  cmd('spec-review', 34, 'spec', {
    name: '归档前审查',
    nameEn: 'Spec Review',
    description: 'GPT、Grok 外部交叉审查 → Critical 必须修复 → 允许归档',
    descriptionEn: 'GPT/Grok external cross-review before archiving',
  }),
]

// ═══════════════════════════════════════════════════════
// Legacy commands (optional, installed from commands-legacy/)
// Source: templates/commands-legacy/
// ═══════════════════════════════════════════════════════

const LEGACY_CONFIGS: WorkflowConfig[] = [
  cmd('workflow', 1, 'development', {
    name: '完整开发工作流',
    nameEn: 'Full Development Workflow',
    description: '完整6阶段开发工作流（研究→构思→计划→执行→优化→评审）',
    descriptionEn: 'Full 6-phase development workflow',
  }),
  cmd('plan', 1.5, 'development', {
    name: '多模型协作规划',
    nameEn: 'Multi-Model Planning',
    description: '上下文检索 + 双模型分析 → 生成 Step-by-step 实施计划',
    descriptionEn: 'Context retrieval + dual-model analysis → Step-by-step plan',
  }),
  cmd('execute', 1.6, 'development', {
    name: '多模型协作执行',
    nameEn: 'Multi-Model Execution',
    description: '根据计划获取原型 → Claude 重构实施 → 多模型审计交付',
    descriptionEn: 'Get prototype from plan → Claude refactor → Multi-model audit',
  }),
  cmd('team', 1.75, 'development', {
    name: 'Agent Teams 统一工作流',
    nameEn: 'Agent Teams Unified Workflow',
    description: '8 阶段企业级工作流：需求→架构→规划→开发→测试→审查→修复→集成，7 角色自动编排',
    descriptionEn: '8-phase enterprise workflow with 7 specialized roles',
  }),
  cmd('team-research', 1.8, 'development', {
    name: 'Agent Teams 需求研究',
    nameEn: 'Agent Teams Research',
    description: '并行探索代码库，产出约束集 + 可验证成功判据',
    descriptionEn: 'Parallel codebase exploration, produces constraint sets + success criteria',
  }),
  cmd('team-plan', 1.85, 'development', {
    name: 'Agent Teams 规划',
    nameEn: 'Agent Teams Planning',
    description: 'Lead 使用当前路由完成并行分析，产出零决策并行实施计划',
    descriptionEn: 'Lead orchestrates analysis through the current routes and produces a zero-decision parallel plan',
  }),
  cmd('team-exec', 1.9, 'development', {
    name: 'Agent Teams 并行实施',
    nameEn: 'Agent Teams Parallel Execution',
    description: '读取计划文件，spawn Builder teammates 并行写代码，需启用 Agent Teams',
    descriptionEn: 'Read plan file, spawn Builder teammates for parallel implementation',
  }),
  cmd('team-review', 1.95, 'development', {
    name: 'Agent Teams 审查',
    nameEn: 'Agent Teams Review',
    description: 'GPT、Grok 外部交叉审查并行实施产出，分级处理 Critical/Warning/Info',
    descriptionEn: 'GPT/Grok cross-review with severity classification',
  }),
  cmd('frontend', 2, 'development', {
    name: '前端专项',
    nameEn: 'Frontend Tasks',
    description: '前端专项任务（前端主模型主导，更快更精准）',
    descriptionEn: 'Frontend tasks (frontend-primary-led, faster)',
  }),
  cmd('codex-exec', 2.5, 'development', {
    name: 'Codex 执行计划',
    nameEn: 'Codex Plan Executor',
    description: '读取 /ccg:plan 计划文件，Codex 全权执行 + 多模型审核',
    descriptionEn: 'Read plan file from /ccg:plan, Codex executes + multi-model review',
  }),
  cmd('backend', 3, 'development', {
    name: '后端专项',
    nameEn: 'Backend Tasks',
    description: '后端专项任务（Codex主导，更快更精准）',
    descriptionEn: 'Backend tasks (Codex-led, faster)',
  }),
  cmd('feat', 4, 'development', {
    name: '智能功能开发',
    nameEn: 'Smart Feature Development',
    description: '智能功能开发 - 自动规划、设计、实施',
    descriptionEn: 'Smart feature development - auto plan, design, implement',
  }),
  cmd('analyze', 5, 'development', {
    name: '技术分析',
    nameEn: 'Technical Analysis',
    description: '双模型技术分析，仅分析不修改代码',
    descriptionEn: 'Dual-model technical analysis, analysis only',
  }),
  cmd('debug', 6, 'development', {
    name: '问题诊断',
    nameEn: 'Debug',
    description: '多模型诊断 + 修复',
    descriptionEn: 'Multi-model diagnosis + fix',
  }),
  cmd('optimize', 7, 'development', {
    name: '性能优化',
    nameEn: 'Performance Optimization',
    description: '多模型性能优化',
    descriptionEn: 'Multi-model performance optimization',
  }),
  cmd('test', 8, 'development', {
    name: '测试生成',
    nameEn: 'Test Generation',
    description: '智能路由测试生成',
    descriptionEn: 'Smart routing test generation',
  }),
  cmd('review', 9, 'development', {
    name: '代码审查',
    nameEn: 'Code Review',
    description: 'GPT、Grok 外部交叉审查，无参数时自动审查 git diff',
    descriptionEn: 'GPT/Grok cross-review, auto-review git diff when no args',
  }),
  cmd('enhance', 9.5, 'development', {
    name: 'Prompt 增强',
    nameEn: 'Prompt Enhancement',
    description: 'ace-tool Prompt 增强工具',
    descriptionEn: 'ace-tool prompt enhancement',
  }),
]

// Combined for backward compatibility
const WORKFLOW_CONFIGS: WorkflowConfig[] = [...CORE_CONFIGS, ...LEGACY_CONFIGS]

// ═══════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════

export function getWorkflowConfigs(): WorkflowConfig[] {
  return WORKFLOW_CONFIGS.sort((a, b) => a.order - b.order)
}

export function getWorkflowById(id: string): WorkflowConfig | undefined {
  return WORKFLOW_CONFIGS.find((w) => w.id === id)
}

/** V3 core command IDs (always installed) */
export function getCoreCommandIds(): string[] {
  return CORE_CONFIGS.map((w) => w.id)
}

/** Legacy command IDs (optional install) */
export function getLegacyCommandIds(): string[] {
  return LEGACY_CONFIGS.map((w) => w.id)
}

/** All command IDs (core + legacy) */
export function getAllCommandIds(): string[] {
  return WORKFLOW_CONFIGS.map((w) => w.id)
}

/**
 * @deprecated Use getCoreCommandIds() or getAllCommandIds() instead.
 */
export const WORKFLOW_PRESETS = {
  full: {
    name: '完整',
    nameEn: 'Full',
    description: `全部命令（${WORKFLOW_CONFIGS.length}个）`,
    descriptionEn: `All commands (${WORKFLOW_CONFIGS.length})`,
    workflows: WORKFLOW_CONFIGS.map((w) => w.id),
  },
}

export type WorkflowPreset = keyof typeof WORKFLOW_PRESETS

export function getWorkflowPreset(preset: WorkflowPreset): string[] {
  return [...WORKFLOW_PRESETS[preset].workflows]
}
