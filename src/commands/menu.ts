import ansis from 'ansis'
import inquirer from 'inquirer'
import { version } from '../../package.json'
import { i18n } from '../i18n'
import { readCcgConfig } from '../utils/config'
import { configMcp } from './config-mcp'
import { init } from './init'
import { update } from './update'
import { manageSkillsMenu } from './skills'
import { doctor } from './doctor'
import { configApi, configOutputStyle } from './menu-config'
import { configModelRouting } from './menu-routing'
import { handleCodexMode, handleDshPlugin } from './menu-orchestrators'
import { handleInstallClaude, uninstall } from './menu-install'
import { handleTools } from './menu-tools'
import { drawHeader, groupSep, pad, showHelp } from './menu-ui'

const MENU_ACTIONS: Record<string, () => unknown> = {
  '1': init,
  '2': update,
  '3': configMcp,
  '4': configApi,
  '5': configOutputStyle,
  '6': configModelRouting,
  X: handleCodexMode,
  D: handleDshPlugin,
  T: handleTools,
  C: handleInstallClaude,
  '-': uninstall,
  H: showHelp,
  S: manageSkillsMenu,
  V: doctor,
}

function mainMenuChoices(isZh: boolean) {
  return [
    ...claudeMenuChoices(isZh),
    ...toolMenuChoices(isZh),
    ...ccgMenuChoices(isZh),
    new inquirer.Separator(ansis.gray('─'.repeat(42))),
    { name: `  ${ansis.red('Q.')} ${i18n.t('menu:options.exit')}`, value: 'Q' },
  ]
}

function item(key: string, label: string, desc: string) {
  return {
    name: `  ${ansis.green(key + '.')} ${pad(label, 20)} ${ansis.gray('- ' + desc)}`,
    value: key,
  }
}

function claudeMenuChoices(isZh: boolean) {
  return [
    groupSep('Claude Code'),
    item('1', i18n.t('menu:options.init'), isZh ? '安装 CCG 工作流' : 'Install CCG workflows'),
    item('2', i18n.t('menu:options.update'), isZh ? '更新到最新版本' : 'Update to latest version'),
    item('3', i18n.t('menu:options.configMcp'), isZh ? '代码检索 MCP 工具' : 'Code retrieval MCP tool'),
    item('4', i18n.t('menu:options.configApi'), isZh ? '自定义 API 端点' : 'Custom API endpoint'),
    item('5', i18n.t('menu:options.configStyle'), isZh ? '选择输出人格' : 'Choose output personality'),
    item('6', i18n.t('menu:options.configModel'), isZh ? '配置模型路由' : 'Configure model routing'),
  ]
}

function toolMenuChoices(isZh: boolean) {
  return [
    groupSep(isZh ? '其他工具' : 'Tools'),
    item(
      'X',
      isZh ? 'Codex 模式' : 'Codex Mode',
      isZh ? '安装 Codex 主导的多模型编排' : 'Install Codex-led multi-model orchestration'
    ),
    item('D', 'DeepSeek Harness', isZh ? '把 CCG 角色矩阵安装到 dsh' : 'Install the CCG role matrix into dsh'),
    item('T', i18n.t('menu:options.tools'), 'ccusage, CCometixLine'),
    item('C', i18n.t('menu:options.installClaude'), isZh ? '安装/重装 CLI' : 'Install/reinstall CLI'),
  ]
}

function ccgMenuChoices(isZh: boolean) {
  return [
    groupSep('CCG'),
    item(
      'S',
      isZh ? 'Skills 管理' : 'Manage Skills',
      isZh ? '按需安装、更新与移除技能' : 'Select, update and remove skills'
    ),
    item('V', isZh ? '环境诊断' : 'Doctor', isZh ? '检查安装模式、模型路由与技能' : 'Check modes, routing and skills'),
    item('H', i18n.t('menu:options.help'), isZh ? '查看全部斜杠命令' : 'View all slash commands'),
    item('-', i18n.t('menu:options.uninstall'), isZh ? '移除 CCG 配置' : 'Remove CCG config'),
  ]
}

export async function showMainMenu(): Promise<void> {
  while (true) {
    // Read config for status display
    const config = await readCcgConfig()
    const lang = config?.general?.language || 'zh-CN'
    drawHeader(menuStatusParts(config, lang))

    const isZh = lang === 'zh-CN'

    const { action } = await inquirer.prompt([
      { type: 'select', name: 'action', message: i18n.t('menu:title'), pageSize: 20, choices: mainMenuChoices(isZh) },
    ])

    if (action === 'Q') {
      console.log()
      console.log(ansis.gray(`  ${i18n.t('common:goodbye')}`))
      console.log()
      return
    }
    await MENU_ACTIONS[action]?.()

    // Pause after action so user can see results
    console.log()
    await inquirer.prompt([
      {
        type: 'input',
        name: 'continue',
        message: ansis.gray(i18n.t('common:pressEnterToReturn')),
      },
    ])
  }
}

function menuStatusParts(config: Awaited<ReturnType<typeof readCcgConfig>>, lang: string): string[] {
  const cmdCount = config?.workflows?.installed?.length || 0

  const mcpProvider = config?.mcp?.provider || '—'

  // Build status parts
  const statusParts = [ansis.green(`v${version}`), ansis.white(`${cmdCount} commands`), ansis.yellow(lang)]
  if (!['—', 'skip'].includes(mcpProvider)) {
    statusParts.push(ansis.magenta(mcpProvider))
  }

  return statusParts
}
