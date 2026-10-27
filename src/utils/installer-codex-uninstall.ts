import { homedir } from 'node:os'
import fs from 'fs-extra'
import { join } from 'pathe'
import { removeSponsorsFromCodex } from './installer-codex-api'
import {
  CODEX_MANAGED_FILES,
  CODEX_MODE_MANIFEST,
  assertSafeCodexDirectory,
  assertCodexPathLayout,
  readOptionalCodexFile,
  readCodexOriginalFile,
  ensureCodexPathLayout,
  createCodexBackup,
  writeCodexFileAtomic,
  removeRegularCodexFile,
  removeOrRestoreCodexManagedFile,
  restoreCodexBackup,
  type CodexModeManifest,
  type CodexBackup,
} from './installer-codex-files'
import { removeCodexManagedBlock, removeCodexHookRegistration, parseCodexConfig } from './installer-codex-content'
import { parseCodexModeManifest } from './installer-codex-manifest'

type Changes = { removed: string[]; skipped: string[] }
type UninstallPlan = Awaited<ReturnType<typeof prepareCodexUninstall>>

async function prepareCodexUninstall(codexHome: string) {
  await assertCodexPathLayout(codexHome)
  const agentsFile = await readOptionalCodexFile(join(codexHome, 'AGENTS.md'))
  const agentsResult = agentsFile ? removeCodexManagedBlock(agentsFile.content) : null

  const hooksFile = await readOptionalCodexFile(join(codexHome, 'hooks.json'))
  const hooksResult = hooksFile ? removeCodexHookRegistration(hooksFile.content, codexHome) : null

  const configFile = await readOptionalCodexFile(join(codexHome, 'config.toml'))
  parseCodexConfig(configFile?.content ?? null)
  const manifestFile = await readOptionalCodexFile(join(codexHome, CODEX_MODE_MANIFEST))
  const manifest = manifestFile ? parseCodexModeManifest(manifestFile.content) : null
  await validateUninstallOwnership(codexHome, manifest, Boolean(agentsResult?.changed || hooksResult?.changed))
  return { agentsFile, agentsResult, hooksFile, hooksResult, manifestFile, manifest }
}

async function validateUninstallOwnership(
  codexHome: string,
  manifest: CodexModeManifest | null,
  hasInstructions: boolean
): Promise<void> {
  const existingRuntimeFiles: string[] = []
  for (const relativePath of CODEX_MANAGED_FILES) {
    if (await readOptionalCodexFile(join(codexHome, relativePath))) existingRuntimeFiles.push(relativePath)
  }
  if (!manifest && (existingRuntimeFiles.length > 0 || hasInstructions)) {
    throw new Error('Codex mode ownership manifest is missing; reinstall Codex mode before uninstalling')
  }
  if (manifest) {
    for (const managedFile of manifest.files) {
      if (managedFile.original) await readCodexOriginalFile(codexHome, managedFile)
    }
  }
}

async function removeCodexAgents(codexHome: string, plan: UninstallPlan, changes: Changes): Promise<void> {
  const { agentsFile, agentsResult } = plan
  const { removed, skipped } = changes
  const agentsPath = join(codexHome, 'AGENTS.md')
  if (agentsFile && agentsResult?.changed) {
    if (agentsResult.content) {
      await writeCodexFileAtomic(agentsPath, agentsResult.content, agentsFile.mode)
    } else {
      await removeRegularCodexFile(agentsPath)
    }
    removed.push('~/.codex/AGENTS.md [CCG block]')
  } else if (agentsFile) {
    skipped.push('~/.codex/AGENTS.md (no CCG block)')
  }
}

async function removeCodexHooks(codexHome: string, plan: UninstallPlan, changes: Changes): Promise<void> {
  const { hooksFile, hooksResult } = plan
  const { removed, skipped } = changes
  const hooksPath = join(codexHome, 'hooks.json')
  if (hooksFile && hooksResult?.changed) {
    if (hooksResult.empty) {
      await removeRegularCodexFile(hooksPath)
    } else {
      await writeCodexFileAtomic(hooksPath, hooksResult.content, hooksFile.mode)
    }
    removed.push('~/.codex/hooks.json [CCG registration]')
  } else if (hooksFile) {
    skipped.push('~/.codex/hooks.json (no CCG registration)')
  }
}

async function removeCodexRuntime(codexHome: string, plan: UninstallPlan, changes: Changes): Promise<void> {
  const { manifest } = plan
  const { removed, skipped } = changes
  if (manifest) {
    for (const managedFile of manifest.files) {
      const action = await removeOrRestoreCodexManagedFile(codexHome, managedFile)
      if (action === 'removed') removed.push(`~/.codex/${managedFile.relativePath}`)
      else if (action === 'restored') removed.push(`~/.codex/${managedFile.relativePath} (original restored)`)
      else if (action === 'preserved') {
        skipped.push(`~/.codex/${managedFile.relativePath} (modified after installation; preserved)`)
      }
    }
  }
}

async function removeCodexSponsors(plan: UninstallPlan, changes: Changes): Promise<void> {
  const { manifest } = plan
  const { removed, skipped } = changes
  const sponsorApis = await removeSponsorsFromCodex(manifest?.sponsorProviderIds || [])
  if (!sponsorApis.success) throw new Error(sponsorApis.message)
  for (const result of sponsorApis.results) {
    if (result.status === 'removed') {
      removed.push(`~/.codex/config.toml [model_providers.${result.id}]`)
    } else if (result.status === 'preserved') {
      skipped.push(`~/.codex/config.toml [model_providers.${result.id}] (modified after installation; preserved)`)
    }
  }
}

async function finishCodexUninstall(
  codexHome: string,
  plan: UninstallPlan,
  backup: CodexBackup,
  changes: Changes
): Promise<void> {
  const { manifestFile } = plan
  const { removed, skipped } = changes
  if (manifestFile) {
    await removeRegularCodexFile(join(codexHome, CODEX_MODE_MANIFEST))
    removed.push('~/.codex/.ccg/codex-mode.json')
  }
  skipped.push('~/.codex/config.toml (user settings preserved)')
  skipped.push(`${backup.path.replace(homedir(), '~')} (pre-uninstall backup)`)
  for (const dir of ['hooks/ccg', 'agents', 'hooks']) {
    const dirPath = join(codexHome, dir)
    if ((await assertSafeCodexDirectory(dirPath)) && (await fs.readdir(dirPath)).length === 0) {
      await fs.remove(dirPath)
      removed.push(`~/.codex/${dir}/ (empty)`)
    }
  }
}

async function recoverCodexUninstall(
  codexHome: string,
  backup: CodexBackup | undefined,
  changes: Changes,
  error: unknown
): Promise<{ success: boolean; removed: string[]; skipped: string[] }> {
  const { removed, skipped } = changes
  if (!backup) return { success: false, removed, skipped: [...skipped, `Error: ${error}`] }
  try {
    await ensureCodexPathLayout(codexHome)
    await restoreCodexBackup(codexHome, backup)
    return {
      success: false,
      removed: [],
      skipped: [...skipped, `Error: ${error}`, `Original files restored from ${backup.path.replace(homedir(), '~')}`],
    }
  } catch (restoreError) {
    return {
      success: false,
      removed,
      skipped: [
        ...skipped,
        `Error: ${error}`,
        `Restore failed: ${restoreError}`,
        `Backup: ${backup.path.replace(homedir(), '~')}`,
      ],
    }
  }
}

/**
 * Remove only CCG-managed Codex content and preserve user-owned instructions and Hooks.
 */
export async function uninstallCodexMode(): Promise<{ success: boolean; removed: string[]; skipped: string[] }> {
  const codexHome = join(homedir(), '.codex')
  const changes: Changes = { removed: [], skipped: [] }
  let backup: CodexBackup | undefined
  try {
    if (!(await assertSafeCodexDirectory(codexHome))) {
      return { success: true, removed: changes.removed, skipped: ['~/.codex/ (not present)'] }
    }
    const plan = await prepareCodexUninstall(codexHome)
    await ensureCodexPathLayout(codexHome)
    backup = await createCodexBackup(codexHome)
    await removeCodexAgents(codexHome, plan, changes)
    await removeCodexHooks(codexHome, plan, changes)
    await removeCodexRuntime(codexHome, plan, changes)
    await removeCodexSponsors(plan, changes)
    await finishCodexUninstall(codexHome, plan, backup, changes)
    return { success: true, ...changes }
  } catch (error) {
    return recoverCodexUninstall(codexHome, backup, changes, error)
  }
}
