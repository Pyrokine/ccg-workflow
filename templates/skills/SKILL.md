---
name: ccg-skills
description: >-
  CCG Skills - Quality gates, documentation generator, and multi-agent orchestration. Auto-installed
  by CCG workflow system.
license: MIT
user-invocable: false
disable-model-invocation: false
---

# CCG Skills

## Directory Structure

```
skills/
├── tools/            # Quality gate tools
│   ├── verify-security/   # Security vulnerability scanning
│   ├── verify-quality/    # Code quality checking
│   ├── verify-change/     # Change analysis & doc sync
│   ├── verify-module/     # Module completeness validation
│   ├── gen-docs/          # README.md & DESIGN.md generator
│   └── lib/               # Shared utilities
├── orchestration/    # Multi-agent coordination
│   └── multi-agent/       # Ant colony-inspired coordination
├── run_skill.js      # Unified skill runner
└── SKILL.md          # This file
```

## Quick Navigation

| Category          | Description                                               | Entry                                     |
| ----------------- | --------------------------------------------------------- | ----------------------------------------- |
| **Quality Gates** | Module completeness, security, quality, change validation | [Quality Gates](#quality-gates)           |
| **Multi-Agent**   | Multi-agent coordination and task decomposition           | [Multi-Agent](#multi-agent-orchestration) |

---

## Quality Gates

Apply all matching triggers to the complete feature stage and combine them into one acceptance pass after
implementation.
Keep targeted checks needed to reproduce a problem or validate intermediate behavior.

Reuse evidence while the candidate, inputs, toolchain, arguments, configuration, and coverage remain applicable. After a
repair, rerun only affected checks. Continue independent checks when another fails, and preserve failed, timed-out,
unavailable, unsupported, and incomplete results. Confirm findings against source and callers, fix confirmed issues
within
the authorized repair scope, and finish when acceptance criteria are met. Read-only reviews report findings without
edits.

| Skill                  | Trigger                                                     | Description                                   |
| ---------------------- | ----------------------------------------------------------- | --------------------------------------------- |
| `/ccg:verify-module`   | New module completed                                        | Module structure & documentation completeness |
| `/ccg:verify-security` | New module / security changes / refactoring                 | Security vulnerability scanning               |
| `/ccg:verify-change`   | Code changes >30 lines / design-level changes / refactoring | Document sync & change impact analysis        |
| `/ccg:verify-quality`  | Code changes >30 lines / complex modules / refactoring      | Code quality metrics checking                 |
| `/ccg:gen-docs`        | New module created                                          | README.md & DESIGN.md skeleton generator      |

Language checks use the target project's ESLint and TypeScript, Ruff, clang-tidy, Go vet, or Cargo/Clippy. Native file
inventories determine coverage; platform or cfg exclusions remain incomplete. Go and Rust run offline and require
existing
project metadata and cached dependencies. Go reuses a CCG-only private persistent build cache, keeps the original user
GOCACHE unchanged, and isolates temporary workspace and module resources. If that cache cannot be used safely, the
report
explains why and the check uses its temporary cache path. Rust uses temporary build output; each Go or Rust check group
keeps its 120 s budget. C/C++ security rules cover credentials, dynamic shell commands, and unbounded input. Related
documentation is checked in the selected Git mode even when it is outside the requested source paths.

### Auto-trigger Rules

```
New module:     /ccg:gen-docs → develop → /ccg:verify-module → /ccg:verify-security
Code changes:   develop → /ccg:verify-change → /ccg:verify-quality
Security tasks: execute → /ccg:verify-security
Refactoring:    refactor → /ccg:verify-change → /ccg:verify-quality → /ccg:verify-security
```

### Running Skills

```bash
# Unified runner
node ~/.claude/skills/ccg/run_skill.js <skill-name> [args...]

# Examples
node ~/.claude/skills/ccg/run_skill.js verify-security ./src
node ~/.claude/skills/ccg/run_skill.js verify-quality ./src -v
node ~/.claude/skills/ccg/run_skill.js verify-change --mode staged
node ~/.claude/skills/ccg/run_skill.js verify-change src --mode committed --base v1 --target-ref v2
node ~/.claude/skills/ccg/run_skill.js verify-module ./my-module
node ~/.claude/skills/ccg/run_skill.js gen-docs ./new-module --force
```

---

## Multi-Agent Orchestration

| Skill         | Trigger                                 | Description                                  |
| ------------- | --------------------------------------- | -------------------------------------------- |
| `multi-agent` | TeamCreate, parallel tasks, multi-agent | Ant colony-inspired multi-agent coordination |

The main session is the default executor. Delegate only for independent work with a clear benefit, material or tool
isolation, high-risk independent verification, or a user request. File count alone does not require delegation. Set
scope,
total agents, maximum depth, budget, stop condition, deduplication key, and output format before dispatch; ordinary
subagents remain leaves.

Provides:

- Agent role system (Lead/Scout/Worker/Soldier/Drone)
- Pheromone-based indirect communication
- File ownership locking & conflict avoidance
- Adaptive concurrency control
- TeamCreate vs single-agent decision tree

---

## Installed by CCG

These skills are automatically installed during `npx ccg-workflow` initialization. To update: run
`npx ccg-workflow update` or `npx ccg-workflow` again.
