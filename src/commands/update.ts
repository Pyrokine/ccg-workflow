import type { ModelRouting, ModelType } from '../types'
import ansis from 'ansis'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import inquirer from 'inquirer'
import ora from 'ora'
import { homedir } from 'node:os'
import { join } from 'pathe'
import { checkForUpdates, compareVersions } from '../utils/version'
import { uninstallWorkflows } from '../utils/installer'
import { readCcgConfig, writeCcgConfig } from '../utils/config'
import { migrateToV1_4_0, needsMigration } from '../utils/migration'
import { i18n } from '../i18n'

const execAsync = promisify(exec)

/**
 * Main update command - checks for updates and installs if available
 */
export async function update(): Promise<void> {
  console.log()
  console.log(ansis.cyan.bold('🔄 检查更新...'))
  console.log()

  const spinner = ora('正在检查最新版本...').start()

  try {
    const { hasUpdate, currentVersion, latestVersion } = await checkForUpdates()

    // Check if local workflow version differs from running version
    const config = await readCcgConfig()
    const localVersion = config?.general?.version || '0.0.0'
    const needsWorkflowUpdate = compareVersions(currentVersion, localVersion) > 0

    spinner.stop()

    if (!latestVersion) {
      console.log(ansis.red('❌ 无法连接到 npm registry，请检查网络连接'))
      return
    }

    console.log(`当前版本: ${ansis.yellow(`v${currentVersion}`)}`)
    console.log(`最新版本: ${ansis.green(`v${latestVersion}`)}`)
    if (localVersion !== '0.0.0') {
      console.log(`本地工作流: ${ansis.gray(`v${localVersion}`)}`)
    }
    console.log()

    // Determine effective update status
    // hasUpdate: npm registry has newer version
    // needsWorkflowUpdate: local workflows are older than running version
    const effectiveNeedsUpdate = hasUpdate || needsWorkflowUpdate
    let defaultConfirm = effectiveNeedsUpdate

    let message: string
    if (hasUpdate) {
      message = `发现新版本 v${latestVersion} (当前: v${currentVersion})，是否更新？`
      defaultConfirm = true
    }
    else if (needsWorkflowUpdate) {
      message = `检测到本地工作流版本 (v${localVersion}) 低于当前版本 (v${currentVersion})，是否更新？`
      defaultConfirm = true
    }
    else {
      message = `当前已是最新版本 (v${currentVersion})。是否强制重新安装/修复工作流？`
      defaultConfirm = false
    }

    const { confirmUpdate } = await inquirer.prompt([{
      type: 'confirm',
      name: 'confirmUpdate',
      message,
      default: defaultConfirm,
    }])

    if (!confirmUpdate) {
      console.log(ansis.gray('已取消更新'))
      return
    }

    // Pass localVersion as fromVersion for accurate display
    const fromVersion = needsWorkflowUpdate ? localVersion : currentVersion
    await performUpdate(fromVersion, latestVersion || currentVersion, hasUpdate)
  }
  catch (error) {
    spinner.stop()
    console.log(ansis.red(`❌ 更新失败: ${error}`))
  }
}

/**
 * Ask user if they want to reconfigure model routing
 */
async function askReconfigureRouting(currentRouting?: ModelRouting): Promise<ModelRouting | null> {
  console.log()
  console.log(ansis.cyan.bold('🔧 模型路由配置'))
  console.log()

  if (currentRouting) {
    console.log(ansis.gray('当前配置:'))
    console.log(`  ${ansis.cyan('前端模型:')} ${currentRouting.frontend.models.map(m => ansis.green(m)).join(', ')}`)
    console.log(`  ${ansis.cyan('后端模型:')} ${currentRouting.backend.models.map(m => ansis.blue(m)).join(', ')}`)
    console.log()
  }

  const { reconfigure } = await inquirer.prompt([{
    type: 'confirm',
    name: 'reconfigure',
    message: '是否重新配置前端和后端模型？',
    default: false,
  }])

  if (!reconfigure) {
    return null
  }

  console.log()

  // Frontend models selection
  const { selectedFrontend } = await inquirer.prompt([{
    type: 'checkbox',
    name: 'selectedFrontend',
    message: i18n.t('init:selectFrontendModels'),
    choices: [
      { name: 'Gemini', value: 'gemini' as ModelType, checked: currentRouting?.frontend.models.includes('gemini') ?? true },
      { name: 'Claude', value: 'claude' as ModelType, checked: currentRouting?.frontend.models.includes('claude') ?? false },
      { name: 'Codex', value: 'codex' as ModelType, checked: currentRouting?.frontend.models.includes('codex') ?? false },
    ],
    validate: (answer: string[]) => answer.length > 0 || i18n.t('init:validation.selectAtLeastOne'),
  }])

  // Backend models selection
  const { selectedBackend } = await inquirer.prompt([{
    type: 'checkbox',
    name: 'selectedBackend',
    message: i18n.t('init:selectBackendModels'),
    choices: [
      { name: 'Codex', value: 'codex' as ModelType, checked: currentRouting?.backend.models.includes('codex') ?? true },
      { name: 'Gemini', value: 'gemini' as ModelType, checked: currentRouting?.backend.models.includes('gemini') ?? false },
      { name: 'Claude', value: 'claude' as ModelType, checked: currentRouting?.backend.models.includes('claude') ?? false },
    ],
    validate: (answer: string[]) => answer.length > 0 || i18n.t('init:validation.selectAtLeastOne'),
  }])

  const frontendModels = selectedFrontend as ModelType[]
  const backendModels = selectedBackend as ModelType[]

  // Build new routing config
  const newRouting: ModelRouting = {
    frontend: {
      models: frontendModels,
      primary: frontendModels[0],
      strategy: frontendModels.length > 1 ? 'parallel' : 'fallback',
    },
    backend: {
      models: backendModels,
      primary: backendModels[0],
      strategy: backendModels.length > 1 ? 'parallel' : 'fallback',
    },
    review: {
      models: [...new Set([...frontendModels, ...backendModels])],
      strategy: 'parallel',
    },
    mode: currentRouting?.mode || 'smart',
  }

  console.log()
  console.log(ansis.green('✓ 新配置:'))
  console.log(`  ${ansis.cyan('前端模型:')} ${frontendModels.map(m => ansis.green(m)).join(', ')}`)
  console.log(`  ${ansis.cyan('后端模型:')} ${backendModels.map(m => ansis.blue(m)).join(', ')}`)
  console.log()

  return newRouting
}

/**
 * Check if CCG is installed globally via npm
 */
async function checkIfGlobalInstall(): Promise<boolean> {
  try {
    const { stdout } = await execAsync('npm list -g ccg-workflow --depth=0', { timeout: 5000 })
    return stdout.includes('ccg-workflow@')
  }
  catch {
    return false
  }
}

/**
 * Perform the actual update process
 */
async function performUpdate(fromVersion: string, toVersion: string, isNewVersion: boolean): Promise<void> {
  console.log()
  console.log(ansis.yellow.bold('⚙️  开始更新...'))
  console.log()

  // Check if installed globally via npm
  const isGlobalInstall = await checkIfGlobalInstall()

  // If globally installed and only workflow needs update (package is already latest)
  if (isGlobalInstall && !isNewVersion) {
    console.log(ansis.cyan('ℹ️  检测到你是通过 npm 全局安装的'))
    console.log()
    console.log(ansis.green('✓ 当前包版本已是最新 (v' + toVersion + ')'))
    console.log(ansis.yellow('⚙️  仅需更新工作流文件'))
    console.log()
    // Continue to update workflows only
  }
  else if (isGlobalInstall && isNewVersion) {
    console.log(ansis.yellow('⚠️  检测到你是通过 npm 全局安装的'))
    console.log()
    console.log('推荐的更新方式：')
    console.log()
    console.log(ansis.cyan('  npm install -g ccg-workflow@latest'))
    console.log()
    console.log(ansis.gray('这将同时更新命令和工作流文件'))
    console.log()

    const { useNpmUpdate } = await inquirer.prompt([{
      type: 'confirm',
      name: 'useNpmUpdate',
      message: '改用 npm 更新（推荐）？',
      default: true,
    }])

    if (useNpmUpdate) {
      console.log()
      console.log(ansis.cyan('请在新的终端窗口中运行：'))
      console.log()
      console.log(ansis.cyan.bold('  npm install -g ccg-workflow@latest'))
      console.log()
      console.log(ansis.gray('(运行完成后，当前版本将自动更新)'))
      console.log()
      return
    }

    console.log()
    console.log(ansis.yellow('⚠️  继续使用内置更新（仅更新工作流文件）'))
    console.log(ansis.gray('注意：这不会更新 ccg 命令本身'))
    console.log()
  }

  // Step 1: Download latest package (force fresh download)
  let spinner = ora('正在下载最新版本...').start()

  try {
    // Clear npx cache first to ensure we get the latest version
    // This is especially important on Windows where npx caching can be aggressive
    if (process.platform === 'win32') {
      spinner.text = '正在清理 npx 缓存...'
      try {
        // Try to clear npx cache on Windows
        await execAsync('npx clear-npx-cache', { timeout: 10000 })
      }
      catch {
        // If clear-npx-cache doesn't work, manually remove cache directory
        const npxCachePath = join(homedir(), '.npm', '_npx')
        try {
          const fs = await import('fs-extra')
          await fs.remove(npxCachePath)
        }
        catch {
          // Cache clearing failed, but continue anyway
        }
      }
    }

    spinner.text = '正在下载最新版本...'
    // Download latest package using npx with --yes flag
    await execAsync(`npx --yes ccg-workflow@latest --version`, { timeout: 60000 })
    spinner.succeed('最新版本下载完成')
  }
  catch (error) {
    spinner.fail('下载最新版本失败')
    console.log(ansis.red(`错误: ${error}`))
    return
  }

  // Step 2: Auto-migrate from old directory structure (if needed)
  if (await needsMigration()) {
    spinner = ora('检测到旧版本配置，正在迁移...').start()
    const migrationResult = await migrateToV1_4_0()

    if (migrationResult.migratedFiles.length > 0) {
      spinner.info(ansis.cyan('配置迁移完成:'))
      console.log()
      for (const file of migrationResult.migratedFiles) {
        console.log(`  ${ansis.green('✓')} ${file}`)
      }
      if (migrationResult.skipped.length > 0) {
        console.log()
        console.log(ansis.gray('  已跳过:'))
        for (const file of migrationResult.skipped) {
          console.log(`  ${ansis.gray('○')} ${file}`)
        }
      }
      console.log()
    }

    if (migrationResult.errors.length > 0) {
      spinner.warn(ansis.yellow('迁移完成，但有部分错误:'))
      for (const error of migrationResult.errors) {
        console.log(`  ${ansis.red('✗')} ${error}`)
      }
      console.log()
    }
  }

  // Step 3: Delete old workflows first
  // IMPORTANT: We must uninstall first, then let the new version install itself
  // This avoids the issue where the old version's PACKAGE_ROOT doesn't have new binaries
  spinner = ora('正在删除旧工作流...').start()

  try {
    const installDir = join(homedir(), '.claude')
    const uninstallResult = await uninstallWorkflows(installDir)

    if (uninstallResult.success) {
      spinner.succeed('旧工作流已删除')
    }
    else {
      spinner.warn('部分文件删除失败，继续安装...')
      for (const error of uninstallResult.errors) {
        console.log(ansis.yellow(`  • ${error}`))
      }
    }
  }
  catch (error) {
    spinner.warn(`删除旧工作流时出错: ${error}，继续安装...`)
  }

  // Step 4: Install new workflows using the latest version via npx
  // This ensures we use the new version's binary files
  spinner = ora('正在安装新版本工作流和二进制...').start()

  try {
    // Use npx to run the latest version's init command with --force flag
    // This ensures the new version's PACKAGE_ROOT is used for binary installation
    // Note: --skip-prompt preserves existing liteMode setting without asking
    await execAsync(`npx --yes ccg-workflow@latest init --force --skip-mcp --skip-prompt`, {
      timeout: 120000,
      env: {
        ...process.env,
        CCG_UPDATE_MODE: 'true', // Signal to init that this is an update
      },
    })
    spinner.succeed('新版本安装成功')

    // Read updated config to display installed commands
    const config = await readCcgConfig()
    if (config?.workflows?.installed) {
      console.log()
      console.log(ansis.cyan(`已安装 ${config.workflows.installed.length} 个命令:`))
      for (const cmd of config.workflows.installed) {
        console.log(`  ${ansis.gray('•')} /ccg:${cmd}`)
      }
    }
  }
  catch (error) {
    spinner.fail('安装新版本失败')
    console.log(ansis.red(`错误: ${error}`))
    console.log()
    console.log(ansis.yellow('请尝试手动运行:'))
    console.log(ansis.cyan('  npx ccg-workflow@latest'))
    return
  }

  console.log()
  console.log(ansis.green.bold('✅ 更新完成！'))
  console.log()
  if (isNewVersion) {
    console.log(ansis.gray(`从 v${fromVersion} 升级到 v${toVersion}`))
  }
  else {
    console.log(ansis.gray(`重新安装了 v${toVersion}`))
  }
  console.log()
}
