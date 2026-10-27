import fs from 'fs-extra'
import { homedir } from 'node:os'
import { join } from 'pathe'
import { parse } from 'smol-toml'
import { check, files, isRegularFile, readText, record } from './doctor-common'
import type { DoctorCheck, DoctorReport, RecordValue } from './doctor-common'

const REQUIRED_CODEX_MODE_FILES = [
  '.ccg/codex-mode.json',
  'agents/ccg-implement.toml',
  'agents/ccg-review.toml',
  'agents/ccg-research.toml',
  'hooks/ccg-workflow.py',
  'hooks/ccg/package.json',
  'hooks/ccg/task-utils.js',
  'hooks/ccg/task-state.js',
]
const CODEX_MANAGED_BLOCK_START_PREFIX = '<!-- CCG:START'
const CODEX_MANAGED_BLOCK_START = '<!-- CCG:START — Managed by CCG Workflow. Do not edit this block manually. -->'
const CODEX_MANAGED_BLOCK_END = '<!-- CCG:END -->'
const HOOK_FILES = [
  'task-utils.js',
  'task-state.js',
  'workflow-state.js',
  'session-start.js',
  'subagent-context.js',
  'skill-router.js',
]
const HOOK_EVENTS: Record<string, string[]> = {
  UserPromptSubmit: ['workflow-state.js', 'skill-router.js'],
  SessionStart: ['session-start.js'],
  PreToolUse: ['subagent-context.js'],
  PostToolUse: ['workflow-state.js'],
  PostToolUseFailure: ['workflow-state.js'],
}

type CodexModeStatus =
  | { kind: 'installed'; detail: string }
  | { kind: 'incomplete'; detail: string }
  | { kind: 'not-installed'; detail: string }

function isCodexWorkflowHookCommand(command: unknown, expectedPath: string): boolean {
  if (typeof command !== 'string') return false
  const normalized = command.replace(/\\/g, '/').trim()
  const match = /^python3\s+(?:"([^"]+)"|'([^']+)'|(\S+))$/.exec(normalized)
  const scriptPath = match?.[1] || match?.[2] || match?.[3]
  return scriptPath === expectedPath
}

function countCodexHookRegistrations(value: unknown, codexHome: string): number {
  const promptHooks = record(record(value).hooks).UserPromptSubmit
  if (!Array.isArray(promptHooks)) return 0
  const expectedPath = join(codexHome, 'hooks', 'ccg-workflow.py').replace(/\\/g, '/')
  let count = 0
  for (const entry of promptHooks) {
    const commands = record(entry).hooks
    if (!Array.isArray(commands)) continue
    for (const hook of commands) {
      if (isCodexWorkflowHookCommand(record(hook).command, expectedPath)) count++
    }
  }
  return count
}

async function hasManagedAgentsBlock(path: string): Promise<boolean> {
  if (!(await isRegularFile(path))) return false
  const content = await readText(path)
  if (content === null) return false
  const startPrefixes = content.split(CODEX_MANAGED_BLOCK_START_PREFIX).length - 1
  const starts = content.split(CODEX_MANAGED_BLOCK_START).length - 1
  const ends = content.split(CODEX_MANAGED_BLOCK_END).length - 1
  return (
    startPrefixes === 1 &&
    starts === 1 &&
    ends === 1 &&
    content.indexOf(CODEX_MANAGED_BLOCK_START) < content.indexOf(CODEX_MANAGED_BLOCK_END)
  )
}

async function hasRegisteredCodexHook(codexHome: string): Promise<boolean> {
  const path = join(codexHome, 'hooks.json')
  if (!(await isRegularFile(path))) return false
  try {
    return countCodexHookRegistrations(await fs.readJson(path), codexHome) === 1
  } catch {
    // Report a damaged registration as incomplete when other CCG artifacts exist
    return false
  }
}

export async function readCodexModeStatus(codexHome = join(homedir(), '.codex')): Promise<CodexModeStatus> {
  const managedAgents = await hasManagedAgentsBlock(join(codexHome, 'AGENTS.md'))
  const fileStates = await Promise.all(
    REQUIRED_CODEX_MODE_FILES.map(async (file) => ({ file, exists: await isRegularFile(join(codexHome, file)) }))
  )
  const hookRegistered = await hasRegisteredCodexHook(codexHome)
  const hasCcgArtifact = managedAgents || hookRegistered || fileStates.some(({ exists }) => exists)
  if (!hasCcgArtifact) return { kind: 'not-installed', detail: 'Not installed (optional)' }

  const missing = fileStates.filter(({ exists }) => !exists).map(({ file }) => file)
  if (!managedAgents) missing.unshift('AGENTS.md (CCG block)')
  if (!hookRegistered) missing.push('hooks.json (CCG registration)')
  if (missing.length > 0) {
    return { kind: 'incomplete', detail: `Incomplete; missing: ${missing.join(', ')}` }
  }
  return { kind: 'installed', detail: 'Installed' }
}

export async function modeChecks(installDir: string, codexDir: string, hasNativeSkills: boolean) {
  const commandFiles = (await files(join(installDir, 'commands', 'ccg'))).filter((f) => f.endsWith('.md'))
  const claude = commandFiles.length > 0 || (await fs.pathExists(join(installDir, 'commands', 'ccg.md')))
  const codexStatus = await readCodexModeStatus(codexDir)
  const codex = codexStatus.kind !== 'not-installed'
  const mode: DoctorReport['mode'] = claude
    ? codex
      ? 'both'
      : 'claude'
    : codex
      ? 'codex'
      : hasNativeSkills
        ? 'skills'
        : 'none'
  return { mode, commandFiles, codexStatus }
}

function normalized(command: string): string {
  return command.replaceAll('\\', '/')
}

function registeredCommands(settings: RecordValue, event: string): string[] {
  const entries = record(settings.hooks)[event]
  if (!Array.isArray(entries)) return []
  return entries.flatMap((entry) => {
    const handlers = record(entry).hooks
    return Array.isArray(handlers)
      ? handlers
          .filter((h) => record(h).type === 'command' && typeof record(h).command === 'string')
          .map((h) => String(record(h).command))
      : []
  })
}

function references(command: string, path: string): boolean {
  const value = normalized(command)
  const expected = normalized(path)
  const start = value.indexOf(expected)
  if (start < 0) return false
  const before = value[start - 1]
  const after = value[start + expected.length]
  return (!before || /[\s"']/.test(before)) && (!after || /[\s"']/.test(after))
}

async function claudeRegistrationStatus(installDir: string) {
  const hookDir = join(installDir, 'hooks', 'ccg')
  const settings = await readText(join(installDir, 'settings.json'))
  let registered = 0
  let registeredEvents = 0
  let invalidSettings = false
  try {
    const json = record(JSON.parse(settings || '{}'))
    for (const [event, handlers] of Object.entries(HOOK_EVENTS)) {
      const commands = registeredCommands(json, event)
      const count = handlers.filter((name) => commands.some((cmd) => references(cmd, join(hookDir, name)))).length
      registered += count
      if (count === handlers.length) registeredEvents++
    }
  } catch {
    invalidSettings = true
  }
  return { registered, registeredEvents, invalidSettings }
}

export async function claudeChecks(installDir: string, commandFiles: string[]): Promise<DoctorCheck[]> {
  const hookFiles = await files(join(installDir, 'hooks', 'ccg'))
  const missing = HOOK_FILES.filter((f) => !hookFiles.includes(f))
  const { registered, registeredEvents, invalidSettings } = await claudeRegistrationStatus(installDir)
  const rules = (await files(join(installDir, 'rules'))).filter((f) => f.startsWith('ccg-') && f.endsWith('.md'))
  const hasEngineCommand = await fs.pathExists(join(installDir, 'commands', 'ccg.md'))
  const hookDetail = `${HOOK_FILES.length - missing.length}/${HOOK_FILES.length} scripts`
  return [
    check(
      'claude.commands',
      'Commands',
      commandFiles.length > 0 || hasEngineCommand ? 'pass' : 'fail',
      `${commandFiles.length} workflow commands${hasEngineCommand ? ', engine entry installed' : ''}`
    ),
    check(
      'claude.hooks',
      'Hook runtime',
      missing.length === 0 ? 'pass' : 'fail',
      `${hookDetail}${missing.length ? `; missing: ${missing.join(', ')}` : ''}`
    ),
    check(
      'claude.hook-registration',
      'Hook registration',
      registered === 6 && !invalidSettings ? 'pass' : 'fail',
      invalidSettings
        ? 'settings.json is invalid'
        : `${registered}/6 handlers across ${registeredEvents}/5 events in settings.json`
    ),
    check('claude.rules', 'Rules', rules.length >= 2 ? 'pass' : 'warn', `${rules.length} CCG rules installed`),
  ]
}

async function codexHookRegistered(codexDir: string): Promise<boolean> {
  try {
    const settings = record(JSON.parse((await readText(join(codexDir, 'hooks.json'))) || '{}'))
    return countCodexHookRegistrations(settings, codexDir) === 1
  } catch {
    /* Do not expose user hook commands. */
    return false
  }
}

async function validCodexConfig(codexDir: string): Promise<boolean> {
  const configText = await readText(join(codexDir, 'config.toml'))
  try {
    const config = configText !== null ? record(parse(configText)) : null
    return config !== null && record(config.features).hooks !== false && record(config.features).multi_agent !== false
  } catch {
    /* Configuration contents and errors may contain provider secrets. */
    return false
  }
}

export async function codexChecks(codexDir: string, status: CodexModeStatus): Promise<DoctorCheck[]> {
  const required = REQUIRED_CODEX_MODE_FILES
  const present = await Promise.all(required.map((path) => isRegularFile(join(codexDir, path))))
  const hookRegistered = await codexHookRegistered(codexDir)
  const validConfig = await validCodexConfig(codexDir)
  return [
    check(
      'codex.agents',
      'Codex mode',
      status.kind === 'installed' ? 'pass' : 'fail',
      status.detail,
      'Run ccg codex-mode install.'
    ),
    check(
      'codex.artifacts',
      'Codex files',
      present.every(Boolean) ? 'pass' : 'fail',
      `${present.filter(Boolean).length}/${required.length} managed agent and hook files`,
      'Run ccg codex-mode install.'
    ),
    check(
      'codex.hook-registration',
      'Codex hooks',
      hookRegistered ? 'pass' : 'fail',
      hookRegistered ? 'CCG workflow hook registered' : 'CCG workflow hook not registered',
      'Run ccg codex-mode install.'
    ),
    check(
      'codex.config',
      'Codex config',
      validConfig ? 'pass' : 'fail',
      validConfig ? 'Readable Codex TOML' : 'Missing or invalid Codex TOML',
      'Run ccg codex-mode install or repair the existing Codex config.toml.'
    ),
  ]
}
