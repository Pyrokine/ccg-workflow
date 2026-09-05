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
const REQUIRED_HOOK_SCRIPTS = [
  'session-start.js',
  'skill-router.js',
  'subagent-context.js',
  'task-state.js',
  'task-utils.js',
  'workflow-state.js',
]

async function dirFiles(path: string): Promise<string[]> {
  if (!(await fs.pathExists(path))) return []
  return (await fs.readdir(path)).filter((file) => !file.startsWith('.'))
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

async function readActiveTaskId(root: string): Promise<string | null> {
  const statePath = join(root, '.ccg', 'state.json')
  if (!(await fs.pathExists(statePath))) return null
  try {
    const state = await fs.readJson(statePath)
    return typeof state.activeTaskId === 'string' && state.activeTaskId !== '' ? state.activeTaskId : null
  } catch {
    return 'invalid-state'
  }
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

  checks.push({
    label: 'Codex mode',
    status: (await fs.pathExists(join(homedir(), '.codex', 'AGENTS.md'))) ? OK : ansis.gray('—'),
    detail: (await fs.pathExists(join(homedir(), '.codex', 'AGENTS.md'))) ? 'Installed' : 'Not installed (optional)',
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
  const activeTaskId = await readActiveTaskId(process.cwd())

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
    `  ${ansis.bold('Codex mode')}     ${(await fs.pathExists(join(homedir(), '.codex', 'AGENTS.md'))) ? 'installed' : ansis.gray('not installed')}`
  )
  console.log(
    `  ${ansis.bold('DSH profiles')}   ${dshInstalled.length > 0 ? dshInstalled.join(', ') : ansis.gray('none')}`
  )
  console.log(`  ${ansis.bold('Active task')}    ${activeTaskId || ansis.gray('none')}`)
  console.log()
}
