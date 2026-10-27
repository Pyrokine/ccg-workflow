import fs from 'fs-extra'
import inquirer from 'inquirer'
import { join } from 'pathe'
import { initI18n } from '../i18n'
import type { CcgConfig, CollaborationMode, InitOptions, ModelRouting, ModelType, SupportedLang } from '../types'
import { normalizeModelNames, normalizeRoutingForInstall, readCcgConfig } from '../utils/config'
import { getAllCommandIds, getCoreCommandIds } from '../utils/installer'
import { PACKAGE_ROOT } from '../utils/installer-template'
import { getSkillCatalog, installedNames, resolveSkillPaths, SKILL_MANIFEST_FILE } from '../utils/skill-manager'

export interface InitState {
  options: InitOptions
  installDir: string
  language: SupportedLang
  existingConfig?: CcgConfig | null
  frontendModels: ModelType[]
  backendModels: ModelType[]
  routingProxy?: ModelRouting['proxy']
  reviewRouting?: ModelRouting['review']
  grokModel: string
  kimiModel: string
  opencodeModel: string
  mode: CollaborationMode
  selectedWorkflows: string[]
  liteMode: boolean
  skipImpeccable: boolean
  selectedSkillsMode?: 'legacy' | 'native'
  skillsProfile?: string[]
  skillCatalog: ReturnType<typeof getSkillCatalog>
  skillPaths: ReturnType<typeof resolveSkillPaths>
  requestedSkills?: string[]
  mcpProvider: string
  aceToolBaseUrl: string
  aceToolToken: string
  contextWeaverApiKey: string
  fastContextApiKey: string
  fastContextIncludeSnippets: boolean
  wantFastContext: boolean
  wantGrokSearch: boolean
  tavilyKey: string
  firecrawlKey: string
  grokApiUrl: string
  grokApiKey: string
  apiUrl: string
  apiKey: string
  sponsorId: string
  sponsorWireCodex: boolean
  sponsorActivateCodex: boolean
}

export function emptyMcpCredentials() {
  return {
    aceToolBaseUrl: '',
    aceToolToken: '',
    contextWeaverApiKey: '',
    fastContextApiKey: '',
    fastContextIncludeSnippets: false,
    wantFastContext: false,
    wantGrokSearch: false,
    tavilyKey: '',
    firecrawlKey: '',
    grokApiUrl: '',
    grokApiKey: '',
  }
}

export function createInitState(options: InitOptions, installDir: string, language: SupportedLang): InitState {
  const skillPaths = resolveSkillPaths({
    target: 'claude',
    templatesDir: join(PACKAGE_ROOT, 'templates', 'skills'),
    nativeDir: join(installDir, 'skills'),
    storeDir: join(installDir, '.ccg-skills'),
  })
  return {
    options,
    installDir,
    language,
    frontendModels: normalizeModelNames(options.frontend, ['claude']),
    backendModels: normalizeModelNames(options.backend, ['claude']),
    grokModel: '',
    kimiModel: '',
    opencodeModel: '',
    mode: 'smart',
    selectedWorkflows: getCoreCommandIds(),
    liteMode: true,
    skipImpeccable: false,
    skillPaths,
    skillCatalog: getSkillCatalog(skillPaths),
    requestedSkills: options.skills
      ?.split(',')
      .map((name) => name.trim())
      .filter(Boolean),
    mcpProvider: 'fast-context',
    ...emptyMcpCredentials(),
    apiUrl: '',
    apiKey: '',
    sponsorId: '',
    sponsorWireCodex: false,
    sponsorActivateCodex: false,
  }
}

export async function initializeLanguage(options: InitOptions): Promise<SupportedLang> {
  let language: SupportedLang = 'zh-CN'
  if (!options.skipPrompt) {
    const existingConfig = await readCcgConfig()
    const savedLang = existingConfig?.general?.language
    if (savedLang) {
      language = savedLang
    } else {
      const { selectedLang } = await inquirer.prompt([
        {
          type: 'select',
          name: 'selectedLang',
          message: '选择语言 / Select language',
          choices: [
            { name: `简体中文`, value: 'zh-CN' },
            { name: `English`, value: 'en' },
          ],
          default: 'zh-CN',
        },
      ])
      language = selectedLang
    }
    await initI18n(language)
  } else if (options.lang) {
    language = options.lang
    await initI18n(language)
  }
  return language
}

function restoreRouting(state: InitState, config: CcgConfig | null): void {
  if (!config?.routing) return
  const routing = normalizeRoutingForInstall(config.routing)
  state.frontendModels = state.options.frontend
    ? normalizeModelNames(state.options.frontend, routing.frontend.models)
    : routing.frontend.models
  state.backendModels = state.options.backend
    ? normalizeModelNames(state.options.backend, routing.backend.models)
    : routing.backend.models
  state.routingProxy = routing.proxy
  state.reviewRouting = routing.review
  state.mode = routing.mode
  state.grokModel = routing.grokModel || ''
  state.kimiModel = routing.kimiModel || ''
  state.opencodeModel = routing.opencodeModel || ''
}

function validateRequestedSkills(state: InitState): void {
  const requested = state.requestedSkills
  if (requested === undefined) return
  const unknown = requested.some(
    (name) => !['all', 'none'].includes(name) && !state.skillCatalog.some((skill) => skill.name === name)
  )
  const mixed = requested.length > 1 && requested.some((name) => ['all', 'none'].includes(name))
  if (!requested.length || unknown || mixed) {
    throw new Error(`Invalid Skills selection: ${state.options.skills}. Use all, none, or catalog names.`)
  }
}

async function restoreSkills(state: InitState): Promise<void> {
  validateRequestedSkills(state)
  const saved = await readCcgConfig()
  restoreSavedSkillsMode(state, saved)
  if (
    state.requestedSkills === undefined &&
    state.selectedSkillsMode !== 'legacy' &&
    (await fs.pathExists(join(state.skillPaths.storeDir, SKILL_MANIFEST_FILE)))
  ) {
    state.skillsProfile = await installedNames(state.skillPaths)
    state.selectedSkillsMode = 'native'
  }
  if (state.requestedSkills !== undefined) {
    state.skillsProfile = requestedSkillProfile(state)
    state.selectedSkillsMode = 'native'
  }
}

function requestedSkillProfile(state: InitState): string[] {
  const requested = state.requestedSkills!
  if (requested[0] === 'all') return state.skillCatalog.map((skill) => skill.name)
  if (requested[0] === 'none') return []
  return [...new Set(requested)]
}

export async function restoreInitState(state: InitState): Promise<void> {
  if (state.options.skipPrompt) {
    await restoreWorkflowSelection(state)
  }
  await restoreSkills(state)
  const config = await readCcgConfig()
  restorePerformance(state, config)
}

export function buildRouting(state: InitState): ModelRouting {
  return {
    frontend: {
      models: state.frontendModels,
      primary: state.frontendModels[0],
      strategy: 'fallback',
    },
    backend: {
      models: state.backendModels,
      primary: state.backendModels[0],
      strategy: 'fallback',
    },
    review: state.reviewRouting || {
      profiles: [
        { id: 'gpt', model: 'gpt-5.6-sol', effort: 'xhigh' },
        { id: 'grok', model: 'grok-4.6', effort: 'high' },
      ],
      strategy: 'parallel',
    },
    ...(state.routingProxy ? { proxy: state.routingProxy } : {}),
    ...(state.grokModel ? { grokModel: state.grokModel } : {}),
    ...(state.kimiModel ? { kimiModel: state.kimiModel } : {}),
    ...(state.opencodeModel ? { opencodeModel: state.opencodeModel } : {}),
    mode: state.mode,
  }
}

function restoreSavedSkillsMode(state: InitState, saved: CcgConfig | null): void {
  state.selectedSkillsMode = saved?.performance?.skillsMode
  state.skillsProfile = state.selectedSkillsMode === 'legacy' ? undefined : saved?.performance?.skillsProfile
  if (state.selectedSkillsMode === undefined && state.skillsProfile !== undefined) state.selectedSkillsMode = 'native'
}

async function restoreWorkflowSelection(state: InitState): Promise<void> {
  const config = await readCcgConfig()
  restoreRouting(state, config)
  const hadLegacy = config?.workflows?.installed?.some((w) =>
    ['workflow', 'plan', 'execute', 'frontend', 'backend', 'feat', 'debug', 'team'].includes(w)
  )
  if (hadLegacy) state.selectedWorkflows = getAllCommandIds()
}

function restorePerformance(state: InitState, config: CcgConfig | null): void {
  const { liteMode, skipImpeccable } = config?.performance ?? {}
  if (liteMode !== undefined) state.liteMode = liteMode
  if (state.options.skipPrompt) {
    if (skipImpeccable !== undefined) state.skipImpeccable = skipImpeccable
    if (state.options.skipMcp) state.mcpProvider = config?.mcp?.provider || 'skip'
  } else {
    state.existingConfig = config
    restoreRouting(state, config)
  }
}
