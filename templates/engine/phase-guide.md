# CCG 通用阶段指导

本文件定义持久策略共享的状态、Gate、Agent dispatch、Spec 和审查规则。

## 1. 状态控制器

唯一状态修改入口：

```bash
node ~/.claude/hooks/ccg/task-state.js <operation> --root "$WORKDIR" \
  --session-key "$CCG_SESSION_KEY" <<'CCG_TASK_JSON'
{...}
CCG_TASK_JSON
```

动态标题、正文、路径、角色和进度只能放在 stdin JSON 中，不放进 shell 参数。`CCG_SESSION_KEY` 由当前 Claude Code
session 的 `SessionStart` Hook 导出；所有 controller 调用都必须携带它。缺失或非法时停止，不得退回共享 active pointer。

SessionStart 连续使用相同的规范会话键时保持导出幂等，新键以追加方式保留其他 Hook 内容；CCG 使用环境文件旁的 `.ccg.lock`
序列化自身写入，锁文件只记录进程 PID；遇到 `CLAUDE_ENV_FILE_BUSY` 时，保留环境文件和锁，核实该次 `CLAUDE_ENV_FILE`
所对应锁的持有进程；持有进程已退出时，仅清理该 CCG 专用锁，再重新触发导出；`CLAUDE_ENV_FILE_LOCK_RELEASE_FAILED`
表示释放失败或锁身份变化，先核实文件归属

### 1.1 只读操作

```bash
node ~/.claude/hooks/ccg/task-state.js resolve --root "$WORKDIR" --session-key "$CCG_SESSION_KEY"
node ~/.claude/hooks/ccg/task-state.js snapshot --root "$WORKDIR" \
  --session-key "$CCG_SESSION_KEY" --mode session --role all
node ~/.claude/hooks/ccg/task-state.js snapshot --root "$WORKDIR" \
  --session-key "$CCG_SESSION_KEY" --mode authority --role implement
node ~/.claude/hooks/ccg/task-state.js list --root "$WORKDIR" --session-key "$CCG_SESSION_KEY"
```

`resolve` 是当前 session active task 的唯一来源。`.ccg/state.json` 只保存 worktree
state 身份与 revision，`.ccg/sessions/<opaque-key>.json`
保存当前 session 的 binding；不得扫描任务目录或其他 binding 选择任务。`list` 只显示 task 元数据、effective status 和
`claimed`，不返回其他 session key 或任务正文。

### 1.2 CAS 字段

每个 mutation 都携带上一条成功响应中的值：

```json
{
  "expected": {
    "stateId": "uuid",
    "stateRevision": 3,
    "bindingRevision": 1,
    "activeTaskId": "task-id",
    "taskRevision": 7
  }
}
```

每个 mutation 都校验 `stateId`、共享 `stateRevision`、当前 session 的 `bindingRevision` 和
`activeTaskId`。`start`、`migrate-state`、`migrate-legacy`、`quarantine-orphans` 和 `restore-orphans` 不需要
`taskRevision`；`activate` 与 `takeover` 使用候选任务 revision。`recover` 在 active
target 已结束时校验该任务 revision，在 target 已丢失或存在未完成 transaction 时不带 task
revision。其他任务 mutation 都必须带 `taskRevision`。遇到
`STATE_ID_CONFLICT`、`STATE_REVISION_CONFLICT`、`BINDING_REVISION_CONFLICT`、`ACTIVE_TASK_CONFLICT`、
`TASK_REVISION_CONFLICT`
或 `REVISION_CONFLICT` 时，重新 `resolve` 并向用户说明状态已经变化，不自动重放新的写操作。

### 1.3 操作表

| 操作                        | 用途                                                                  | revision 变化                                 |
| --------------------------- | --------------------------------------------------------------------- | --------------------------------------------- |
| `start`                     | 创建持久任务，支持 `activate`、`interrupt`、`replace`、`inactive`     | 新 task 为 1；state +1；认领时当前 binding +1 |
| `activate`                  | 当前 session 认领未被占用的 open task                                 | 当前 binding +1                               |
| `takeover`                  | 用户明确要求后把 task claim 转移到当前 session                        | 被释放和当前 binding 各自 +1                  |
| `update-requirements`       | 更新任务契约                                                          | task +1                                       |
| `write-artifact`            | 写 analysis、plan、review 或 research Markdown                        | task +1                                       |
| `checkpoint`                | 更新 phase、nextAction、gate 与 progress                              | task +1                                       |
| `link-spec` / `unlink-spec` | 精确关联 tracked Markdown section                                     | task +1                                       |
| `set-spec-evolution`        | 记录规范演进结果                                                      | task +1                                       |
| `finish`                    | 标记 completed 或 cancelled，默认按 return 链恢复父任务               | task +1；当前 binding +1                      |
| `recover`                   | 重放未完成 transaction、清除当前 binding 的丢失 target，或恢复父任务  | 由恢复类型决定                                |
| `migrate-state`             | schema v1 state 备份后转换为不含 global pointer 的 schema v2          | state +1；不自动创建 session claim            |
| `migrate-legacy`            | 显式迁移旧 task；unfinished status 保持 open                          | task 集合变化时 state +1                      |
| `repair-status`             | 只修复有明确证据的 canonical `in_progress` 或旧 `superseded` 映射错误 | task +1                                       |
| `quarantine-orphans`        | 原子移动无 `task.json` 的目录到 historical artifacts                  | 有目录变更时 state +1                         |
| `restore-orphans`           | 按 manifest 原子恢复 historical artifact                              | state +1                                      |

一个 open task 默认只允许一个 session claim；`activate` 遇到其他 claim 时返回 `TASK_CLAIMED`，必须经用户明确选择后调用
`takeover`。open `returnToTaskId` 链也由当前 binding 保留，防止另一 session 同时认领父任务。

跨 artifact、task、state 和 session binding 的修改先写入
`.ccg/transaction.json`，全部目标原子替换后才删除 marker。marker 存在时，`resolve` 返回
`INCOMPLETE_TRANSACTION`，`snapshot`、`list` 和其他 mutation 不得继续；用户确认后调用 `recover`
重放 marker 中的目标内容。

任务目录完成后仍保留原路径。`task.json.status` 只允许 `open`、`completed` 和 `cancelled`；当前 session
binding 指向一个 open task 时，resolver 对外显示 `in_progress`，其他 open task 显示
`suspended`。`.ccg`、tasks、sessions、migrations、historical artifacts、research 和 `.turns`
的父链中出现 symlink 时，控制器拒绝读写。

### 1.4 迁移、修复与认领顺序

1. `STATE_MIGRATION_REQUIRED`：使用 resolver 返回的 `stateId`、`stateRevision`、`legacyActiveTaskId`，并固定
   `bindingRevision: 0`、`activeTaskId: null` 调用
   `migrate-state`。原 state 按字节备份；旧 pointer 只写入 manifest，不分配给当前 session
2. `ORPHAN_TASK_DIR`：使用最新 state/binding CAS 调用 `quarantine-orphans`。目录通过同文件系统 rename 移到
   `.ccg/historical-artifacts/orphans/`，不读取内容、不生成 task、不推断 lifecycle
3. `TASK_MIGRATION_REQUIRED`：先调用 `preflight-legacy`；blocked contract 需要人工修复。其余使用最新 state/binding
   CAS 调用 `migrate-legacy`，迁移后重新 `resolve`
4. `selection-required`：展示 ID、title、revision、durable status 和 `claimed`。未占用任务调用
   `activate`；被占用任务只有在用户明确选择接管后调用 `takeover`
5. canonical task 持久化了 `in_progress` 时，只能在 `finishedAt: null` 且 revision 匹配时调用 `repair-status` 的
   `canonical-in-progress`；有 legacy backup 明确证明原状态为 `superseded` 时，才可调用 `superseded-completed`

迁移、修复和 quarantine 后都必须重新 `resolve`，使用新 revision 继续。不得把旧 global
pointer 自动认领给当前 session，不得把 unfinished task 改成 terminal status，也不得从 orphan 内容推断任务状态。

## 2. 阶段检查点

每个持久策略阶段结束后：

1. 核对本阶段实际产物，需要保存时使用 `write-artifact` 登记 analysis、plan、review 或 research
2. 使用 `checkpoint` 写入新的 `currentPhase`、`nextAction`、`gate` 和 `progress`
3. 保存响应中的新 `task.revision`
4. 需要用户决定或存在阻塞时，说明具体下一动作；已有授权的工作继续执行

普通事实查询保持 taskless，无需创建阶段文件

`currentPhase` 按 UTF-8 最多 64 字节，使用 `4-development` 等短阶段标签，完整阶段描述写入 progress；`nextAction` 按 UTF-8
最多 1024 字节，保留实际下一动作

progress 最多 256 KiB，包含末尾换行，保留当前结果、下一动作和证据链接；详细历史按以下顺序保存：

1. 将已有历史按每份最多 256 KiB 分段，通过 `write-artifact` 的 `kind=research` 写入未占用的 `progress-001.md` 等文件名
2. 确认历史保存成功，再调用 `resolve` 取得最新 CAS
3. 使用最新 CAS 提交 `checkpoint`，progress 写入当前摘要及 `research/progress-001.md` 等历史链接，requirements 保留全部有效要求

阶段名或 progress 超限时，控制器在写入前拒绝请求，原记录与 revision 保持原值；按提示缩短阶段标签或保存历史后重新提交检查点

示例：

```bash
node ~/.claude/hooks/ccg/task-state.js checkpoint --root "$WORKDIR" \
  --session-key "$CCG_SESSION_KEY" <<'CCG_TASK_JSON'
{
  "expected": {
    "stateId": "uuid",
    "stateRevision": 3,
    "bindingRevision": 1,
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

持久策略之间升级时，通过 `checkpoint` 更新任务的下一动作；当前控制器不提供任意 strategy
patch。需要改变持久策略时，完成或取消旧任务，再创建目标策略任务。

## 5. 指令优先级与任务材料

执行时依次遵守 system 和 developer 指令、用户本次明确指令、项目级 `CLAUDE.md`、全局 `CLAUDE.md`

精确关联的 tracked spec section、`requirements.md`、已审批计划、进度和摘要用于恢复任务事实与已有决定，执行权限以当前指令为准

普通即时问答保持当前任务与绑定；用户明确插入临时工作且没有并发写入冲突时，使用 `start` 的 `interrupt`
，完成后恢复父任务，无需再询问模式；替换目标或存在并发写入风险时再让用户选择处理方式，worktree 操作仍需实际授权

当前请求改变目标、范围或约束时，按当前指令判断继续、更新或新建任务，通过控制器更新受影响材料；其他 session
的任务保持原有认领和内容隔离，只读规划由主会话直接检索，Agent 名称或研究角色不改变权限和绑定检查

在当前授权范围内，用精确 spec 和有效需求核对计划、进度与摘要；发现材料冲突时报告具体字段并更新过时材料，需要新授权或方案决定时等待确认；计划中的简称保持
spec 定义的实体、版本和依赖方向

SessionStart 在 startup、compact、resume、clear 和 fork 时从 Hook payload 的 `session_id` 派生 opaque
key，并恢复该 binding 的完整 snapshot。startup、compact、resume 和 clear 只有在 Claude Code 保持同一 session
ID 时继续同一 task；fork 使用新 ID，不自动继承父 session claim。UserPromptSubmit 每个用户回合重新读取
`mode=authority, role=all`，只注入当前 session task header、state/binding/task revision、exact spec sections 和
`requirements.md`，不带旧 plan、progress、analysis、review 或 research。foreground
Agent、wrapper、TaskOutput 成功返回，以及 Agent 或 wrapper 失败后，PostToolUse/PostToolUseFailure 会使用同一父 session
key 重新读取 authority；后台启动只返回 task ID 时不刷新，等待 TaskOutput 的实际结果。

标准 Bash、Edit 和 Write 每次调用都在 PreToolUse 重新读取并验证当前 session 的完整
authority，原始命令、路径与写入内容保持不变；连续普通调用只有在已输出的合同正文和任务身份相同时才显示简短状态，任务、revision
和目录排在长 nextAction 之前

当前要求或精确 spec 正文变化、任务切换、compact／resume、用户新回合及外部结果返回时输出完整合同；同 revision 下手动修改 spec
也按正文变化处理，新 Agent 和 wrapper 始终取得完整角色上下文

去重仅使用当前 session 有界私有记录中最近已输出的正文，直接比较正文，运行记录独立于生命周期和授权；首次建立记录时输出全文，记录失效或读写失败时显示诊断并输出全文，恢复事件重新建立记录；无需读取大型转录或计算内容哈希

没有活动任务时普通工具保持可用；任务状态、契约预算或关联 spec 异常保留实际诊断和已有机器校验；执行者写入或删除前按最新
requirements 核对用户修正和交付保留要求，其他 MCP 写工具保持其实际覆盖范围

取得更新的 authority 后，使用当前已注入的合同核对下一动作：

1. 核对当前 task ID、state／binding／task revision 与角色；父任务恢复、外部结果返回或出现状态冲突时重新 `resolve`
2. 消费完整 `requirements.md` 和匹配当前角色的精确 spec；普通调用的简短状态表示正文沿用最近一次全文，Hook 仍在每次调用时读取并验证
   authority
3. 对实体、版本、依赖方向、允许动作、禁止动作、排除项、停止条件和验收标准逐字段核对
4. 发现冲突时停止受影响的实施，报告 `文档路径#section`、冲突字段、旧值和正确值
5. 按当前指令同步实际合同与受影响材料；需要新授权时等待用户决定

`requirements.md` 保存当前仍有效的目标、范围、约束与验收标准，UTF-8 原文和 XML 转义后的正文各自最多 8192 字节，包含末尾换行；
`nextAction` 按 UTF-8 最多 1024 字节

超限错误报告实际 UTF-8 字节数及对应上限，写前拒绝并保留原文和 revision；保留全部有效要求，详细论证和历史调查移至现有
research／progress，规范正文通过 `link-spec` 精确引用，整理后重新调用 `update-requirements`

用户新增或修正的有效约束同步到 requirements 或精确关联的规范，progress 记录进展与历史，恢复执行仍读取实际合同；CAS
冲突后重新读取状态，由当前请求决定下一次写入，不自动重放

Spec 必须通过 `link-spec` 精确关联 tracked 或 staged Markdown section。Git tracking 按 literal path 校验，fenced code
block 内的 heading 示例不参与 section 匹配。重复 heading、单 section 超限、spec 文件扫描不完整或全部关联 section
超出上下文预算时，控制器拒绝关联。不要扫描
`.ccg/spec/`，不要把整个目录隐式关联给所有任务。

OpenSpec change 必须写入 task scope 和 `requirements.md`。`spec-research`、`spec-plan`、`spec-impl`
只关联当前 change 下用户选定的 exact headings。新 artifact 未 tracked 或 staged 时，以 `spec_artifacts_must_be_tracked`
checkpoint 停止并让用户选择；命令不得自动执行
`git add`。archive 移动 change 前先 unlink 旧路径，成功后关联新的 canonical 或 archive section，避免 active
task 保留失效路径。

## 6. Team Dispatch

默认由主会话执行；独立工作有明确收益、需要材料或工具隔离、高风险发现需要独立证据，或用户指定协作时再委派，文件数与策略名称本身不触发派发

派发前明确独立范围、Agent 总量、最大深度、token 或时间预算、停止条件、去重键和输出格式；普通 subagent 保持叶子状态，第二层
reviewer／verifier 仅按主会话预先限定的工作项与总量安排

并行实施的前提：

- 任务已经按文件范围分组
- 方案已获授权，需要审批的计划已批准，已有相同方案批准可复用
- 每个子任务的写文件范围互不重叠
- 当前 snapshot 有有效 `requirements.md`

Builder prompt 必须包含：

- 工作目录
- task ID 与当前 task revision
- 文件范围
- 实施步骤
- 验收标准
- 当前授权范围与材料用途：`ccg-specs` 和有效需求用于核对派发摘要，冲突按第 5 节处理，不扩大执行权限

PreToolUse Hook 会把 role-aware snapshot 写入 Agent 的 `updatedInput.prompt`。调用 `codeagent-wrapper`
时，Hook 会识别直接调用和 `env ... codeagent-wrapper`，确认唯一 quoted heredoc 属于同一 shell command，再改写实际
`updatedInput.command`；`additionalContext` 不代表 wrapper 已收到上下文。

PostToolUse/PostToolUseFailure 只能把最新 authority 加入工具结果后的下一次模型请求，不能撤销已经完成的工具调用 Hook
会重新读取、校验和注入当前文件；自然语言规范由执行者理解，并按字段核对外部结论和下一动作

任务状态无效、任务契约或 spec 失效、上下文超限、quoted heredoc 无法与 wrapper command 安全绑定时，Hook 返回
`permissionDecision: "deny"`，Agent 或 wrapper 不会启动。修复对应状态或命令结构后重新发起调用。

Workflow 使用宿主实际 schema 中的参数传递当前要求、角色和限制，返回后核对最新 authority；Agent 的 `updatedInput.prompt`
改写只用于相应 Agent 工具，Workflow 脚本保持原有输入合同；只读能力经宿主确认前，沿用现有权限和 session 绑定检查

Agent 和外部模型保持 `.ccg/` 由主会话管理；Lead 汇总成功、失败和未完成结果，再调用 `write-artifact` 和 `checkpoint`
，独立工作继续完成

## 7. Spec Evolution

任务结束前检查本次修改是否需要更新项目已有的 tracked 文档或 OpenSpec：

- `applied`：用户确认并已更新 tracked spec
- `skipped`：存在建议，但用户明确不写入
- `not_applicable`：没有可复用的规范变化
- `pending`：尚未处理，`finish` 会拒绝

有建议时，先展示目标文档、section 和具体内容，获得用户确认后修改。不要自动创建 `.ccg/spec/`。

记录结果：

```bash
node ~/.claude/hooks/ccg/task-state.js set-spec-evolution --root "$WORKDIR" \
  --session-key "$CCG_SESSION_KEY" <<'CCG_TASK_JSON'
{
  "expected": {
    "stateId": "uuid",
    "stateRevision": 3,
    "bindingRevision": 1,
    "activeTaskId": "task-id",
    "taskRevision": 9
  },
  "value": "not_applicable"
}
CCG_TASK_JSON
```

## 8. 任务记录观察

UserPromptSubmit 只刷新任务上下文，不写
`.turns`，不根据回合数判断工作停滞；长阶段可以保持同一 phase 与 nextAction，实际进展按产物、测试和外部结果判断

显式调用 `record-turn` 时，控制器使用当前 session 的完整 CAS，记录最近 10 条 phase、nextAction 与 task
revision 连续 3 条记录均相同时，兼容字段 `loop.kind` 返回
`unchanged_task_records`，仅表示任务记录未变；artifact 或 checkpoint 提升 task
revision 后，不再匹配旧记录缺少 revision 的旧 telemetry 不参与判定，原始 session ID 不写入 `.turns`

观察结果本身不要求停止或更改策略；确认实际动作重复失败或存在阻塞后，通过 `checkpoint`
记录具体下一动作，无法继续时保留任务为 open，并报告阻塞 turn 文件损坏时，显式 `record-turn` 返回错误并保留原文件

## 9. Ralph Loop

关键词路由输出
`ccg-model-suggestion`，用于建议模型与角色，按当前真实用户请求和已有授权决定是否执行；引用、通知和任务材料中的关键词不产生执行权限主路由保留
`routing.backend.primary`、`routing.frontend.primary` 和 Pure Claude 行为，审查保留 `routing.review.profiles`
的 model、effort 与不持久化 reviewer 契约领域知识每份最多读取 16 KiB、注入前 120 行；截断时输出
`SKILL_CONTEXT_TRUNCATED` 与相对 skill 路径，后续所需内容再按路径读取

Ralph Loop 按完整功能阶段组织一次集中验收，保留实施期间为复现问题、区分原因或验证中间行为所需的定向检查

1. 整批实施完成后，汇总所有适用触发条件：新源码模块创建时使用 `ccg:gen-docs`，开发后使用 `ccg:verify-module` 与
   `ccg:verify-security`；功能阶段代码变更超过 30 行使用 `ccg:verify-change` 与 `ccg:verify-quality`
   ；认证、授权、加密、输入校验或凭据管理变化使用 `ccg:verify-security`；重构使用 change、quality 与
   security，多个触发条件合并为同一候选的一次检查
2. 原生 Skills 与 legacy 保持等效触发；原生模式只调用当前选择中可用的 Skill，缺少时使用项目等效检查，缺失的检查及覆盖写明未验证
3. 复用候选、输入、工具链、参数、配置和覆盖仍适用的证据；失败修复后只复验受影响部分，其他有效证据保留，命令、范围和结果写入现有
   progress／review
4. 独立检查继续完成，依赖检查等待实际前提；分别记录失败、超时、不可用、不支持和未完成状态
5. 默认由主会话阅读完整变更、调用者和验收标准；独立复核有实际收益或用户要求时按 § 6 委派，用户明确请求外部审查时才启动对应
   profile，使用 `--no-session-persistence` 并传入完整当前材料
6. 回到当前源码确认 finding，已授权修复范围内的 confirmed finding 连续修复；Critical 或 High
   在交付前解决，只读审查直接报告发现，需新范围或权限时请求用户决定
7. 复审针对真实变化、风险或尚缺证据，避免固定创建新 reviewer、逐轮调用全部 Skill 或询问是否继续；满足验收条件后结束，必需的检查失败或未完成时保留相应状态

持久任务使用 `write-artifact` 保存 `review.md`，通过 `checkpoint` 记录发现、修复、实际验证与未完成项；外部报告按当前源码复核，生命周期仍由主会话通过控制器管理

## 10. 完成与取消

完成前：

1. 验收标准逐项核对
2. 测试与静态检查结果写入 progress
3. review.md 已登记（策略要求审查时）
4. Spec Evolution 已记录
5. Gate 为 `null`

调用 `finish`：

```bash
node ~/.claude/hooks/ccg/task-state.js finish --root "$WORKDIR" \
  --session-key "$CCG_SESSION_KEY" <<'CCG_TASK_JSON'
{
  "expected": {
    "stateId": "uuid",
    "stateRevision": 3,
    "bindingRevision": 1,
    "activeTaskId": "task-id",
    "taskRevision": 10
  },
  "status": "completed",
  "progress": "# Progress\n\n## Completed\n\n- 验收完成\n\n## Verification\n\n- pnpm test: passed\n"
}
CCG_TASK_JSON
```

默认沿 `returnToTaskId` 返回最近仍为 open 的父任务；请求中设置 `"restorePreviousTask": false` 时，结束当前任务并清空当前
session binding，父任务保持 open；该参数必须为 boolean，任务目录保持原路径，提交按用户实际授权处理

`finish` 或 `recover` 返回 `resumedTaskId` 后，重新 `resolve`，读取恢复父任务当前的 `requirements.md`、匹配角色的精确 spec、
`nextAction` 与 `gate`；按当前授权继续，Gate 需要审批时等待用户决定，后续 mutation 使用父任务新返回的完整 CAS，子任务
revision 仅用于子任务

父任务恢复以当前合同为准，临时任务的摘要或旧进度用于理解历史；新增有效约束同步到父任务实际读取的 requirements 或精确
spec，再继续实施
