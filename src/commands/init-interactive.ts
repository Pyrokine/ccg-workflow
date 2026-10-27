import ansis from 'ansis'
import inquirer from 'inquirer'
import { i18n } from '../i18n'
import type { InitState } from './init-state'
import type { StepId, SummaryAction } from './init-navigation'
import { runApiStep, runModelStep, runPerfStep } from './init-prompts'
import { runMcpStep } from './init-mcp'

const STEP_RUNNERS = { api: runApiStep, model: runModelStep, mcp: runMcpStep, perf: runPerfStep }

export const runSummaryStep = async (state: InitState, workflowsCount: number): Promise<SummaryAction> => {
  showInitSummary(state, workflowsCount)

  const { action } = await inquirer.prompt([
    {
      type: 'select',
      name: 'action',
      message: i18n.t('init:summaryMenu.prompt'),
      choices: [
        { name: `${ansis.green('✓')} ${i18n.t('init:summaryMenu.confirm')}`, value: 'confirm' },
        new inquirer.Separator(),
        { name: `${ansis.cyan('✎')} ${i18n.t('init:summaryMenu.editApi')}`, value: 'api' },
        { name: `${ansis.cyan('✎')} ${i18n.t('init:summaryMenu.editModel')}`, value: 'model' },
        { name: `${ansis.cyan('✎')} ${i18n.t('init:summaryMenu.editMcp')}`, value: 'mcp' },
        { name: `${ansis.cyan('✎')} ${i18n.t('init:summaryMenu.editPerf')}`, value: 'perf' },
        new inquirer.Separator(),
        { name: `${ansis.red('×')} ${i18n.t('init:summaryMenu.cancel')}`, value: 'cancel' },
      ],
      default: 'confirm',
    },
  ])
  return action as SummaryAction
}

export async function runInitSteps(state: InitState): Promise<boolean> {
  const stepOrder: StepId[] = ['api', 'model', 'mcp', 'perf']
  let stepIdx = 0
  let jumpingToSummary = false

  while (true) {
    if (stepIdx < stepOrder.length) {
      const stepId = stepOrder[stepIdx]
      const canGoBack = stepIdx > 0

      const result = await STEP_RUNNERS[stepId](state, canGoBack)

      if (result === 'cancel') {
        console.log(ansis.yellow(i18n.t('init:installCancelled')))
        return false
      }
      if (result === 'back') {
        stepIdx = Math.max(0, stepIdx - 1)
        continue
      }

      // result === 'next'
      if (jumpingToSummary) {
        // Returned from a summary-triggered jump — go back to summary
        jumpingToSummary = false
        stepIdx = stepOrder.length
      } else {
        stepIdx++
      }
    } else {
      // Summary stage
      const summaryAction = await runSummaryStep(state, state.selectedWorkflows.length)
      if (summaryAction === 'confirm') {
        break
      }
      if (summaryAction === 'cancel') {
        console.log(ansis.yellow(i18n.t('init:installCancelled')))
        return false
      }
      // Jump to the requested step, then return to summary
      jumpingToSummary = true
      stepIdx = stepOrder.indexOf(summaryAction)
    }
  }
  return true
}

export function showNoninteractiveSummary(state: InitState): void {
  console.log()
  console.log(ansis.yellow('━'.repeat(50)))
  console.log(ansis.bold(`  ${i18n.t('init:summary.title')}`))
  console.log()
  const fmName = state.frontendModels[0].charAt(0).toUpperCase() + state.frontendModels[0].slice(1)
  const bmName = state.backendModels[0].charAt(0).toUpperCase() + state.backendModels[0].slice(1)
  console.log(
    `  ${ansis.cyan(i18n.t('init:summary.modelRouting'))}  ${ansis.green(fmName)} (Frontend) + ` +
      `${ansis.blue(bmName)} (Backend)`
  )
  console.log(
    `  ${ansis.cyan(i18n.t('init:summary.commandCount'))}  ${ansis.yellow(state.selectedWorkflows.length.toString())}`
  )
  console.log(ansis.yellow('━'.repeat(50)))
  console.log()
}

function showInitSummary(state: InitState, workflowsCount: number): void {
  console.log()
  console.log(ansis.yellow('━'.repeat(50)))
  console.log(ansis.bold(`  ${i18n.t('init:summary.title')}`))
  console.log()
  const fmName = state.frontendModels[0].charAt(0).toUpperCase() + state.frontendModels[0].slice(1)
  const bmName = state.backendModels[0].charAt(0).toUpperCase() + state.backendModels[0].slice(1)
  const apiLabel = apiSummary(state)
  console.log(`  ${ansis.cyan(i18n.t('init:summary.apiProvider'))}  ${apiLabel}`)
  console.log(
    `  ${ansis.cyan(i18n.t('init:summary.modelRouting'))}  ${ansis.green(fmName)} (Frontend) + ` +
      `${ansis.blue(bmName)} (Backend)`
  )
  console.log(`  ${ansis.cyan(i18n.t('init:summary.commandCount'))}  ${ansis.yellow(workflowsCount.toString())}`)
  if (state.frontendModels.includes('opencode') || state.backendModels.includes('opencode')) {
    console.log(`  ${ansis.cyan('OpenCode model:')} ${ansis.gray(state.opencodeModel || 'OpenCode default')}`)
  }
  const skillsSummary =
    state.skillsProfile === undefined ? 'Legacy installation' : state.skillsProfile.join(', ') || 'None'
  console.log(`  ${ansis.cyan('Native Skills:')} ${skillsSummary}`)
  const mcpSummary = summarizeMcp(state)
  console.log(`  ${ansis.cyan(i18n.t('init:summary.mcpTool'))}      ${mcpSummary}`)
  const webUiSummary = state.liteMode
    ? ansis.gray(i18n.t('init:summary.disabled'))
    : ansis.green(i18n.t('init:summary.enabled'))
  console.log(`  ${ansis.cyan(i18n.t('init:summary.webUI'))}        ${webUiSummary}`)
  if (state.wantGrokSearch) {
    const grokSummary = state.tavilyKey ? ansis.green('✓') : ansis.yellow(`(${i18n.t('init:summary.pendingConfig')})`)
    console.log(`  ${ansis.cyan('grok-search')}    ${grokSummary}`)
  }
  console.log(ansis.yellow('━'.repeat(50)))
  console.log()
}

function apiSummary(state: InitState): string {
  if (state.apiUrl && state.apiKey) return `${ansis.green('●')} ${state.apiUrl} ${ansis.gray('+ ***')}`
  if (state.apiUrl) return `${ansis.green('●')} ${state.apiUrl}`
  return `${ansis.gray('○')} ${i18n.t('init:summary.apiSelfManaged')}`
}

function summarizeMcp(state: InitState): string {
  if (state.mcpProvider === 'fast-context') return ansis.green('fast-context')
  if (state.mcpProvider === 'ace-tool' || state.mcpProvider === 'ace-tool-rs')
    return state.aceToolToken
      ? ansis.green(state.mcpProvider)
      : ansis.yellow(`${state.mcpProvider} (${i18n.t('init:summary.pendingConfig')})`)
  if (state.mcpProvider === 'contextweaver')
    return state.contextWeaverApiKey
      ? ansis.green('contextweaver')
      : ansis.yellow(`contextweaver (${i18n.t('init:summary.pendingConfig')})`)
  return ansis.gray(i18n.t('init:summary.skipped'))
}
