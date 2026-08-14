---
description: '{{BACKEND_PRIMARY}} 全权执行计划 - 读取 /ccg:plan 产出的计划文件，{{BACKEND_PRIMARY}} 承担 MCP 搜索 + 代码实现 + 测试，多模型审核'
---

# Codex-Exec - Codex 全权执行计划

$ARGUMENTS

---

## 核心理念

**与 `/ccg:plan` 配对使用**：

```
/ccg:plan → 多模型协同规划（Codex ∥ frontend 模型 分析 → Claude 综合）
                ↓ 计划文件 (.claude/plan/xxx.md)
/ccg:codex-exec → {{BACKEND_PRIMARY}} 全权执行（MCP 搜索 + 代码实现 + 测试）
                ↓ 代码变更
                → GPT ∥ Grok 外部审核
```

**与 `/ccg:execute` 的区别**：

| 维度           | `/ccg:execute`                                            | `/ccg:codex-exec`              |
|--------------|-----------------------------------------------------------|--------------------------------|
| 代码实现         | Claude 重构 {{BACKEND_PRIMARY}}/{{FRONTEND_PRIMARY}} 的 Diff | **{{BACKEND_PRIMARY}} 直接实现**   |
| MCP 搜索       | Claude 调用 MCP                                             | **{{BACKEND_PRIMARY}} 调用 MCP** |
| Claude 上下文   | 高（搜索结果 + 代码全进来）                                           | **极低（只看摘要 + diff）**            |
| Claude token | 大量消耗                                                      | **极少消耗**                       |
| 审核           | 多模型审查                                                     | **多模型审查（不变）**                  |

---

## 语言协议

- 与工具/模型交互用 **英语**
- 与用户交互用 **中文**

---

## 多模型调用规范

**工作目录**：

- `{{WORKDIR}}`：**必须通过 Bash 执行 `pwd`（Unix）或 `cd`（Windows CMD）获取当前工作目录的绝对路径**，禁止从 `$HOME` 或环境变量推断
- 如果用户通过 `/add-dir` 添加了多个工作区，先用 Glob/Grep 确定任务相关的工作区
- 如果无法确定，用 `AskUserQuestion` 询问用户选择目标工作区

**{{BACKEND_PRIMARY}} 执行调用语法**：

```
Bash({
  command: "~/.claude/bin/codeagent-wrapper {{LITE_MODE_FLAG}}--progress --backend {{BACKEND_PRIMARY}} - \"{{WORKDIR}}\" <<'EXEC_EOF'
<TASK>
<指令内容>
</TASK>
EXEC_EOF",
  run_in_background: true,
  timeout: 3600000,
  description: "简短描述"
})
```

**{{BACKEND_PRIMARY}} 复用会话调用**：

```
Bash({
  command: "~/.claude/bin/codeagent-wrapper {{LITE_MODE_FLAG}}--progress --backend {{BACKEND_PRIMARY}} resume <SESSION_ID> - \"{{WORKDIR}}\" <<'EXEC_EOF'
<TASK>
<指令内容>
</TASK>
EXEC_EOF",
  run_in_background: true,
  timeout: 3600000,
  description: "简短描述"
})
```

**审核调用语法**（GPT、Grok 双路审查）：

在同一条消息中启动 GPT、Grok 两个 `Bash` 调用，每个调用接收完整 git diff、计划文件和相关完整文件：

| reviewer | wrapper 参数 | 审查重点 |
|---|---|---|
| GPT | `--backend claude --no-session-persistence --claude-model {{REVIEW_GPT_MODEL}} --claude-effort {{REVIEW_GPT_EFFORT}}` | 后端逻辑、正确性、安全、回归与测试缺口 |
| Grok | `--backend claude --no-session-persistence --claude-model {{REVIEW_GROK_MODEL}} --claude-effort {{REVIEW_GROK_EFFORT}}` | 前端交互、可访问性、设计一致性与前端安全 |

两个外部调用使用 `~/.claude/.ccg/prompts/claude/reviewer.md`，不得修改文件，输出按 Critical/Warning/Info 分级的问题、位置、依据与修复建议。外部 reviewer 不使用 `resume` 或保存 `SESSION_ID`。

**角色提示词**：

| 阶段 | reviewer |
|---|---|
| 审查 | `~/.claude/.ccg/prompts/claude/reviewer.md`，供 GPT、Grok 两个外部 profile 共用 |

**等待后台任务**（最大超时 600000ms = 10 分钟）：

```
TaskOutput({ task_id: "<task_id>", block: true, timeout: 600000 })
```

**重要**：

- 必须指定 `timeout: 600000`，否则默认只有 30 秒会导致提前超时
- 若 10 分钟后仍未完成，继续用 `TaskOutput` 轮询，**绝对不要 Kill 进程**
- 若因等待时间过长跳过了等待，**必须调用 `AskUserQuestion` 询问用户选择继续等待还是 Kill Task**
- ⛔ **前端模型失败必须重试**：若前端模型调用失败（非零退出码或输出包含错误信息），最多重试 2 次（间隔 5 秒）。仅当 3
  次全部失败时才跳过前端模型结果并使用单模型结果继续。
- ⛔ **后端模型结果必须等待**：后端模型执行时间较长（5-15 分钟）属于正常。TaskOutput 超时后必须继续用 TaskOutput 轮询，*
  *绝对禁止在后端模型未返回结果时直接跳过或继续下一阶段**。已启动的后端任务若被跳过 = 浪费 token + 丢失结果。

---

## 执行工作流

**执行任务**：$ARGUMENTS

### 📖 Phase 0：读取计划

`[模式：准备]`

1. **识别输入类型**：
    - 计划文件路径（如 `.claude/plan/xxx.md`）→ 读取并解析
    - 直接的任务描述 → 提示用户先执行 `/ccg:plan`

2. **解析计划内容**，提取：
    - 任务类型（前端/后端/全栈）
    - 技术方案
    - 实施步骤
    - 关键文件列表
    - SESSION_ID（`CODEX_SESSION` / `FRONTEND_SESSION`）

3. **执行前确认**：
   向用户展示计划摘要，确认后执行：

   ```markdown
   ## 即将执行

   **任务**：<计划标题>
   **模式**：Codex 全权执行
   **步骤**：<N 步>
   **关键文件**：<N 个>

   Codex 将自主完成：MCP 搜索 + 代码实现 + 测试验证
   GPT、Grok 将以独立临时会话进行后端与前端审查

   确认执行？(Y/N)
   ```

---

### ⚡ Phase 1：Codex 全权执行

`[模式：执行]`

**将计划转化为 Codex 结构化指令，一次性下发**：

```
Bash({
  command: "~/.claude/bin/codeagent-wrapper {{LITE_MODE_FLAG}}--progress --backend {{BACKEND_PRIMARY}} resume <CODEX_SESSION> - \"{{WORKDIR}}\" <<'EXEC_EOF'
<TASK>
You are a full-stack execution agent. Implement the following plan end-to-end.

## Implementation Plan
<将 Phase 0 解析出的完整计划内容粘贴于此>

## Your Instructions

### Step 1: Context Verification
Before coding, verify you have sufficient context:
- Use ace-tool MCP (search_context) to search for relevant existing code patterns
- Read the key files listed in the plan to understand current implementation
- If the plan references external libraries/APIs, use context7 MCP to query their latest documentation
- If latest information is needed, use grok-search MCP for web search

### Step 2: Implementation
Implement each step from the plan in order:
<将计划的实施步骤逐条列出>

Constraints:
- Follow existing code conventions in this project
- Handle edge cases and errors properly
- Keep changes minimal and focused on the plan
- Do NOT modify files outside the plan's scope

### Step 3: Self-Verification
After implementation:
- Run lint/typecheck if available
- Run existing tests: <从计划中提取测试命令，如无则 "run project's test suite">
- Verify no regressions in touched modules

## Output Format
Respond with a structured report:

### CONTEXT_GATHERED
<What information was searched/found, key findings from MCP tools>

### CHANGES_MADE
For each file changed:
- File path
- What was changed and why
- Lines added/removed

### VERIFICATION_RESULTS
- Lint/typecheck: pass/fail
- Tests: pass/fail (details if fail)
- Manual checks performed

### REMAINING_ISSUES
<Any unresolved issues, edge cases, or suggestions>
</TASK>
EXEC_EOF",
  run_in_background: true,
  timeout: 3600000,
  description: "Codex 全权执行：<计划标题>"
})
```

**📌 记录 SESSION_ID**（`CODEX_EXEC_SESSION`）

如果计划中无 `CODEX_SESSION`（用户跳过了 `/ccg:plan` 的多模型分析），则使用新会话。

用 `TaskOutput` 等待完成。

---

### 🔍 Phase 2：审查准备

`[模式：准备]`

**Lead 只整理材料并启动审查，不自行判定实现质量**：

1. **读取 Codex 报告**：解析 CONTEXT_GATHERED / CHANGES_MADE / VERIFICATION_RESULTS / REMAINING_ISSUES。
2. **收集审查上下文**：

   ```
   Bash({ command: "git diff HEAD", description: "获取审查变更" })
   ```

3. **准备 GPT、Grok 输入**：附上完整 diff、相关完整文件、计划约束和 Codex 验证结果，随后进入 Phase 3。

---

### 🔄 Phase 2.5：审查后追加指令（仅在存在已确认 Critical finding 时）

`[模式：追加]`

**复用 Codex 会话，下发已确认问题的修正指令**：

```
Bash({
  command: "~/.claude/bin/codeagent-wrapper {{LITE_MODE_FLAG}}--progress --backend {{BACKEND_PRIMARY}} resume <CODEX_EXEC_SESSION> - \"{{WORKDIR}}\" <<'FIXEOF'
<TASK>
The implementation needs corrections:

## Issues Found
1. <问题描述 + 具体文件:行号>
2. <问题描述 + 具体文件:行号>

## Required Fixes
1. <具体修正要求>
2. <具体修正要求>

Apply fixes and re-run tests. Report results in the same format.
</TASK>
FIXEOF",
  run_in_background: true,
  timeout: 3600000,
  description: "Codex 修正：<问题简述>"
})
```

等待完成后重新进入 Phase 3。**最多 2 轮返工**，超过后将未解决问题报告给用户。

---

### ✅ Phase 3：多模型审核

`[模式：审核]`

**GPT、Grok 外部交叉审查**：

1. **获取变更 diff**：

   ```
   Bash({ command: "git diff HEAD", description: "获取完整变更 diff" })
   ```

2. **并行调用 GPT、Grok reviewer**（`run_in_background: true`）：

    - **GPT**：`--backend claude --no-session-persistence --claude-model {{REVIEW_GPT_MODEL}} --claude-effort {{REVIEW_GPT_EFFORT}}`，关注后端逻辑、正确性、安全、回归与测试缺口
    - **Grok**：`--backend claude --no-session-persistence --claude-model {{REVIEW_GROK_MODEL}} --claude-effort {{REVIEW_GROK_EFFORT}}`，关注前端交互、可访问性、设计一致性与前端安全

   GPT、Grok 使用 `~/.claude/.ccg/prompts/claude/reviewer.md`，输入变更完整 diff、计划文件和相关完整文件。用 `TaskOutput` 等待两个结果，不得 `resume` 或保存 reviewer `SESSION_ID`。

3. **整合审查意见**：
    - 合并 GPT、Grok 两份报告并去重，每项回到当前源码确认
    - **Critical** → 必须修复
    - **Warning** → 建议修复，报告给用户决定
    - **Info** → 记录不处理

4. **执行修复**（如有 Critical）：
    - 将已确认的 Critical finding 下发给 {{BACKEND_PRIMARY}} 修复
    - 修复后重新执行 Phase 3

---

### 📦 Phase 4：交付

`[模式：交付]`

向用户报告：

```markdown
## ✅ 执行完成

### 执行摘要
| 项目 | 详情 |
|------|------|
| 计划 | <计划文件路径> |
| 模式 | {{BACKEND_PRIMARY}} 全权执行 + GPT、Grok 外部审核 |
| 搜索 | <Codex 使用了哪些 MCP 工具，关键发现> |
| 变更 | <N 个文件，+X/-Y 行> |
| 测试 | <通过/失败> |
| 返工 | <0/1/2 轮> |

### 变更清单
| 文件 | 操作 | 说明 |
|------|------|------|
| path/to/file.ts | 修改/新增 | 描述 |

### 审核结果
- GPT 审查：<通过/发现 N 个问题>
- Grok 审查：<通过/发现 N 个问题>
- 整合处理：<已修复 N 个 Critical，N 个 Warning 待用户决定>

### 后续建议
1. [ ] <建议的测试步骤>
2. [ ] <建议的验证步骤>
```

---

## 关键规则

1. **Lead 编排原则** — Lead 只读计划、整理审查材料、启动 GPT/Grok 并汇总确认 finding。
2. **{{BACKEND_PRIMARY}} 全权执行** — MCP 搜索、文档查询、代码检索、实现、测试全由 {{BACKEND_PRIMARY}} 完成。
3. **GPT、Grok 双 profile 审核** — 两者使用独立临时会话交叉审查，主 Claude 只汇总结果。
4. **结论依据** — 每项 finding 必须回到当前源码确认。
5. **一次性下发** — 尽量一次给 Codex 完整指令 + 完整计划，减少来回通信。
6. **最多 2 轮返工** — 超过 2 轮后报告未解决问题，避免无限循环。
7. **计划对齐** — Codex 实现必须在计划范围内，超出范围的变更视为违规。

---

## 使用方法

```bash
# 标准流程：先规划，再执行
/ccg:plan 实现用户认证功能
# 审查计划后...
/ccg:codex-exec .claude/plan/user-auth.md

# 直接执行（会提示先 /ccg:plan）
/ccg:codex-exec 实现用户认证功能
```

---

## 与 /ccg:plan 的关系

```
/ccg:plan ──→ .claude/plan/xxx.md
                    │
          ┌─────────┴─────────┐
          ↓                   ↓
   /ccg:execute        /ccg:codex-exec
   (Claude 重构)       (Codex 全权)
   Claude 高消耗       Claude 极低消耗
   精细控制             高效执行
```

用户可根据任务特点选择：

- **需要精细控制** → `/ccg:execute`（Claude 逐行重构）
- **需要高效执行** → `/ccg:codex-exec`（Codex 一把梭）
