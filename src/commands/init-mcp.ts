import ansis from 'ansis'
import inquirer from 'inquirer'
import { i18n } from '../i18n'
import { emptyMcpCredentials } from './init-state'
import type { InitState } from './init-state'
import { BACK_SENTINEL, CANCEL_SENTINEL, navSentinels } from './init-navigation'
import type { StepReturn } from './init-navigation'

export async function runMcpStep(state: InitState, canGoBack: boolean): Promise<StepReturn> {
  if (state.options.skipMcp) {
    state.mcpProvider = state.existingConfig?.mcp?.provider || 'skip'
    return 'next'
  }

  console.log()
  console.log(ansis.cyan.bold(`  🔧 Step 3/4 — ${i18n.t('init:mcp.title')}`))
  console.log()

  // Pre-step gate: since the main prompt is a checkbox (can't embed
  // navigation sentinels cleanly), ask a single-choice list first.
  const gate = await promptMcpGate(canGoBack)

  if (gate === BACK_SENTINEL) return 'back'
  if (gate === CANCEL_SENTINEL) return 'cancel'

  Object.assign(state, emptyMcpCredentials())

  const selectedTools = await promptMcpTools()

  await configureSelectedMcpTools(state, selectedTools)
  return 'next'
}

async function promptAceTool(state: InitState): Promise<void> {
  console.log()
  console.log(ansis.cyan.bold(`  🔧 ace-tool MCP`))
  console.log()
  console.log(
    `     ${ansis.gray('•')} ${ansis.cyan(i18n.t('init:mcp.officialService'))}: ` +
      ansis.underline('https://augmentcode.com/')
  )
  console.log(
    `     ${ansis.gray('•')} ${ansis.cyan(i18n.t('init:mcp.proxyService'))} ` +
      `${ansis.yellow(`(${i18n.t('init:mcp.noSignup')})`)}: ${ansis.underline('https://acemcp.heroman.wtf/')}`
  )
  console.log()

  const aceAnswers = await inquirer.prompt([
    {
      type: 'input',
      name: 'baseUrl',
      message: `Base URL ${ansis.gray(`(${i18n.t('init:mcp.baseUrlHint')})`)}`,
      default: '',
    },
    {
      type: 'password',
      name: 'token',
      message: `Token ${ansis.gray(`(${i18n.t('init:mcp.tokenRequired')})`)}`,
      mask: '*',
      validate: (input: string) => input.trim() !== '' || i18n.t('init:mcp.enterToken'),
    },
  ])
  state.aceToolBaseUrl = aceAnswers.baseUrl || ''
  state.aceToolToken = aceAnswers.token || ''
}

async function promptFastContext(state: InitState): Promise<void> {
  console.log()
  console.log(ansis.cyan.bold(`  🔧 fast-context MCP`))
  console.log(ansis.gray(`     Windsurf Fast Context — ${i18n.t('init:mcp.fcAutoExtract')}`))
  console.log()

  const fcAnswers = await inquirer.prompt([
    {
      type: 'input',
      name: 'apiKey',
      message: `WINDSURF_API_KEY ${ansis.gray(`(${i18n.t('init:mcp.fcLeaveEmpty')})`)}`,
      default: '',
    },
    {
      type: 'select',
      name: 'includeSnippets',
      message: i18n.t('init:mcp.fcSnippetMode'),
      choices: [
        {
          name: `${i18n.t('init:mcp.fcPathOnly')} ${ansis.gray(`(${i18n.t('init:mcp.fcSaveToken')})`)}`,
          value: false,
        },
        { name: i18n.t('init:mcp.fcFullSnippet'), value: true },
      ],
    },
  ])
  state.fastContextApiKey = fcAnswers.apiKey?.trim() || ''
  state.fastContextIncludeSnippets = fcAnswers.includeSnippets
}

async function promptContextWeaver(state: InitState): Promise<void> {
  console.log()
  console.log(ansis.cyan.bold(`  🔧 ContextWeaver MCP`))
  console.log()
  console.log(
    `     ${ansis.gray('1.')} ` +
      i18n.t('init:mcp.siliconflowStep1', { url: ansis.underline('https://siliconflow.cn/') })
  )
  console.log(`     ${ansis.gray('2.')} ${i18n.t('init:mcp.siliconflowStep2')}`)
  console.log(`     ${ansis.gray('3.')} ${i18n.t('init:mcp.siliconflowStep3')}`)
  console.log()

  const cwAnswers = await inquirer.prompt([
    {
      type: 'password',
      name: 'apiKey',
      message: `SiliconFlow API Key ${ansis.gray('(sk-xxx)')}`,
      mask: '*',
      validate: (input: string) => input.trim() !== '' || i18n.t('init:mcp.enterApiKey'),
    },
  ])
  state.contextWeaverApiKey = cwAnswers.apiKey || ''
}

async function promptGrokSearch(state: InitState): Promise<void> {
  console.log()
  console.log(ansis.cyan.bold(`  🔍 grok-search MCP`))
  console.log()
  console.log(
    `     Tavily: ${ansis.underline('https://www.tavily.com/')} ${ansis.gray(`(${i18n.t('init:grok.tavilyHint')})`)}`
  )
  console.log(
    `     Firecrawl: ${ansis.underline('https://www.firecrawl.dev/')} ` +
      ansis.gray(`(${i18n.t('init:grok.firecrawlHint')})`)
  )
  console.log(`     Grok API: ${ansis.gray(i18n.t('init:grok.grokHint'))}`)
  console.log()

  const grokAnswers = await inquirer.prompt([
    {
      type: 'input',
      name: 'grokApiUrl',
      message: `GROK_API_URL ${ansis.gray(`(${i18n.t('init:grok.optional')})`)}`,
      default: '',
    },
    {
      type: 'password',
      name: 'grokApiKey',
      message: `GROK_API_KEY ${ansis.gray(`(${i18n.t('init:grok.optional')})`)}`,
      mask: '*',
    },
    {
      type: 'password',
      name: 'tavilyKey',
      message: `TAVILY_API_KEY ${ansis.gray(`(${i18n.t('init:grok.optional')})`)}`,
      mask: '*',
    },
    {
      type: 'password',
      name: 'firecrawlKey',
      message: `FIRECRAWL_API_KEY ${ansis.gray(`(${i18n.t('init:grok.optional')})`)}`,
      mask: '*',
    },
  ])

  state.tavilyKey = grokAnswers.tavilyKey?.trim() || ''
  state.firecrawlKey = grokAnswers.firecrawlKey?.trim() || ''
  state.grokApiUrl = grokAnswers.grokApiUrl?.trim() || ''
  state.grokApiKey = grokAnswers.grokApiKey?.trim() || ''
}

async function promptMcpTools(): Promise<string[]> {
  const { selectedTools } = (await inquirer.prompt([
    {
      type: 'checkbox',
      name: 'selectedTools',
      message: i18n.t('init:mcp.selectTools'),
      choices: [
        {
          name: `fast-context ${ansis.green(`(${i18n.t('common:recommended')})`)} ${ansis.gray('— AI 驱动语义搜索')}`,
          value: 'fast-context',
          checked: true,
        },
        {
          name: `ace-tool ${ansis.gray('— search_context 代码检索')}`,
          value: 'ace-tool',
        },
        {
          name: `context7 ${ansis.green('(free)')} ${ansis.gray('— 库文档查询')}`,
          value: 'context7',
          checked: true,
        },
        {
          name: `grok-search ${ansis.gray('— 联网搜索 (需 API Key)')}`,
          value: 'grok-search',
        },
        {
          name: `contextweaver ${ansis.gray('— 硅基流动嵌入检索 (需 API Key)')}`,
          value: 'contextweaver',
        },
      ],
    },
  ])) as { selectedTools: string[] }
  return selectedTools
}

async function promptMcpGate(canGoBack: boolean): Promise<string> {
  const { gate } = await inquirer.prompt([
    {
      type: 'select',
      name: 'gate',
      message: i18n.t('init:mcp.gatePrompt'),
      choices: [
        { name: `${ansis.green('●')} ${i18n.t('init:mcp.gateContinue')}`, value: 'continue' },
        ...navSentinels(canGoBack),
      ],
    },
  ])
  return gate
}

async function configureSelectedMcpTools(state: InitState, selectedTools: string[]): Promise<void> {
  const hasAceTool = selectedTools.includes('ace-tool')
  const hasFastContext = selectedTools.includes('fast-context')
  const hasContextWeaver = selectedTools.includes('contextweaver')
  state.wantFastContext = hasFastContext
  state.wantGrokSearch = selectedTools.includes('grok-search')

  if (hasAceTool) {
    state.mcpProvider = 'ace-tool'
  } else if (hasFastContext) {
    state.mcpProvider = 'fast-context'
  } else if (hasContextWeaver) {
    state.mcpProvider = 'contextweaver'
  } else {
    state.mcpProvider = 'skip'
  }

  if (hasAceTool) await promptAceTool(state)

  if (hasFastContext) await promptFastContext(state)

  if (hasContextWeaver) await promptContextWeaver(state)

  if (state.wantGrokSearch) await promptGrokSearch(state)
}
