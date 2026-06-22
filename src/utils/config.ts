import fs from 'fs-extra'
import { homedir } from 'node:os'
import { join } from 'pathe'
import { parse, stringify } from 'smol-toml'
import { version as packageVersion } from '../../package.json'
import type { CcgConfig, ModelRouting, ModelType, SupportedLang } from '../types'

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
    },
  }
}

export function createDefaultRouting(): ModelRouting {
  return {
    frontend: {
      models: ['antigravity', 'codex'],
      primary: 'antigravity',
      strategy: 'fallback',
    },
    backend: {
      models: ['codex'],
      primary: 'codex',
      strategy: 'fallback',
    },
    review: {
      models: ['codex', 'antigravity'],
      strategy: 'single',
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
  mode?: unknown
}

const activeModels = new Set<ModelType>(['codex', 'claude', 'antigravity'])
const routingStrategies = new Set(['parallel', 'fallback', 'round-robin'])
const reviewStrategies = new Set(['parallel', 'fallback', 'single'])
const collaborationModes = new Set(['parallel', 'smart', 'sequential'])

export function normalizeModelName(value: unknown): ModelType | null {
  if (typeof value !== 'string') {
    return null
  }

  const model = value.trim().toLowerCase()
  if (model === 'agy' || model === 'gemini') {
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

function normalizeProxyModelName(value: unknown): ModelType | null {
  if (typeof value !== 'string') {
    return null
  }

  const model = value.trim().toLowerCase()
  if (model === 'agy' || model === 'antigravity') {
    return 'antigravity'
  }
  return null
}

function normalizeProxyModels(value: unknown): ModelType[] {
  const source = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : null
  if (!source) {
    return []
  }

  const models = source
    .map((model) => normalizeProxyModelName(model))
    .filter((model): model is ModelType => model !== null)
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

export function normalizeRoutingForInstall(routing?: unknown): ModelRouting {
  const defaults = createDefaultRouting()
  const source = routing as RoutingInput | undefined
  const frontend = normalizeModelRoute(source?.frontend, defaults.frontend)
  const backend = normalizeModelRoute(source?.backend, defaults.backend)
  const reviewFallback = [...new Set([...backend.models, ...frontend.models])]
  const reviewModels = normalizeModelNames(source?.review?.models, reviewFallback)
  const reviewStrategy: ModelRouting['review']['strategy'] =
    typeof source?.review?.strategy === 'string' && reviewStrategies.has(source.review.strategy)
      ? (source.review.strategy as ModelRouting['review']['strategy'])
      : defaults.review.strategy
  const mode: ModelRouting['mode'] =
    typeof source?.mode === 'string' && collaborationModes.has(source.mode)
      ? (source.mode as ModelRouting['mode'])
      : defaults.mode
  const normalized: ModelRouting = {
    frontend,
    backend,
    review: {
      models: reviewModels,
      strategy: reviewStrategy,
    },
    mode,
  }
  const proxy = normalizeRoutingProxy(source?.proxy)
  if (proxy) {
    normalized.proxy = proxy
  }
  return normalized
}
