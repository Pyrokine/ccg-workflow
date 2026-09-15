---
description: '管理项目共享规范、当前会话备注和提交级决策历史'
---

# Context - 项目上下文管理

管理 `.context/` 中的团队知识和本地会话备注。此命令不创建、选择或修改持久任务；当前 session 的 active task 只由 task controller 和 `.ccg/sessions/` binding 决定。

## 存储边界

| 路径                                               | 性质                             | 用途                                                                   |
| -------------------------------------------------- | -------------------------------- | ---------------------------------------------------------------------- |
| `.ccg/state.json`、`.ccg/sessions/`、`.ccg/tasks/` | 当前 worktree 本地运行态，不提交 | state 身份、session task binding、任务契约、阶段、计划、进度、审查记录 |
| `.context/current/`                                | 本地会话信息，不提交             | 当前分支的临时备注和提交前摘要                                         |
| `.context/prefs/`                                  | Git 跟踪，团队共享               | 编码规范和开发流程                                                     |
| `.context/history/`                                | Git 跟踪，团队共享               | 已脱敏的提交级决策历史                                                 |
| 项目文档、OpenSpec                                 | Git 跟踪，团队共享               | 成熟规范；持久任务通过 exact `path#section` 关联                       |

`.context/` 不替代 `requirements.md`，也不从目录名、分支或历史记录推断 active task。每个 session 只自动加载自己的 binding；独立 worktree 各自拥有 `.ccg/` 运行态，共享 Git 跟踪的 prefs、history 和规范文档。

## 使用方法

```bash
/ccg:context <init|log|show|compress|history|squash> [options]
```

## 子命令

| 子命令            | 说明                                    |
| ----------------- | --------------------------------------- |
| `init`            | 初始化 `.context/` 目录和共享模板       |
| `log <message>`   | 向当前分支的本地 `session.log` 追加备注 |
| `show`            | 查看当前分支的本地备注                  |
| `compress`        | 生成本地提交前摘要 `uncommit.md`        |
| `history [file]`  | 查看提交级决策历史，或按文件过滤        |
| `squash <ids...>` | 合并多条 ContextEntry                   |

通常只需执行一次 `init`。`/ccg:commit` 根据 diff 生成 ContextEntry；`log` 仅记录 diff 无法表达的决策理由。

## init

1. 从当前目录向上查找 `.git` 文件或目录，确定当前 worktree 根
2. 已存在的文件保持不变，只创建缺失项
3. 创建：

```text
.context/
├── .gitignore
├── .gitattributes
├── prefs/
│   ├── coding-style.md
│   └── workflow.md
├── current/
│   └── branches/
│       └── .gitkeep
└── history/
    ├── commits.jsonl
    ├── commits.md
    └── archives/
        └── .gitkeep
```

`.context/.gitignore`：

```gitignore
# Worktree-local session material
current/

# Raw interaction logs
**/session.log
**/session.raw.log
**/*.session.log
**/*.raw.log

# Temporary files
**/*.tmp
**/*.bak
**/*.swp
```

`.context/.gitattributes`：

```gitattributes
history/commits.jsonl merge=union
history/archives/*.jsonl merge=union
```

`.context/prefs/coding-style.md`：

```markdown
# Coding style guide

This tracked file defines team coding rules for humans and development agents.

## General

- Keep changes reviewable and avoid unrelated refactors
- Use explicit names and explicit error handling
- Follow the repository's language-specific conventions

## Testing

- Add or update tests for changed behavior
- Record the commands actually run

## Security

- Do not store secrets in source, logs, or ContextEntry records
- Validate data at trust boundaries
```

`.context/prefs/workflow.md`：

```markdown
# Development workflow rules

This tracked file defines the team's development and verification process.

## Feature

1. Confirm requirements and scope
2. Read affected code and authoritative specs
3. Implement the approved plan
4. Add or update tests
5. Run the required checks
6. Update tracked documentation when behavior or contracts change

## Fix

1. Reproduce the symptom
2. Establish the cause with code or runtime evidence
3. Add a failing regression test when practical
4. Fix the shared cause
5. Run targeted and regression tests

## Refactor

1. Record a passing baseline
2. Preserve public behavior unless the task contract says otherwise
3. Refactor in independently verifiable steps
4. Compare final results with the baseline
```

Create an empty `.context/history/commits.jsonl` and this human-readable view:

```markdown
# Commit decision history

Canonical store: `commits.jsonl`

| Date | Context-Id | Commit | Summary | Decisions | Bugs | Risk |
| ---- | ---------- | ------ | ------- | --------- | ---- | ---- |
```

If the project has `CLAUDE.md`, append the following block only when it is absent:

```markdown
## .context project knowledge

- Team coding rules: `.context/prefs/coding-style.md`
- Team workflow rules: `.context/prefs/workflow.md`
- Sanitized decision history: `.context/history/commits.md`
- Local session notes: `.context/current/`, never commit
- Persistent task runtime: `.ccg/`, never commit and never edit directly
```

Report created, preserved, and skipped files separately.

## log

1. Get the current branch with `git branch --show-current`; use `detached-head` when empty
2. Create `.context/current/branches/<branch>/`
3. Append to `session.log`:

```markdown
## <ISO-8601 timestamp>

<message>
```

Do not copy task contracts, full model transcripts, secrets, or linked spec bodies into this log.

## show

Read `.context/current/branches/<branch>/session.log`. If it does not exist, report that the current branch has no local notes.

## compress

1. Read the current branch's `session.log`
2. Stop when it is empty
3. Redact tokens, keys, passwords, cookies, Authorization headers, internal credentials, and personal data
4. Extract decisions, rejected alternatives, bugs, and verification results
5. Write `.context/current/branches/<branch>/uncommit.md`
6. Do not update `history/` and do not modify `.ccg/`

## history

Read `.context/history/commits.md`. When a file path is supplied, filter `commits.jsonl` entries whose `changes.files` contain that path.

## squash

1. Read the requested Context-Ids from `commits.jsonl`
2. Refuse missing or duplicate IDs
3. Create one new UUIDv7 ContextEntry with `Context-Refs` pointing to the source IDs
4. Merge decisions, bugs, file changes, and verification records without duplicating identical entries
5. Redact before appending to `commits.jsonl`
6. Regenerate `commits.md`

## ContextEntry schema

```json
{
  "schema_version": "1.0.0",
  "context_id": "<UUIDv7>",
  "created_at": "<ISO-8601>",
  "producer": {
    "tool": "<tool-name>",
    "llm": { "provider": "<provider>", "model": "<model>" }
  },
  "git": {
    "branch": "<branch>",
    "commit_sha": "<short-sha>",
    "trailers": { "Context-Id": "<uuid>" }
  },
  "summary": "<one-line summary>",
  "decisions": [
    {
      "title": "<decision>",
      "rationale": "<reason>",
      "tradeoffs": ["<tradeoff>"],
      "assumptions": ["<assumption>"],
      "rejected_alternatives": [{ "option": "<alternative>", "reason": "<reason>" }],
      "side_effects": ["<effect>"]
    }
  ],
  "bugs": [
    {
      "symptom": "<symptom>",
      "root_cause": "<cause>",
      "fix": "<fix>",
      "lesson": "<lesson>"
    }
  ],
  "changes": { "files": ["<path>"] },
  "tests": [{ "command": "<command>", "result": "<pass|fail>", "coverage": "<optional>" }],
  "privacy": { "classification": "internal", "redactions_applied": true }
}
```

## Rules

1. Commit `.context/prefs/` and `.context/history/`
2. Never commit `.context/current/` or `.ccg/`
3. `commits.jsonl` is the canonical decision history; `commits.md` is derived
4. Active task identity comes only from the task controller
5. Exact linked tracked specs and the active task's `requirements.md` outrank summaries and historical notes
6. Redact before writing shared history
