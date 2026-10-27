import ansis from 'ansis'
import fs from 'fs-extra'
import ora from 'ora'
import { join } from 'pathe'
import { i18n } from '../i18n'
import type { ModelRouting } from '../types'
import { createDefaultConfig, ensureCcgDir, writeCcgConfig } from '../utils/config'
import {
  configureSponsorForCodex,
  getSponsor,
  installAceTool,
  installContextWeaver,
  installFastContext,
  installMcpServer,
  installWorkflows,
  sponsorCopy,
  syncMcpToCodex,
  writeFastContextPrompt,
} from '../utils/installer'
import { migrateToV1_4_0, needsMigration } from '../utils/migration'
import type { InitState } from './init-state'
import { configureApiDefaults, installHook } from './command-settings'
import type { ClaudeSettings } from './command-settings'
import { appendGrokSearchPrompt, installGrokSearchMcp } from './grok-search'
import { showInitResult } from './init-result'

type Spinner = ReturnType<typeof ora>

async function migrateInstall(spinner: Spinner): Promise<void> {
  // v1.4.0: Auto-migrate from old directory structure
  if (await needsMigration()) {
    spinner.text = 'Migrating from v1.3.x to v1.4.0...'
    const migrationResult = await migrateToV1_4_0()

    if (migrationResult.migratedFiles.length > 0) {
      spinner.info(ansis.cyan('Migration completed:'))
      console.log()
      for (const file of migrationResult.migratedFiles) {
        console.log(`  ${ansis.green('✓')} ${file}`)
      }
      if (migrationResult.skipped.length > 0) {
        console.log()
        console.log(ansis.gray('  Skipped:'))
        for (const file of migrationResult.skipped) {
          console.log(`  ${ansis.gray('○')} ${file}`)
        }
      }
      console.log()
      spinner.start(i18n.t('init:installing'))
    }

    if (migrationResult.errors.length > 0) {
      spinner.warn(ansis.yellow('Migration completed with errors:'))
      for (const error of migrationResult.errors) {
        console.log(`  ${ansis.red('✗')} ${error}`)
      }
      console.log()
      spinner.start(i18n.t('init:installing'))
    }
  }
}

async function installRetrievalMcps(state: InitState, spinner: Spinner): Promise<void> {
  // ace-tool
  if (state.aceToolToken) {
    spinner.text = i18n.t('init:aceTool.installing')
    const aceResult = await installAceTool({ baseUrl: state.aceToolBaseUrl, token: state.aceToolToken })
    if (aceResult.success) {
      console.log(`    ${ansis.green('✓')} ace-tool MCP ${ansis.gray(`→ ${aceResult.configPath}`)}`)
    } else {
      console.log(`    ${ansis.yellow('⚠')} ace-tool: ${ansis.gray(aceResult.message)}`)
    }
  }

  // fast-context
  if (state.wantFastContext) {
    const fcResult = await installFastContext({
      apiKey: state.fastContextApiKey || undefined,
      includeSnippets: state.fastContextIncludeSnippets,
    })
    if (fcResult.success) {
      console.log(`    ${ansis.green('✓')} fast-context MCP ${ansis.gray(`→ ${fcResult.configPath}`)}`)
      // Write search guidance — auxiliary mode if ace-tool is primary
      await writeFastContextPrompt(state.mcpProvider === 'ace-tool' || state.mcpProvider === 'ace-tool-rs')
      console.log(
        `    ${ansis.green('✓')} ${i18n.t('init:mcp.fcPromptInjected')} ${ansis.gray('→ ~/.claude/rules/ + ~/.codex/')}`
      )
    } else {
      console.log(`    ${ansis.yellow('⚠')} fast-context: ${ansis.gray(fcResult.message)}`)
    }
  }

  // contextweaver
  if (state.contextWeaverApiKey) {
    spinner.text = i18n.t('init:mcp.cwConfiguring')
    const cwResult = await installContextWeaver({ siliconflowApiKey: state.contextWeaverApiKey })
    if (cwResult.success) {
      console.log(`    ${ansis.green('✓')} ContextWeaver MCP ${ansis.gray(`→ ${cwResult.configPath}`)}`)
    } else {
      console.log(`    ${ansis.yellow('⚠')} ContextWeaver: ${ansis.gray(cwResult.message)}`)
    }
  }
}

async function saveApiSettings(state: InitState, settingsPath: string): Promise<void> {
  // Save API configuration if provided
  if (state.apiUrl && state.apiKey) {
    let settings: ClaudeSettings = {}
    if (await fs.pathExists(settingsPath)) {
      settings = await fs.readJSON(settingsPath)
    }
    if (!settings.env) settings.env = {}
    settings.env.ANTHROPIC_BASE_URL = state.apiUrl
    settings.env.ANTHROPIC_AUTH_TOKEN = state.apiKey
    delete settings.env.ANTHROPIC_API_KEY
    configureApiDefaults(settings)
    await fs.writeJSON(settingsPath, settings, { spaces: 2 })
    console.log()
    console.log(`    ${ansis.green('✓')} API ${ansis.gray(`→ ${settingsPath}`)}`)
  }
}

async function configureSponsorCodex(state: InitState): Promise<void> {
  if (state.sponsorWireCodex && state.sponsorId) {
    const sponsor = getSponsor(state.sponsorId)
    const codexApi = await configureSponsorForCodex(state.sponsorId, state.sponsorActivateCodex)
    console.log()
    if (codexApi.success && sponsor) {
      const copy = sponsorCopy(sponsor)
      console.log(`    ${ansis.green('✓')} Codex ${ansis.gray(`→ ${codexApi.configPath}`)}`)
      console.log(`      ${ansis.gray(i18n.t('init:api.sponsorCodexEnvHint', copy))}`)
      console.log(`      ${ansis.cyan(`export ${sponsor.codex.env_key}="<your-${sponsor.id}-api-key>"`)}`)
      if (!codexApi.active) {
        console.log(`      ${ansis.gray(i18n.t('init:api.sponsorCodexNotActive', copy))}`)
      }
    } else {
      console.log(`    ${ansis.yellow('!')} ${codexApi.message}`)
    }
  }
}

async function installSearchMcp(state: InitState, spinner: Spinner): Promise<void> {
  // Install grok-search MCP if requested
  if (state.wantGrokSearch && (state.tavilyKey || state.firecrawlKey || state.grokApiUrl || state.grokApiKey)) {
    spinner.text = i18n.t('init:grok.installing')
    const grokResult = await installGrokSearchMcp({
      tavilyKey: state.tavilyKey,
      firecrawlKey: state.firecrawlKey,
      grokApiUrl: state.grokApiUrl || undefined,
      grokApiKey: state.grokApiKey || undefined,
    })

    if (grokResult.success) {
      // Write global prompt to ~/.claude/rules/ccg-grok-search.md
      await appendGrokSearchPrompt()
      console.log()
      console.log(`    ${ansis.green('✓')} grok-search MCP ${ansis.gray('→ ~/.claude.json')}`)
      console.log(
        `    ${ansis.green('✓')} ${i18n.t('init:grok.promptAppended')} ` +
          ansis.gray('→ ~/.claude/rules/ccg-grok-search.md')
      )
    } else {
      console.log()
      console.log(`    ${ansis.yellow('⚠')} grok-search MCP ${i18n.t('init:grok.installFailed')}`)
      console.log(ansis.gray(`      ${grokResult.message}`))
    }
  }
}

async function syncAdditionalMcp(state: InitState): Promise<void> {
  if (!state.options.skipMcp) {
    const context7Result = await installMcpServer('context7', 'npx', ['-y', '@upstash/context7-mcp@latest'])
    if (context7Result.success) {
      console.log()
      console.log(`    ${ansis.green('✓')} context7 MCP ${ansis.gray('→ ~/.claude.json')}`)
    } else {
      console.log()
      console.log(`    ${ansis.yellow('⚠')} context7 MCP install failed`)
      console.log(ansis.gray(`      ${context7Result.message}`))
    }

    // ═══════════════════════════════════════════════════════
    // Sync MCP servers to Codex (~/.codex/config.toml)
    // Enables /ccg:codex-exec to use MCP tools (grok-search, context7, etc.)
    // ═══════════════════════════════════════════════════════
    const codexSyncResult = await syncMcpToCodex()
    if (codexSyncResult.success && codexSyncResult.synced.length > 0) {
      console.log()
      console.log(
        `    ${ansis.green('✓')} Codex MCP sync: ${codexSyncResult.synced.join(', ')} ` +
          ansis.gray('→ ~/.codex/config.toml')
      )
    } else if (!codexSyncResult.success) {
      console.log()
      console.log(`    ${ansis.yellow('⚠')} Codex MCP sync failed`)
      console.log(ansis.gray(`      ${codexSyncResult.message}`))
    }
  }
}

export async function installInit(state: InitState, routing: ModelRouting): Promise<void> {
  const spinner = ora(i18n.t('init:installing')).start()
  try {
    await migrateInstall(spinner)
    await ensureCcgDir()

    // Create config
    const config = createDefaultConfig({
      language: state.language,
      routing,
      installedWorkflows: state.selectedWorkflows,
      mcpProvider: state.mcpProvider,
      liteMode: state.liteMode,
      skipImpeccable: state.skipImpeccable,
      skillsProfile: state.skillsProfile,
      skillsMode: state.selectedSkillsMode,
    })

    // Save config FIRST - ensure it's created even if installation fails
    await writeCcgConfig(config)

    // Install workflows and commands
    const result = await installWorkflows(state.selectedWorkflows, state.installDir, state.options.force, {
      routing,
      liteMode: state.liteMode,
      mcpProvider: state.mcpProvider,
      skipImpeccable: state.skipImpeccable,
      skillsProfile: state.skillsProfile,
      skillsMode: state.selectedSkillsMode,
    })

    if (!result.success) {
      spinner.fail(ansis.red(i18n.t('init:installFailed')))
      for (const error of result.errors) console.log(`    ${ansis.red('✗')} ${error}`)
      process.exitCode = 1
      return
    }

    // Install selected MCP tools (multiple can be installed)
    spinner.succeed(ansis.green(i18n.t('init:installSuccess')))
    await installRetrievalMcps(state, spinner)
    const settingsPath = join(state.installDir, 'settings.json')
    await saveApiSettings(state, settingsPath)
    await configureSponsorCodex(state)
    // Always install codeagent-wrapper auto-approve via permissions.allow
    await installHook(settingsPath)
    console.log()
    console.log(`    ${ansis.green('✓')} ${i18n.t('init:hooks.installed')} ${ansis.gray('(permissions.allow)')}`)
    await installSearchMcp(state, spinner)
    await syncAdditionalMcp(state)
    await showInitResult(state, result)
    console.log()
  } catch (error) {
    spinner.fail(ansis.red(i18n.t('init:installFailed')))
    console.error(error)
    process.exitCode = 1
  }
}
