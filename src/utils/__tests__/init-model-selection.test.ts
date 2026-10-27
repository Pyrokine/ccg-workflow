import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { init } from '../../commands/init'
import { createDefaultConfig, createDefaultRouting } from '../config'
import { injectConfigVariables } from '../installer-template'
import { promptOpencodeModel, validateOpencodeModel } from '../model-selection'
import type { CcgConfig } from '../../types'
import { resolve } from 'node:path'

const mocks = vi.hoisted(() => ({
  existing: {} as CcgConfig,
  writeConfig: vi.fn(),
  install: vi.fn(),
  prompt: vi.fn(),
  pathExists: vi.fn(),
  installedNames: vi.fn(),
  spinnerFailed: vi.fn(),
  spinnerSucceeded: vi.fn(),
  installMcp: vi.fn(),
  installAceTool: vi.fn(),
  installContextWeaver: vi.fn(),
  installFastContext: vi.fn(),
  grokSearch: vi.fn(),
  syncMcp: vi.fn(),
}))

vi.mock('inquirer', () => ({ default: { prompt: mocks.prompt, Separator: class {} } }))
vi.mock('fs-extra', async () => {
  const actual = await vi.importActual<{ default: typeof import('fs-extra') }>('fs-extra')
  return { default: { ...actual.default, pathExists: mocks.pathExists, writeJSON: vi.fn() } }
})
vi.mock('ora', () => ({
  default: () => ({
    start() {
      return this
    },
    succeed: mocks.spinnerSucceeded,
    fail: mocks.spinnerFailed,
  }),
}))
vi.mock('../../i18n', () => ({ i18n: { t: (key: string) => key }, initI18n: vi.fn() }))
vi.mock('../migration', () => ({ needsMigration: vi.fn().mockResolvedValue(false), migrateToV1_4_0: vi.fn() }))
vi.mock('../../commands/grok-search', () => ({
  installGrokSearchMcp: mocks.grokSearch,
  appendGrokSearchPrompt: vi.fn(),
}))
vi.mock('../config', async () => ({
  ...(await vi.importActual<typeof import('../config')>('../config')),
  readCcgConfig: () => Promise.resolve(mocks.existing),
  writeCcgConfig: mocks.writeConfig,
  ensureCcgDir: vi.fn(),
}))
vi.mock('../installer', () => ({
  getCoreCommandIds: () => ['go'],
  getAllCommandIds: () => ['go', 'plan'],
  installWorkflows: mocks.install,
  sponsorInquirerChoices: () => [],
  showBinaryDownloadWarning: vi.fn(),
  configureSponsorForCodex: vi.fn(),
  getSponsor: vi.fn(),
  installAceTool: mocks.installAceTool,
  installAceToolRs: vi.fn(),
  installContextWeaver: mocks.installContextWeaver,
  installFastContext: mocks.installFastContext,
  installMcpServer: mocks.installMcp,
  promptSponsorInit: vi.fn(),
  syncMcpToCodex: mocks.syncMcp,
  writeFastContextPrompt: vi.fn(),
}))
vi.mock('../skill-manager', async (original) => ({
  resolveSkillPaths: (await original<typeof import('../skill-manager')>()).resolveSkillPaths,
  SKILL_MANIFEST_FILE: 'manifest.json',
  installedNames: mocks.installedNames,
  getSkillCatalog: () => [
    { name: 'verify-change', description: 'Review changes' },
    { name: 'multi-agent', description: 'Coordinate agents' },
  ],
}))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.pathExists.mockResolvedValue(false)
  mocks.installedNames.mockResolvedValue([])
  process.exitCode = undefined
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  mocks.existing = createDefaultConfig({
    language: 'en',
    routing: {
      ...createDefaultRouting(),
      backend: { models: ['opencode'], primary: 'opencode', strategy: 'fallback' },
      opencodeModel: 'deepseek/custom-test-model',
    },
    installedWorkflows: ['go'],
    mcpProvider: 'skip',
  })
  mocks.install.mockResolvedValue({ success: true, installedCommands: [], installedPrompts: [], errors: [] })
  mocks.installMcp.mockResolvedValue({ success: true })
  mocks.syncMcp.mockResolvedValue({ success: true, synced: [] })
})
afterEach(() => {
  expect(console.error).not.toHaveBeenCalled()
  process.exitCode = undefined
  vi.restoreAllMocks()
})

function answerInitQuestions(overrides: Record<string, unknown> = {}) {
  mocks.prompt.mockImplementation(async (questions: Array<{ name: string; default?: unknown }>) => {
    const name = questions[0].name
    const answers: Record<string, unknown> = {
      apiProvider: 'skip',
      selectedFrontend: 'codex',
      selectedBackend: 'opencode',
      selectedOpencodeModel: questions[0].default,
      perfMode: 'standard',
      versionMode: 'v3',
      skillsMode: 'legacy',
      action: 'confirm',
      ...overrides,
    }
    if (!(name in answers)) throw new Error(`Unexpected prompt: ${name}`)
    return { [name]: answers[name] }
  })
}

function answerInitSequence(answers: Record<string, unknown>[]) {
  mocks.prompt.mockImplementation(async (questions: Array<{ name: string }>) => {
    const answer = answers.shift()
    expect(answer).toBeDefined()
    expect(Object.keys(answer!)).toEqual(questions.map((question) => question.name))
    return answer
  })
}

function promptNames() {
  return mocks.prompt.mock.calls.map(([questions]) => questions[0].name)
}

const performanceAnswers = [{ perfMode: 'lite' }, { versionMode: 'v3' }, { skillsMode: 'legacy' }]

describe('init interactive navigation', () => {
  it('returns from the model step to API selection before continuing installation', async () => {
    answerInitSequence([
      { apiProvider: 'official' },
      { selectedFrontend: '__ccg_back__' },
      { apiProvider: 'skip' },
      { selectedFrontend: 'codex' },
      { selectedBackend: 'opencode' },
      { selectedOpencodeModel: 'deepseek/custom-test-model' },
      ...performanceAnswers,
      { action: 'confirm' },
    ])
    await init({ skipMcp: true, installDir: '/tmp/ccg-init-test' })
    expect(promptNames()).toEqual([
      'apiProvider',
      'selectedFrontend',
      'apiProvider',
      'selectedFrontend',
      'selectedBackend',
      'selectedOpencodeModel',
      'perfMode',
      'versionMode',
      'skillsMode',
      'action',
    ])
    expect(mocks.install).toHaveBeenCalledTimes(1)
    expect(mocks.writeConfig.mock.calls[0][0].routing.backend.primary).toBe('opencode')
  })

  it('cancels backend selection before writing configuration or installing anything', async () => {
    answerInitSequence([
      { apiProvider: 'skip' },
      { selectedFrontend: 'opencode' },
      { selectedBackend: '__ccg_cancel__' },
    ])
    await init({ skipMcp: true, installDir: '/tmp/ccg-init-test' })
    expect(promptNames()).toEqual(['apiProvider', 'selectedFrontend', 'selectedBackend'])
    expect(mocks.writeConfig).not.toHaveBeenCalled()
    expect(mocks.install).not.toHaveBeenCalled()
    expect(mocks.installMcp).not.toHaveBeenCalled()
    expect(mocks.spinnerSucceeded).not.toHaveBeenCalled()
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('init:installCancelled'))
    expect(mocks.existing.routing.frontend.primary).toBe('claude')
  })

  it('returns directly to the summary after editing models from the summary', async () => {
    answerInitSequence([
      { apiProvider: 'skip' },
      { selectedFrontend: 'codex' },
      { selectedBackend: 'opencode' },
      { selectedOpencodeModel: 'deepseek/custom-test-model' },
      ...performanceAnswers,
      { action: 'model' },
      { selectedFrontend: 'claude' },
      { selectedBackend: 'claude' },
      { action: 'confirm' },
    ])
    await init({ skipMcp: true, installDir: '/tmp/ccg-init-test' })
    expect(promptNames().slice(-4)).toEqual(['action', 'selectedFrontend', 'selectedBackend', 'action'])
    expect(promptNames().filter((name) => name === 'perfMode')).toHaveLength(1)
    expect(mocks.install).toHaveBeenCalledTimes(1)
    const routing = mocks.writeConfig.mock.calls[0][0].routing
    expect(routing.frontend.primary).toBe('claude')
    expect(routing.backend.primary).toBe('claude')
  })

  it('clears previous MCP credentials and selections when MCP tools are selected again', async () => {
    answerInitSequence([
      { apiProvider: 'skip' },
      { selectedFrontend: 'claude' },
      { selectedBackend: 'claude' },
      { gate: 'continue' },
      { selectedTools: ['ace-tool', 'fast-context', 'contextweaver', 'grok-search'] },
      { baseUrl: 'https://example.invalid', token: 'fixture-ace-token' },
      { apiKey: 'fixture-fast-key', includeSnippets: true },
      { apiKey: 'fixture-context-key' },
      {
        grokApiUrl: 'https://example.invalid',
        grokApiKey: 'fixture-grok',
        tavilyKey: 'fixture-t',
        firecrawlKey: 'fixture-f',
      },
      ...performanceAnswers,
      { action: 'mcp' },
      { gate: 'continue' },
      { selectedTools: [] },
      { action: 'confirm' },
    ])
    await init({ installDir: '/tmp/ccg-init-test' })
    expect(promptNames().slice(-4)).toEqual(['action', 'gate', 'selectedTools', 'action'])
    expect(mocks.install).toHaveBeenCalledTimes(1)
    expect(mocks.install.mock.calls[0][3].mcpProvider).toBe('skip')
    expect(mocks.writeConfig.mock.calls[0][0].mcp.provider).toBe('skip')
    expect(mocks.installAceTool).not.toHaveBeenCalled()
    expect(mocks.installFastContext).not.toHaveBeenCalled()
    expect(mocks.installContextWeaver).not.toHaveBeenCalled()
    expect(mocks.grokSearch).not.toHaveBeenCalled()
    expect(mocks.installMcp).toHaveBeenCalledTimes(1)
    expect(mocks.installMcp).toHaveBeenCalledWith('context7', 'npx', ['-y', '@upstash/context7-mcp@latest'])
  })
})

describe('OpenCode configuration during init', () => {
  it.each([undefined, 'verify-change'])(
    'resolves a relative install directory for Skills selection %j',
    async (skills) => {
      mocks.existing.performance!.skillsMode = skills === undefined ? 'legacy' : 'native'
      await expect(
        init({ skipPrompt: true, skipMcp: true, installDir: './local-install', skills })
      ).resolves.toBeUndefined()
      expect(mocks.install).toHaveBeenCalledWith(
        ['go'],
        resolve('local-install'),
        undefined,
        expect.objectContaining({
          skillsMode: skills === undefined ? 'legacy' : 'native',
          skillsProfile: skills === undefined ? undefined : ['verify-change'],
        })
      )
    }
  )

  it('preserves the model during a non-interactive reinstall and injects it into execution templates', async () => {
    await init({ skipPrompt: true, skipMcp: true, force: true, installDir: '/tmp/ccg-init-test' })
    expect(mocks.writeConfig).toHaveBeenCalledTimes(1)
    const config = mocks.writeConfig.mock.calls[0][0]
    expect(config.routing.opencodeModel).toBe('deepseek/custom-test-model')
    const installOptions = mocks.install.mock.calls[0][3]
    const command = injectConfigVariables(
      'wrapper --backend {{BACKEND_PRIMARY}} {{OPENCODE_MODEL_FLAG}}task',
      installOptions
    )
    expect(command).toContain('--backend opencode --opencode-model deepseek/custom-test-model task')
    expect(mocks.prompt).not.toHaveBeenCalled()
  })

  it('uses the saved model as the interactive default even when MCP configuration is skipped', async () => {
    answerInitQuestions()
    await init({ skipMcp: true, force: true, installDir: '/tmp/ccg-init-test' })
    expect(mocks.writeConfig).toHaveBeenCalledTimes(1)
    expect(mocks.writeConfig.mock.calls[0][0].routing.opencodeModel).toBe('deepseek/custom-test-model')
    const question = mocks.prompt.mock.calls
      .flatMap(([questions]) => questions)
      .find((q) => q.name === 'selectedOpencodeModel')
    expect(question.default).toBe('deepseek/custom-test-model')
  })

  it('shows saved native Skills as checked and saves only the explicit custom selection', async () => {
    mocks.existing.performance!.skillsProfile = ['verify-change']
    answerInitQuestions({ skillsMode: 'custom', selectedSkills: ['multi-agent'] })
    await init({ skipMcp: true, force: true, installDir: '/tmp/ccg-init-test' })
    const question = mocks.prompt.mock.calls
      .flatMap(([questions]) => questions)
      .find((q) => q.name === 'selectedSkills')
    expect(question.choices).toEqual([
      { name: 'verify-change — Review changes', value: 'verify-change', checked: true },
      { name: 'multi-agent — Coordinate agents', value: 'multi-agent', checked: false },
    ])
    expect(mocks.writeConfig.mock.calls[0][0].performance.skillsProfile).toEqual(['multi-agent'])
  })

  it('leaves the legacy profile implicit when no Skills selection has been configured', async () => {
    await init({ skipPrompt: true, skipMcp: true, installDir: '/tmp/ccg-init-test' })
    expect(mocks.writeConfig.mock.calls[0][0].performance).not.toHaveProperty('skillsProfile')
    expect(mocks.install.mock.calls[0][3].skillsProfile).toBeUndefined()
  })

  it.each([[undefined], [['verify-change']]])(
    'uses the latest manifest rather than a stale profile %j',
    async (oldProfile) => {
      mocks.existing.performance!.skillsProfile = oldProfile
      mocks.pathExists.mockImplementation(async (path: string) => path.endsWith('/.ccg-skills/manifest.json'))
      mocks.installedNames.mockResolvedValue(['multi-agent'])
      await init({ skipPrompt: true, skipMcp: true, installDir: '/tmp/ccg-init-test' })
      expect(mocks.writeConfig.mock.calls[0][0].performance.skillsProfile).toEqual(['multi-agent'])
      expect(mocks.writeConfig.mock.calls[0][0].performance.skillsMode).toBe('native')
      expect(mocks.installedNames).toHaveBeenCalledWith(
        expect.objectContaining({
          nativeDir: '/tmp/ccg-init-test/skills',
          storeDir: '/tmp/ccg-init-test/.ccg-skills',
        })
      )
    }
  )

  it('preserves an empty manifest selection after standalone removals', async () => {
    mocks.existing.performance!.skillsProfile = ['verify-change']
    mocks.pathExists.mockImplementation(async (path: string) => path.endsWith('/.ccg-skills/manifest.json'))
    await init({ skipPrompt: true, skipMcp: true, installDir: '/tmp/ccg-init-test' })
    expect(mocks.writeConfig.mock.calls[0][0].performance.skillsProfile).toEqual([])
  })

  it('keeps an explicit legacy choice even if an older native manifest remains', async () => {
    mocks.existing.performance!.skillsMode = 'legacy'
    mocks.pathExists.mockImplementation(async (path: string) => path.endsWith('/.ccg-skills/manifest.json'))
    await init({ skipPrompt: true, skipMcp: true, installDir: '/tmp/ccg-init-test' })
    expect(mocks.installedNames).not.toHaveBeenCalled()
    expect(mocks.writeConfig.mock.calls[0][0].performance.skillsMode).toBe('legacy')
    expect(mocks.writeConfig.mock.calls[0][0].performance.skillsProfile).toBeUndefined()
  })

  it('refuses a damaged manifest without falling back to old configuration', async () => {
    mocks.pathExists.mockImplementation(async (path: string) => path.endsWith('/.ccg-skills/manifest.json'))
    mocks.installedNames.mockRejectedValueOnce(new Error('Invalid managed skill record'))
    await expect(init({ skipPrompt: true, skipMcp: true })).rejects.toThrow('Invalid managed skill record')
    expect(mocks.writeConfig).not.toHaveBeenCalled()
    expect(mocks.install).not.toHaveBeenCalled()
  })

  it('explicit --skills overrides the manifest selection', async () => {
    mocks.pathExists.mockImplementation(async (path: string) => path.endsWith('/.ccg-skills/manifest.json'))
    mocks.installedNames.mockResolvedValue(['multi-agent'])
    await init({ skipPrompt: true, skipMcp: true, skills: 'none', installDir: '/tmp/ccg-init-test' })
    expect(mocks.installedNames).not.toHaveBeenCalled()
    expect(mocks.writeConfig.mock.calls[0][0].performance.skillsProfile).toEqual([])
  })

  it('persists an explicit interactive legacy choice for later updates', async () => {
    mocks.existing.performance!.skillsProfile = ['verify-change']
    answerInitQuestions({ skillsMode: 'legacy' })
    await init({ skipMcp: true, installDir: '/tmp/ccg-init-test' })
    const saved = mocks.writeConfig.mock.calls[0][0]
    expect(saved.performance.skillsMode).toBe('legacy')
    expect(saved.performance.skillsProfile).toBeUndefined()
  })

  it('returns a nonzero exit status and stops configuration side effects after installation fails', async () => {
    mocks.install.mockResolvedValueOnce({
      success: false,
      installedCommands: [],
      installedPrompts: [],
      errors: ['Skill conflict'],
    })
    await init({ skipPrompt: true, installDir: '/tmp/ccg-init-test' })
    expect(process.exitCode).toBe(1)
    expect(mocks.spinnerFailed).toHaveBeenCalled()
    expect(mocks.spinnerSucceeded).not.toHaveBeenCalled()
    expect(mocks.installMcp).not.toHaveBeenCalled()
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Skill conflict'))
  })

  it.each([[[]], [['verify-change', 'multi-agent']]])(
    'preserves a native Skills selection %j during reinstall',
    async (skillsProfile) => {
      mocks.existing.performance!.skillsProfile = skillsProfile
      await init({ skipPrompt: true, skipMcp: true, installDir: '/tmp/ccg-init-test' })
      expect(mocks.writeConfig.mock.calls[0][0].performance.skillsProfile).toEqual(skillsProfile)
      expect(mocks.install.mock.calls[0][3].skillsProfile).toEqual(skillsProfile)
    }
  )

  it.each([
    ['none', []],
    ['all', ['verify-change', 'multi-agent']],
    ['multi-agent,verify-change,multi-agent', ['multi-agent', 'verify-change']],
  ])('applies --skills %s without mutating the old profile', async (skills, expected) => {
    mocks.existing.performance!.skillsProfile = ['verify-change']
    await init({ skipPrompt: true, skipMcp: true, skills, installDir: '/tmp/ccg-init-test' })
    expect(mocks.writeConfig.mock.calls[0][0].performance.skillsProfile).toEqual(expected)
    expect(mocks.existing.performance!.skillsProfile).toEqual(['verify-change'])
  })

  it.each(['', 'unknown-skill', 'all,multi-agent', 'none,all'])(
    'rejects invalid --skills %s before writing configuration',
    async (skills) => {
      await expect(init({ skipPrompt: true, skipMcp: true, skills })).rejects.toThrow('Invalid Skills selection')
      expect(mocks.writeConfig).not.toHaveBeenCalled()
      expect(mocks.install).not.toHaveBeenCalled()
    }
  )

  it('allows the user to clear the saved model to use the OpenCode default', async () => {
    mocks.prompt.mockResolvedValue({ selectedOpencodeModel: ' ' })
    expect(await promptOpencodeModel('deepseek/custom-test-model', false)).toBe('')
  })
})

describe('OpenCode model input', () => {
  it.each(['', ' ', 'deepseek/test-model', 'custom/model:latest', 'provider/org/model'])('accepts %j', (value) => {
    expect(validateOpencodeModel(value)).toBe(true)
  })
  it.each([
    'model-only',
    'provider/model name',
    'provider/model;touch',
    'provider/$(id)',
    'provider/`id`',
    'provider/model\nnext',
  ])('rejects %j', (value) => {
    expect(validateOpencodeModel(value)).not.toBe(true)
  })
})
