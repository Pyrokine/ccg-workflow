import ansis from 'ansis'
import inquirer from 'inquirer'
import { i18n } from '../i18n'

export type CodexProviderSpec = {
  name: string
  base_url: string
  wire_api: string
  env_key: string
}

export type SponsorGateway = {
  id: string
  name: string
  signupUrl: string
  /** ANTHROPIC_BASE_URL — Claude Code appends /v1/messages itself. */
  anthropicBaseUrl: string
  tagline: { 'zh-CN': string; en: string }
  getKeyNote: { 'zh-CN': string; en: string }
  /** Codex uses the OpenAI protocol, so base_url keeps /v1. */
  codex: CodexProviderSpec
}

export const SPONSORS: readonly SponsorGateway[] = [
  {
    id: 'apimart',
    name: 'APIMart',
    signupUrl: 'https://go.apimart.ai/gh-ccg-workflow',
    anthropicBaseUrl: 'https://api.apimart.ai',
    tagline: {
      'zh-CN': 'Claude 与 GPT API 网关',
      en: 'Claude and GPT API gateway',
    },
    getKeyNote: { 'zh-CN': '', en: '' },
    codex: {
      name: 'APIMart',
      base_url: 'https://api.apimart.ai/v1',
      wire_api: 'responses',
      env_key: 'APIMART_API_KEY',
    },
  },
  {
    id: 'packycode',
    name: 'PackyCode',
    signupUrl: 'https://www.packyapi.ai/register?aff=m21P',
    anthropicBaseUrl: 'https://cf.api.fan',
    tagline: {
      'zh-CN': '统一域名统一密钥，专属 Codex / Claude Code 高速通道',
      en: 'one domain, one key, dedicated Codex / Claude Code routes',
    },
    getKeyNote: {
      'zh-CN': '（新用户 $1 体验额度）',
      en: ' ($1 in free credits for new users)',
    },
    codex: {
      name: 'PackyCode',
      base_url: 'https://cf.api.fan/v1',
      wire_api: 'responses',
      env_key: 'PACKYCODE_API_KEY',
    },
  },
]

const sponsorsById = new Map(SPONSORS.map((sponsor) => [sponsor.id, sponsor]))

export function getSponsor(id: string): SponsorGateway | undefined {
  return sponsorsById.get(id)
}

function locale(lang?: string): 'zh-CN' | 'en' {
  return (lang || i18n.language || 'zh-CN').startsWith('zh') ? 'zh-CN' : 'en'
}

export function sponsorCopy(
  sponsor: SponsorGateway,
  lang?: string
): {
  id: string
  name: string
  tagline: string
  note: string
} {
  const selectedLocale = locale(lang)
  return {
    id: sponsor.id,
    name: sponsor.name,
    tagline: sponsor.tagline[selectedLocale],
    note: sponsor.getKeyNote[selectedLocale],
  }
}

export function sponsorInquirerChoices(namespace: 'init' | 'menu' = 'init'): Array<{
  name: string
  value: string
}> {
  return SPONSORS.map((sponsor) => ({
    name: `${ansis.yellow('★')} ${i18n.t(`${namespace}:api.sponsorOption`, sponsorCopy(sponsor))} ${ansis.gray(`— ${sponsor.signupUrl}`)}`,
    value: sponsor.id,
  }))
}

async function promptSponsorKey(sponsor: SponsorGateway, namespace: 'init' | 'menu'): Promise<string> {
  console.log()
  console.log(
    `    ${ansis.yellow('★')} ${i18n.t(`${namespace}:api.sponsorGetKey`, sponsorCopy(sponsor))}: ${ansis.cyan.underline(sponsor.signupUrl)}`
  )
  console.log()

  const { key } = await inquirer.prompt<{ key: string }>([
    {
      type: 'password',
      name: 'key',
      message: `${sponsor.name} API Key ${ansis.gray(`(${i18n.t(`${namespace}:api.keyRequired`)})`)}`,
      mask: '*',
      validate: (value: string) => value.trim() !== '' || i18n.t(`${namespace}:api.enterKey`),
    },
  ])
  return key?.trim() || ''
}

export async function promptSponsorInit(sponsor: SponsorGateway): Promise<{
  apiKey: string
  wireCodex: boolean
  activateCodex: boolean
}> {
  const copy = sponsorCopy(sponsor)
  const apiKey = await promptSponsorKey(sponsor, 'init')
  const { wire } = await inquirer.prompt<{ wire: boolean }>([
    {
      type: 'confirm',
      name: 'wire',
      message: i18n.t('init:api.sponsorCodexPrompt', copy),
      default: true,
    },
  ])

  let activateCodex = false
  if (wire) {
    const { activate } = await inquirer.prompt<{ activate: boolean }>([
      {
        type: 'confirm',
        name: 'activate',
        message: i18n.t('init:api.sponsorCodexActivatePrompt', copy),
        default: false,
      },
    ])
    activateCodex = activate
  }

  return { apiKey, wireCodex: wire, activateCodex }
}

export function promptSponsorMenuKey(sponsor: SponsorGateway): Promise<string> {
  return promptSponsorKey(sponsor, 'menu')
}
