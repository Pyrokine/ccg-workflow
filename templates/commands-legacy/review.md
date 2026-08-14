---
description: '多模型代码审查：GPT、Grok 双路交叉验证'
---

# Review - 多模型代码审查

GPT、Grok 两个 reviewer 并行交叉验证。无参数时自动审查当前 git 变更。

## 使用方法

```bash
/review [代码或描述]
```

- **无参数**：自动审查 `git diff HEAD`
- **有参数**：审查指定代码或描述

## 审查范围

1. 通过 Bash 获取 `{{WORKDIR}}`，Unix 使用 `pwd`，Windows CMD 使用 `cd`
2. 无参数时读取 `git diff HEAD`、`git status --short` 和完整变更文件
3. 有参数时读取指定代码或描述关联的完整文件
4. 调用 `{{MCP_SEARCH_TOOL}}` 获取必要上下文

## GPT、Grok 双 profile 审查

在同一条消息中发起 GPT、Grok 两个 `Bash` 调用，均使用 `run_in_background: true`。每个调用带入完整 diff、相关文件上下文和验收规则。主 Claude 只编排调用和汇总结果。

所有 reviewer 使用同一个角色提示词：

```text
ROLE_FILE: ~/.claude/.ccg/prompts/claude/reviewer.md
<TASK>
审查以下代码变更：
<git diff 内容 + 完整文件上下文>
</TASK>
OUTPUT: 按 Critical/Warning/Info 分类列出问题。每项包含文件、行号、描述和修复建议。
```

| reviewer | wrapper 参数 | 审查重点 |
| --- | --- | --- |
| GPT | `--backend claude --no-session-persistence --claude-model {{REVIEW_GPT_MODEL}} --claude-effort {{REVIEW_GPT_EFFORT}}` | 后端逻辑、正确性、安全、回归与测试缺口 |
| Grok | `--backend claude --no-session-persistence --claude-model {{REVIEW_GROK_MODEL}} --claude-effort {{REVIEW_GROK_EFFORT}}` | 前端交互、可访问性、设计一致性与前端安全 |

示例：

```text
Bash({
  command: "~/.claude/bin/codeagent-wrapper {{LITE_MODE_FLAG}}--progress --backend claude --no-session-persistence --claude-model {{REVIEW_GPT_MODEL}} --claude-effort {{REVIEW_GPT_EFFORT}} - \"{{WORKDIR}}\" <<'EOF'\nROLE_FILE: ~/.claude/.ccg/prompts/claude/reviewer.md\n<TASK>审查以下代码变更：\n<完整 git diff 和文件上下文>\n</TASK>\nOUTPUT: Critical/Warning/Info JSON 报告\nEOF",
  run_in_background: true,
  timeout: 3600000,
  description: "GPT review"
})
```

在同一条消息中追加 Grok 调用。使用 `TaskOutput` 等待两个结果。

GPT 与 Grok 使用独立临时会话，因此禁止使用 `resume`、保存或复用 reviewer 的 `SESSION_ID`。单个 reviewer 失败时最多重试两次，之后只报告该 reviewer 不可用。

## 综合反馈

1. 合并 GPT、Grok 两份报告并去重
2. 按 Critical / Warning / Info 分级
3. 每条 finding 标注 GPT、Grok 或质量关卡来源
4. Critical finding 必须回到当前源码确认后才能修复

```markdown
## 代码审查报告

### Critical
1. [GPT] `file.ts:42` — 问题描述

### Warning
1. [Grok] `file.ts:88` — 问题描述

### Info
1. [GPT] `file.ts:20` — 问题描述
```

## 关键规则

1. 无参数时审查 `git diff HEAD`
2. 两个 reviewer 都完成后才能综合
3. reviewer 不写文件
4. 不将某个 reviewer 的结果归入其它来源
