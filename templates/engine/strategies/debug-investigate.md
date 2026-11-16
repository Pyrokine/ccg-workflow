# Strategy: Debug Investigate — 深度调试

适用于原因尚未明确的复杂错误，由主会话沿源码、错误栈和复现路径调查

## 适用条件

- 复杂度 M 或以上
- 错误原因需要调查
- 需要保留诊断、修复及验证证据

需要独立诊断或用户明确请求多模型时，再读取 `~/.claude/.ccg/engine/model-router.md`，按实际收益和授权委派

## 工作流状态机

`[phase-state:1-collect]` 当前阶段：信息收集 Next: 沿错误和源码调查 `[/phase-state:1-collect]`

`[phase-state:2-diagnose]` 当前阶段：诊断 Gate: 错误信息已收集 Next: 取得可核实的诊断证据 `[/phase-state:2-diagnose]`

`[phase-state:3-validate]` 当前阶段：验证诊断 Gate: 已有诊断证据 Next: 核对修复方向和授权 `[/phase-state:3-validate]`

`[phase-state:4-confirm]` 当前阶段：核对修复授权 Gate: 诊断已核实 Next:
已授权且方案明确时直接修复，需要新决定时等待确认 `[/phase-state:4-confirm]`

`[phase-state:5-fix]` 当前阶段：修复与验证 Gate: 方案和授权明确 Next: 完成修复后集中验收 `[/phase-state:5-fix]`

## 阶段详情

### Phase 1: 信息收集 `[required]`

使用 `checkpoint` 记录 `1-collect`，将当前有效的复现条件、错误现象和约束通过 `update-requirements` 写入任务契约

读取错误消息、堆栈、复现输入、相关环境和近期变更；按实际文件、函数和调用关系调查，复用已有有效证据

### Phase 2: 诊断 `[required]`

主会话默认直接调查，比较源码行为与实际现象；必要时执行定向复现以区分候选原因

独立诊断有明确收益或用户指定协作时，按 `phase-guide.md § 6` 限定问题、文件范围、预算和停止条件，再使用模型路由

外部结果成功或失败返回后，重新 `resolve` 并核对当前 requirements、精确 spec 和 revision；诊断与证据使用 `write-artifact` 写入
`analysis.md`，记录 `2-diagnose`

### Phase 3: 验证诊断 `[required]`

1. 回到当前源码、输入或日志验证每个诊断，记录支持证据、反例和仍未解决的问题
2. 对候选修复比较行为、接口、数据及权限影响，模型之间的共识仍需实际证据
3. 更新 `analysis.md`，使用 `checkpoint` 记录 `3-validate`

### Phase 4: 核对修复授权 `[required]`

证据明确、修复方向唯一且属于已有授权时，记录依据，将 Gate 保持为 `null`，直接进入 `5-fix`

存在授权缺口、高风险操作或会改变结果的未决选择时，展示具体方案与影响，使用 `checkpoint` 记录 `4-confirm`，设置
`gate: user_approval_required` 并等待用户决定（HARD STOP）

用户确认后记录所选方案并清除 Gate；已有相同方案的批准直接复用

### Phase 5: 修复与集中验证

1. 应用证据支持的修复，搜索并处理当前范围内同类问题
2. 保留复现所需的定向检查，修复完整功能后按 `phase-guide.md § 9` 集中验收
3. 复用候选、输入、工具链、参数、配置和覆盖仍适用的结果，修复后只复验影响项
4. 独立检查继续完成，失败、超时和未完成状态分别保留
5. 修复无效时检查实际错误，调整有证据支持的方向；需要恢复时只恢复本次已识别的变更并保留其他工作，需要新决定时返回 Phase 4
6. 报告已确认的原因、功能变化及实际验证结果

## Spec Evolution 与完成

按 `phase-guide.md § 7` 处理规范演进；验收标准满足且 Gate 为 `null` 后调用 `finish`，有 `resumedTaskId` 时按 § 10
重新读取并继续父任务

## 执行约束

- 诊断以当前源码、输入和实际输出为依据
- 已授权的明确修复连续执行，需要新授权或方案决定时等待确认
- 委派按实际收益安排，默认由主会话调查和实施
