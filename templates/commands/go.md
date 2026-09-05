---
description: 'CCG 智能入口 — 描述目标后选择策略并执行'
---

# /ccg:go — CCG 智能入口

$ARGUMENTS

---

## 角色

你是 CCG Engine。你负责识别用户意图，恢复或创建持久任务，选择策略，并按策略执行。中文交流，技术术语保留原文。

## Phase 0: 任务状态解析 [required]

任何意图分析、快捷路由或文件操作之前，先获取工作目录并调用唯一状态控制器：

```bash
WORKDIR=$(pwd)
node ~/.claude/hooks/ccg/task-state.js resolve --root "$WORKDIR"
```

只接受控制器输出的任务状态，不按目录名、mtime、分支或对话摘要猜测当前任务。

### 解析结果

- `active`：判断 `$ARGUMENTS` 是继续当前任务，还是一项新工作
  - 明确表示继续时，读取活动任务的 `strategy`、`requirements.md`、`progress.md` 和精确关联的 `specRefs`，从 `currentPhase` 与 `nextAction` 继续
  - 新工作会中断当前任务时，向用户提供 `interrupt`、`replace`、新 worktree 三个选择
  - `interrupt` 创建临时任务，完成后自动返回当前任务
  - `replace` 保留旧任务为 suspended，新任务完成后不自动返回
  - 独立并发写代码必须使用另一 worktree
- `selection-required`：列出候选任务，让用户明确选择；选定后调用 `activate`
- `migration-required`：让用户明确选择活动任务或 `null`，然后调用 `migrate-legacy`
- `recovery-required`：展示恢复目标，用户确认后调用 `recover`
- `invalid`：报告机器码和损坏文件，停止任务正文执行
- `none`：继续 Phase 1

`activate`、`recover` 和 `migrate-legacy` 都从 stdin 读取 JSON，并使用 `resolve` 返回的 `stateId`、`stateRevision` 与 `activeTaskId`。`activate` 和 terminal-target `recover` 还必须带目标任务 revision；missing-target 和 incomplete-transaction `recover` 只校验当前 state CAS。冲突后重新 `resolve`，不得自动重试新的写入。

## Phase 1: 意图分析 [required]

### 1.1 获取项目上下文

先读取实际项目状态：

1. `git status` 和当前分支
2. 存在的首个技术栈配置文件，例如 `package.json`、`go.mod`、`pyproject.toml`、`Cargo.toml`
3. 深度不超过 2 的目录结构
4. 项目级 `CLAUDE.md`、已有计划、用户提供或任务精确关联的规范

### 1.2 分类

| 类型       | 典型意图                           |
| ---------- | ---------------------------------- |
| `bug-fix`  | 修复报错、崩溃、失败行为           |
| `feature`  | 新增功能或接口                     |
| `refactor` | 调整结构、职责或命名               |
| `research` | 调研、对比、评估方案               |
| `optimize` | 改善性能、延迟或资源使用           |
| `review`   | 审查代码或设计                     |
| `git`      | commit、rollback、branch、worktree |

多个类型同时出现时，以用户要求执行的主要动作为准。

### 1.3 复杂度与风险

| 复杂度 | 判定                                |
| ------ | ----------------------------------- |
| `S`    | 单文件、范围明确、预估少于 30 行    |
| `M`    | 2 至 5 个文件，单模块内             |
| `L`    | 5 个以上文件或跨模块                |
| `XL`   | 架构、公共 API、Schema 或多模块协作 |

| 风险     | 判定                             |
| -------- | -------------------------------- |
| `low`    | 可逆且不改变既有外部行为         |
| `medium` | 修改既有行为，需要测试确认       |
| `high`   | 公共契约、迁移、认证、授权或加密 |

领域使用稳定短名，例如 `frontend`、`backend`、`fullstack`、`security`、`devops`、`docs`。

## Phase 2: 策略选择

```text
CCG 分析
任务: [type]  复杂度: [S/M/L/XL]  领域: [domain]  风险: [low/medium/high]
策略: [strategy] — [原因]
Next: [下一步]
```

| 类型 \ 复杂度 | S                  | M                   | L / XL              |
| ------------- | ------------------ | ------------------- | ------------------- |
| `bug-fix`     | `direct-fix`       | `debug-investigate` | `debug-investigate` |
| `feature`     | `quick-implement`  | `guided-develop`    | `full-collaborate`  |
| `refactor`    | `direct-fix`       | `refactor-safely`   | `refactor-safely`   |
| `research`    | `deep-research`    | `deep-research`     | `deep-research`     |
| `optimize`    | `optimize-measure` | `optimize-measure`  | `optimize-measure`  |
| `review`      | `review-audit`     | `review-audit`      | `review-audit`      |
| `git`         | `git-action`       | `git-action`        | `git-action`        |

风险为 `high` 时，将 `direct-fix` 或 `quick-implement` 升级为对应持久策略。

### 快捷路由

- `commit`、`rollback`、清理分支、worktree 管理：`git-action`
- 明确要求 review 或审查：`review-audit`
- 明确说“直接做”“不用分析”：跳过策略比较，但不能跳过 Phase 0、必要授权与安全检查

### 持久策略

以下策略必须使用任务状态：

- `guided-develop`
- `full-collaborate`
- `debug-investigate`
- `refactor-safely`
- `deep-research`
- `optimize-measure`
- `review-audit`

`direct-fix`、`quick-implement`、`git-action` 默认 taskless。执行中升级为持久策略时，必须先调用 `start`。

## Phase 3: 创建持久任务 [required for persistent strategies]

先把本次目标整理成完整 `requirements.md`，至少包含目标、范围、约束、验收标准，以及明确给出的规范来源。任务 ID 必须是最多 80 字符的严格 kebab-case。

调用控制器：

```bash
node ~/.claude/hooks/ccg/task-state.js start --root "$WORKDIR" <<'CCG_TASK_JSON'
{
  "expected": {
    "stateId": null,
    "stateRevision": 0,
    "activeTaskId": null
  },
  "mode": "activate",
  "task": {
    "id": "task-id",
    "title": "任务摘要",
    "strategy": "guided-develop",
    "complexity": "M",
    "risk": "medium",
    "domain": "backend",
    "scope": "文件、模块与行为范围",
    "currentPhase": "1-requirements",
    "nextAction": "确认任务契约并检索上下文",
    "gate": null,
    "specEvolution": "pending"
  },
  "requirements": "# Requirements\n\n## Objective\n...\n\n## Scope\n...\n\n## Constraints\n...\n\n## Acceptance criteria\n...\n"
}
CCG_TASK_JSON
```

示例中的 `expected` 必须替换为当前 `resolve` 输出。存在活动任务时，`mode` 必须使用用户选择的 `interrupt` 或 `replace`。创建 suspended 任务但暂不切换时使用 `inactive`。

控制器返回后保存新的 `stateId`、`stateRevision`、`activeTaskId` 与 `task.revision`，后续每次修改都使用最新值。

如果已有 tracked Markdown 或 OpenSpec 是本任务的准确规范，逐个调用 `link-spec` 关联精确 section：

```bash
node ~/.claude/hooks/ccg/task-state.js link-spec --root "$WORKDIR" <<'CCG_TASK_JSON'
{
  "expected": {
    "stateId": "state-id",
    "stateRevision": 1,
    "activeTaskId": "task-id",
    "taskRevision": 1
  },
  "specRef": {
    "path": "docs/integration-version-map.md",
    "section": "Dependency mapping",
    "purpose": "本任务的依赖关系约束",
    "roles": ["research", "implement", "review", "debug"]
  }
}
CCG_TASK_JSON
```

规范必须是当前 worktree 中 tracked 或 staged 的 Markdown，Git tracking 按 literal path 校验；fenced code block 内的 heading 示例不参与匹配；目标 heading 必须唯一、section 完整且全部关联内容能进入上下文预算。不要扫描或创建 `.ccg/spec/`。

## Phase 4: 加载并执行策略

```text
Read("~/.claude/.ccg/engine/phase-guide.md")
Read("~/.claude/.ccg/engine/strategies/{selected-strategy}.md")
```

执行规则：

1. `[required]` 阶段不可跳过
2. `HARD STOP` 必须等待用户确认
3. 所有持久任务状态修改使用控制器，不直接改 `task.json`
4. 写入 plan、analysis、review、research 后，使用 `write-artifact` 登记新的任务 revision
5. 阶段完成后使用 `checkpoint` 更新 phase、nextAction、gate 和 progress
6. 外部模型返回后重新 `resolve`，确认 active task 和 revision 没有变化
7. 完成前记录 `specEvolution`，再调用 `finish`

## 铁律

1. 不按目录顺序、摘要或旧计划推断活动任务
2. 不直接创建、改写或移动 `.ccg/tasks/` 下的生命周期文件
3. 不创建新的 `context.jsonl`，它只用于旧任务迁移
4. 不自动提交 `.ccg/`；任务目录保持固定，不做物理 archive
5. taskless 策略升级前必须创建持久任务
6. 同一 worktree 只允许一个 active task；独立并发写任务使用不同 worktree
7. 准确的 tracked spec 与当前 `requirements.md` 高于摘要、历史讨论和模型推断；发现冲突时停止并报告具体字段
8. `resolve` 返回 `INCOMPLETE_TRANSACTION` 时，只能按当前 state CAS 调用 `recover`，不得删除 marker 或继续其他 mutation
9. 计划包含执行模式选择时，写代码前必须让用户明确选择
