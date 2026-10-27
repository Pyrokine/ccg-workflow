import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { update } from '../update'

const mocks = vi.hoisted(() => ({
  init: vi.fn(),
  prompt: vi.fn(),
  registry: vi.fn(),
  exec: vi.fn(),
  config: { general: { version: '3.6.7-aug.1' }, performance: { skillsMode: 'native', skillsProfile: [] } },
}))
vi.mock('../init', () => ({ init: mocks.init }))
vi.mock('inquirer', () => ({ default: { prompt: mocks.prompt } }))
vi.mock('../../utils/config', () => ({ readCcgConfig: async () => mocks.config }))
vi.mock('../../utils/version', () => ({ checkForUpdates: mocks.registry, compareVersions: vi.fn() }))
vi.mock('../../i18n', () => ({ i18n: { language: 'en', t: (key: string) => key } }))
vi.mock('ora', () => ({
  default: () => ({
    start() {
      return this
    },
    stop: vi.fn(),
  }),
}))
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  exec: mocks.exec,
}))

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  process.exitCode = undefined
  mocks.prompt.mockResolvedValue({ confirmUpdate: true })
  mocks.init.mockResolvedValue(undefined)
})
afterEach(() => {
  process.exitCode = undefined
  vi.restoreAllMocks()
})

describe('private fork updates', () => {
  it('refreshes with the current init and preserves native selection without invoking npm', async () => {
    await update()
    expect(mocks.init).toHaveBeenCalledWith({ force: true, skipPrompt: true, skipMcp: true })
    expect(mocks.config.performance).toEqual({ skillsMode: 'native', skillsProfile: [] })
    expect(mocks.registry).not.toHaveBeenCalled()
    expect(mocks.exec).not.toHaveBeenCalled()
    expect(console.log).toHaveBeenCalledWith('update:updateDone')
  })
  it('does not refresh a cancelled request', async () => {
    mocks.prompt.mockResolvedValueOnce({ confirmUpdate: false })
    await update()
    expect(mocks.init).not.toHaveBeenCalled()
    expect(mocks.registry).not.toHaveBeenCalled()
    expect(mocks.exec).not.toHaveBeenCalled()
  })
  it('retains the init failure exit status without reporting success', async () => {
    mocks.init.mockImplementationOnce(async () => {
      process.exitCode = 1
    })
    await update()
    expect(process.exitCode).toBe(1)
    expect(console.log).not.toHaveBeenCalledWith('update:updateDone')
  })
  it('reports an exception as a failed update', async () => {
    mocks.init.mockRejectedValueOnce(new Error('fixture failure'))
    await update()
    expect(process.exitCode).toBe(1)
    expect(console.log).not.toHaveBeenCalledWith('update:updateDone')
  })
})
