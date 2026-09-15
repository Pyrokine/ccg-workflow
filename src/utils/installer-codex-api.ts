import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import fs from 'fs-extra'
import { join } from 'pathe'
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'
import { SPONSORS, getSponsor, type CodexProviderSpec, type SponsorGateway } from './sponsors'

export type { CodexProviderSpec }

export const APIMART_CODEX_PROVIDER_ID = 'apimart'
export const APIMART_CODEX_PROVIDER = getSponsor(APIMART_CODEX_PROVIDER_ID)!.codex
export const PACKYCODE_CODEX_PROVIDER_ID = 'packycode'
export const PACKYCODE_CODEX_PROVIDER = getSponsor(PACKYCODE_CODEX_PROVIDER_ID)!.codex

export type CodexProviderStatus = 'added' | 'preserved' | 'removed' | 'absent' | 'failed'

export type CodexApiResult = {
  success: boolean
  message: string
  /** true when model_provider was actually switched to this provider */
  activated: boolean
  /** true when this provider is active after the operation */
  active?: boolean
  status?: CodexProviderStatus
  configPath?: string
}

export type CodexSponsorResult = {
  id: string
  success: boolean
  status: CodexProviderStatus
  message: string
}

export type CodexSponsorsResult = {
  success: boolean
  results: CodexSponsorResult[]
  message: string
  configPath?: string
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key)
}

function isCcgProvider(value: unknown, expected: CodexProviderSpec): boolean {
  const provider = asRecord(value)
  return (
    provider !== null &&
    Object.keys(provider).length === Object.keys(expected).length &&
    Object.entries(expected).every(([key, expectedValue]) => provider[key] === expectedValue)
  )
}

async function readCodexConfig(configPath: string): Promise<{
  config: Record<string, unknown>
  exists: boolean
}> {
  const current = await fs.lstat(configPath).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  })
  if (!current) {
    return { config: {}, exists: false }
  }
  if (!current.isFile() || current.isSymbolicLink()) {
    throw new Error(`Refusing to read non-regular Codex config: ${configPath}`)
  }

  const config = asRecord(parseToml(await fs.readFile(configPath, 'utf-8')))
  if (!config) {
    throw new Error(`Codex config root must be a TOML table: ${configPath}`)
  }
  return { config, exists: true }
}

function getModelProviders(config: Record<string, unknown>, create: boolean): Record<string, unknown> | null {
  if (config.model_providers === undefined) {
    if (!create) return null
    const providers: Record<string, unknown> = {}
    config.model_providers = providers
    return providers
  }

  const providers = asRecord(config.model_providers)
  if (!providers) {
    throw new Error('Codex model_providers must be a TOML table')
  }
  return providers
}

async function writeTomlAtomic(path: string, config: Record<string, unknown>): Promise<void> {
  const current = await fs.lstat(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  })
  if (current && (!current.isFile() || current.isSymbolicLink())) {
    throw new Error(`Refusing to replace non-regular Codex config: ${path}`)
  }

  const mode = current ? current.mode & 0o777 : 0o600
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(tempPath, stringifyToml(config), { encoding: 'utf-8', mode, flag: 'wx' })
    await fs.chmod(tempPath, mode)
    await fs.rename(tempPath, path)
  } catch (error) {
    await fs.remove(tempPath).catch(() => undefined)
    throw error
  }
}

function failedResults(sponsors: readonly SponsorGateway[], error: unknown): CodexSponsorResult[] {
  return sponsors.map((sponsor) => ({
    id: sponsor.id,
    success: false,
    status: 'failed',
    message: `Failed to update ${sponsor.name} Codex provider: ${error}`,
  }))
}

async function configureSponsors(
  sponsors: readonly SponsorGateway[],
  activateId?: string
): Promise<{ batch: CodexSponsorsResult; activated: boolean; activeProvider?: string }> {
  const codexHome = join(homedir(), '.codex')
  const configPath = join(codexHome, 'config.toml')

  try {
    await fs.ensureDir(codexHome)
    const { config } = await readCodexConfig(configPath)
    const providers = getModelProviders(config, true)!
    const results: CodexSponsorResult[] = []
    let changed = false

    for (const sponsor of sponsors) {
      if (hasOwn(providers, sponsor.id)) {
        results.push({
          id: sponsor.id,
          success: true,
          status: 'preserved',
          message: `Existing ${sponsor.name} provider left unchanged`,
        })
        continue
      }

      providers[sponsor.id] = { ...sponsor.codex }
      changed = true
      results.push({
        id: sponsor.id,
        success: true,
        status: 'added',
        message: `${sponsor.name} registered as a Codex model provider`,
      })
    }

    const activated = Boolean(activateId && config.model_provider !== activateId)
    if (activated) {
      config.model_provider = activateId
      changed = true
    }

    if (changed) await writeTomlAtomic(configPath, config)

    return {
      activated,
      activeProvider: typeof config.model_provider === 'string' ? config.model_provider : undefined,
      batch: {
        success: true,
        results,
        configPath,
        message: results.map((result) => result.message).join('; '),
      },
    }
  } catch (error) {
    const results = failedResults(sponsors, error)
    return {
      activated: false,
      batch: {
        success: false,
        results,
        message: results.map((result) => result.message).join('; '),
      },
    }
  }
}

async function removeSponsors(sponsors: readonly SponsorGateway[]): Promise<CodexSponsorsResult> {
  const configPath = join(homedir(), '.codex', 'config.toml')

  try {
    const { config, exists } = await readCodexConfig(configPath)
    if (!exists) {
      const results = sponsors.map((sponsor) => ({
        id: sponsor.id,
        success: true,
        status: 'absent' as const,
        message: `${sponsor.name} not present in Codex config`,
      }))
      return { success: true, results, message: 'No Codex config to clean' }
    }

    const providers = getModelProviders(config, false)
    const results: CodexSponsorResult[] = []
    let changed = false

    for (const sponsor of sponsors) {
      if (!providers || !hasOwn(providers, sponsor.id)) {
        results.push({
          id: sponsor.id,
          success: true,
          status: 'absent',
          message: `${sponsor.name} not present in Codex config`,
        })
        continue
      }
      if (!isCcgProvider(providers[sponsor.id], sponsor.codex)) {
        results.push({
          id: sponsor.id,
          success: true,
          status: 'preserved',
          message: `${sponsor.name} provider is user-managed and was left unchanged`,
        })
        continue
      }

      delete providers[sponsor.id]
      if (config.model_provider === sponsor.id) delete config.model_provider
      changed = true
      results.push({
        id: sponsor.id,
        success: true,
        status: 'removed',
        message: `CCG-managed ${sponsor.name} provider removed from Codex config`,
      })
    }

    if (providers && Object.keys(providers).length === 0) delete config.model_providers
    if (changed) await writeTomlAtomic(configPath, config)

    return {
      success: true,
      results,
      ...(changed ? { configPath } : {}),
      message: results.map((result) => result.message).join('; '),
    }
  } catch (error) {
    const results = failedResults(sponsors, error)
    return {
      success: false,
      results,
      message: results.map((result) => result.message).join('; '),
    }
  }
}

export async function configureSponsorForCodex(id: string, activate = false): Promise<CodexApiResult> {
  const sponsor = getSponsor(id)
  if (!sponsor) {
    return {
      success: false,
      activated: false,
      status: 'failed',
      message: `Unknown sponsor: ${id}`,
    }
  }

  const { batch, activated, activeProvider } = await configureSponsors([sponsor], activate ? sponsor.id : undefined)
  const result = batch.results[0]
  return {
    success: batch.success,
    activated,
    active: activeProvider === sponsor.id,
    status: result.status,
    configPath: batch.configPath,
    message: !batch.success
      ? result.message
      : activate
        ? `${result.message} and is the active Codex model provider`
        : `${result.message} (not activated)`,
  }
}

export async function removeSponsorFromCodex(id: string): Promise<CodexApiResult> {
  const sponsor = getSponsor(id)
  if (!sponsor) {
    return {
      success: false,
      activated: false,
      status: 'failed',
      message: `Unknown sponsor: ${id}`,
    }
  }

  const batch = await removeSponsors([sponsor])
  const result = batch.results[0]
  return {
    success: batch.success,
    activated: false,
    status: result.status,
    configPath: batch.configPath,
    message: result.message,
  }
}

export async function configureAllSponsorsForCodex(): Promise<CodexSponsorsResult> {
  return (await configureSponsors(SPONSORS)).batch
}

export async function removeSponsorsFromCodex(ids: readonly string[]): Promise<CodexSponsorsResult> {
  const sponsors: SponsorGateway[] = []
  for (const id of ids) {
    const sponsor = getSponsor(id)
    if (!sponsor) {
      return {
        success: false,
        results: [],
        message: `Unknown sponsor: ${id}`,
      }
    }
    sponsors.push(sponsor)
  }
  if (sponsors.length === 0) return { success: true, results: [], message: 'No managed Codex sponsors to remove' }
  return removeSponsors(sponsors)
}

export async function removeAllSponsorsFromCodex(): Promise<CodexSponsorsResult> {
  return removeSponsors(SPONSORS)
}

export function configureApiMartForCodex(activate = false): Promise<CodexApiResult> {
  return configureSponsorForCodex(APIMART_CODEX_PROVIDER_ID, activate)
}

export function removeApiMartFromCodex(): Promise<CodexApiResult> {
  return removeSponsorFromCodex(APIMART_CODEX_PROVIDER_ID)
}

export function configurePackyCodeForCodex(activate = false): Promise<CodexApiResult> {
  return configureSponsorForCodex(PACKYCODE_CODEX_PROVIDER_ID, activate)
}

export function removePackyCodeFromCodex(): Promise<CodexApiResult> {
  return removeSponsorFromCodex(PACKYCODE_CODEX_PROVIDER_ID)
}
