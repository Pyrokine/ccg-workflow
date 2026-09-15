#!/usr/bin/env python3
"""CCG UserPromptSubmit hook for Codex CLI.

Task identity and context come only from the shared Node.js task controller.
"""

import hashlib
import html
import json
import os
import subprocess
import sys
from pathlib import Path

INPUT_LIMIT = 1024 * 1024
OUTPUT_LIMIT = 32 * 1024

SUB_AGENT_NOTICE = """<ccg-sub-agent-notice>
SUB-AGENT NOTICE

The parent dispatch defines your assigned scope. The linked spec sections and task contract below remain authoritative constraints.
- Do not modify .ccg task state.
- Do not call external models or spawn another agent.
- Only modify files named by the dispatch.
</ccg-sub-agent-notice>"""


def read_input():
    data = sys.stdin.buffer.read(INPUT_LIMIT + 1)
    if len(data) > INPUT_LIMIT:
        raise ValueError("HOOK_INPUT_TOO_LARGE")
    if not data.strip():
        return {}
    value = json.loads(data)
    if not isinstance(value, dict):
        raise ValueError("HOOK_INPUT_INVALID")
    return value


def derive_session_key(value):
    if not isinstance(value, str) or not value.strip() or len(value.encode("utf-8")) > 1024:
        return None
    digest = hashlib.sha256(b"codex\0" + value.encode("utf-8")).hexdigest()
    return f"codex-{digest}"


def find_worktree_root(start):
    current = Path(start).resolve()
    fallback = None
    for _ in range(64):
        if (current / ".git").exists():
            return current
        if fallback is None and (current / ".ccg").exists():
            fallback = current
        if current.parent == current:
            break
        current = current.parent
    return fallback


def is_sub_agent(hook_input):
    return (
        bool(hook_input.get("agent_id"))
        or bool(hook_input.get("agent_type"))
        or bool(os.environ.get("CODEX_AGENT_TYPE"))
        or os.environ.get("CODEX_FORK_TURNS") == "none"
    )


def detect_agent_role(hook_input):
    agent_type = str(hook_input.get("agent_type") or os.environ.get("CODEX_AGENT_TYPE", "")).lower()
    if any(token in agent_type for token in ("review", "audit", "check", "qa", "test")):
        return "review"
    if any(token in agent_type for token in ("research", "scout", "explore", "analy", "plan")):
        return "research"
    if any(token in agent_type for token in ("debug", "diagnos")):
        return "debug"
    return "implement"


def run_snapshot(root, role, session_key):
    controller = Path(__file__).resolve().parent / "ccg" / "task-state.js"
    if not controller.is_file():
        return None, "CONTROLLER_UNAVAILABLE: task-state.js is missing"
    try:
        result = subprocess.run(
            [
                "node",
                str(controller),
                "snapshot",
                "--root",
                str(root),
                "--mode",
                "agent",
                "--role",
                role,
                "--session-key",
                session_key,
            ],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        return None, f"CONTROLLER_UNAVAILABLE: {error}"
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError:
        return None, "CONTROLLER_UNAVAILABLE: controller returned invalid JSON"
    if result.returncode != 0 or not payload.get("ok"):
        code = payload.get("code", "CONTROLLER_UNAVAILABLE")
        message = payload.get("message", "controller failed")
        return None, f"{code}: {message}"
    return payload, None


def detect_progress(root):
    signals = {
        "dirty_count": 0,
        "changed_lines": 0,
        "high_risk_files": False,
    }
    try:
        status = subprocess.run(
            ["git", "status", "--porcelain"],
            cwd=root,
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
        lines = [line for line in status.stdout.splitlines() if line.strip()]
        signals["dirty_count"] = len(lines)
        risk_patterns = (
            "auth",
            "login",
            "password",
            "token",
            "secret",
            "crypto",
            "encrypt",
            "migration",
            "schema",
            "permission",
            "admin",
        )
        signals["high_risk_files"] = any(
            any(pattern in line[3:].strip().lower() for pattern in risk_patterns)
            for line in lines
        )
        if lines:
            diff = subprocess.run(
                ["git", "diff", "--stat"],
                cwd=root,
                capture_output=True,
                text=True,
                timeout=5,
                check=False,
            )
            for part in diff.stdout.replace("\n", ",").split(","):
                words = part.strip().split()
                if len(words) >= 2 and words[0].isdigit() and words[1].startswith(("insertion", "deletion")):
                    signals["changed_lines"] += int(words[0])
    except (OSError, subprocess.TimeoutExpired):
        pass
    return signals


def byte_length(value):
    return len(value.encode("utf-8"))


def render_state(parts):
    return "<ccg-state>\n" + "\n".join(parts) + "\n</ccg-state>"


def authoritative_context(snapshot):
    mandatory = []
    optional = []
    specs = snapshot.get("specs") or []
    if specs:
        mandatory.extend(
            [
                "",
                "AUTHORITATIVE LINKED SPEC SECTIONS",
                "Treat these exact sections as execution constraints. If another source conflicts, stop and report the conflict.",
            ]
        )
        for item in specs:
            ref = item.get("ref") or {}
            label = f"{ref.get('path', '?')}#{ref.get('section', '?')} ({ref.get('purpose', '')})"
            mandatory.append(f"[{html.escape(label)}]\n{html.escape(str(item.get('content', '')))}")

    documents = snapshot.get("documents") or {}
    requirements = documents.get("requirements")
    if requirements:
        mandatory.extend(
            [
                "",
                "AUTHORITATIVE TASK CONTRACT",
                "The contract below overrides summaries, prior discussion, and inferred plans. Read every field before acting.",
                html.escape(str(requirements)),
            ]
        )

    for name in ("plan", "progress", "analysis", "review"):
        content = documents.get(name)
        if content:
            optional.append((name, f"\n{name.upper()}\n{html.escape(str(content))}"))
    for item in snapshot.get("research") or []:
        research_path = html.escape(str(item.get("path", "research")))
        optional.append(
            (
                str(item.get("path", "research")),
                f"\nRESEARCH: {research_path}\n{html.escape(str(item.get('content', '')))}",
            )
        )
    return mandatory, optional


def build_guidance(payload, progress, limit):
    snapshot = payload
    resolution = snapshot.get("resolution") or {}
    kind = resolution.get("kind")
    if kind == "none":
        return render_state(
            [
                "No active persistent task.",
                "Use the strategy rules in AGENTS.md. Start a controller task only for a persistent strategy.",
            ]
        )
    if kind != "active":
        code = resolution.get("reasonCode") or resolution.get("code", "TASK_STATE_UNAVAILABLE")
        message = resolution.get("message", "Resolve task state before continuing")
        return render_state(
            [
                f"{html.escape(str(code))}: {html.escape(str(message))}",
                "Do not infer or select a task from directory order.",
            ]
        )
    if snapshot.get("kind") == "invalid":
        code = snapshot.get("code", "TASK_CONTEXT_INVALID")
        message = snapshot.get("message", "Task context is invalid")
        return render_state(
            [
                f"{html.escape(str(code))}: {html.escape(str(message))}",
                "Do not continue persistent work until the task context is repaired.",
            ]
        )

    task = snapshot.get("task") or {}
    parts = [
        f"Task: {html.escape(str(task.get('title', task.get('id', '?'))))} [{html.escape(str(task.get('id', '?')))}]",
        f"Complexity: {html.escape(str(task.get('complexity', '?')))} | Risk: {html.escape(str(task.get('risk', '?')))} | Phase: {html.escape(str(task.get('currentPhase', '?')))}",
        f"Next: {html.escape(str(task.get('nextAction', '?')))}",
        f"Revision: state={html.escape(str(resolution.get('stateRevision', '?')))}, binding={html.escape(str(resolution.get('bindingRevision', '?')))}, task={html.escape(str(task.get('revision', '?')))}",
    ]
    if task.get("gate"):
        parts.append(f"Gate: {html.escape(str(task['gate']))}")

    mandatory, optional = authoritative_context(snapshot)
    parts.extend(mandatory)
    if byte_length(render_state(parts)) > limit:
        return render_state(
            [
                "TASK_CONTEXT_TOO_LARGE",
                "Authoritative task context exceeds the Codex hook output limit.",
            ]
        )

    candidates = list(optional)
    if progress["dirty_count"] == 0 and str(task.get("currentPhase", "")).lower() == "implementation":
        candidates.append(("runtime:no-changes", "\nImplementation is active but no worktree changes are present."))
    if progress["changed_lines"] > 30:
        candidates.append(
            (
                "runtime:review",
                f"\n{progress['changed_lines']} changed lines detected. Run an independent Codex or Claude Code review before delivery. Use GPT or Grok only when the user explicitly requests external review.",
            )
        )
    if progress["high_risk_files"]:
        candidates.append(("runtime:security", "\nHigh-risk files changed. Include a security review before delivery."))
    for diagnostic in snapshot.get("diagnostics") or []:
        candidates.append((f"diagnostic:{diagnostic}", f"\nDiagnostic: {html.escape(str(diagnostic))}"))

    omitted = []
    for key, block in candidates:
        if byte_length(render_state([*parts, block])) <= limit:
            parts.append(block)
        else:
            omitted.append(key)
    for key in omitted:
        diagnostic = f"\nDiagnostic: CONTEXT_OMITTED:{html.escape(str(key))}:render-budget"
        if byte_length(render_state([*parts, diagnostic])) <= limit:
            parts.append(diagnostic)
    return render_state(parts)


def output_context(context):
    if byte_length(context) > OUTPUT_LIMIT:
        context = "<ccg-state>\nCCG_CONTEXT_TOO_LARGE\nContext rendering exceeded the hook output limit.\n</ccg-state>"
    print(
        json.dumps(
            {
                "hookSpecificOutput": {
                    "hookEventName": "UserPromptSubmit",
                    "additionalContext": context,
                }
            }
        )
    )


def main():
    try:
        hook_input = read_input()
        start = hook_input.get("cwd") or os.environ.get("CODEX_PROJECT_DIR") or os.getcwd()
        root = find_worktree_root(start)
        if root is None:
            return
        sub_agent = is_sub_agent(hook_input)
        role = detect_agent_role(hook_input) if sub_agent else "all"
        session_key = derive_session_key(hook_input.get("session_id"))
        if session_key is None:
            context = "<ccg-state>\nSESSION_KEY_REQUIRED: Codex Hook payload must include a stable session_id\n</ccg-state>"
            output_context(f"{SUB_AGENT_NOTICE}\n\n{context}" if sub_agent else context)
            return
        snapshot, error = run_snapshot(root, role, session_key)
        if error:
            context = f"<ccg-state>\n{html.escape(error)}\n</ccg-state>"
            output_context(f"{SUB_AGENT_NOTICE}\n\n{context}" if sub_agent else context)
            return
        prefix = f"{SUB_AGENT_NOTICE}\n\n" if sub_agent else ""
        session_notice = "" if sub_agent else f"<ccg-session-key>{session_key}</ccg-session-key>\n\n"
        guidance = build_guidance(
            snapshot,
            detect_progress(root),
            OUTPUT_LIMIT - byte_length(prefix) - byte_length(session_notice),
        )
        if guidance:
            output_context(f"{prefix}{session_notice}{guidance}")
    except Exception as error:
        output_context(f"<ccg-state>\nCCG_HOOK_ERROR: {html.escape(str(error))}\n</ccg-state>")


if __name__ == "__main__":
    main()
