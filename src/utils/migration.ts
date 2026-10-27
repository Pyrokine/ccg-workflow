/**
 * Migration utilities for v1.4.0
 * Handles automatic migration from old directory structure to new one
 */

import fs from 'fs-extra'
import { homedir } from 'node:os'
import { join } from 'pathe'

export interface MigrationResult {
  success: boolean
  migratedFiles: string[]
  errors: string[]
  skipped: string[]
}

async function removeEmptyCcgDirectory(path: string, result: MigrationResult): Promise<void> {
  // Remove old directory (only if migration succeeded and it's empty)
  try {
    const remaining = await fs.readdir(path)
    if (remaining.length === 0) {
      await fs.remove(path)
      result.migratedFiles.push('Removed old ~/.ccg/ directory')
    } else {
      result.skipped.push('~/.ccg/ (not empty, keeping for safety)')
    }
  } catch (error) {
    // It's okay if we can't remove the old directory
    result.skipped.push(`~/.ccg/ (could not remove: ${error})`)
  }
}

async function migrateCcgDirectory(oldDir: string, newDir: string, result: MigrationResult): Promise<void> {
  if (!(await fs.pathExists(oldDir))) {
    result.skipped.push('~/.ccg/ (does not exist, nothing to migrate)')
    return
  }
  for (const file of await fs.readdir(oldDir)) {
    const srcFile = join(oldDir, file)
    const destFile = join(newDir, file)
    try {
      // Skip if destination already exists (don't overwrite)
      if (await fs.pathExists(destFile)) {
        result.skipped.push(`~/.ccg/${file} (already exists in new location)`)
        continue
      }
      // Copy file or directory
      await fs.copy(srcFile, destFile)
      result.migratedFiles.push(`~/.ccg/${file} → ~/.claude/.ccg/${file}`)
    } catch (error) {
      result.errors.push(`Failed to migrate ${file}: ${error}`)
      result.success = false
    }
  }
  await removeEmptyCcgDirectory(oldDir, result)
}

async function migratePrompts(oldDir: string, newDir: string, result: MigrationResult): Promise<void> {
  if (!(await fs.pathExists(oldDir))) {
    result.skipped.push('~/.claude/prompts/ccg/ (does not exist, nothing to migrate)')
    return
  }
  try {
    // Skip if destination already exists
    if (await fs.pathExists(newDir)) {
      result.skipped.push('~/.claude/prompts/ccg/ (already exists in new location)')
      return
    }
    await fs.copy(oldDir, newDir)
    result.migratedFiles.push('~/.claude/prompts/ccg/ → ~/.claude/.ccg/prompts/')
    // Remove old directory
    await fs.remove(oldDir)
    result.migratedFiles.push('Removed old ~/.claude/prompts/ccg/ directory')

    // Try to remove parent directory if empty
    const promptsParentDir = join(homedir(), '.claude', 'prompts')
    if ((await fs.readdir(promptsParentDir)).length === 0) {
      await fs.remove(promptsParentDir)
      result.migratedFiles.push('Removed empty ~/.claude/prompts/ directory')
    }
  } catch (error) {
    result.errors.push(`Failed to migrate prompts: ${error}`)
    result.success = false
  }
}

/**
 * Migrate from v1.3.x to v1.4.0
 *
 * Changes:
 * 1. ~/.ccg/ → ~/.claude/.ccg/
 * 2. ~/.claude/prompts/ccg/ → ~/.claude/.ccg/prompts/
 */
export async function migrateToV1_4_0(): Promise<MigrationResult> {
  const result: MigrationResult = { success: true, migratedFiles: [], errors: [], skipped: [] }
  const oldCcgDir = join(homedir(), '.ccg')
  const newCcgDir = join(homedir(), '.claude', '.ccg')
  const oldPromptsDir = join(homedir(), '.claude', 'prompts', 'ccg')
  const newPromptsDir = join(newCcgDir, 'prompts')
  try {
    // Ensure new config directory exists
    await fs.ensureDir(newCcgDir)
    // 1. Migrate ~/.ccg/ → ~/.claude/.ccg/
    await migrateCcgDirectory(oldCcgDir, newCcgDir, result)
    // 2. Migrate ~/.claude/prompts/ccg/ → ~/.claude/.ccg/prompts/
    await migratePrompts(oldPromptsDir, newPromptsDir, result)
  } catch (error) {
    result.errors.push(`Migration failed: ${error}`)
    result.success = false
  }
  return result
}

/**
 * Check if migration is needed
 */
export async function needsMigration(): Promise<boolean> {
  // If config.toml exists with a version >= 2.0.0, skip migration entirely.
  // This prevents V3 users from triggering v1.4.0 migration due to stale
  // directories or getCurrentVersion() returning 0.0.0 on Windows npx cache.
  try {
    const configPath = join(homedir(), '.claude', '.ccg', 'config.toml')
    if (await fs.pathExists(configPath)) {
      const content = await fs.readFile(configPath, 'utf-8')
      const versionMatch = content.match(/version\s*=\s*"([^"]+)"/)
      if (versionMatch) {
        const major = Number.parseInt(versionMatch[1].split('.')[0], 10)
        if (major >= 2) return false
      }
    }
  } catch {
    // Config read failed, fall through to directory checks
  }

  const oldCcgDir = join(homedir(), '.ccg')
  const oldPromptsDir = join(homedir(), '.claude', 'prompts', 'ccg')
  const oldConfigFile = join(homedir(), '.claude', 'commands', 'ccg', '_config.md')

  const hasOldCcgDir = await fs.pathExists(oldCcgDir)
  const hasOldPromptsDir = await fs.pathExists(oldPromptsDir)
  const hasOldConfigFile = await fs.pathExists(oldConfigFile)

  return hasOldCcgDir || hasOldPromptsDir || hasOldConfigFile
}
