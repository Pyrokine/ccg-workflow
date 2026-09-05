---
description: '初始化 OpenSpec (OPSX) 环境 + 验证多模型 MCP 工具'
---

<!-- CCG:SPEC:INIT:START -->
**Core Philosophy**

- OPSX provides the specification framework; CCG adds multi-model collaboration.
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

2. **Check and Install OpenSpec (OPSX)**
    - **IMPORTANT**: OpenSpec CLI command is `openspec`, NOT `opsx`
    - Verify if OpenSpec is available:
      ```bash
      npx @fission-ai/openspec --version
      ```
    - If not found, install globally:
      ```bash
      npm install -g @fission-ai/openspec@latest
      ```
    - After installation, verify again:
      ```bash
      openspec --version
      ```
    - If `openspec` command not found after global install, use `npx`:
      ```bash
      npx @fission-ai/openspec --version
      ```
    - **Note**: Always use `openspec` (not `opsx`) for CLI commands.

3. **Initialize OPSX for Current Project**
    - **重要**：所有命令必须在当前工作目录下执行，禁止 `cd` 到其他路径。如不确定当前目录，先执行 `pwd` 确认。
    - Check if already initialized:
      ```bash
      ls -la openspec/ .claude/skills/openspec-* 2>/dev/null || echo "Not initialized"
      ```
    - If not initialized, run interactive setup (v1.2+ auto-detects AI tools):
      ```bash
      npx @fission-ai/openspec init
      ```
    - **Profile Selection** (v1.2+):
        - `core` profile (default): 4 essential workflows (`propose`, `explore`, `apply`, `archive`)
        - `custom` profile: Pick any subset of workflows
        - To change profile later: `openspec config profile`
    - Verify initialization:
        - Check `openspec/` directory exists
        - Check `.claude/skills/` contains `openspec-*` skills
        - Check `.claude/commands/opsx/` contains OPSX commands
    - Report any errors with remediation steps.

4. **Validate Model Routes**
    - 当 `{{BACKEND_PRIMARY}}` 与 `{{FRONTEND_PRIMARY}}` 都是 Claude 时，只检查 Claude Code 可用性，不调用 codeagent-wrapper 或任何外部 CLI。
    - 只有用户已将某条 primary route 明确配置为 Codex、Antigravity、Grok、Kimi Code 或 OpenCode 时，才检查 codeagent-wrapper 可用性并测试该外部 route。
    - For each unavailable explicitly configured tool, display warning with installation instructions.

5. **Summary Report**
   Display status table:
   ```
   Component                 Status
   ─────────────────────────────────
   OpenSpec (OPSX) CLI       ✓/✗
   Project initialized       ✓/✗
   OPSX Skills               ✓/✗
   Claude Code Agent         ✓/✗
   Configured external route  ✓/✗/N/A
   ```

   **Next Steps (Use CCG Encapsulated Commands)**
    1. Start Research: `/ccg:spec-research "description"`
    2. Plan & Design: `/ccg:spec-plan`
    3. Implement: `/ccg:spec-impl` (Includes auto-review & archive)

   **Standalone Tools (Available Anytime)**
    - Code Review: `/ccg:spec-review` (GPT/Grok cross-review)

**Reference**

- OpenSpec (OPSX) CLI: `npx @fission-ai/openspec --help`
- Profile Management: `openspec config profile`
- CCG Workflow: `npx ccg-workflow`
- 后端/前端模型 MCP: Bundled with codeagent-wrapper
- Node.js >= 18.x required for OpenSpec

<!-- CCG:SPEC:INIT:END -->
