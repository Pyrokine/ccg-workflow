# Strategy: Review Audit — 代码审查

> 适用于代码审查需求，由 GPT、Grok 两路独立审查交叉验证，结果分级输出。

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
📍 Next: 范围确定后启动GPT、Grok 双路审查
[/phase-state:1-scope]

[phase-state:2-review]
当前阶段：GPT、Grok 双路审查
Gate: 审查范围已确定 ✓
📍 Next: GPT、Grok 双路审查返回后综合报告
[/phase-state:2-review]

[phase-state:3-report]
当前阶段：综合报告
Gate: GPT、Grok 双路审查已返回 ✓
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

### Phase 2: GPT、Grok 双路审查 [required]

**Gate check**: 审查范围已确定

在同一条消息中并行启动 GPT、Grok 两个 `Bash` 调用。两个 reviewer 都接收完整 `git diff`、完整文件上下文和验收规则，互不依赖彼此的会话或结果。GPT 的任务文本必须列出后端审查维度，Grok 的任务文本必须列出前端审查维度。主 Claude 只负责准备上下文和汇总发现。

```text
ROLE_FILE: ~/.claude/.ccg/prompts/claude/reviewer.md
<TASK>
审查以下代码变更。
上下文：[git diff + 完整文件上下文]
按 Critical/Warning/Info 输出，每条包含位置、问题和修复建议。
</TASK>
```

| reviewer | wrapper 参数 | 审查重点 |
| --- | --- | --- |
| GPT | `--backend claude --no-session-persistence --claude-model {{REVIEW_GPT_MODEL}} --claude-effort {{REVIEW_GPT_EFFORT}}` | 后端逻辑、正确性、安全、回归与测试缺口 |
| Grok | `--backend claude --no-session-persistence --claude-model {{REVIEW_GROK_MODEL}} --claude-effort {{REVIEW_GROK_EFFORT}}` | 前端交互、可访问性、设计一致性与前端安全 |

GPT 与 Grok 使用独立临时会话，禁止使用 `resume` 或保存 `SESSION_ID`。两者的 model、effort 从 `review.profiles` 注入。若外部 reviewer 失败，只报告该 reviewer 不可用，不能将其它结果归入该来源。

等待两个调用返回后再综合报告。

### Phase 3: 综合报告 + 质量关卡

**Gate check**: GPT、Grok 双路审查已返回

#### 3a. 质量关卡

**⛔ 必须逐个调用 Skill，不可跳过：**

- 调用 Skill `ccg:verify-security` — 等待报告
- 调用 Skill `ccg:verify-quality` — 等待报告

#### 3b. 综合报告

合并 GPT、Grok reviewer 发现与质量关卡结果，去重，按严重度分级：

```
📋 代码审查报告

## Critical（必须修复）
1. [file:line] — [问题描述]
   建议: [具体修复建议]
   来源: [GPT/Grok/质量关卡]

## Warning（建议修复）
1. [file:line] — [问题描述]
   建议: [具体修复建议]

## Info（供参考）
1. [file:line] — [观察/建议]

---
总计: [N] Critical, [M] Warning, [K] Info
```

如果有 Critical 发现，询问用户是否立即修复（可切换到 `direct-fix` 策略）。

#### Spec Evolution（审查完成后执行）

参考 `phase-guide.md § 8 Spec Evolution Protocol` 执行：

1. 从审查发现中提炼可复用的编码规范（特别是 Critical/Warning 级反复出现的模式）
2. 如有值得记录的经验 → 草拟 Spec 条目，展示给用户确认后追加到 `.ccg/spec/{domain}/index.md`
3. 无值得提炼的经验 → 跳过

---

## 铁律

- **审查结果必须分级** — 不可笼统说"代码看起来没问题"
- **两个 reviewer 必须独立审查** — 交叉验证的价值在于独立性
- **Critical 必须明确标出** — 不可淡化严重问题
- **如无发现，明确说明** — "经GPT、Grok 双路审查，未发现问题" 优于沉默
