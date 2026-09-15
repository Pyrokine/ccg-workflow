---
description: '需求 → 约束集（并行探索 + OPSX 提案）'
---

<!-- CCG:SPEC:RESEARCH:START -->

**Core Philosophy**

- Research produces **constraint sets**, not information dumps. Each constraint narrows the solution space.
- Constraints tell subsequent stages "don't consider this direction," enabling mechanical execution without decisions.
- Output: 约束集合 + 可验证的成功判据 (constraint sets + verifiable success criteria).
- Strictly adhere to OPSX rules when writing spec-structured documents.

**Guardrails**

- **STOP! BEFORE ANY OTHER ACTION**: You MUST perform Prompt Enhancement FIRST. This is NON-NEGOTIABLE.
- **NEVER** divide subagent tasks by roles (e.g., "架构师agent", "安全专家agent").
- **ALWAYS** divide by context boundaries (e.g., "user-related code", "authentication logic").
- Each subagent context must be self-contained with independent output.
- Use `{{MCP_SEARCH_TOOL}}` to minimize grep/find operations.
- Do not make architectural decisions—surface constraints that guide decisions.
- **USER GUIDANCE RULE**: When suggesting next steps to the user, ALWAYS use CCG commands (`/ccg:spec-research`,
  `/ccg:spec-plan`, `/ccg:spec-impl`, `/ccg:spec-review`). NEVER suggest `/opsx:*` commands to the user. If OpenSpec CLI
  returns error messages referencing OPSX skills, translate them to CCG equivalents.
- **PHASE BOUNDARY**: This phase ONLY generates the OPSX proposal artifact. Do NOT modify any source code. Do NOT
  proceed to planning or implementation. After the proposal is generated, STOP and inform the user: "Research complete.
  Run `/ccg:spec-plan` to continue."

**Steps**

0. **MANDATORY: Enhance Requirement FIRST**
   - **DO THIS IMMEDIATELY. DO NOT SKIP.**
   - **Prompt 增强**（按 `/ccg:enhance` 的逻辑执行）：分析 $ARGUMENTS 的意图、缺失信息、隐含假设，补全为结构化需求（明确目标、技术约束、范围边界、验收标准）。
   - Use enhanced prompt for ALL subsequent steps.

1. **Generate OPSX Change**
   - Check if change already exists:
     ```bash
     openspec list --json
     ```
   - If change doesn't exist, create it:
     ```bash
     openspec new change "<brief-descriptive-name>"
     ```
   - This scaffolds `openspec/changes/<name>/` with proposal.md.
   - If change already exists, continue with existing change.

2. **Establish Persistent CCG Task**
   - Resolve task state before codebase exploration:
     ```bash
     WORKDIR=$(pwd)
     node ~/.claude/hooks/ccg/task-state.js resolve --root "$WORKDIR" --session-key "$CCG_SESSION_KEY"
     ```
   - `CCG_SESSION_KEY` comes from the current Claude Code `SessionStart` Hook. Stop on a missing or invalid key; never fall back to a worktree-global task pointer.
   - Use only the controller result. Do not select a task by directory name, mtime, branch, or conversation summary.
   - Reuse an active task only when both `task.scope` and `requirements.md` identify the exact OpenSpec change and
     `openspec/changes/<change_id>/`. If another task is active in this session, ask the user to choose `interrupt`, `replace`, or another
     worktree. On `selection-required`, activate only an unclaimed matching task; a claimed task requires explicit user-approved `takeover`.
     Stop on `migration-required`, `recovery-required`, or `invalid` until the controller state is resolved.
   - When no matching task exists, create one with `start`. Derive complexity and risk from the enhanced requirement;
     include the exact change ID in both `scope` and `requirements`:
     ```bash
     node ~/.claude/hooks/ccg/task-state.js start --root "$WORKDIR" --session-key "$CCG_SESSION_KEY" <<'CCG_TASK_JSON'
     {
       "expected": {
         "stateId": null,
         "stateRevision": 0,
         "bindingRevision": 0,
         "activeTaskId": null
       },
       "mode": "activate",
       "task": {
         "id": "openspec-<change_id>",
         "title": "Implement OpenSpec change <change_id>",
         "strategy": "full-collaborate",
         "complexity": "<S|M|L|XL>",
         "risk": "<low|medium|high>",
         "domain": "<domain>",
         "scope": "OpenSpec change: <change_id>; artifacts: openspec/changes/<change_id>/",
         "currentPhase": "1-requirements",
         "nextAction": "Research constraints and generate proposal.md",
         "gate": null,
         "specEvolution": "pending"
       },
       "requirements": "# Requirements\n\n## Objective\nResearch, plan, implement, review, and archive OpenSpec change <change_id>.\n\n## Scope\nopenspec/changes/<change_id>/\n\n## Constraints\n<enhanced constraints>\n\n## Acceptance criteria\n<verifiable criteria>\n"
     }
     CCG_TASK_JSON
     ```
   - Derive the task ID from the change ID as strict kebab-case and keep the complete ID within 80 characters.
   - Replace every placeholder and every `expected` value with current data. Save the returned state revision, binding
     revision, active task ID, and task revision; every later controller mutation must use the latest successful response.
     The durable task status remains `open`; the current session sees effective status `in_progress`.

3. **Initial Codebase Assessment**
   - Use `{{MCP_SEARCH_TOOL}}` to scan codebase.
   - Determine project scale: single vs multi-directory structure.
   - **Decision**: If multi-directory → enable parallel Explore subagents.

4. **Define Exploration Boundaries (Context-Based)**
   - Identify natural context boundaries (NOT functional roles):
     - Subagent 1: User domain code (models, services, UI)
     - Subagent 2: Auth & authorization (middleware, session, tokens)
     - Subagent 3: Infrastructure (configs, deployments, builds)
   - Each boundary should be self-contained: no cross-communication needed.

5. **Parallel Exploration**
   - 当 `{{BACKEND_PRIMARY}}` 与 `{{FRONTEND_PRIMARY}}` 都是 Claude 时，在同一条消息中创建两个独立 Claude Code Agent。后端 Agent 的 prompt 包含 `CCG_ROLE: research`，探索后端边界；前端 Agent 的 prompt 也包含 `CCG_ROLE: research`，探索前端边界。不得调用 codeagent-wrapper 或任何外部 CLI。
   - 只有用户已将某条 primary route 明确配置为 Codex、Antigravity、Grok、Kimi Code 或 OpenCode 时，才按 `model-router.md` 为该条 route 调用 wrapper。primary route 为 Claude 时仍创建 Claude Code Agent。
   - 两个 Agent 或外部 route 必须在同一条消息中启动。等待所有结果后再综合。

   **Output Template** (instruct both Agents or explicit external routes to use this format):

   ```json
   {
     "module_name": "context boundary explored",
     "existing_structures": ["key patterns found"],
     "existing_conventions": ["standards in use"],
     "constraints_discovered": ["hard constraints limiting solution space"],
     "open_questions": ["ambiguities requiring user input"],
     "dependencies": ["cross-module dependencies"],
     "risks": ["potential blockers"],
     "success_criteria_hints": ["observable success behaviors"]
   }
   ```

   外部 route 返回 task ID 时使用 `TaskOutput` 等待。Claude Code Agent 完成后由运行时通知，禁止轮询。

   外部 frontend route 失败时最多重试 2 次，间隔 5 秒。外部 backend route 的结果必须等待；超时后继续轮询，禁止跳过。

6. **Aggregate and Synthesize**
   - Collect all subagent outputs.
   - Merge into unified constraint sets:
     - **Hard constraints**: Technical limitations, patterns that cannot be violated
     - **Soft constraints**: Conventions, preferences, style guides
     - **Dependencies**: Cross-module relationships affecting implementation order
     - **Risks**: Blockers needing mitigation

7. **User Interaction for Ambiguity Resolution**
   - Compile prioritized list of open questions.
   - Use `AskUserQuestion` tool to present systematically:
     - Group related questions
     - Provide context for each
     - Suggest defaults when applicable
   - Capture responses as additional constraints.

8. **Finalize OPSX Proposal**
   - **BEFORE calling `/opsx:continue`** (internal skill call — do NOT expose this command to user), output a
     structured summary for OPSX context:

     ```markdown
     ## Research Summary for OPSX

     **Discovered Constraints**:

     - [List all hard and soft constraints from Step 6]

     **Dependencies**:

     - [List cross-module dependencies]

     **Risks & Mitigations**:

     - [List identified risks and mitigation strategies]

     **Success Criteria**:

     - [List verifiable success behaviors]

     **User Confirmations**:

     - [List all user decisions from Step 7]
     ```

   - Then call `/opsx:continue` internally to generate proposal artifact:
     ```
     /opsx:continue
     ```
   - The OPSX skill will use the above summary to write proposal.md.
   - **Note**: This is an internal call. If this step fails, guide the user to re-run `/ccg:spec-research`.
   - Read the generated `openspec/changes/<change_id>/proposal.md`. Select only unique exact headings whose complete
     sections define scope, constraints, dependencies, exclusions, or success criteria.
   - Each selected file must already be tracked or staged. If the proposal is untracked, checkpoint the task with gate
     `spec_artifacts_must_be_tracked`, list the exact file, and use `AskUserQuestion` with these choices:
     - `Stage listed artifacts` — tell the user to run `git add -- <exact-files>` and rerun `/ccg:spec-research`
     - `Keep untracked and stop` — leave the task open and stop
       The command must never run `git add` automatically.
   - For every selected heading, call `link-spec` with the latest state/binding/task revision and current session key. Use the literal project-relative
     path, exact heading text, a specific purpose, and roles `research`, `implement`, `review`, and `debug`. After each
     response, use its new task revision for the next link. Do not scan a directory or copy the section into `.ccg`.
   - After all links succeed, call `checkpoint` with gate `null`, phase `2-research-complete`, and next action
     `Run /ccg:spec-plan for OpenSpec change <change_id>`.
   - **STOP**: After proposal is generated and linked, inform user:
     "Research phase complete. Proposal generated. Run `/ccg:spec-plan` to continue planning."
     Do NOT proceed to planning or implementation.

9. **Context Checkpoint**
   - Report current context usage.
   - If approaching 80K tokens, suggest: "Run `/clear` and continue with `/ccg:spec-plan`"

**Reference**

- OPSX CLI: `openspec status --change "<id>" --json`, `openspec list --json`
- Check prior research: `ls openspec/changes/*/`
- Use `AskUserQuestion` for ANY ambiguity—never assume or guess

<!-- CCG:SPEC:RESEARCH:END -->
