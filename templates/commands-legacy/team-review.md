---
description: 'Agent Teams 审查 - GPT、Grok 双路审查实施产出，按 Critical/Warning/Info 分级'
---

<!-- CCG:TEAM:REVIEW:START -->
**Core Philosophy**

GPT、Grok 的独立审查覆盖后端与前端的不同缺陷视角。
- Critical 问题必须修复后才能结束。
- 审查范围严格限于 team-exec 的变更。

**Guardrails**

- **MANDATORY**: GPT、Grok 两个 reviewer 都完成或被报告不可用后才能综合。
- 每个审查来源使用完整 `git diff`、相关文件和计划约束。
- GPT、Grok 使用不持久化的新会话，不使用 `resume` 或 reviewer `SESSION_ID`。

**Steps**

1. **收集变更产物**
   - 运行 `git diff` 获取完整变更。
   - 如有 `.claude/team-plan/` 计划文件，读取约束和成功判据。
   - 读取变更涉及的完整文件。

2. **GPT、Grok 双 profile 审查（PARALLEL）**
   - 通过 Bash 获取 `{{WORKDIR}}`，Unix 使用 `pwd`，Windows CMD 使用 `cd`。
   - 在同一条消息中启动 GPT、Grok 两个 `Bash` 调用，均为 `run_in_background: true`。
   - 每个调用使用：

   ```text
   ROLE_FILE: ~/.claude/.ccg/prompts/claude/reviewer.md
   <TASK>
   审查以下变更：
   <完整 git diff、完整相关文件、计划约束>
   </TASK>
   OUTPUT: JSON，包含 severity、dimension、file、line、description、fix_suggestion。
   ```

   | reviewer | wrapper 参数 | 审查重点 |
   | --- | --- | --- |
   | GPT | `--backend claude --no-session-persistence --claude-model {{REVIEW_GPT_MODEL}} --claude-effort {{REVIEW_GPT_EFFORT}}` | 后端逻辑、正确性、安全、回归与测试缺口 |
   | Grok | `--backend claude --no-session-persistence --claude-model {{REVIEW_GROK_MODEL}} --claude-effort {{REVIEW_GROK_EFFORT}}` | 前端交互、可访问性、设计一致性与前端安全 |

   - GPT 审查后端逻辑、正确性、安全、回归与测试缺口，Grok 审查前端交互、可访问性、设计一致性与前端安全。
   - 使用 `TaskOutput` 等待两个任务。
   - 单个 reviewer 失败时最多重试两次，之后标记该 reviewer 不可用。

3. **综合发现**
   - 合并 GPT、Grok 两份报告并去重。
   - Critical：安全漏洞、逻辑错误、数据丢失风险，必须修复。
   - Warning：模式偏离、可维护性或集成风险，建议修复。
   - Info：可选改进。

4. **输出审查报告**

   ```markdown
   ## 审查报告

   ### Critical
   - [GPT] file.ts:42 - 描述

   ### Warning
   - [Grok] utils.ts:88 - 描述

   ### Info
   - [GPT] helper.ts:20 - 描述
   ```

5. **决策门**
   - 有 Critical finding 时，先展示并确认后修复。
   - 修复后重新运行受影响的审查维度。

**Exit Criteria**

- [ ] GPT、Grok 两个 reviewer 已完成或被报告不可用
- [ ] 所有 finding 已综合分级
- [ ] 没有未处理的 Critical finding
- [ ] 审查报告已输出

<!-- CCG:TEAM:REVIEW:END -->
