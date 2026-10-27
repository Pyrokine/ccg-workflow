import fs from 'fs-extra'
import { join } from 'pathe'
import type { InstallResult } from '../types'
import {
  createInstallContext,
  workflowInstallConfig,
  type InstallConfig,
  type InstallContext,
  type InstallOptions,
} from './installer-context'
import { PACKAGE_ROOT } from './installer-template'
import { installCommandFiles, installEngineFiles, installAgentFiles, installPromptFiles } from './installer-files'
import { installSkillFiles, installRuleFiles, installSkillGeneratedCommands } from './installer-skills'
import { installHookScripts, readHookSettings, registerHooksInSettings } from './installer-hooks'
import { installBinaryFile } from './installer-binary'

export { verifyBinary, verifyBinaryVersion, showBinaryDownloadWarning } from './installer-binary'
export { installCodexMode, uninstallCodexMode } from './installer-codex'
export { uninstallWorkflows, type UninstallResult } from './installer-uninstall'

// ═══════════════════════════════════════════════════════
// Re-exports — all consumers import from './installer'
// These re-exports preserve backward compatibility.
// ═══════════════════════════════════════════════════════

export {
  getAllCommandIds,
  getCoreCommandIds,
  getLegacyCommandIds,
  getWorkflowById,
  getWorkflowConfigs,
  getWorkflowPreset,
  WORKFLOW_PRESETS,
} from './installer-data'
export type { WorkflowPreset } from './installer-data'

export { injectConfigVariables } from './installer-template'

export {
  APIMART_CODEX_PROVIDER,
  APIMART_CODEX_PROVIDER_ID,
  PACKYCODE_CODEX_PROVIDER,
  PACKYCODE_CODEX_PROVIDER_ID,
  configureAllSponsorsForCodex,
  configureApiMartForCodex,
  configurePackyCodeForCodex,
  configureSponsorForCodex,
  removeAllSponsorsFromCodex,
  removeApiMartFromCodex,
  removePackyCodeFromCodex,
  removeSponsorFromCodex,
} from './installer-codex-api'
export type {
  CodexApiResult,
  CodexProviderStatus,
  CodexSponsorResult,
  CodexSponsorsResult,
} from './installer-codex-api'

export {
  SPONSORS,
  getSponsor,
  promptSponsorInit,
  promptSponsorMenuKey,
  sponsorCopy,
  sponsorInquirerChoices,
} from './sponsors'
export type { CodexProviderSpec, SponsorGateway } from './sponsors'

export {
  installAceTool,
  installAceToolRs,
  installContextWeaver,
  installFastContext,
  installMcpServer,
  syncMcpToCodex,
  uninstallAceTool,
  uninstallContextWeaver,
  uninstallFastContext,
  uninstallMcpServer,
} from './installer-mcp'
export type { ContextWeaverConfig } from './installer-mcp'

export { removeFastContextPrompt, writeFastContextPrompt } from './installer-prompt'

export { collectInvocableSkills, collectSkills, parseFrontmatter } from './skill-registry'
export type { SkillMeta } from './skill-registry'

export async function installWorkflows(
  workflowIds: string[],
  installDir: string,
  force = false,
  config?: InstallOptions
): Promise<InstallResult> {
  const ctx = createInstallContext(installDir, force, workflowInstallConfig(config))

  // ── Pre-flight: validate template directory exists ──
  // This is the #1 root cause of "silent install failure" on Windows:
  // if PACKAGE_ROOT resolved wrong, templateDir doesn't exist and every
  // sub-step silently returns empty results while reporting success.
  if (!(await fs.pathExists(ctx.templateDir))) {
    const errorMsg =
      `Template directory not found: ${ctx.templateDir} (PACKAGE_ROOT=${PACKAGE_ROOT}). ` +
      `This usually means the npm package is incomplete or the cache is corrupted. ` +
      `Try: npm cache clean --force && npx ccg-workflow@latest`
    ctx.result.errors.push(errorMsg)
    ctx.result.success = false
    return ctx.result
  }

  // Ensure base directories
  await fs.ensureDir(join(installDir, 'commands', 'ccg'))
  await fs.ensureDir(join(installDir, '.ccg'))
  await fs.ensureDir(join(installDir, '.ccg', 'prompts'))
  await fs.ensureDir(join(installDir, '.ccg', 'engine', 'strategies'))

  // Execute each install step
  await installCommandFiles(ctx, workflowIds)
  await installEngineFiles(ctx)
  const hooksInstalled = await installHookScripts(ctx)
  if (hooksInstalled) {
    await registerHooksInSettings(ctx)
  }
  await installAgentFiles(ctx)
  await installPromptFiles(ctx)
  await installSkillFiles(ctx)
  await installRuleFiles(ctx)
  if (ctx.result.errors.length > 0) ctx.result.success = false
  await installSkillGeneratedCommands(ctx)
  if (!ctx.config.skipBinary) {
    await installBinaryFile(ctx)
  }

  return finishWorkflowInstall(ctx, workflowIds.length)
}

function finishWorkflowInstall(ctx: InstallContext, expectedCommands: number): InstallResult {
  // ── Post-flight: validate installation produced results ──
  // Catch the case where all sub-steps silently returned empty
  if (ctx.result.installedCommands.length === 0 && ctx.result.errors.length === 0) {
    ctx.result.errors.push(
      `No commands were installed (expected ${expectedCommands}). ` +
        `Template dir: ${ctx.templateDir}. ` +
        `This may indicate a corrupted package or file permission issue.`
    )
    ctx.result.success = false
  }

  ctx.result.configPath = join(ctx.installDir, 'commands', 'ccg')
  return ctx.result
}

/**
 * Refresh routing-dependent CCG artifacts and the Hook runtime they depend on.
 * Skills, MCP servers, and the wrapper binary remain untouched.
 */
export async function syncRoutingTemplates(
  workflowIds: string[],
  installDir: string,
  config: {
    routing: InstallConfig['routing']
    liteMode?: boolean
    mcpProvider?: string
    skipImpeccable?: boolean
    skillsProfile?: string[]
    skillsMode?: 'legacy' | 'native'
  }
): Promise<InstallResult> {
  const ctx = createInstallContext(
    installDir,
    true,
    {
      routing: config.routing,
      liteMode: config.liteMode ?? true,
      mcpProvider: config.mcpProvider || 'fast-context',
      skipImpeccable: config.skipImpeccable ?? false,
      skipBinary: true,
      skillsProfile: config.skillsMode === 'legacy' ? undefined : config.skillsProfile,
      skillsMode: config.skillsMode,
    },
    join(installDir, 'commands', 'ccg')
  )

  if (!(await fs.pathExists(ctx.templateDir))) {
    ctx.result.errors.push(`Template directory not found: ${ctx.templateDir}`)
    ctx.result.success = false
    return ctx.result
  }

  await fs.ensureDir(join(installDir, 'commands', 'ccg'))
  await fs.ensureDir(join(installDir, '.ccg', 'prompts'))
  await fs.ensureDir(join(installDir, '.ccg', 'engine', 'strategies'))

  if (!(await readHookSettings(ctx))) return ctx.result
  if (!(await installHookScripts(ctx))) return ctx.result
  await registerHooksInSettings(ctx)
  if (!ctx.result.success) return ctx.result

  await installCommandFiles(ctx, workflowIds, { backupExisting: true })
  await installEngineFiles(ctx, { backupExisting: true })
  await installPromptFiles(ctx)
  if (ctx.result.errors.length > 0) ctx.result.success = false
  return ctx.result
}
