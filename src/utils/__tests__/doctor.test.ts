import { execFileSync } from 'node:child_process'
import fs from 'fs-extra'
import { join } from 'pathe'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { testHome } = vi.hoisted(() => ({
  testHome: `/tmp/ccg-doctor-${process.pid}`,
}))

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os')
  return { ...actual, homedir: () => testHome }
})
vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }))

import { doctor, status } from '../../commands/doctor'

const execFileSyncMock = vi.mocked(execFileSync)
const installDir = join(testHome, '.claude')
const projectRoot = join(testHome, 'project')
const originalCwd = process.cwd()
const hookScripts = [
  'session-start.js',
  'skill-router.js',
  'subagent-context.js',
  'task-state.js',
  'task-utils.js',
  'workflow-state.js',
]

async function captureConsole(callback: () => Promise<void>): Promise<string> {
  const lines: string[] = []
  const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '))
  })
  try {
    await callback()
  } finally {
    spy.mockRestore()
  }
  return lines.join('\n')
}

async function createInstalledFixture(): Promise<void> {
  await fs.ensureDir(join(installDir, 'commands', 'ccg'))
  await fs.writeFile(join(installDir, 'commands', 'ccg', 'go.md'), '# go\n')

  await fs.ensureDir(join(installDir, 'hooks', 'ccg'))
  await Promise.all(hookScripts.map((name) => fs.writeFile(join(installDir, 'hooks', 'ccg', name), '// hook\n')))

  const hookCommand = `node ${join(installDir, 'hooks', 'ccg', 'workflow-state.js')}`
  const hookEntry = { matcher: '', hooks: [{ type: 'command', command: hookCommand }] }
  await fs.writeJson(join(installDir, 'settings.json'), {
    hooks: {
      UserPromptSubmit: [hookEntry],
      SessionStart: [hookEntry],
      PreToolUse: [hookEntry],
      PostToolUse: [hookEntry],
      PostToolUseFailure: [hookEntry],
    },
  })

  await fs.ensureDir(join(installDir, '.ccg'))
  await fs.writeFile(
    join(installDir, '.ccg', 'config.toml'),
    [
      '[general]',
      'version = "3.6.4-aug.1"',
      'language = "zh-CN"',
      '',
      '[routing.frontend]',
      'models = ["claude"]',
      'primary = "claude"',
      '',
      '[routing.backend]',
      'models = ["claude"]',
      'primary = "claude"',
      '',
    ].join('\n')
  )

  await fs.ensureDir(join(installDir, 'bin'))
  await fs.writeFile(join(installDir, 'bin', 'codeagent-wrapper'), '')
  await fs.ensureDir(join(installDir, 'skills', 'ccg'))
  await fs.ensureDir(join(installDir, 'rules'))
  await Promise.all([
    fs.writeFile(join(installDir, 'rules', 'ccg-skills.md'), '# rules\n'),
    fs.writeFile(join(installDir, 'rules', 'ccg-skill-routing.md'), '# routing\n'),
  ])
  await fs.writeJson(join(testHome, '.claude.json'), { mcpServers: { context7: { command: 'context7' } } })
}

beforeEach(async () => {
  process.chdir(originalCwd)
  await fs.remove(testHome)
  await fs.ensureDir(projectRoot)
  execFileSyncMock.mockReset()
  execFileSyncMock.mockReturnValue(Buffer.from('codeagent-wrapper version 5.15.0-aug.1\n'))
})

afterEach(() => {
  process.chdir(originalCwd)
  vi.restoreAllMocks()
})

afterAll(async () => {
  await fs.remove(testHome)
})

describe('doctor', () => {
  it('checks the private version, complete Hook runtime, and all five Hook events', async () => {
    await createInstalledFixture()

    const output = await captureConsole(doctor)

    expect(output).toContain('CCG Doctor v3.6.4-aug.1')
    expect(output).toContain('6 scripts')
    expect(output).toContain('5/5 events')
    expect(output).toContain('All required checks passed.')
  })

  it('reports invalid settings instead of counting Hook registration as absent', async () => {
    await createInstalledFixture()
    await fs.writeFile(join(installDir, 'settings.json'), '{invalid')

    const output = await captureConsole(doctor)

    expect(output).toContain('settings.json is invalid')
    expect(output).toContain('1 issue(s) found.')
  })
})

describe('status', () => {
  it('reports matching private versions and the active worktree task', async () => {
    await createInstalledFixture()
    await fs.ensureDir(join(projectRoot, '.ccg'))
    await fs.writeJson(join(projectRoot, '.ccg', 'state.json'), { activeTaskId: 'sync-upstream' })
    process.chdir(projectRoot)

    const output = await captureConsole(status)

    expect(output).toContain('3.6.4-aug.1')
    expect(output).toContain('(matches)')
    expect(output).toContain('v5.15.0-aug.1')
    expect(output).toContain('sync-upstream')
  })

  it('surfaces a damaged worktree state file', async () => {
    await createInstalledFixture()
    await fs.ensureDir(join(projectRoot, '.ccg'))
    await fs.writeFile(join(projectRoot, '.ccg', 'state.json'), '{invalid')
    process.chdir(projectRoot)

    const output = await captureConsole(status)

    expect(output).toContain('invalid-state')
  })
})
