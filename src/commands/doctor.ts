import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import ansis from 'ansis'
import fs from 'fs-extra'
import { join } from 'pathe'
import { version as packageVersion } from '../../package.json'
import { readCcgConfig } from '../utils/config'
import { defaultDshHome, findDshProfiles } from '../utils/installer-dsh'

const OK = ansis.green('✓')
const WARN = ansis.yellow('⚠')
const FAIL = ansis.red('✗')
const OPEN_LIKE_TASK_STATUSES = new Set([
  'open',
  'in_progress',
  'in-progress',
  'active',
  'pending',
  'paused',
  'suspended',
])
const REQUIRED_HOOK_SCRIPTS = [
  'session-start.js',
  'skill-router.js',
  'subagent-context.js',
  'task-state.js',
  'task-utils.js',
  'workflow-state.js',
]
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

type CodexModeStatus =
  | { kind: 'installed'; detail: string }
  | { kind: 'incomplete'; detail: string }
  | { kind: 'not-installed'; detail: string }

async function dirFiles(path: string): Promise<string[]> {
  if (!(await fs.pathExists(path))) return []
  return (await fs.readdir(path)).filter((file) => !file.startsWith('.'))
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await fs.lstat(path)).isFile()
  } catch {
    return false
  }
}

function isCodexWorkflowHookCommand(command: unknown, expectedPath: string): boolean {
  if (typeof command !== 'string') return false
  const normalized = command.replace(/\\/g, '/').trim()
  const match = /^python3\s+(?:"([^"]+)"|'([^']+)'|(\S+))$/.exec(normalized)
  const scriptPath = match?.[1] || match?.[2] || match?.[3]
  return scriptPath === expectedPath
}

function countCodexHookRegistrations(value: unknown): number {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 0
  const hooks = (value as { hooks?: unknown }).hooks
  if (typeof hooks !== 'object' || hooks === null || Array.isArray(hooks)) return 0
  const promptHooks = (hooks as { UserPromptSubmit?: unknown }).UserPromptSubmit
  if (!Array.isArray(promptHooks)) return 0
  const expectedPath = join(homedir(), '.codex', 'hooks', 'ccg-workflow.py').replace(/\\/g, '/')
  let count = 0
  for (const entry of promptHooks) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
    const commands = (entry as { hooks?: unknown }).hooks
    if (!Array.isArray(commands)) continue
    for (const hook of commands) {
      if (typeof hook !== 'object' || hook === null || Array.isArray(hook)) continue
      const command = (hook as { command?: unknown }).command
      if (isCodexWorkflowHookCommand(command, expectedPath)) count++
    }
  }
  return count
}

async function readCodexModeStatus(): Promise<CodexModeStatus> {
  const codexHome = join(homedir(), '.codex')
  const agentsPath = join(codexHome, 'AGENTS.md')
  let managedAgents = false
  if (await isRegularFile(agentsPath)) {
    try {
      const content = await fs.readFile(agentsPath, 'utf-8')
      const startPrefixes = content.split(CODEX_MANAGED_BLOCK_START_PREFIX).length - 1
      const starts = content.split(CODEX_MANAGED_BLOCK_START).length - 1
      const ends = content.split(CODEX_MANAGED_BLOCK_END).length - 1
      managedAgents =
        startPrefixes === 1 &&
        starts === 1 &&
        ends === 1 &&
        content.indexOf(CODEX_MANAGED_BLOCK_START) < content.indexOf(CODEX_MANAGED_BLOCK_END)
    } catch {
      // Report unreadable CCG artifacts as incomplete below
    }
  }

  const fileStates = await Promise.all(
    REQUIRED_CODEX_MODE_FILES.map(async (file) => ({ file, exists: await isRegularFile(join(codexHome, file)) }))
  )
  const hooksPath = join(codexHome, 'hooks.json')
  let hookRegistered = false
  if (await isRegularFile(hooksPath)) {
    try {
      hookRegistered = countCodexHookRegistrations(await fs.readJson(hooksPath)) === 1
    } catch {
      // Report a damaged registration as incomplete when other CCG artifacts exist
    }
  }

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

function execSafe(command: string, args: string[] = []): string | null {
  try {
    return execFileSync(command, args, { stdio: 'pipe', timeout: 10_000 }).toString().trim()
  } catch {
    return null
  }
}

function supportsCurrentNode(version: string): boolean {
  const match = version.match(/^v(\d+)\.(\d+)\./)
  if (!match) return false
  const major = Number(match[1])
  const minor = Number(match[2])
  return (major === 22 && minor >= 13) || major > 24 || (major === 24 && minor >= 19)
}

function routedModels(config: Awaited<ReturnType<typeof readCcgConfig>>): Set<string> {
  const models: Array<string | undefined> = [
    config?.routing?.frontend?.primary,
    config?.routing?.backend?.primary,
    ...(config?.routing?.frontend?.models || []),
    ...(config?.routing?.backend?.models || []),
  ]
  return new Set(models.filter((model): model is string => typeof model === 'string'))
}

async function countOpenTasks(root: string): Promise<number | null> {
  const tasksDir = join(root, '.ccg', 'tasks')
  if (!(await fs.pathExists(tasksDir))) return 0
  try {
    let count = 0
    for (const entry of await fs.readdir(tasksDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const taskPath = join(tasksDir, entry.name, 'task.json')
      if (!(await fs.pathExists(taskPath))) continue
      const task = await fs.readJson(taskPath)
      if (OPEN_LIKE_TASK_STATUSES.has(String(task?.status || '').toLowerCase())) count++
    }
    return count
  } catch {
    return null
  }
}

async function countBindings(root: string): Promise<number | null> {
  const sessionsDir = join(root, '.ccg', 'sessions')
  if (!(await fs.pathExists(sessionsDir))) return 0
  try {
    return (await fs.readdir(sessionsDir, { withFileTypes: true })).filter(
      (entry) => entry.isFile() && /^(?:claude|codex)-[0-9a-f]{64}\.json$/.test(entry.name)
    ).length
  } catch {
    return null
  }
}

async function readTaskStatus(root: string, installDir: string): Promise<string> {
  const statePath = join(root, '.ccg', 'state.json')
  if (!(await fs.pathExists(statePath))) return 'schema=none, open=0, bindings=0'
  let state: Record<string, unknown>
  try {
    state = (await fs.readJson(statePath)) as Record<string, unknown>
  } catch {
    return 'invalid-state'
  }

  const sessionKey = process.env.CCG_SESSION_KEY
  if (sessionKey !== undefined && !/^(?:claude|codex)-[0-9a-f]{64}$/.test(sessionKey)) {
    return 'session-key-invalid'
  }
  if (sessionKey) {
    const controller = join(installDir, 'hooks', 'ccg', 'task-state.js')
    if (await fs.pathExists(controller)) {
      const output = execSafe(process.execPath, [controller, 'resolve', '--root', root, '--session-key', sessionKey])
      if (output) {
        try {
          const resolution = JSON.parse(output) as Record<string, unknown>
          if (resolution.ok === true && resolution.kind === 'active') {
            return `in_progress: ${String(resolution.activeTaskId)}`
          }
          if (resolution.ok === true) return String(resolution.kind || 'none')
        } catch {
          return 'session-state-invalid'
        }
      }
      return 'session-state-unavailable'
    }
  }

  const schema = Number.isSafeInteger(state.schemaVersion) ? `v${String(state.schemaVersion)}` : 'invalid'
  const openTasks = await countOpenTasks(root)
  const bindings = await countBindings(root)
  return `schema=${schema}, open=${openTasks ?? '?'}, bindings=${bindings ?? '?'}`
}

export async function doctor(): Promise<void> {
  const installDir = join(homedir(), '.claude')
  const checks: Array<{ label: string; status: string; detail: string }> = []

  checks.push({
    label: 'Node.js',
    status: supportsCurrentNode(process.version) ? OK : FAIL,
    detail: `${process.version}${supportsCurrentNode(process.version) ? '' : ' (requires ^22.13.0 or >=24.19.0)'}`,
  })

  const config = await readCcgConfig()
  checks.push({
    label: 'CCG config',
    status: config ? OK : WARN,
    detail: config
      ? `v${config.general?.version || '?'}, lang=${config.general?.language || '?'}`
      : 'Not found (~/.claude/.ccg/config.toml)',
  })

  const commands = (await dirFiles(join(installDir, 'commands', 'ccg'))).filter((file) => file.endsWith('.md'))
  checks.push({
    label: 'Commands',
    status: commands.length > 0 ? OK : FAIL,
    detail: `${commands.length} installed`,
  })

  const hookFiles = await dirFiles(join(installDir, 'hooks', 'ccg'))
  const missingHooks = REQUIRED_HOOK_SCRIPTS.filter((file) => !hookFiles.includes(file))
  checks.push({
    label: 'Hook runtime',
    status: missingHooks.length === 0 ? OK : missingHooks.length < REQUIRED_HOOK_SCRIPTS.length ? WARN : FAIL,
    detail:
      missingHooks.length === 0 ? `${REQUIRED_HOOK_SCRIPTS.length} scripts` : `missing: ${missingHooks.join(', ')}`,
  })

  let hooksRegistered = 0
  const settingsPath = join(installDir, 'settings.json')
  if (await fs.pathExists(settingsPath)) {
    try {
      const settings = await fs.readJson(settingsPath)
      for (const entries of Object.values(settings.hooks || {}) as unknown[]) {
        if (!Array.isArray(entries)) continue
        for (const entry of entries) {
          const candidate = typeof entry === 'object' && entry !== null ? (entry as { hooks?: unknown }) : null
          const hooks = Array.isArray(candidate?.hooks) ? candidate.hooks : []
          if (
            hooks.some(
              (hook) =>
                typeof hook === 'object' &&
                hook !== null &&
                typeof (hook as { command?: unknown }).command === 'string' &&
                (hook as { command: string }).command.includes('hooks/ccg/')
            )
          ) {
            hooksRegistered++
          }
        }
      }
    } catch {
      hooksRegistered = -1
    }
  }
  checks.push({
    label: 'Hook registration',
    status: hooksRegistered >= 5 ? OK : hooksRegistered > 0 ? WARN : FAIL,
    detail: hooksRegistered < 0 ? 'settings.json is invalid' : `${hooksRegistered}/5 events`,
  })

  const wrapperName = process.platform === 'win32' ? 'codeagent-wrapper.exe' : 'codeagent-wrapper'
  const wrapperPath = join(installDir, 'bin', wrapperName)
  const binaryOutput = (await fs.pathExists(wrapperPath)) ? execSafe(wrapperPath, ['--version']) : null
  const binaryVersion = binaryOutput?.replace(/^.*version\s*/, '') || null
  checks.push({
    label: 'Binary',
    status: binaryVersion ? OK : FAIL,
    detail: binaryVersion ? `v${binaryVersion}` : `Not executable (${wrapperPath})`,
  })

  checks.push({
    label: 'Skills',
    status: (await fs.pathExists(join(installDir, 'skills', 'ccg'))) ? OK : WARN,
    detail: (await fs.pathExists(join(installDir, 'skills', 'ccg'))) ? 'Installed' : 'Not found',
  })

  const rules = (await dirFiles(join(installDir, 'rules'))).filter((file) => file.startsWith('ccg-'))
  checks.push({
    label: 'Rules',
    status: rules.length >= 2 ? OK : rules.length > 0 ? WARN : FAIL,
    detail: rules.length > 0 ? rules.join(', ') : 'None',
  })

  let mcpServers: string[] = []
  const claudeJsonPath = join(homedir(), '.claude.json')
  if (await fs.pathExists(claudeJsonPath)) {
    try {
      const claudeConfig = await fs.readJson(claudeJsonPath)
      mcpServers = Object.keys(claudeConfig.mcpServers || {})
    } catch {
      mcpServers = ['invalid-config']
    }
  }
  checks.push({
    label: 'MCP servers',
    status: mcpServers.length > 0 && !mcpServers.includes('invalid-config') ? OK : WARN,
    detail: mcpServers.length > 0 ? mcpServers.join(', ') : 'None configured',
  })

  const codexMode = await readCodexModeStatus()
  checks.push({
    label: 'Codex mode',
    status: codexMode.kind === 'installed' ? OK : codexMode.kind === 'incomplete' ? WARN : ansis.gray('—'),
    detail: codexMode.detail,
  })

  const models = routedModels(config)
  const cliChecks: Array<[string, string, string[], string]> = [
    ['antigravity', 'agy', ['--version'], 'Antigravity CLI'],
    ['codex', 'codex', ['--version'], 'Codex CLI'],
    ['kimi', 'kimi', ['--version'], 'Kimi Code CLI'],
    ['opencode', 'opencode', ['--version'], 'OpenCode CLI'],
  ]
  for (const [model, command, args, label] of cliChecks) {
    if (!models.has(model)) continue
    const output = execSafe(command, args)
    checks.push({
      label,
      status: output ? OK : FAIL,
      detail: output ? output.split('\n')[0] : 'Not found',
    })
  }

  if (models.has('grok')) {
    const grokName = process.platform === 'win32' ? 'grok.exe' : 'grok'
    const fallback = join(homedir(), '.grok', 'bin', grokName)
    const output =
      execSafe('grok', ['--version']) || ((await fs.pathExists(fallback)) ? execSafe(fallback, ['--version']) : null)
    checks.push({
      label: 'Grok CLI',
      status: output ? OK : FAIL,
      detail: output ? output.split('\n')[0] : 'Not found',
    })
  }

  if (models.size === 1 && models.has('claude')) {
    checks.push({
      label: 'Pure Claude Code',
      status: OK,
      detail: 'Agent Teams mode; no primary external model CLI required',
    })
  }

  console.log()
  console.log(ansis.cyan.bold(`  CCG Doctor v${packageVersion}`))
  console.log()
  for (const { label, status, detail } of checks) {
    console.log(`  ${status} ${ansis.bold(label.padEnd(20))} ${ansis.gray(detail)}`)
  }

  const failures = checks.filter((check) => check.status === FAIL)
  console.log()
  if (failures.length === 0) {
    console.log(ansis.green('  All required checks passed.'))
  } else {
    console.log(
      ansis.red(`  ${failures.length} issue(s) found. Re-run the private repository installer to repair them.`)
    )
  }
  console.log()
}

export async function status(): Promise<void> {
  const installDir = join(homedir(), '.claude')
  const config = await readCcgConfig()
  const installedVersion = config?.general?.version || 'unknown'
  const commands = (await dirFiles(join(installDir, 'commands', 'ccg'))).filter((file) => file.endsWith('.md'))
  const hooks = (await dirFiles(join(installDir, 'hooks', 'ccg'))).filter((file) => file.endsWith('.js'))
  const wrapperName = process.platform === 'win32' ? 'codeagent-wrapper.exe' : 'codeagent-wrapper'
  const wrapperPath = join(installDir, 'bin', wrapperName)
  const binaryOutput = (await fs.pathExists(wrapperPath)) ? execSafe(wrapperPath, ['--version']) : null
  const binaryVersion = binaryOutput?.replace(/^.*version\s*/, 'v') || '—'

  let mcpServers: string[] = []
  const claudeJsonPath = join(homedir(), '.claude.json')
  if (await fs.pathExists(claudeJsonPath)) {
    try {
      const claudeConfig = await fs.readJson(claudeJsonPath)
      mcpServers = Object.keys(claudeConfig.mcpServers || {})
    } catch {
      mcpServers = ['invalid-config']
    }
  }

  const dshProfiles = await findDshProfiles(defaultDshHome())
  const dshInstalled = dshProfiles.filter((profile) => profile.installed).map((profile) => profile.name)
  const codexMode = await readCodexModeStatus()
  const taskStatus = await readTaskStatus(process.cwd(), installDir)

  console.log()
  console.log(ansis.cyan.bold('  CCG Status'))
  console.log()
  console.log(`  ${ansis.bold('Installed')}      ${installedVersion}`)
  console.log(
    `  ${ansis.bold('Current CLI')}    ${packageVersion}${installedVersion === packageVersion ? ansis.green(' (matches)') : ansis.yellow(' (different)')}`
  )
  console.log(`  ${ansis.bold('Commands')}       ${commands.length}`)
  console.log(`  ${ansis.bold('Hooks')}          ${hooks.length} scripts`)
  console.log(`  ${ansis.bold('Binary')}         ${binaryVersion}`)
  console.log(`  ${ansis.bold('Frontend')}       ${config?.routing?.frontend?.primary || '—'}`)
  console.log(`  ${ansis.bold('Backend')}        ${config?.routing?.backend?.primary || '—'}`)
  console.log(`  ${ansis.bold('MCP')}            ${mcpServers.length > 0 ? mcpServers.join(', ') : ansis.gray('none')}`)
  console.log(
    `  ${ansis.bold('Codex mode')}     ${
      codexMode.kind === 'installed'
        ? 'installed'
        : codexMode.kind === 'incomplete'
          ? ansis.yellow(codexMode.detail.toLowerCase())
          : ansis.gray('not installed')
    }`
  )
  console.log(
    `  ${ansis.bold('DSH profiles')}   ${dshInstalled.length > 0 ? dshInstalled.join(', ') : ansis.gray('none')}`
  )
  console.log(`  ${ansis.bold('Task state')}     ${taskStatus}`)
  console.log()
}
