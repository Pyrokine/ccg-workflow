import fs from 'fs-extra'

export type ClaudeHookCommand = { command?: string; [key: string]: unknown }
export type ClaudeHook = { matcher?: string; hooks?: ClaudeHookCommand[]; [key: string]: unknown }
export type ClaudeSettings = {
  hooks?: { PreToolUse?: ClaudeHook[]; [key: string]: unknown }
  permissions?: { allow?: string[]; [key: string]: unknown }
  env?: Record<string, string>
  [key: string]: unknown
}

/**
 * Auto-approve codeagent-wrapper Bash commands in settings.json.
 *
 * All platforms use permissions.allow with wildcard pattern (v1.7.89+).
 * Old Hook-based approach and old permission entries are automatically cleaned up.
 */
export async function installHook(settingsPath: string): Promise<'permission'> {
  let settings: ClaudeSettings = {}
  if (await fs.pathExists(settingsPath)) {
    settings = await fs.readJSON(settingsPath)
  }

  // ── All platforms: permissions.allow approach (v1.7.89+) ──

  removeLegacyWrapperHook(settings)

  // Remove old permission entry without leading wildcard (migration from ≤v1.7.88)
  if (settings.permissions?.allow) {
    const oldEntry = 'Bash(codeagent-wrapper*)'
    const oldIdx = settings.permissions.allow.indexOf(oldEntry)
    if (oldIdx >= 0) {
      settings.permissions.allow.splice(oldIdx, 1)
    }
  }

  // Add permissions.allow entry
  if (!settings.permissions) settings.permissions = {}
  if (!settings.permissions.allow) settings.permissions.allow = []

  const permEntry = 'Bash(*codeagent-wrapper*)'
  if (!settings.permissions.allow.includes(permEntry)) {
    settings.permissions.allow.push(permEntry)
  }

  await fs.writeJSON(settingsPath, settings, { spaces: 2 })
  return 'permission'
}

export function configureApiDefaults(settings: ClaudeSettings): void {
  if (!settings.env) settings.env = {}
  // Default optimization config
  settings.env.DISABLE_TELEMETRY = '1'
  settings.env.DISABLE_ERROR_REPORTING = '1'
  settings.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
  settings.env.CLAUDE_CODE_ATTRIBUTION_HEADER = '0'
  settings.env.MCP_TIMEOUT = '60000'
  // codeagent-wrapper permission allowlist
  if (!settings.permissions) settings.permissions = {}
  if (!settings.permissions.allow) settings.permissions.allow = []
  const wrapperPerms = [
    'Bash(~/.claude/bin/codeagent-wrapper --backend antigravity*)',
    'Bash(~/.claude/bin/codeagent-wrapper --backend agy*)',
    'Bash(~/.claude/bin/codeagent-wrapper --backend codex*)',
    'Bash(~/.claude/bin/codeagent-wrapper --backend claude*)',
    'Bash(~/.claude/bin/codeagent-wrapper --backend grok*)',
    'Bash(~/.claude/bin/codeagent-wrapper --backend kimi*)',
    'Bash(~/.claude/bin/codeagent-wrapper --backend opencode*)',
  ]
  for (const perm of wrapperPerms) {
    if (!settings.permissions.allow.includes(perm)) settings.permissions.allow.push(perm)
  }
}

function removeLegacyWrapperHook(settings: ClaudeSettings): void {
  // Remove old Hook if it exists (migration from ≤v1.7.88)
  if (settings.hooks?.PreToolUse) {
    const hookIdx = settings.hooks.PreToolUse.findIndex(
      (h) => h.matcher === 'Bash' && h.hooks?.some((hh) => hh.command?.includes('codeagent-wrapper'))
    )
    if (hookIdx >= 0) {
      settings.hooks.PreToolUse.splice(hookIdx, 1)
      // Clean up empty arrays/objects
      if (settings.hooks.PreToolUse.length === 0) delete settings.hooks.PreToolUse
      if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks
    }
  }
}
