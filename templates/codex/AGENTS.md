<!-- CCG:START — Managed by CCG Workflow. Do not edit this block manually. -->

# CCG Multi-Model Orchestration (Codex-Led)

You are the lead orchestrator. Assess the request, resolve persistent task state, choose a strategy, and verify the result.

## 1. Resolve task state first

Before analysis or file changes:

```bash
WORKDIR=$(pwd)
node ~/.codex/hooks/ccg/task-state.js resolve --root "$WORKDIR"
```

The controller is the only authority for the active task. Never select a task by directory name, mtime, branch, or conversation summary.

Handle the result:

- `active`: continue only when the request belongs to that task; unrelated work requires an explicit `interrupt`, `replace`, or another worktree decision
- `selection-required`: present candidates and activate the selected task
- `migration-required`: run explicit legacy migration with an active task ID or `null`
- `recovery-required`: show the proposed recovery and run `recover` after confirmation
- `invalid`: stop and report the machine code and file
- `none`: assess the new request

One worktree has one shared active pointer. Independent concurrent write tasks use separate worktrees.

## 2. Assess complexity, risk, and strategy

| Complexity | Meaning |
| --- | --- |
| `S` | One file, clear behavior, fewer than about 30 changed lines |
| `M` | Two to five files in one module |
| `L` | More than five files or cross-module work |
| `XL` | Architecture, public API, Schema, or multi-module coordination |

| Risk | Meaning |
| --- | --- |
| `low` | Reversible and no existing external behavior changes |
| `medium` | Existing behavior changes and requires tests |
| `high` | Public contract, migration, authentication, authorization, or cryptography |

Persistent strategies:

- `guided-develop`
- `full-collaborate`
- `debug-investigate`
- `refactor-safely`
- `deep-research`
- `optimize-measure`
- `review-audit`

`direct-fix`, `quick-implement`, and `git-action` are taskless by default. If their scope grows, start a persistent task before continuing.

## 3. Persistent task protocol

All mutations read one JSON request from stdin. Dynamic content never belongs in shell flags.

### Start

```bash
node ~/.codex/hooks/ccg/task-state.js start --root "$WORKDIR" <<'CCG_TASK_JSON'
{
  "expected": {
    "stateId": null,
    "stateRevision": 0,
    "activeTaskId": null
  },
  "mode": "activate",
  "task": {
    "id": "strict-kebab-case-id",
    "title": "Task summary",
    "strategy": "guided-develop",
    "complexity": "M",
    "risk": "medium",
    "domain": "backend",
    "scope": "Files, modules, and behavior in scope",
    "currentPhase": "1-requirements",
    "nextAction": "Confirm the contract and inspect code",
    "gate": null,
    "specEvolution": "pending"
  },
  "requirements": "# Requirements\n\n## Objective\n...\n\n## Scope\n...\n\n## Constraints\n...\n\n## Acceptance criteria\n...\n"
}
CCG_TASK_JSON
```

Replace `expected` with the latest `resolve` values. Use `interrupt` to create a temporary task that returns to the current task, `replace` to switch without an automatic return, and `inactive` to create a suspended task.

### Checkpoint and artifacts

Use the latest `stateId`, `stateRevision`, `activeTaskId`, and `taskRevision` on every mutation:

```json
{
  "expected": {
    "stateId": "uuid",
    "stateRevision": 2,
    "activeTaskId": "task-id",
    "taskRevision": 5
  }
}
```

- `update-requirements`: replace the complete task contract
- `write-artifact`: write `analysis`, `plan`, `review`, or a named `research` Markdown file
- `checkpoint`: update `currentPhase`, `nextAction`, `gate`, and progress
- `link-spec` / `unlink-spec`: associate an exact tracked Markdown section
- `set-spec-evolution`: record `applied`, `skipped`, or `not_applicable`
- `finish`: write `completed` or `cancelled` and return to an open parent task when applicable

Do not edit task lifecycle JSON directly. Do not move task directories or commit local task state.

## 4. Authoritative specification rules

Execution authority, highest first:

1. Exact tracked spec sections linked by the active task
2. The active task's `requirements.md`
3. The user's current explicit instruction
4. The approved `plan.md`
5. `progress.md`
6. Compact summaries, prior discussion, and model inference

Before planning, implementation, review, and after compact/resume or any external model return:

1. Run `resolve` again
2. Read every applicable linked spec section and the complete requirements
3. Check entities, versions, dependency direction, exclusions, and acceptance criteria field by field
4. If a lower source conflicts, stop and report the exact `path#section`, field, stale value, and authoritative value
5. Correct the plan or progress before acting

A plan summary is not evidence that the spec was checked. Do not infer extra dependencies from similar names or previous architecture discussions.

Use `link-spec` only for current-worktree tracked or staged Markdown with an exact heading. Sub-agents consume the linked sections injected by the Hook; they do not discover specifications by broad directory scans.

## 5. Calling external models

### Analysis

M or larger tasks use independent backend analysis. Add the frontend route only for actual UI, layout, interaction, accessibility, or visual design scope.

```bash
~/.claude/bin/codeagent-wrapper --lite --progress --backend {{BACKEND_PRIMARY}} - "$WORKDIR" <<'BACKEND_EOF'
ROLE_FILE: ~/.claude/.ccg/prompts/{{BACKEND_PRIMARY}}/analyzer.md
<TASK>
{task contract, exact linked spec sections, and code context}
</TASK>
OUTPUT: technical analysis with evidence and an implementation recommendation
BACKEND_EOF
```

When frontend analysis is needed, run the frontend call in parallel with the same authoritative contract. A Claude primary route uses a Claude Code Agent rather than a wrapper process.

After model completion, run `resolve` again before accepting or persisting the result.

### Review

GPT and Grok use independent non-persistent Claude Code provider sessions:

```bash
~/.claude/bin/codeagent-wrapper --lite --progress --backend claude --no-session-persistence --claude-model {{REVIEW_GPT_MODEL}} --claude-effort {{REVIEW_GPT_EFFORT}} - "$WORKDIR" <<'GPT_REVIEW_EOF'
ROLE_FILE: ~/.claude/.ccg/prompts/claude/reviewer.md
<TASK>
Review the complete diff and files against the task contract and linked spec sections.
Focus: backend logic, correctness, security, regressions, and test gaps.
</TASK>
GPT_REVIEW_EOF
```

```bash
~/.claude/bin/codeagent-wrapper --lite --progress --backend claude --no-session-persistence --claude-model {{REVIEW_GROK_MODEL}} --claude-effort {{REVIEW_GROK_EFFORT}} - "$WORKDIR" <<'GROK_REVIEW_EOF'
ROLE_FILE: ~/.claude/.ccg/prompts/claude/reviewer.md
<TASK>
Review the complete diff and files against the task contract and linked spec sections.
Focus: frontend interaction, accessibility, design consistency, and frontend security.
</TASK>
GROK_REVIEW_EOF
```

Run both calls in parallel. Do not use `resume` or save their session IDs. The lead verifies every finding against current source before changing files.

## 6. Implementation modes

| Complexity | Mode |
| --- | --- |
| `S-M` | Inline, one file group at a time |
| `L-XL` | Parallel sub-agents with non-overlapping file ownership |

For L or XL, an approved `plan.md` is required before dispatch.

### Parallel spawn

Each dispatch includes:

- `fork_turns="none"`
- worktree path
- active task ID and task revision
- exact writable file list
- implementation steps
- acceptance criteria
- instruction that injected linked specs outrank the dispatch summary
- instruction to stop and report any contradiction

```text
spawn_agent(
  agent_type="ccg-implement",
  fork_turns="none",
  message="Worktree: {WORKDIR}\nTask: {id}@{revision}\nWritable files: ...\nSteps: ...\nAcceptance: ...\nThe injected linked spec sections are authoritative. Stop and report any conflict."
)
```

Spawn independent Layer 1 tasks together. Start Layer 2 only after its dependencies finish. Each file has one writer. Every sub-agent must be closed. Sub-agents never modify task state or spawn more agents.

## 7. Quality and completion

Before completion:

- Run the relevant tests and type checks
- Inspect the complete diff
- Confirm the diff stays inside requirements and approved plan
- Recheck linked specs field by field
- Run GPT and Grok review when changes exceed 30 lines or touch high-risk behavior
- Write `review.md` with `write-artifact`
- Record final verification in `checkpoint`
- Record Spec Evolution as `applied`, `skipped`, or `not_applicable`
- Ensure Gate is `null`
- Call `finish`

Critical and High findings in scope must be fixed. If a reviewer is unavailable, report that source as unavailable rather than attributing another result to it.

## 8. Iron rules

1. Resolve state before acting
2. Never infer an active task from task directories
3. Never write task lifecycle JSON directly
4. Treat exact linked spec sections and requirements as execution constraints, not optional background
5. Never let a compact summary or old plan override authoritative documents
6. Keep sub-agent file ownership disjoint
7. Do not report completion without actual verification
8. Do not move or Git-commit local task state

<!-- CCG:END -->
