# Strategy: Refactor Safely — 安全重构

> 适用于代码重构，强调增量执行和测试保护。

## 适用条件

- 复杂度 M 或以上
- 重构、整理、提取、简化类任务
- 需要保证行为不变

## 前置加载（L/XL 复杂度时）

```
Read("~/.claude/.ccg/engine/model-router.md")
```

---

## 工作流状态机

[phase-state:1-understand]
当前阶段：理解现有代码
📍 Next: 映射完依赖关系后建立测试基线
[/phase-state:1-understand]

[phase-state:2-baseline]
当前阶段：建立基线
Gate: 代码已理解 ✓
📍 Next: 基线建立后进入规划
[/phase-state:2-baseline]

[phase-state:3-plan]
当前阶段：规划重构步骤
Gate: 测试基线已建立 ✓
📍 Next: 计划确认后逐步执行
[/phase-state:3-plan]

[phase-state:4-execute]
当前阶段：增量执行
Gate: 用户已确认计划 ✓
📍 Next: 每步执行后验证测试通过
[/phase-state:4-execute]

[phase-state:5-verify]
当前阶段：最终验证
Gate: 所有步骤已执行 ✓
📍 Next: 全部测试通过后报告结果
[/phase-state:5-verify]

---

## 阶段详情

### Phase 1: 理解 [required]

使用 `checkpoint` 更新为 `1-understand`，下一动作设为“读取代码，映射依赖”。先逐字段核对 `requirements.md` 和 authoritative spec 中声明的不变量。

1. 读取所有涉及重构的文件
2. 映射依赖关系（谁调用了这些代码？谁被这些代码调用？）
3. 识别公共 API / 接口边界（这些不能轻易改变）
4. 记录当前行为特征

### Phase 2: 建立基线 [required]

1. 运行现有测试：`pnpm test` / `go test` / `pytest` 等
2. 记录测试结果作为基线
3. 如果没有相关测试 → 告知用户，建议但不强制先补测试
4. 输出基线状态：
   ```
   📊 测试基线
     通过: [N] 个
     失败: [M] 个（已有的，非重构引入）
     覆盖: [相关模块的测试覆盖情况]
   ```
5. 使用 `checkpoint` 更新为 `2-baseline`，将基线结果写入 progress，下一动作设为“撰写增量重构计划”

### Phase 3: 规划

制定增量重构计划，每一步应该能独立通过测试：

```
📋 重构计划

## 目标
[重构目标和预期效果]

## 步骤（每步独立可验证）
1. [步骤描述] — 影响文件: [...]
2. [步骤描述] — 影响文件: [...]
...

## 不变量
- [不应该改变的行为/接口]
```

对于 L/XL 任务，可选调用外部模型做架构审查。

使用 `write-artifact` 写入 `plan.md`，再用 `checkpoint` 更新为 `3-plan`，`gate` 设为 `user_approval_required`。展示计划并等待用户确认。用户确认后，用 `checkpoint` 清除 Gate，阶段更新为 `4-execute`。

### Phase 4: 增量执行

实施期间通过 `checkpoint` 把 `nextAction` 写成当前步骤，不直接改任务 JSON。

**逐步执行**，每步之后：

1. 应用变更
2. 运行测试
3. 如果测试通过 → 继续下一步
4. 如果测试失败 → **立即停止**，分析原因，修复或回退

每步报告：

```
Step [N/M]: [描述] — ✅ 测试通过 / ❌ 测试失败
```

### Phase 5: 迭代审查 [Ralph Loop]

1. 运行完整测试套件
2. 对比基线：确保不引入新的失败

参考 `phase-guide.md § 9 Ralph Loop` 执行迭代审查（最多 3 轮）。

#### Round N 流程

**⛔ 审查线程：**

3. 获取变更：`git diff` 全量输出
4. 创建独立 Claude Code 审查 Agent，使用完整 diff、相关文件和验收标准检查正确性、安全、回归与测试缺口，不调用 codeagent-wrapper 或外部 CLI
5. 只有用户明确请求 GPT、Grok、双模型审查或 `/ccg:spec-review` 时，才启动对应外部 review profile。外部 reviewer 使用 `--no-session-persistence`，不使用 `resume` 或 `SESSION_ID`。Lead 汇总并确认 finding

**⛔ 质量关卡（必须逐个调用 Skill，不可跳过，不可用自己的判断替代）：**

6. 调用 Skill `ccg:verify-quality` — 等待报告
7. 调用 Skill `ccg:verify-security` — 等待报告
8. 调用 Skill `ccg:verify-change` — 等待报告

**综合报告**：模型审查 + 质量关卡，按严重度分级

**用户决定（⛔ 必须等待）：**

- 有 Critical → `发现 N 个 Critical 问题。修复后再审一轮？[Y/n]`
- 无 Critical → `审查通过。需要再审一轮？[y/N]`
- 用户选择继续 → 修复后回到 Round N+1
- 用户选择停止 → 退出审查循环

每轮审查写入 `review.md`，使用 `write-artifact` 登记，并通过 `checkpoint` 更新 progress。

9. `git diff` 展示全部变更
10. 对比基线，确认无回归
11. 输出结果：
   ```
   ✅ 重构完成
     步骤: [N] 步全部通过
     变更: [文件数] 文件，[行数] 行
     测试: 基线 [N] 通过 → 重构后 [N] 通过
     审查: [N] 轮，[Critical: N, Warning: N, Info: N]
     📍 Next: /ccg:commit 提交
   ```

#### Spec Evolution 与完成

按 `phase-guide.md § 7` 检查重构模式和架构约定是否需要更新项目已有的 tracked 文档或 OpenSpec，并用 `set-spec-evolution` 记录结果。

完整测试、基线对比和审查完成后，用 `finish` 标记任务为 `completed`。任务目录保持原路径，不移动、不提交 `.ccg/`。

---

## 铁律

- **不可一次性大改** — 必须拆分为增量步骤
- **每步必须验证测试** — 测试失败立即停止
- **保持行为不变** — 除非重构目标明确包含行为变更
- **不扩大范围** — 只重构用户指定的范围
