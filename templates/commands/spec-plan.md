---
description: '多模型分析 → 消除歧义 → 零决策可执行计划'
---
<!-- CCG:SPEC:PLAN:START -->
**Core Philosophy**
- The goal is to eliminate ALL decision points—implementation should be pure mechanical execution.
- Every ambiguity must be resolved into explicit constraints before proceeding.
- Multi-model collaboration surfaces blind spots and conflicting assumptions.
- Every requirement must have Property-Based Testing (PBT) properties—focus on invariants.

**Guardrails**
- Do not proceed to implementation until every ambiguity is resolved.
- Multi-model collaboration is **mandatory**: use both Codex and Gemini.
- If constraints cannot be fully specified, escalate to user or return to research phase.
- Refer to `openspec/AGENTS.md` for conventions; run `openspec update` if missing.

**Steps**
1. **Select Proposal**
   - Run `openspec list` to display Active Changes.
   - Confirm with user which proposal ID to refine.
   - Run `openspec show <proposal_id>` to review current state.

2. **Multi-Model Implementation Analysis (PARALLEL)**
   - **CRITICAL**: You MUST launch BOTH Codex AND Gemini in a SINGLE message with TWO Bash tool calls.
   - **DO NOT** call one model first and wait. Launch BOTH simultaneously with `run_in_background: true`.

   **Step 2.1**: In ONE message, make TWO parallel Bash calls:

   **FIRST Bash call (Codex)**:
   ```
   Bash({
     command: "~/.claude/bin/codeagent-wrapper --backend codex - \"$PWD\" <<'EOF'\nAnalyze proposal <proposal_id> from backend perspective:\n- Implementation approach\n- Technical risks\n- Alternative architectures\n- Edge cases and failure modes\nOUTPUT: JSON with analysis\nEOF",
     run_in_background: true,
     timeout: 300000,
     description: "Codex: backend analysis"
   })
   ```

   **SECOND Bash call (Gemini) - IN THE SAME MESSAGE**:
   ```
   Bash({
     command: "~/.claude/bin/codeagent-wrapper --backend gemini - \"$PWD\" <<'EOF'\nAnalyze proposal <proposal_id> from frontend/integration perspective:\n- Maintainability assessment\n- Scalability considerations\n- Integration conflicts\nOUTPUT: JSON with analysis\nEOF",
     run_in_background: true,
     timeout: 300000,
     description: "Gemini: frontend analysis"
   })
   ```

   **Step 2.2**: After BOTH Bash calls return task IDs, wait for results with TWO TaskOutput calls:
   ```
   TaskOutput({ task_id: "<codex_task_id>", block: true, timeout: 600000 })
   TaskOutput({ task_id: "<gemini_task_id>", block: true, timeout: 600000 })
   ```

   - Synthesize responses and present consolidated options to user.

3. **Uncertainty Elimination Audit**
   - **Codex**: "Review proposal for unspecified decision points. List each as: [AMBIGUITY] → [REQUIRED CONSTRAINT]"
   - **Gemini**: "Identify implicit assumptions. Specify: [ASSUMPTION] → [EXPLICIT CONSTRAINT NEEDED]"

   **Anti-Pattern Detection** (flag and reject):
   - Information collection without decision boundaries
   - Technical comparisons without selection criteria
   - Deferred decisions marked "to be determined during implementation"

   **Target Pattern** (required for approval):
   - Explicit technology choices with parameters (e.g., "JWT with TTL=15min")
   - Concrete algorithm selections with configs (e.g., "bcrypt cost=12")
   - Precise behavioral rules (e.g., "Lock account 30min after 5 failed attempts")

   Iterate with user until ALL ambiguities resolved.

4. **PBT Property Extraction**
   - **Codex**: "Extract PBT properties. For each requirement: [INVARIANT] → [FALSIFICATION STRATEGY]"
   - **Gemini**: "Define system properties: [PROPERTY] | [DEFINITION] | [BOUNDARY CONDITIONS] | [COUNTEREXAMPLE GENERATION]"

   **Property Categories**:
   - **Commutativity/Associativity**: Order-independent operations
   - **Idempotency**: Repeated operations yield same result
   - **Round-trip**: Encode→Decode returns original
   - **Invariant Preservation**: State constraints maintained
   - **Monotonicity**: Ordering guarantees (e.g., timestamps increase)
   - **Bounds**: Value ranges, size limits, rate constraints

5. **Update OpenSpec Documents**
   - Run `/openspec:proposal <proposal_id>` to update specs with:
     * All resolved constraints
     * PBT properties in spec format
     * Zero-decision task sequence
   - Run `openspec validate <proposal_id>` to verify format.

6. **Context Checkpoint**
   - Report current context usage.
   - If approaching 80K tokens, suggest: "Run `/clear` and continue with `/ccg:spec:impl`"

**Exit Criteria**
A proposal is ready for implementation only when:
- [ ] All multi-model analyses completed and synthesized
- [ ] Zero ambiguities remain (verified by step 3 audit)
- [ ] All PBT properties documented with falsification strategies
- [ ] `openspec validate <id>` returns zero issues
- [ ] User has explicitly approved all constraint decisions

**Reference**
- Inspect proposal: `openspec show <id> --json`
- Check conflicts: `openspec list --specs`
- Search patterns: `rg -n "INVARIANT:|PROPERTY:" openspec/`
- Use `AskUserQuestion` for ANY ambiguity—never assume
<!-- CCG:SPEC:PLAN:END -->
