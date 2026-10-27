import ansis from 'ansis'
import inquirer from 'inquirer'
import { i18n } from '../i18n'
import type { ModelType } from '../types'
import {
  getAllCommandIds,
  getCoreCommandIds,
  getSponsor,
  promptSponsorInit,
  sponsorInquirerChoices,
} from '../utils/installer'
import { modelChoices, promptExecutionModels } from './model-prompts'
import type { InitState } from './init-state'
import { BACK_SENTINEL, CANCEL_SENTINEL, navSentinels } from './init-navigation'
import type { StepReturn } from './init-navigation'

export async function runApiStep(state: InitState, canGoBack: boolean): Promise<StepReturn> {
  console.log()
  console.log(ansis.cyan.bold(`  🔑 Step 1/4 — ${i18n.t('init:api.title')}`))
  console.log()

  const { apiProvider } = await inquirer.prompt([
    {
      type: 'select',
      name: 'apiProvider',
      message: i18n.t('init:api.providerPrompt'),
      choices: [
        { name: `${ansis.green('●')} ${i18n.t('init:api.officialOption')}`, value: 'official' },
        { name: `${ansis.cyan('●')} ${i18n.t('init:api.thirdPartyOption')}`, value: 'thirdparty' },
        ...sponsorInquirerChoices('init'),
        { name: `${ansis.gray('○')} ${i18n.t('init:api.skipOption')}`, value: 'skip' },
        ...navSentinels(canGoBack),
      ],
    },
  ])

  if (apiProvider === BACK_SENTINEL) return 'back'
  if (apiProvider === CANCEL_SENTINEL) return 'cancel'

  // Clear stale values before collecting fresh input
  state.apiUrl = ''
  state.apiKey = ''
  state.sponsorId = ''
  state.sponsorWireCodex = false
  state.sponsorActivateCodex = false

  await configureApiProvider(state, apiProvider)
  return 'next'
}

export async function runModelStep(state: InitState, canGoBack: boolean): Promise<StepReturn> {
  console.log()
  console.log(ansis.cyan.bold(`  🧠 Step 2/4 — ${i18n.t('init:model.title')}`))
  console.log()

  console.log(ansis.yellow(`  ${i18n.t('init:model.geminiDisabled')}`))
  console.log()

  const selectedFrontend = await promptRouteModel('Frontend', state.frontendModels[0], canGoBack)
  if (selectedFrontend === BACK_SENTINEL) return 'back'
  if (selectedFrontend === CANCEL_SENTINEL) return 'cancel'
  const selectedBackend = await promptRouteModel('Backend', state.backendModels[0], canGoBack)
  if (selectedBackend === BACK_SENTINEL) return 'back'
  if (selectedBackend === CANCEL_SENTINEL) return 'cancel'

  const selectedModels = new Set<ModelType>([selectedFrontend as ModelType, selectedBackend as ModelType])
  await promptExecutionModels(state, selectedModels, state.language === 'zh-CN')
  if (selectedFrontend === 'claude' && selectedBackend === 'claude') {
    console.log(ansis.cyan(`  ${i18n.t('init:model.pureClaudeCode')}`))
  }

  state.frontendModels = [selectedFrontend as ModelType]
  state.backendModels = [selectedBackend as ModelType]
  return 'next'
}

export async function runPerfStep(state: InitState, canGoBack: boolean): Promise<StepReturn> {
  console.log()
  console.log(ansis.cyan.bold(`  ⚡ Step 4/4 — ${i18n.t('init:perf.title')}`))
  console.log()

  const { perfMode } = await inquirer.prompt([
    {
      type: 'select',
      name: 'perfMode',
      message: i18n.t('init:perf.selectMode'),
      choices: [
        { name: `${ansis.green('●')} ${i18n.t('init:perf.standardOption')}`, value: 'standard' },
        { name: `${ansis.cyan('●')} ${i18n.t('init:perf.liteOption')}`, value: 'lite' },
        ...navSentinels(canGoBack),
      ],
      default: state.liteMode ? 'lite' : 'standard',
    },
  ])

  if (perfMode === BACK_SENTINEL) return 'back'
  if (perfMode === CANCEL_SENTINEL) return 'cancel'

  state.liteMode = perfMode === 'lite'

  await chooseInstallMode(state)
  if (state.requestedSkills === undefined) await chooseNativeSkills(state)
  return 'next'
}

async function configureApiProvider(state: InitState, apiProvider: string): Promise<void> {
  const sponsor = getSponsor(apiProvider)
  if (sponsor) {
    // Claude Code appends /v1/messages, so ANTHROPIC_BASE_URL must not include /v1.
    state.apiUrl = sponsor.anthropicBaseUrl
    state.sponsorId = sponsor.id
    const picked = await promptSponsorInit(sponsor)
    state.apiKey = picked.apiKey
    state.sponsorWireCodex = picked.wireCodex
    state.sponsorActivateCodex = picked.activateCodex
  } else if (apiProvider === 'thirdparty') {
    const apiAnswers = await inquirer.prompt([
      {
        type: 'input',
        name: 'url',
        message: `API URL ${ansis.gray(`(${i18n.t('init:api.urlRequired')})`)}`,
        validate: (v: string) => v.trim() !== '' || i18n.t('init:api.enterUrl'),
      },
      {
        type: 'password',
        name: 'key',
        message: `API Key ${ansis.gray(`(${i18n.t('init:api.keyRequired')})`)}`,
        mask: '*',
        validate: (v: string) => v.trim() !== '' || i18n.t('init:api.enterKey'),
      },
    ])
    state.apiUrl = apiAnswers.url?.trim() || ''
    state.apiKey = apiAnswers.key?.trim() || ''
  } else if (apiProvider === 'skip') {
    console.log()
    console.log(`    ${ansis.gray('○')} ${i18n.t('init:api.skipNoticeTitle')}`)
  }
  // 'official' leaves apiUrl/apiKey empty — will use OAuth login
}

async function promptRouteModel(side: 'Frontend' | 'Backend', current: ModelType, canGoBack: boolean): Promise<string> {
  const name = `selected${side}`
  const answer = await inquirer.prompt<Record<string, string>>([
    {
      type: 'select',
      name,
      message: i18n.t(`init:model.select${side}`),
      choices: [...modelChoices(), ...navSentinels(canGoBack)],
      default: current || 'claude',
    },
  ])
  return answer[name]
}

async function chooseInstallMode(state: InitState): Promise<void> {
  // Version mode: v3 (smart entry + engine) or legacy (all 30 commands)
  const { versionMode } = await inquirer.prompt([
    {
      type: 'select',
      name: 'versionMode',
      message: '安装模式',
      choices: [
        { name: `${ansis.green('v3 新版')} — /ccg:go 智能入口 + Hook 引擎 + 12 核心命令（推荐）`, value: 'v3' },
        { name: `${ansis.gray('旧版兼容')} — 新版全部 + 18 个旧版命令（workflow/debug/team 等）`, value: 'legacy' },
      ],
      default: 'v3',
    },
  ])
  if (versionMode === 'legacy') {
    state.selectedWorkflows = getAllCommandIds()
    const { includeImpeccable } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'includeImpeccable',
        message: i18n.t('init:commands.includeImpeccable'),
        default: !state.skipImpeccable,
      },
    ])
    state.skipImpeccable = !includeImpeccable
  } else {
    state.selectedWorkflows = getCoreCommandIds()
    state.skipImpeccable = true
  }
}

async function chooseNativeSkills(state: InitState): Promise<void> {
  const skillsMode = await promptSkillsMode(state)
  if (skillsMode === 'legacy') state.skillsProfile = undefined
  else if (skillsMode === 'core') {
    state.skillsProfile = [
      'gen-docs',
      'verify-security',
      'verify-quality',
      'verify-change',
      'verify-module',
      'multi-agent',
    ].filter((name) => state.skillCatalog.some((skill) => skill.name === name))
  } else {
    await selectCustomSkills(state)
  }
  state.selectedSkillsMode = skillsMode === 'legacy' ? 'legacy' : 'native'
}

async function selectCustomSkills(state: InitState): Promise<void> {
  const { selectedSkills } = await inquirer.prompt([
    {
      type: 'checkbox',
      name: 'selectedSkills',
      message: state.language === 'zh-CN' ? '选择原生 Skills' : 'Select native Skills',
      choices: state.skillCatalog.map((skill) => ({
        name: `${skill.name} — ${skill.description}`,
        value: skill.name,
        checked: state.skillsProfile?.includes(skill.name) ?? false,
      })),
    },
  ])
  state.skillsProfile = selectedSkills
}

async function promptSkillsMode(state: InitState): Promise<string> {
  const { skillsMode } = await inquirer.prompt([
    {
      type: 'select',
      name: 'skillsMode',
      message: state.language === 'zh-CN' ? '原生 Skills 安装方式' : 'Native Skills installation',
      choices: [
        { name: state.language === 'zh-CN' ? '保留兼容安装' : 'Keep legacy Skills installation', value: 'legacy' },
        {
          name:
            state.language === 'zh-CN'
              ? '核心质量关卡 + 多 Agent（6 项）'
              : 'Core quality gates + multi-agent (6 skills)',
          value: 'core',
        },
        {
          name: state.language === 'zh-CN' ? '按需选择（可全部取消）' : 'Choose individual skills (can leave empty)',
          value: 'custom',
        },
      ],
      default: state.skillsProfile === undefined ? 'legacy' : 'custom',
    },
  ])
  return skillsMode
}
