# Strategy: Review Audit — 代码审查

> 适用于代码审查需求，默认由独立 Claude Code Agent 审查；用户明确请求外部审查时才调用 GPT、Grok profile。

## 适用条件

- 用户请求代码审查
- 任何复杂度级别
- 自动检测 git diff 作为审查范围

## 前置加载

```
Read("~/.claude/.ccg/engine/model-router.md")
```

---

## 工作流状态机

[phase-state:1-scope]
当前阶段：确定审查范围
📍 Next: 范围确定后启动独立 Claude Code 审查
[/phase-state:1-scope]

[phase-state:2-review]
当前阶段：Claude Code 审查
Gate: 审查范围已确定 ✓
📍 Next: 审查返回后综合报告
[/phase-state:2-review]

[phase-state:3-report]
当前阶段：综合报告
Gate: 审查已返回 ✓
📍 Next: 报告输出后等待用户决定
[/phase-state:3-report]

---

## 阶段详情

### Phase 1: 确定审查范围 [required]

1. 如果用户指定了文件/范围 → 使用指定范围
2. 如果未指定 → 自动获取：
    - `git diff HEAD` — 未提交的变更
    - 如果无 diff → `git diff HEAD~1` — 最近一次提交
    - 如果仍无 diff → 询问用户要审查什么
3. 读取变更涉及的完整文件（不只是 diff，需要上下文）

输出审查范围：

```
📋 审查范围
  变更: [N] 文件，[+M/-K] 行
  文件: [文件列表]
```

使用 `checkpoint` 更新为 `1-scope`，把精确范围写入 progress。存在 linked spec 时，把对应 section 作为 reviewer 的验收约束，不用摘要替代。

### Phase 2: Claude Code 审查 [required]

**Gate check**: 审查范围已确定

创建一个独立 Claude Code Agent。Agent 接收完整 `git diff`、完整文件上下文和验收规则，按 Critical/Warning/Info 输出，每条包含位置、问题和修复建议。默认不得调用 codeagent-wrapper 或任何外部 CLI。

用户明确请求 GPT、Grok、双模型审查或 `/ccg:spec-review` 时，才按 `review.profiles` 启动对应外部 reviewer。外部 profile 使用 `--backend claude --no-session-persistence`，GPT 审查后端逻辑、正确性、安全、回归与测试缺口，Grok 审查前端交互、可访问性、设计一致性与前端安全。外部 reviewer 不使用 `resume` 或保存 `SESSION_ID`；失败时只报告该 reviewer 不可用。

审查返回后重新 `resolve`，确认 active task 和 revision 未变化，再用 `checkpoint` 更新为 `2-review`。

### Phase 3: 综合报告 + 质量关卡

**Gate check**: 审查已返回

#### 3a. 质量关卡

**⛔ 必须逐个调用 Skill，不可跳过：**

- 调用 Skill `ccg:verify-security` — 等待报告
- 调用 Skill `ccg:verify-quality` — 等待报告

#### 3b. 综合报告

合并 Claude Code 审查、已显式调用的外部 reviewer 发现与质量关卡结果，去重，按严重度分级：

```
📋 代码审查报告

## Critical（必须修复）
1. [file:line] — [问题描述]
   建议: [具体修复建议]
   来源: [Claude Code/GPT/Grok/质量关卡]

## Warning（建议修复）
1. [file:line] — [问题描述]
   建议: [具体修复建议]

## Info（供参考）
1. [file:line] — [观察/建议]

---
总计: [N] Critical, [M] Warning, [K] Info
```

使用 `write-artifact` 写入 `review.md`，再用 `checkpoint` 更新为 `3-report`。如果有 Critical 发现，询问用户是否立即修复；修复属于新工作时使用 `interrupt` 创建临时任务。

#### Spec Evolution 与完成

按 `phase-guide.md § 7` 检查审查结果是否需要更新项目已有的 tracked 文档或 OpenSpec，并用 `set-spec-evolution` 记录结果。报告交付后调用 `finish` 标记任务为 `completed`。

---

## 铁律

- **审查结果必须分级** — 不可笼统说"代码看起来没问题"
- **默认审查必须使用独立 Claude Code Agent**，不得因审查请求自动启动外部 CLI
- **外部 reviewer 只在用户明确请求时启动**，多个外部 reviewer 必须独立审查
- **Critical 必须明确标出** — 不可淡化严重问题
- **如无发现，明确说明审查来源和范围**
