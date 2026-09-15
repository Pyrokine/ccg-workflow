import { homedir } from 'node:os'
import fs from 'fs-extra'
import { join } from 'pathe'
import { parse as parseToml } from 'smol-toml'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installCodexMode, uninstallCodexMode } from '../installer'

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: vi.fn() }
})

type JsonRecord = Record<string, unknown>

type CodexConfig = JsonRecord & {
  model?: string
  model_provider?: string
  notify?: string[]
  model_providers?: Record<string, JsonRecord>
}

let tmpHome: string
let codexHome: string
let agentsPath: string
let configPath: string
let hooksPath: string
let authPath: string

const userAgents = '# User Codex instructions\n\nKeep this text verbatim.\n'
const userConfig = `model = "gpt-user-model"
model_provider = "existing"
notify = ["/home/user/notify-report.sh"]

[model_providers.existing]
name = "Existing provider"
base_url = "https://example.test/v1"
wire_api = "responses"
env_key = "EXISTING_API_KEY"
`
const userHooks = {
  version: 1,
  hooks: {
    UserPromptSubmit: [
      {
        matcher: 'user',
        hooks: [{ type: 'command', command: 'python3 /home/user/prompt-hook.py', timeout: 7 }],
      },
    ],
    SessionStart: [
      {
        hooks: [{ type: 'command', command: 'python3 /home/user/session-hook.py' }],
      },
    ],
  },
}
const userAuth = '{"tokens":{"access_token":"kept-verbatim"}}\n'

function countManagedMarkers(content: string): { starts: number; ends: number } {
  return {
    starts: content.split('<!-- CCG:START').length - 1,
    ends: content.split('<!-- CCG:END -->').length - 1,
  }
}

function countCcgHooks(value: unknown): number {
  if (Array.isArray(value)) return value.reduce((total, item) => total + countCcgHooks(item), 0)
  if (!value || typeof value !== 'object') return 0
  const record = value as JsonRecord
  const command = typeof record.command === 'string' ? record.command.replace(/\\/g, '/') : ''
  return (command.includes('/.codex/hooks/ccg-workflow.py') ? 1 : 0) + countCcgHooks(Object.values(record))
}

async function readConfig(): Promise<CodexConfig> {
  return parseToml(await fs.readFile(configPath, 'utf-8')) as CodexConfig
}

async function writeUserFiles(): Promise<void> {
  await fs.ensureDir(codexHome)
  await fs.writeFile(agentsPath, userAgents, 'utf-8')
  await fs.writeFile(configPath, userConfig, 'utf-8')
  await fs.chmod(configPath, 0o600)
  await fs.writeJson(hooksPath, userHooks, { spaces: 2 })
  await fs.chmod(hooksPath, 0o640)
  await fs.writeFile(authPath, userAuth, 'utf-8')
}

beforeEach(async () => {
  tmpHome = await fs.mkdtemp('/tmp/ccg-codex-mode-')
  codexHome = join(tmpHome, '.codex')
  agentsPath = join(codexHome, 'AGENTS.md')
  configPath = join(codexHome, 'config.toml')
  hooksPath = join(codexHome, 'hooks.json')
  authPath = join(codexHome, 'auth.json')
  vi.mocked(homedir).mockReturnValue(tmpHome)
})

afterEach(async () => {
  await fs.remove(tmpHome)
  vi.restoreAllMocks()
})

describe('Codex mode installation', () => {
  it('merges user instructions and Hooks while preserving config, auth, and file modes', async () => {
    await writeUserFiles()

    const result = await installCodexMode()

    expect(result.success).toBe(true)
    const agents = await fs.readFile(agentsPath, 'utf-8')
    expect(agents.startsWith(userAgents)).toBe(true)
    expect(countManagedMarkers(agents)).toEqual({ starts: 1, ends: 1 })
    expect(agents.indexOf('## Pure Claude Code mode')).toBeGreaterThan(agents.indexOf('<!-- CCG:START'))

    const hooks = (await fs.readJson(hooksPath)) as JsonRecord
    expect(hooks.version).toBe(1)
    expect(JSON.stringify(hooks)).toContain('/home/user/prompt-hook.py')
    expect(JSON.stringify(hooks)).toContain('/home/user/session-hook.py')
    expect(countCcgHooks(hooks)).toBe(1)

    const config = await readConfig()
    expect(config.model).toBe('gpt-user-model')
    expect(config.model_provider).toBe('existing')
    expect(config.notify).toEqual(['/home/user/notify-report.sh'])
    expect(config.model_providers?.existing?.base_url).toBe('https://example.test/v1')
    expect(config.model_providers?.apimart).toBeDefined()
    expect(config.model_providers?.packycode).toBeDefined()
    expect((await fs.stat(configPath)).mode & 0o777).toBe(0o600)
    expect((await fs.stat(hooksPath)).mode & 0o777).toBe(0o640)
    expect(await fs.readFile(authPath, 'utf-8')).toBe(userAuth)

    for (const relativePath of [
      'agents/ccg-implement.toml',
      'agents/ccg-review.toml',
      'agents/ccg-research.toml',
      'hooks/ccg-workflow.py',
      'hooks/ccg/package.json',
      'hooks/ccg/task-utils.js',
      'hooks/ccg/task-state.js',
    ]) {
      expect(await fs.pathExists(join(codexHome, relativePath)), relativePath).toBe(true)
    }
    const implementAgent = await fs.readFile(join(codexHome, 'agents', 'ccg-implement.toml'), 'utf-8')
    expect(implementAgent).toContain('[features]\nmulti_agent = false\nmulti_agent_v2 = false')
    expect(implementAgent).not.toContain('[features.multi_agent_v2]')

    const backups = await fs.readdir(join(codexHome, '.ccg', 'backups'))
    expect(backups).toHaveLength(1)
    expect(await fs.pathExists(join(codexHome, '.ccg', 'backups', backups[0], 'manifest.json'))).toBe(true)
  })

  it('updates one managed block and normalizes duplicate CCG Hooks without removing user Hooks', async () => {
    await writeUserFiles()
    await fs.writeFile(
      agentsPath,
      `${userAgents}\n<!-- CCG:START — Managed by CCG Workflow. Do not edit this block manually. -->\nOLD CCG BLOCK\n<!-- CCG:END -->\n\n# User suffix\n`,
      'utf-8'
    )
    const ccgCommand = `python3 ${join(codexHome, 'hooks', 'ccg-workflow.py')}`
    await fs.writeJson(hooksPath, {
      hooks: {
        UserPromptSubmit: [
          {
            matcher: 'mixed',
            hooks: [
              { type: 'command', command: '/home/user/prompt-hook.py' },
              { type: 'command', command: `${ccgCommand}.backup` },
              { type: 'command', command: ccgCommand },
            ],
          },
          { hooks: [{ type: 'command', command: ccgCommand }] },
        ],
        SessionStart: [{ hooks: [{ type: 'command', command: ccgCommand }] }],
      },
    })

    const result = await installCodexMode()

    expect(result.success).toBe(true)
    const agents = await fs.readFile(agentsPath, 'utf-8')
    expect(agents).toContain(userAgents)
    expect(agents).toContain('# User suffix')
    expect(agents).not.toContain('OLD CCG BLOCK')
    expect(countManagedMarkers(agents)).toEqual({ starts: 1, ends: 1 })
    const hooks = await fs.readJson(hooksPath)
    expect(countCcgHooks(hooks)).toBe(2)
    expect(JSON.stringify(hooks)).toContain('/home/user/prompt-hook.py')
    expect(JSON.stringify(hooks)).toContain(`${ccgCommand}.backup`)
  })

  it('rejects damaged or duplicate AGENTS markers before changing any file', async () => {
    await writeUserFiles()
    const damaged = `${userAgents}\n<!-- CCG:START -->\nfirst\n<!-- CCG:START -->\nsecond\n<!-- CCG:END -->\n`
    await fs.writeFile(agentsPath, damaged, 'utf-8')
    const hooksBefore = await fs.readFile(hooksPath, 'utf-8')

    const result = await installCodexMode()

    expect(result.success).toBe(false)
    expect(result.message).toContain('damaged or duplicate')
    expect(await fs.readFile(agentsPath, 'utf-8')).toBe(damaged)
    expect(await fs.readFile(configPath, 'utf-8')).toBe(userConfig)
    expect(await fs.readFile(hooksPath, 'utf-8')).toBe(hooksBefore)
    expect(await fs.pathExists(join(codexHome, 'agents', 'ccg-implement.toml'))).toBe(false)
    expect(await fs.pathExists(join(codexHome, '.ccg'))).toBe(false)
  })

  it('rejects a prefix-compatible but noncanonical AGENTS marker before changing any file', async () => {
    await writeUserFiles()
    const damaged = `${userAgents}\n<!-- CCG:START-old -->\nuser-owned text\n<!-- CCG:END -->\n`
    await fs.writeFile(agentsPath, damaged, 'utf-8')

    const result = await installCodexMode()

    expect(result.success).toBe(false)
    expect(result.message).toContain('damaged or duplicate')
    expect(await fs.readFile(agentsPath, 'utf-8')).toBe(damaged)
    expect(await fs.pathExists(join(codexHome, '.ccg'))).toBe(false)
  })

  it('rejects invalid hooks.json before changing any file', async () => {
    await writeUserFiles()
    await fs.writeFile(hooksPath, '{invalid', 'utf-8')

    const result = await installCodexMode()

    expect(result.success).toBe(false)
    expect(result.message).toContain('hooks.json is invalid JSON')
    expect(await fs.readFile(agentsPath, 'utf-8')).toBe(userAgents)
    expect(await fs.readFile(configPath, 'utf-8')).toBe(userConfig)
    expect(await fs.readFile(hooksPath, 'utf-8')).toBe('{invalid')
    expect(await fs.pathExists(join(codexHome, '.ccg'))).toBe(false)
  })

  it('rejects a symlinked Codex target without changing its destination', async () => {
    await fs.ensureDir(codexHome)
    const target = join(tmpHome, 'outside-agents.md')
    await fs.writeFile(target, 'outside content\n', 'utf-8')
    await fs.symlink(target, agentsPath)

    const result = await installCodexMode()

    expect(result.success).toBe(false)
    expect(result.message).toContain('non-regular Codex file')
    expect(await fs.readFile(target, 'utf-8')).toBe('outside content\n')
    expect(await fs.pathExists(join(codexHome, '.ccg'))).toBe(false)
  })

  it('refuses explicit Codex feature conflicts instead of overriding them', async () => {
    await fs.ensureDir(codexHome)
    const config = '[features]\nhooks = false\nmulti_agent = true\n'
    await fs.writeFile(configPath, config, 'utf-8')

    const result = await installCodexMode()

    expect(result.success).toBe(false)
    expect(result.message).toContain('explicitly disables the hooks feature')
    expect(await fs.readFile(configPath, 'utf-8')).toBe(config)
    expect(await fs.pathExists(agentsPath)).toBe(false)
  })

  it('rolls back every target when a later config write fails', async () => {
    await writeUserFiles()
    const before = {
      agents: await fs.readFile(agentsPath, 'utf-8'),
      config: await fs.readFile(configPath, 'utf-8'),
      hooks: await fs.readFile(hooksPath, 'utf-8'),
    }
    const rename = fs.rename.bind(fs)
    let failed = false
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (!failed && to === configPath && String(from).startsWith(`${configPath}.`)) {
        failed = true
        throw new Error('simulated config rename failure')
      }
      await rename(from, to)
    })

    const result = await installCodexMode()

    expect(result.success).toBe(false)
    expect(result.message).toContain('Original files restored')
    expect(await fs.readFile(agentsPath, 'utf-8')).toBe(before.agents)
    expect(await fs.readFile(configPath, 'utf-8')).toBe(before.config)
    expect(await fs.readFile(hooksPath, 'utf-8')).toBe(before.hooks)
    expect(await fs.readFile(authPath, 'utf-8')).toBe(userAuth)
    expect(await fs.pathExists(join(codexHome, 'agents', 'ccg-implement.toml'))).toBe(false)
    expect((await fs.readdir(codexHome)).filter((file) => file.endsWith('.tmp'))).toEqual([])
  })

  it('creates new config and Hook files with restrictive permissions', async () => {
    const result = await installCodexMode()

    expect(result.success).toBe(true)
    expect((await fs.stat(configPath)).mode & 0o777).toBe(0o600)
    expect((await fs.stat(hooksPath)).mode & 0o777).toBe(0o600)
    expect((await fs.stat(agentsPath)).mode & 0o777).toBe(0o644)
    expect((await fs.stat(join(codexHome, '.ccg', 'codex-mode.json'))).mode & 0o777).toBe(0o600)
  })

  it('keeps the first pre-install runtime backup across repeated installs', async () => {
    await writeUserFiles()
    const runtimePath = join(codexHome, 'agents', 'ccg-implement.toml')
    const original = 'model = "user-owned"\n'
    await fs.ensureDir(join(codexHome, 'agents'))
    await fs.writeFile(runtimePath, original, 'utf-8')
    await fs.chmod(runtimePath, 0o640)

    expect((await installCodexMode()).success).toBe(true)
    expect((await installCodexMode()).success).toBe(true)
    expect((await uninstallCodexMode()).success).toBe(true)

    expect(await fs.readFile(runtimePath, 'utf-8')).toBe(original)
    expect((await fs.stat(runtimePath)).mode & 0o777).toBe(0o640)
  })
})

describe('Codex mode uninstall', () => {
  it('removes only CCG content and retains user changes made after installation', async () => {
    await writeUserFiles()
    expect((await installCodexMode()).success).toBe(true)

    await fs.appendFile(agentsPath, '\n# User instruction added later\n', 'utf-8')
    await fs.appendFile(configPath, '\n[features]\nhooks = false\nmulti_agent = false\n', 'utf-8')
    const hooks = (await fs.readJson(hooksPath)) as JsonRecord
    const hookTable = hooks.hooks as Record<string, unknown[]>
    hookTable.SessionStart.push({ hooks: [{ type: 'command', command: '/home/user/later-hook.py' }] })
    await fs.writeJson(hooksPath, hooks, { spaces: 2 })

    const result = await uninstallCodexMode()

    expect(result.success).toBe(true)
    const agents = await fs.readFile(agentsPath, 'utf-8')
    expect(agents).toContain('Keep this text verbatim.')
    expect(agents).toContain('# User instruction added later')
    expect(agents).not.toContain('<!-- CCG:START')
    expect(agents).not.toContain('<!-- CCG:END -->')

    const remainingHooks = await fs.readJson(hooksPath)
    expect(countCcgHooks(remainingHooks)).toBe(0)
    expect(JSON.stringify(remainingHooks)).toContain('/home/user/prompt-hook.py')
    expect(JSON.stringify(remainingHooks)).toContain('/home/user/session-hook.py')
    expect(JSON.stringify(remainingHooks)).toContain('/home/user/later-hook.py')

    const config = await readConfig()
    expect(config.model).toBe('gpt-user-model')
    expect(config.model_provider).toBe('existing')
    expect(config.notify).toEqual(['/home/user/notify-report.sh'])
    expect(config.model_providers?.existing).toBeDefined()
    expect(config.model_providers?.apimart).toBeUndefined()
    expect(config.model_providers?.packycode).toBeUndefined()
    expect(await fs.readFile(authPath, 'utf-8')).toBe(userAuth)
    expect(await fs.pathExists(join(codexHome, 'hooks', 'ccg-workflow.py'))).toBe(false)
    expect(await fs.pathExists(join(codexHome, 'agents', 'ccg-implement.toml'))).toBe(false)
    expect(await fs.pathExists(join(codexHome, '.ccg', 'codex-mode.json'))).toBe(false)
  })

  it('preserves a pre-existing sponsor provider that already matches the CCG specification', async () => {
    await writeUserFiles()
    await fs.appendFile(
      configPath,
      '\n[model_providers.apimart]\nname = "APIMart"\nbase_url = "https://api.apimart.ai/v1"\nwire_api = "responses"\nenv_key = "APIMART_API_KEY"\n',
      'utf-8'
    )

    expect((await installCodexMode()).success).toBe(true)
    expect((await uninstallCodexMode()).success).toBe(true)

    const config = await readConfig()
    expect(config.model_providers?.apimart).toBeDefined()
    expect(config.model_providers?.packycode).toBeUndefined()
  })

  it('preserves a managed runtime file changed after installation', async () => {
    await writeUserFiles()
    expect((await installCodexMode()).success).toBe(true)
    const runtimePath = join(codexHome, 'agents', 'ccg-review.toml')
    await fs.appendFile(runtimePath, '\n# user change\n', 'utf-8')

    const result = await uninstallCodexMode()

    expect(result.success).toBe(true)
    expect(await fs.readFile(runtimePath, 'utf-8')).toContain('# user change')
    expect(result.skipped).toContain('~/.codex/agents/ccg-review.toml (modified after installation; preserved)')
  })

  it('rejects a tampered ownership backup path before uninstalling', async () => {
    await writeUserFiles()
    expect((await installCodexMode()).success).toBe(true)
    const manifestPath = join(codexHome, '.ccg', 'codex-mode.json')
    const manifest = await fs.readJson(manifestPath)
    manifest.files[0].original = { backupName: '..', mode: 0o600, sha256: '0'.repeat(64) }
    await fs.writeJson(manifestPath, manifest)

    const result = await uninstallCodexMode()

    expect(result.success).toBe(false)
    expect(result.skipped.join('\n')).toContain('invalid original-file entry')
    expect(await fs.pathExists(join(codexHome, 'hooks', 'ccg-workflow.py'))).toBe(true)
  })

  it('refuses to remove fixed runtime files when ownership metadata is missing', async () => {
    await fs.ensureDir(join(codexHome, 'agents'))
    const runtimePath = join(codexHome, 'agents', 'ccg-review.toml')
    await fs.writeFile(runtimePath, 'user-owned\n', 'utf-8')

    const result = await uninstallCodexMode()

    expect(result.success).toBe(false)
    expect(result.skipped.join('\n')).toContain('ownership manifest is missing')
    expect(await fs.readFile(runtimePath, 'utf-8')).toBe('user-owned\n')
  })
})
