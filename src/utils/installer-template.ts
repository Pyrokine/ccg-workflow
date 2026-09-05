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
      `  Please report this issue at: https://github.com/fengshao1227/ccg-workflow/issues`
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
  { id: 'grok', model: 'grok-4.5', effort: 'high' },
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
export function injectConfigVariables(
  content: string,
  config: {
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
): string {
  let processed = content

  // Model routing injection
  const routing = config.routing || {}

  // Frontend models
  const frontendModels = routing.frontend?.models || ['claude']
  const frontendPrimary = routing.frontend?.primary || 'claude'
  processed = processed.replace(/\{\{FRONTEND_MODELS\}\}/g, JSON.stringify(frontendModels))
  processed = processed.replace(/\{\{FRONTEND_PRIMARY\}\}/g, frontendPrimary)

  // Backend models
  const backendModels = routing.backend?.models || ['claude']
  const backendPrimary = routing.backend?.primary || 'claude'
  processed = processed.replace(/\{\{BACKEND_MODELS\}\}/g, JSON.stringify(backendModels))
  processed = processed.replace(/\{\{BACKEND_PRIMARY\}\}/g, backendPrimary)

  // Review profiles
  const reviewProfiles = resolveReviewProfiles(routing.review?.profiles)
  const reviewProfileById = new Map(reviewProfiles.map((profile) => [profile.id, profile]))
  const reviewGpt = reviewProfileById.get('gpt')
  const reviewGrok = reviewProfileById.get('grok')
  processed = processed.replace(/\{\{REVIEW_PROFILES\}\}/g, JSON.stringify(reviewProfiles))
  processed = processed.replace(/\{\{REVIEW_GPT_MODEL\}\}/g, reviewGpt?.model || '')
  processed = processed.replace(/\{\{REVIEW_GPT_EFFORT\}\}/g, reviewGpt?.effort || '')
  processed = processed.replace(/\{\{REVIEW_GROK_MODEL\}\}/g, reviewGrok?.model || '')
  processed = processed.replace(/\{\{REVIEW_GROK_EFFORT\}\}/g, reviewGrok?.effort || '')

  // Routing mode
  const routingMode = routing.mode || 'smart'
  processed = processed.replace(/\{\{ROUTING_MODE\}\}/g, routingMode)

  processed = processed.replace(/\{\{GEMINI_MODEL_FLAG\}\}/g, '')

  const configuredModels = new Set([...frontendModels, ...backendModels])
  const replaceModelFlag = (placeholder: string, model: string | undefined, backend: string, flag: string): void => {
    const pattern = new RegExp(`\\{\\{${placeholder}\\}\\}`, 'g')
    const modelName = model?.trim()
    if (!configuredModels.has(backend) || !modelName) {
      processed = processed.replace(pattern, '')
      return
    }

    const hardCodedBackend = /--backend\s+([a-z0-9-]+)(?:\s|$)/
    processed = processed
      .split('\n')
      .map((line) => {
        if (!line.includes(`{{${placeholder}}}`)) {
          return line
        }
        const matchedBackend = line.match(hardCodedBackend)?.[1]
        if (matchedBackend && matchedBackend !== backend) {
          return line.replace(pattern, '')
        }
        const conditionalBackends = line.match(/--backend\s+<([^>]+)>/)?.[1].split('|') || []
        if (conditionalBackends.some((route) => route.trim().split(/\s+/, 1)[0] === backend)) {
          return line.replace(pattern, '')
        }
        return line.replace(pattern, `${flag} ${modelName} `)
      })
      .join('\n')
  }

  replaceModelFlag('GROK_MODEL_FLAG', routing.grokModel, 'grok', '--grok-model')
  replaceModelFlag('KIMI_MODEL_FLAG', routing.kimiModel, 'kimi', '--kimi-model')
  replaceModelFlag('OPENCODE_MODEL_FLAG', routing.opencodeModel, 'opencode', '--opencode-model')

  const addModelFlagToWrapperCalls = (backend: string, model: string | undefined, flag: string): void => {
    const modelName = model?.trim()
    if (!configuredModels.has(backend) || !modelName) {
      return
    }

    const wrapperBackend = new RegExp(`(codeagent-wrapper.*?--backend\\s+${backend})(?=\\s|$)`)
    processed = processed
      .split('\n')
      .map((line) => {
        if (!line.includes('codeagent-wrapper') || line.includes(flag)) {
          return line
        }
        return line.replace(wrapperBackend, `$1 ${flag} ${modelName}`)
      })
      .join('\n')
  }

  addModelFlagToWrapperCalls('grok', routing.grokModel, '--grok-model')
  addModelFlagToWrapperCalls('kimi', routing.kimiModel, '--kimi-model')
  addModelFlagToWrapperCalls('opencode', routing.opencodeModel, '--opencode-model')

  const modelRoute = (backend: string): string => {
    const flags: Record<string, [string | undefined, string]> = {
      grok: [routing.grokModel, '--grok-model'],
      kimi: [routing.kimiModel, '--kimi-model'],
      opencode: [routing.opencodeModel, '--opencode-model'],
    }
    const modelFlag = flags[backend]
    if (!modelFlag) {
      return backend
    }
    const [model, flag] = modelFlag
    return model?.trim() ? `${backend} ${flag} ${model.trim()}` : backend
  }
  const conditionalBackend = `--backend <${backendPrimary}|${frontendPrimary}>`
  const conditionalModelRoutes = `--backend <${modelRoute(backendPrimary)}|${modelRoute(frontendPrimary)}>`
  processed = processed.replaceAll(conditionalBackend, conditionalModelRoutes)

  const pureClaudeCodeMode = routing.frontend?.primary === 'claude' && routing.backend?.primary === 'claude'
  if (pureClaudeCodeMode) {
    const directive = `
## Pure Claude Code mode

Both primary routes use Claude. This section overrides every later primary-route \`codeagent-wrapper\` example. Do not execute a later wrapper call that resolves to \`--backend claude\` without \`--no-session-persistence\`; it is a non-Pure-Claude alternative. Use independent Claude Code Agent or Agent Teams work instead. Set \`CCG_ROLE: research\` for research or analysis work and \`CCG_ROLE: implement\` for implementation work so role-scoped specifications are injected. Review commands that explicitly use \`--no-session-persistence\` remain enabled and must run in independent contexts.
`
    const frontmatter = /^---\n[\s\S]*?\n---\n/
    if (frontmatter.test(processed)) {
      processed = processed.replace(frontmatter, (match) => `${match}${directive}`)
    } else {
      processed = `${directive}\n${processed}`
    }
  }

  // Lite mode flag for codeagent-wrapper
  // If liteMode is true, inject "--lite" flag
  const liteModeFlag = (config.liteMode ?? true) ? '--lite ' : ''
  processed = processed.replace(/\{\{LITE_MODE_FLAG\}\}/g, liteModeFlag)

  // MCP tool injection based on provider (registry-driven)
  const mcpProvider = config.mcpProvider || 'ace-tool'
  if (mcpProvider === 'skip') {
    // MCP skipped: multi-step fallback replacement (unique logic, not in registry)
    processed = processed.replace(/,\s*\{\{MCP_SEARCH_TOOL\}\}/g, '')
    processed = processed.replace(
      /```\n\{\{MCP_SEARCH_TOOL\}\}[\s\S]*?\n```/g,
      '> MCP 未配置。使用 `Glob` 定位文件 + `Grep` 搜索关键符号 + `Read` 读取文件内容。'
    )
    processed = processed.replace(/`\{\{MCP_SEARCH_TOOL\}\}`/g, '`Glob + Grep`（MCP 未配置）')
    processed = processed.replace(/\{\{MCP_SEARCH_TOOL\}\}/g, 'Glob + Grep')
    processed = processed.replace(/\{\{MCP_SEARCH_PARAM\}\}/g, '')
  } else {
    // Registry lookup — adding a new MCP provider = 1 line
    const provider = MCP_PROVIDERS[mcpProvider] ?? MCP_PROVIDERS['ace-tool']
    processed = processed.replace(/\{\{MCP_SEARCH_TOOL\}\}/g, provider.tool)
    processed = processed.replace(/\{\{MCP_SEARCH_PARAM\}\}/g, provider.param)
  }

  return processed
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
