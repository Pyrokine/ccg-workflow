import i18next from 'i18next'
import type { SupportedLang } from '../types'
import zhCN from './zh-CN'
import en from './en'

export const i18n = i18next

export async function initI18n(lang: SupportedLang = 'zh-CN'): Promise<void> {
  if (!i18n.isInitialized) {
    const options = {
      showSupportNotice: false,
      lng: lang,
      fallbackLng: 'en',
      resources: {
        'zh-CN': { translation: zhCN, ...zhCN },
        en: { translation: en, ...en },
      },
      interpolation: {
        escapeValue: false,
      },
    }
    await i18n.init(options)
  } else if (i18n.language !== lang) {
    await i18n.changeLanguage(lang)
  }
}

export async function changeLanguage(lang: SupportedLang): Promise<void> {
  await i18n.changeLanguage(lang)
}
