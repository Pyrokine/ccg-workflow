import { afterEach, describe, expect, it } from 'vitest'
import { changeLanguage, i18n, initI18n } from '../../i18n'

afterEach(async () => {
  i18n.removeResourceBundle('en', 'compatibility-fixture')
  i18n.removeResourceBundle('zh-CN', 'compatibility-fixture')
  await changeLanguage('zh-CN')
})

describe('i18next compatibility', () => {
  it('uses the requested locale for both default and explicit namespaces', async () => {
    await initI18n('zh-CN')
    expect(i18n.t('common.back')).toBe('返回')
    expect(i18n.t('common:back')).toBe('返回')
    await initI18n('en')
    expect(i18n.t('common.back')).toBe('Back')
    expect(i18n.t('common:back')).toBe('Back')
    expect(i18n.t('common.unknownSubcommand', { subcommand: 'fixture' })).toBe('Unknown subcommand: fixture')
    await changeLanguage('zh-CN')
    expect(i18n.t('common.unknownSubcommand', { subcommand: 'fixture' })).toBe('未知子命令: fixture')
  })

  it('keeps explicit empty translations and falls back to English for missing keys', async () => {
    await initI18n('zh-CN')
    i18n.addResourceBundle('en', 'compatibility-fixture', { empty: 'English value', missing: 'English fallback' })
    i18n.addResourceBundle('zh-CN', 'compatibility-fixture', { empty: '' })
    expect(i18n.t('empty', { ns: 'compatibility-fixture' })).toBe('')
    expect(i18n.t('missing', { ns: 'compatibility-fixture' })).toBe('English fallback')
    expect(i18n.resolvedLanguage).toBe('zh-CN')
  })
})
