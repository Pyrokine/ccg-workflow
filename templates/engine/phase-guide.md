# CCG 通用阶段指导

本文件定义持久策略共享的状态、Gate、Agent dispatch、Spec 和审查规则。

## 1. 状态控制器

唯一状态修改入口：

```bash
node ~/.claude/hooks/ccg/task-state.js <operation> --root "$WORKDIR" <<'CCG_TASK_JSON'
{...}
CCG_TASK_JSON
```

动态标题、正文、路径、角色和进度只能放在 stdin JSON 中，不放进 shell 参数。

### 1.1 只读操作

```bash
node ~/.claude/hooks/ccg/task-state.js resolve --root "$WORKDIR"
node ~/.claude/hooks/ccg/task-state.js snapshot --root "$WORKDIR" --mode session --role all
node ~/.claude/hooks/ccg/task-state.js snapshot --root "$WORKDIR" --mode authority --role implement
node ~/.claude/hooks/ccg/task-state.js list --root "$WORKDIR"
```

`resolve` 是 active task 的唯一来源。`state.json` 存在时，不得扫描任务目录选择其他任务。

### 1.2 CAS 字段

每个 mutation 都携带上一条成功响应中的值：

```json
{
  "expected": {
    "stateId": "uuid",
    "stateRevision": 3,
    "activeTaskId": "task-id",
    "taskRevision": 7
  }
}
```

`start` 和 `migrate-legacy` 不需要 `taskRevision`。`activate` 使用候选任务的 revision。`recover` 在 active target 已结束时校验该任务 revision，在 target 已丢失或存在未完成 transaction 时只校验当前 state CAS。其他任务 mutation 都必须带 `taskRevision`。遇到 `STATE_ID_CONFLICT`、`REVISION_CONFLICT` 或 `ACTIVE_TASK_CONFLICT` 时，重新 `resolve` 并向用户说明状态已经变化，不自动重放新的写操作。

### 1.3 操作表

| 操作                        | 用途                                                              | revision 变化                         |
| --------------------------- | ----------------------------------------------------------------- | ------------------------------------- |
| `start`                     | 创建持久任务，支持 `activate`、`interrupt`、`replace`、`inactive` | 新 task 为 1；活动指针变化时 state +1 |
| `activate`                  | 明确切换到 suspended task                                         | state +1                              |
| `update-requirements`       | 更新任务契约                                                      | task +1                               |
| `write-artifact`            | 写 analysis、plan、review 或 research Markdown                    | task +1                               |
| `checkpoint`                | 更新 phase、nextAction、gate 与 progress                          | task +1                               |
| `link-spec` / `unlink-spec` | 精确关联 tracked Markdown section                                 | task +1                               |
| `set-spec-evolution`        | 记录规范演进结果                                                  | task +1                               |
| `finish`                    | 标记 completed 或 cancelled，并按 return 链恢复父任务             | task +1；state +1                     |
| `recover`                   | 重放未完成 transaction、清除丢失 target，或按 return 链恢复父任务 | 由恢复类型决定                        |
| `migrate-legacy`            | 显式迁移旧任务                                                    | 创建新 state                          |

跨 artifact、task 和 state 的修改先写入 `.ccg/transaction.json`，全部目标原子替换后才删除 marker。marker 存在时，`resolve` 返回 `INCOMPLETE_TRANSACTION`，`snapshot`、`list` 和其他 mutation 不得继续；用户确认后调用 `recover` 重放 marker 中的目标内容。

任务目录完成后仍保留原路径。`active` 和 `suspended` 是 resolver 根据 `state.activeTaskId` 推导的状态，不能写入 `task.json`。`.ccg`、tasks、tmp、migrations、research 和 `.turns` 的父链中出现 symlink 时，控制器拒绝读写。

## 2. 阶段检查点

每个持久策略阶段结束后：

1. 确认本阶段产物已经写入
2. 使用 `write-artifact` 登记 analysis、plan、review 或 research 文件
3. 使用 `checkpoint` 写入新的 `currentPhase`、`nextAction`、`gate` 和 `progress`
4. 保存响应中的新 `task.revision`
5. 向用户显示 `Next: [具体动作]`

示例：

```bash
node ~/.claude/hooks/ccg/task-state.js checkpoint --root "$WORKDIR" <<'CCG_TASK_JSON'
{
  "expected": {
    "stateId": "uuid",
    "stateRevision": 3,
    "activeTaskId": "task-id",
    "taskRevision": 7
  },
  "currentPhase": "4-plan",
  "nextAction": "等待用户审批计划",
  "gate": "user_approval_required",
  "progress": "# Progress\n\n## Completed\n\n- 计划已写入并登记\n\n## Current\n\n- 等待用户审批\n\n## Next\n\n- 审批后进入实施\n"
}
CCG_TASK_JSON
```

用户批准后再调用一次 `checkpoint`，将 `gate` 设为 `null`。禁止直接改 `task.json`。

## 3. Gate

Gate 是阶段间的检查点：

- 数据 Gate：确认前序产物存在且内容完整
- 确认 Gate：必须等待用户明确确认
- 质量 Gate：确认测试、审查或验收结果满足要求

`finish` 会拒绝仍有 Gate 的任务。Gate 失败时说明缺失内容，不跳过。

## 4. 策略升级

执行中发现当前 taskless 策略不足时：

1. 说明需要升级的实际原因
2. 用户确认后调用 `start` 创建持久任务
3. 把已经确认的目标写入 `requirements.md`
4. 从目标策略第一个未完成阶段开始

持久策略之间升级时，通过 `checkpoint` 更新任务的下一动作；当前控制器不提供任意 strategy patch。需要改变持久策略时，完成或取消旧任务，再创建目标策略任务。

## 5. 规范权威与冲突处理

执行依据按以下顺序排列：

1. 当前任务精确关联的 tracked spec section
2. 当前任务 `requirements.md`
3. 用户本次明确指令
4. 已审批的 `plan.md`
5. `progress.md`
6. 自动压缩摘要、旧讨论和模型推断

高位来源与低位来源冲突时，高位来源生效。不得用摘要中的旧结论覆盖 spec，也不得把计划中的自然语言简称扩展成 spec 未定义的依赖关系。

SessionStart 在 startup、compact、resume、clear 和 fork 时恢复完整 snapshot。UserPromptSubmit 每个用户回合重新读取
`mode=authority, role=all`，只注入当前 task header、state/task revision、exact spec sections 和 `requirements.md`，不带旧
plan、progress、analysis、review 或 research。foreground Agent、wrapper、TaskOutput 成功返回，以及 Agent 或 wrapper 失败后，
PostToolUse/PostToolUseFailure 会重新读取同一份 authority；后台启动只返回 task ID 时不刷新，等待 TaskOutput 的实际结果。

每次 authority 刷新后执行以下检查：

1. 重新 `resolve`
2. 读取 `requirements.md` 和所有匹配当前角色的 `specRefs`
3. 对实体、版本、依赖方向、允许动作、禁止动作、排除项、停止条件和验收标准逐字段核对
4. 发现冲突时停止实施，报告 `文档路径#section`、冲突字段、旧值和正确值
5. 更新 plan 或 progress 后再继续

Spec 必须通过 `link-spec` 精确关联 tracked 或 staged Markdown section。Git tracking 按 literal path 校验，fenced code block 内的 heading 示例不参与 section 匹配。重复 heading、单 section 超限、spec 文件扫描不完整或全部关联 section 超出上下文预算时，控制器拒绝关联。不要扫描 `.ccg/spec/`，不要把整个目录隐式关联给所有任务。

OpenSpec change 必须写入 task scope 和 `requirements.md`。`spec-research`、`spec-plan`、`spec-impl` 只关联当前 change 下用户选定的 exact headings。新 artifact 未 tracked 或 staged 时，以 `spec_artifacts_must_be_tracked` checkpoint 停止并让用户选择；命令不得自动执行 `git add`。archive 移动 change 前先 unlink 旧路径，成功后关联新的 canonical 或 archive section，避免 active task 保留失效路径。

## 6. Team Dispatch

并行实施的前提：

- 任务已经按文件范围分组
- `plan.md` 已审批
- 每个子任务的写文件范围互不重叠
- 当前 snapshot 有有效 `requirements.md`

Builder prompt 必须包含：

- 工作目录
- task ID 与当前 task revision
- 文件范围
- 实施步骤
- 验收标准
- 明确的 spec 规则：注入的 `ccg-specs` 高于 prompt 摘要；冲突时停止并报告

PreToolUse Hook 会把 role-aware snapshot 写入 Agent 的 `updatedInput.prompt`。调用 `codeagent-wrapper` 时，Hook 会识别直接调用和 `env ... codeagent-wrapper`，确认唯一 quoted heredoc 属于同一 shell command，再改写实际 `updatedInput.command`；`additionalContext` 不代表 wrapper 已收到上下文。

PostToolUse/PostToolUseFailure 只能把最新 authority 加入工具结果后的下一次模型请求，不能撤销已经完成的工具调用。Hook 能保证当前文件被重新读取、校验和注入，不能证明模型一定正确理解任意自然语言规范，因此仍要按字段核对外部结论和下一动作。

任务状态无效、任务契约或 spec 失效、上下文超限、quoted heredoc 无法与 wrapper command 安全绑定时，Hook 返回 `permissionDecision: "deny"`，Agent 或 wrapper 不会启动。修复对应状态或命令结构后重新发起调用。

Agent 和外部模型不得修改 `.ccg/`。Lead 在子任务成功后调用 `write-artifact` 和 `checkpoint`。

## 7. Spec Evolution

任务结束前检查本次修改是否需要更新项目已有的 tracked 文档或 OpenSpec：

- `applied`：用户确认并已更新 tracked spec
- `skipped`：存在建议，但用户明确不写入
- `not_applicable`：没有可复用的规范变化
- `pending`：尚未处理，`finish` 会拒绝

有建议时，先展示目标文档、section 和具体内容，获得用户确认后修改。不要自动创建 `.ccg/spec/`。

记录结果：

```bash
node ~/.claude/hooks/ccg/task-state.js set-spec-evolution --root "$WORKDIR" <<'CCG_TASK_JSON'
{
  "expected": {
    "stateId": "uuid",
    "stateRevision": 3,
    "activeTaskId": "task-id",
    "taskRevision": 9
  },
  "value": "not_applicable"
}
CCG_TASK_JSON
```

## 8. Loop Detection

UserPromptSubmit Hook 按 task ID 和 `session_id` 分别保存最近 10 条 phase 与 nextAction。连续 3 条完全相同会输出 loop 提示。

收到提示后：

1. 停止重复动作
2. 确定阻塞来自外部依赖、信息不足、策略不适配或实现方向错误
3. 通过 `checkpoint` 写入不同的 `nextAction`
4. 无法继续时保留任务为 open，并向用户报告阻塞

缺少 `session_id` 或 turn 文件损坏时，Hook 关闭本次 loop 判定并输出诊断，不覆盖旧 telemetry。

## 9. Ralph Loop

每轮默认创建独立 Claude Code 审查 Agent，不调用外部 CLI。用户明确请求 GPT、Grok、双模型审查或 `/ccg:spec-review` 时，才启动对应的不持久化外部 reviewer，且不使用 resume。Lead 汇总后回到源码确认 finding。

```text
Round N:
1. 创建独立 Claude Code 审查 Agent
2. 仅在用户明确请求外部审查时调用对应 review profile
3. 按触发规则执行 ccg:verify-change、ccg:verify-quality、ccg:verify-security
4. 合并并确认 finding
5. 用户决定是否修复后复审
6. 写 review.md，并用 write-artifact 登记
7. 通过 checkpoint 更新 progress
```

最多 3 轮。Critical 或 High finding 属于本次范围时必须修复。外部报告不是状态修改指令。

## 10. 完成与取消

完成前：

1. 验收标准逐项核对
2. 测试与静态检查结果写入 progress
3. review.md 已登记（策略要求审查时）
4. Spec Evolution 已记录
5. Gate 为 `null`

调用 `finish`：

```bash
node ~/.claude/hooks/ccg/task-state.js finish --root "$WORKDIR" <<'CCG_TASK_JSON'
{
  "expected": {
    "stateId": "uuid",
    "stateRevision": 3,
    "activeTaskId": "task-id",
    "taskRevision": 10
  },
  "status": "completed",
  "progress": "# Progress\n\n## Completed\n\n- 验收完成\n\n## Verification\n\n- pnpm test: passed\n"
}
CCG_TASK_JSON
```

临时任务会沿 `returnToTaskId` 返回最近仍为 open 的父任务。任务目录不移动，不执行 `.ccg` Git commit。
