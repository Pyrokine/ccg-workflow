---
description: '初始化 OpenSpec 环境 + 验证多模型 MCP 工具'
---
<!-- CCG:SPEC:INIT:START -->
**Core Philosophy**
- OpenSpec provides the specification framework; CCG adds multi-model collaboration.
- This phase ensures all tools are ready before any development work begins.
- Fail fast: detect missing dependencies early rather than mid-workflow.

**Guardrails**
- Detect OS (Linux/macOS/Windows) and adapt commands accordingly.
- Do not proceed to next step until current step completes successfully.
- Provide clear, actionable error messages when a step fails.
- Respect user's existing configurations; avoid overwriting without confirmation.

**Steps**
1. **Detect Operating System**
   - Identify OS using `uname -s` (Unix) or environment variables (Windows).
   - Inform user which OS was detected.

2. **Check and Install OpenSpec**
   - Verify if `openspec` CLI is installed: `openspec --version`
   - If not installed:
     ```bash
     npm install -g @fission-ai/openspec@latest
     ```
   - Confirm installation success.

3. **Initialize OpenSpec for Current Project**
   - Run:
     ```bash
     openspec init --tools claude
     ```
   - Verify `openspec/` directory structure is created.
   - Report any errors with remediation steps.

4. **Validate Multi-Model MCP Tools**
   - Check `codeagent-wrapper` availability: `~/.claude/bin/codeagent-wrapper --version`
   - Test Codex backend:
     ```bash
     ~/.claude/bin/codeagent-wrapper --backend codex - "$PWD" <<< "echo test"
     ```
   - Test Gemini backend:
     ```bash
     ~/.claude/bin/codeagent-wrapper --backend gemini - "$PWD" <<< "echo test"
     ```
   - For each unavailable tool, display warning with installation instructions.

5. **Validate Context Retrieval MCP** (Optional)
   - Check if `mcp__ace-tool__search_context` is available.
   - If not, suggest: "Run `npx ccg-workflow` and select ace-tool MCP option."

6. **Summary Report**
   Display status table:
   ```
   Component                 Status
   ─────────────────────────────────
   OpenSpec CLI              ✓/✗
   Project initialized       ✓/✗
   codeagent-wrapper         ✓/✗
   Codex backend             ✓/✗
   Gemini backend            ✓/✗
   ace-tool MCP              ✓/✗ (optional)
   ```
   If any required components missing, list actions before proceeding.

**Reference**
- OpenSpec CLI: `openspec --help`
- CCG Workflow: `npx ccg-workflow`
- Codex/Gemini MCP: Bundled with codeagent-wrapper
- Node.js >= 18.x required for OpenSpec
<!-- CCG:SPEC:INIT:END -->
