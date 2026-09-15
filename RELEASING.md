# Releasing CCG

This repository publishes source releases on GitHub. It does not publish to npm, and `package.json` must keep `"private": true`.

## Version rules

The package version has the form `X.Y.Z-aug.N`:

- `X.Y.Z` follows the upstream package version currently absorbed by this fork
- `N` increases for each fork release based on that upstream version
- published version tags are immutable; a release error requires a new `aug.N`

The package version must match in `package.json`, the README footers, the current `CHANGELOG.md` heading, the root plugin manifests, and other user-visible version metadata.

`codeagent-wrapper` has its own version. A Go wrapper change must update both `codeagent-wrapper/main.go` and `EXPECTED_BINARY_VERSION` in `src/utils/installer.ts`. Its `X.Y.Z` follows the absorbed upstream wrapper version, while fork changes increase only the `aug.N` suffix.

## Tags and releases

Each package release uses one annotated tag named `vX.Y.Z-aug.N`. The tag must point to a commit whose `package.json` version is `X.Y.Z-aug.N`, and it must have one ordinary GitHub Release with the same name. Package releases contain source metadata only; they do not carry wrapper binaries.

`preset` is separate from package version history. It is a mutable prerelease used only for the six precompiled `codeagent-wrapper` binaries. `.github/workflows/build-binaries.yml` owns that tag, Release, and its assets. Do not create, move, delete, or upload `preset` assets manually.

`.github/workflows/release-versions.yml` accepts only annotated `vX.Y.Z-aug.N` tags in this repository. It verifies the tag target and package version before creating a missing GitHub Release.

## Required checks

Run these checks from the repository root before a release:

```bash
git status --short
git diff --stat
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

Run the release-specific checks as well:

```bash
rg -n -- "--backend gemini|templates/prompts/gemini|GeminiBackend|syncMcpToGemini" src templates codeagent-wrapper dsh-ccg package.json
find . -maxdepth 3 -type d -name true
git ls-files 'true/*'
```

The Gemini search must return no active-path matches. The directory and tracked-file checks must return no `true/` entries.

Review the worktree, staged diff, commits to be pushed, tag metadata, release text, and generated assets for organization-only names, private endpoints, real home-directory paths, personal company addresses, credentials, cookies, authorization headers, and other non-public identifiers. Clone-local untracked files belong in `.git/info/exclude`, not the shared `.gitignore`; do not use `skip-worktree` or `assume-unchanged` as ignore mechanisms.

## Release procedure

1. Update package and wrapper versions where required, then update `CHANGELOG.md`, both READMEs, and plugin metadata
2. Run every required check and review the complete diff
3. Obtain explicit approval before committing, pushing, creating a tag, or changing a GitHub Release
4. Push the release commit to `main`
5. Create an annotated `vX.Y.Z-aug.N` tag on that commit and push only that tag
6. Confirm that the version Release workflow created the matching ordinary Release with no binary assets
7. If the wrapper changed, wait for the binary workflow and verify all six `preset` assets report `EXPECTED_BINARY_VERSION`

Never use `git push --all`, `git push --tags`, or `git push --mirror` for a release. Push only the intended branch and tag refs
