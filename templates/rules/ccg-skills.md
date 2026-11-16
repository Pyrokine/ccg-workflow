# CCG Quality Gates — Auto-trigger Rules

Apply these triggers to the complete feature stage. After its implementation is ready, combine all applicable gates into
one acceptance pass. Skills are installed at `~/.claude/skills/ccg/` and exposed as namespaced Skill names.

Use exactly `ccg:verify-security`, `ccg:verify-quality`, `ccg:verify-change`, `ccg:verify-module`, and `ccg:gen-docs`.
Slash commands use `/ccg:*`, for example `/ccg:verify-change`.

## Trigger Rules

| Scenario                                                                                   | When                                                                       | Required skills                                                      |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| New module/package/directory with source code                                              | Start documentation when the module is created; validate after development | `ccg:gen-docs`, then `ccg:verify-module` and `ccg:verify-security`   |
| Code changes exceeding 30 lines in the feature stage                                       | After implementation                                                       | `ccg:verify-change` and `ccg:verify-quality`                         |
| Authentication, authorization, encryption, input validation, or secrets management changes | After implementation                                                       | `ccg:verify-security`                                                |
| Refactoring existing code                                                                  | After refactoring                                                          | `ccg:verify-change`, `ccg:verify-quality`, and `ccg:verify-security` |

## Execution Rules

1. Collect triggers across the complete feature stage, not individual edits, files, findings, or review rounds. Run each
   applicable gate once for the final candidate and its requested coverage. Keep targeted checks needed to reproduce a
   problem or validate an intermediate behavior.
2. Reuse results while the candidate, inputs, toolchain, arguments, configuration, and coverage remain applicable. After
   a repair, rerun only affected checks; retain valid results for unaffected areas. Record the command, scope, result,
   and
   any incomplete coverage in the existing task record.
3. Run independent checks even if another check fails. A dependent check waits for its actual prerequisite. Keep failed,
   unavailable, timed-out, unsupported, and incomplete results visible; another check passing does not change them.
4. Confirm reported findings against the current source and its callers. Continue fixing confirmed issues within the
   authorized repair scope, then verify the affected behavior. Critical or High findings require resolution before
   delivery; a read-only review reports them without changing code. New scope or authority needs a user decision.
5. End acceptance when the required evidence supports the candidate and the acceptance criteria are met. Report relevant
   findings and incomplete coverage without a separate success message for every gate. Required checks that remain
   incomplete stay unverified.

## Multi-Agent Coordination

The main session is the default executor. Delegate when independent work has a clear benefit, substantial intermediate
material needs isolation, separate tool or permission boundaries require it, a high-risk finding needs independent
verification, or the user requests collaboration. File count alone does not require delegation.

When delegation is justified, use `~/.claude/skills/ccg/orchestration/multi-agent/SKILL.md` for role assignment and file
ownership. Set independent scope, total agents, maximum depth, budget, stop condition, deduplication key, and output
format
before dispatch. Keep one writer per file and preserve the current authorization and session task isolation.
