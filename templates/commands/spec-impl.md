---
description: '按规范执行 + 多模型协作 + 归档'
---

<!-- CCG:SPEC:IMPL:START -->

**Core Philosophy**

- Implementation is pure mechanical execution—all decisions were made in Plan phase.
- External model outputs are prototypes only; must be rewritten to production-grade code.
- Keep changes tightly scoped; enforce side-effect review before any modification.
- Minimize documentation—prefer self-explanatory code over comments.

**Guardrails**

- **NEVER** apply 后端/前端模型 prototypes directly—all outputs are reference only.
- **MANDATORY**: Request `unified diff patch` format from external models; they have zero write permission.
- Keep implementation strictly within `tasks.md` scope—no scope creep.
- Refer to `openspec/config.yaml` for conventions.
- **USER GUIDANCE RULE**: When suggesting next steps to the user, ALWAYS use CCG commands (`/ccg:spec-research`,
  `/ccg:spec-plan`, `/ccg:spec-impl`, `/ccg:spec-review`). NEVER suggest `/opsx:*` commands to the user. If OpenSpec CLI
  returns error messages referencing OPSX skills, translate them to CCG equivalents.
- **TASKS FORMAT RULE**: When generating or modifying `tasks.md`, ALL tasks MUST use checkbox format (
  `- [ ] X.Y description`). Heading+bullet format will cause OpenSpec CLI to parse 0 tasks and block the workflow.

**Steps**

1. **Select Change**
   - Run `openspec list --json` to inspect Active Changes.
   - Confirm with user which change ID to implement.
   - Run `openspec status --change "<change_id>" --json` to review tasks.

2. **Resolve Persistent CCG Task and Authority**
   - Resolve from the current worktree:
     ```bash
     WORKDIR=$(pwd)
     node ~/.claude/hooks/ccg/task-state.js resolve --root "$WORKDIR" --session-key "$CCG_SESSION_KEY"
     ```
   - `CCG_SESSION_KEY` must come from the current Claude Code session. Continue only when that session's result is `active`, `task.scope` identifies `OpenSpec change: <change_id>`, and
     `requirements.md` identifies `openspec/changes/<change_id>/`. Do not infer task identity from branch, directory name,
     mtime, prior plan, or conversation summary.
   - Load current implementation authority:
     ```bash
     node ~/.claude/hooks/ccg/task-state.js snapshot --root "$WORKDIR" --mode authority --role implement --session-key "$CCG_SESSION_KEY"
     ```
   - Require a valid non-empty task contract and at least one matching exact `specRef` under
     `openspec/changes/<change_id>/`. Stop on missing, oversized, changed, ambiguous, selection, migration, or recovery
     state. Direct the user to `/ccg:spec-plan` when artifacts or links are missing.
   - Before every Agent or `codeagent-wrapper` dispatch, rebuild this authority snapshot. PreToolUse injects the same
     current authority into the real prompt or heredoc. After a foreground Agent, wrapper, or TaskOutput result, the
     PostToolUse Hook refreshes authority for the next model decision; then re-run `resolve` with the same session key and verify the task identity,
     binding revision, and task revision before any controller mutation. Every mutation uses `--session-key "$CCG_SESSION_KEY"`.

3. **Apply OPSX Change (Pre-flight Check)**
   - Call `/opsx:apply` internally to enter implementation mode:
     ```
     /opsx:apply
     ```
   - This will load the change context and guide you through the tasks defined in `tasks.md`.
   - **Note**: This is an internal call. If this step fails, guide the user to re-run `/ccg:spec-impl`.
   - **HARD GATE**: Check the returned `state` field:
     - If `state: "blocked"` → STOP immediately. Inform the user which artifacts are missing and suggest: "Run
       `/ccg:spec-plan` to generate missing artifacts first."
     - If `progress.total === 0` → STOP immediately. Inform: "tasks.md has no parseable tasks. Run `/ccg:spec-plan`
       to regenerate."
     - Only proceed to Step 4 when `state: "ready"` and `progress.total > 0`.

4. **Identify Minimal Verifiable Phase**
   - Review `tasks.md` and identify the **smallest verifiable phase**.
   - Do NOT complete all tasks at once—control context window.
   - Announce: "Implementing Phase X: [task group name]"

5. **Route Tasks to Appropriate Model**
   - **Route A: {{FRONTEND_PRIMARY}}** — Frontend/UI/styling (CSS, React, Vue, HTML, components)
   - **Route B: {{BACKEND_PRIMARY}}** — Backend/logic/algorithm (API, data processing, business logic)
   - primary route 为 Claude 时，为每项任务创建 Claude Code Agent。Agent prompt 必须包含 `CCG_ROLE: implement`、任务描述、相关代码上下文和精确 spec 约束。不得调用 codeagent-wrapper 或任何外部 CLI。
   - 只有用户已将相应 primary route 明确配置为 Codex、Antigravity、Grok、Kimi Code 或 OpenCode 时，才按 `model-router.md` 调用 wrapper。

   外部 route 的非审查任务可按配置复用 `SESSION_ID:`。Claude Code Agent 使用独立上下文。Step 8 的外部 reviewer 使用独立临时会话，不复用这些 session。

6. **Rewrite Prototype to Production Code**
   Upon receiving diff patch, **NEVER apply directly**. Rewrite by:
   - Removing redundancy
   - Ensuring clear naming and simple structure
   - Aligning with project style
   - Eliminating unnecessary comments
   - Verifying no new dependencies introduced

7. **Side-Effect Review** (Mandatory before apply)
   Verify the change:
   - [ ] Does not exceed `tasks.md` scope
   - [ ] Does not affect unrelated modules
   - [ ] Does not introduce new dependencies
   - [ ] Does not break existing interfaces

   If issues found, make targeted corrections.

8. **Claude Code Review**
   - Create an independent Claude Code Agent to review the complete diff, changed files, and spec constraints for correctness, regressions, security, and tests.
   - Do not call codeagent-wrapper or another external CLI during this default review.
   - Only when the user explicitly requests GPT, Grok, dual-model review, or `/ccg:spec-review`, use the external review profile workflow. External reviewers use `--no-session-persistence` and do not use `resume` or retain `SESSION_ID`.

   Address any confirmed Critical findings before proceeding.

9. **Update Task Status**
   - Mark completed task in `tasks.md`: `- [x] Task description`.
   - Rebuild `snapshot --mode authority --role implement` after changing a linked section. If its exact heading moved,
     duplicated, disappeared, or exceeded the budget, stop and repair the spec link before another dispatch.
   - Use `checkpoint` with the latest state/binding/task revision to record the completed phase, verification evidence, current
     OpenSpec progress, and next task. Do not edit `.ccg/tasks/*/task.json` or `progress.md` directly.
   - Commit changes only when the user has authorized that Git operation.

10. **Context Checkpoint**

- After completing a phase, report context usage.
- If below 80K: Ask user "Continue to next phase?"
- If approaching 80K: Suggest "Run `/clear` and resume with `/ccg:spec-impl`"

11. **Archive on Completion**
    - When ALL tasks in `tasks.md` are marked `[x]`, save the current exact refs under
      `openspec/changes/<change_id>/`, then unlink them one at a time with `unlink-spec` and the latest task revision. This
      prevents the archive move from leaving the active task with missing authoritative paths.
    - Call `/opsx:archive` internally to archive the change:
      ```
      /opsx:archive
      ```
    - This merges spec deltas to `openspec/specs/` and moves change to archive. If archiving fails, relink the saved
      original refs before stopping and guide the user to re-run `/ccg:spec-impl`.
    - After a successful archive, identify the new literal Markdown paths and their unique exact headings. Link the
      canonical or archived sections that preserve the completed task's constraints. If selected files are untracked,
      checkpoint with gate `spec_artifacts_must_be_tracked` and use `AskUserQuestion`:
      - `Stage listed artifacts` — tell the user to run `git add -- <exact-files>` and rerun `/ccg:spec-impl`
      - `Keep untracked and stop` — leave the task open and stop
        The command must never run `git add` automatically.
    - Rebuild the authority snapshot, record `specEvolution`, clear the gate, and call `finish` only after archive links
      are valid and all exit criteria are satisfied.

**Reference**

- Check task status: `openspec status --change "<id>" --json`
- View active changes: `openspec list --json`
- Search existing patterns: `rg -n "function|class" <file>`

**Exit Criteria**
Implementation is complete when:

- [ ] All tasks in `tasks.md` marked `[x]`
- [ ] All multi-model reviews passed
- [ ] Side-effect review confirmed no regressions
- [ ] Change archived successfully

<!-- CCG:SPEC:IMPL:END -->
