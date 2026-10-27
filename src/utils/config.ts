import fs from 'fs-extra'
import { homedir } from 'node:os'
import { join } from 'pathe'
import { parse, stringify } from 'smol-toml'
import { version as packageVersion } from '../../package.json'
import type { CcgConfig, ModelRouting, ModelType, ReviewProfile, ReviewProfileId, SupportedLang } from '../types'

// v1.4.0: 配置目录统一到 ~/.claude/.ccg/
const CCG_DIR = join(homedir(), '.claude', '.ccg')
const CONFIG_FILE = join(CCG_DIR, 'config.toml')

export function getCcgDir(): string {
  return CCG_DIR
}

export function getConfigPath(): string {
  return CONFIG_FILE
}

export async function ensureCcgDir(): Promise<void> {
  await fs.ensureDir(CCG_DIR)
}

export async function readCcgConfig(): Promise<CcgConfig | null> {
  try {
    if (await fs.pathExists(CONFIG_FILE)) {
      const content = await fs.readFile(CONFIG_FILE, 'utf-8')
      return parse(content) as unknown as CcgConfig
    }
  } catch {
    // Config doesn't exist or is invalid
  }
  return null
}

export async function writeCcgConfig(config: CcgConfig): Promise<void> {
  await ensureCcgDir()
  const content = stringify(config as unknown as Record<string, unknown>)
  await fs.writeFile(CONFIG_FILE, content, 'utf-8')
}

export function createDefaultConfig(options: {
  language: SupportedLang
  routing: ModelRouting
  installedWorkflows: string[]
  mcpProvider?: string
  liteMode?: boolean
  skipImpeccable?: boolean
  skillsProfile?: string[]
  skillsMode?: 'legacy' | 'native'
}): CcgConfig {
  return {
    general: {
      version: packageVersion,
      language: options.language,
      createdAt: new Date().toISOString(),
    },
    routing: options.routing,
    workflows: {
      installed: options.installedWorkflows,
    },
    paths: {
      commands: join(homedir(), '.claude', 'commands', 'ccg'),
      prompts: join(CCG_DIR, 'prompts'), // v1.4.0: 移到配置目录
      backup: join(CCG_DIR, 'backup'),
    },
    mcp: {
      provider: options.mcpProvider || 'fast-context',
      setup_url: 'https://augmentcode.com/',
    },
    performance: {
      liteMode: options.liteMode ?? true,
      skipImpeccable: options.skipImpeccable || false,
      ...(options.skillsProfile !== undefined ? { skillsProfile: [...options.skillsProfile] } : {}),
      ...(options.skillsMode !== undefined ? { skillsMode: options.skillsMode } : {}),
    },
  }
}

export function createDefaultRouting(): ModelRouting {
  return {
    frontend: {
      models: ['claude'],
      primary: 'claude',
      strategy: 'fallback',
    },
    backend: {
      models: ['claude'],
      primary: 'claude',
      strategy: 'fallback',
    },
    review: {
      profiles: [
        { id: 'gpt', model: 'gpt-5.6-sol', effort: 'xhigh' },
        { id: 'grok', model: 'grok-4.6', effort: 'high' },
      ],
      strategy: 'parallel',
    },
    mode: 'smart',
  }
}

type ModelRouteInput = {
  models?: unknown
  primary?: unknown
  strategy?: unknown
}

type ReviewRouteInput = {
  profiles?: unknown
  models?: unknown
  strategy?: unknown
}

type RoutingProxyInput = {
  models?: unknown
  http?: unknown
  https?: unknown
}

type RoutingInput = {
  frontend?: ModelRouteInput
  backend?: ModelRouteInput
  review?: ReviewRouteInput
  proxy?: RoutingProxyInput
  grokModel?: unknown
  kimiModel?: unknown
  opencodeModel?: unknown
  mode?: unknown
}

const activeModels = new Set<ModelType>(['codex', 'claude', 'antigravity', 'grok', 'kimi', 'opencode'])
const reviewProfileIds = new Set<ReviewProfileId>(['gpt', 'grok'])
const reviewEfforts = new Set(['low', 'medium', 'high', 'xhigh', 'max'])
const defaultReviewProfiles: ReviewProfile[] = [
  { id: 'gpt', model: 'gpt-5.6-sol', effort: 'xhigh' },
  { id: 'grok', model: 'grok-4.6', effort: 'high' },
]

function cloneReviewProfiles(profiles: ReviewProfile[]): ReviewProfile[] {
  return profiles.map((profile) => ({ ...profile }))
}
const routingStrategies = new Set(['parallel', 'fallback', 'round-robin'])
const reviewStrategies = new Set(['parallel', 'fallback', 'single'])
const collaborationModes = new Set(['parallel', 'smart', 'sequential'])

export function normalizeModelName(value: unknown): ModelType | null {
  if (typeof value !== 'string') {
    return null
  }

  const model = value.trim().toLowerCase()
  if (model === 'gemini') {
    return 'grok'
  }
  if (model === 'agy') {
    return 'antigravity'
  }
  if (activeModels.has(model as ModelType)) {
    return model as ModelType
  }
  return null
}

export function normalizeModelNames(value: unknown, fallback: ModelType[]): ModelType[] {
  const source = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : null
  if (!source) {
    return fallback
  }

  const models = source.map((model) => normalizeModelName(model)).filter((model): model is ModelType => model !== null)
  const deduped = [...new Set(models)]
  return deduped.length > 0 ? deduped : fallback
}

function normalizeProxyModelName(value: unknown): Extract<ModelType, 'antigravity'> | null {
  if (typeof value !== 'string') {
    return null
  }

  const model = value.trim().toLowerCase()
  if (model === 'agy' || model === 'antigravity') {
    return 'antigravity'
  }
  return null
}

function normalizeProxyModels(value: unknown): Extract<ModelType, 'antigravity'>[] {
  const source = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : null
  if (!source) {
    return []
  }

  const models = source
    .map((model) => normalizeProxyModelName(model))
    .filter((model): model is Extract<ModelType, 'antigravity'> => model !== null)
  return [...new Set(models)]
}

function normalizeRoutingProxy(proxy: RoutingProxyInput | undefined): ModelRouting['proxy'] | undefined {
  const models = normalizeProxyModels(proxy?.models)
  if (models.length === 0 || typeof proxy?.http !== 'string') {
    return undefined
  }

  const http = proxy.http.trim()
  const https = typeof proxy.https === 'string' && proxy.https.trim() ? proxy.https.trim() : http
  if (!http) {
    return undefined
  }

  return { models, http, https }
}

function normalizeGrokModel(model: string): string {
  return model === 'grok-4.5' ? 'grok-4.6' : model
}

function normalizeReviewProfile(value: unknown): ReviewProfile | null {
  if (typeof value !== 'object' || value === null) return null
  const profile = value as { id?: unknown; model?: unknown; effort?: unknown }
  if (typeof profile.id !== 'string' || !reviewProfileIds.has(profile.id as ReviewProfileId)) return null

  const normalized: ReviewProfile = { id: profile.id as ReviewProfileId }
  if (typeof profile.model === 'string' && profile.model.trim()) {
    const model = profile.model.trim()
    normalized.model = normalized.id === 'grok' ? normalizeGrokModel(model) : model
  }
  if (typeof profile.effort === 'string' && reviewEfforts.has(profile.effort)) {
    normalized.effort = profile.effort as ReviewProfile['effort']
  }
  return normalized
}

function normalizeReviewProfiles(value: unknown, fallback: ReviewProfile[]): ReviewProfile[] {
  if (!Array.isArray(value)) return cloneReviewProfiles(fallback)

  const configured = new Map<ReviewProfileId, ReviewProfile>()
  for (const rawProfile of value) {
    const profile = normalizeReviewProfile(rawProfile)
    if (profile && !configured.has(profile.id)) configured.set(profile.id, profile)
  }
  return fallback.map((defaultProfile) => ({ ...defaultProfile, ...configured.get(defaultProfile.id) }))
}

function normalizeLegacyReviewModels(value: unknown): ReviewProfile[] {
  return normalizeModelNames(value, []).length > 0 ? cloneReviewProfiles(defaultReviewProfiles) : []
}

function normalizeModelRoute(
  route: ModelRouteInput | undefined,
  fallback: { models: ModelType[]; primary: ModelType; strategy: ModelRouting['frontend']['strategy'] }
): { models: ModelType[]; primary: ModelType; strategy: ModelRouting['frontend']['strategy'] } {
  let models = normalizeModelNames(route?.models, fallback.models)
  const primary = normalizeModelName(route?.primary)
  if (primary) {
    models = [primary, ...models.filter((model) => model !== primary)]
  }

  const strategy =
    typeof route?.strategy === 'string' && routingStrategies.has(route.strategy) ? route.strategy : fallback.strategy
  return {
    models,
    primary: models[0],
    strategy: strategy as ModelRouting['frontend']['strategy'],
  }
}

function normalizeReviewRoute(
  source: ReviewRouteInput | undefined,
  fallback: ModelRouting['review']
): ModelRouting['review'] {
  const legacyProfiles = normalizeLegacyReviewModels(source?.models)
  return {
    profiles: normalizeReviewProfiles(
      source?.profiles,
      legacyProfiles.length > 0 ? legacyProfiles : defaultReviewProfiles
    ),
    strategy:
      typeof source?.strategy === 'string' && reviewStrategies.has(source.strategy)
        ? (source.strategy as ModelRouting['review']['strategy'])
        : fallback.strategy,
  }
}

function normalizeCollaborationMode(value: unknown, fallback: ModelRouting['mode']): ModelRouting['mode'] {
  return typeof value === 'string' && collaborationModes.has(value) ? (value as ModelRouting['mode']) : fallback
}

function normalizeModelOverrides(source: RoutingInput | undefined) {
  const overrides: Pick<ModelRouting, 'grokModel' | 'kimiModel' | 'opencodeModel'> = {}
  for (const [key, value] of Object.entries({
    grokModel: source?.grokModel,
    kimiModel: source?.kimiModel,
    opencodeModel: source?.opencodeModel,
  }) as Array<[keyof typeof overrides, unknown]>) {
    if (typeof value === 'string' && value.trim()) {
      const model = value.trim()
      overrides[key] = key === 'grokModel' ? normalizeGrokModel(model) : model
    }
  }
  return overrides
}

export function normalizeRoutingForInstall(routing?: unknown): ModelRouting {
  const defaults = createDefaultRouting()
  const source = routing as RoutingInput | undefined
  const normalized: ModelRouting = {
    frontend: normalizeModelRoute(source?.frontend, defaults.frontend),
    backend: normalizeModelRoute(source?.backend, defaults.backend),
    review: normalizeReviewRoute(source?.review, defaults.review),
    mode: normalizeCollaborationMode(source?.mode, defaults.mode),
    ...normalizeModelOverrides(source),
  }
  const proxy = normalizeRoutingProxy(source?.proxy)
  if (proxy) normalized.proxy = proxy
  return normalized
}
