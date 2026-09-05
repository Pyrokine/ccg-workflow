import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import fs from 'fs-extra'
import { join } from 'pathe'
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'

/**
 * APIMart provider registration for Codex CLI (~/.codex/config.toml).
 *
 * Codex speaks the OpenAI wire protocol, so its base_url KEEPS the /v1 suffix —
 * the opposite of Claude Code, where ANTHROPIC_BASE_URL must omit it because
 * Claude Code appends /v1/messages itself. Getting these two backwards yields a
 * silent 404, so they are deliberately defined in separate places.
 *
 * Source: https://docs.apimart.ai/en/integrations/dev-tool/codex-cli.md
 */
export const APIMART_CODEX_PROVIDER_ID = 'apimart'

export const APIMART_CODEX_PROVIDER = {
  name: 'APIMart',
  base_url: 'https://api.apimart.ai/v1',
  wire_api: 'responses',
  env_key: 'APIMART_API_KEY',
} as const

export type CodexApiResult = {
  success: boolean
  message: string
  /** true when `model_provider` was actually switched to APIMart */
  activated: boolean
  configPath?: string
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function isCcgApiMartProvider(value: unknown): boolean {
  const provider = asRecord(value)
  return (
    provider !== null &&
    Object.keys(provider).length === Object.keys(APIMART_CODEX_PROVIDER).length &&
    Object.entries(APIMART_CODEX_PROVIDER).every(([key, expected]) => provider[key] === expected)
  )
}

async function writeTomlAtomic(path: string, config: Record<string, unknown>): Promise<void> {
  const current = await fs.lstat(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  })
  if (current && (!current.isFile() || current.isSymbolicLink())) {
    throw new Error(`Refusing to replace non-regular Codex config: ${path}`)
  }

  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(tempPath, stringifyToml(config), 'utf-8')
    if (current) await fs.chmod(tempPath, current.mode & 0o777)
    await fs.rename(tempPath, path)
  } catch (error) {
    await fs.remove(tempPath).catch(() => undefined)
    throw error
  }
}

/**
 * Register APIMart as a selectable model provider in ~/.codex/config.toml.
 *
 * Additive by design. The [model_providers.apimart] table is written so Codex
 * knows how to reach APIMart, but `model_provider` is left untouched unless the
 * caller explicitly passes `activate: true`.
 *
 * That default is deliberate: flipping `model_provider` globally diverts EVERY
 * Codex request away from the user's ChatGPT subscription onto pay-as-you-go
 * billing. Silently rerouting someone's paid usage is not a side effect an
 * installer gets to have, so activation stays an explicit, informed choice.
 *
 * An existing APIMart table belongs to the user. CCG leaves it unchanged rather
 * than replacing settings such as a custom endpoint or credential environment.
 */
export async function configureApiMartForCodex(activate = false): Promise<CodexApiResult> {
  try {
    const codexHome = join(homedir(), '.codex')
    const configPath = join(codexHome, 'config.toml')
    await fs.ensureDir(codexHome)

    let config: Record<string, unknown> = {}
    if (await fs.pathExists(configPath)) {
      const content = await fs.readFile(configPath, 'utf-8')
      config = asRecord(parseToml(content)) ?? {}
    }

    const modelProviders = asRecord(config.model_providers) ?? {}
    const existingProvider = asRecord(modelProviders[APIMART_CODEX_PROVIDER_ID])
    let changed = false
    if (!existingProvider) {
      modelProviders[APIMART_CODEX_PROVIDER_ID] = { ...APIMART_CODEX_PROVIDER }
      config.model_providers = modelProviders
      changed = true
    }

    const activated = activate && config.model_provider !== APIMART_CODEX_PROVIDER_ID
    if (activated) {
      config.model_provider = APIMART_CODEX_PROVIDER_ID
      changed = true
    }

    if (changed) await writeTomlAtomic(configPath, config)

    return {
      success: true,
      activated,
      configPath,
      message: activated
        ? existingProvider
          ? 'Existing APIMart provider left unchanged and set as the active Codex model provider'
          : 'APIMart registered and set as the active Codex model provider'
        : existingProvider
          ? 'Existing APIMart provider left unchanged (not activated)'
          : 'APIMart registered as a Codex model provider (not activated)',
    }
  } catch (error) {
    return { success: false, activated: false, message: `Failed to configure APIMart for Codex: ${error}` }
  }
}

/**
 * Remove the exact APIMart table CCG creates from ~/.codex/config.toml.
 *
 * A pre-existing or subsequently customized table is user-owned and remains in
 * place. Its `model_provider` selection remains in place as well.
 */
export async function removeApiMartFromCodex(): Promise<CodexApiResult> {
  try {
    const configPath = join(homedir(), '.codex', 'config.toml')
    if (!(await fs.pathExists(configPath))) {
      return { success: true, activated: false, message: 'No Codex config to clean' }
    }

    const config = asRecord(parseToml(await fs.readFile(configPath, 'utf-8'))) ?? {}
    let changed = false

    const modelProviders = asRecord(config.model_providers)
    const isCcgProvider = modelProviders !== null && isCcgApiMartProvider(modelProviders[APIMART_CODEX_PROVIDER_ID])
    if (modelProviders && isCcgProvider) {
      delete modelProviders[APIMART_CODEX_PROVIDER_ID]
      // Drop the parent table once it is empty — an orphaned [model_providers]
      // is valid TOML but pure litter in a file the user reads and edits.
      if (Object.keys(modelProviders).length === 0) delete config.model_providers
      changed = true
    }
    if (isCcgProvider && config.model_provider === APIMART_CODEX_PROVIDER_ID) {
      delete config.model_provider
      changed = true
    }

    if (!changed) {
      return {
        success: true,
        activated: false,
        message: 'APIMart provider is user-managed or not present in Codex config',
      }
    }

    await writeTomlAtomic(configPath, config)

    return {
      success: true,
      activated: false,
      configPath,
      message: 'CCG-managed APIMart provider removed from Codex config',
    }
  } catch (error) {
    return { success: false, activated: false, message: `Failed to remove APIMart from Codex: ${error}` }
  }
}
