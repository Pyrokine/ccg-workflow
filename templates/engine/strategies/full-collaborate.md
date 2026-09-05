# Strategy: Full Collaborate — 完整多模型协作

> 适用于复杂功能开发，需要多模型并行分析、规划和审查。等效于 /ccg:workflow。

## 适用条件

- 复杂度 L/XL（5+ 文件，跨模块，架构级变更）
- 风险 medium 或 high
- 需要多角度分析和交叉验证

## 前置加载

```
Read("~/.claude/.ccg/engine/model-router.md")
```

---

## 工作流状态机

[phase-state:1-research]
当前阶段：研究与分析 [模式：研究]
📍 Next: 需求评分 ≥7 后进入多模型构思
[/phase-state:1-research]

[phase-state:2-ideation]
当前阶段：多模型构思 [模式：构思]
Gate: 需求完整性评分 ≥7 ✓
📍 Next: 双模型分析结果返回后进入规划
[/phase-state:2-ideation]

[phase-state:3-planning]
当前阶段：详细规划 [模式：计划]
Gate: 双模型分析已返回 ✓
📍 Next: 用户审批计划后进入实施（HARD STOP）
[/phase-state:3-planning]

[phase-state:4-implementation]
当前阶段：实施 [模式：执行]
Gate: 用户已审批计划 ✓
📍 Next: 实施完成后进入优化审查
[/phase-state:4-implementation]

[phase-state:5-optimization]
当前阶段：优化审查 [模式：优化]
Gate: 实施已完成 ✓
📍 Next: 审查结果整合后进入最终验收
[/phase-state:5-optimization]

[phase-state:6-final]
当前阶段：最终验收 [模式：评审]
Gate: 优化审查已完成 ✓
📍 Next: 验收通过后建议提交
[/phase-state:6-final]

---

## 阶段详情

### Phase 1: 研究与分析 [required]

`[模式：研究]`

1. **需求增强**：分析 $ARGUMENTS 的意图、缺失信息、隐含假设，补全为结构化需求（目标、约束、范围、验收标准）
2. **上下文检索**：用 MCP 搜索工具收集项目上下文
3. **需求完整性评分**（0-10）：
    - 目标明确性（0-3）、预期结果（0-3）、边界范围（0-2）、约束条件（0-2）
    - ≥7：继续 | <7：停止，提出补充问题

用户确认增强后的需求后，使用 `update-requirements` 写入完整契约，再用 `checkpoint` 更新为 `1-research`，下一动作设为“启动多模型构思”。

### Phase 2: 多模型构思 [required]

`[模式：构思]`

**Gate check**: 需求评分 ≥7

**模型调用**：

- **backend 模型**：analyzer 角色 — 技术可行性、后端方案、风险评估
- **frontend 模型**：只有任务明确涉及前端、布局、界面、页面设计、UI/UX、视觉样式或交互设计时才调用

使用 model-router.md 中的调用模板。

等待双模型返回：

```
TaskOutput({ task_id: "$BACKEND_TASK_ID", block: true, timeout: 600000 })
TaskOutput({ task_id: "$FRONTEND_TASK_ID", block: true, timeout: 600000 })
```

**保存 SESSION_ID**（`BACKEND_SESSION` / `FRONTEND_SESSION`）用于后续复用。

**重试规则**：

- frontend 模型失败 → 重试 2 次，间隔 5s
- frontend 模型 3 次全败 → 按 `frontend.models` 顺序调用下一个候选模型执行同一任务
- backend 模型执行中（5-15 分钟正常）→ 持续等待，**绝不终止**
- fallback 全败 → 降级为后端单模型，告知用户

综合双方分析，输出方案对比（至少 2 个方案）。

外部模型返回后重新 `resolve`。综合结果使用 `write-artifact` 写入 `analysis.md`，再用 `checkpoint` 更新为 `2-ideation`，下一动作设为“根据分析与 authoritative spec 撰写计划”。

不要创建 `context.jsonl` 或扫描 `.ccg/spec/`。子 Agent 上下文由 task snapshot 中的 requirements、artifacts 和精确 `specRefs` 提供。

### Phase 3: 详细规划 [required]

`[模式：计划]`

**Gate check**: 双模型分析已返回

**模型调用**（复用会话 `resume`）：

- **backend 模型**：architect 角色 + `resume $BACKEND_SESSION`
- **frontend 模型**：只有 Phase 2 已启动 frontend 会话时，才用 architect 角色 + `resume $FRONTEND_SESSION`

综合双方规划，输出详细实施计划：

- 实施步骤（按文件/模块分组）
- 架构决策及理由
- 测试策略
- 风险及缓解措施

按实体、版本、依赖方向和排除项逐字段核对 authoritative spec，再用 `write-artifact` 写入 `plan.md`。随后用 `checkpoint` 更新为 `3-planning`，`gate` 设为 `user_approval_required`，下一动作设为“等待用户审批计划”。

**⛔⛔⛔ HARD STOP — 你必须在这里停下来，向用户展示以下选项并等待回复。不可跳过，不可默认选择。⛔⛔⛔**

你现在必须输出以下内容（原样输出，不是代码块示例）：

---
⛔ **计划审批 + 执行模式选择**

请审批以上计划，并选择谁来写代码：

1. **Agent Teams** — Claude Builders 并行写，多文件同时进行
2. **backend / frontend 模型** — 用户明确选择的外部模型写代码

请回复 1 或 2（或直接说"用team"/"用codex"等）。
---

**在用户回复之前，你不可以执行任何文件写入操作。** 未审批不可进入 Phase 4。

用户确认后，用 `checkpoint` 将 `gate` 设为 `null`，阶段更新为 `4-implementation`，并记录用户选择的执行模式。

### Phase 4: 实施

`[模式：执行]`

**Gate check**: 用户已审批计划 + 选择了执行模式

根据用户选择的执行模式执行：

---

#### 模式 A: Agent Teams 并行（用户选 [1]）

**⛔⛔⛔ 你的第一个动作必须是 TeamCreate。不是 Write，不是 Bash，不是 Read，是 TeamCreate。⛔⛔⛔**

**你绝对不可以自己用 Write/Edit 工具写产品代码。所有代码由 Team Builder 写。你只做编排。**

使用 `checkpoint` 保持阶段为 `4-implementation`，下一动作设为“TeamCreate 后按已审批计划派发 Builders”。

#### Step 1: 拆分子任务

从 plan.md 中提取实施步骤，按**文件归属**拆分为独立子任务：

- 每个子任务有明确的文件范围（互不重叠）
- 标注依赖关系：Layer 1（无依赖）→ Layer 2（依赖 Layer 1）
- 每个 dispatch 写明 task ID、task revision，并声明注入的 `ccg-specs` 高于 prompt 摘要；发现冲突时停止并报告

#### Step 2: 创建 Team（必须执行）

**立即调用 TeamCreate，不可跳过或假设会失败：**

```
TeamCreate({ team_name: "{task-id}-team", description: "CCG 实施团队" })
```

⚠️ 只有当 TeamCreate **实际返回错误**时（Agent Teams 未启用），才可降级为自己写。**不可预判失败而跳过。**

#### Step 3: 并行 spawn Layer 1 Builders

**所有 Layer 1 Builder 必须在同一条消息中 spawn**（一条消息多个 Agent 调用 = 真正并行）：

```
Agent({
  team_name: "{task-id}-team",
  name: "dev-1",
  model: "sonnet",
  prompt: "你是 Builder，负责实施子任务 1。\n\n## 工作目录\n{WORKDIR}\n\n## Active task\nID: {task-id}\nRevision: {task-revision}\n\n## 文件范围约束（⛔ 硬性规则）\n你只能创建或修改以下文件：\n- {file1}\n- {file2}\n严禁修改其他文件。违反 = 任务失败。\n\n## 实施步骤\n{steps from plan.md}\n\n## 验收标准\n{criteria from requirements.md}\n\n注入的精确 spec section 和 requirements.md 高于本派发摘要；发现冲突时停止并报告，不修改 `.ccg/`。"
})
Agent({
  team_name: "{task-id}-team",
  name: "dev-2",
  model: "sonnet",
  prompt: "..."
})
// ... 所有 Layer 1 dev 在这一条消息里
```

#### Step 4: 等待 Layer 1 → spawn Layer 2

- teammates 完成后自动通知（不需要轮询）
- Layer 1 全部完成后 → 在新消息中 spawn Layer 2 Builders
- Builder 遇到问题 → SendMessage 指导

#### Step 5: 准备 Claude Code 审查

收集完整 `git diff`、相关完整文件和验收标准。在 Phase 5 创建独立 Claude Code 审查 Agent。只有用户明确请求 GPT、Grok、双模型审查或 `/ccg:spec-review` 时才启动外部 reviewer。

Critical → spawn fix-dev 修复（最多 2 轮）。

#### Step 6: shutdown + cleanup

```
SendMessage({ to: "dev-1", message: { type: "shutdown_request" } })
SendMessage({ to: "dev-2", message: { type: "shutdown_request" } })
```

#### 降级方案（仅当 TeamCreate 实际报错时）

如果 TeamCreate 返回错误（如 `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` 未启用），则：

1. 告知用户："Agent Teams 未启用，降级为顺序实施"
2. 按 plan.md 中的 Layer 顺序逐文件实施
3. 仍然遵守质量关卡

---

#### 模式 B: 外部模型并行实施（用户选 [2]）

使用 `checkpoint` 保持阶段为 `4-implementation`，下一动作设为“Parallel Builder 执行已审批 plan”。

Claude 作为编排者，调用当前 backend 模型并行写代码。backend 为 `claude` 时使用 Agent Teams，不启动 wrapper。

**Step 1**: 从 plan.md 按**文件归属**拆分为并行子任务：

- **Layer 1** — 无依赖（底层模块：model/store/util/schema）→ 并行
- **Layer 2** — 依赖 Layer 1（上层：route/middleware/controller/component）→ 串行等 Layer 1
- 每个子任务：active task ID + task revision + 文件范围 + 实施步骤 + 验收标准 + 验证命令
- 每个派发声明注入的精确 spec section 与 requirements.md 优先；缺失上下文、revision 不一致或内容冲突时停止并报告

**Step 2**: 调用 codeagent-wrapper `--parallel` 模式：

```
Bash({
  command: "~/.claude/bin/codeagent-wrapper {{LITE_MODE_FLAG}}--progress --parallel --backend {{BACKEND_PRIMARY}} - \"$WORKDIR\" <<'PARALLEL_EOF'\n---TASK---\nid: layer1-{name1}\nworkdir: $WORKDIR\n---CONTENT---\nROLE_FILE: ~/.claude/.ccg/prompts/{{BACKEND_PRIMARY}}/builder.md\n<TASK>\n## Active task\nID: {task-id}\nRevision: {task-revision}\n\n## Authority\n注入的精确 spec section 和 requirements.md 高于本派发摘要；缺失上下文、revision 不一致或内容冲突时停止并报告。不得修改 `.ccg/`。\n\n## 文件范围（⛔ 只改这些文件）\n{file1, file2}\n\n## 实施步骤\n{steps from plan.md Layer 1}\n\n## 验证命令\n{test/lint commands}\n</TASK>\n---TASK---\nid: layer1-{name2}\nworkdir: $WORKDIR\n---CONTENT---\nROLE_FILE: ~/.claude/.ccg/prompts/{{BACKEND_PRIMARY}}/builder.md\n<TASK>\n## Active task\nID: {task-id}\nRevision: {task-revision}\n\n## Authority\n注入的精确 spec section 和 requirements.md 高于本派发摘要；缺失上下文、revision 不一致或内容冲突时停止并报告。不得修改 `.ccg/`。\n\n## 文件范围\n{file3, file4}\n\n## 实施步骤\n{steps}\n</TASK>\n---TASK---\nid: layer2-{name3}\nworkdir: $WORKDIR\ndependencies: layer1-{name1},layer1-{name2}\n---CONTENT---\nROLE_FILE: ~/.claude/.ccg/prompts/{{BACKEND_PRIMARY}}/builder.md\n<TASK>\n## Active task\nID: {task-id}\nRevision: {task-revision}\n\n## Authority\n注入的精确 spec section 和 requirements.md 高于本派发摘要；缺失上下文、revision 不一致或内容冲突时停止并报告。不得修改 `.ccg/`。\n\n## 文件范围\n{file5, file6}\n\n## 实施步骤\n{steps from Layer 2}\n</TASK>\nPARALLEL_EOF",
  run_in_background: true,
  timeout: 3600000,
  description: "Parallel Builder: {N} 个子任务（L1: {X} 并行 → L2: {Y} 串行）"
})
```

拆分原则：

- Layer 1 子任务数量 = plan 中无依赖的文件组数（通常 2-4 个）
- 每个子任务的文件范围**不可重叠**
- 可混合 backend（后端任务用 backend 模型，前端任务用 frontend 模型）— 在 `---TASK---` 中指定对应 `backend` 值

**Step 3**: 等待完成，读取汇总报告（wrapper 自动合并所有子任务结果）

**Step 4**: Lead 准备审查材料：

1. 收集完整 `git diff`、相关完整文件和 plan 验收标准
2. 将范围信息附入独立 Claude Code 审查 Agent 的输入
3. 不在此步骤自行审查或修复

**降级**：外部模型失败/超时 → 告知用户，切换到模式 A 执行

### Phase 5: 迭代审查 [required · Ralph Loop]

`[模式：优化]`

**Gate check**: 实施已完成

使用 `checkpoint` 更新为 `5-optimization`，下一动作设为“Ralph Loop Round 1: 模型审查与质量关卡”。

参考 `phase-guide.md § 9 Ralph Loop` 执行迭代审查。最多 3 轮。

#### Round N 流程（N=1,2,3）

**5a. Claude Code 审查**

- 创建独立 Claude Code 审查 Agent，使用完整 diff、相关文件和验收标准检查正确性、安全、回归与测试缺口
- 不调用 codeagent-wrapper 或任何外部 CLI
- 只有用户明确请求 GPT、Grok、双模型审查或 `/ccg:spec-review` 时，才启动对应外部 review profile。外部 reviewer 使用 `--no-session-persistence`，不使用 `resume` 或 `SESSION_ID`
- Lead 在收到审查结果后汇总并确认 finding

**5b. 质量关卡**

**⛔ 以下 Skill 必须逐个调用执行，不可跳过，不可用自己的判断替代：**

1. 调用 Skill `ccg:verify-security` — 等待报告
2. 调用 Skill `ccg:verify-quality` — 等待报告
3. 调用 Skill `ccg:verify-change` — 等待报告

**5c. 综合报告**

整合审查意见 + 质量关卡结果，按严重度分级：

- **Critical**：必须修复（阻塞交付）
- **Warning**：建议修复
- **Info**：供参考

每轮使用 `write-artifact` 覆盖 `review.md`，再用 `checkpoint` 把轮次、finding 数量和修复结果写入 progress。不要创建单独的状态日志。

**5d. 用户决定（⛔ 必须等待）**

展示审查结果后询问用户：

- 有 Critical → `发现 N 个 Critical 问题。修复后再审一轮？[Y/n]`
- 无 Critical 但有 Warning → `无 Critical 问题。需要再审一轮处理 Warning？[y/N]`
- 全部通过 → 直接进入 Phase 6

用户选择继续 →

1. spawn fix-dev（**新 Agent，干净上下文**）修复 Critical/Warning
2. fix-dev 完成后回到 5a 开始 Round N+1
3. 使用 `checkpoint` 更新 progress 中的修复记录

用户选择停止 → 进入 Phase 6

**第 3 轮仍有 Critical** → 强制停止，建议回退到 Phase 3 重新规划。

### Phase 6: 最终验收

`[模式：评审]`

使用 `checkpoint` 更新为 `6-final`，下一动作设为“逐项执行最终验收”。

1. 对照计划检查完成情况
2. 运行测试验证功能
3. `git diff` 全量变更摘要
4. 输出结果：
   ```
   ✅ 协作开发完成
     变更: [N] 文件，[M] 行
     方案: [选定方案摘要]
     审查: [Critical: N, Warning: N, Info: N]
     📍 Next: /ccg commit 提交，或查看 .ccg/tasks/{task-id}/ 中的完整记录
   ```

#### Spec Evolution 与完成

按 `phase-guide.md § 7` 检查本次变更是否需要更新项目已有的 tracked 文档或 OpenSpec，并用 `set-spec-evolution` 记录结果。

最终验收通过且 Gate 为 `null` 后，使用 `finish` 标记任务为 `completed`。任务目录保持原路径，不移动、不提交 `.ccg/`。

```
📍 Next: /ccg:commit 提交产品代码
```

---

## 铁律

- **Phase 3 必须用户审批** — HARD STOP，不可自动跳过
- **Phase 2 双模型必须并行** — 不可串行调用
- **外部模型返回前不可提前进入下一阶段** — 等待是必须的
- **不可因为"任务简单"而跳过 [required] 阶段** — 每个阶段都有其价值
- **执行权限跟随已审批模式** — 仅模式 B 的 Builder 可在各自文件范围内写代码；分析、规划和 reviewer 不写产品代码
- **评分 <7 或用户未审批时强制停止** — 不可绕过
