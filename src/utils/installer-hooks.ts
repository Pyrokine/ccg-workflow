import { rename } from 'node:fs/promises'
import fs from 'fs-extra'
import { join } from 'pathe'
import type { InstallContext } from './installer-context'
import { lstatOptional } from './installer-codex-files'
import { asRecord, parseJsonRecord } from './installer-codex-content'
import { injectHookConfig } from './installer-template'
import { TASK_STATE_RUNTIME_FILES } from './installer-data'

export function isCcgHookCommand(command: unknown): boolean {
  return typeof command === 'string' && command.replace(/\\/g, '/').includes('/hooks/ccg/')
}

const HOOK_FILES = [
  ...TASK_STATE_RUNTIME_FILES,
  'workflow-state.js',
  'session-start.js',
  'subagent-context.js',
  'skill-router.js',
]

/**
 * Install CCG hook scripts to ~/.claude/hooks/ccg/
 */
export async function installHookScripts(ctx: InstallContext): Promise<boolean> {
  const hooksSrcDir = join(ctx.templateDir, 'hooks')
  if (!(await fs.pathExists(hooksSrcDir))) {
    ctx.result.errors.push(`Hook template directory not found: ${hooksSrcDir}`)
    ctx.result.success = false
    return false
  }

  const hooksDestDir = join(ctx.installDir, 'hooks', 'ccg')
  await fs.ensureDir(hooksDestDir)

  try {
    const boundary = join(hooksDestDir, 'package.json')
    let metadata: Record<string, unknown> = {}
    const current = await lstatOptional(boundary)
    if (current) {
      if (!current.isFile() || current.isSymbolicLink())
        throw new Error('Hook package metadata is not a regular file; preserved')
      metadata = parseJsonRecord(await fs.readFile(boundary, 'utf-8'), 'Hook package metadata')
    }
    await fs.writeJson(boundary, { ...metadata, type: 'commonjs' }, { spaces: 2 })
    for (const file of HOOK_FILES) {
      const src = join(hooksSrcDir, file)
      if (!(await fs.pathExists(src))) {
        throw new Error(`Required hook runtime file not found: ${src}`)
      }
      if (file === 'package.json') continue
      const content = await fs.readFile(src, 'utf-8')
      await fs.writeFile(join(hooksDestDir, file), injectHookConfig(content, ctx.config, ctx.installDir), 'utf-8')
    }
    return true
  } catch (error) {
    ctx.result.errors.push(`Failed to install hook scripts: ${error}`)
    ctx.result.success = false
    return false
  }
}

const CCG_HOOK_EVENTS = ['UserPromptSubmit', 'SessionStart', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure'] as const

export async function readHookSettings(ctx: InstallContext): Promise<Record<string, unknown> | null> {
  const settingsPath = join(ctx.installDir, 'settings.json')
  let settings: Record<string, unknown> = {}
  if (await fs.pathExists(settingsPath)) {
    const rawSettings = await fs.readFile(settingsPath, 'utf-8')
    try {
      const parsed = asRecord(JSON.parse(rawSettings))
      if (!parsed) {
        ctx.result.errors.push('Failed to register hooks in settings.json: root value must be an object')
        ctx.result.success = false
        return null
      }
      settings = parsed as Record<string, unknown>
    } catch (error) {
      ctx.result.errors.push(`Failed to register hooks in settings.json: invalid JSON (${error})`)
      ctx.result.success = false
      return null
    }
  }

  const configuredHooks = settings.hooks
  if (configuredHooks !== undefined && !asRecord(configuredHooks)) {
    ctx.result.errors.push('Failed to register hooks in settings.json: hooks must be an object')
    ctx.result.success = false
    return null
  }
  const hooks = (configuredHooks || {}) as Record<string, unknown>
  for (const event of CCG_HOOK_EVENTS) {
    if (hooks[event] !== undefined && !Array.isArray(hooks[event])) {
      ctx.result.errors.push(`Failed to register hooks in settings.json: hooks.${event} must be an array`)
      ctx.result.success = false
      return null
    }
  }
  return settings
}

function ccgHookDefinitions(hooksDir: string): Record<string, Record<string, unknown>> {
  const quoteCommandPath = (filePath: string): string => `"${filePath.replace(/"/g, '\\"')}"`
  return {
    UserPromptSubmit: {
      hooks: [
        { type: 'command', command: `node ${quoteCommandPath(join(hooksDir, 'workflow-state.js'))}`, timeout: 10 },
        { type: 'command', command: `node ${quoteCommandPath(join(hooksDir, 'skill-router.js'))}`, timeout: 5 },
      ],
    },
    SessionStart: {
      matcher: 'startup|resume|clear|compact|fork',
      hooks: [
        { type: 'command', command: `node ${quoteCommandPath(join(hooksDir, 'session-start.js'))}`, timeout: 15 },
      ],
    },
    PreToolUse: {
      matcher: 'Bash|Agent',
      hooks: [
        { type: 'command', command: `node ${quoteCommandPath(join(hooksDir, 'subagent-context.js'))}`, timeout: 15 },
      ],
    },
    PostToolUse: {
      matcher: 'Bash|Agent|TaskOutput',
      hooks: [
        { type: 'command', command: `node ${quoteCommandPath(join(hooksDir, 'workflow-state.js'))}`, timeout: 10 },
      ],
    },
    PostToolUseFailure: {
      matcher: 'Bash|Agent',
      hooks: [
        { type: 'command', command: `node ${quoteCommandPath(join(hooksDir, 'workflow-state.js'))}`, timeout: 10 },
      ],
    },
  }
}

function preservedHookEntries(existing: Record<string, unknown>[]): Record<string, unknown>[] {
  const preservedEntries: Record<string, unknown>[] = []
  for (const entry of existing) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      preservedEntries.push(entry)
      continue
    }
    const commands = entry.hooks
    if (!Array.isArray(commands)) {
      preservedEntries.push(entry)
      continue
    }
    const preservedCommands = commands.filter((hook) => {
      if (!hook || typeof hook !== 'object' || Array.isArray(hook)) return true
      return !isCcgHookCommand((hook as Record<string, unknown>).command)
    })
    if (preservedCommands.length > 0) preservedEntries.push({ ...entry, hooks: preservedCommands })
  }
  return preservedEntries
}

/**
 * Register CCG hooks in ~/.claude/settings.json.
 * Merges with existing hooks — does not overwrite user's other hooks.
 */
export async function registerHooksInSettings(ctx: InstallContext): Promise<void> {
  const settingsPath = join(ctx.installDir, 'settings.json')
  const hooksDir = join(ctx.installDir, 'hooks', 'ccg')

  try {
    const settings = await readHookSettings(ctx)
    if (!settings) return
    const hooks = { ...((settings.hooks || {}) as Record<string, unknown>) }

    for (const [event, definition] of Object.entries(ccgHookDefinitions(hooksDir))) {
      const existing = hooks[event]
      if (existing !== undefined && !Array.isArray(existing)) {
        ctx.result.errors.push(`Failed to register hooks in settings.json: hooks.${event} must be an array`)
        ctx.result.success = false
        return
      }

      const preservedEntries = preservedHookEntries((existing || []) as Record<string, unknown>[])
      hooks[event] = [...preservedEntries, definition]
    }

    settings.hooks = hooks
    const tempSettingsPath = `${settingsPath}.ccg-${process.pid}.tmp`
    try {
      await fs.writeFile(tempSettingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf-8')
      await rename(tempSettingsPath, settingsPath)
    } finally {
      await fs.remove(tempSettingsPath).catch(() => undefined)
    }
  } catch (error) {
    ctx.result.errors.push(`Failed to register hooks in settings.json: ${error}`)
    ctx.result.success = false
  }
}
