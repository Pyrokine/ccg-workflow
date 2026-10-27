import ansis from 'ansis'
import fs from 'fs-extra'
import inquirer from 'inquirer'
import { exec, spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { promisify } from 'node:util'
import { join } from 'pathe'
import { i18n } from '../i18n'
import { isWindows } from '../utils/platform'
import type { ClaudeSettings } from './command-settings'

const execAsync = promisify(exec)

export async function handleTools(): Promise<void> {
  console.log()

  const { tool } = await inquirer.prompt([
    {
      type: 'select',
      name: 'tool',
      message: i18n.t('menu:tools.title'),
      choices: [
        {
          name: `${ansis.green('📊')} ccusage        ${ansis.gray(`${i18n.t('menu:tools.ccusage')}`)}`,
          value: 'ccusage',
        },
        { name: `${ansis.blue('📟')} CCometixLine   ${ansis.gray(`${i18n.t('menu:tools.ccline')}`)}`, value: 'ccline' },
        new inquirer.Separator(),
        { name: `${ansis.gray(`← ${i18n.t('common:back')}`)}`, value: 'cancel' },
      ],
    },
  ])

  if (tool === 'cancel') return

  if (tool === 'ccusage') {
    await runCcusage()
  } else if (tool === 'ccline') {
    await handleCCometixLine()
  }
}

async function runCcusage(): Promise<void> {
  console.log()
  console.log(ansis.cyan(`  📊 ${i18n.t('menu:tools.runningCcusage')}`))
  console.log(ansis.gray('  $ npx ccusage@latest'))
  console.log()

  return new Promise((resolve) => {
    const child = spawn('npx', ['ccusage@latest'], {
      stdio: 'inherit',
      shell: true,
    })
    child.on('close', () => resolve())
    child.on('error', () => resolve())
  })
}

async function handleCCometixLine(): Promise<void> {
  console.log()

  const { action } = await inquirer.prompt([
    {
      type: 'select',
      name: 'action',
      message: i18n.t('menu:tools.cclineAction'),
      choices: [
        { name: `${ansis.green('➜')} ${i18n.t('menu:tools.cclineInstall')}`, value: 'install' },
        { name: `${ansis.red('✕')} ${i18n.t('menu:tools.cclineUninstall')}`, value: 'uninstall' },
        new inquirer.Separator(),
        { name: `${ansis.gray(`← ${i18n.t('common:back')}`)}`, value: 'cancel' },
      ],
    },
  ])

  if (action === 'cancel') return

  if (action === 'install') {
    await installCCometixLine()
  } else if (action === 'uninstall') {
    await uninstallCCometixLine()
  }
}

async function installCCometixLine(): Promise<void> {
  console.log()
  console.log(ansis.yellow(`  ⏳ ${i18n.t('menu:tools.cclineInstalling')}`))

  try {
    const installCmd = isWindows() ? 'npm install -g @cometix/ccline' : 'sudo npm install -g @cometix/ccline'
    await execAsync(installCmd, { timeout: 120000 })
    console.log(ansis.green(`  ✓ ${i18n.t('menu:tools.cclineInstallSuccess')}`))

    const settingsPath = join(homedir(), '.claude', 'settings.json')
    let settings: ClaudeSettings = {}

    if (await fs.pathExists(settingsPath)) {
      settings = await fs.readJson(settingsPath)
    }

    settings.statusLine = {
      type: 'command',
      command: isWindows() ? '~/.claude/ccline/ccline.exe' : '~/.claude/ccline/ccline',
      padding: 0,
    }

    await fs.ensureDir(join(homedir(), '.claude'))
    await fs.writeJson(settingsPath, settings, { spaces: 2 })
    console.log(ansis.green(`  ✓ ${i18n.t('menu:tools.cclineConfigured')}`))

    console.log()
    console.log(ansis.cyan(`  💡 ${i18n.t('common:restartToApply')}`))
  } catch (error) {
    console.log(ansis.red(`  ✗ ${i18n.t('menu:tools.cclineInstallFailed', { error: String(error) })}`))
  }
}

async function uninstallCCometixLine(): Promise<void> {
  console.log()
  console.log(ansis.yellow(`  ⏳ ${i18n.t('menu:tools.cclineUninstalling')}`))

  try {
    const settingsPath = join(homedir(), '.claude', 'settings.json')
    if (await fs.pathExists(settingsPath)) {
      const settings = await fs.readJson(settingsPath)
      delete settings.statusLine
      await fs.writeJson(settingsPath, settings, { spaces: 2 })
      console.log(ansis.green(`  ✓ ${i18n.t('menu:tools.cclineConfigRemoved')}`))
    }

    const uninstallCmd = isWindows() ? 'npm uninstall -g @cometix/ccline' : 'sudo npm uninstall -g @cometix/ccline'
    await execAsync(uninstallCmd, { timeout: 60000 })
    console.log(ansis.green(`  ✓ ${i18n.t('menu:tools.cclineUninstalled')}`))
  } catch (error) {
    console.log(ansis.red(`  ✗ ${i18n.t('menu:tools.cclineUninstallFailed', { error: String(error) })}`))
  }
}
