import fs from 'fs-extra'
import { execFileSync } from 'node:child_process'
import { join } from 'pathe'
import { check, readText } from './doctor-common'
import type { DoctorCheck, DoctorDependencies, RecordValue } from './doctor-common'

const OPEN_LIKE_TASK_STATUSES = new Set([
  'open',
  'in_progress',
  'in-progress',
  'active',
  'pending',
  'paused',
  'suspended',
])
export const BACKENDS: Record<string, { label: string; commands: string[]; windows: string[] }> = {
  codex: { label: 'Codex CLI', commands: ['codex'], windows: ['codex.cmd', 'codex.exe'] },
  antigravity: { label: 'Antigravity CLI', commands: ['agy'], windows: ['agy.exe', 'agy.cmd'] },
  claude: { label: 'Claude CLI', commands: ['claude'], windows: ['claude.exe', 'claude.cmd'] },
  kimi: { label: 'Kimi Code CLI', commands: ['kimi'], windows: ['kimi.exe'] },
  grok: { label: 'Grok CLI', commands: ['grok'], windows: ['grok.exe'] },
  opencode: { label: 'OpenCode CLI', commands: ['opencode'], windows: ['opencode.exe', 'opencode.cmd'] },
}

export function executeVersion(file: string, args: string[]): string | null {
  try {
    // Only fixed npm shim names use cmd.exe. Paths and configuration values
    // never become shell commands; native executables use execFile directly.
    if (process.platform === 'win32' && /^[\w-]+\.cmd$/.test(file)) {
      return execFileSync('cmd.exe', ['/d', '/s', '/c', `${file} --version`], { stdio: 'pipe', timeout: 10000 })
        .toString()
        .trim()
    }
    return execFileSync(file, args, { stdio: 'pipe', timeout: 10000 }).toString().trim()
  } catch {
    return null
  }
}

export function versionDetail(raw: string): string {
  // Do not echo arbitrary executable output (or terminal escape sequences).
  const match = raw.match(/\b(?:v)?(\d+\.\d+(?:\.\d+)?(?:-[\w.-]+)?)\b/)
  return match ? `v${match[1]}` : 'Available (--version succeeded)'
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

function resolveSessionTask(
  root: string,
  controller: string,
  sessionKey: string,
  exec: NonNullable<DoctorDependencies['exec']>
): string {
  const output = exec(process.execPath, [controller, 'resolve', '--root', root, '--session-key', sessionKey])
  if (output) {
    try {
      const resolution = JSON.parse(output) as RecordValue
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

async function taskSummary(root: string, state: RecordValue): Promise<string> {
  const schema = Number.isSafeInteger(state.schemaVersion) ? `v${String(state.schemaVersion)}` : 'invalid'
  const openTasks = await countOpenTasks(root)
  const bindings = await countBindings(root)
  return `schema=${schema}, open=${openTasks ?? '?'}, bindings=${bindings ?? '?'}`
}

export async function readTaskStatus(root: string, installDir: string, exec = executeVersion): Promise<string> {
  const statePath = join(root, '.ccg', 'state.json')
  if (!(await fs.pathExists(statePath))) return 'schema=none, open=0, bindings=0'
  let state: RecordValue
  try {
    state = (await fs.readJson(statePath)) as RecordValue
  } catch {
    return 'invalid-state'
  }

  const sessionKey = process.env.CCG_SESSION_KEY
  if (sessionKey !== undefined && !/^(?:claude|codex)-[0-9a-f]{64}$/.test(sessionKey)) {
    return 'session-key-invalid'
  }
  if (sessionKey) {
    const controller = join(installDir, 'hooks', 'ccg', 'task-state.js')
    if (await fs.pathExists(controller)) return resolveSessionTask(root, controller, sessionKey, exec)
  }
  return taskSummary(root, state)
}

export async function taskCheck(
  root: string,
  installDir: string,
  exec: NonNullable<DoctorDependencies['exec']>
): Promise<DoctorCheck> {
  const task = await readTaskStatus(root, installDir, exec)
  return check(
    'task.state',
    'Task state',
    /invalid|unavailable/.test(task) ? 'warn' : 'pass',
    task,
    'Inspect the current session task with the installed task-state controller.'
  )
}

export async function readWrapperVersion(
  installDir: string,
  platform: NodeJS.Platform,
  exec: NonNullable<DoctorDependencies['exec']>
): Promise<string | null> {
  const wrapper = join(installDir, 'bin', platform === 'win32' ? 'codeagent-wrapper.exe' : 'codeagent-wrapper')
  return (await fs.pathExists(wrapper)) ? exec(wrapper, ['--version']) : null
}

async function backendVersion(
  name: string,
  home: string,
  platform: NodeJS.Platform,
  exec: NonNullable<DoctorDependencies['exec']>
): Promise<string | null> {
  const spec = BACKENDS[name]
  const candidates = platform === 'win32' ? spec.windows : spec.commands
  let output: string | null = null
  for (const command of candidates) {
    output = exec(command, ['--version'])
    if (output) break
  }
  if (!output && name === 'grok') {
    const fallback = join(home, '.grok', 'bin', platform === 'win32' ? 'grok.exe' : 'grok')
    if (await fs.pathExists(fallback)) output = exec(fallback, ['--version'])
  }
  return output
}

export async function backendChecks(
  names: string[],
  pureClaude: boolean,
  home: string,
  platform: NodeJS.Platform,
  exec: NonNullable<DoctorDependencies['exec']>
): Promise<DoctorCheck[]> {
  if (pureClaude)
    return [
      check('routing.pure-claude', 'Pure Claude Code', 'pass', 'Agent Teams mode; no external model CLI required'),
    ]
  const checks: DoctorCheck[] = []
  for (const name of names) {
    const spec = BACKENDS[name]
    const output = await backendVersion(name, home, platform, exec)
    checks.push(
      check(
        `cli.${name}`,
        spec.label,
        output ? 'pass' : 'fail',
        output ? versionDetail(output) : 'Not found or --version failed',
        `Install ${spec.label} and ensure ${spec.commands[0]} is on PATH, then run ccg doctor.`
      )
    )
  }
  return checks
}

export async function standaloneDelegationChecks(
  installDir: string,
  codexDir: string,
  home: string,
  platform: NodeJS.Platform,
  exec: NonNullable<DoctorDependencies['exec']>
): Promise<DoctorCheck[]> {
  const raw = await readWrapperVersion(installDir, platform, exec)
  const agents = (await readText(join(codexDir, 'AGENTS.md'))) || ''
  const names = [...new Set([...agents.matchAll(/--backend ([a-z][a-z0-9-]*)\b/g)].map((match) => match[1]))].filter(
    (name) => Object.hasOwn(BACKENDS, name)
  )
  const promptFiles = names.flatMap((name) =>
    ['analyzer', 'reviewer'].map((role) => join(installDir, '.ccg', 'prompts', name, `${role}.md`))
  )
  const hasPrompts =
    promptFiles.length > 0 && (await Promise.all(promptFiles.map((path) => fs.pathExists(path)))).every(Boolean)
  const drivers = await backendChecks(
    names.filter((name) => name !== 'codex'),
    false,
    home,
    platform,
    exec
  )
  return [
    check(
      'binary.wrapper',
      'External delegation',
      raw ? 'pass' : 'warn',
      raw ? versionDetail(raw) : 'Wrapper not installed; M+ external model delegation is unavailable',
      'Run ccg init to install the external model delegation toolchain.'
    ),
    check(
      'codex.role-prompts',
      'Delegation prompts',
      hasPrompts ? 'pass' : 'warn',
      hasPrompts
        ? 'External role prompts found'
        : 'Role prompts not installed; external model delegation is incomplete',
      'Run ccg init to install role prompts and configure external model CLIs.'
    ),
    ...drivers.map((driver) => ({
      ...driver,
      id: driver.id.replace('cli.', 'cli.delegation.'),
      status: driver.status === 'fail' ? ('warn' as const) : driver.status,
      detail: driver.status === 'fail' ? `${driver.detail}; external model delegation is unavailable` : driver.detail,
    })),
  ]
}
