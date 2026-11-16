# Releasing CCG

This repository publishes source releases on GitHub. Keep `"private": true` in both `package.json` and
`dsh-ccg/package.json`; neither package is published to npm.

## Version rules

The package version has the form `X.Y.Z-aug.N`:

- `X.Y.Z` follows the upstream package version currently absorbed by this fork
- `N` increases for each fork release based on that upstream version
- published version tags are immutable; a release error requires a new `aug.N`

Use this version matrix when preparing the candidate:

| Release unit                | Version declarations                                                                                   | Consumers and matching metadata                                                                                                                              |
| --------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CCG package and root plugin | `package.json`, `.claude-plugin/plugin.json`, both version fields in `.claude-plugin/marketplace.json` | `src/utils/version.ts` reads bundled package metadata; both README footers, the current `CHANGELOG.md` heading, and current-version documentation must agree |
| Go wrapper                  | `codeagent-wrapper/main.go`                                                                            | `EXPECTED_BINARY_VERSION` in `src/utils/installer-binary.ts`, downloaded binary identity, and applicable version assertions must agree                       |
| DSH plugin                  | `dsh-ccg/package.json`                                                                                 | Its exported package metadata, entrypoints, READMEs, and compatibility contracts use the DSH plugin version, independently of the root package               |

A Go wrapper change updates its version and the installer expectation together. Its `X.Y.Z` follows the absorbed
upstream wrapper version; fork changes increase only its `aug.N` suffix. Retain the DSH versioning scheme and update its
version only when that release unit requires it. Read versions through existing package metadata paths instead of adding
another version constant.

Update corresponding lockfile entries only where the existing format records changed metadata or dependencies. The pnpm
lockfile does not require an invented root package-version field. Preserve synthetic peer versions in compatibility
tests and historical changelog bodies; update assertions that identify the current release without weakening their
checks.

## Tags and release notes

Each package release uses one annotated tag named `vX.Y.Z-aug.N`. It points to the final release commit whose
`package.json` version is `X.Y.Z-aug.N` and has one ordinary GitHub Release with the same name. Ordinary releases
contain source metadata only, with no wrapper binary assets.

`preset` is a mutable prerelease for the six precompiled wrapper binaries. `.github/workflows/build-binaries.yml` owns
its tag, Release, and assets. Manage `preset` exclusively through that workflow, including recovery.

Choose an existing previous ordinary Release tag as the comparison baseline. Review its resolved commit against the
final candidate; exclude `preset` and unpublished version guesses. Release text must describe this version's
user-visible capabilities, fixes, compatibility changes, and specific limitations. Preserve historical release text.

The version-tag workflow currently uses `--generate-notes`; it does not read the corresponding `CHANGELOG.md` entry.
Review the generated body and, with Release-edit approval, use the reviewed current-version changelog content to supply
missing release details. Automatic changelog consumption requires a separate workflow change.

## Candidate scope and commit structure

Before staging, record the base commit, existing staged/unstaged/untracked changes, included files, excluded files, and
planned commit groups. Preserve work owned by others and existing local state. Include new files needed by an
entrypoint, workflow, interface, or helper, together with their transitive dependencies.

Each implementation commit contains one reviewable concern, its tests, and directly related documentation. Separate
upstream integration, dependency and CI updates, bug fixes, and mechanical cleanup when independently reviewable. Keep
complete functions and test cases together. Deliver an interface with its implementation and a helper with its first
consumer. Order dependent groups so each intermediate commit builds and passes its affected checks.

Each commit has a hard limit of 5,000 added plus deleted lines. Plan for at most 4,700 lines, leaving at least 300 lines
of margin. Count the complete candidate commit, including new files, generated files, and lockfiles. Before a new
commit, use `git diff --cached --numstat`. Before amending, use `git diff --cached --numstat HEAD^` to include the
original commit's changes and the staged update. Check the resulting commit with
`git show --numstat --format= <commit>`. Sum additions and deletions across all paths; inspect binary entries
separately. Choose the number of groups from semantic boundaries and dependencies, not a fixed group count.

Complete implementation commits before the final, separate version-metadata commit. That commit contains only version
declarations, matching version assertions, plugin metadata, release notes, and current-version documentation. Inspect
each complete diff and the commit sequence; every subject must describe its contents. Record intermediate check
evidence, not just the proposed grouping.

Obtain explicit approval for committing, pushing, tagging, and Release changes before those actions. Bind remote
approval to the release version, final full Git SHA, repository, target branch/tag, and intended published objects. A
candidate change outside approved scope pauses the affected remote stage until its scope and approval are updated. Reuse
valid approval for the same candidate, scope, and target; do not ask repeatedly for unchanged actions.

## Acceptance evidence

Maintain a per-release matrix mapping each change to its entrypoint, required case, platform/runtime, validation level,
evidence, and status. Record exact commands, inputs, source revision, build parameters, environment identity, and
relevant outputs or CI run links. Distinguish unit tests, controlled protocol tests, native execution, public downloads,
and installed consumption. Exercise the registered entrypoint through its final consumer; a component's presence is not
acceptance.

Use these statuses consistently:

- `PASS`: the named assertion succeeded for the recorded candidate and environment
- `FAIL`: preserve the failed assertion and output, fix confirmed in-scope defects, then recheck that entrypoint
- `SKIP`: name the unmet prerequisite and the condition under which the check becomes applicable
- `UNVERIFIED`: the check has no valid execution evidence; state the affected release decision
- `FALSE POSITIVE` or `COMPATIBILITY RETAINED`: cite source/runtime evidence and the reason the behavior remains

Keep the original failing assertion, functional contract, and performance/time budget during a repair. A substitute
entrypoint or different runtime must be recorded at its own coverage level. A required failure or missing required
evidence blocks its corresponding publication stage.

Reuse passing evidence when source, inputs, build parameters, and relevant environment are unchanged. Recheck only
affected coverage after a change, retaining the original evidence's platform and validation level. For pure
version-string updates, retain strict functional assertions and check version consistency, affected version assertions,
the relevant build, and CLI identity. Associate final CI results with the final release SHA even when unchanged local
checks reuse earlier evidence.

### Local preflight

Run these checks from the repository root for the applicable coverage, reusing valid evidence as described above:

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
node bin/ccg.mjs --version
```

For DSH changes, include `dsh-ccg` tests and lint plus the applicable official-runtime combinations from
`.github/workflows/dsh-compat.yml`. For site changes, include `pnpm docs:build`; site publication has separate
acceptance below. Match the runtime used by each check to the supported environment claimed in the matrix.

Run the release-specific checks as well:

```bash
rg -n -- "--backend gemini|templates/prompts/gemini|GeminiBackend|syncMcpToGemini" src \
  templates codeagent-wrapper dsh-ccg package.json
find . -maxdepth 3 -type d -name true
git ls-files 'true/*'
```

The Gemini search must return no active-path matches. The directory and tracked-file checks must return no `true/`
entries. Classify any matches against the actual entrypoint before accepting a compatibility exception.

Review the worktree, staged diff, tracked files, commits to be pushed (including author/committer identities), tag
metadata, release text, and generated assets for private names, endpoints, home-directory paths, company addresses,
credentials, cookies, authorization headers, and other non-public identifiers. Use a public Git identity. Clone-local
untracked files belong in `.git/info/exclude`, not the shared `.gitignore`; keep ordinary index tracking instead of
`skip-worktree` or `assume-unchanged` ignore mechanisms.

## CI and publication order

Publication requires successful required checks for the same final release SHA: all `CI` jobs and applicable DSH,
binary-validation, and documentation checks. Record applicability and successful run identities before the corresponding
publication stage. Build and validate with read permissions; grant write permissions only to the publication stage,
which uses the accepted artifacts.

Current automation has these gaps:

- `release-versions.yml` validates the annotated tag and package version, then creates the Release without waiting for
  other CI workflows
- `build-binaries.yml` cross-compiles and immediately replaces `preset`; its whole job has `contents: write` and no CI
  wait
- `deploy-docs.yml` separates build and deploy jobs, but does not wait for main CI; its permissions are workflow-wide

Cross-workflow dependencies, a binary-validation stage before publication, and publication-only write permissions
require separate YAML changes. The following manual checks govern current use; the workflows do not enforce those gates.

1. Finish the candidate and local evidence, record the final full SHA, and obtain approval for the exact remote scope.
   Treat a push that triggers `preset` or Pages as a publication action when obtaining approval.
2. Obtain required CI results on that exact candidate before a publishing trigger. For approved pull-request checks,
   verify both the run SHA and tested checkout; default merge-preview results qualify only when that tested commit is
   the final candidate. Complete applicable binary and documentation preflight before the trigger. If required same-SHA
   evidence is unavailable with current triggers, pause the affected publication and arrange an approved validation
   route or workflow change.
3. Push only the reviewed branch ref, preserving the validated SHA when advancing `main`. A merge or rebase that changes
   the final SHA requires results for the new SHA before its publication trigger. Keep the approved version and target
   binding current.
4. Confirm successful main-branch `CI` and applicable DSH/documentation/binary runs for the final SHA. The binary and
   Pages workflows can publish during this push; inspect their resulting state separately and record any partial
   publication.
5. After the required final-SHA checks succeed, create the annotated version tag on that commit and push only that tag.
   Confirm the version-tag workflow succeeds and inspect the resulting source Release and its notes.
6. Complete public-object acceptance below. Perform local installation acceptance only under separate installation
   approval, then report each stage's status and any unresolved required evidence.

Use explicit destination refs, such as `git push origin HEAD:refs/heads/main` from the validated candidate and
`git push origin refs/tags/vX.Y.Z-aug.N:refs/tags/vX.Y.Z-aug.N` for the approved tag. Release pushes select only their
intended refs; `--all`, `--tags`, and `--mirror` are excluded.

## Public objects and installation

Local preflight, publication, and installation each have their own acceptance result:

| Object                      | Required acceptance                                                                                                                                                               | Evidence to retain                                                                                            |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Ordinary source Release     | Public tag resolves to the final full SHA; package version, Release name/body, and source archive agree; no wrapper assets                                                        | Tag target, Release URL/body, and downloaded source metadata                                                  |
| `preset` binaries           | All six expected assets exist; workflow source SHA, OS/architecture, and embedded wrapper version match the accepted build and installer expectation                              | Workflow run and asset identities; embedded-version checks; native `--version` output on executable platforms |
| Documentation site          | Deployment uses the intended SHA; public root and relevant pages return expected HTTP status and readable content; linked scripts, styles, and images load                        | Deployment URL/run, HTTP results, page content and resource checks                                            |
| Approved local installation | Installed files and metadata match the selected source/artifacts; CLI and wrapper resolve to those files; Hook registration reaches the installed controller and changed behavior | Install paths/source, version outputs, relevant registrations, and a controlled entrypoint-to-consumer result |

The six preset assets are `codeagent-wrapper-darwin-amd64`, `codeagent-wrapper-darwin-arm64`,
`codeagent-wrapper-linux-amd64`, `codeagent-wrapper-linux-arm64`, `codeagent-wrapper-windows-amd64.exe`, and
`codeagent-wrapper-windows-arm64.exe`. Distinguish cross-compiled or inspected binaries from binaries executed on their
native platform. Record unavailable native execution as `UNVERIFIED` for that coverage.

A successful site build or an HTTP response alone does not establish readable pages and working resources. Inspect the
published content and its resources before accepting the site.

Local installation requires independent approval for its destination and changes. Preserve unrelated user Hooks,
configuration, authentication, and recovery data. Compare version fields with the installed files, binary, registered
Hook, and controller actually consumed; a reported version string alone does not establish an effective upgrade.

## Failure and completion

On a failure, timeout, or network error, preserve the command output and inspect actual remote refs, workflow runs,
Releases, assets, and deployment state before retrying. Record completed, failed, and unverified stages separately.
Resume only the incomplete stage within valid approval, using workflow-managed recovery for `preset`.

Keep published version tags fixed. Correct a published release error with a new `aug.N` and its own reviewed candidate;
obtain approval for any additional remote changes. Preserve previous artifacts and evidence needed for recovery rather
than treating partial publication as an unpublished attempt.

Report the released version/full SHA and targets, successful checks and public objects, failures/skips/unverified
coverage, and installation status separately. Keep candidate inventories, approvals, commands, logs, and one-time
execution records in local task materials; this document contains the lasting release rules.
