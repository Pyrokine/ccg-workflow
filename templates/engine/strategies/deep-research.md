# Strategy: Deep Research — 深度研究

> 适用于技术方案研究、对比分析。多模型并行探索，结构化输出。

## 适用条件

- 用户提出研究/分析/对比类问题
- 不涉及代码修改（纯研究）
- 任何复杂度级别

## 前置加载

```
Read("~/.claude/.ccg/engine/model-router.md")
```

---

## 工作流状态机

[phase-state:1-clarify]
当前阶段：明确研究问题
📍 Next: 问题明确后启动多模型探索
[/phase-state:1-clarify]

[phase-state:2-explore]
当前阶段：多模型并行探索
Gate: 研究问题已明确 ✓
📍 Next: 双模型结果返回后进入综合
[/phase-state:2-explore]

[phase-state:3-synthesize]
当前阶段：综合分析
Gate: 双模型探索已返回 ✓
📍 Next: 输出结构化报告后进入讨论
[/phase-state:3-synthesize]

[phase-state:4-discuss]
当前阶段：交互式讨论
📍 Next: 用户满意后结束
[/phase-state:4-discuss]

---

## 阶段详情

### Phase 1: 明确问题 [required]

1. 解析用户的研究意图：
    - 要研究什么？
    - 研究目的是什么？（做决策？了解现状？评估可行性？）
    - 有什么约束或偏好？

2. 如果问题太宽泛，先收窄：
   ```
   📋 研究范围
     问题: [明确的研究问题]
     目的: [决策/了解/评估]
     约束: [时间/技术/资源约束]
   ```
3. 确认后使用 `update-requirements` 更新研究契约，再用 `checkpoint` 记录 `1-clarify`

### Phase 2: 多模型并行探索 [required]

使用 `checkpoint` 更新为 `2-explore`，下一动作设为“双模型并行探索”。

**并行调用**（`run_in_background: true`）：

- **backend 模型**：analyzer 角色
  ```
  <TASK>
  需求：研究分析 [问题]
  上下文：[项目上下文、技术栈、约束]
  </TASK>
  OUTPUT: 技术分析报告（可行性、架构选项、风险、成本估算）
  ```
- **frontend 模型**：analyzer 角色
  ```
  <TASK>
  需求：研究分析 [问题]
  上下文：[项目上下文、用户场景、约束]
  </TASK>
  OUTPUT: 用户/体验视角分析（UX 影响、用户流程、设计选项）
  ```

等待双模型返回。返回后重新 `resolve`，确认 active task 和 revision 未变化。

### Phase 3: 综合分析

**Gate check**: 双模型探索已返回

交叉对比双方视角。

使用 `write-artifact` 将双模型原始分析分别写入 `research/backend-analysis.md` 和 `research/frontend-analysis.md`。每次调用后使用响应中的新 task revision。随后用 `checkpoint` 更新为 `3-synthesize`，下一动作设为“综合研究结论”。

输出结构化报告：

```
📋 研究报告: [主题]

## 选项对比

| 维度 | 方案 A | 方案 B | 方案 C |
|------|--------|--------|--------|
| 概述 | ... | ... | ... |
| 优势 | ... | ... | ... |
| 劣势 | ... | ... | ... |
| 复杂度 | S/M/L | S/M/L | S/M/L |
| 风险 | low/mid/high | ... | ... |
| 预估工期 | ... | ... | ... |

## 推荐

**推荐方案 [X]**
理由：[简明理由]

## 注意事项
- [关键风险或注意点]
```

### Phase 4: 交互式讨论

用户可以：

- 追问某个方案的细节
- 要求更深入分析某个方面
- 要求 POC / 原型验证
- 确认结论并结束

```
📍 研究已完成。如需实施推荐方案，可以用 /ccg:go implement [方案描述]
```

讨论结束后用 `checkpoint` 记录 `4-discuss`。本研究未改变项目规范时，用 `set-spec-evolution` 记录 `not_applicable`，然后调用 `finish` 标记为 `completed`。后续实施创建新任务，不复用已完成的研究任务。

---

## 铁律

- **纯研究模式，不做代码修改** — 除非用户明确要求 POC
- **结果必须结构化输出** — 表格对比，不是自由聊天
- **必须给出推荐** — 不可只列选项不做判断
- **双模型探索必须并行** — 独立视角更有价值
