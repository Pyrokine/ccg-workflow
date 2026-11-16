# Strategy: Guided Develop — 引导式开发

适用于中等复杂度的功能开发，由主会话完成调查、规划和实施，按需要委派独立工作

## 适用条件

- 复杂度 M，通常为 2 至 5 个文件、单个模块
- 需要规划实施步骤与验收条件
- 风险 low 或 medium

## 工作流状态机

`[phase-state:1-requirements]` 当前阶段：明确需求 Next: 读取相关代码与规范 `[/phase-state:1-requirements]`

`[phase-state:2-context]` 当前阶段：上下文检索 Gate: 需求明确 Next: 分析当前实现和依赖 `[/phase-state:2-context]`

`[phase-state:3-analysis]` 当前阶段：领域分析 Gate: 上下文已收集 Next: 形成实施方案 `[/phase-state:3-analysis]`

`[phase-state:4-plan]` 当前阶段：规划 Gate: 分析已完成 Next: 审批必要的新方案，复用已有相同方案的批准
`[/phase-state:4-plan]`

`[phase-state:5-implement]` 当前阶段：实施 Gate: 方案已获授权 Next: 完整功能完成后集中验收 `[/phase-state:5-implement]`

`[phase-state:6-verify]` 当前阶段：验证 Gate: 实施已完成 Next: 满足验收条件后交付 `[/phase-state:6-verify]`

## 阶段详情

### Phase 1: 明确需求 `[required]`

根据用户请求核对目标、约束、范围和验收标准，已有信息足够时直接继续；只有影响方案或授权的缺失信息才需要用户决定

使用 `update-requirements` 保存当前有效合同，再用 `checkpoint` 记录 `1-requirements`

### Phase 2: 上下文检索 `[required]`

读取目标、直接调用者、项目规范和已有测试，沿实际调用关系确定影响范围，逐字段核对 requirements 和精确 spec，记录 `2-context`

### Phase 3: 领域分析 `[required]`

默认由主会话分析，不按复杂度或文件数强制启动 Agent；独立调查、材料隔离或用户明确要求使委派有收益时，按 `phase-guide.md § 6`
安排，再读取 `~/.claude/.ccg/engine/model-router.md`

前端视角只用于实际涉及界面、布局或交互的工作；用户已将 primary route 明确配置为外部模型时，按模型路由选择对应工具

外部结果返回后重新 `resolve` 并消费当前契约；必要的分析用 `write-artifact` 写入 `analysis.md`，记录 `3-analysis`

### Phase 4: 规划 `[required]`

计划包含选定方案、按文件分组的步骤、行为及接口影响、必要测试与验收标准；写入前核对实体、版本、依赖方向和排除项，再用
`write-artifact` 保存 `plan.md`

复杂方案、公共接口变化或存在未决选择时，展示计划，记录 `4-plan`，设置 `gate: user_approval_required` 并等待确认（HARD STOP）

已有相同方案的批准且范围、约束未变时复用批准；方案明确且已获授权时直接继续，无需重新询问执行者选择

批准后使用 `checkpoint` 清除 Gate 并进入 `5-implement`，默认由主会话实施

### Phase 5: 实施

按已授权计划完成当前功能，连续修复范围内已确认的问题；需要新范围或权限时说明具体影响并等待决定

用户指定外部实施或存在适合独立委派的文件组时，按 § 6 限定写范围、总量、深度、预算和停止条件，使用模型路由已有调用模板；Builder
接收完整当前 requirements 和精确 spec，保持叶子角色并保留 `.ccg/` 的主会话所有权

Workflow 使用宿主实际 schema 传递要求，Agent prompt 注入规则按其工具范围应用；外部调用失败或超时时保留实际结果，主会话在原授权内继续可独立完成的工作

使用 `checkpoint` 维护 `5-implement` 的实际下一动作

### Phase 6: 集中验收与审查 `[Ralph Loop]`

1. 完整功能完成后，按 `phase-guide.md § 9` 合并适用质量关卡、相关测试和审查，实施期间保留必要的定向复现检查
2. 复用候选、输入、工具链、参数、配置和覆盖仍适用的结果，修复后只复验受影响部分
3. 独立检查继续完成，失败、超时和未完成分别记录，未取得的证据保留未验证状态
4. 审读完整变更及调用链，核实审查发现；独立审查有实际收益或用户要求时才委派，用户明确请求外部审查时按 model-router 调用对应
   profile
5. 当前授权范围内的 confirmed finding 连续修复，复审针对真实变化或风险；达到验收标准后结束
6. 使用 `write-artifact` 保存 `review.md`，用 `checkpoint` 更新结果，交付功能变化及实际验证状态

## Spec Evolution 与完成

按 `phase-guide.md § 7` 记录规范演进，验收条件满足且 Gate 为 `null` 后调用 `finish`，有 `resumedTaskId` 时按 § 10
重新读取并继续父任务

## 升级规则

涉及跨模块协调、架构级变化或重大风险时评估 `full-collaborate`，保持已有批准有效；需要新方案或授权时再等待用户决定，策略变更沿控制器现有入口处理

## 执行约束

- 必要的计划审批保留，已有相同方案的批准复用
- 默认由主会话实施，委派遵守独立范围和权限
- 整批实施完成后集中验收，修复只复验影响项
