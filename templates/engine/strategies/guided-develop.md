# Strategy: Guided Develop — 引导式开发

> 适用于中等复杂度的功能开发。可选调用外部模型进行领域分析。

## 适用条件

- 复杂度 M（2-5 文件，单模块）
- 需要一定规划但不需要完整的多模型协作
- 风险 low 或 medium

---

## 工作流状态机

[phase-state:1-requirements]
当前阶段：需求增强
📍 Next: 需求结构化后进入上下文检索
[/phase-state:1-requirements]

[phase-state:2-context]
当前阶段：上下文检索
Gate: 需求已增强 ✓
📍 Next: 上下文收集完毕后判断是否需要外部模型分析
[/phase-state:2-context]

[phase-state:3-analysis]
当前阶段：领域分析（可选外部模型）
Gate: 上下文已收集 ✓
📍 Next: 分析完成后进入规划阶段
[/phase-state:3-analysis]

[phase-state:4-plan]
当前阶段：规划
Gate: 分析已完成 ✓
📍 Next: 用户确认计划后进入实施
[/phase-state:4-plan]

[phase-state:5-implement]
当前阶段：实施
Gate: 用户已确认计划 ✓（HARD STOP）
📍 Next: 实施完成后进入验证
[/phase-state:5-implement]

[phase-state:6-verify]
当前阶段：验证
Gate: 实施已完成 ✓
📍 Next: 验证通过后报告结果
[/phase-state:6-verify]

---

## 阶段详情

### Phase 1: 需求增强 [required]

分析用户的 $ARGUMENTS，补全为结构化需求：

- **目标**：要实现什么
- **约束**：不能改什么、需要兼容什么
- **范围**：哪些文件/模块会受影响
- **验收标准**：怎样算完成

展示增强后的需求，用户确认或调整。确认后使用 `update-requirements` 写入完整任务契约，再用 `checkpoint` 更新为 `1-requirements`，下一动作设为“检索相关代码与规范”。

### Phase 2: 上下文检索 [required]

1. 用 MCP 搜索工具搜索相关代码
2. 读取目标模块的核心文件
3. 识别依赖关系和可能的影响范围
4. 了解现有的测试覆盖情况
5. 逐字段核对 `requirements.md` 和注入的 `ccg-specs`，不得用摘要或旧计划覆盖规范
6. 使用 `checkpoint` 更新为 `2-context`，下一动作设为“启动领域分析”

### Phase 3: 多视角分析 [required]

**Gate check**: 需求已增强 ✓ 上下文已收集 ✓

**⛔ M 复杂度必须启动后端分析。只有任务明确涉及前端、布局、界面、页面设计、UI/UX、视觉样式或交互设计时，才额外启动前端分析。**

执行步骤：

1. primary route 为 Claude 时，创建独立 Claude Code Agent。后端 Agent 的 prompt 包含 `CCG_ROLE: research`、增强后的需求和 Phase 2 的项目上下文；前端 Agent 仅在前端设计范围内创建，prompt 同样包含 `CCG_ROLE: research`。不得调用 codeagent-wrapper 或任何外部 CLI。
2. 只有用户已将相应 primary route 明确配置为 Codex、Antigravity、Grok、Kimi Code 或 OpenCode 时，才按 `model-router.md` 调用 wrapper。
3. 多个 Agent 或外部 route 必须在同一条消息中启动。Claude Code Agent 完成后由运行时通知；外部 route 返回 task ID 时使用 `TaskOutput` 等待。
4. 外部模型返回后重新 `resolve`，确认 active task 和 revision 未变化。
5. 综合分析结果，提取关键建议用于 Phase 4 规划
7. 有可复用分析时使用 `write-artifact` 写入 `analysis.md`，再用 `checkpoint` 更新为 `3-analysis`，下一动作设为“撰写实施计划”

### Phase 4: 规划 [required]

撰写实施计划，输出格式：

```
📋 实施计划

## 需求
[增强后的需求摘要]

## 方案
[选定方案及理由]

## 步骤
1. [文件路径] — [具体变更]
2. [文件路径] — [具体变更]
...

## 影响范围
- 修改: [文件列表]
- 新增: [文件列表]（如有）
- 测试: [需要更新/新增的测试]
```

使用 `write-artifact` 写入 `plan.md`。写入前按实体、版本、依赖方向和排除项逐字段核对 authoritative spec。

随后使用 `checkpoint` 更新为 `4-plan`，`gate` 设为 `user_approval_required`，下一动作设为“等待用户审批计划”。

**⛔⛔⛔ HARD STOP — 你必须在这里停下来，向用户展示以下选项并等待回复。不可跳过，不可默认选择。⛔⛔⛔**

你现在必须输出以下内容（原样输出，不是代码块示例）：

---
⛔ **计划审批 + 执行模式选择**

请审批以上计划，并选择谁来写代码：

1. **Claude 自己写** — 精细控制，逐步实施
2. **backend / frontend 模型** — 用户明确选择的外部模型写代码

请回复 1 或 2（或直接说"你来写"/"用codex"等）。
---

**在用户回复之前，你不可以执行任何文件写入操作。** 违反 = 流程失控。

用户确认后，使用 `checkpoint` 将 `gate` 设为 `null`，阶段更新为 `5-implement`，并记录用户选择的执行模式。

### Phase 5: 实施

根据用户选择的执行模式：

#### 模式 A: Claude 自己写（用户选 [1]）

1. 严格按计划执行
2. 遵循项目现有代码规范
3. 每完成一个主要步骤，简要报告进度
4. 遇到计划外的问题时告知用户，不自行扩大范围

#### 模式 B: 外部模型实施（用户选 [2]）

Claude 作为编排者，调用当前 backend 模型写代码。backend 为 `claude` 时使用 Agent Teams，不启动 wrapper。

**Step 1**: 从 plan.md 按文件归属拆分子任务：

- **Layer 1** — 无依赖的任务（底层模块：model/util/store）
- **Layer 2** — 依赖 Layer 1 的任务（上层：route/middleware/component）
- 每个子任务标注：active task ID、task revision、文件范围、实施步骤、验收标准和验证命令
- 每个派发声明注入的精确 spec section 与 requirements.md 优先；缺失上下文、revision 不一致或内容冲突时停止并报告

**Step 2**: 生成并行任务配置，调用 codeagent-wrapper `--parallel` 模式：

```
Bash({
  command: "~/.claude/bin/codeagent-wrapper {{LITE_MODE_FLAG}}--progress --parallel --backend {{BACKEND_PRIMARY}} - \"$WORKDIR\" <<'PARALLEL_EOF'\n---TASK---\nid: layer1-{name1}\nworkdir: $WORKDIR\n---CONTENT---\nROLE_FILE: ~/.claude/.ccg/prompts/{{BACKEND_PRIMARY}}/builder.md\n<TASK>\n## Active task\nID: {task-id}\nRevision: {task-revision}\n\n## Authority\n注入的精确 spec section 和 requirements.md 高于本派发摘要；缺失上下文、revision 不一致或内容冲突时停止并报告。不得修改 `.ccg/`。\n\n## 文件范围（⛔ 只改这些文件）\n{file1, file2}\n\n## 实施步骤\n{steps from plan.md}\n</TASK>\n---TASK---\nid: layer1-{name2}\nworkdir: $WORKDIR\n---CONTENT---\nROLE_FILE: ~/.claude/.ccg/prompts/{{BACKEND_PRIMARY}}/builder.md\n<TASK>\n## Active task\nID: {task-id}\nRevision: {task-revision}\n\n## Authority\n注入的精确 spec section 和 requirements.md 高于本派发摘要；缺失上下文、revision 不一致或内容冲突时停止并报告。不得修改 `.ccg/`。\n\n## 文件范围\n{file3, file4}\n\n## 实施步骤\n{steps}\n</TASK>\n---TASK---\nid: layer2-{name3}\nworkdir: $WORKDIR\ndependencies: layer1-{name1},layer1-{name2}\n---CONTENT---\nROLE_FILE: ~/.claude/.ccg/prompts/{{BACKEND_PRIMARY}}/builder.md\n<TASK>\n## Active task\nID: {task-id}\nRevision: {task-revision}\n\n## Authority\n注入的精确 spec section 和 requirements.md 高于本派发摘要；缺失上下文、revision 不一致或内容冲突时停止并报告。不得修改 `.ccg/`。\n\n## 文件范围\n{file5}\n\n## 实施步骤\n{steps}\n</TASK>\nPARALLEL_EOF",
  run_in_background: true,
  timeout: 3600000,
  description: "Parallel Builder: {task count} 个子任务"
})
```

**也可以用 Codex 原生 spawn 模式**（显式启用 Codex 主导模式时使用已安装的 `ccg-*` Agent 角色）：

- 发送编排指令让 Codex 读 AGENTS.md 的 §5 "Parallel Spawn" 模式
- Codex 自行 spawn ccg-implement 子代理并行写

**Step 3**: 等待完成，读取汇总报告

**Step 4**: Lead 收集 `git diff`、完整相关文件和 plan 验收标准，作为独立 Claude Code 审查 Agent 的输入，不在此步骤自行审查或修复

**降级**：外部模型失败/超时 → 切换到模式 A

实施开始时使用 `checkpoint` 保持阶段为 `5-implement`，下一动作写成当前实际实施步骤。子 Agent 或外部模型不得修改 `.ccg/`。

### Phase 6: 迭代审查 [Ralph Loop]

1. `git diff` 展示所有变更
2. 运行测试（如果有）

参考 `phase-guide.md § 9 Ralph Loop` 执行迭代审查（变更 >30 行时，最多 3 轮）。

#### Round N 流程

**⛔ 审查线程：**

3. 创建独立 Claude Code 审查 Agent，使用完整 diff、相关文件和验收标准检查正确性、安全、回归与测试缺口，不调用 codeagent-wrapper 或外部 CLI
4. 只有用户明确请求 GPT、Grok、双模型审查或 `/ccg:spec-review` 时，才启动对应外部 review profile。外部 reviewer 使用 `--no-session-persistence`，不使用 `resume` 或 `SESSION_ID`。Lead 汇总并确认 finding

**⛔ 质量关卡（必须逐个调用 Skill，不可跳过）：**

5. 调用 Skill `ccg:verify-quality` — 等待报告
6. 调用 Skill `ccg:verify-security` — 等待报告（涉及 auth/input/crypto 时）
7. 调用 Skill `ccg:verify-change` — 等待报告

**用户决定（⛔ 必须等待）：**

- 有 Critical → `发现 N 个 Critical 问题。修复后再审一轮？[Y/n]`
- 无 Critical → `审查通过。需要再审一轮？[y/N]`
- 用户选择继续 → 修复 Critical 后回到 Round N+1
- 用户选择停止 → 退出审查循环

每轮修复与审查结果写入 `review.md`，使用 `write-artifact` 登记，并通过 `checkpoint` 更新 progress。

8. 检查是否满足验收标准
9. 输出结果：
   ```
   ✅ 开发完成
     变更: [N] 文件，[M] 行
     实现: [摘要]
     测试: [通过/跳过/失败情况]
     审查: [N] 轮，[Critical: N, Warning: N, Info: N]
     📍 Next: 可以用 /ccg:commit 提交
   ```

#### Spec Evolution 与完成

按 `phase-guide.md § 7` 检查是否需要更新项目已有的 tracked 文档或 OpenSpec，并用 `set-spec-evolution` 记录 `applied`、`skipped` 或 `not_applicable`。

验收、测试和审查完成且 Gate 为 `null` 后，使用 `finish` 标记任务为 `completed`。任务目录保持原路径，不移动、不提交 `.ccg/`。

---

## 升级规则

- 发现涉及 5+ 文件或需要跨模块协调 → 升级到 `full-collaborate`
- 发现涉及架构级变更 → 升级到 `full-collaborate`
- 外部模型分析发现重大风险 → 升级到 `full-collaborate`

---

## 铁律

- **Phase 4 计划必须用户确认** — HARD STOP，不可自动跳过
- **执行权限跟随已审批模式** — 模式 A 由 Claude 修改；模式 B 的 Builder 只修改分配给它的文件
- **不扩大范围** — 只做计划内的变更，计划外的报告但不自行处理
- **增量实施** — 多文件变更时逐文件执行，便于追踪
