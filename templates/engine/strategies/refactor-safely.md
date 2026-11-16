# Strategy: Refactor Safely — 安全重构

适用于结构、职责和命名调整，保持已约定的行为与接口，由主会话默认实施

## 适用条件

- 复杂度 M 或以上
- 用户要求重构、整理或简化
- 需要可核实的行为基线和验收证据

## 工作流状态机

`[phase-state:1-understand]` 当前阶段：理解现有代码 Next: 映射依赖与不变量 `[/phase-state:1-understand]`

`[phase-state:2-baseline]` 当前阶段：建立基线 Gate: 代码已理解 Next: 使用有效证据确定基线 `[/phase-state:2-baseline]`

`[phase-state:3-plan]` 当前阶段：规划重构 Gate: 基线已记录 Next: 必要审批后实施，复用已有批准 `[/phase-state:3-plan]`

`[phase-state:4-execute]` 当前阶段：实施 Gate: 方案已获授权 Next: 完成功能阶段后集中验收 `[/phase-state:4-execute]`

`[phase-state:5-verify]` 当前阶段：验证 Gate: 重构已完成 Next: 对比基线并交付结果 `[/phase-state:5-verify]`

## 阶段详情

### Phase 1: 理解 `[required]`

阅读涉及模块、直接调用者和测试，核对 requirements 与精确 spec 中的不变量、公共接口和数据约束，使用 `checkpoint` 记录
`1-understand`

### Phase 2: 建立基线 `[required]`

已有候选、输入、工具链、参数、配置和覆盖均适用的结果时直接复用；缺少基线时执行相关定向测试，保留既有失败和未覆盖状态

没有相关测试时说明行为保证缺少的证据，按风险和验收要求增加必要检查；用 `checkpoint` 记录基线及 `2-baseline`

### Phase 3: 规划

计划按行为和依赖组织实施步骤，列出不变量、接口影响及对应验证；使用 `write-artifact` 保存 `plan.md`

复杂方案、公共接口变化或未决选择需要审批，设置 `gate: user_approval_required` 并等待确认；已有相同方案批准且约束未变时直接复用，保持
Gate 为 `null`，进入 `4-execute`

独立架构审查有具体收益或用户要求时，再读取 `~/.claude/.ccg/engine/model-router.md`；用户明确请求外部审查时才调用对应
profile

### Phase 4: 实施

按依赖顺序完成已授权重构，通过 `checkpoint` 维护实际下一动作；默认由主会话执行，独立委派遵守 `phase-guide.md § 6`

同一功能阶段完成后集中验收；为区分行为变化或复现失败所需的定向检查保留，无需为每个编辑重复完整测试

定向检查失败时读取实际错误，修复影响范围内的问题，再继续相关实施；其他独立工作继续完成，需要恢复时保留其他所有者的修改

### Phase 5: 集中验收与审查 `[Ralph Loop]`

1. 按验收标准与基线比较重构结果，按 `phase-guide.md § 9` 合并适用质量关卡和必要测试
2. 复用候选、输入、工具链、参数、配置和覆盖仍适用的证据，修复后只复验受影响部分
3. 独立检查继续完成，失败、超时和未完成分别记录
4. 阅读完整变更和直接调用链，独立审查按实际收益或用户要求安排，复审针对真实变化与风险
5. 在当前授权范围内连续修复已确认问题，验收条件满足后结束
6. 使用 `write-artifact` 保存 `review.md`，通过 `checkpoint` 记录基线差异、修复和实际验证结果

## Spec Evolution 与完成

按 `phase-guide.md § 7` 记录规范演进，验收条件满足且 Gate 为 `null` 后调用 `finish`，有 `resumedTaskId` 时按 § 10
重新读取并继续父任务

## 执行约束

- 保持约定行为和公共接口，行为变化按用户授权处理
- 计划和基线使用现有有效证据，复杂新方案保留必要审批
- 整批完成后集中验收，必要的定向检查保留
