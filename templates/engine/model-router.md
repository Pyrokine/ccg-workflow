# CCG 模型路由器 — 运行时模型选择框架

> 本文件由策略文件通过 Read 加载，提供动态模型选择和 codeagent-wrapper 调用模板。

## 1. 获取模型配置

读取用户配置确定可用模型：

```
Read ~/.claude/.ccg/config.toml
```

从 `[routing]` 区块提取：

- `frontend.models` — 前端候选模型，按顺序尝试
- `frontend.primary` — 前端首选模型，默认 `antigravity`
- `frontend.strategy` — `fallback` 时首选失败后按 `models` 继续尝试
- `backend.primary` — 后端模型，默认 `codex`
- `review.models` — 审查模型列表，默认 `codex` + `antigravity`
- `proxy` — 可选代理配置；仅在显式配置 `antigravity` / `agy` 时注入，不默认注入

如果配置文件不存在或不可读，使用默认值直接继续。当前默认前端 fallback 链是 `antigravity` → `codex`。

Gemini CLI 已禁用：2026-06-18 后 consumer OAuth 请求不再处理，CCG 使用 Antigravity 替代。不要选择 `gemini`，旧配置中的
`gemini` 只允许迁移为 `antigravity`。

## 2. 按阶段选择模型

### 分析/研究阶段

| 任务领域  | 推荐模型                                       | 角色提示词                   |
|-------|--------------------------------------------|-------------------------|
| 后端/架构 | backend 模型                                 | `$BACKEND/analyzer.md`  |
| 前端/UI | frontend 模型                                | `$FRONTEND/analyzer.md` |
| 全栈    | backend 模型，涉及前端、布局、界面、页面设计时再调用 frontend 模型 | 对应 analyzer             |
| 安全    | backend 模型                                 | `$BACKEND/analyzer.md`  |

### 规划阶段

| 任务领域     | 推荐模型                                       | 角色提示词                    |
|----------|--------------------------------------------|--------------------------|
| 架构设计     | backend 模型                                 | `$BACKEND/architect.md`  |
| UI/UX 设计 | frontend 模型                                | `$FRONTEND/architect.md` |
| 全栈       | backend 模型，涉及前端、布局、界面、页面设计时再调用 frontend 模型 | 对应 architect             |

### 审查阶段

- 按 `review.models` 调用两个审查模型，默认 `codex` + `antigravity`
- 两个模型都必须通过 `~/.claude/bin/codeagent-wrapper --lite --progress --backend $MODEL` 启动
- 某个模型失败时只报告该模型不可用，禁止把其它模型结果标成它的结论

### 调试阶段

| 任务领域 | 推荐模型                                           | 角色提示词                   |
|------|------------------------------------------------|-------------------------|
| 后端问题 | backend 模型优先                                   | `$BACKEND/debugger.md`  |
| 前端问题 | frontend 模型优先                                  | `$FRONTEND/debugger.md` |
| 不确定  | backend 模型优先，确认涉及前端、布局、界面、页面设计时再调用 frontend 模型 | 对应 debugger             |

### 实施阶段

**默认模式**（Claude 执行）：

- 外部模型仅提供建议，Claude 执行所有文件修改

**Codex Builder 模式**（用户选择时）：

- backend 模型 + `$BACKEND/builder.md` — **有完整写权限**，直接写代码到文件系统
- Claude 监控进度，审查产出，必要时接管
- 适用于 M-L 复杂度、低中风险的明确实施任务

## 3. 调用模板

Antigravity 只有在 `[routing.proxy]` 显式配置 `antigravity` / `agy` 和代理 URL 时，才由 `~/.claude/bin/codeagent-wrapper`
注入代理。Codex / Claude 不走代理。

### 获取工作目录

先确定当前工作目录（不可从 $HOME 推断）：

```
WORKDIR=$(pwd)
```

### 新会话调用

```
Bash({
  command: "~/.claude/bin/codeagent-wrapper {{LITE_MODE_FLAG}}--progress --backend $MODEL - \"$WORKDIR\" <<'CODEAGENT_EOF'\nROLE_FILE: ~/.claude/.ccg/prompts/$MODEL/$ROLE.md\n<TASK>\n$TASK_CONTENT\n</TASK>\nOUTPUT: $OUTPUT_FORMAT\nCODEAGENT_EOF",
  run_in_background: true,
  timeout: 3600000,
  description: "$SHORT_DESCRIPTION"
})
```

变量说明：

- `$MODEL` — 选定的模型名（`codex` / `claude` / `antigravity`）
- `$ROLE` — 角色文件名（`analyzer` / `architect` / `reviewer` / `debugger` / `optimizer` / `tester` / `builder`）
- `$TASK_CONTENT` — 任务内容（需求 + 上下文）
- `$OUTPUT_FORMAT` — 期望输出格式
- `$SHORT_DESCRIPTION` — 简短描述（用于进度显示）

### 复用会话调用

```
Bash({
  command: "~/.claude/bin/codeagent-wrapper {{LITE_MODE_FLAG}}--progress --backend $MODEL resume $SESSION_ID - \"$WORKDIR\" <<'CODEAGENT_EOF'\nROLE_FILE: ~/.claude/.ccg/prompts/$MODEL/$ROLE.md\n<TASK>\n$TASK_CONTENT\n</TASK>\nOUTPUT: $OUTPUT_FORMAT\nCODEAGENT_EOF",
  run_in_background: true,
  timeout: 3600000,
  description: "$SHORT_DESCRIPTION"
})
```

### 条件双模型调用模式

默认只启动 backend 模型。只有任务明确涉及前端、布局、界面、页面设计、UI/UX 时，才同时启动 frontend 模型：

1. 启动 backend 模型（`run_in_background: true`）
2. 命中前端设计条件时，启动 frontend 模型（`run_in_background: true`）
3. 等待已启动的任务完成：
   ```
   TaskOutput({ task_id: "$BACKEND_TASK_ID", block: true, timeout: 600000 })
   TaskOutput({ task_id: "$FRONTEND_TASK_ID", block: true, timeout: 600000 })
   ```
4. 综合已返回的结果

## 4. 等待与重试规则

| 场景                  | 策略                                                           |
|---------------------|--------------------------------------------------------------|
| frontend 首选模型失败     | 重试最多 2 次，间隔 5s                                               |
| frontend 首选模型 3 次全败 | 按 `frontend.models` 顺序调用下一个模型，例如 `antigravity` 失败后调用 `codex` |
| backend 模型运行中       | 可能需要 5-15 分钟，保持轮询，永不终止                                       |
| fallback 全败         | 降级为后端单模型模式，告知用户                                              |
| 超时                  | 600s 等待上限，超时后报告并询问用户                                         |

## 5. SESSION_ID 管理

- 每次 codeagent-wrapper 调用返回 `Session-ID: xxx`
- 捕获并保存：`BACKEND_SESSION`、`FRONTEND_SESSION`
- 后续阶段通过 `resume $SESSION_ID` 复用上下文
- 复用会话可减少重复分析，提升效率
