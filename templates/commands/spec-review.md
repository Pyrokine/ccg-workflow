---
description: 'GPT、Grok 双路交叉审查'
---

<!-- CCG:SPEC:REVIEW:START -->
**Core Philosophy**

- GPT and Grok provide independent backend and frontend review perspectives.
- Critical findings SHOULD be addressed before proceeding.
- Review validates implementation against spec constraints and code quality.

**Guardrails**

- **MANDATORY**: GPT and Grok reviews must complete before synthesis.
- Review scope is strictly limited to the proposal's changes.
- Reviewers receive the complete diff, relevant files, spec constraints, and PBT properties.
- GPT and Grok use new sessions. Do not use `resume` or retain their `SESSION_ID`.

**Steps**

1. **Select Proposal**
   - Run `openspec list --json` to display active changes.
   - Confirm the proposal ID.
   - Run `openspec status --change "<proposal_id>" --json` to load the spec and tasks.

2. **Collect Implementation Artifacts**
   - Identify files modified by the proposal.
   - Read the complete changed files and `git diff`.
   - Load relevant constraints and PBT properties from `openspec/changes/<id>/specs/`.

3. **GPT and Grok Review (PARALLEL)**
   - Get `{{WORKDIR}}` by executing `pwd` on Unix or `cd` on Windows CMD.
   - Launch GPT and Grok background `Bash` calls in one message with `run_in_background: true`.
   - Each call uses this input format:

   ```text
   ROLE_FILE: ~/.claude/.ccg/prompts/claude/reviewer.md
   <TASK>
   Review proposal <proposal_id> implementation.
   Context: [spec constraints, PBT properties, complete git diff, complete changed files]
   OUTPUT: JSON findings with severity, dimension, file, line, description, violated constraint where applicable, and fix_suggestion.
   </TASK>
   ```

   | External reviewer | wrapper command |
   | --- | --- |
   | GPT | `~/.claude/bin/codeagent-wrapper {{LITE_MODE_FLAG}}--progress --backend claude --no-session-persistence --claude-model {{REVIEW_GPT_MODEL}} --claude-effort {{REVIEW_GPT_EFFORT}} - "{{WORKDIR}}"` |
   | Grok | `~/.claude/bin/codeagent-wrapper {{LITE_MODE_FLAG}}--progress --backend claude --no-session-persistence --claude-model {{REVIEW_GROK_MODEL}} --claude-effort {{REVIEW_GROK_EFFORT}} - "{{WORKDIR}}"` |

   - GPT checks backend logic, correctness, security, regressions, and tests. Grok checks frontend interaction, accessibility, design consistency, and frontend security.
   - Wait for both external tasks. A failed reviewer can retry twice with a five-second interval. After three failures, report only that reviewer as unavailable.

4. **Synthesize Findings**
   - Merge the two reports.
   - Deduplicate equivalent findings.
   - Classify each finding:
     - **Critical**: spec violation, security vulnerability, breaking change.
     - **Warning**: maintainability, pattern, integration, or regression concern.
     - **Info**: optional improvement.

5. **Present Review Report**

   ```text
   ## Review Report: <proposal_id>

   ### Critical
   - [GPT|Grok] file.ts:42 — description

   ### Warning
   - [GPT|Grok] file.ts:88 — description

   ### Info
   - [GPT|Grok] file.ts:20 — description
   ```

6. **Decision Gate**
   - If Critical findings exist, present them and do not archive.
   - If no Critical finding exists, ask whether to archive.

7. **Optional: Inline Fix Mode**
   - Confirm findings against the current source before editing.
   - Re-run the affected review dimensions after a fix.

**Exit Criteria**

- [ ] GPT and Grok reviews completed or the unavailable reviewer was reported.
- [ ] Findings are synthesized and classified.
- [ ] Zero unresolved Critical findings remain.

<!-- CCG:SPEC:REVIEW:END -->
