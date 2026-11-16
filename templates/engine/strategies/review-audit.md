# Strategy: Review Audit — 代码审查

适用于代码或设计审查，默认由主会话阅读源码并判断，独立复核按实际收益或用户要求安排

## 适用条件

- 用户请求代码审查
- 任何复杂度
- 按用户指定范围或当前 Git 差异取得审查输入

## 工作流状态机

`[phase-state:1-scope]` 当前阶段：确定审查范围 Next: 读取差异和完整相关文件 `[/phase-state:1-scope]`

`[phase-state:2-review]` 当前阶段：审查 Gate: 范围已确定 Next: 核实发现和适用检查 `[/phase-state:2-review]`

`[phase-state:3-report]` 当前阶段：综合报告 Gate: 审查已完成 Next: 交付发现及实际覆盖 `[/phase-state:3-report]`

## 阶段详情

### Phase 1: 确定审查范围 `[required]`

优先使用用户指定文件、提交或模块；未指定时读取 `git diff HEAD`，无差异时读取 `git diff HEAD~1`，仍无范围时请求用户选择

读取变更涉及的完整函数、直接调用者、测试和规范，用 `checkpoint` 记录 `1-scope`；精确 spec 作为验收要求，requirements 保留当前有效合同

### Phase 2: 审查 `[required]`

默认由主会话检查正确性、安全、回归和测试缺项，逐条用当前源码与调用链核实发现

高风险问题需要独立验证、独立范围确有收益或用户明确要求时，按 `phase-guide.md § 6` 派发有界只读审查；委派名称保持原权限和会话绑定检查

用户明确请求 GPT、Grok、双模型审查或 `/ccg:spec-review` 时，加载对应路由：

```text
Read("~/.claude/.ccg/engine/model-router.md")
```

使用对应 `review.profiles`，外部 reviewer 使用 `--no-session-persistence`，传入完整当前上下文，保持独立审查；失败或超时保留实际结果

外部结果返回后重新 `resolve`，核对当前 requirements、精确 spec 和 revision，记录 `2-review`

### Phase 3: 集中检查与报告

1. 按 `phase-guide.md § 9` 汇总适用质量关卡，与当前候选已有的有效测试和检查证据合并
2. 复用候选、输入、工具链、参数、配置和覆盖仍适用的结果；独立检查继续完成，失败和未完成状态分别保留
3. 合并去重已核实发现，每条给出严重度、位置、实际行为、影响和修复建议，区分 confirmed finding 与待验证判断
4. 使用 `write-artifact` 保存 `review.md`，通过 `checkpoint` 记录 `3-report` 和实际覆盖
5. 只读审查交付报告后结束；用户已授权修复时连续处理范围内已确认问题，修复后只复验影响项，复审按真实变化和风险安排

报告按 Critical／High、Warning、Info 分级；Critical 或 High 明确写出阻断原因，无发现时说明审查范围和未验证项

需要新增修复授权时说明具体方案与影响，等待用户决定；明确插入且无冲突的修复任务按 `/ccg:go` 使用 `interrupt`

## Spec Evolution 与完成

按 `phase-guide.md § 7` 记录规范演进；审查报告交付后调用 `finish`，有 `resumedTaskId` 时按 § 10 重新读取并继续父任务

## 执行约束

- 根据当前源码和调用链确认发现，报告真实覆盖
- 只读审查保持只读，已有修复授权按范围持续执行
- 主会话默认审查，独立复核与外部调用按实际需要安排
