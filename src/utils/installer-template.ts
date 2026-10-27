import fs from 'fs-extra'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'pathe'
import type { ReviewProfile } from '../types'
import { isWindows } from './platform'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

/**
 * Find package root by looking for package.json up the directory tree.
 * Validates that the found root contains a templates/ directory.
 *
 * Increased depth from 5 → 10 to handle deeply nested npm cache paths
 * on Windows (e.g., AppData\Local\npm-cache\_npx\<hash>\node_modules\...).
 */
function findPackageRoot(startDir: string): string {
  let dir = startDir
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(join(dir, 'package.json'))) {
      // Validate: package root must contain templates/ directory
      if (fs.existsSync(join(dir, 'templates'))) {
        return dir
      }
      // Found package.json but no templates/ — might be a parent workspace
      // Continue searching upward
    }
    const parent = dirname(dir)
    if (parent === dir) break // Reached filesystem root
    dir = parent
  }

  // Fallback: warn loudly — this is the root cause of "silent install failure"
  console.error(
    `[CCG] ⚠ PACKAGE_ROOT resolution failed: could not find package.json with templates/ directory.\n` +
      `  Start dir: ${startDir}\n` +
      `  Last checked: ${dir}\n` +
      `  This will cause commands/skills/prompts to not be installed.\n` +
      `  Please report this issue at: https://github.com/Pyrokine/ccg-workflow/issues`
  )
  return startDir
}

export const PACKAGE_ROOT = findPackageRoot(__dirname)

// ═══════════════════════════════════════════════════════
// MCP provider registry — adding a new provider = 1 line
// ═══════════════════════════════════════════════════════

const MCP_PROVIDERS: Record<string, { tool: string; param: string }> = {
  'ace-tool': { tool: 'mcp__ace-tool__search_context', param: 'query' },
  'ace-tool-rs': { tool: 'mcp__ace-tool__search_context', param: 'query' },
  contextweaver: { tool: 'mcp__contextweaver__codebase-retrieval', param: 'information_request' },
  'fast-context': { tool: 'mcp__fast-context__fast_context_search', param: 'query' },
}

const DEFAULT_REVIEW_PROFILES: readonly ReviewProfile[] = [
  { id: 'gpt', model: 'gpt-5.6-sol', effort: 'xhigh' },
  { id: 'grok', model: 'grok-4.6', effort: 'high' },
]

const REVIEW_PROFILE_IDS = new Set<ReviewProfile['id']>(['gpt', 'grok'])
const REVIEW_EFFORTS = new Set<NonNullable<ReviewProfile['effort']>>(['low', 'medium', 'high', 'xhigh', 'max'])

function resolveReviewProfiles(configuredProfiles?: ReviewProfile[]): ReviewProfile[] {
  const configuredById = new Map<ReviewProfile['id'], ReviewProfile>()

  for (const profile of configuredProfiles || []) {
    if (!REVIEW_PROFILE_IDS.has(profile.id) || configuredById.has(profile.id)) {
      continue
    }

    const normalized: ReviewProfile = { id: profile.id }
    if (profile.model?.trim()) {
      normalized.model = profile.model.trim()
    }
    if (profile.effort && REVIEW_EFFORTS.has(profile.effort)) {
      normalized.effort = profile.effort
    }
    configuredById.set(normalized.id, normalized)
  }

  return DEFAULT_REVIEW_PROFILES.map((defaultProfile) => ({
    ...defaultProfile,
    ...configuredById.get(defaultProfile.id),
  }))
}

/**
 * Replace template variables in content based on user configuration.
 * Injects model routing configs and MCP provider tool names at install time.
 *
 * Supported MCP providers: 'ace-tool' (default), 'ace-tool-rs', 'contextweaver',
 * 'fast-context', 'skip' (fallback to Glob+Grep).
 */
export function injectHookConfig(
  content: string,
  config: {
    routing?: {
      frontend?: { primary?: string }
      backend?: { primary?: string }
      grokModel?: string
      kimiModel?: string
      opencodeModel?: string
      review?: { profiles?: ReviewProfile[] }
    }
    liteMode?: boolean
    skillsProfile?: string[]
  },
  installDir: string
): string {
  const backends = ['codex', 'claude', 'antigravity', 'grok', 'kimi', 'opencode']
  const routing = config.routing ?? {}
  const snapshot = {
    installDir,
    frontend: backends.includes(routing.frontend?.primary ?? '') ? routing.frontend!.primary : 'claude',
    backend: backends.includes(routing.backend?.primary ?? '') ? routing.backend!.primary : 'claude',
    models: { grok: routing.grokModel, kimi: routing.kimiModel, opencode: routing.opencodeModel },
    review: resolveReviewProfiles(routing.review?.profiles),
    liteMode: config.liteMode ?? true,
    nativeSkills: config.skillsProfile !== undefined,
  }
  return content.replace(/"\{\{HOOK_CONFIG_JSON\}\}"/g, () => JSON.stringify(JSON.stringify(snapshot)))
}

type TemplateConfig = {
  routing?: {
    mode?: string
    frontend?: { models?: string[]; primary?: string }
    backend?: { models?: string[]; primary?: string }
    review?: {
      profiles?: ReviewProfile[]
    }
    grokModel?: string
    kimiModel?: string
    opencodeModel?: string
  }
  liteMode?: boolean
  mcpProvider?: string
}

type TemplateRouting = NonNullable<TemplateConfig['routing']>
type ModelFlag = { backend: string; model?: string; flag: string; placeholder: string }

function injectRoutingVariables(content: string, routing: TemplateRouting): string {
  const frontendModels = routing.frontend?.models || ['claude']
  const backendModels = routing.backend?.models || ['claude']
  return content
    .replace(/\{\{FRONTEND_MODELS\}\}/g, JSON.stringify(frontendModels))
    .replace(/\{\{FRONTEND_PRIMARY\}\}/g, routing.frontend?.primary || 'claude')
    .replace(/\{\{BACKEND_MODELS\}\}/g, JSON.stringify(backendModels))
    .replace(/\{\{BACKEND_PRIMARY\}\}/g, routing.backend?.primary || 'claude')
}

function injectReviewProfiles(content: string, routing: TemplateRouting): string {
  const reviewProfiles = resolveReviewProfiles(routing.review?.profiles)
  const reviewProfileById = new Map(reviewProfiles.map((profile) => [profile.id, profile]))
  const reviewGpt = reviewProfileById.get('gpt')
  const reviewGrok = reviewProfileById.get('grok')
  return content
    .replace(/\{\{REVIEW_PROFILES\}\}/g, JSON.stringify(reviewProfiles))
    .replace(/\{\{REVIEW_GPT_MODEL\}\}/g, reviewGpt?.model || '')
    .replace(/\{\{REVIEW_GPT_EFFORT\}\}/g, reviewGpt?.effort || '')
    .replace(/\{\{REVIEW_GROK_MODEL\}\}/g, reviewGrok?.model || '')
    .replace(/\{\{REVIEW_GROK_EFFORT\}\}/g, reviewGrok?.effort || '')
}

function replaceModelFlag(content: string, modelFlag: ModelFlag, configuredModels: Set<string>): string {
  const { placeholder, model, backend, flag } = modelFlag
  const pattern = new RegExp(`\\{\\{${placeholder}\\}\\}`, 'g')
  const modelName = model?.trim()
  if (!configuredModels.has(backend) || !modelName) return content.replace(pattern, '')

  const hardCodedBackend = /--backend\s+([a-z0-9-]+)(?:\s|$)/
  return content
    .split('\n')
    .map((line) => {
      if (!line.includes(`{{${placeholder}}}`)) return line
      const matchedBackend = line.match(hardCodedBackend)?.[1]
      if (matchedBackend && matchedBackend !== backend) return line.replace(pattern, '')
      const conditionalBackends = line.match(/--backend\s+<([^>]+)>/)?.[1].split('|') || []
      if (conditionalBackends.some((route) => route.trim().split(/\s+/, 1)[0] === backend)) {
        return line.replace(pattern, '')
      }
      return line.replace(pattern, `${flag} ${modelName} `)
    })
    .join('\n')
}

function addModelFlagToWrapperCalls(content: string, modelFlag: ModelFlag, configuredModels: Set<string>): string {
  const { backend, model, flag } = modelFlag
  const modelName = model?.trim()
  if (!configuredModels.has(backend) || !modelName) return content
  const wrapperBackend = new RegExp(`(codeagent-wrapper.*?--backend\\s+${backend})(?=\\s|$)`)
  return content
    .split('\n')
    .map((line) => {
      if (!line.includes('codeagent-wrapper') || line.includes(flag)) return line
      return line.replace(wrapperBackend, `$1 ${flag} ${modelName}`)
    })
    .join('\n')
}

function injectModelFlags(content: string, routing: TemplateRouting): string {
  const frontendRouting = routing.frontend || {}
  const backendRouting = routing.backend || {}
  const configuredModels = new Set([
    ...(frontendRouting.models || ['claude']),
    ...(backendRouting.models || ['claude']),
  ])
  const modelFlags: ModelFlag[] = [
    { backend: 'grok', model: routing.grokModel, flag: '--grok-model', placeholder: 'GROK_MODEL_FLAG' },
    { backend: 'kimi', model: routing.kimiModel, flag: '--kimi-model', placeholder: 'KIMI_MODEL_FLAG' },
    { backend: 'opencode', model: routing.opencodeModel, flag: '--opencode-model', placeholder: 'OPENCODE_MODEL_FLAG' },
  ]
  let processed = content.replace(/\{\{GEMINI_MODEL_FLAG\}\}/g, '')
  for (const modelFlag of modelFlags) processed = replaceModelFlag(processed, modelFlag, configuredModels)
  for (const modelFlag of modelFlags) processed = addModelFlagToWrapperCalls(processed, modelFlag, configuredModels)
  return injectConditionalModelRoutes(processed, routing, modelFlags)
}

function injectConditionalModelRoutes(content: string, routing: TemplateRouting, modelFlags: ModelFlag[]): string {
  const modelRoute = (backend: string): string => {
    const modelFlag = modelFlags.find((entry) => entry.backend === backend)
    return modelFlag?.model?.trim() ? `${backend} ${modelFlag.flag} ${modelFlag.model.trim()}` : backend
  }
  const backend = routing.backend?.primary || 'claude'
  const frontend = routing.frontend?.primary || 'claude'
  const conditionalBackend = `--backend <${backend}|${frontend}>`
  return content.replaceAll(conditionalBackend, `--backend <${modelRoute(backend)}|${modelRoute(frontend)}>`)
}

function injectPureClaudeDirective(content: string): string {
  const guidance = [
    'Both primary routes use Claude. This section overrides every later primary-route `codeagent-wrapper` example.',
    'Do not execute a later wrapper call that resolves to `--backend claude` without `--no-session-persistence`;',
    'it is a non-Pure-Claude alternative. Use independent Claude Code Agent or Agent Teams work instead.',
    'Set `CCG_ROLE: research` for research or analysis work and `CCG_ROLE: implement` for implementation work',
    'so role-scoped specifications are injected. Review commands that explicitly use `--no-session-persistence`',
    'remain enabled and must run in independent contexts.',
  ].join(' ')
  const directive = `\n## Pure Claude Code mode\n\n${guidance}\n`
  const frontmatter = /^---\n[\s\S]*?\n---\n/
  return frontmatter.test(content)
    ? content.replace(frontmatter, (match) => `${match}${directive}`)
    : `${directive}\n${content}`
}

function injectMcpProvider(content: string, mcpProvider: string): string {
  if (mcpProvider === 'skip') {
    // MCP skipped: multi-step fallback replacement (unique logic, not in registry)
    return content
      .replace(/,\s*\{\{MCP_SEARCH_TOOL\}\}/g, '')
      .replace(
        /```\n\{\{MCP_SEARCH_TOOL\}\}[\s\S]*?\n```/g,
        '> MCP 未配置。使用 `Glob` 定位文件 + `Grep` 搜索关键符号 + `Read` 读取文件内容。'
      )
      .replace(/`\{\{MCP_SEARCH_TOOL\}\}`/g, '`Glob + Grep`（MCP 未配置）')
      .replace(/\{\{MCP_SEARCH_TOOL\}\}/g, 'Glob + Grep')
      .replace(/\{\{MCP_SEARCH_PARAM\}\}/g, '')
  }
  const provider = MCP_PROVIDERS[mcpProvider] ?? MCP_PROVIDERS['ace-tool']
  return content.replace(/\{\{MCP_SEARCH_TOOL\}\}/g, provider.tool).replace(/\{\{MCP_SEARCH_PARAM\}\}/g, provider.param)
}

export function injectConfigVariables(content: string, config: TemplateConfig): string {
  const routing = config.routing || {}
  let processed = injectRoutingVariables(content, routing)
  processed = injectReviewProfiles(processed, routing)
  processed = processed.replace(/\{\{ROUTING_MODE\}\}/g, routing.mode || 'smart')
  processed = injectModelFlags(processed, routing)
  const pureClaudeCodeMode = routing.frontend?.primary === 'claude' && routing.backend?.primary === 'claude'
  if (pureClaudeCodeMode) processed = injectPureClaudeDirective(processed)
  // Lite mode flag for codeagent-wrapper
  const liteModeFlag = (config.liteMode ?? true) ? '--lite ' : ''
  processed = processed.replace(/\{\{LITE_MODE_FLAG\}\}/g, liteModeFlag)
  return injectMcpProvider(processed, config.mcpProvider || 'ace-tool')
}

/**
 * Replace ~ paths in template content with absolute paths.
 * Fixes Windows multi-user path resolution issues.
 *
 * IMPORTANT: Always use forward slashes (/) for cross-platform compatibility.
 * Windows Git Bash requires forward slashes in heredoc (backslashes get escaped).
 * PowerShell and CMD also support forward slashes for most commands.
 */
export function replaceHomePathsInTemplate(content: string, installDir: string): string {
  // Get absolute paths for replacement
  const userHome = homedir()
  const ccgDir = join(installDir, '.ccg')
  const binDir = join(installDir, 'bin')
  const claudeDir = installDir // ~/.claude

  // IMPORTANT: Always use forward slashes for cross-platform compatibility
  // Git Bash on Windows requires forward slashes in heredoc (backslashes get escaped)
  // PowerShell and CMD also support forward slashes for most commands
  const toForwardSlash = (path: string) => path.replace(/\\/g, '/')

  let processed = content

  // Order matters: replace longer patterns first to avoid partial matches
  // 1. Replace ~/.claude/.ccg with absolute path (longest match first)
  processed = processed.replace(/~\/\.claude\/\.ccg/g, toForwardSlash(ccgDir))

  // 2. Replace ~/.claude/bin/codeagent-wrapper with absolute path + .exe on Windows
  //    CRITICAL: Windows Git Bash requires explicit .exe extension
  const wrapperName = isWindows() ? 'codeagent-wrapper.exe' : 'codeagent-wrapper'
  const wrapperPath = `${toForwardSlash(binDir)}/${wrapperName}`
  processed = processed.replace(/~\/\.claude\/bin\/codeagent-wrapper/g, wrapperPath)

  // 3. Replace ~/.claude/bin with absolute path (for other binaries)
  processed = processed.replace(/~\/\.claude\/bin/g, toForwardSlash(binDir))

  // 4. Replace ~/.claude with absolute path
  processed = processed.replace(/~\/\.claude/g, toForwardSlash(claudeDir))

  // 5. Replace remaining ~/ patterns with user home
  processed = processed.replace(/~\//g, `${toForwardSlash(userHome)}/`)

  return processed
}
