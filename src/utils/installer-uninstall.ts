import { rename } from 'node:fs/promises'
import fs from 'fs-extra'
import { join } from 'pathe'
import { installedNames, removeSkills } from './skill-manager'
import { collectSkillNames, removeDirCollectMdNames } from './installer-skills'
import { isCcgHookCommand } from './installer-hooks'

export interface UninstallResult {
  success: boolean
  removedCommands: string[]
  removedPrompts: string[]
  removedAgents: string[]
  removedSkills: string[]
  removedRules: boolean
  removedHooks: boolean
  removedBin: boolean
  errors: string[]
}

async function removeNativeSkills(installDir: string, result: UninstallResult): Promise<void> {
  try {
    const skillOptions = {
      target: 'claude' as const,
      nativeDir: join(installDir, 'skills'),
      storeDir: join(installDir, '.ccg-skills'),
    }
    const selected = await installedNames(skillOptions)
    if (selected.length) await removeSkills(selected, skillOptions)
    result.removedSkills.push(...selected.map((name) => `ccg-${name}`))
  } catch (error) {
    result.errors.push(`Failed to remove managed native skills: ${error}`)
    result.success = false
  }
}

async function removeCommandDirectories(installDir: string, result: UninstallResult): Promise<void> {
  const directories = [
    ['commands', 'removedCommands'],
    ['agents', 'removedAgents'],
  ] as const
  for (const [name, key] of directories) {
    try {
      result[key] = await removeDirCollectMdNames(join(installDir, name, 'ccg'))
    } catch (error) {
      result.errors.push(`Failed to remove ${name} directory: ${error}`)
      result.success = false
    }
  }
}

async function removeLegacySkills(installDir: string, result: UninstallResult): Promise<void> {
  // Remove CCG skills directory only (skills/ccg/) — preserves user's own skills
  const skillsDir = join(installDir, 'skills', 'ccg')
  if (!(await fs.pathExists(skillsDir))) return
  try {
    result.removedSkills.push(...(await collectSkillNames(skillsDir)))
    await fs.remove(skillsDir)
  } catch (error) {
    result.errors.push(`Failed to remove skills: ${error}`)
    result.success = false
  }
}

async function removeWorkflowRules(installDir: string, result: UninstallResult): Promise<void> {
  const rulesDir = join(installDir, 'rules')
  if (!(await fs.pathExists(rulesDir))) return
  try {
    for (const ruleFile of ['ccg-skills.md', 'ccg-grok-search.md', 'ccg-skill-routing.md']) {
      const rulePath = join(rulesDir, ruleFile)
      if (await fs.pathExists(rulePath)) {
        await fs.remove(rulePath)
        result.removedRules = true
      }
    }
  } catch (error) {
    result.errors.push(`Failed to remove rules: ${error}`)
  }
}

function removeHookEventCommands(eventHooks: Record<string, unknown>[]): {
  entries: Record<string, unknown>[]
  changed: boolean
} {
  let changed = false
  const entries = eventHooks
    .map((entry) => {
      const commands = Array.isArray(entry.hooks) ? entry.hooks : []
      const keptCommands = commands.filter((hook) => !isCcgHookCommand(hook?.command))
      if (keptCommands.length !== commands.length) changed = true
      return keptCommands.length > 0 ? { ...entry, hooks: keptCommands } : null
    })
    .filter((entry) => entry !== null)
  return { entries, changed }
}

function pruneHookSettings(settings: Record<string, unknown>): boolean {
  const hooks =
    settings.hooks && typeof settings.hooks === 'object' ? (settings.hooks as Record<string, unknown>) : null
  if (!hooks) return false
  let changed = false
  for (const event of Object.keys(hooks)) {
    const eventHooks = Array.isArray(hooks[event]) ? hooks[event] : []
    const kept = removeHookEventCommands(eventHooks as Record<string, unknown>[])
    if (kept.changed) changed = true
    if (kept.entries.length > 0) {
      hooks[event] = kept.entries
    } else {
      delete hooks[event]
      if (eventHooks.length > 0) changed = true
    }
  }
  if (Object.keys(hooks).length === 0) {
    delete settings.hooks
    changed = true
  }
  return changed
}

async function deregisterWorkflowHooks(installDir: string, result: UninstallResult): Promise<void> {
  const settingsPath = join(installDir, 'settings.json')
  if (!(await fs.pathExists(settingsPath))) return
  try {
    const settings = await fs.readJson(settingsPath)
    if (!pruneHookSettings(settings)) return
    const tempSettingsPath = `${settingsPath}.ccg-uninstall-${process.pid}.tmp`
    try {
      await fs.writeFile(tempSettingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf-8')
      await rename(tempSettingsPath, settingsPath)
    } finally {
      await fs.remove(tempSettingsPath).catch(() => undefined)
    }
    result.removedHooks = true
  } catch (error) {
    result.errors.push(`Failed to deregister hooks from settings.json: ${error}`)
  }
}

async function removeWorkflowHooks(installDir: string, result: UninstallResult): Promise<void> {
  const hooksDir = join(installDir, 'hooks', 'ccg')
  if (await fs.pathExists(hooksDir)) {
    try {
      await fs.remove(hooksDir)
      result.removedHooks = true
    } catch (error) {
      result.errors.push(`Failed to remove hooks: ${error}`)
      result.success = false
    }
  }
  await deregisterWorkflowHooks(installDir, result)
}

async function removeWorkflowBinary(installDir: string, result: UninstallResult): Promise<void> {
  const binDir = join(installDir, 'bin')
  if (!(await fs.pathExists(binDir))) return
  try {
    const wrapperName = process.platform === 'win32' ? 'codeagent-wrapper.exe' : 'codeagent-wrapper'
    const wrapperPath = join(binDir, wrapperName)
    if (await fs.pathExists(wrapperPath)) {
      await fs.remove(wrapperPath)
      result.removedBin = true
    }
  } catch (error) {
    result.errors.push(`Failed to remove binary: ${error}`)
    result.success = false
  }
}

async function removeWorkflowConfig(installDir: string, result: UninstallResult): Promise<void> {
  const ccgConfigDir = join(installDir, '.ccg')
  if (!(await fs.pathExists(ccgConfigDir))) return
  try {
    await fs.remove(ccgConfigDir)
    result.removedPrompts.push('ALL_PROMPTS_AND_CONFIGS')
  } catch (error) {
    result.errors.push(`Failed to remove .ccg directory: ${error}`)
  }
}

/**
 * Uninstall workflows by removing their command files.
 * @param options.preserveBinary — when true, skip binary removal (used during update)
 */
export async function uninstallWorkflows(
  installDir: string,
  options?: { preserveBinary?: boolean }
): Promise<UninstallResult> {
  const result: UninstallResult = {
    success: true,
    removedCommands: [],
    removedPrompts: [],
    removedAgents: [],
    removedSkills: [],
    removedRules: false,
    removedHooks: false,
    removedBin: false,
    errors: [],
  }
  await removeNativeSkills(installDir, result)
  await removeCommandDirectories(installDir, result)
  await removeLegacySkills(installDir, result)
  await removeWorkflowRules(installDir, result)
  await removeWorkflowHooks(installDir, result)
  // Preserve the binary during updates to avoid an unnecessary re-download.
  if (!options?.preserveBinary) await removeWorkflowBinary(installDir, result)
  await removeWorkflowConfig(installDir, result)
  return result
}
