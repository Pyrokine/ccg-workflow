---
description: '管理 Git Worktree，并隔离 worktree 运行态与 session 任务绑定'
---

# Worktree - Git Worktree 管理

在仓库外的结构化目录创建和管理 Git worktree。每个 worktree 有独立的项目根 `.ccg/state.json`、`.ccg/sessions/` 和 `.ccg/tasks/`，共享 Git 跟踪的源码、规范和 `.context` 团队知识。每个 Claude Code session 只解析自己的 opaque binding。

## 使用方法

```bash
/ccg:worktree <add|list|remove|prune|migrate> [options]
```

## 子命令

| 命令               | 说明                                             |
| ------------------ | ------------------------------------------------ |
| `add <name>`       | 创建新 worktree                                  |
| `list`             | 列出 worktree、分支和当前 session 的任务状态摘要 |
| `remove <name      | path>`                                           | 删除指定 worktree |
| `prune`            | 清理失效的 Git worktree 引用                     |
| `migrate <target>` | 把未提交的产品改动迁移到目标 worktree            |

## 选项

| 选项              | 说明                           |
| ----------------- | ------------------------------ |
| `-b <branch>`     | 创建新分支                     |
| `-o, --open`      | 创建后用 IDE 打开              |
| `--from <source>` | 指定迁移源 worktree            |
| `--stash`         | 通过 stash 迁移产品改动        |
| `--track`         | 跟踪远程分支                   |
| `--detach`        | 创建 detached HEAD worktree    |
| `--lock`          | 创建后执行 `git worktree lock` |

## 两类 `.ccg` 目录

```text
parent-directory/
├── your-project/                   # 主 worktree
│   ├── .git/
│   └── .ccg/                       # 此 worktree 的 state、session binding 与任务运行态
└── .ccg/                           # 仓库外的 worktree 管理目录
    └── your-project/
        ├── feature-ui/
        │   ├── .git                # linked worktree 指针文件
        │   └── .ccg/               # feature-ui 独立 state、session binding 与任务运行态
        └── hotfix/
            ├── .git
            └── .ccg/               # hotfix 独立 state、session binding 与任务运行态
```

仓库外的 `../.ccg/<project>/` 只组织 worktree 路径。每个项目根下的 `.ccg/` 保存任务运行态。两者不能混用。

## add

1. 从当前目录向上查找 `.git` 文件或目录，确定所属仓库和当前 worktree
2. 校验 `<name>`，拒绝绝对路径、`..` 和会逃出管理目录的路径
3. 默认目标为 `../.ccg/<project>/<name>`
4. 未指定 `-b` 时，以 `<name>` 作为新分支名；`--track`、`--detach` 按 Git 原生语义处理
5. 执行 `git worktree add`
6. 只在用户明确选择时复制 `.env` 等本地环境文件，复制前列出文件，禁止输出文件内容
7. 不复制源 worktree 的 `.ccg/`、`.context/current/`、session log、task contract、plan 或 review artifact
8. 新 worktree 首次创建持久任务时，task controller 自动建立本地 `.ccg/` 并写入 Git exclude
9. `--open` 只在创建成功后执行

一个 worktree 可以保存多个 session binding，但每个 session 同时只认领一个 task，同一 open task 默认只由一个 session 认领。不同 session 不会自动注入彼此的任务正文；可能并发改写同一产品文件的独立任务仍应放在不同 worktree。

## list

1. 执行 `git worktree list --porcelain`
2. 要求当前 `CCG_SESSION_KEY` 有效；对每个可访问 worktree 调用：
   ```bash
   node ~/.claude/hooks/ccg/task-state.js resolve --root "<worktree>" --session-key "$CCG_SESSION_KEY"
   ```
3. 显示路径、分支、HEAD、锁定状态和当前 session 在该 worktree 的以下任务状态之一：
   - `in_progress: <task-id>@<revision>`
   - `selection-required`
   - `migration-required`
   - `recovery-required`
   - `invalid: <code>`
   - `none`
4. `selection-required` 只展示候选元数据与 `claimed` 状态，不展示其他 session key 或任务正文
5. 不按分支名、目录名或修改时间推断任务

## migrate

迁移产品改动，不迁移任务运行态。

1. 确认源和目标都是同一仓库的已注册 worktree
2. 读取两侧 `git status --short`
3. 目标存在未提交改动时停止
4. 展示将迁移的 tracked 与用户明确选择的 untracked 文件
5. 排除 `.ccg/`、`.context/current/`、session log、凭证和未获授权的环境文件
6. 使用用户选择的 patch、stash 或文件复制方式迁移
7. 在目标 worktree 检查 diff 与源范围一致
8. 需要继续持久任务时，在目标 worktree 显式创建或认领任务；禁止复制 `state.json`、session binding 或 task 目录
9. 未经用户明确授权，不删除源改动

## remove

1. 解析并展示目标 worktree、分支和 `git status --short`
2. 使用当前 session key 调用目标 task controller `resolve`，并读取 session-neutral 的 open task 与 binding 数量
3. 存在未提交改动、任何 open task、任何 session binding、待迁移数据、恢复状态或损坏状态时，说明会丢失的本地内容并等待明确确认
4. 默认执行 `git worktree remove <path>`，只有用户明确要求才使用 `--force`
5. 删除 worktree 会同时删除该目录中的 `.ccg/` 本地任务运行态；Git 跟踪的规范和 `.context` 团队知识不受影响

## prune

先执行 `git worktree prune --dry-run --verbose` 展示候选项。用户确认后再执行 `git worktree prune --verbose`。

## 示例

```bash
/ccg:worktree add feature-ui
/ccg:worktree add hotfix -b fix/login -o
/ccg:worktree migrate feature-ui --from main
/ccg:worktree list
/ccg:worktree remove feature-ui
/ccg:worktree prune
```

## Rules

1. Worktree 路径使用绝对路径验证后再传给 Git
2. 不复制、合并或提交 `.ccg/` state、session binding 或任务运行态
3. 不从 branch、mtime 或任务目录名推断当前 session 的 active task
4. 不输出其他 session key，也不读取其他 session 任务正文来生成列表
5. Git 跟踪的项目文档、OpenSpec、`.context/prefs/` 和 `.context/history/` 才是跨 worktree 共享知识
6. 破坏性操作前展示目标状态并等待明确确认
