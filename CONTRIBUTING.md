# Contributing to CCG

## Development setup

### Prerequisites

- Node.js 22.13+ or 24.19.0+; see `.node-version`
- pnpm 11 through Corepack
- Go 1.26+ when changing `codeagent-wrapper`

### Build and test

```bash
git clone https://github.com/Pyrokine/ccg-workflow.git
cd ccg-workflow
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm test
```

The main source areas are:

```text
src/                    TypeScript CLI and installers
templates/              Commands, runtime hooks, prompts, skills, and rules
codeagent-wrapper/      Go wrapper source
dsh-ccg/                DeepSeek Harness plugin
.github/workflows/      CI and GitHub Release automation
```

## Development workflow

1. Open or claim an issue that describes the change
2. Create a focused branch with `git switch -c <name>`
3. Follow the existing code and test style in the affected module
4. Update user-facing documentation when behavior changes
5. Run the checks listed below
6. Commit with a Conventional Commits subject
7. Push the branch and open a pull request

Use these commit prefixes: `feat`, `fix`, `docs`, `test`, `refactor`, and `chore`.

A pull request should address one concern, include tests for changed behavior, and explain any user-visible compatibility effect.

## Required checks

```bash
git diff --check
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm build
go -C codeagent-wrapper test ./...
go -C codeagent-wrapper build -o /dev/null .
node bin/ccg.mjs --help
```

Go checks are required for wrapper changes. The other checks apply to every pull request.

## Public-content hygiene

Tracked code, tests, fixtures, documentation, workflows, examples, commit metadata, and release material must be suitable for a public repository. Do not include organization-only names, private service addresses, real local home-directory paths, company email addresses, access tokens, cookies, authorization headers, or credential fragments.

Use neutral fixtures such as `module-alpha`, `/home/user/`, and `USER`. Keep clone-local untracked paths in `.git/info/exclude`; `skip-worktree` and `assume-unchanged` are not ignore mechanisms.

Repository maintenance instructions and local task state do not belong in commits. Do not commit project-maintainer `CLAUDE.md` files, `.ccg/`, local `.claude/` state, task contracts, plans, review artifacts, transcripts, migration data, or history-rewrite backups. Runtime templates that are intentionally shipped by the product remain part of the source tree.

## Releases

Maintainers must follow [RELEASING.md](./RELEASING.md). Committing, pushing, tagging, and changing GitHub Releases require explicit approval for that release operation.

## Reporting issues

Use the [issue tracker](https://github.com/Pyrokine/ccg-workflow/issues) for reproducible defects and feature proposals. Include the affected version, platform, command, expected behavior, and the smallest safe reproduction
