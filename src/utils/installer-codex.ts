import { homedir } from 'node:os'
import fs from 'fs-extra'
import { join } from 'pathe'
import type { InstallConfig } from './installer-context'
import { normalizeRoutingForInstall, readCcgConfig } from './config'
import { PACKAGE_ROOT } from './installer-template'
import { SPONSORS } from './sponsors'
import { configureAllSponsorsForCodex } from './installer-codex-api'
import {
  TASK_STATE_RUNTIME_FILES,
  CODEX_MODE_MANIFEST,
  CODEX_BACKUP_FILES,
  assertCodexPathLayout,
  ensureCodexPathLayout,
  readOptionalCodexFile,
  readRequiredCodexSource,
  writeCodexFileAtomic,
  createCodexBackup,
  restoreCodexBackup,
  readCodexOriginalFile,
  type CodexInstallPlan,
  type CodexModeManifest,
  type CodexBackup,
  type CodexPlannedFile,
} from './installer-codex-files'
import {
  asRecord,
  renderCodexPaths,
  renderCodexManagedBlock,
  mergeCodexManagedBlock,
  canonicalCodexHookDefinition,
  mergeCodexHooks,
  parseCodexConfig,
  assertCodexModeFeatures,
} from './installer-codex-content'
import { isCodexSponsorProvider, parseCodexModeManifest, buildCodexModeManifest } from './installer-codex-manifest'

async function createCodexInstallConfig(): Promise<InstallConfig> {
  const config = await readCcgConfig()
  const performance = config?.performance ?? {}
  return {
    routing: normalizeRoutingForInstall(config?.routing),
    liteMode: performance.liteMode ?? true,
    mcpProvider: config?.mcp?.provider || 'fast-context',
    skipImpeccable: performance.skipImpeccable ?? false,
    skipBinary: false,
  }
}

async function readCodexInstructions(codexTemplateDir: string, codexHome: string, config: InstallConfig) {
  const agentsTemplate = await readRequiredCodexSource(join(codexTemplateDir, 'AGENTS.md'))
  const managedBlock = renderCodexManagedBlock(agentsTemplate, config)
  const existingAgents = await readOptionalCodexFile(join(codexHome, 'AGENTS.md'))

  const hooksTemplate = renderCodexPaths(await readRequiredCodexSource(join(codexTemplateDir, 'hooks.json')))
  const hookDefinition = canonicalCodexHookDefinition(hooksTemplate, codexHome)
  const existingHooks = await readOptionalCodexFile(join(codexHome, 'hooks.json'))
  return { managedBlock, existingAgents, hookDefinition, existingHooks }
}

function planCodexInstructions(
  instructions: Awaited<ReturnType<typeof readCodexInstructions>>,
  codexHome: string
): CodexPlannedFile[] {
  const { managedBlock, existingAgents, hookDefinition, existingHooks } = instructions
  const files: CodexPlannedFile[] = [
    {
      relativePath: 'AGENTS.md',
      content: mergeCodexManagedBlock(existingAgents?.content ?? null, managedBlock),
      mode: existingAgents?.mode ?? 0o644,
    },
    {
      relativePath: 'hooks.json',
      content: mergeCodexHooks(existingHooks?.content ?? null, hookDefinition, codexHome),
      mode: existingHooks?.mode ?? 0o600,
    },
  ]
  return files
}

async function appendCodexRuntimeFiles(files: CodexPlannedFile[], codexTemplateDir: string): Promise<void> {
  for (const name of ['ccg-implement.toml', 'ccg-review.toml', 'ccg-research.toml']) {
    files.push({
      relativePath: `agents/${name}`,
      content: await readRequiredCodexSource(join(codexTemplateDir, 'agents', name)),
      mode: 0o644,
    })
  }
  files.push({
    relativePath: 'hooks/ccg-workflow.py',
    content: renderCodexPaths(await readRequiredCodexSource(join(codexTemplateDir, 'hooks', 'ccg-workflow.py'))),
    mode: 0o644,
  })
  for (const name of TASK_STATE_RUNTIME_FILES) {
    files.push({
      relativePath: `hooks/ccg/${name}`,
      content: await readRequiredCodexSource(join(PACKAGE_ROOT, 'templates', 'hooks', name)),
      mode: 0o644,
    })
  }
}

async function prepareCodexInstall(
  codexTemplateDir: string,
  codexHome: string,
  config: InstallConfig
): Promise<CodexInstallPlan> {
  await assertCodexPathLayout(codexHome)

  const instructions = await readCodexInstructions(codexTemplateDir, codexHome, config)

  const existingConfig = await readOptionalCodexFile(join(codexHome, 'config.toml'))
  const parsedConfig = parseCodexConfig(existingConfig?.content ?? null)
  assertCodexModeFeatures(parsedConfig)

  const manifestFile = await readOptionalCodexFile(join(codexHome, CODEX_MODE_MANIFEST))
  const previousManifest = manifestFile ? parseCodexModeManifest(manifestFile.content) : null
  if (previousManifest) {
    for (const managedFile of previousManifest.files) {
      if (managedFile.original) await readCodexOriginalFile(codexHome, managedFile)
    }
  }
  const providers = asRecord(parsedConfig.model_providers)
  const retainedSponsorProviderIds =
    previousManifest?.sponsorProviderIds.filter((id) => providers && isCodexSponsorProvider(providers[id], id)) || []

  const files = planCodexInstructions(instructions, codexHome)

  await appendCodexRuntimeFiles(files, codexTemplateDir)

  for (const file of CODEX_BACKUP_FILES) {
    await readOptionalCodexFile(join(codexHome, file))
  }
  return {
    files,
    activeProvider: parsedConfig.model_provider,
    previousManifest,
    retainedSponsorProviderIds,
  }
}

async function verifyCodexProviders(codexHome: string, activeProvider: unknown): Promise<void> {
  const configFile = await readOptionalCodexFile(join(codexHome, 'config.toml'))
  const config = parseCodexConfig(configFile?.content ?? null)
  assertCodexModeFeatures(config)
  const providers = asRecord(config.model_providers)
  for (const sponsor of SPONSORS) {
    if (!providers || !Object.prototype.hasOwnProperty.call(providers, sponsor.id)) {
      throw new Error(`Codex mode verification failed for model_providers.${sponsor.id}`)
    }
  }
  if (JSON.stringify(config.model_provider) !== JSON.stringify(activeProvider)) {
    throw new Error('Codex mode installation changed the active model provider')
  }
}

async function verifyCodexInstall(
  codexHome: string,
  plan: CodexInstallPlan,
  expectedManifest: CodexModeManifest
): Promise<void> {
  for (const file of plan.files) {
    const installed = await readOptionalCodexFile(join(codexHome, file.relativePath))
    if (!installed || installed.content !== file.content) {
      throw new Error(`Codex mode verification failed for ${file.relativePath}`)
    }
  }

  await verifyCodexProviders(codexHome, plan.activeProvider)

  const manifestFile = await readOptionalCodexFile(join(codexHome, CODEX_MODE_MANIFEST))
  if (!manifestFile) throw new Error('Codex mode ownership manifest is missing')
  const manifest = parseCodexModeManifest(manifestFile.content)
  if (JSON.stringify(manifest) !== JSON.stringify(expectedManifest)) {
    throw new Error('Codex mode ownership manifest verification failed')
  }
}

function codexInstallMessage(backup: CodexBackup): string {
  return [
    'Codex mode installed:',
    '  ~/.codex/AGENTS.md (CCG block merged)',
    '  ~/.codex/config.toml (user settings preserved; sponsor providers registered but not activated)',
    '  ~/.codex/hooks.json (CCG Hook merged)',
    '  ~/.codex/hooks/ccg-workflow.py',
    '  ~/.codex/hooks/ccg/task-state.js',
    '  ~/.codex/agents/ccg-implement.toml',
    '  ~/.codex/agents/ccg-review.toml',
    '  ~/.codex/agents/ccg-research.toml',
    `  Backup: ${backup.path.replace(homedir(), '~')}`,
  ].join('\n')
}

/**
 * Install the optional Codex-led runtime without replacing user-owned Codex configuration.
 */
export async function installCodexMode(): Promise<{ success: boolean; message: string }> {
  const codexTemplateDir = join(PACKAGE_ROOT, 'templates', 'codex')
  if (!(await fs.pathExists(codexTemplateDir))) {
    return { success: false, message: 'Codex template directory not found' }
  }

  const codexHome = join(homedir(), '.codex')
  let backup: CodexBackup | undefined
  try {
    const config = await createCodexInstallConfig()
    const plan = await prepareCodexInstall(codexTemplateDir, codexHome, config)
    await ensureCodexPathLayout(codexHome)
    backup = await createCodexBackup(codexHome)

    for (const file of plan.files) {
      await writeCodexFileAtomic(join(codexHome, file.relativePath), file.content, file.mode)
    }

    const sponsorApis = await configureAllSponsorsForCodex()
    if (!sponsorApis.success) throw new Error(sponsorApis.message)
    const manifest = await buildCodexModeManifest(plan, backup, sponsorApis.results)
    await writeCodexFileAtomic(join(codexHome, CODEX_MODE_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, 0o600)
    await verifyCodexInstall(codexHome, plan, manifest)

    return {
      success: true,
      message: codexInstallMessage(backup),
    }
  } catch (error) {
    if (!backup) return { success: false, message: `Failed to install Codex mode: ${error}` }
    try {
      await restoreCodexBackup(codexHome, backup)
      return {
        success: false,
        message:
          `Failed to install Codex mode: ${error}. ` +
          `Original files restored from ${backup.path.replace(homedir(), '~')}`,
      }
    } catch (restoreError) {
      return {
        success: false,
        message:
          `Failed to install Codex mode: ${error}. Restore also failed: ${restoreError}. ` +
          `Backup: ${backup.path.replace(homedir(), '~')}`,
      }
    }
  }
}

export { uninstallCodexMode } from './installer-codex-uninstall'
