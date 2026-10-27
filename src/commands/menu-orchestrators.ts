import ansis from 'ansis'
import inquirer from 'inquirer'
import ora from 'ora'
import { join } from 'pathe'
import { i18n } from '../i18n'
import { installCodexMode, uninstallCodexMode } from '../utils/installer'
import { defaultDshHome, findDshProfiles, installDshPlugin, uninstallDshPlugin } from '../utils/installer-dsh'

export async function handleDshPlugin(): Promise<void> {
  const isZh = i18n.language === 'zh-CN'
  const dshHome = defaultDshHome()
  console.log()
  console.log(ansis.cyan.bold('  CCG for DeepSeek Harness'))
  console.log()
  console.log(
    isZh
      ? '  七个固定角色委派工具可分别配置模型，也可作为带独立文件的常驻队友。'
      : '  Seven role-pinned delegation tools can use separate models or work as persistent teammates.'
  )
  console.log()

  const profiles = await findDshProfiles(dshHome)
  if (!showDshProfiles(dshHome, profiles, isZh)) return
  const action = await promptDshAction(isZh)

  if (action === 'back') return

  let chosen: string[] | undefined
  if (action === 'pick') {
    const picked = await pickDshProfiles(profiles, isZh)
    if (!picked?.length) return
    chosen = picked
  }

  const uninstalling = action === 'uninstall'
  const spinner = ora(dshProgressMessage(uninstalling, isZh)).start()
  const result = uninstalling
    ? await uninstallDshPlugin({ dshHome })
    : await installDshPlugin({ dshHome, profiles: chosen })
  showDshResult(result, spinner, uninstalling, isZh)
}

export async function handleCodexMode(): Promise<void> {
  const isZh = i18n.language === 'zh-CN'
  console.log()
  console.log(ansis.cyan.bold(isZh ? '  Codex 多模型编排模式' : '  Codex Multi-Model Orchestration Mode'))
  console.log()
  const action = await promptCodexAction(isZh)

  if (action === 'back') return

  if (action === 'uninstall') {
    await removeCodexMode(isZh)
    return
  }
  const confirm = await confirmCodexInstall(isZh)

  if (!confirm) return
  await installCodexFromMenu(isZh)
}

function showDshProfiles(
  dshHome: string,
  profiles: Awaited<ReturnType<typeof findDshProfiles>>,
  isZh: boolean
): boolean {
  if (profiles.length === 0) {
    console.log(
      ansis.yellow(
        isZh
          ? `  没有找到 DeepSeek Harness 配置档：${join(dshHome, 'profiles')}`
          : `  No DeepSeek Harness profile found: ${join(dshHome, 'profiles')}`
      )
    )
    console.log(ansis.gray(isZh ? '  先运行一次 `dsh web` 生成配置档。' : '  Run `dsh web` once to create a profile.'))
    return false
  }

  for (const profile of profiles) {
    const mark = profile.installed ? ansis.green('✓') : ansis.gray('○')
    const note = profile.installed ? ansis.gray(isZh ? '已安装' : 'installed') : ''
    console.log(`  ${mark} ${profile.name} ${note}`)
  }
  console.log()
  return true
}

async function promptDshAction(isZh: boolean): Promise<string> {
  const { action } = await inquirer.prompt([
    {
      type: 'select',
      name: 'action',
      message: isZh ? '选择操作' : 'Select action',
      choices: [
        { name: isZh ? '安装或更新全部配置档' : 'Install or update every profile', value: 'install' },
        { name: isZh ? '选择配置档安装' : 'Choose profiles to install', value: 'pick' },
        { name: isZh ? '从全部配置档卸载' : 'Uninstall from every profile', value: 'uninstall' },
        { name: isZh ? '返回' : 'Back', value: 'back' },
      ],
    },
  ])
  return action
}

async function pickDshProfiles(
  profiles: Awaited<ReturnType<typeof findDshProfiles>>,
  isZh: boolean
): Promise<string[]> {
  const { picked } = await inquirer.prompt<{ picked: string[] }>([
    {
      type: 'checkbox',
      name: 'picked',
      message: isZh ? '选择配置档' : 'Select profiles',
      choices: profiles.map((profile) => ({
        name: profile.name,
        value: profile.name,
        checked: profile.installed,
      })),
    },
  ])
  return picked
}

function dshSuccessMessage(
  result: Awaited<ReturnType<typeof installDshPlugin>>,
  uninstalling: boolean,
  isZh: boolean
): string {
  return uninstalling
    ? isZh
      ? `已移除：${result.profiles.join(', ') || '没有配置档安装过'}`
      : `Removed from: ${result.profiles.join(', ') || 'no installed profile'}`
    : isZh
      ? `已安装到：${result.profiles.join(', ')}`
      : `Installed into: ${result.profiles.join(', ')}`
}

function showDshResult(
  result: Awaited<ReturnType<typeof installDshPlugin>>,
  spinner: ReturnType<typeof ora>,
  uninstalling: boolean,
  isZh: boolean
): void {
  if (result.success) {
    spinner.succeed(dshSuccessMessage(result, uninstalling, isZh))
    if (!uninstalling) {
      console.log(
        ansis.gray(
          isZh
            ? '  重启 dsh 后，在设置 › 内置插件 › CCG 角色矩阵中配置模型档位'
            : '  Restart dsh, then configure model tiers in Settings > Built-in plugins > CCG.'
        )
      )
    }
  } else {
    spinner.fail(isZh ? '操作失败' : 'Operation failed')
    if (result.message) console.log(ansis.red(`  ${result.message}`))
  }

  for (const warning of result.warnings) {
    console.log(ansis.yellow(`  ! ${warning}`))
  }
}

async function promptCodexAction(isZh: boolean): Promise<string> {
  const { action } = await inquirer.prompt([
    {
      type: 'select',
      name: 'action',
      message: isZh ? '选择操作' : 'Select action',
      choices: [
        { name: isZh ? '安装 / 更新 Codex 模式' : 'Install / Update Codex Mode', value: 'install' },
        {
          name: isZh
            ? '卸载 Codex 模式（只删 CCG 文件，保留用户配置）'
            : 'Uninstall Codex Mode (CCG files only, preserves user config)',
          value: 'uninstall',
        },
        { name: isZh ? '返回' : 'Back', value: 'back' },
      ],
    },
  ])
  return action
}

async function removeCodexMode(isZh: boolean): Promise<void> {
  const spinner = ora(isZh ? '卸载 Codex 模式...' : 'Uninstalling Codex mode...').start()
  const result = await uninstallCodexMode()
  if (result.success) {
    spinner.succeed(isZh ? 'Codex 模式已卸载' : 'Codex mode uninstalled')
    showCodexFiles(result.removed, ansis.red('✗'))
    showCodexFiles(result.skipped, ansis.gray('○'))
  } else {
    spinner.fail(isZh ? '卸载失败' : 'Uninstall failed')
    showCodexFiles(result.skipped, ansis.yellow('!'))
  }
  return
}

async function confirmCodexInstall(isZh: boolean): Promise<boolean> {
  // Install
  console.log(
    isZh
      ? '  安装 CCG Codex 模式到 ~/.codex/，让 Codex CLI 作为主导者编排多模型。'
      : '  Install CCG Codex mode to ~/.codex/, enabling Codex CLI as lead orchestrator.'
  )
  console.log()
  console.log(isZh ? '  将安装:' : '  Will install:')
  console.log('    ~/.codex/AGENTS.md              — merged CCG orchestration block')
  console.log('    ~/.codex/config.toml             — preserved; sponsor providers registered only')
  console.log('    ~/.codex/hooks.json + hooks/     — merged session-aware task Hook')
  console.log('    ~/.codex/agents/ccg-*.toml       — leaf Agent definitions')
  console.log()

  const { confirm } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'confirm',
      message: isZh ? '确认安装？' : 'Confirm install?',
      default: true,
    },
  ])
  return confirm
}

async function installCodexFromMenu(isZh: boolean): Promise<void> {
  const spinner = ora(isZh ? '安装 Codex 模式...' : 'Installing Codex mode...').start()
  const result = await installCodexMode()
  if (result.success) {
    spinner.succeed(isZh ? 'Codex 模式安装完成' : 'Codex mode installed')
    console.log()
    console.log(ansis.green(result.message))
    console.log()
    console.log(
      ansis.yellow(
        isZh
          ? '  使用方法: 在项目目录运行 codex，AGENTS.md 会自动生效'
          : '  Usage: run codex in your project directory, AGENTS.md takes effect automatically'
      )
    )
  } else {
    spinner.fail(result.message)
  }
}

function dshProgressMessage(uninstalling: boolean, isZh: boolean): string {
  return uninstalling
    ? isZh
      ? '正在移除 dsh-ccg...'
      : 'Removing dsh-ccg...'
    : isZh
      ? '正在安装 dsh-ccg...'
      : 'Installing dsh-ccg...'
}

function showCodexFiles(files: string[], mark: string): void {
  if (!files.length) return
  console.log()
  for (const file of files) console.log(`  ${mark} ${file}`)
}
