import { homedir } from 'node:os'
import { join } from 'pathe'
import { parse as parseToml } from 'smol-toml'
import type { InstallConfig } from './installer-context'
import { injectConfigVariables } from './installer-template'
import {
  CODEX_MANAGED_BLOCK_START_PREFIX,
  CODEX_MANAGED_BLOCK_START,
  CODEX_MANAGED_BLOCK_END,
  type JsonRecord,
} from './installer-codex-files'

export function renderCodexPaths(content: string): string {
  const userHome = homedir().replace(/\\/g, '/')
  return content.replace(/~\//g, `${userHome}/`)
}

export function renderCodexTemplate(content: string, config: InstallConfig): string {
  return renderCodexPaths(injectConfigVariables(content, config))
}

export function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : null
}

function markerOffsets(content: string, marker: string): number[] {
  const offsets: number[] = []
  let offset = 0
  while (offset < content.length) {
    const found = content.indexOf(marker, offset)
    if (found < 0) break
    offsets.push(found)
    offset = found + marker.length
  }
  return offsets
}

function locateCodexManagedBlock(content: string): { start: number; end: number } | null {
  const startPrefixes = markerOffsets(content, CODEX_MANAGED_BLOCK_START_PREFIX)
  const starts = markerOffsets(content, CODEX_MANAGED_BLOCK_START)
  const ends = markerOffsets(content, CODEX_MANAGED_BLOCK_END)
  if (startPrefixes.length === 0 && ends.length === 0) return null
  if (
    startPrefixes.length !== 1 ||
    starts.length !== 1 ||
    startPrefixes[0] !== starts[0] ||
    ends.length !== 1 ||
    starts[0] >= ends[0]
  ) {
    throw new Error('Codex AGENTS.md contains damaged or duplicate CCG managed-block markers')
  }
  return { start: starts[0], end: ends[0] + CODEX_MANAGED_BLOCK_END.length }
}

function extractCodexManagedBlock(content: string): string {
  const location = locateCodexManagedBlock(content)
  if (!location || content.slice(0, location.start).trim() || content.slice(location.end).trim()) {
    throw new Error('Codex AGENTS.md template must contain exactly one standalone CCG managed block')
  }
  return content.slice(location.start, location.end)
}

export function renderCodexManagedBlock(template: string, config: InstallConfig): string {
  extractCodexManagedBlock(template)
  const rendered = renderCodexTemplate(template, config)
  const location = locateCodexManagedBlock(rendered)
  if (!location || rendered.slice(location.end).trim()) {
    throw new Error('Rendered Codex AGENTS.md template has content after the CCG managed block')
  }

  const prefix = rendered.slice(0, location.start).trim()
  const block = rendered.slice(location.start, location.end)
  if (!prefix) return block
  const startMarkerEnd = block.indexOf('-->') + 3
  const body = block.slice(startMarkerEnd).replace(/^\s*/, '')
  return `${block.slice(0, startMarkerEnd)}\n\n${prefix}\n\n${body}`
}

export function mergeCodexManagedBlock(existing: string | null, block: string): string {
  if (existing === null || existing.length === 0) return `${block}\n`
  const location = locateCodexManagedBlock(existing)
  if (location) return `${existing.slice(0, location.start)}${block}${existing.slice(location.end)}`
  const separator = existing.endsWith('\n') ? '\n' : '\n\n'
  return `${existing}${separator}${block}\n`
}

export function removeCodexManagedBlock(existing: string): { content: string; changed: boolean } {
  const location = locateCodexManagedBlock(existing)
  if (!location) return { content: existing, changed: false }
  let content = `${existing.slice(0, location.start)}${existing.slice(location.end)}`
  if (!content.trim()) return { content: '', changed: true }
  if (content.startsWith('\n') && location.start === 0) content = content.slice(1)
  if (content.endsWith('\n\n') && location.end === existing.length) content = content.slice(0, -1)
  return { content, changed: true }
}

export function parseJsonRecord(content: string, label: string): JsonRecord {
  let value: unknown
  try {
    value = JSON.parse(content)
  } catch (error) {
    throw new Error(`${label} is invalid JSON`, { cause: error })
  }
  const record = asRecord(value)
  if (!record) throw new Error(`${label} root must be an object`)
  return record
}

function isCodexWorkflowHookCommand(command: unknown, codexHome: string): boolean {
  if (typeof command !== 'string') return false
  const normalized = command.replace(/\\/g, '/').trim()
  const match = /^python3\s+(?:"([^"]+)"|'([^']+)'|(\S+))$/.exec(normalized)
  const scriptPath = match?.[1] || match?.[2] || match?.[3]
  if (!scriptPath) return false
  const expected = join(codexHome, 'hooks', 'ccg-workflow.py').replace(/\\/g, '/')
  return scriptPath === expected || scriptPath === '~/.codex/hooks/ccg-workflow.py'
}

function removeCodexWorkflowHooks(root: JsonRecord, codexHome: string): { root: JsonRecord; changed: boolean } {
  const configuredHooks = root.hooks
  if (configuredHooks === undefined) return { root: { ...root }, changed: false }
  const hooks = asRecord(configuredHooks)
  if (!hooks) throw new Error('Codex hooks.json hooks must be an object')

  const nextHooks: JsonRecord = { ...hooks }
  let changed = false
  for (const [event, value] of Object.entries(hooks)) {
    if (!Array.isArray(value)) throw new Error(`Codex hooks.json hooks.${event} must be an array`)
    const entries = value
      .map((entry) => {
        const entryRecord = asRecord(entry)
        if (!entryRecord || !Array.isArray(entryRecord.hooks)) return entry
        const kept = entryRecord.hooks.filter((hook) => {
          const hookRecord = asRecord(hook)
          return !hookRecord || !isCodexWorkflowHookCommand(hookRecord.command, codexHome)
        })
        if (kept.length === entryRecord.hooks.length) return entry
        changed = true
        return kept.length > 0 ? { ...entryRecord, hooks: kept } : null
      })
      .filter((entry) => entry !== null)
    if (entries.length > 0) nextHooks[event] = entries
    else delete nextHooks[event]
  }

  const nextRoot = { ...root }
  if (Object.keys(nextHooks).length > 0) nextRoot.hooks = nextHooks
  else delete nextRoot.hooks
  return { root: nextRoot, changed }
}

export function canonicalCodexHookDefinition(content: string, codexHome: string): JsonRecord {
  const root = parseJsonRecord(content, 'Codex hooks template')
  const hooks = asRecord(root.hooks)
  const entries = hooks?.UserPromptSubmit
  if (!Array.isArray(entries) || entries.length !== 1) {
    throw new Error('Codex hooks template must define exactly one UserPromptSubmit entry')
  }
  const entry = asRecord(entries[0])
  const commands = entry?.hooks
  if (
    !entry ||
    !Array.isArray(commands) ||
    commands.length !== 1 ||
    !isCodexWorkflowHookCommand(asRecord(commands[0])?.command, codexHome)
  ) {
    throw new Error('Codex hooks template does not contain the expected CCG command Hook')
  }
  return JSON.parse(JSON.stringify(entry)) as JsonRecord
}

export function mergeCodexHooks(existing: string | null, definition: JsonRecord, codexHome: string): string {
  const root = existing === null ? {} : parseJsonRecord(existing, 'Codex hooks.json')
  const cleaned = removeCodexWorkflowHooks(root, codexHome).root
  const hooks = asRecord(cleaned.hooks) || {}
  const existingEntries = hooks.UserPromptSubmit
  if (existingEntries !== undefined && !Array.isArray(existingEntries)) {
    throw new Error('Codex hooks.json hooks.UserPromptSubmit must be an array')
  }
  cleaned.hooks = {
    ...hooks,
    UserPromptSubmit: [...((existingEntries || []) as unknown[]), definition],
  }
  return `${JSON.stringify(cleaned, null, 2)}\n`
}

export function removeCodexHookRegistration(
  existing: string,
  codexHome: string
): { content: string; changed: boolean; empty: boolean } {
  const root = parseJsonRecord(existing, 'Codex hooks.json')
  const cleaned = removeCodexWorkflowHooks(root, codexHome)
  return {
    content: `${JSON.stringify(cleaned.root, null, 2)}\n`,
    changed: cleaned.changed,
    empty: Object.keys(cleaned.root).length === 0,
  }
}

export function parseCodexConfig(content: string | null): JsonRecord {
  if (content === null) return {}
  const config = asRecord(parseToml(content))
  if (!config) throw new Error('Codex config.toml root must be a TOML table')
  return config
}

export function assertCodexModeFeatures(config: JsonRecord): void {
  const features = config.features
  if (features === undefined) return
  const featureTable = asRecord(features)
  if (!featureTable) throw new Error('Codex config.toml features must be a TOML table')
  if (featureTable.hooks === false) {
    throw new Error('Codex config.toml explicitly disables the hooks feature required by CCG Codex mode')
  }
  if (featureTable.multi_agent === false) {
    throw new Error('Codex config.toml explicitly disables the multi_agent feature required by CCG Codex mode')
  }
}
