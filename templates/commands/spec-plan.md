---
description: '多模型分析 → 消除歧义 → 零决策可执行计划'
---

<!-- CCG:SPEC:PLAN:START -->

**Core Philosophy**

- The goal is to eliminate ALL decision points—implementation should be pure mechanical execution.
- Every ambiguity must be resolved into explicit constraints before proceeding.
- Multi-model collaboration surfaces blind spots and conflicting assumptions.
- Every requirement must have Property-Based Testing (PBT) properties—focus on invariants.

**Guardrails**

- Do not proceed to implementation until every ambiguity is resolved.
- Multi-model collaboration is **mandatory**: use both {{BACKEND_PRIMARY}} and {{FRONTEND_PRIMARY}}.
- If constraints cannot be fully specified, escalate to user or return to research phase.
- Refer to `openspec/config.yaml` for project conventions.
- **USER GUIDANCE RULE**: When suggesting next steps to the user, ALWAYS use CCG commands (`/ccg:spec-research`,
  `/ccg:spec-plan`, `/ccg:spec-impl`, `/ccg:spec-review`). NEVER suggest `/opsx:*` commands to the user. If OpenSpec CLI
  returns error messages referencing OPSX skills, translate them to CCG equivalents.
- **TASKS FORMAT RULE**: When generating or modifying `tasks.md`, ALL tasks MUST use checkbox format (
  `- [ ] X.Y description`). Heading+bullet format will cause OpenSpec CLI to parse 0 tasks and block the workflow.
- **PHASE BOUNDARY**: This phase ONLY generates OPSX artifacts (specs.md, design.md, tasks.md). Do NOT modify any source
  code. Do NOT proceed to implementation. After artifacts are generated, STOP and inform the user: "Plan complete. Run
  `/ccg:spec-impl` to start implementation."

**Steps**

1. **Select Change**
   - Run `openspec list --json` to display Active Changes.
   - Confirm with user which change ID to refine.
   - Run `openspec status --change "<change_id>" --json` to review current state.

2. **Resolve Persistent CCG Task and Authority**
   - Resolve from the current worktree:
     ```bash
     WORKDIR=$(pwd)
     node ~/.claude/hooks/ccg/task-state.js resolve --root "$WORKDIR" --session-key "$CCG_SESSION_KEY"
     ```
   - `CCG_SESSION_KEY` must come from the current Claude Code session. Continue only when that session's result is `active`, `task.scope` identifies `OpenSpec change: <change_id>`, and
     `requirements.md` identifies `openspec/changes/<change_id>/`. Do not infer a match from branch, task directory, or
     conversation history.
   - Run an authority snapshot before analysis:
     ```bash
     node ~/.claude/hooks/ccg/task-state.js snapshot --root "$WORKDIR" --mode authority --role research --session-key "$CCG_SESSION_KEY"
     ```
   - Require a valid task contract and at least one matching exact `specRef` under
     `openspec/changes/<change_id>/`. On missing, invalid, selection, migration, or recovery state, stop and direct the
     user to `/ccg:spec-research` or the controller action named by the error.
   - Save the current state revision, binding revision, active task ID, and task revision. Every mutation below uses the latest successful response and `--session-key "$CCG_SESSION_KEY"`.

3. **Implementation Analysis (PARALLEL)**
   - 当 `{{BACKEND_PRIMARY}}` 与 `{{FRONTEND_PRIMARY}}` 都是 Claude 时，在同一条消息中创建两个独立 Claude Code Agent。后端 Agent 的 prompt 包含 `CCG_ROLE: research`，分析实现方案、技术风险、替代架构和边界条件；前端 Agent 的 prompt 也包含 `CCG_ROLE: research`，分析可维护性、扩展性和集成冲突。不得调用 codeagent-wrapper 或任何外部 CLI。
   - 只有用户已将某条 primary route 明确配置为 Codex、Antigravity、Grok、Kimi Code 或 OpenCode 时，才按 `model-router.md` 为该条 route 调用 wrapper。primary route 为 Claude 时仍创建 Claude Code Agent。
   - 两个 Agent 或外部 route 必须在同一条消息中启动。外部 route 返回 task ID 时使用 `TaskOutput` 等待；Claude Code Agent 完成后由运行时通知，禁止轮询。
   - 外部 frontend route 失败时最多重试 2 次，间隔 5 秒。外部 backend route 的结果必须等待；超时后继续轮询，禁止跳过。

   - Synthesize responses and present consolidated options to user.

4. **Uncertainty Elimination Audit**
   - **{{BACKEND_PRIMARY}}**: "Review proposal for unspecified decision points. List each
     as: [AMBIGUITY] → [REQUIRED CONSTRAINT]"
   - **{{FRONTEND_PRIMARY}}**: "Identify implicit assumptions. Specify: [ASSUMPTION] → [EXPLICIT CONSTRAINT NEEDED]"

   **Anti-Pattern Detection** (flag and reject):
   - Information collection without decision boundaries
   - Technical comparisons without selection criteria
   - Deferred decisions marked "to be determined during implementation"

   **Target Pattern** (required for approval):
   - Explicit technology choices with parameters (e.g., "JWT with TTL=15min")
   - Concrete algorithm selections with configs (e.g., "bcrypt cost=12")
   - Precise behavioral rules (e.g., "Lock account 30min after 5 failed attempts")

   Iterate with user until ALL ambiguities resolved.

5. **PBT Property Extraction**
   - **{{BACKEND_PRIMARY}}**: "Extract PBT properties. For each requirement: [INVARIANT] → [FALSIFICATION STRATEGY]"
   - **{{FRONTEND_PRIMARY}}**: "Define system
     properties: [PROPERTY] | [DEFINITION] | [BOUNDARY CONDITIONS] | [COUNTEREXAMPLE GENERATION]"

   **Property Categories**:
   - **Commutativity/Associativity**: Order-independent operations
   - **Idempotency**: Repeated operations yield same result
   - **Round-trip**: Encode→Decode returns original
   - **Invariant Preservation**: State constraints maintained
   - **Monotonicity**: Ordering guarantees (e.g., timestamps increase)
   - **Bounds**: Value ranges, size limits, rate constraints

6. **Update OPSX Artifacts**
   - **BEFORE calling `/opsx:continue`** (internal skill call — do NOT expose this command to user), output a
     structured summary for OPSX context:

     ```markdown
     ## Planning Summary for OPSX

     **Multi-Model Analysis Results**:

     - {{BACKEND_PRIMARY}} (Backend): [Key findings and recommendations]
     - {{FRONTEND_PRIMARY}} (Frontend): [Key findings and recommendations]
     - Consolidated Approach: [Selected implementation strategy]

     **Resolved Constraints**:

     - [All explicit constraints from Step 4]

     **PBT Properties**:

     - [All extracted properties from Step 5 with falsification strategies]

     **Technical Decisions**:

     - [All finalized technology choices, algorithms, configurations]

     **Implementation Tasks**:

     - [High-level task breakdown ready for tasks.md]
     ```

   - Then call `/opsx:continue` internally to generate next artifacts:
     ```
     /opsx:continue
     ```
   - The OPSX skill will use the above summary to create specs.md, design.md, and tasks.md.
   - **Note**: This is an internal call. If this step fails, guide the user to re-run `/ccg:spec-plan`.
   - Read the generated Markdown under `openspec/changes/<change_id>/`. Select unique exact headings whose complete
     sections define behavior, design constraints, task scope, exclusions, invariants, or acceptance criteria.
   - Every selected file must already be tracked or staged. If any selected artifact is untracked, checkpoint the task
     with gate `spec_artifacts_must_be_tracked`, list only those exact files, and use `AskUserQuestion` with these choices:
     - `Stage listed artifacts` — tell the user to run `git add -- <exact-files>` and rerun `/ccg:spec-plan`
     - `Keep untracked and stop` — leave the task open and stop
       The command must never run `git add` automatically.
   - Link every selected section with `link-spec`, literal project-relative path, exact heading, specific purpose, and
     roles `research`, `implement`, `review`, and `debug`. Use the task revision returned by one link in the next call.
     Do not link an entire file implicitly and do not scan a directory.
   - Re-run `snapshot --mode authority --role implement`. Continue only when it is valid and contains at least one exact
     section from the current change. Then checkpoint with gate `null`, phase `4-plan-complete`, and next action
     `Run /ccg:spec-impl for OpenSpec change <change_id>`.
   - **STOP**: After artifacts are generated and linked, inform user:
     "Plan phase complete. Artifacts generated: specs.md, design.md, tasks.md. Run `/ccg:spec-impl` to start
     implementation."
     Do NOT proceed to modify source code.

7. **Context Checkpoint**
   - Report current context usage.
   - If approaching 80K tokens, suggest: "Run `/clear` and continue with `/ccg:spec-impl`"

**Exit Criteria**
A change is ready for implementation only when:

- [ ] All multi-model analyses completed and synthesized
- [ ] Zero ambiguities remain (verified by step 4 audit)
- [ ] All PBT properties documented with falsification strategies
- [ ] Artifacts (specs, design, tasks) generated via OpenSpec skills
- [ ] User has explicitly approved all constraint decisions

**Reference**

- Inspect change: `openspec status --change "<id>" --json`
- List changes: `openspec list --json`
- Search patterns: `rg -n "INVARIANT:|PROPERTY:" openspec/`
- Use `AskUserQuestion` for ANY ambiguity—never assume

<!-- CCG:SPEC:PLAN:END -->
