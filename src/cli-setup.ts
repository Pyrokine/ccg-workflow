import { homedir } from 'node:os'
import ansis from 'ansis'
import type { CAC } from 'cac'
import { join } from 'pathe'
import { version } from '../package.json'
import { configMcp } from './commands/config-mcp'
import { diagnoseMcp, fixMcp } from './commands/diagnose-mcp'
import { doctor, status } from './commands/doctor'
import { init } from './commands/init'
import { showMainMenu } from './commands/menu'
import { i18n, initI18n } from './i18n'
import type { CliOptions } from './types'
import { readCcgConfig } from './utils/config'
import { installCodexMode, uninstallCodexMode, uninstallWorkflows } from './utils/installer'
import { findDshProfiles, installDshPlugin, uninstallDshPlugin } from './utils/installer-dsh'

type HelpSection = { title?: string; body: string }

function customizeHelp(sections: HelpSection[]): HelpSection[] {
  sections.unshift({
    title: '',
    body: ansis.cyan.bold(`CCG - Claude Code + GPT + Grok v${version}`),
  })

  sections.push({
    title: ansis.yellow(i18n.t('cli:help.commands')),
    body: [
      `  ${ansis.cyan('ccg')}              ${i18n.t('cli:help.commandDescriptions.showMenu')}`,
      `  ${ansis.cyan('ccg init')} | ${ansis.cyan('i')}     ${i18n.t('cli:help.commandDescriptions.initConfig')}`,
      `  ${ansis.cyan('ccg config mcp')}   ${i18n.t('cli:help.commandDescriptions.configMcp')}`,
      `  ${ansis.cyan('ccg diagnose-mcp')} ${i18n.t('cli:help.commandDescriptions.diagnoseMcp')}`,
      `  ${ansis.cyan('ccg fix-mcp')}      ${i18n.t('cli:help.commandDescriptions.fixMcp')}`,
      `  ${ansis.cyan('ccg doctor')}       Check installation health`,
      `  ${ansis.cyan('ccg status')}       Show installation overview`,
      `  ${ansis.cyan('ccg codex-mode')}   Install or uninstall Codex-led mode`,
      `  ${ansis.cyan('ccg dsh')}          Install CCG into DeepSeek Harness`,
      `  ${ansis.cyan('ccg uninstall')}    Uninstall CCG without prompts`,
      '',
      ansis.gray(`  ${i18n.t('cli:help.shortcuts')}`),
      `  ${ansis.cyan('ccg i')}            ${i18n.t('cli:help.shortcutDescriptions.quickInit')}`,
    ].join('\n'),
  })

  sections.push({
    title: ansis.yellow(i18n.t('cli:help.options')),
    body: [
      `  ${ansis.green('--lang, -l')} <lang>         ${i18n.t('cli:help.optionDescriptions.displayLanguage')} (zh-CN, en)`,
      `  ${ansis.green('--force, -f')}               ${i18n.t('cli:help.optionDescriptions.forceOverwrite')}`,
      `  ${ansis.green('--help, -h')}                ${i18n.t('cli:help.optionDescriptions.displayHelp')}`,
      `  ${ansis.green('--version, -v')}             ${i18n.t('cli:help.optionDescriptions.displayVersion')}`,
      '',
      ansis.gray(`  ${i18n.t('cli:help.nonInteractiveMode')}`),
      `  ${ansis.green('--skip-prompt, -s')}         ${i18n.t('cli:help.optionDescriptions.skipAllPrompts')}`,
      `  ${ansis.green('--frontend, -F')} <models>   ${i18n.t('cli:help.optionDescriptions.frontendModels')}`,
      `  ${ansis.green('--backend, -B')} <models>    ${i18n.t('cli:help.optionDescriptions.backendModels')}`,
      `  ${ansis.green('--mode, -m')} <mode>         ${i18n.t('cli:help.optionDescriptions.collaborationMode')}`,
      `  ${ansis.green('--workflows, -w')} <list>    ${i18n.t('cli:help.optionDescriptions.workflows')}`,
      `  ${ansis.green('--install-dir, -d')} <path>  ${i18n.t('cli:help.optionDescriptions.installDir')}`,
    ].join('\n'),
  })

  sections.push({
    title: ansis.yellow(i18n.t('cli:help.examples')),
    body: [
      ansis.gray(`  # ${i18n.t('cli:help.exampleDescriptions.showInteractiveMenu')}`),
      `  ${ansis.cyan('npx ccg')}`,
      '',
      ansis.gray(`  # ${i18n.t('cli:help.exampleDescriptions.runFullInitialization')}`),
      `  ${ansis.cyan('npx ccg init')}`,
      `  ${ansis.cyan('npx ccg i')}`,
      '',
      ansis.gray(`  # ${i18n.t('cli:help.exampleDescriptions.customModels')}`),
      `  ${ansis.cyan('npx ccg i --frontend claude --backend claude')}`,
      '',
      ansis.gray(`  # ${i18n.t('cli:help.exampleDescriptions.parallelMode')}`),
      `  ${ansis.cyan('npx ccg i --mode parallel')}`,
      '',
    ].join('\n'),
  })

  return sections
}

export async function setupCommands(cli: CAC): Promise<void> {
  try {
    const config = await readCcgConfig()
    const defaultLang = config?.general?.language || 'zh-CN'
    await initI18n(defaultLang)
  } catch {
    await initI18n('zh-CN')
  }

  // Default command - show menu
  cli
    .command('', i18n.t('cli:help.commandDescriptions.showMenu'))
    .option('--lang, -l <lang>', `${i18n.t('cli:help.optionDescriptions.displayLanguage')} (zh-CN, en)`)
    .action(async (options: CliOptions) => {
      if (options.lang) {
        await initI18n(options.lang)
      }
      await showMainMenu()
    })

  // Init command
  cli
    .command('init', i18n.t('cli:help.commandDescriptions.initConfig'))
    .alias('i')
    .option('--lang, -l <lang>', `${i18n.t('cli:help.optionDescriptions.displayLanguage')} (zh-CN, en)`)
    .option('--force, -f', i18n.t('cli:help.optionDescriptions.forceOverwrite'))
    .option('--skip-prompt, -s', i18n.t('cli:help.optionDescriptions.skipAllPrompts'))
    .option('--skip-mcp', 'Skip MCP configuration (used during update)')
    .option('--frontend, -F <models>', i18n.t('cli:help.optionDescriptions.frontendModels'))
    .option('--backend, -B <models>', i18n.t('cli:help.optionDescriptions.backendModels'))
    .option('--mode, -m <mode>', i18n.t('cli:help.optionDescriptions.collaborationMode'))
    .option('--workflows, -w <workflows>', i18n.t('cli:help.optionDescriptions.workflows'))
    .option('--install-dir, -d <path>', i18n.t('cli:help.optionDescriptions.installDir'))
    .action(async (options: CliOptions) => {
      if (options.lang) {
        await initI18n(options.lang)
      }
      await init(options)
    })

  // Diagnose MCP command
  cli.command('diagnose-mcp', i18n.t('cli:help.commandDescriptions.diagnoseMcp')).action(async () => {
    await diagnoseMcp()
  })

  // Fix MCP command (Windows only)
  cli.command('fix-mcp', i18n.t('cli:help.commandDescriptions.fixMcp')).action(async () => {
    await fixMcp()
  })

  // Config MCP command
  cli
    .command('config <subcommand>', i18n.t('cli:help.commandDescriptions.configMcp'))
    .action(async (subcommand: string) => {
      if (subcommand === 'mcp') {
        await configMcp()
      } else {
        console.log(ansis.red(i18n.t('common:unknownSubcommand', { subcommand })))
        console.log(ansis.gray(i18n.t('common:availableSubcommands', { list: 'mcp' })))
      }
    })

  cli.command('doctor', 'Check CCG installation health').action(async () => {
    await doctor()
  })

  cli.command('status', 'Show CCG installation status').action(async () => {
    await status()
  })

  cli.command('codex-mode <action>', 'Install or uninstall Codex-led mode').action(async (action: string) => {
    if (action === 'install') {
      const result = await installCodexMode()
      if (result.success) {
        console.log(ansis.green('✓ Codex mode installed'))
        console.log(result.message)
      } else {
        console.error(ansis.red(`✗ ${result.message}`))
        process.exitCode = 1
      }
      return
    }

    if (action === 'uninstall') {
      const result = await uninstallCodexMode()
      if (result.success) {
        console.log(ansis.green('✓ Codex mode uninstalled'))
        if (result.removed.length > 0) {
          console.log(ansis.gray(`  Removed: ${result.removed.join(', ')}`))
        }
      } else {
        console.error(ansis.red('✗ Codex mode uninstall failed'))
        process.exitCode = 1
      }
      return
    }

    console.error(ansis.red(`Unknown action: ${action}`))
    console.log(ansis.gray('Usage: ccg codex-mode <install|uninstall>'))
    process.exitCode = 1
  })

  cli
    .command('dsh [action]', 'Install or uninstall CCG for DeepSeek Harness')
    .option('--profile <name>', 'Install only into this profile; repeat to select multiple profiles')
    .action(async (action = 'install', options: { profile?: string | string[] }) => {
      const profiles =
        options.profile === undefined ? undefined : Array.isArray(options.profile) ? options.profile : [options.profile]

      if (action === 'list') {
        const found = await findDshProfiles()
        if (found.length === 0) {
          console.log(ansis.yellow('No DeepSeek Harness profile found'))
          return
        }
        for (const profile of found) {
          console.log(
            `  ${profile.installed ? ansis.green('✓') : ansis.gray('○')} ${profile.name} ${ansis.gray(profile.dir)}`
          )
        }
        return
      }

      if (action === 'install') {
        const result = await installDshPlugin({ profiles })
        if (result.success) {
          console.log(ansis.green(`✓ dsh-ccg installed into: ${result.profiles.join(', ')}`))
          console.log(
            ansis.gray('  Restart dsh to load it, then configure the model tiers in Settings › Plugins › CCG')
          )
        } else {
          console.error(ansis.red(`✗ ${result.message ?? 'Installation failed'}`))
          process.exitCode = 1
        }
        for (const warning of result.warnings) {
          console.warn(ansis.yellow(`  ! ${warning}`))
        }
        return
      }

      if (action === 'uninstall') {
        if (profiles !== undefined) {
          console.error(ansis.red('--profile is only supported with `ccg dsh install`'))
          process.exitCode = 1
          return
        }
        const result = await uninstallDshPlugin()
        if (result.success) {
          console.log(ansis.green(`✓ dsh-ccg removed from: ${result.profiles.join(', ') || '(no profile carried it)'}`))
        } else {
          console.error(ansis.red(`✗ ${result.message ?? 'Uninstall failed'}`))
          process.exitCode = 1
        }
        for (const warning of result.warnings) {
          console.warn(ansis.yellow(`  ! ${warning}`))
        }
        return
      }

      console.error(ansis.red(`Unknown action: ${action}`))
      console.log(ansis.gray('Usage: ccg dsh <install|uninstall|list> [--profile <name>]'))
      process.exitCode = 1
    })

  cli.command('uninstall', 'Uninstall CCG from ~/.claude without prompts').action(async () => {
    const result = await uninstallWorkflows(join(homedir(), '.claude'))
    if (result.success) {
      console.log(ansis.green('✓ CCG uninstalled'))
      if (result.removedCommands.length > 0) {
        console.log(ansis.gray(`  Commands: ${result.removedCommands.length} removed`))
      }
      if (result.removedHooks) console.log(ansis.gray('  Hooks: removed'))
      if (result.removedBin) console.log(ansis.gray('  Binary: removed'))
      return
    }

    console.error(ansis.red('✗ Uninstall failed'))
    for (const error of result.errors) {
      console.error(ansis.gray(`  ${error}`))
    }
    process.exitCode = 1
  })

  cli.help((sections) => customizeHelp(sections))
  cli.version(version)
}
