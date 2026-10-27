import fs from 'fs-extra'
import { homedir } from 'node:os'
import { join } from 'pathe'
import { parse } from 'smol-toml'
import { version } from '../../package.json'
import { listSkills, SKILL_MANIFEST_FILE } from './skill-manager'
import { compareVersions } from './version'
import { check, readText, record } from './doctor-common'
import type { DoctorCheck, DoctorDependencies, DoctorReport, RecordValue } from './doctor-common'
import { claudeChecks, codexChecks, modeChecks } from './doctor-hosts'
import {
  BACKENDS,
  backendChecks,
  executeVersion,
  readWrapperVersion,
  standaloneDelegationChecks,
  taskCheck,
  versionDetail,
} from './doctor-runtime'

export type { DoctorStatus, DoctorCheck, DoctorReport, DoctorDependencies } from './doctor-common'
export { readCodexModeStatus } from './doctor-hosts'
export { executeVersion, readTaskStatus } from './doctor-runtime'

function supportsCurrentNode(version: string): boolean {
  const match = version.match(/^v(\d+)\.(\d+)\./)
  if (!match) return false
  const major = Number(match[1])
  const minor = Number(match[2])
  return (major === 22 && minor >= 13) || major > 24 || (major === 24 && minor >= 19)
}

async function readConfiguration(path: string): Promise<{ config: RecordValue; result: DoctorCheck }> {
  const text = await readText(path)
  if (text === null) {
    return {
      config: {},
      result: check(
        'config',
        'CCG config',
        'warn',
        'Not found or unreadable',
        'Run npx ccg-workflow to configure model routing.'
      ),
    }
  }
  try {
    const config = record(parse(text))
    const configured = Object.keys(record(config.routing)).length > 0
    return {
      config,
      result: check(
        'config',
        'CCG config',
        configured ? 'pass' : 'fail',
        configured ? 'Readable TOML with model routing' : 'Missing model routing',
        'Reconfigure model routing with npx ccg-workflow.'
      ),
    }
  } catch {
    return {
      config: {},
      result: check(
        'config',
        'CCG config',
        'fail',
        'Invalid TOML',
        'Repair config.toml syntax or run npx ccg-workflow to reconfigure.'
      ),
    }
  }
}

function collectRouteBackends(route: RecordValue, names: Set<string>): boolean {
  const models = Array.isArray(route.models) ? route.models : null
  let invalid = typeof route.primary !== 'string' || !models
  const values = [route.primary, ...(models || [])].filter((v) => v !== undefined)
  for (const value of values) {
    if (typeof value !== 'string' || !Object.hasOwn(BACKENDS, value)) invalid = true
    else names.add(value)
  }
  return invalid || models?.length === 0
}

function invalidReviewProfiles(profiles: unknown): boolean {
  return (
    profiles !== undefined &&
    (!Array.isArray(profiles) ||
      profiles.length === 0 ||
      profiles.some((p) => !['gpt', 'grok'].includes(String(record(p).id))) ||
      new Set(profiles.map((p) => record(p).id)).size !== profiles.length)
  )
}

function selectedBackends(config: RecordValue): { names: string[]; invalid: boolean; invalidProfiles: boolean } {
  const names = new Set<string>()
  const routing = record(config.routing)
  let invalid = false
  for (const section of ['frontend', 'backend']) {
    invalid = collectRouteBackends(record(routing[section]), names) || invalid
  }
  const invalidProfiles = invalidReviewProfiles(record(routing.review).profiles)
  return { names: [...names].sort(), invalid: invalid || invalidProfiles, invalidProfiles }
}

function modeBackends(config: RecordValue, mode: DoctorReport['mode']) {
  const selection = ['claude', 'both'].includes(mode)
    ? selectedBackends(config)
    : { names: mode === 'codex' ? ['codex'] : [], invalid: false, invalidProfiles: false }
  return {
    ...selection,
    pureClaude: selection.names.length === 1 && selection.names[0] === 'claude' && !selection.invalid,
  }
}

type McpFormat = 'json' | 'toml'
async function mcpServerCount(path: string, format: McpFormat) {
  const text = await readText(path)
  if (!text) return { count: 0, invalid: false }
  try {
    const parsed = record(format === 'json' ? JSON.parse(text) : parse(text))
    return {
      count: Object.keys(record(parsed[format === 'json' ? 'mcpServers' : 'mcp_servers'])).length,
      invalid: false,
    }
  } catch {
    return { count: 0, invalid: true }
  }
}

async function mcpCheck(home: string, codexDir: string, mode: DoctorReport['mode']): Promise<DoctorCheck> {
  const sources: [string, McpFormat][] = []
  if (mode !== 'codex') sources.push([join(home, '.claude.json'), 'json'])
  if (mode !== 'claude') sources.push([join(codexDir, 'config.toml'), 'toml'])
  let count = 0
  let invalid = false
  for (const [path, format] of sources) {
    const source = await mcpServerCount(path, format)
    count += source.count
    invalid = invalid || source.invalid
  }
  return check(
    'mcp.config',
    'MCP servers',
    invalid ? 'warn' : count ? 'pass' : 'warn',
    invalid ? 'MCP configuration unreadable' : `${count} configured (connectivity not tested)`,
    'Run ccg diagnose-mcp for MCP configuration and connectivity checks.'
  )
}

function nativeSkillPaths(home: string, installDir: string, target: 'claude' | 'codex', deps: DoctorDependencies) {
  const root = target === 'claude' ? installDir : join(home, '.agents')
  return { nativeDir: join(root, 'skills'), storeDir: join(root, '.ccg-skills'), ...deps.skillPaths?.[target], target }
}

async function skillChecks(
  home: string,
  installDir: string,
  mode: DoctorReport['mode'],
  deps: DoctorDependencies
): Promise<DoctorCheck[]> {
  const required: ('claude' | 'codex')[] =
    mode === 'both' ? ['claude', 'codex'] : mode === 'claude' || mode === 'codex' ? [mode] : []
  const targets: ('claude' | 'codex')[] = []
  for (const target of ['claude', 'codex'] as const) {
    const paths = nativeSkillPaths(home, installDir, target, deps)
    if (required.includes(target) || (await fs.pathExists(join(paths.storeDir, SKILL_MANIFEST_FILE))))
      targets.push(target)
  }
  return Promise.all(
    targets.map(async (target) => {
      const paths = nativeSkillPaths(home, installDir, target, deps)
      const id = `${target}.skills`
      if (!(await fs.pathExists(join(paths.storeDir, SKILL_MANIFEST_FILE)))) {
        const legacy = await fs.pathExists(join(installDir, 'skills', 'ccg', 'SKILL.md'))
        return check(
          id,
          `${target === 'claude' ? 'Claude' : 'Codex'} skills`,
          'warn',
          legacy ? 'Legacy bundled skills found; native selection not configured' : 'No managed native skill selection',
          `Use ccg skills catalog and ccg skills install <names> --target ${target} to select native skills.`
        )
      }
      try {
        const entries = (await listSkills(paths)).filter((entry) => entry.installed)
        const broken = entries.filter((entry) => !entry.healthy)
        return check(
          id,
          `${target === 'claude' ? 'Claude' : 'Codex'} skills`,
          broken.length ? 'fail' : 'pass',
          `${entries.length - broken.length}/${entries.length} managed skills healthy`,
          `Run ccg skills list --installed --target ${target}; inspect changed aliases and caches before updating.`
        )
      } catch {
        return check(
          id,
          `${target === 'claude' ? 'Claude' : 'Codex'} skills`,
          'fail',
          'Managed skill manifest or directories are invalid',
          `Inspect managed skill paths and run ccg skills list --target ${target}.`
        )
      }
    })
  )
}

function doctorEnvironment(deps: DoctorDependencies) {
  const home = deps.home || homedir()
  const installDir = deps.installDir || join(home, '.claude')
  return {
    home,
    installDir,
    codexDir: deps.codexDir || join(home, '.codex'),
    configPath: deps.configPath || join(installDir, '.ccg', 'config.toml'),
    platform: deps.platform || process.platform,
    exec: deps.exec || executeVersion,
    nodeVersion: deps.nodeVersion || process.version,
  }
}
type DoctorEnvironment = ReturnType<typeof doctorEnvironment>

function adjustConfigCheck(result: DoctorCheck, mode: DoctorReport['mode']): void {
  if (mode === 'codex') {
    result.status = result.status === 'warn' ? 'skip' : result.status === 'fail' ? 'warn' : 'pass'
    if (result.status === 'skip') result.detail = 'Claude routing config is optional for standalone Codex mode'
    result.remediation =
      result.status === 'warn'
        ? 'Repair optional Claude routing config before enabling external model delegation.'
        : null
  }
  if (['claude', 'both'].includes(mode) && result.status === 'warn') result.status = 'fail'
  if (mode === 'skills' && result.status === 'warn') {
    result.status = 'skip'
    result.detail = 'Workflow routing is optional for standalone native skills'
    result.remediation = null
  }
}

function initialChecks(nodeVersion: string, result: DoctorCheck, mode: DoctorReport['mode']): DoctorCheck[] {
  return [
    check(
      'runtime.node',
      'Node.js',
      supportsCurrentNode(nodeVersion) ? 'pass' : 'fail',
      nodeVersion,
      'Install Node.js ^22.13.0 or >=24.19.0.'
    ),
    result,
    check(
      'installation.mode',
      'Installation',
      mode === 'none' ? 'fail' : 'pass',
      mode === 'none' ? 'No CCG managed installation found' : `CCG ${mode} mode`
    ),
  ]
}

function installedVersionCheck(config: RecordValue): DoctorCheck {
  const installedVersion = record(config.general).version
  let detail = 'Installed version unavailable'
  if (typeof installedVersion === 'string') {
    const comparison =
      installedVersion === version
        ? ' (matches)'
        : compareVersions(installedVersion, version) < 0
          ? ' (update workflows)'
          : ' (different)'
    detail = `v${installedVersion}; local CLI v${version}${comparison}`
  }
  return check(
    'installation.version',
    'Installed version',
    installedVersion === version ? 'pass' : 'warn',
    detail,
    'Run the repository installer to refresh workflows with this local CLI.'
  )
}

async function workflowChecks(
  config: RecordValue,
  selection: ReturnType<typeof selectedBackends>,
  installDir: string,
  commandFiles: string[]
): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = []
  const { names, invalid, invalidProfiles } = selection
  if (Object.keys(config).length > 0)
    checks.push(
      check(
        'routing.backends',
        'Model routing',
        invalid ? 'fail' : 'pass',
        invalid ? 'Invalid or unsupported backend routing' : names.join(', '),
        'Reconfigure frontend, backend and review routing with npx ccg-workflow.'
      )
    )
  checks.push(installedVersionCheck(config))
  checks.push(...(await claudeChecks(installDir, commandFiles)))
  checks.push(
    check(
      'review.profiles',
      'Review profiles',
      invalidProfiles ? 'fail' : 'pass',
      invalidProfiles
        ? 'Invalid or duplicate GPT/Grok review profiles'
        : 'GPT/Grok use explicit independent temporary Claude sessions; the primary routes are unchanged',
      'Reconfigure routing.review.profiles with unique gpt and grok profile IDs.'
    )
  )
  return checks
}

async function modelRuntimeChecks(
  env: DoctorEnvironment,
  mode: DoctorReport['mode'],
  names: string[],
  pureClaude: boolean
): Promise<DoctorCheck[]> {
  const { installDir, codexDir, home, platform, exec } = env
  const checks: DoctorCheck[] = []
  if (mode === 'codex') checks.push(...(await standaloneDelegationChecks(installDir, codexDir, home, platform, exec)))
  if (!pureClaude && ['claude', 'both'].includes(mode)) {
    const raw = await readWrapperVersion(installDir, platform, exec)
    checks.push(
      check(
        'binary.wrapper',
        'Binary',
        raw ? 'pass' : 'fail',
        raw ? versionDetail(raw) : 'codeagent-wrapper not found or --version failed'
      )
    )
  }
  checks.push(...(await backendChecks(names, pureClaude, home, platform, exec)))
  return checks
}

export async function collectDoctorReport(deps: DoctorDependencies = {}): Promise<DoctorReport> {
  const env = doctorEnvironment(deps)
  const { home, installDir, codexDir, configPath, exec, nodeVersion } = env
  const { config, result } = await readConfiguration(configPath)
  const nativeManifests = await Promise.all(
    (['claude', 'codex'] as const).map((target) =>
      fs.pathExists(join(nativeSkillPaths(home, installDir, target, deps).storeDir, SKILL_MANIFEST_FILE))
    )
  )
  const { mode, commandFiles, codexStatus } = await modeChecks(installDir, codexDir, nativeManifests.some(Boolean))
  const workflowInstalled = ['claude', 'both'].includes(mode)
  adjustConfigCheck(result, mode)
  const selection = modeBackends(config, mode)
  const { names, pureClaude } = selection
  const checks = initialChecks(nodeVersion, result, mode)
  if (workflowInstalled) checks.push(...(await workflowChecks(config, selection, installDir, commandFiles)))
  if (mode === 'codex' || mode === 'both') checks.push(...(await codexChecks(codexDir, codexStatus)))
  else if (workflowInstalled) checks.push(check('codex.agents', 'Codex mode', 'skip', codexStatus.detail))
  checks.push(...(await modelRuntimeChecks(env, mode, names, pureClaude)))
  if (workflowInstalled || mode === 'codex') {
    checks.push(await taskCheck(deps.root || process.cwd(), mode === 'codex' ? codexDir : installDir, exec))
  }
  checks.push(...(await skillChecks(home, installDir, mode, deps)))
  checks.push(await mcpCheck(home, codexDir, mode))
  return {
    schemaVersion: 1,
    version,
    mode,
    backends: names,
    checks,
    failureCount: checks.filter((c) => c.status === 'fail').length,
    warningCount: checks.filter((c) => c.status === 'warn').length,
  }
}
