# CCG 模型路由器 — 运行时模型选择框架

> 本文件由策略文件通过 Read 加载，提供动态模型选择和 codeagent-wrapper 调用模板。

## 1. 获取模型配置

读取用户配置确定可用模型：

```
Read ~/.claude/.ccg/config.toml
```

从 `[routing]` 区块提取：

- `frontend.models` / `frontend.primary` — 前端候选模型及首选模型，默认 `antigravity`
- `backend.models` / `backend.primary` — 后端候选模型及首选模型，默认 `codex`
- `review.profiles` — 外部审查 profile 列表，默认 GPT、Grok
- `grokModel` — Grok CLI 可选型号
- `kimiModel` — Kimi 可选型号，留空时使用 Kimi CLI 自身默认值
- `opencodeModel` — OpenCode 可选 `provider/model`
- `proxy` — 可选代理配置，仅 `antigravity` / `agy` 可注入

模型可为 `codex`、`claude`、`antigravity`、`grok`、`kimi` 或 `opencode`。配置文件缺失或不可读时，使用默认路由。

Gemini CLI 已禁用：2026-06-18 后 consumer OAuth 请求不再处理。不要选择 `gemini`，旧配置中的 `gemini` 只允许迁移为 `antigravity`。

## 1b. 纯 Claude Code 模式

当 `frontend.primary` 与 `backend.primary` 都是 `claude` 时：

- 不调用 `codeagent-wrapper`，也不启动外部 CLI 执行前端或后端工作
- 分析与 Builder 工作改由 Claude Code Agent 或 Agent Teams 完成
- 分别创建独立上下文的 Agent，分配后端或前端视角
- 按第 2 节调用 GPT、Grok 两个外部 profile，主 Claude 只编排与汇总
- 第 3 节的新会话与复用会话模板不用于前端或后端工作

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

- 按 `review.profiles` 启动 GPT、Grok 两个独立 reviewer，缺少任一 profile 时使用默认 profile 补全
- 两者都通过 `~/.claude/bin/codeagent-wrapper --backend claude` 启动，实际 provider 与当前 Claude Code 相同
- GPT 负责后端逻辑、正确性、安全、回归和测试缺口，Grok 负责前端交互、可访问性、设计一致性和前端安全
- GPT 与 Grok 使用各自 profile 中的 `model` 和 `effort`，默认值分别是 `gpt-5.6-sol` / `xhigh` 与 `grok-4.5` / `high`
- 两个 reviewer 都传 `--no-session-persistence`，每次审查独立且不可 `resume`
- 某个 reviewer 失败时只报告该 reviewer 不可用，禁止把其它结果标成它的结论

### 调试阶段

| 任务领域 | 推荐模型                                           | 角色提示词                   |
|------|------------------------------------------------|-------------------------|
| 后端问题 | backend 模型优先                                   | `$BACKEND/debugger.md`  |
| 前端问题 | frontend 模型优先                                  | `$FRONTEND/debugger.md` |
| 不确定  | backend 模型优先，确认涉及前端、布局、界面、页面设计时再调用 frontend 模型 | 对应 debugger             |

### 实施阶段

**默认模式**（Claude 执行）：

- 外部模型仅提供建议，Claude 执行所有文件修改

**外部 Builder 模式**（用户选择时）：

- backend 模型 + `$BACKEND/builder.md` — 有完整写权限，直接写代码到文件系统
- 支持 `codex`、`antigravity`、`grok`、`kimi` 与 `opencode`
- backend 为 `claude` 时使用 Agent Teams，不启动 wrapper
- Claude 监控进度，准备 GPT、Grok 审查材料并协调已确认问题的修复
- 适用于 M-L 复杂度、低中风险的明确实施任务

## 3. 调用模板

仅 Antigravity 在 `[routing.proxy]` 显式配置 `antigravity` / `agy` 和代理 URL 时，才由 `~/.claude/bin/codeagent-wrapper` 注入代理。Codex、Claude、Grok、Kimi 与 OpenCode 不走代理。

### 获取工作目录

先确定当前工作目录（不可从 $HOME 推断）：

```
WORKDIR=$(pwd)
```

### 新会话调用

在构造命令前，根据选定 backend 添加对应的可选 model flag：

| Backend | routing 字段 | CLI 参数 |
|---|---|---|
| `grok` | `grokModel` | `--grok-model <model>` |
| `kimi` | `kimiModel` | `--kimi-model <model>` |
| `opencode` | `opencodeModel` | `--opencode-model <provider/model>` |

其它 backend 不添加 model flag。随后以完成替换的命令启动 wrapper：

```
Bash({
  command: "~/.claude/bin/codeagent-wrapper {{LITE_MODE_FLAG}}--progress --backend <MODEL_AND_OPTIONAL_FLAG> - \"$WORKDIR\" <<'CODEAGENT_EOF'\nROLE_FILE: ~/.claude/.ccg/prompts/$MODEL/$ROLE.md\n<TASK>\n$TASK_CONTENT\n</TASK>\nOUTPUT: $OUTPUT_FORMAT\nCODEAGENT_EOF",
  run_in_background: true,
  timeout: 3600000,
  description: "$SHORT_DESCRIPTION"
})
```

变量说明：

- `$MODEL`：选定的模型名（`codex` / `claude` / `antigravity` / `grok` / `kimi` / `opencode`）
- `$ROLE`：角色文件名（`analyzer` / `architect` / `reviewer` / `debugger` / `optimizer` / `tester` / `builder`）
- `$TASK_CONTENT`：任务内容（需求 + 上下文）
- `$OUTPUT_FORMAT`：期望输出格式
- `$SHORT_DESCRIPTION`：简短描述（用于进度显示）

纯 Claude Code 模式不填写 `$MODEL`，直接按第 1b 节创建独立 Claude Agent。

### 复用会话调用

此调用只适用于非审查任务。审查 profile 使用 `--no-session-persistence`，因此不得加入 `resume <SESSION_ID>`。其它任务沿用新会话调用的 backend 和 model flag 选择规则，仅在 task 前加入 `resume <SESSION_ID>`：

```
Bash({
  command: "~/.claude/bin/codeagent-wrapper {{LITE_MODE_FLAG}}--progress --backend <MODEL_AND_OPTIONAL_FLAG> resume $SESSION_ID - \"$WORKDIR\" <<'CODEAGENT_EOF'\nROLE_FILE: ~/.claude/.ccg/prompts/$MODEL/$ROLE.md\n<TASK>\n$TASK_CONTENT\n</TASK>\nOUTPUT: $OUTPUT_FORMAT\nCODEAGENT_EOF",
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

- 非审查任务可捕获 `Session-ID: xxx`，保存为 `BACKEND_SESSION`、`FRONTEND_SESSION` 后通过 `resume $SESSION_ID` 复用
- 审查任务不返回或保存可复用的 session，必须传入完整 diff、完整文件上下文和验收规则
