import ansis from 'ansis'
import inquirer from 'inquirer'
import { i18n } from '../i18n'

const ANSI_ESCAPE_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')

/**
 * Get visual display width of a string (CJK = 2, ASCII = 1)
 */
const FULL_WIDTH_RANGES = [
  [0x2e80, 0x9fff],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe4f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f9ff],
  [0x20000, 0x2fa1f],
]

function visWidth(s: string): number {
  const stripped = s.replace(ANSI_ESCAPE_RE, '')
  let w = 0
  for (const ch of stripped) {
    const code = ch.codePointAt(0) || 0
    // CJK Unified Ideographs + common fullwidth ranges
    const wide = FULL_WIDTH_RANGES.some(([first, last]) => code >= first && code <= last)
    w += wide ? 2 : 1
  }
  return w
}

/**
 * Pad a string to a fixed visible width (ANSI + CJK aware)
 */
export function pad(s: string, w: number): string {
  const diff = w - visWidth(s)
  return diff > 0 ? s + ' '.repeat(diff) : s
}

const INNER_W = 60

/**
 * Center a string (with ANSI) inside a fixed-width area
 */
function centerLine(s: string, w: number): string {
  const vis = visWidth(s)
  const left = Math.max(0, Math.floor((w - vis) / 2))
  const right = Math.max(0, w - vis - left)
  return ' '.repeat(left) + s + ' '.repeat(right)
}

/**
 * Draw a boxed row: ║ <content padded to INNER_W> ║
 */
function boxRow(content: string): string {
  const vis = visWidth(content)
  const gap = Math.max(0, INNER_W - vis)
  return ansis.cyan('║') + content + ' '.repeat(gap) + ansis.cyan('║')
}

export function drawHeader(statusParts: string[]): void {
  const top = ansis.cyan('╔' + '═'.repeat(INNER_W) + '╗')
  const bot = ansis.cyan('╚' + '═'.repeat(INNER_W) + '╝')
  const empty = boxRow(' '.repeat(INNER_W))

  // ASCII Art Logo
  const logo = [
    '  ██████╗  ██████╗  ██████╗ ',
    ' ██╔════╝ ██╔════╝ ██╔════╝ ',
    ' ██║      ██║      ██║  ███╗',
    ' ██║      ██║      ██║   ██║',
    ' ╚██████╗ ╚██████╗ ╚██████╔╝',
    '  ╚═════╝  ╚═════╝  ╚═════╝ ',
  ]

  console.log()
  console.log(top)
  console.log(empty)
  for (const line of logo) {
    console.log(boxRow(centerLine(ansis.bold.white(line), INNER_W)))
  }
  console.log(empty)
  console.log(boxRow(centerLine(ansis.gray('Multi-Model Collaboration'), INNER_W)))
  console.log(empty)
  if (statusParts.length > 0) {
    const statusLine = statusParts.join(ansis.gray('  |  '))
    console.log(boxRow(centerLine(statusLine, INNER_W)))
    console.log(empty)
  }
  console.log(bot)
  console.log()
}

export function groupSep(label: string): InstanceType<typeof inquirer.Separator> {
  const w = 42
  const labelW = visWidth(label)
  const remaining = Math.max(0, w - labelW - 2)
  const left = Math.floor(remaining / 2)
  const right = remaining - left
  return new inquirer.Separator(ansis.gray(`${'─'.repeat(left)} ${label} ${'─'.repeat(right)}`))
}

export function showHelp(): void {
  console.log()
  console.log(ansis.cyan.bold(`  ${i18n.t('menu:help.title')}`))
  console.log()

  const col1 = 22 // command column width
  const section = (title: string) => console.log(ansis.yellow.bold(`  ${title}`))
  const cmd = (name: string, desc: string) => console.log(`  ${ansis.green(name.padEnd(col1))} ${ansis.gray(desc)}`)

  // Core Engine
  section(i18n.t('menu:help.sections.engine'))
  cmd('/ccg:go', i18n.t('menu:help.descriptions.go'))
  console.log()

  // OpenSpec Workflows
  section(i18n.t('menu:help.sections.opsx'))
  cmd('/ccg:spec-init', i18n.t('menu:help.descriptions.specInit'))
  cmd('/ccg:spec-research', i18n.t('menu:help.descriptions.specResearch'))
  cmd('/ccg:spec-plan', i18n.t('menu:help.descriptions.specPlan'))
  cmd('/ccg:spec-impl', i18n.t('menu:help.descriptions.specImpl'))
  cmd('/ccg:spec-review', i18n.t('menu:help.descriptions.specReview'))
  console.log()

  // Git Tools
  section(i18n.t('menu:help.sections.gitTools'))
  cmd('/ccg:commit', i18n.t('menu:help.descriptions.commit'))
  cmd('/ccg:rollback', i18n.t('menu:help.descriptions.rollback'))
  cmd('/ccg:clean-branches', i18n.t('menu:help.descriptions.cleanBranches'))
  cmd('/ccg:worktree', i18n.t('menu:help.descriptions.worktree'))
  console.log()

  // Project Management
  section(i18n.t('menu:help.sections.projectMgmt'))
  cmd('/ccg:init', i18n.t('menu:help.descriptions.init'))
  cmd('/ccg:context', i18n.t('menu:help.descriptions.context'))
  console.log()

  // Quality Gates
  section(i18n.t('menu:help.sections.qualityGates'))
  cmd('/ccg:verify-security', i18n.t('menu:help.descriptions.verifySecurity'))
  cmd('/ccg:verify-quality', i18n.t('menu:help.descriptions.verifyQuality'))
  cmd('/ccg:verify-change', i18n.t('menu:help.descriptions.verifyChange'))
  cmd('/ccg:verify-module', i18n.t('menu:help.descriptions.verifyModule'))
  console.log()

  console.log(ansis.gray(`  ${i18n.t('menu:help.hint')}`))
  console.log()
}
