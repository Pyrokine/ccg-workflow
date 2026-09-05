import { homedir } from 'node:os'
import fs from 'fs-extra'
import { join } from 'pathe'
import { parse as parseToml } from 'smol-toml'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { APIMART_CODEX_PROVIDER, configureApiMartForCodex, removeApiMartFromCodex } from '../installer-codex-api'

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: vi.fn() }
})

const EXISTING_CONFIG = `approval_policy = 'never'
model = 'gpt-5.6-sol'
service_tier = 'priority'

[features]
multi_agent_v2 = true

[mcp_servers.existing_thing]
command = "/usr/bin/true"
`

type CodexConfig = Record<string, unknown> & {
  approval_policy?: string
  model?: string
  service_tier?: string
  model_provider?: string
  model_providers?: Record<string, Record<string, unknown>>
  features?: Record<string, unknown>
  mcp_servers?: Record<string, Record<string, unknown>>
}

let tmpHome: string
let configPath: string

async function readConfig(): Promise<CodexConfig> {
  return parseToml(await fs.readFile(configPath, 'utf-8')) as CodexConfig
}

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(join(await fs.realpath('/tmp'), 'ccg-codex-api-'))
  configPath = join(tmpHome, '.codex', 'config.toml')
  await fs.ensureDir(join(tmpHome, '.codex'))
  vi.mocked(homedir).mockReturnValue(tmpHome)
})

afterEach(async () => {
  await fs.remove(tmpHome)
  vi.restoreAllMocks()
})

describe('configureApiMartForCodex', () => {
  it('registers the provider without activating it by default', async () => {
    await fs.writeFile(configPath, EXISTING_CONFIG, 'utf-8')

    const result = await configureApiMartForCodex()

    expect(result.success).toBe(true)
    expect(result.activated).toBe(false)

    const config = await readConfig()
    expect(config.model_providers?.apimart).toEqual({ ...APIMART_CODEX_PROVIDER })
    // The critical guarantee: never silently reroute paid usage.
    expect(config.model_provider).toBeUndefined()
  })

  it('keeps the /v1 suffix — Codex speaks OpenAI, unlike ANTHROPIC_BASE_URL', async () => {
    await configureApiMartForCodex()
    const config = await readConfig()
    expect(config.model_providers?.apimart?.base_url).toBe('https://api.apimart.ai/v1')
    expect(config.model_providers?.apimart?.wire_api).toBe('responses')
  })

  it('preserves every pre-existing user setting', async () => {
    await fs.writeFile(configPath, EXISTING_CONFIG, 'utf-8')

    await configureApiMartForCodex(true)

    const config = await readConfig()
    expect(config.approval_policy).toBe('never')
    expect(config.model).toBe('gpt-5.6-sol')
    expect(config.service_tier).toBe('priority')
    expect(config.features?.multi_agent_v2).toBe(true)
    expect(config.mcp_servers?.existing_thing?.command).toBe('/usr/bin/true')
  })

  it('activates only when explicitly asked', async () => {
    const result = await configureApiMartForCodex(true)

    expect(result.activated).toBe(true)
    expect((await readConfig()).model_provider).toBe('apimart')
  })

  it('leaves an existing APIMart provider byte-for-byte unchanged', async () => {
    const existing = `${EXISTING_CONFIG}
[model_providers.apimart]
name = "User APIMart"
base_url = "https://gateway.example.test/v1"
wire_api = "chat"
env_key = "USER_API_KEY"
`
    await fs.writeFile(configPath, existing, 'utf-8')

    await configureApiMartForCodex()

    expect(await fs.readFile(configPath, 'utf-8')).toBe(existing)
  })

  it('preserves a restrictive config mode during registration and removal', async () => {
    await fs.writeFile(configPath, EXISTING_CONFIG, 'utf-8')
    await fs.chmod(configPath, 0o600)

    await configureApiMartForCodex()
    expect((await fs.stat(configPath)).mode & 0o777).toBe(0o600)

    await removeApiMartFromCodex()
    expect((await fs.stat(configPath)).mode & 0o777).toBe(0o600)
  })

  it('creates the config when none exists yet', async () => {
    expect(await fs.pathExists(configPath)).toBe(false)

    const result = await configureApiMartForCodex()

    expect(result.success).toBe(true)
    expect(await fs.pathExists(configPath)).toBe(true)
  })

  it('keeps the original config when the atomic rename fails', async () => {
    await fs.writeFile(configPath, EXISTING_CONFIG, 'utf-8')
    const before = await fs.readFile(configPath, 'utf-8')
    const rename = fs.rename.bind(fs)
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (to === configPath && String(from).startsWith(`${configPath}.`)) {
        throw new Error('simulated APIMart rename failure')
      }
      await rename(from, to)
    })

    const result = await configureApiMartForCodex()

    expect(result.success).toBe(false)
    expect(result.message).toContain('simulated APIMart rename failure')
    expect(await fs.readFile(configPath, 'utf-8')).toBe(before)
    expect((await fs.readdir(join(tmpHome, '.codex'))).filter((file) => file.endsWith('.tmp'))).toEqual([])
  })
})

describe('removeApiMartFromCodex', () => {
  it('round-trips back to the original config, leaving no residue', async () => {
    await fs.writeFile(configPath, EXISTING_CONFIG, 'utf-8')
    const before = await readConfig()

    await configureApiMartForCodex(true)
    await removeApiMartFromCodex()

    expect(await readConfig()).toEqual(before)
  })

  it('drops a dangling model_provider so Codex does not break on next run', async () => {
    await configureApiMartForCodex(true)
    await removeApiMartFromCodex()

    const config = await readConfig()
    expect(config.model_provider).toBeUndefined()
    expect(config.model_providers).toBeUndefined()
  })

  it('leaves other providers and their activation alone', async () => {
    await fs.writeFile(
      configPath,
      `model_provider = "custom"

[model_providers.custom]
name = "Custom"
base_url = "https://example.test/v1"
`,
      'utf-8'
    )

    await configureApiMartForCodex()
    await removeApiMartFromCodex()

    const config = await readConfig()
    expect(config.model_provider).toBe('custom')
    expect(config.model_providers?.custom?.name).toBe('Custom')
    expect(config.model_providers?.apimart).toBeUndefined()
  })

  it('does not delete an APIMart provider that existed before CCG ran', async () => {
    const existing = `[model_providers.apimart]
name = "User APIMart"
base_url = "https://gateway.example.test/v1"
wire_api = "chat"
env_key = "USER_API_KEY"
`
    await fs.writeFile(configPath, existing, 'utf-8')

    await configureApiMartForCodex()
    const result = await removeApiMartFromCodex()

    expect(result.configPath).toBeUndefined()
    expect(await fs.readFile(configPath, 'utf-8')).toBe(existing)
  })

  it('is a no-op when there is no config at all', async () => {
    const result = await removeApiMartFromCodex()
    expect(result.success).toBe(true)
    expect(await fs.pathExists(configPath)).toBe(false)
  })
})
