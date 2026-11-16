# Strategy: Full Collaborate — 完整协作开发

适用于复杂功能和跨模块变更，由主会话负责整体方案、实施与验收，按独立工作收益安排协作

## 适用条件

- 复杂度 L 或 XL，跨模块、公共接口或架构级变更
- 风险 medium 或 high
- 需要完整的方案和验收记录

## 工作流状态机

`[phase-state:1-research]` 当前阶段：研究与分析 Next: 需求明确后分析实施选项 `[/phase-state:1-research]`

`[phase-state:2-ideation]` 当前阶段：方案分析 Gate: 目标和约束明确 Next: 根据证据选择方案 `[/phase-state:2-ideation]`

`[phase-state:3-planning]` 当前阶段：详细规划 Gate: 方案分析完成 Next:
必要的新方案审批后实施，复用已有批准 `[/phase-state:3-planning]`

`[phase-state:4-implementation]` 当前阶段：实施 Gate: 计划已获授权 Next:
整批实施完成后集中验收 `[/phase-state:4-implementation]`

`[phase-state:5-optimization]` 当前阶段：集中验收与审查 Gate: 实施已完成 Next:
修复已确认问题并复验影响项 `[/phase-state:5-optimization]`

`[phase-state:6-final]` 当前阶段：最终交付 Gate: 验收证据已汇总 Next: 满足验收条件后结束 `[/phase-state:6-final]`

## 阶段详情

### Phase 1: 研究与分析 `[required]`

核对用户目标、范围、约束和验收标准，读取现有实现、调用者及项目规范；信息缺失会改变结果或授权时再请求用户决定

使用 `update-requirements` 保存当前有效合同，历史调查使用已有 research 或 analysis artifact，使用 `checkpoint` 记录
`1-research`

### Phase 2: 方案分析 `[required]`

默认由主会话分析已有实现、可复用能力及必要变化，比较实际合理的方案，选择满足目标且维护成本合适的实现

独立调查、材料隔离、高风险复核或用户明确请求使协作有价值时，按 `phase-guide.md § 6` 限定工作后读取
`~/.claude/.ccg/engine/model-router.md`；实际涉及前端问题时再安排前端视角

外部模型返回后重新 `resolve`，按当前 requirements 和精确 spec 核对结论；使用 `write-artifact` 保存 `analysis.md`，记录
`2-ideation`

### Phase 3: 详细规划 `[required]`

计划包含文件分组、依赖方向、实施步骤、接口和数据影响、测试方法、验收标准与必要恢复路径；按实体、版本、依赖方向和排除项核对精确
spec，再用 `write-artifact` 保存 `plan.md`

复杂方案、公共接口变化、数据迁移或未决选择需要用户审批，记录 `3-planning`，设置 `gate: user_approval_required` 并等待明确确认（HARD
STOP）

已有相同方案的批准且范围、约束未变时直接复用；用户批准后清除 Gate，进入 `4-implementation`，默认由主会话实施，执行者选择无需另设审批

### Phase 4: 实施

按获准计划完成整批修改，连续处理同一授权范围内已确认的问题；阶段进度和下一动作通过 `checkpoint` 保存

主会话是默认执行者，文件数量或策略名称本身不要求创建 Team

#### 独立委派

有明确收益或用户指定协作时，按文件所有权安排互不重叠的子任务，遵守 `phase-guide.md § 6` 的总量、深度、预算、停止条件和返回格式

每个 Builder 接收工作目录、task ID、revision、完整当前 requirements、匹配角色的精确 spec、实施步骤及验收标准；Builder
只修改已分配文件并保持叶子角色，`.ccg/` 由主会话管理

需要持续协作时使用宿主可用的 Team 能力，独立有界工作可使用普通 Agent；用户指定外部实施时按 model-router 已有 wrapper
模板调用，backend 为 `claude` 时使用宿主能力

Workflow 按宿主实际 schema 传递当前要求与角色限制，返回后核对当前 authority，脚本保持原有输入合同

#### 等待与结果处理

等待宿主的完成通知或外部任务实际结果，使用既有活动任务，报告失败与超时；依据具体错误决定恢复动作，独立工作继续完成

主会话取得结果后阅读完整相关变更和调用者，修复范围内已核实的问题；涉及新目标、权限或并发写入冲突时再请求用户决定

### Phase 5: 集中验收与审查 `[required · Ralph Loop]`

使用 `checkpoint` 记录 `5-optimization`，下一动作写为当前验收或修复事项

1. 整批实施完成后按 `phase-guide.md § 9` 合并适用质量关卡、相关测试和审查，保留实施阶段必要的定向复现检查
2. 复用候选、输入、工具链、参数、配置和覆盖仍适用的结果；失败修复后只复验受影响部分
3. 独立检查继续执行，失败、超时和未完成状态分别保留，缺失覆盖明确写未验证
4. 主会话审读完整变更、调用链和验收要求；独立审查有具体收益或用户要求时才委派，用户明确请求 GPT、Grok、双模型审查或
   `/ccg:spec-review` 时按 model-router 调用外部 profile
5. 回到当前源码确认 finding，在已授权修复范围内连续处理；复审针对真实变化或风险，保留仍有效的其他证据
6. 需要改变方案或新增权限时请求用户决定；满足验收标准后结束，无固定轮次的继续询问

使用 `write-artifact` 保存 `review.md`，通过 `checkpoint` 记录发现、处理结果和未完成项

### Phase 6: 最终交付

使用 `checkpoint` 记录 `6-final`，对照原需求、获准计划及完整变更核对结果，直接使用 Phase 5 仍有效的验收证据

交付功能变化、决定性验证结果及影响使用的未验证项；必需的验收仍失败或缺失时报告具体限制，保留任务为 open

## Spec Evolution 与完成

按 `phase-guide.md § 7` 记录规范演进；验收满足且 Gate 为 `null` 后调用 `finish`，有 `resumedTaskId` 时按 § 10
重新读取父任务完整要求并按当前授权继续

## 执行约束

- 复杂方案保留必要审批，相同方案已有批准时复用
- 主会话默认实施，独立委派保持文件所有权、预算与叶子限制
- 完成整批修改后集中验收，范围内已确认的问题持续修复
