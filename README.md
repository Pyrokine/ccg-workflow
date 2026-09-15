# CCG - Claude Code + GPT + Grok Collaboration

<div align="center">

<img src="assets/logo/ccg-logo-cropped.png" alt="CCG Workflow" width="400">

[![GitHub stars](https://img.shields.io/github/stars/fengshao1227/ccg-workflow?style=social)](https://github.com/fengshao1227/ccg-workflow)
[![NPM Downloads](https://img.shields.io/npm/dt/ccg-workflow?style=flat-square&color=blue)](https://www.npmjs.com/package/ccg-workflow)
[![npm version](https://img.shields.io/npm/v/ccg-workflow.svg)](https://www.npmjs.com/package/ccg-workflow)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-Compatible-green.svg)](https://claude.ai/code)
[![Tests](https://img.shields.io/badge/Tests-340%20passed-brightgreen.svg)](#)
[![Follow on X](https://img.shields.io/badge/X-@CCG__Workflow-black?logo=x&logoColor=white)](https://x.com/CCG_Workflow)
![star](https://atomgit.com/fengshao1227/ccg-workflow/star/badge.svg)
[![Docs](https://img.shields.io/badge/Docs-ccg.fengshao1227.com-blue?style=for-the-badge&logo=readthedocs&logoColor=white)](https://github.com/Pyrokine/ccg-workflow/)

[简体中文](./README.zh-CN.md) | English | [**Documentation**](https://github.com/Pyrokine/ccg-workflow/)

</div>

## ♥️ Sponsor

[![PackyCode](assets/sponsors/packycode.png)](https://www.packyapi.ai/register?aff=m21P)

[PackyCode](https://www.packyapi.ai/register?aff=m21P) provides dedicated Claude Code and Codex routes through one domain
and API key. The installer can configure Claude Code and register its Codex provider without changing the active provider.

---

[![APIMart](assets/sponsors/apimart.jpg)](https://go.apimart.ai/gh-ccg-workflow)

[APIMart](https://go.apimart.ai/gh-ccg-workflow) sponsors this project and provides image, video, Claude, and GPT APIs.
The installer can configure its Anthropic-compatible endpoint for Claude Code and register its Codex provider. Codex
activation remains an explicit choice.

---

[![NotebookLM Remover](assets/sponsors/notebooklm-remover.png)](https://notebooklmremover.org)

[NotebookLM Remover](https://notebooklmremover.org) — Free browser-local AI watermark remover. Remove NotebookLM
watermarks across video, PDF, PPTX, infographic, podcast, and more. 100% private, works offline.

---

## CCG for DeepSeek Harness: `dsh-ccg`

The bundled `dsh-ccg` plugin brings the same role matrix to
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). It uses the configured `DSH_HOME`, copies the plugin
to a durable local path, and updates only the selected profile manifests.

```bash
npx ccg-workflow dsh install                # Install into every discovered profile
npx ccg-workflow dsh install --profile web  # Install into one profile
npx ccg-workflow dsh list
npx ccg-workflow dsh uninstall
```

See [`dsh-ccg/README.md`](./dsh-ccg/README.md) for its role tools, model panels, and persistent teammates.

---

CCG is a workflow engine for Claude Code. Its default frontend, backend, and review routes use independent Claude Code Agents.
Codex, Antigravity, Grok, Kimi Code, OpenCode, and GPT/Grok external review run only when explicitly requested.

Gemini CLI is disabled because consumer OAuth requests stopped being processed after 2026-06-18. Legacy Gemini routes migrate to Grok; `agy` remains an Antigravity alias.

## What's new in v3.6.7-aug.1

- Package tarballs use an explicit skills whitelist and exclude `templates/skills/domains/security/`; the red-team and pentest reference notes remain available in Git and are still omitted from default installation.
- PackyCode joins APIMart in a shared sponsor registry used by init, the API menu, Codex mode, and uninstall.
- Codex mode merges one managed block into an existing `~/.codex/AGENTS.md`, preserves user Hooks while registering one
  `UserPromptSubmit` command, creates a pre-install backup, and rolls back every target when installation fails. Its
  ownership manifest restores pre-existing same-name runtime files and leaves later user edits untouched during uninstall.
- Sponsor Codex providers are additive, never overwrite existing provider tables or authentication, preserve config file
  permissions, and activate only after an explicit choice. Uninstall removes only provider tables added by that Codex-mode
  installation. Current stable Codex Hook and multi-agent defaults are retained instead of forcing obsolete
  `multi_agent_v2` timeout tables.
- GPT review remains `gpt-5.6-sol / xhigh`; Grok review now defaults to `grok-4.6 / high`, with exact `grok-4.5` defaults
  migrated during install.
- Claude Code can install the skills bundle from this repository as a native plugin. The complete multi-model workflow
  remains available through the installer.
- `bt-panel`, `seo-page-builder`, and `adsense-site-auditor` add focused web operations workflows.
- `frontend-design` is the single direct design entry and uses 20 Impeccable playbooks internally.
- `dsh-ccg` installs the role matrix into DeepSeek Harness profiles and respects `DSH_HOME`.
- Codex sub-agents skip MCP startup by default. `/ccg:codex-exec` opts in only for retrieval-capable executor calls.
- The task controller refreshes exact specification authority on every user prompt and after foreground external results.

## What's new in v3.0

v3.0 is a ground-up rewrite. One command replaces 29.

- `/ccg:go` — Describe what you want in plain language. The engine analyzes your intent, picks the right strategy, and
  executes it.
- **Hook engine** — User prompts receive a bounded task breadcrumb. Startup, resume, clear, and compact restore the current session's complete task contract, artifacts, and exact linked spec sections; fork starts with a new unbound session identity.
- **Task persistence** — Each worktree stores shared tasks plus opaque per-session bindings. Durable task status remains `open`, `completed`, or `cancelled`; an open task claimed by the current session is exposed as `in_progress`. State, binding, and task revisions reject stale concurrent writes.
- **Agent Teams** — Large tasks spawn parallel Builder teammates via TeamCreate. Each Builder gets isolated file
  ownership.
- **Quality gates** — `ccg:verify-security`, `ccg:verify-quality`, `ccg:verify-change` run as Skill invocations inside strategy
  verification phases.
- **Domain knowledge hooks** — When your message mentions security, caching, RAG, etc., the relevant knowledge file is
  auto-injected into context.
- **Model routing** — Frontend and backend default to independent Claude Code Agents. Codex, Antigravity, Grok, Kimi Code, and OpenCode run only when explicitly selected; Grok, Kimi Code, and OpenCode CLI routes can each use an optional model name.
- **Cross-model review** — Explicit GPT, Grok, dual-model review, and `/ccg:spec-review` use the configured Claude Code provider in separate non-persistent print sessions. `routing.review.profiles` configures their provider-side model and effort independently of the Grok CLI route.
- **Pure Claude Code mode** — This is the default. Independent Claude Code Agents or Agent Teams handle frontend, backend, and review work without wrapper calls.
- **Codex-Led Mode** — Use Codex CLI as the lead orchestrator only when explicitly selected. Install via menu option `X`.

## Quick Start

```bash
npx ccg-workflow
```

Requires Node.js 22.13+ or 24.19.0+ and Claude Code CLI. Codex CLI, Antigravity CLI, Grok CLI, Kimi Code CLI, and OpenCode CLI are optional for frontend and backend routing.

The installer walks through 4 steps: API config, model routing, MCP tools, performance mode. New users get a streamlined
2-step flow with sensible defaults.

## How it works

```
You: /ccg:go add JWT authentication to this API

CCG Engine:
  1. Reads project context (git status, tech stack, file structure)
  2. Classifies: feature / L complexity / backend / high risk
  3. Selects strategy: full-collaborate
  4. Creates .ccg/state.json + a session binding + .ccg/tasks/add-jwt-auth/
  5. Writes the complete requirements contract and links exact tracked spec sections
  6. Launches independent Claude Code analysis Agents when both perspectives apply
  7. Produces plan → HARD STOP for your approval
  8. Spawns Agent Teams Builders with task ID, revision, file scope, and authoritative specs
  9. Runs quality gates + an independent Claude Code review, then records the final checkpoint

External CLI routes and GPT/Grok cross-review run only when explicitly requested.

Every turn, a hook injects:
  <ccg-state>
  Task: add-jwt-auth [add-jwt-auth]
  Status: in_progress
  Strategy: full-collaborate
  Phase: 4-implementation
  Next: Layer 1 Builders executing
  Revision: state=3, binding=1, task=7
  </ccg-state>
```

## Strategies

The engine picks a strategy based on task type and complexity:

| Strategy          | When                           | External models      | Teams |
| ----------------- | ------------------------------ | -------------------- | ----- |
| direct-fix        | Simple bug, single file        | No                   | No    |
| quick-implement   | Small feature, clear scope     | No                   | No    |
| guided-develop    | Medium feature, needs planning | Explicit route only  | No    |
| full-collaborate  | Complex feature, multi-module  | Explicit route only  | Yes   |
| debug-investigate | Complex bug, unknown cause     | Explicit route only  | No    |
| refactor-safely   | Code restructuring             | Explicit review only | No    |
| deep-research     | Technical research, comparison | Explicit route only  | No    |
| optimize-measure  | Performance optimization       | Optional             | No    |
| review-audit      | Code review                    | Explicit review only | No    |
| git-action        | commit, rollback, branches     | No                   | No    |

Simple tasks run fast with no overhead. Complex tasks get the full engine.

## Commands

v3.0 installs 12 core commands by default. Legacy mode adds 18 more.

### Core

| Command   | Description                                                   |
| --------- | ------------------------------------------------------------- |
| `/ccg:go` | Smart entry — describe what you want, engine handles the rest |

### Git

| Command               | Description               |
| --------------------- | ------------------------- |
| `/ccg:commit`         | Smart conventional commit |
| `/ccg:rollback`       | Interactive rollback      |
| `/ccg:clean-branches` | Clean merged branches     |
| `/ccg:worktree`       | Worktree management       |

### Project

| Command        | Description                  |
| -------------- | ---------------------------- |
| `/ccg:init`    | Initialize project CLAUDE.md |
| `/ccg:context` | Project context management   |

### OpenSpec

| Command              | Description                      |
| -------------------- | -------------------------------- |
| `/ccg:spec-init`     | Initialize OPSX environment      |
| `/ccg:spec-research` | Requirements → constraints       |
| `/ccg:spec-plan`     | Constraints → zero-decision plan |
| `/ccg:spec-impl`     | Execute plan + archive           |
| `/ccg:spec-review`   | GPT/Grok cross-review            |

## Hook Engine

CCG installs a CommonJS Hook runtime and registers four handler scripts across five Hook event types in
`~/.claude/settings.json`:

| Hook                  | Event                                                   | Purpose                                                                                   |
| --------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `workflow-state.js`   | `UserPromptSubmit`, `PostToolUse`, `PostToolUseFailure` | Refresh exact authority on every prompt and after foreground external results             |
| `session-start.js`    | `SessionStart`                                          | Restore the full task snapshot on startup, resume, clear, compact, and fork               |
| `subagent-context.js` | `PreToolUse` for Bash/Agent                             | Modify the actual Agent prompt or wrapper heredoc with role-matched task and spec context |
| `skill-router.js`     | `UserPromptSubmit`                                      | Inject matching domain knowledge                                                          |

`SessionStart` derives an opaque key from the Claude Code `session_id` and exports it through `CLAUDE_ENV_FILE`. Every controller call and authority refresh uses that key. Agent prompts and wrapper heredocs inherit the parent Claude session binding; raw session IDs are not written to state, binding, or turn files.

`task-state.js` is the only task lifecycle writer. Hook input, task files, and spec sections are size-bounded. Invalid task state, missing or oversized authoritative context, and quoted heredocs that cannot be bound to the wrapper command make the `PreToolUse` Hook return `permissionDecision: "deny"`, so the Agent or wrapper does not start without its task contract.

## Task System

Persistent strategies use shared worktree tasks and session-scoped active bindings:

```text
.ccg/
├── state.json                    # stateId and shared structure revision; no active pointer
├── sessions/
│   └── claude-<sha256>.json      # this session's activeTaskId and binding revision
├── state.lock                    # short-lived mutation lock
├── transaction.json             # present only while a multi-file mutation needs recovery
├── tasks/
│   └── add-jwt-auth/
│       ├── task.json             # open/completed/cancelled, task revision, phase, gate, specRefs
│       ├── requirements.md       # required task contract
│       ├── progress.md           # latest successful checkpoint and next action
│       ├── analysis.md           # optional analysis
│       ├── plan.md               # optional approved plan
│       ├── review.md             # optional review result
│       └── research/             # optional research artifacts
├── migrations/                   # byte-preserving state and legacy-task backups
└── historical-artifacts/orphans/ # reversible quarantine for directories without task.json
```

Task files persist only `open`, `completed`, or `cancelled`. When the current session binding points to an open task, the resolver reports effective `in_progress`; other open tasks are `suspended`. One open task is claimed by one session by default, including its open `returnToTaskId` chain. Selecting a claimed task returns `TASK_CLAIMED`; only an explicit takeover transfers the binding. Finishing or recovering a task updates only the calling session's binding. State, binding, and task compare-and-swap revisions reject stale writes, and multi-file updates keep a replayable transaction marker until every atomic replacement succeeds.

When a session has no binding but open tasks remain, the controller returns candidate metadata and requires explicit selection. It does not expose another session key or inject another task's requirements, specifications, or artifacts. This is task-routing isolation, not a filesystem secrecy boundary for processes running as the same operating-system user.

Schema v1 state, legacy tasks, evidenced invalid statuses, and orphan directories use separate explicit migration, repair, and quarantine operations. A former global pointer is retained only as a selection hint and is never assigned automatically. Unfinished legacy tasks remain open, while orphan directories are renamed without reading or classifying their contents. Runtime parent paths must remain ordinary directories inside the worktree; symbolic links are rejected. Branch names and directory timestamps are diagnostic data, never task selectors.

## Specification authority

A task links tracked or staged Markdown sections through structured `specRefs`:

```json
{
  "path": "docs/integration-version-map.md",
  "section": "Merge and dependency rules",
  "purpose": "Defines which repositories merge and which are referenced",
  "roles": ["research", "implement", "review", "debug"]
}
```

The Hook validates the project-relative path, regular-file status, literal Git tracking, unique exact heading outside fenced code blocks, complete bounded section, aggregate context budget, role, and project-root containment. Exact spec sections and `requirements.md` are rendered before optional task artifacts, so the final 32 KiB bound cannot discard the authoritative sources. Broad directory scans and implicit `.ccg/spec/` templates are not used.

Execution authority is: exact linked spec sections, `requirements.md`, the user's current explicit instruction, approved `plan.md`, `progress.md`, then compact summaries or model inference. After compact/resume and external-model returns, the lead must re-resolve state and compare entities, versions, dependency direction, exclusions, and acceptance criteria before acting.

## Local and shared context

| Location                                  | Scope                                                   |
| ----------------------------------------- | ------------------------------------------------------- |
| `.ccg/`                                   | Local runtime for this worktree; ignored by Git         |
| `.context/current/`                       | Local session notes; ignored by Git                     |
| `.context/prefs/` and `.context/history/` | Tracked team conventions and sanitized decision history |
| Project docs and OpenSpec                 | Tracked shared specifications linked by exact section   |

## Skills bundle

The installer and native Claude Code plugin both include these direct skill entries:

| Skill                       | Purpose                                                              |
| --------------------------- | -------------------------------------------------------------------- |
| `/ccg:frontend-design`      | Frontend design entry with 20 internal Impeccable playbooks          |
| `/ccg:bt-panel`             | Deploy and manage sites through the BaoTa/aaPanel HTTP API           |
| `/ccg:seo-page-builder`     | Create and audit SEO tool pages with a runnable on-page audit script |
| `/ccg:adsense-site-auditor` | Check AdSense application readiness and policy requirements          |

Install only the skills bundle from the private fork:

```bash
claude plugin marketplace add Pyrokine/ccg-workflow
claude plugin install ccg@ccg
```

The native plugin does not install wrapper binaries or placeholder-based workflow commands.

## CLI commands

```bash
npx ccg-workflow doctor                   # Environment health check
npx ccg-workflow status                   # Installation and active-task overview
npx ccg-workflow codex-mode install       # Install Codex-led mode
npx ccg-workflow codex-mode uninstall     # Remove Codex-led mode
npx ccg-workflow dsh install              # Install dsh-ccg
npx ccg-workflow dsh list                 # List DSH profile status
npx ccg-workflow dsh uninstall            # Remove dsh-ccg
npx ccg-workflow uninstall                # Uninstall CCG
```

## Configuration

```
~/.claude/
├── commands/ccg/          # Slash commands
├── hooks/ccg/             # Task controller, shared utilities, 4 handlers, 5 event types
├── .ccg/
│   ├── config.toml        # Model routing, MCP, performance
│   ├── engine/            # Strategy files + model router
│   └── prompts/           # Expert prompts (codex/antigravity/claude)
├── skills/ccg/            # Quality gates + domain knowledge
└── bin/codeagent-wrapper  # Multi-model execution bridge
```

### Environment Variables

Set in `~/.claude/settings.json` under `"env"`:

| Variable                               | Default  | Description                                                |
| -------------------------------------- | -------- | ---------------------------------------------------------- |
| `CODEX_TIMEOUT`                        | `7200`   | Wrapper timeout (seconds)                                  |
| `CODEAGENT_POST_MESSAGE_DELAY`         | `5`      | Post-completion delay (seconds)                            |
| `APIMART_API_KEY`                      | unset    | API key used when the APIMart Codex provider is selected   |
| `PACKYCODE_API_KEY`                    | unset    | API key used when the PackyCode Codex provider is selected |
| `DSH_HOME`                             | `~/.dsh` | DeepSeek Harness home used by `dsh-ccg`                    |
| `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` | unset    | Set to `1` to enable Agent Teams parallel execution        |

## Update / Uninstall

```bash
npx ccg-workflow@latest     # Update
npx ccg-workflow            # Select "Uninstall" from menu
```

## Credits

- [cexll/myclaude](https://github.com/cexll/myclaude) — codeagent-wrapper inspiration
- [UfoMiao/zcf](https://github.com/UfoMiao/zcf) — Git tools reference
- [mindfold-ai/Trellis](https://github.com/mindfold-ai/Trellis) — Hook-based workflow state patterns
- [ace-tool](https://linux.do/t/topic/1344562) — MCP code retrieval

## Contributors

<!-- readme: contributors -start -->
<table>
<tr>
    <td align="center"><a href="https://github.com/fengshao1227"><img src="https://avatars.githubusercontent.com/fengshao1227?v=4&s=100" width="100;" alt="fengshao1227"/><br /><sub><b>fengshao1227</b></sub></a></td>
    <td align="center"><a href="https://github.com/SXP-Simon"><img src="https://avatars.githubusercontent.com/SXP-Simon?v=4&s=100" width="100;" alt="SXP-Simon"/><br /><sub><b>SXP-Simon</b></sub></a></td>
    <td align="center"><a href="https://github.com/RebornQ"><img src="https://avatars.githubusercontent.com/RebornQ?v=4&s=100" width="100;" alt="RebornQ"/><br /><sub><b>RebornQ</b></sub></a></td>
    <td align="center"><a href="https://github.com/Sakuranda"><img src="https://avatars.githubusercontent.com/Sakuranda?v=4&s=100" width="100;" alt="Sakuranda"/><br /><sub><b>Sakuranda</b></sub></a></td>
    <td align="center"><a href="https://github.com/Mriris"><img src="https://avatars.githubusercontent.com/Mriris?v=4&s=100" width="100;" alt="Mriris"/><br /><sub><b>Mriris</b></sub></a></td>
    <td align="center"><a href="https://github.com/23q3"><img src="https://avatars.githubusercontent.com/23q3?v=4&s=100" width="100;" alt="23q3"/><br /><sub><b>23q3</b></sub></a></td>
    <td align="center"><a href="https://github.com/MrNine-666"><img src="https://avatars.githubusercontent.com/MrNine-666?v=4&s=100" width="100;" alt="MrNine-666"/><br /><sub><b>MrNine-666</b></sub></a></td>
</tr>
<tr>
    <td align="center"><a href="https://github.com/GGzili"><img src="https://avatars.githubusercontent.com/GGzili?v=4&s=100" width="100;" alt="GGzili"/><br /><sub><b>GGzili</b></sub></a></td>
</tr>
</table>
<!-- readme: contributors -end -->

## Contact

- **X (Twitter)**: [@CCG_Workflow](https://x.com/CCG_Workflow)
- **Email**: [noreply@github.com](mailto:noreply@github.com)
- **Issues**: [GitHub Issues](https://github.com/fengshao1227/ccg-workflow/issues)
- **Community**: [Linux.do](https://linux.do)

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=fengshao1227/ccg-workflow&type=timeline&legend=top-left)](https://www.star-history.com/#fengshao1227/ccg-workflow&type=timeline&legend=top-left)

## License

MIT

---

v3.6.7-aug.1 | [Issues](https://github.com/fengshao1227/ccg-workflow/issues) | [Contributing](./CONTRIBUTING.md)
