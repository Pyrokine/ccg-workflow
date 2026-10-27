import ansis from 'ansis'
import fs from 'fs-extra'
import { homedir } from 'node:os'
import { join } from 'pathe'
import { i18n } from '../i18n'
import type { InstallResult } from '../types'
import { showBinaryDownloadWarning } from '../utils/installer'
import type { InitState } from './init-state'

export async function showInitResult(state: InitState, result: InstallResult): Promise<void> {
  showInstalledContent(result)
  showInstallationErrors(result)

  // Show binary installation result
  await showBinaryInstallation(state, result)

  showMcpResources(state)
}

function showInstalledContent(result: InstallResult): void {
  // Show result summary
  console.log()
  console.log(ansis.cyan(`  ${i18n.t('init:installedCommands')}`))
  result.installedCommands.forEach((cmd) => {
    console.log(`    ${ansis.green('✓')} /ccg:${cmd}`)
  })

  // Show installed prompts
  if (result.installedPrompts.length > 0) {
    console.log()
    console.log(ansis.cyan(`  ${i18n.t('init:installedPrompts')}`))
    // Group by model
    const grouped: Record<string, string[]> = {}
    result.installedPrompts.forEach((p) => {
      const [model, role] = p.split('/')
      if (!grouped[model]) grouped[model] = []
      grouped[model].push(role)
    })
    Object.entries(grouped).forEach(([model, roles]) => {
      console.log(`    ${ansis.green('✓')} ${model}: ${roles.join(', ')}`)
    })
  }

  // Show installed skills
  if (result.installedSkills && result.installedSkills > 0) {
    console.log()
    console.log(ansis.cyan('  Skills:'))
    console.log(`    ${ansis.green('✓')} ${result.installedSkills} skills installed (quality gates + multi-agent)`)
    console.log(ansis.gray('       → ~/.claude/skills/'))
  }

  // Show installed rules
  if (result.installedRules) {
    console.log()
    console.log(ansis.cyan('  Rules:'))
    console.log(`    ${ansis.green('✓')} quality gate auto-trigger rules`)
    console.log(ansis.gray('       → ~/.claude/rules/ccg-skills.md'))
  }

  // Show errors if any
}

function showInstallationErrors(result: InstallResult): void {
  if (result.errors.length > 0) {
    console.log()
    if (!result.success) {
      // Critical failure — prominent red box
      console.log(ansis.red.bold(`  ╔════════════════════════════════════════════════════════════╗`))
      console.log(ansis.red.bold(`  ║  ⚠  安装出现错误 / Installation errors detected           ║`))
      console.log(ansis.red.bold(`  ╚════════════════════════════════════════════════════════════╝`))
    } else {
      console.log(ansis.yellow(`  ⚠ ${i18n.t('init:installationErrors')}`))
    }
    result.errors.forEach((error) => {
      console.log(`    ${ansis.red('✗')} ${error}`)
    })
    if (!result.success) {
      console.log()
      console.log(ansis.yellow(`  尝试修复 / Try to fix:`))
      console.log(ansis.cyan(`    npx ccg-workflow@latest init --force`))
      console.log(ansis.gray(`    如仍失败，请提交 issue 并附上以上错误信息`))
      console.log(ansis.gray(`    If still failing, report an issue with the errors above`))
    }
  }
}

async function showBinaryInstallation(state: InitState, result: InstallResult): Promise<void> {
  if (result.binInstalled && result.binPath) {
    console.log()
    console.log(ansis.cyan(`  ${i18n.t('init:installedBinary')}`))
    console.log(`    ${ansis.green('✓')} codeagent-wrapper ${ansis.gray(`→ ${result.binPath}`)}`)

    const platform = process.platform

    if (platform === 'win32') {
      await configureWindowsPath(result.binPath)
    } else if (!state.options.skipPrompt) {
      await configureShellPath(result.binPath)
    }
  } else {
    // Binary download failed — show prominent warning with manual fix instructions
    showBinaryDownloadWarning(join(state.installDir, 'bin'))
  }
}

async function configureWindowsPath(binPath: string): Promise<void> {
  const windowsPath = binPath.replace(/\//g, '\\').replace(/\\$/, '')
  try {
    const { execSync } = await import('node:child_process')
    const psFlags = '-NoProfile -NonInteractive -ExecutionPolicy Bypass'
    const currentPath = execSync(
      `powershell ${psFlags} -Command "[System.Environment]::GetEnvironmentVariable('PATH', 'User')"`,
      { encoding: 'utf-8' }
    ).trim()
    const currentPathNorm = currentPath.toLowerCase().replace(/\\$/g, '')
    const windowsPathNorm = windowsPath.toLowerCase()

    if (!currentPathNorm.includes(windowsPathNorm) && !currentPathNorm.includes('.claude\\bin')) {
      const escapedPath = windowsPath.replace(/'/g, "''")
      const psScript = currentPath
        ? `$p=[System.Environment]::GetEnvironmentVariable('PATH','User');` +
          `[System.Environment]::SetEnvironmentVariable('PATH',($p+';'+'${escapedPath}'),'User')`
        : `[System.Environment]::SetEnvironmentVariable('PATH','${escapedPath}','User')`
      execSync(`powershell ${psFlags} -Command "${psScript}"`, { stdio: 'pipe' })
      console.log(`    ${ansis.green('✓')} PATH ${ansis.gray('→ User env')}`)
    }
  } catch {
    // Silently ignore PATH config errors on Windows
  }
}

async function configureShellPath(binPath: string): Promise<void> {
  const exportCommand = `export PATH="${binPath}:$PATH"`
  const shell = process.env.SHELL || ''
  const isZsh = shell.includes('zsh')
  const isBash = shell.includes('bash')
  const isMacDefaultZsh = process.platform === 'darwin' && !shell

  if (isZsh || isBash || isMacDefaultZsh) {
    const shellRc = isZsh || isMacDefaultZsh ? join(homedir(), '.zshrc') : join(homedir(), '.bashrc')
    const shellRcDisplay = isZsh || isMacDefaultZsh ? '~/.zshrc' : '~/.bashrc'

    await writeShellPath(binPath, shellRc, shellRcDisplay, exportCommand)
  } else {
    console.log(`    ${ansis.yellow('⚠')} PATH ${ansis.gray(`→ ${i18n.t('init:addToPathManually')}`)}`)
    console.log(`      ${ansis.cyan(exportCommand)}`)
  }
}

function showMcpResources(state: InitState): void {
  // Show MCP resources if user skipped installation
  if (
    state.mcpProvider === 'skip' ||
    ((state.mcpProvider === 'ace-tool' || state.mcpProvider === 'ace-tool-rs') && !state.aceToolToken) ||
    (state.mcpProvider === 'contextweaver' && !state.contextWeaverApiKey)
  ) {
    console.log()
    console.log(ansis.cyan.bold(`  📖 ${i18n.t('init:mcp.mcpOptions')}`))
    console.log()
    console.log(ansis.gray(`     ${i18n.t('init:mcp.mcpOptionsHint')}`))
    console.log()
    console.log(
      `     ${ansis.green('1.')} ${ansis.cyan('fast-context')} ${ansis.yellow('(推荐)')}: Windsurf Fast Context`
    )
    console.log(`        ${ansis.gray('AI 驱动代码搜索，需 Windsurf 账号，免费/低成本')}`)
    console.log()
    console.log(
      `     ${ansis.green('2.')} ${ansis.cyan('ace-tool / ace-tool-rs')}: ` +
        ansis.underline('https://augmentcode.com/')
    )
    console.log(`        ${ansis.gray(i18n.t('init:mcp.promptEnhancement'))}`)
    console.log()
    console.log(
      `     ${ansis.green('3.')} ${ansis.cyan('ace-tool ' + i18n.t('init:mcp.proxyService'))} ` +
        `${ansis.yellow(`(${i18n.t('init:mcp.noSignup')})`)}: ${ansis.underline('https://acemcp.heroman.wtf/')}`
    )
    console.log(`        ${ansis.gray(i18n.t('init:mcp.communityProxy'))}`)
    console.log()
    console.log(
      `     ${ansis.green('4.')} ${ansis.cyan('ContextWeaver')} ` +
        `${ansis.yellow(`(${i18n.t('init:mcp.freeQuota')})`)}: ${ansis.underline('https://siliconflow.cn/')}`
    )
    console.log(`        ${ansis.gray(i18n.t('init:mcp.localEngine'))}`)
    console.log()
  }
}

async function writeShellPath(
  binPath: string,
  shellRc: string,
  shellRcDisplay: string,
  exportCommand: string
): Promise<void> {
  try {
    let rcContent = ''
    if (await fs.pathExists(shellRc)) {
      rcContent = await fs.readFile(shellRc, 'utf-8')
    }

    if (rcContent.includes(binPath) || rcContent.includes('/.claude/bin')) {
      const hint = i18n.t('init:pathAlreadyConfigured', { file: shellRcDisplay })
      console.log(`    ${ansis.green('✓')} PATH ${ansis.gray(`→ ${shellRcDisplay} (${hint})`)}`)
    } else {
      const configLine = `\n# CCG multi-model collaboration system\n${exportCommand}\n`
      await fs.appendFile(shellRc, configLine, 'utf-8')
      console.log(`    ${ansis.green('✓')} PATH ${ansis.gray(`→ ${shellRcDisplay}`)}`)
    }
  } catch {
    // Silently ignore PATH config errors
  }
}
