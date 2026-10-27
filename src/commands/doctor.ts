import { homedir } from 'node:os'
import ansis from 'ansis'
import fs from 'fs-extra'
import { join } from 'pathe'
import { version as packageVersion } from '../../package.json'
import { readCcgConfig } from '../utils/config'
import { defaultDshHome, findDshProfiles } from '../utils/installer-dsh'
import { collectDoctorReport, executeVersion, readCodexModeStatus, readTaskStatus } from '../utils/doctor-checks'
import type { DoctorDependencies, DoctorReport } from '../utils/doctor-checks'

async function dirFiles(path: string): Promise<string[]> {
  if (!(await fs.pathExists(path))) return []
  return (await fs.readdir(path)).filter((file) => !file.startsWith('.'))
}

function printDoctorReport(report: DoctorReport, output: (text: string) => void): void {
  output(`\n  CCG Doctor v${report.version}\n`)
  const symbols = { pass: ansis.green('✓'), warn: ansis.yellow('!'), fail: ansis.red('✗'), skip: ansis.gray('—') }
  for (const check of report.checks) {
    output(`  ${symbols[check.status]} ${ansis.bold(check.label.padEnd(20))} ${check.detail}`)
    if (check.remediation) output(`    ${check.remediation}`)
  }
  output(
    report.failureCount
      ? `\n  ${report.failureCount} issue(s) found.\n`
      : report.warningCount
        ? `\n  No failures; ${report.warningCount} warning(s).\n`
        : '\n  All required checks passed.\n'
  )
}

export async function doctor(options: { json?: boolean } = {}, deps: DoctorDependencies = {}): Promise<DoctorReport> {
  const report = await collectDoctorReport(deps)
  const output = deps.output || console.log
  if (options.json) output(JSON.stringify(report, null, 2))
  else printDoctorReport(report, output)
  const exitCode = report.failureCount ? 1 : 0
  if (deps.setExitCode) deps.setExitCode(exitCode)
  else process.exitCode = exitCode
  return report
}

async function readBinaryVersion(installDir: string): Promise<string> {
  const wrapperName = process.platform === 'win32' ? 'codeagent-wrapper.exe' : 'codeagent-wrapper'
  const wrapperPath = join(installDir, 'bin', wrapperName)
  const output = (await fs.pathExists(wrapperPath)) ? executeVersion(wrapperPath, ['--version']) : null
  return output?.replace(/^.*version\s*/, 'v') || '—'
}

async function readMcpServers(): Promise<string[]> {
  const claudeJsonPath = join(homedir(), '.claude.json')
  if (!(await fs.pathExists(claudeJsonPath))) return []
  try {
    const claudeConfig = await fs.readJson(claudeJsonPath)
    return Object.keys(claudeConfig.mcpServers || {})
  } catch {
    return ['invalid-config']
  }
}

function codexStatusLabel(codexMode: Awaited<ReturnType<typeof readCodexModeStatus>>): string {
  if (codexMode.kind === 'installed') return 'installed'
  if (codexMode.kind === 'incomplete') return ansis.yellow(codexMode.detail.toLowerCase())
  return ansis.gray('not installed')
}

async function printIntegrationStatus(installDir: string): Promise<void> {
  const mcpServers = await readMcpServers()
  const dshProfiles = await findDshProfiles(defaultDshHome())
  const dshInstalled = dshProfiles.filter((profile) => profile.installed).map((profile) => profile.name)
  const codexMode = await readCodexModeStatus()
  const taskStatus = await readTaskStatus(process.cwd(), installDir)
  console.log(`  ${ansis.bold('MCP')}            ${mcpServers.length > 0 ? mcpServers.join(', ') : ansis.gray('none')}`)
  console.log(`  ${ansis.bold('Codex mode')}     ${codexStatusLabel(codexMode)}`)
  console.log(
    `  ${ansis.bold('DSH profiles')}   ${dshInstalled.length > 0 ? dshInstalled.join(', ') : ansis.gray('none')}`
  )
  console.log(`  ${ansis.bold('Task state')}     ${taskStatus}`)
}

export async function status(): Promise<void> {
  const installDir = join(homedir(), '.claude')
  const config = await readCcgConfig()
  const installedVersion = config?.general?.version || 'unknown'
  const commands = (await dirFiles(join(installDir, 'commands', 'ccg'))).filter((file) => file.endsWith('.md'))
  const hooks = (await dirFiles(join(installDir, 'hooks', 'ccg'))).filter((file) => file.endsWith('.js'))
  const binaryVersion = await readBinaryVersion(installDir)
  const versionNote = installedVersion === packageVersion ? ansis.green(' (matches)') : ansis.yellow(' (different)')
  console.log()
  console.log(ansis.cyan.bold('  CCG Status'))
  console.log()
  console.log(`  ${ansis.bold('Installed')}      ${installedVersion}`)
  console.log(`  ${ansis.bold('Current CLI')}    ${packageVersion}${versionNote}`)
  console.log(`  ${ansis.bold('Commands')}       ${commands.length}`)
  console.log(`  ${ansis.bold('Hooks')}          ${hooks.length} scripts`)
  console.log(`  ${ansis.bold('Binary')}         ${binaryVersion}`)
  printRoutingStatus(config)
  await printIntegrationStatus(installDir)
  console.log()
}

function printRoutingStatus(config: Awaited<ReturnType<typeof readCcgConfig>>): void {
  console.log(`  ${ansis.bold('Frontend')}       ${config?.routing?.frontend?.primary || '—'}`)
  console.log(`  ${ansis.bold('Backend')}        ${config?.routing?.backend?.primary || '—'}`)
}
