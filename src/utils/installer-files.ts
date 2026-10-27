import { createHash } from 'node:crypto'
import fs from 'fs-extra'
import { dirname, join } from 'pathe'
import type { WorkflowConfig } from '../types'
import type { InstallContext } from './installer-context'
import { getLegacyCommandIds, getWorkflowById } from './installer-data'
import { injectConfigVariables, replaceHomePathsInTemplate } from './installer-template'

async function backupRoutingTemplate(ctx: InstallContext, destFile: string, content: string): Promise<void> {
  if (!(await fs.pathExists(destFile))) {
    return
  }

  const existing = await fs.readFile(destFile, 'utf-8')
  if (existing === content) {
    return
  }

  const backupRoot = join(ctx.installDir, '.ccg', 'backup', 'routing-templates')
  const relativePath = destFile.slice(ctx.installDir.length + 1)
  const manifestPath = join(backupRoot, 'manifest.json')
  const manifest = (await fs.pathExists(manifestPath))
    ? ((await fs.readJson(manifestPath)) as Record<
        string,
        { originalSha256: string; replacementSha256: string; snapshots?: string[] }
      >)
    : {}
  const existingSha256 = createHash('sha256').update(existing).digest('hex')
  const replacementSha256 = createHash('sha256').update(content).digest('hex')
  const previous = manifest[relativePath]

  if (previous?.replacementSha256 === existingSha256) {
    return
  }

  const primaryBackup = join(backupRoot, relativePath)
  const backupFile = previous ? `${primaryBackup}.${existingSha256.slice(0, 12)}` : primaryBackup
  await copyRoutingBackup(ctx, destFile, backupFile, backupRoot)

  if (previous) {
    previous.snapshots = [...new Set([...(previous.snapshots || []), existingSha256])]
  } else {
    manifest[relativePath] = { originalSha256: existingSha256, replacementSha256 }
  }
  await fs.writeJson(manifestPath, manifest, { spaces: 2 })
}

async function copyRoutingBackup(
  ctx: InstallContext,
  destFile: string,
  backupFile: string,
  backupRoot: string
): Promise<void> {
  if (!(await fs.pathExists(backupFile))) {
    await fs.ensureDir(dirname(backupFile))
    await fs.copy(destFile, backupFile, { overwrite: false })
    ctx.result.backupPath = backupRoot
    ctx.result.backedUpFiles ??= []
    ctx.result.backedUpFiles.push(backupFile)
  }
}

/**
 * Copy .md templates from srcDir → destDir with optional variable injection.
 * Returns list of installed file stems (filename without .md).
 */
export async function copyMdTemplates(
  ctx: InstallContext,
  srcDir: string,
  destDir: string,
  options: { inject?: boolean; backupExisting?: boolean } = {}
): Promise<string[]> {
  const installed: string[] = []
  if (!(await fs.pathExists(srcDir))) {
    // Log warning — helps diagnose "0 commands installed" issues
    console.error(`[CCG] Template source directory not found: ${srcDir}`)
    return installed
  }

  await fs.ensureDir(destDir)
  const files = await fs.readdir(srcDir)
  for (const file of files) {
    if (!file.endsWith('.md')) continue
    const sourceFile = join(srcDir, file)
    const destFile = join(destDir, file)
    if (ctx.force || !(await fs.pathExists(destFile))) {
      let content = await fs.readFile(sourceFile, 'utf-8')
      if (options.inject) content = injectConfigVariables(content, ctx.config)
      content = replaceHomePathsInTemplate(content, ctx.installDir)

      if (options.backupExisting) {
        await backupRoutingTemplate(ctx, destFile, content)
      }

      await fs.writeFile(destFile, content, 'utf-8')
      installed.push(file.replace('.md', ''))
    }
  }
  return installed
}

/**
 * Install slash command .md files from templates/commands/
 */
export async function installCommandFiles(
  ctx: InstallContext,
  workflowIds: string[],
  options: { backupExisting?: boolean } = {}
): Promise<void> {
  const legacyIds = new Set(getLegacyCommandIds())

  for (const workflowId of workflowIds) {
    const workflow = getWorkflowById(workflowId)
    if (!workflow) {
      ctx.result.errors.push(`Unknown workflow: ${workflowId}`)
      continue
    }

    for (const cmd of workflow.commands) {
      const srcSubdir = legacyIds.has(workflowId) ? 'commands-legacy' : 'commands'
      await installWorkflowCommand(ctx, workflow, cmd, srcSubdir, options)
    }
  }
}

async function installWorkflowCommand(
  ctx: InstallContext,
  workflow: WorkflowConfig,
  cmd: string,
  srcSubdir: string,
  options: { backupExisting?: boolean }
): Promise<void> {
  const commandsDir = join(ctx.installDir, 'commands', 'ccg')
  // Route to correct source directory: core → commands/, legacy → commands-legacy/
  const srcFile = join(ctx.templateDir, srcSubdir, `${cmd}.md`)
  const destFile = join(commandsDir, `${cmd}.md`)

  try {
    if (await fs.pathExists(srcFile)) {
      if (ctx.force || !(await fs.pathExists(destFile))) {
        let content = await fs.readFile(srcFile, 'utf-8')
        content = injectConfigVariables(content, ctx.config)
        content = replaceHomePathsInTemplate(content, ctx.installDir)

        if (options.backupExisting) {
          await backupRoutingTemplate(ctx, destFile, content)
        }

        await fs.writeFile(destFile, content, 'utf-8')
      }
      ctx.result.installedCommands.push(cmd)
    } else {
      const placeholder = `---
description: "${workflow.descriptionEn}"
---

# /ccg:${cmd}

${workflow.description}

> This command is part of CCG multi-model collaboration system.
`
      await fs.writeFile(destFile, placeholder, 'utf-8')
      ctx.result.installedCommands.push(cmd)
    }
  } catch (error) {
    ctx.result.errors.push(`Failed to install ${cmd}: ${error}`)
    ctx.result.success = false
  }
}

/**
 * Install agent .md files from templates/commands/agents/
 */
export async function installAgentFiles(ctx: InstallContext): Promise<void> {
  try {
    await copyMdTemplates(ctx, join(ctx.templateDir, 'commands', 'agents'), join(ctx.installDir, 'agents', 'ccg'), {
      inject: true,
    })
  } catch (error) {
    ctx.result.errors.push(`Failed to install agents: ${error}`)
    ctx.result.success = false
  }
}

/**
 * Install expert prompt .md files for supported wrapper backends.
 */
export async function installPromptFiles(ctx: InstallContext): Promise<void> {
  const promptsTemplateDir = join(ctx.templateDir, 'prompts')
  const configuredModels = new Set([
    ...ctx.config.routing.frontend.models,
    ...ctx.config.routing.backend.models,
    'claude',
  ])
  const promptsDir = join(ctx.installDir, '.ccg', 'prompts')
  if (!(await fs.pathExists(promptsTemplateDir))) {
    ctx.result.errors.push(`Prompts template directory not found: ${promptsTemplateDir}`)
    return
  }

  for (const model of ['codex', 'claude', 'antigravity', 'grok', 'kimi', 'opencode']) {
    if (!configuredModels.has(model) && model !== 'claude') {
      continue
    }
    try {
      const installed = await copyMdTemplates(ctx, join(promptsTemplateDir, model), join(promptsDir, model))
      for (const name of installed) {
        ctx.result.installedPrompts.push(`${model}/${name}`)
      }
    } catch (error) {
      ctx.result.errors.push(`Failed to install ${model} prompts: ${error}`)
      ctx.result.success = false
    }
  }
}

/**
 * Install engine files from templates/engine/ → ~/.claude/.ccg/engine/
 * Includes model-router.md, phase-guide.md, and strategy files.
 * All .md files receive variable injection + path replacement.
 */
export async function installEngineFiles(
  ctx: InstallContext,
  options: { backupExisting?: boolean } = {}
): Promise<void> {
  const engineSrcDir = join(ctx.templateDir, 'engine')
  if (!(await fs.pathExists(engineSrcDir))) return

  const engineDestDir = join(ctx.installDir, '.ccg', 'engine')

  try {
    // Copy top-level engine .md files (model-router.md, phase-guide.md)
    await copyMdTemplates(ctx, engineSrcDir, engineDestDir, { inject: true, ...options })

    // Copy strategy files
    const strategiesSrc = join(engineSrcDir, 'strategies')
    const strategiesDest = join(engineDestDir, 'strategies')
    if (await fs.pathExists(strategiesSrc)) {
      await copyMdTemplates(ctx, strategiesSrc, strategiesDest, { inject: true, ...options })
    }
  } catch (error) {
    ctx.result.errors.push(`Failed to install engine files: ${error}`)
  }
}
