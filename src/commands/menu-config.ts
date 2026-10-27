import ansis from 'ansis'
import fs from 'fs-extra'
import inquirer from 'inquirer'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'pathe'
import { i18n } from '../i18n'
import type { ClaudeSettings } from './command-settings'

import { getSponsor, promptSponsorMenuKey, sponsorInquirerChoices } from '../utils/installer'
import { configureApiDefaults } from './command-settings'

export async function configApi(): Promise<void> {
  console.log()
  console.log(ansis.cyan.bold(`  ${i18n.t('menu:api.title')}`))
  console.log()

  const settingsPath = join(homedir(), '.claude', 'settings.json')
  let settings: ClaudeSettings = {}

  if (await fs.pathExists(settingsPath)) {
    settings = await fs.readJson(settingsPath)
  }

  // Show current config
  const currentUrl = settings.env?.ANTHROPIC_BASE_URL
  const currentKey = settings.env?.ANTHROPIC_AUTH_TOKEN || settings.env?.ANTHROPIC_API_KEY
  if (currentUrl || currentKey) {
    console.log(ansis.gray(`  ${i18n.t('menu:api.currentConfig')}`))
    if (currentUrl) console.log(ansis.gray(`    URL: ${currentUrl}`))
    if (currentKey) console.log(ansis.gray(`    Key: ${i18n.t('menu:api.keyConfigured')}`))
    console.log()
  }

  const { apiProvider } = await inquirer.prompt([
    {
      type: 'select',
      name: 'apiProvider',
      message: i18n.t('menu:api.providerPrompt'),
      choices: [
        { name: `${ansis.green('●')} ${i18n.t('menu:api.officialOption')}`, value: 'official' },
        { name: `${ansis.cyan('●')} ${i18n.t('menu:api.thirdPartyOption')}`, value: 'thirdparty' },
        ...sponsorInquirerChoices('menu'),
      ],
    },
  ])

  await applyApiProvider(settings, apiProvider, currentUrl)

  configureApiDefaults(settings)

  await fs.ensureDir(join(homedir(), '.claude'))
  await fs.writeJson(settingsPath, settings, { spaces: 2 })

  console.log()
  console.log(ansis.green(`  ✓ ${i18n.t('menu:api.saved')}`))
  console.log(ansis.gray(`    ${i18n.t('common:configFile')}: ${settingsPath}`))
}

const OUTPUT_STYLES = [
  { id: 'default', nameKey: 'menu:style.default', descKey: 'menu:style.defaultDesc' },
  { id: 'engineer-professional', nameKey: 'menu:style.engineerPro', descKey: 'menu:style.engineerProDesc' },
  { id: 'nekomata-engineer', nameKey: 'menu:style.nekomata', descKey: 'menu:style.nekomataDesc' },
  { id: 'laowang-engineer', nameKey: 'menu:style.laowang', descKey: 'menu:style.laowangDesc' },
  { id: 'ojousama-engineer', nameKey: 'menu:style.ojousama', descKey: 'menu:style.ojousamaDesc' },
  { id: 'abyss-cultivator', nameKey: 'menu:style.abyss', descKey: 'menu:style.abyssDesc' },
  { id: 'abyss-concise', nameKey: 'menu:style.abyssConcise', descKey: 'menu:style.abyssConciseDesc' },
  { id: 'abyss-command', nameKey: 'menu:style.abyssCommand', descKey: 'menu:style.abyssCommandDesc' },
  { id: 'abyss-ritual', nameKey: 'menu:style.abyssRitual', descKey: 'menu:style.abyssRitualDesc' },
]

export async function configOutputStyle(): Promise<void> {
  console.log()
  console.log(ansis.cyan.bold(`  ${i18n.t('menu:style.title')}`))
  console.log()

  const settingsPath = join(homedir(), '.claude', 'settings.json')
  let settings: ClaudeSettings = {}
  if (await fs.pathExists(settingsPath)) {
    settings = await fs.readJson(settingsPath)
  }

  const currentStyle = settings.outputStyle || 'default'
  console.log(ansis.gray(`  ${i18n.t('menu:style.currentStyle')}: ${currentStyle}`))
  console.log()

  const { style } = await inquirer.prompt([
    {
      type: 'select',
      name: 'style',
      message: i18n.t('menu:style.selectStyle'),
      choices: OUTPUT_STYLES.map((s) => ({
        name: `${i18n.t(s.nameKey)} ${ansis.gray(`- ${i18n.t(s.descKey)}`)}`,
        value: s.id,
      })),
      default: currentStyle,
    },
  ])

  if (style === currentStyle) {
    console.log(ansis.gray(i18n.t('menu:style.notChanged')))
    return
  }

  await installOutputStyle(style)

  // Update settings.json
  if (style === 'default') {
    delete settings.outputStyle
  } else {
    settings.outputStyle = style
  }

  await fs.writeJson(settingsPath, settings, { spaces: 2 })

  console.log()
  console.log(ansis.green(`  ✓ ${i18n.t('menu:style.set', { style })}`))
  console.log(ansis.gray(`    ${i18n.t('common:restartToApply')}`))
}

async function applyApiProvider(
  settings: ClaudeSettings,
  apiProvider: string,
  currentUrl: string | undefined
): Promise<void> {
  const sponsor = getSponsor(apiProvider)
  if (apiProvider === 'official') {
    // Clear third-party config, let Claude Code use official auth
    if (!settings.env) settings.env = {}
    delete settings.env.ANTHROPIC_BASE_URL
    delete settings.env.ANTHROPIC_AUTH_TOKEN
    delete settings.env.ANTHROPIC_API_KEY
  } else if (sponsor) {
    const key = await promptSponsorMenuKey(sponsor)
    if (!settings.env) settings.env = {}
    settings.env.ANTHROPIC_BASE_URL = sponsor.anthropicBaseUrl
    settings.env.ANTHROPIC_AUTH_TOKEN = key
    delete settings.env.ANTHROPIC_API_KEY
  } else {
    const answers = await inquirer.prompt([
      {
        type: 'input',
        name: 'url',
        message: `API URL ${ansis.gray(`(${i18n.t('menu:api.urlRequired')})`)}`,
        default: currentUrl || '',
        validate: (v: string) => v.trim() !== '' || i18n.t('menu:api.enterUrl'),
      },
      {
        type: 'password',
        name: 'key',
        message: `API Key ${ansis.gray(`(${i18n.t('menu:api.keyRequired')})`)}`,
        mask: '*',
        validate: (v: string) => v.trim() !== '' || i18n.t('menu:api.enterKey'),
      },
    ])

    if (!settings.env) settings.env = {}
    settings.env.ANTHROPIC_BASE_URL = answers.url.trim()
    settings.env.ANTHROPIC_AUTH_TOKEN = answers.key.trim()
    delete settings.env.ANTHROPIC_API_KEY
  }
}

async function installOutputStyle(style: string): Promise<void> {
  // Copy style file if not default
  if (style !== 'default') {
    const outputStylesDir = join(homedir(), '.claude', 'output-styles')
    await fs.ensureDir(outputStylesDir)

    const __filename = fileURLToPath(import.meta.url)
    const __dirname = dirname(__filename)
    let pkgRoot = dirname(dirname(__dirname))
    if (!(await fs.pathExists(join(pkgRoot, 'templates')))) {
      pkgRoot = dirname(pkgRoot)
    }
    const templatePath = join(pkgRoot, 'templates', 'output-styles', `${style}.md`)
    const destPath = join(outputStylesDir, `${style}.md`)

    if (await fs.pathExists(templatePath)) {
      await fs.copy(templatePath, destPath)
      console.log(ansis.green(`  ✓ ${i18n.t('menu:style.installed', { style })}`))
    }
  }

  // Update settings.json
}
