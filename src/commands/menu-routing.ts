import ansis from 'ansis'
import inquirer from 'inquirer'
import { homedir } from 'node:os'
import ora from 'ora'
import { join } from 'pathe'
import { i18n } from '../i18n'
import type { CcgConfig, ModelRouting, ModelType } from '../types'
import { createDefaultConfig, normalizeRoutingForInstall, readCcgConfig, writeCcgConfig } from '../utils/config'
import { getAllCommandIds, syncRoutingTemplates } from '../utils/installer'
import { modelChoices, promptExecutionModels } from './model-prompts'
import type { ExecutionModels } from './model-prompts'

function showCurrentRouting(routing: ModelRouting): void {
  console.log()
  console.log(ansis.cyan.bold(`  ${i18n.t('init:model.title')}`))
  console.log()
  console.log(ansis.yellow(`  ${i18n.t('init:model.geminiDisabled')}`))
  console.log()
  console.log(ansis.gray(`  ${i18n.t('init:model.currentRouting')}:`))
  console.log(`  ${ansis.cyan(`${i18n.t('init:model.currentFrontend')}:`)} ${ansis.green(routing.frontend.primary)}`)
  console.log(`  ${ansis.cyan(`${i18n.t('init:model.currentBackend')}:`)}  ${ansis.blue(routing.backend.primary)}`)
  for (const [key, model] of [
    ['currentGrok', routing.grokModel],
    ['currentKimi', routing.kimiModel],
    ['currentOpencode', routing.opencodeModel],
  ]) {
    if (model) console.log(`  ${ansis.cyan(`${i18n.t(`init:model.${key}`)}:`)} ${ansis.green(model)}`)
  }
  showPureClaude(routing.frontend.primary, routing.backend.primary)
  console.log()
}

function showPureClaude(frontend: ModelType, backend: ModelType): void {
  if (frontend === 'claude' && backend === 'claude') {
    console.log(ansis.cyan(`  ${i18n.t('init:model.pureClaudeCode')}`))
  }
}

async function promptRouteModel(side: 'Frontend' | 'Backend', current: ModelType): Promise<ModelType> {
  const name = `selected${side}`
  const answer = await inquirer.prompt<Record<string, ModelType>>([
    {
      type: 'select',
      name,
      message: i18n.t(`init:model.select${side}`),
      choices: modelChoices(),
      default: current,
    },
  ])
  return answer[name]
}

function selectedRouting(
  current: ModelRouting,
  frontend: ModelType,
  backend: ModelType,
  models: ExecutionModels
): ModelRouting {
  return {
    frontend: { models: [frontend], primary: frontend, strategy: 'fallback' },
    backend: { models: [backend], primary: backend, strategy: 'fallback' },
    review: current.review,
    ...(current.proxy ? { proxy: current.proxy } : {}),
    ...(models.grokModel ? { grokModel: models.grokModel } : {}),
    ...(models.kimiModel ? { kimiModel: models.kimiModel } : {}),
    ...(models.opencodeModel ? { opencodeModel: models.opencodeModel } : {}),
    mode: current.mode,
  }
}

function routingUnchanged(current: ModelRouting, selected: ModelRouting): boolean {
  const modelFields = ['grokModel', 'kimiModel', 'opencodeModel'] as const
  return (
    selected.frontend.primary === current.frontend.primary &&
    selected.backend.primary === current.backend.primary &&
    modelFields.every((key) => (selected[key] || '') === (current[key] || ''))
  )
}

function routingInstallOptions(config: CcgConfig) {
  return {
    routing: config.routing ?? normalizeRoutingForInstall(undefined),
    liteMode: config.performance?.liteMode,
    mcpProvider: config.mcp?.provider,
    skipImpeccable: config.performance?.skipImpeccable,
    skillsProfile: config.performance?.skillsProfile,
    skillsMode: config.performance?.skillsMode,
  }
}

async function refreshRoutingConfig(config: CcgConfig): Promise<void> {
  const spinner = ora(i18n.t('init:model.reinstalling')).start()
  const installedWorkflows = config.workflows?.installed?.length ? config.workflows.installed : getAllCommandIds()
  try {
    const result = await syncRoutingTemplates(
      installedWorkflows,
      join(homedir(), '.claude'),
      routingInstallOptions(config)
    )
    if (!result.success) {
      spinner.fail(i18n.t('init:model.reinstallFailed'))
      for (const error of result.errors) console.log(ansis.red(`  ${error}`))
    } else {
      await writeCcgConfig(config)
      spinner.succeed(i18n.t('init:model.reinstallDone'))
      console.log(ansis.green(`  ✓ ${i18n.t('init:model.routingUpdated')}`))
      if (result.backedUpFiles?.length) {
        console.log(
          ansis.gray(
            `  ${i18n.t('init:model.routingBackup', { count: result.backedUpFiles.length, path: result.backupPath })}`
          )
        )
      }
    }
  } catch {
    spinner.fail(i18n.t('init:model.reinstallFailed'))
  }
  console.log(ansis.gray(`  ${i18n.t('common:restartToApply')}`))
}

export async function configModelRouting(): Promise<void> {
  let config = await readCcgConfig()
  const current = normalizeRoutingForInstall(config?.routing)
  showCurrentRouting(current)
  const frontend = await promptRouteModel('Frontend', current.frontend.primary)
  const backend = await promptRouteModel('Backend', current.backend.primary)
  showPureClaude(frontend, backend)
  const models = {
    grokModel: current.grokModel || '',
    kimiModel: current.kimiModel || '',
    opencodeModel: current.opencodeModel || '',
  }
  await promptExecutionModels(models, new Set([frontend, backend]), i18n.language !== 'en')
  const routing = selectedRouting(current, frontend, backend, models)
  if (config && routingUnchanged(current, routing)) {
    console.log(ansis.gray(`  ${i18n.t('common:configNotModified')}`))
    return
  }
  if (config) config.routing = routing
  else {
    config = createDefaultConfig({
      language: i18n.language === 'en' ? 'en' : 'zh-CN',
      routing,
      installedWorkflows: getAllCommandIds(),
      mcpProvider: 'fast-context',
      liteMode: true,
    })
  }
  await refreshRoutingConfig(config)
}
