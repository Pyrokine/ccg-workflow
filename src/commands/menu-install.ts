import ansis from 'ansis'
import inquirer from 'inquirer'
import { exec } from 'node:child_process'
import { homedir } from 'node:os'
import { promisify } from 'node:util'
import { join } from 'pathe'
import { i18n } from '../i18n'
import { isWindows } from '../utils/platform'

const execAsync = promisify(exec)

import { uninstallWorkflows } from '../utils/installer'

export async function handleInstallClaude(): Promise<void> {
  console.log()
  console.log(ansis.cyan.bold(`  ${i18n.t('menu:claude.title')}`))
  console.log()
  if (!(await prepareClaudeInstall())) return
  const method = await promptClaudeMethod()

  if (method === 'cancel') return

  console.log()
  console.log(ansis.yellow(`  ⏳ ${i18n.t('menu:claude.installing')}`))

  try {
    await executeClaudeInstall(method)

    console.log(ansis.green(`  ✓ ${i18n.t('menu:claude.installSuccess')}`))
    console.log()
    console.log(ansis.cyan(`  💡 ${i18n.t('menu:claude.runHint')}`))
  } catch (e) {
    console.log(ansis.red(`  ✗ ${i18n.t('menu:claude.installFailed', { error: String(e) })}`))
  }
}

// ═══════════════════════════════════════════════════════
// Uninstall
// ═══════════════════════════════════════════════════════

/**
 * Check if CCG is installed globally via npm
 */
async function checkIfGlobalInstall(): Promise<boolean> {
  try {
    const { stdout } = await execAsync('npm list -g ccg-workflow --depth=0', { timeout: 5000 })
    return stdout.includes('ccg-workflow@')
  } catch {
    return false
  }
}

export async function uninstall(): Promise<void> {
  console.log()

  // Check if installed globally via npm
  const isGlobalInstall = await checkIfGlobalInstall()
  showGlobalUninstallSteps(isGlobalInstall)

  // Confirm uninstall
  const { confirm } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'confirm',
      message: isGlobalInstall ? i18n.t('menu:uninstall.continuePrompt') : i18n.t('menu:uninstall.confirm'),
      default: false,
    },
  ])

  if (!confirm) {
    console.log(ansis.gray(`  ${i18n.t('menu:uninstall.cancelled')}`))
    return
  }

  console.log()
  console.log(ansis.yellow(`  ${i18n.t('menu:uninstall.uninstalling')}`))

  // Uninstall workflows
  const installDir = join(homedir(), '.claude')
  const result = await uninstallWorkflows(installDir)

  if (result.success) {
    showUninstallSuccess(result, isGlobalInstall)
  } else {
    console.log(ansis.red(`  ${i18n.t('menu:uninstall.failed')}`))
    for (const error of result.errors) {
      console.log(ansis.red(`    ${error}`))
    }
  }

  console.log()
}

async function prepareClaudeInstall(): Promise<boolean> {
  // Check if already installed
  const isInstalled = await execAsync('claude --version', { timeout: 5000 }).then(
    () => true,
    () => false
  )

  if (isInstalled) {
    console.log(ansis.yellow(`  ⚠ ${i18n.t('menu:claude.alreadyInstalled')}`))
    const { confirm } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirm',
        message: i18n.t('menu:claude.reinstallPrompt'),
        default: false,
      },
    ])

    if (!confirm) {
      console.log(ansis.gray(`  ${i18n.t('common:cancelled')}`))
      return false
    }

    // Uninstall
    console.log()
    console.log(ansis.yellow(`  ⏳ ${i18n.t('menu:claude.uninstalling')}`))
    try {
      const uninstallCmd = isWindows()
        ? 'npm uninstall -g @anthropic-ai/claude-code'
        : 'sudo npm uninstall -g @anthropic-ai/claude-code'
      await execAsync(uninstallCmd, { timeout: 60000 })
      console.log(ansis.green(`  ✓ ${i18n.t('menu:claude.uninstallSuccess')}`))
    } catch (e) {
      console.log(ansis.red(`  ✗ ${i18n.t('menu:claude.uninstallFailed', { error: String(e) })}`))
      return false
    }
  }
  return true
}

async function promptClaudeMethod(): Promise<string> {
  // Select installation method
  const isMac = process.platform === 'darwin'
  const isLinux = process.platform === 'linux'

  const { method } = await inquirer.prompt([
    {
      type: 'select',
      name: 'method',
      message: i18n.t('menu:claude.selectMethod'),
      choices: [
        { name: `npm ${ansis.green('(⭐)')} ${ansis.gray('- npm install -g')}`, value: 'npm' },
        ...(isMac || isLinux ? [{ name: `homebrew ${ansis.gray('- brew install')}`, value: 'homebrew' }] : []),
        ...(isMac || isLinux ? [{ name: `curl ${ansis.gray('- official script')}`, value: 'curl' }] : []),
        ...(isWindows()
          ? [
              { name: `powershell ${ansis.gray('- Windows official')}`, value: 'powershell' },
              { name: `cmd ${ansis.gray('- Command Prompt')}`, value: 'cmd' },
            ]
          : []),
        new inquirer.Separator(),
        { name: `${ansis.gray(i18n.t('common:cancel'))}`, value: 'cancel' },
      ],
    },
  ])
  return method
}

async function executeClaudeInstall(method: string): Promise<void> {
  if (method === 'npm') {
    const installCmd = isWindows()
      ? 'npm install -g @anthropic-ai/claude-code'
      : 'sudo npm install -g @anthropic-ai/claude-code'
    await execAsync(installCmd, { timeout: 300000 })
  } else if (method === 'homebrew') {
    await execAsync('brew install --cask claude-code', { timeout: 300000 })
  } else if (method === 'curl') {
    await execAsync('curl -fsSL https://claude.ai/install.sh | bash', { timeout: 300000 })
  } else if (method === 'powershell') {
    await execAsync('powershell -Command "irm https://claude.ai/install.ps1 | iex"', { timeout: 300000 })
  } else if (method === 'cmd') {
    await execAsync(
      'cmd /c "curl -fsSL https://claude.ai/install.cmd -o install.cmd && install.cmd && del install.cmd"',
      { timeout: 300000 }
    )
  }
}

function showGlobalUninstallSteps(isGlobalInstall: boolean): void {
  if (isGlobalInstall) {
    console.log(ansis.yellow(`  ⚠️  ${i18n.t('menu:uninstall.globalDetected')}`))
    console.log()
    console.log(`  ${i18n.t('menu:uninstall.twoSteps')}`)
    console.log(
      `    ${ansis.cyan(`1. ${i18n.t('menu:uninstall.step1')}`)} ` +
        ansis.gray(`(${i18n.t('menu:uninstall.step1Hint')})`)
    )
    console.log(
      `    ${ansis.cyan(`2. ${i18n.t('menu:uninstall.step2')}`)} ` +
        ansis.gray(`(${i18n.t('menu:uninstall.step2Hint')})`)
    )
    console.log()
  }
}

function showRemovedWorkflows(result: Awaited<ReturnType<typeof uninstallWorkflows>>): void {
  if (result.removedCommands.length > 0) {
    console.log()
    console.log(ansis.cyan(`  ${i18n.t('menu:uninstall.removedCommands')}`))
    for (const cmd of result.removedCommands) {
      console.log(`    ${ansis.gray('•')} /ccg:${cmd}`)
    }
  }

  if (result.removedAgents.length > 0) {
    console.log()
    console.log(ansis.cyan(`  ${i18n.t('menu:uninstall.removedAgents')}`))
    for (const agent of result.removedAgents) {
      console.log(`    ${ansis.gray('•')} ${agent}`)
    }
  }

  if (result.removedSkills.length > 0) {
    console.log()
    console.log(ansis.cyan(`  ${i18n.t('menu:uninstall.removedSkills')}`))
    console.log(`    ${ansis.gray('•')} multi-model-collaboration`)
  }

  if (result.removedBin) {
    console.log()
    console.log(ansis.cyan(`  ${i18n.t('menu:uninstall.removedBin')}`))
    console.log(`    ${ansis.gray('•')} codeagent-wrapper`)
  }
}

function showUninstallSuccess(result: Awaited<ReturnType<typeof uninstallWorkflows>>, isGlobalInstall: boolean): void {
  console.log(ansis.green(`  ✅ ${i18n.t('menu:uninstall.success')}`))
  showRemovedWorkflows(result)

  // If globally installed, show instructions to uninstall npm package
  if (isGlobalInstall) {
    console.log()
    console.log(ansis.yellow.bold(`  🔸 ${i18n.t('menu:uninstall.lastStep')}`))
    console.log()
    console.log(`  ${i18n.t('menu:uninstall.runInNewTerminal')}`)
    console.log()
    console.log(ansis.cyan.bold('    npm uninstall -g ccg-workflow'))
    console.log()
    console.log(ansis.gray(`  (${i18n.t('menu:uninstall.afterDone')})`))
  }
}
