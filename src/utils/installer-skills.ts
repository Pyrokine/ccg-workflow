import fs from 'fs-extra'
import { basename, join } from 'pathe'
import type { InstallContext } from './installer-context'
import { getAllCommandIds } from './installer-data'
import { copyMdTemplates } from './installer-files'
import { replaceHomePathsInTemplate } from './installer-template'
import { collectSkills, installSkillCommands } from './skill-registry'
import { installedNames, removeSkills, syncSkills } from './skill-manager'
import { activateNativeSkills } from './skill-activation'

/**
 * Recursively collect skill names (directories containing SKILL.md, excludes root).
 * Used by both install (count) and uninstall (list names).
 */
export async function collectSkillNames(dir: string, depth = 0): Promise<string[]> {
  const names: string[] = []
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory()) {
        names.push(...(await collectSkillNames(join(dir, entry.name), depth + 1)))
      } else if (entry.name === 'SKILL.md' && depth > 0) {
        names.push(basename(dir))
      }
    }
  } catch (error) {
    // Only suppress ENOENT (dir not found); log other errors that indicate real problems
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      console.error(`[CCG] Failed to read skills directory ${dir}: ${code || error}`)
    }
  }
  return names
}

/**
 * Remove a directory and collect .md file stems. Returns [] if dir doesn't exist.
 */
export async function removeDirCollectMdNames(dir: string): Promise<string[]> {
  if (!(await fs.pathExists(dir))) return []
  const files = await fs.readdir(dir)
  const names = files.filter((f) => f.endsWith('.md')).map((f) => f.replace('.md', ''))
  await fs.remove(dir)
  return names
}

/**
 * Install skill files from templates/skills/ → ~/.claude/skills/ccg/
 * Includes v1.7.73 legacy layout migration.
 */
export async function installSkillFiles(ctx: InstallContext): Promise<void> {
  const skillsTemplateDir = join(ctx.templateDir, 'skills')
  const skillsDestDir = join(ctx.installDir, 'skills', 'ccg')

  // Report error instead of silently returning when template dir is missing
  if (!(await fs.pathExists(skillsTemplateDir))) {
    ctx.result.errors.push(`Skills template directory not found: ${skillsTemplateDir}`)
    return
  }

  try {
    // Migration: move old v1.7.73 layout into skills/ccg/ namespace
    const nativeOptions = {
      target: 'claude' as const,
      nativeDir: join(ctx.installDir, 'skills'),
      storeDir: join(ctx.installDir, '.ccg-skills'),
    }
    if (ctx.config.skillsMode === 'legacy') {
      const selected = await installedNames(nativeOptions)
      if (selected.length) await removeSkills(selected, nativeOptions)
    }
    if (ctx.config.skillsProfile !== undefined) {
      const selected = await syncSkills({
        ...nativeOptions,
        names: ctx.config.skillsProfile,
        templatesDir: skillsTemplateDir,
      })
      ctx.result.installedSkills = selected.length
      return
    }
    await migrateLegacySkills(ctx, skillsDestDir)
    await copyLegacySkills(ctx, skillsTemplateDir, skillsDestDir)
  } catch (error) {
    ctx.result.errors.push(`Failed to install skills: ${error}`)
    ctx.result.success = false
  }
}

async function migrateLegacySkills(ctx: InstallContext, skillsDestDir: string): Promise<void> {
  const oldSkillsRoot = join(ctx.installDir, 'skills')
  const ccgLegacyItems = ['tools', 'orchestration', 'SKILL.md', 'run_skill.js']
  const needsMigration = !(await fs.pathExists(skillsDestDir)) && (await fs.pathExists(join(oldSkillsRoot, 'tools')))
  if (needsMigration) {
    await fs.ensureDir(skillsDestDir)
    for (const item of ccgLegacyItems) {
      const oldPath = join(oldSkillsRoot, item)
      const newPath = join(skillsDestDir, item)
      if (await fs.pathExists(oldPath)) {
        try {
          await fs.move(oldPath, newPath, { overwrite: true })
        } catch (moveErr) {
          // Windows: file locking can cause move to fail — log but continue
          ctx.result.errors.push(`Skills migration: failed to move ${item}: ${moveErr}`)
        }
      }
    }
  }
}

async function replacePathsInDir(ctx: InstallContext, dir: string): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      await replacePathsInDir(ctx, fullPath)
    } else if (entry.name.endsWith('.md')) {
      const content = await fs.readFile(fullPath, 'utf-8')
      const processed = replaceHomePathsInTemplate(content, ctx.installDir)
      if (processed !== content) {
        await fs.writeFile(fullPath, processed, 'utf-8')
      }
    }
  }
}

async function copyLegacySkills(ctx: InstallContext, skillsTemplateDir: string, skillsDestDir: string): Promise<void> {
  // Recursive copy: preserves full directory tree
  // Always overwrite to ensure fresh install gets all files
  await fs.copy(skillsTemplateDir, skillsDestDir, {
    overwrite: true,
    errorOnExist: false,
  })

  // Drop red-team / pentest notes even when installing from a git checkout.
  // They are also excluded from local tarballs because security scanners may
  // flag the reference content. Users who need them can copy from GitHub.
  const securityDir = join(skillsDestDir, 'domains', 'security')
  if (await fs.pathExists(securityDir)) {
    await fs.remove(securityDir)
  }

  await replacePathsInDir(ctx, skillsDestDir)

  // Post-copy validation: verify at least one SKILL.md was actually copied
  const installedSkills = await collectSkillNames(skillsDestDir)
  ctx.result.installedSkills = installedSkills.length

  if (installedSkills.length === 0) {
    ctx.result.errors.push(
      `Skills copy completed but no SKILL.md found in ${skillsDestDir}. ` +
        `Possible cause: file locking (antivirus), permission denied, or path too long. ` +
        `Try running as administrator or disabling antivirus real-time scanning temporarily.`
    )
  }
}

async function removeRetiredImpeccableCommands(skillsTemplateDir: string, commandsDir: string): Promise<void> {
  const retired = collectSkills(skillsTemplateDir).filter(
    (skill) => skill.category === 'impeccable' && !skill.userInvocable
  )
  for (const skill of retired) {
    const commandPath = join(commandsDir, `${skill.name}.md`)
    if (!(await fs.pathExists(commandPath))) continue

    const content = (await fs.readFile(commandPath, 'utf-8')).replaceAll('\\', '/')
    const relPath = skill.relPath.replaceAll('\\', '/')
    if (content.includes(`/skills/ccg/${relPath}/SKILL.md`)) {
      await fs.remove(commandPath)
    }
  }
}

/**
 * Auto-generate slash commands for user-invocable skills via Skill Registry.
 *
 * Scans templates/skills/ for SKILL.md files with `user-invocable: true` frontmatter,
 * then generates ~/.claude/commands/ccg/{name}.md for each — SKIPPING any name that
 * already exists in installer-data.ts to avoid conflicts with complex multi-model commands.
 */
export async function installSkillGeneratedCommands(ctx: InstallContext): Promise<void> {
  if (ctx.config.skillsProfile !== undefined) return
  const skillsTemplateDir = join(ctx.templateDir, 'skills')
  const skillsInstallDir = join(ctx.installDir, 'skills', 'ccg')
  const commandsDir = join(ctx.installDir, 'commands', 'ccg')

  if (!(await fs.pathExists(skillsTemplateDir))) return

  try {
    await removeRetiredImpeccableCommands(skillsTemplateDir, commandsDir)
    const existingCommandNames = new Set(getAllCommandIds())

    const skipCategories: import('./skill-registry').SkillCategory[] = []
    if (ctx.config.skipImpeccable) {
      skipCategories.push('impeccable')
    }

    const generated = await installSkillCommands(
      skillsTemplateDir,
      skillsInstallDir,
      commandsDir,
      existingCommandNames,
      skipCategories
    )

    if (generated.length > 0) {
      ctx.result.installedCommands.push(...generated)
      ctx.result.installedSkillCommands = generated.length
    }
  } catch (error) {
    // Non-fatal: skill command generation failure shouldn't block installation
    ctx.result.errors.push(`Skill Registry command generation warning: ${error}`)
  }
}

/**
 * Install rule .md files from templates/rules/ → ~/.claude/rules/
 */
export async function installRuleFiles(ctx: InstallContext): Promise<void> {
  try {
    if (ctx.config.skillsProfile !== undefined) {
      const notes = await activateNativeSkills({ installDir: ctx.installDir, names: ctx.config.skillsProfile })
      if (notes.length) throw new Error(notes.join('\n'))
      ctx.result.installedRules = true
      return
    }
    const installed = await copyMdTemplates(ctx, join(ctx.templateDir, 'rules'), join(ctx.installDir, 'rules'))
    if (installed.length > 0) ctx.result.installedRules = true
  } catch (error) {
    ctx.result.errors.push(`Failed to install rules: ${error}`)
  }
}
