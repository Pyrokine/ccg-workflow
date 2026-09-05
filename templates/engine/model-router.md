# CCG 模型路由器 — 运行时模型选择框架

> 本文件由策略文件通过 Read 加载，提供动态模型选择和 codeagent-wrapper 调用模板。

## 1. 获取模型配置

读取用户配置确定可用模型：

```
Read ~/.claude/.ccg/config.toml
```

从 `[routing]` 区块提取：

- `frontend.models` / `frontend.primary` — 前端候选模型及首选模型，默认 `claude`
- `backend.models` / `backend.primary` — 后端候选模型及首选模型，默认 `claude`
- `review.profiles` — 显式请求外部审查时使用的 GPT、Grok profile 列表
- `grokModel` — Grok CLI 可选型号
- `kimiModel` — Kimi 可选型号，留空时使用 Kimi CLI 自身默认值
- `opencodeModel` — OpenCode 可选 `provider/model`
- `proxy` — 可选代理配置，仅 `antigravity` / `agy` 可注入

模型可为 `codex`、`claude`、`antigravity`、`grok`、`kimi` 或 `opencode`。配置文件缺失或不可读时，使用默认路由。

Gemini CLI 已禁用：2026-06-18 后 consumer OAuth 请求不再处理。不要选择 `gemini`，旧配置中的 `gemini` 会迁移为 `grok`；`agy` 是 `antigravity` 的别名。

## 1b. 纯 Claude Code 模式

当 `frontend.primary` 与 `backend.primary` 都是 `claude` 时：

- 不调用 `codeagent-wrapper`，也不启动外部 CLI 执行前端或后端工作
- 分析与 Builder 工作改由 Claude Code Agent 或 Agent Teams 完成
- 分别创建独立上下文的 Agent，分配后端或前端视角
- 常规审查使用独立 Claude Code Agent；仅用户明确请求 GPT、Grok、双模型审查或 `/ccg:spec-review` 时调用外部 profile
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

- 默认创建独立 Claude Code Agent 审查完整 diff、相关文件和验收规则，不调用外部 CLI
- 用户明确请求 GPT、Grok、双模型审查或 `/ccg:spec-review` 时，按 `review.profiles` 启动对应外部 reviewer
- 外部 reviewer 都通过 `~/.claude/bin/codeagent-wrapper --backend claude` 启动，实际 provider 与当前 Claude Code 相同
- GPT 负责后端逻辑、正确性、安全、回归和测试缺口，Grok 负责前端交互、可访问性、设计一致性和前端安全
- GPT 与 Grok 使用各自 profile 中的 `model` 和 `effort`，默认值分别是 `gpt-5.6-sol` / `xhigh` 与 `grok-4.5` / `high`
- 外部 reviewer 都传 `--no-session-persistence`，每次审查独立且不可 `resume`
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

- backend 模型 + `$BACKEND/builder.md` 只在已审批计划分配的文件范围内写代码
- Hook 将 active task、完整任务契约和按角色匹配的精确 spec section 注入实际 wrapper stdin
- Builder 必须核对 task ID 和 revision；dispatch 或 plan 与 authoritative spec 冲突时停止并报告
- 支持 `codex`、`antigravity`、`grok`、`kimi` 与 `opencode`
- backend 为 `claude` 时使用 Agent Teams，不启动 wrapper
- Claude 监控进度，准备 Claude Code 审查材料；用户明确请求外部审查时再准备对应 profile 材料
- 适用于 M-L 复杂度、低中风险的明确实施任务

## 3. 调用模板

仅 Antigravity 在 `[routing.proxy]` 显式配置 `antigravity` / `agy` 和代理 URL 时，才由 `~/.claude/bin/codeagent-wrapper` 注入代理。Codex、Claude、Grok、Kimi 与 OpenCode 不走代理。

### 获取工作目录

先确定当前工作目录（不可从 $HOME 推断）：

```
WORKDIR=$(pwd)
```

### 显式外部 route 的新会话调用

以下调用只适用于用户已明确配置为 Codex、Antigravity、Grok、Kimi Code 或 OpenCode 的 primary route。根据选定 backend 添加对应的可选 model flag：

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

- `$MODEL`：已明确配置的外部模型名（`codex` / `antigravity` / `grok` / `kimi` / `opencode`）
- `$ROLE`：角色文件名（`analyzer` / `architect` / `reviewer` / `debugger` / `optimizer` / `tester` / `builder`）
- `$TASK_CONTENT`：任务内容（需求 + 上下文）
- `$OUTPUT_FORMAT`：期望输出格式
- `$SHORT_DESCRIPTION`：简短描述（用于进度显示）

纯 Claude Code 模式不填写 `$MODEL`，直接按第 1b 节创建独立 Claude Agent。

### 显式外部 route 的会话复用

此调用只适用于已明确配置的外部 route 的非审查任务。审查 profile 使用 `--no-session-persistence`，因此不得加入 `resume <SESSION_ID>`。其它外部任务沿用新会话调用的 backend 和 model flag 选择规则，仅在 task 前加入 `resume <SESSION_ID>`：

```
Bash({
  command: "~/.claude/bin/codeagent-wrapper {{LITE_MODE_FLAG}}--progress --backend <MODEL_AND_OPTIONAL_FLAG> resume $SESSION_ID - \"$WORKDIR\" <<'CODEAGENT_EOF'\nROLE_FILE: ~/.claude/.ccg/prompts/$MODEL/$ROLE.md\n<TASK>\n$TASK_CONTENT\n</TASK>\nOUTPUT: $OUTPUT_FORMAT\nCODEAGENT_EOF",
  run_in_background: true,
  timeout: 3600000,
  description: "$SHORT_DESCRIPTION"
})
```

### 条件双视角调用模式

默认创建 backend Claude Code Agent。只有任务明确涉及前端、布局、界面、页面设计、UI/UX 时，才同时创建 frontend Claude Code Agent。两个 Agent 都使用独立上下文，不调用 codeagent-wrapper 或任何外部 CLI。

用户已将某条 primary route 明确配置为 Codex、Antigravity、Grok、Kimi Code 或 OpenCode 时，才按该 route 的配置启动外部 CLI。混合路由中，Claude route 仍使用 Agent，外部 route 才使用 wrapper。外部 route 返回 task ID 时使用 `TaskOutput` 等待；Agent 完成后由运行时通知。

## 4. 等待与重试规则

| 场景 | 策略 |
|---|---|
| Claude Code Agent 运行中 | 等待完成通知，不轮询 |
| 显式配置的外部 route 失败 | 重试最多 2 次，间隔 5s |
| 显式配置的外部 route 仍失败 | 报告失败，不自动切换到另一个 CLI |
| 外部 route 超时 | 600s 等待上限，超时后报告并询问用户 |

## 5. SESSION_ID 管理

- 非审查任务可捕获 `Session-ID: xxx`，保存为 `BACKEND_SESSION`、`FRONTEND_SESSION` 后通过 `resume $SESSION_ID` 复用
- 审查任务不返回或保存可复用的 session，必须传入完整 diff、完整文件上下文和验收规则
