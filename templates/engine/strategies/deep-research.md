# Strategy: Deep Research — 深度研究

适用于研究、事实查询、方案比较和可行性分析，默认由主会话直接检索与判断

## 适用条件

- 用户要求研究、分析或对比
- 研究范围内以只读方式取得证据
- 任何复杂度；普通事实查询无需持久任务

简单问题直接回答，保持当前任务和绑定不变；需要跨阶段保存证据或恢复长任务时，按 `/ccg:go` 创建持久任务，再使用本文件的状态控制器步骤

## 工作流状态机

`[phase-state:1-clarify]` 当前阶段：明确研究问题 Next: 直接检索回答所需的证据 `[/phase-state:1-clarify]`

`[phase-state:2-explore]` 当前阶段：检索与分析 Gate: 研究问题明确 Next: 根据证据形成判断 `[/phase-state:2-explore]`

`[phase-state:3-synthesize]` 当前阶段：综合分析 Gate: 已取得相关证据 Next:
交付结论、依据和必要限制 `[/phase-state:3-synthesize]`

`[phase-state:4-discuss]` 当前阶段：交付与后续讨论 Next: 回答完成即结束本次研究 `[/phase-state:4-discuss]`

## 阶段详情

### Phase 1: 明确问题 `[required]`

识别用户要判断的问题、用途和约束；上下文已有答案时直接使用，只有缺失信息会改变结果时才请求决定

持久任务使用 `update-requirements` 保存当前有效的研究要求，并用 `checkpoint` 记录 `1-clarify`；即时查询直接继续，无需创建研究文件

### Phase 2: 检索与分析 `[required]`

由主会话使用已有搜索、Read 或领域工具获取直接相关证据，核对原始来源中的实体、版本、数值和单位

独立调查有明确收益、材料量需要隔离或用户指定多模型时，再读取 `~/.claude/.ccg/engine/model-router.md`，按
`phase-guide.md § 6` 限定范围与预算；实际涉及前端问题时才安排前端视角

只读规划优先由主会话检索；Agent 名称或 `research` 标记保持原有绑定与权限检查，Workflow 按宿主实际 schema 传递当前要求

持久任务记录 `2-explore`；委派返回后重新 `resolve`，读取当前契约、精确 spec 和下一动作再消费结果

### Phase 3: 综合分析

给出直接回答或首选方案，用证据解释决定性差异；方案比较只列实际有用的选项，未知事实写明对判断的影响

简单查询使用合适长度的自然语言，无需固定表格或两个分析角色；持久任务使用现有 `write-artifact` 保存必要证据并记录
`3-synthesize`

### Phase 4: 交付与后续讨论

研究问题回答完整即交付，无需等待用户表示满意；用户后续追问沿当前主题处理，要求实施或 POC 时重新判断实际授权

持久任务记录 `4-discuss`，按 `phase-guide.md § 7` 记录规范演进，然后调用 `finish`；有 `resumedTaskId` 时按 § 10
重新读取父任务的当前要求和下一动作

## 执行约束

- 普通事实查询由主会话直接处理，保持当前任务
- 长研究按实际恢复需要维护任务记录，requirements 保存当前合同，历史调查使用已有 research artifact
- 根据证据作出判断，实施遵循用户给予的权限
