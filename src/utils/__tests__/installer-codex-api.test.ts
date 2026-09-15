import { homedir } from 'node:os'
import fs from 'fs-extra'
import { join } from 'pathe'
import { parse as parseToml } from 'smol-toml'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  APIMART_CODEX_PROVIDER,
  PACKYCODE_CODEX_PROVIDER,
  configureAllSponsorsForCodex,
  configureApiMartForCodex,
  configurePackyCodeForCodex,
  configureSponsorForCodex,
  removeAllSponsorsFromCodex,
  removeApiMartFromCodex,
  removePackyCodeFromCodex,
  removeSponsorFromCodex,
} from '../installer-codex-api'
import { SPONSORS } from '../sponsors'

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
let codexHome: string
let configPath: string
let authPath: string

async function readConfig(): Promise<CodexConfig> {
  return parseToml(await fs.readFile(configPath, 'utf-8')) as CodexConfig
}

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(join(await fs.realpath('/tmp'), 'ccg-codex-api-'))
  codexHome = join(tmpHome, '.codex')
  configPath = join(codexHome, 'config.toml')
  authPath = join(codexHome, 'auth.json')
  await fs.ensureDir(codexHome)
  vi.mocked(homedir).mockReturnValue(tmpHome)
})

afterEach(async () => {
  await fs.remove(tmpHome)
  vi.restoreAllMocks()
})

describe('sponsor registry', () => {
  it('defines unique HTTPS gateways with separate Claude and Codex base URLs', () => {
    expect(SPONSORS.map((sponsor) => sponsor.id)).toEqual(['apimart', 'packycode'])
    expect(new Set(SPONSORS.map((sponsor) => sponsor.id)).size).toBe(SPONSORS.length)

    for (const sponsor of SPONSORS) {
      expect(new URL(sponsor.signupUrl).protocol).toBe('https:')
      expect(new URL(sponsor.anthropicBaseUrl).protocol).toBe('https:')
      expect(sponsor.anthropicBaseUrl).not.toMatch(/\/v1\/?$/)
      expect(sponsor.codex.base_url).toMatch(/\/v1$/)
      expect(sponsor.codex.wire_api).toBe('responses')
      expect(sponsor.codex.env_key).toMatch(/^[A-Z][A-Z0-9_]*_API_KEY$/)
    }
  })

  it('keeps the published APIMart and PackyCode provider specifications', () => {
    expect(APIMART_CODEX_PROVIDER).toEqual({
      name: 'APIMart',
      base_url: 'https://api.apimart.ai/v1',
      wire_api: 'responses',
      env_key: 'APIMART_API_KEY',
    })
    expect(PACKYCODE_CODEX_PROVIDER).toEqual({
      name: 'PackyCode',
      base_url: 'https://cf.api.fan/v1',
      wire_api: 'responses',
      env_key: 'PACKYCODE_API_KEY',
    })
  })
})

describe('configure sponsor providers for Codex', () => {
  it('registers every sponsor without changing the active provider', async () => {
    await fs.writeFile(configPath, EXISTING_CONFIG, 'utf-8')

    const result = await configureAllSponsorsForCodex()

    expect(result.success).toBe(true)
    expect(result.results.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: 'apimart', status: 'added' },
      { id: 'packycode', status: 'added' },
    ])
    const config = await readConfig()
    expect(config.model_providers?.apimart).toEqual({ ...APIMART_CODEX_PROVIDER })
    expect(config.model_providers?.packycode).toEqual({ ...PACKYCODE_CODEX_PROVIDER })
    expect(config.model_provider).toBeUndefined()
  })

  it('keeps the APIMart compatibility wrapper scoped to APIMart', async () => {
    const result = await configureApiMartForCodex()
    const config = await readConfig()

    expect(result.success).toBe(true)
    expect(result.activated).toBe(false)
    expect(result.active).toBe(false)
    expect(config.model_providers?.apimart).toEqual({ ...APIMART_CODEX_PROVIDER })
    expect(config.model_providers?.packycode).toBeUndefined()
  })

  it('parses and writes the config once for a batch registration', async () => {
    await fs.writeFile(configPath, EXISTING_CONFIG, 'utf-8')
    const rename = fs.rename.bind(fs)
    const renameSpy = vi.spyOn(fs, 'rename').mockImplementation((from, to) => rename(from, to))

    const result = await configureAllSponsorsForCodex()

    expect(result.success).toBe(true)
    expect(renameSpy).toHaveBeenCalledTimes(1)
  })

  it('activates only the explicitly selected sponsor', async () => {
    await configureAllSponsorsForCodex()

    const result = await configurePackyCodeForCodex(true)

    expect(result.success).toBe(true)
    expect(result.activated).toBe(true)
    expect((await readConfig()).model_provider).toBe('packycode')
  })

  it('reports an already selected sponsor as active without claiming another switch', async () => {
    await configurePackyCodeForCodex(true)

    const result = await configurePackyCodeForCodex(true)

    expect(result.success).toBe(true)
    expect(result.activated).toBe(false)
    expect(result.active).toBe(true)
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

  it('leaves an existing provider unchanged', async () => {
    const existing = `${EXISTING_CONFIG}
[model_providers.apimart]
name = "User APIMart"
base_url = "https://gateway.example.test/v1"
wire_api = "chat"
env_key = "USER_API_KEY"
`
    await fs.writeFile(configPath, existing, 'utf-8')

    const result = await configureApiMartForCodex()

    expect(result.success).toBe(true)
    expect(result.status).toBe('preserved')
    expect(await fs.readFile(configPath, 'utf-8')).toBe(existing)
  })

  it('preserves a user-managed sibling while registering the other sponsor', async () => {
    await fs.writeFile(
      configPath,
      `model_provider = "apimart"

[model_providers.apimart]
name = "User APIMart"
base_url = "https://gateway.example.test/v1"
wire_api = "chat"
env_key = "USER_API_KEY"
`,
      'utf-8'
    )

    const result = await configureAllSponsorsForCodex()
    const config = await readConfig()

    expect(result.success).toBe(true)
    expect(result.results[0].status).toBe('preserved')
    expect(config.model_provider).toBe('apimart')
    expect(config.model_providers?.apimart?.name).toBe('User APIMart')
    expect(config.model_providers?.packycode).toEqual({ ...PACKYCODE_CODEX_PROVIDER })
  })

  it('does not create or modify Codex auth.json', async () => {
    const auth = '{"tokens":{"access_token":"kept-verbatim"}}\n'
    await fs.writeFile(authPath, auth, 'utf-8')

    await configureAllSponsorsForCodex()

    expect(await fs.readFile(authPath, 'utf-8')).toBe(auth)
  })

  it('preserves a restrictive config mode during registration', async () => {
    await fs.writeFile(configPath, EXISTING_CONFIG, 'utf-8')
    await fs.chmod(configPath, 0o600)

    await configureAllSponsorsForCodex()

    expect((await fs.stat(configPath)).mode & 0o777).toBe(0o600)
  })

  it('creates the config when none exists yet', async () => {
    const result = await configureAllSponsorsForCodex()

    expect(result.success).toBe(true)
    expect(await fs.pathExists(configPath)).toBe(true)
    expect((await fs.stat(configPath)).mode & 0o777).toBe(0o600)
  })

  it('rejects a symlink config without touching its target', async () => {
    const targetPath = join(tmpHome, 'target.toml')
    await fs.writeFile(targetPath, EXISTING_CONFIG, 'utf-8')
    await fs.symlink(targetPath, configPath)

    const result = await configureApiMartForCodex()

    expect(result.success).toBe(false)
    expect(result.message).toContain('non-regular Codex config')
    expect(await fs.readFile(targetPath, 'utf-8')).toBe(EXISTING_CONFIG)
  })

  it('rejects a non-regular config path', async () => {
    await fs.ensureDir(configPath)

    const result = await configureApiMartForCodex()

    expect(result.success).toBe(false)
    expect(result.message).toContain('non-regular Codex config')
  })

  it('keeps the original config when the atomic rename fails', async () => {
    await fs.writeFile(configPath, EXISTING_CONFIG, 'utf-8')
    const before = await fs.readFile(configPath, 'utf-8')
    const rename = fs.rename.bind(fs)
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (to === configPath && String(from).startsWith(`${configPath}.`)) {
        throw new Error('simulated sponsor rename failure')
      }
      await rename(from, to)
    })

    const result = await configureAllSponsorsForCodex()

    expect(result.success).toBe(false)
    expect(result.results.every((item) => item.status === 'failed')).toBe(true)
    expect(result.message).toContain('simulated sponsor rename failure')
    expect(await fs.readFile(configPath, 'utf-8')).toBe(before)
    expect((await fs.readdir(codexHome)).filter((file) => file.endsWith('.tmp'))).toEqual([])
  })

  it('rejects an unknown sponsor without writing a config', async () => {
    const result = await configureSponsorForCodex('unknown')

    expect(result.success).toBe(false)
    expect(result.status).toBe('failed')
    expect(await fs.pathExists(configPath)).toBe(false)
  })

  it('reports malformed TOML as a batch failure', async () => {
    await fs.writeFile(configPath, '[broken', 'utf-8')

    const result = await configureAllSponsorsForCodex()

    expect(result.success).toBe(false)
    expect(result.results.every((item) => item.success === false && item.status === 'failed')).toBe(true)
    expect(await fs.readFile(configPath, 'utf-8')).toBe('[broken')
  })
})

describe('remove sponsor providers from Codex', () => {
  it('round-trips all sponsors back to the original config', async () => {
    await fs.writeFile(configPath, EXISTING_CONFIG, 'utf-8')
    const before = await readConfig()

    await configureAllSponsorsForCodex()
    const result = await removeAllSponsorsFromCodex()

    expect(result.success).toBe(true)
    expect(result.results.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: 'apimart', status: 'removed' },
      { id: 'packycode', status: 'removed' },
    ])
    expect(await readConfig()).toEqual(before)
  })

  it('removes one sponsor without changing the other', async () => {
    await configureAllSponsorsForCodex()

    await removePackyCodeFromCodex()
    let config = await readConfig()
    expect(config.model_providers?.packycode).toBeUndefined()
    expect(config.model_providers?.apimart).toEqual({ ...APIMART_CODEX_PROVIDER })

    await removeApiMartFromCodex()
    config = await readConfig()
    expect(config.model_providers).toBeUndefined()
  })

  it('drops model_provider only when removing the exact active CCG table', async () => {
    await configurePackyCodeForCodex(true)

    const result = await removePackyCodeFromCodex()
    const config = await readConfig()

    expect(result.status).toBe('removed')
    expect(config.model_provider).toBeUndefined()
    expect(config.model_providers).toBeUndefined()
  })

  it('preserves a user-managed sponsor table and active selection', async () => {
    const existing = `model_provider = "packycode"

[model_providers.packycode]
name = "User PackyCode"
base_url = "https://gateway.example.test/v1"
wire_api = "chat"
env_key = "USER_API_KEY"
`
    await fs.writeFile(configPath, existing, 'utf-8')

    const result = await removePackyCodeFromCodex()

    expect(result.success).toBe(true)
    expect(result.status).toBe('preserved')
    expect(result.configPath).toBeUndefined()
    expect(await fs.readFile(configPath, 'utf-8')).toBe(existing)
  })

  it('preserves other providers and their activation', async () => {
    await fs.writeFile(
      configPath,
      `model_provider = "custom"

[model_providers.custom]
name = "Custom"
base_url = "https://example.test/v1"
`,
      'utf-8'
    )
    await configureAllSponsorsForCodex()

    await removeAllSponsorsFromCodex()
    const config = await readConfig()

    expect(config.model_provider).toBe('custom')
    expect(config.model_providers?.custom?.name).toBe('Custom')
    expect(config.model_providers?.apimart).toBeUndefined()
    expect(config.model_providers?.packycode).toBeUndefined()
  })

  it('preserves config permissions during removal', async () => {
    await configureAllSponsorsForCodex()
    await fs.chmod(configPath, 0o600)

    await removeAllSponsorsFromCodex()

    expect((await fs.stat(configPath)).mode & 0o777).toBe(0o600)
  })

  it('does not modify auth.json during removal', async () => {
    const auth = '{"tokens":{"access_token":"kept-verbatim"}}\n'
    await fs.writeFile(authPath, auth, 'utf-8')
    await configureAllSponsorsForCodex()

    await removeAllSponsorsFromCodex()

    expect(await fs.readFile(authPath, 'utf-8')).toBe(auth)
  })

  it('is a no-op when there is no config', async () => {
    const result = await removeAllSponsorsFromCodex()

    expect(result.success).toBe(true)
    expect(result.results.every((item) => item.status === 'absent')).toBe(true)
    expect(await fs.pathExists(configPath)).toBe(false)
  })

  it('rejects an unknown sponsor without writing a config', async () => {
    const result = await removeSponsorFromCodex('unknown')

    expect(result.success).toBe(false)
    expect(result.status).toBe('failed')
    expect(await fs.pathExists(configPath)).toBe(false)
  })

  it('reports malformed TOML as a batch failure instead of false success', async () => {
    await fs.writeFile(configPath, '[broken', 'utf-8')

    const result = await removeAllSponsorsFromCodex()

    expect(result.success).toBe(false)
    expect(result.results.every((item) => item.success === false && item.status === 'failed')).toBe(true)
    expect(await fs.readFile(configPath, 'utf-8')).toBe('[broken')
  })
})
