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
      'version = "3.6.7-aug.1"',
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

async function createCodexModeFixture(): Promise<void> {
  const codexHome = join(testHome, '.codex')
  await fs.ensureDir(join(codexHome, 'agents'))
  await fs.ensureDir(join(codexHome, 'hooks', 'ccg'))
  await fs.ensureDir(join(codexHome, '.ccg'))
  await Promise.all([
    fs.writeJson(join(codexHome, '.ccg', 'codex-mode.json'), { schemaVersion: 1, files: [], sponsorProviderIds: [] }),
    fs.writeFile(
      join(codexHome, 'AGENTS.md'),
      '<!-- CCG:START — Managed by CCG Workflow. Do not edit this block manually. -->\n# CCG\n<!-- CCG:END -->\n'
    ),
    fs.writeFile(join(codexHome, 'agents', 'ccg-implement.toml'), ''),
    fs.writeFile(join(codexHome, 'agents', 'ccg-review.toml'), ''),
    fs.writeFile(join(codexHome, 'agents', 'ccg-research.toml'), ''),
    fs.writeFile(join(codexHome, 'hooks', 'ccg-workflow.py'), ''),
    fs.writeFile(join(codexHome, 'hooks', 'ccg', 'package.json'), '{}\n'),
    fs.writeFile(join(codexHome, 'hooks', 'ccg', 'task-utils.js'), ''),
    fs.writeFile(join(codexHome, 'hooks', 'ccg', 'task-state.js'), ''),
    fs.writeJson(join(codexHome, 'hooks.json'), {
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [{ type: 'command', command: `python3 ${join(codexHome, 'hooks', 'ccg-workflow.py')}` }],
          },
        ],
      },
    }),
  ])
}

beforeEach(async () => {
  process.chdir(originalCwd)
  await fs.remove(testHome)
  await fs.ensureDir(projectRoot)
  delete process.env.CCG_SESSION_KEY
  execFileSyncMock.mockReset()
  execFileSyncMock.mockReturnValue(Buffer.from('codeagent-wrapper version 5.15.0-aug.1\n'))
})

afterEach(() => {
  process.chdir(originalCwd)
  delete process.env.CCG_SESSION_KEY
  vi.restoreAllMocks()
})

afterAll(async () => {
  await fs.remove(testHome)
})

describe('doctor', () => {
  it('checks the private version, complete Hook runtime, and all five Hook events', async () => {
    await createInstalledFixture()

    const output = await captureConsole(doctor)

    expect(output).toContain('CCG Doctor v3.6.7-aug.1')
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

  it('does not treat a user-owned Codex AGENTS.md as CCG Codex mode', async () => {
    await createInstalledFixture()
    await fs.ensureDir(join(testHome, '.codex'))
    await fs.writeFile(join(testHome, '.codex', 'AGENTS.md'), '# User instructions\n')

    const output = await captureConsole(doctor)

    expect(output).toContain('Not installed (optional)')
    expect(output).not.toContain('Incomplete; missing:')
  })

  it('reports partial CCG Codex runtime as incomplete', async () => {
    await createInstalledFixture()
    await fs.ensureDir(join(testHome, '.codex', 'hooks'))
    await fs.writeFile(join(testHome, '.codex', 'hooks', 'ccg-workflow.py'), '')

    const output = await captureConsole(doctor)

    expect(output).toContain('Incomplete; missing:')
    expect(output).toContain('AGENTS.md (CCG block)')
    expect(output).toContain('hooks.json (CCG registration)')
  })

  it('reports CCG Codex mode only when instructions, runtime, agents, and Hook registration exist', async () => {
    await createInstalledFixture()
    await createCodexModeFixture()

    const output = await captureConsole(doctor)

    expect(output).toMatch(/Codex mode\s+Installed/)
  })

  it('does not count a user Hook whose command only contains the CCG script path as a substring', async () => {
    await createInstalledFixture()
    await createCodexModeFixture()
    const hooksPath = join(testHome, '.codex', 'hooks.json')
    const hooks = await fs.readJson(hooksPath)
    hooks.hooks.UserPromptSubmit.push({
      hooks: [
        {
          type: 'command',
          command: `python3 ${join(testHome, '.codex', 'hooks', 'ccg-workflow.py')}.backup`,
        },
      ],
    })
    await fs.writeJson(hooksPath, hooks)

    const output = await captureConsole(doctor)

    expect(output).toMatch(/Codex mode\s+Installed/)
  })

  it('reports duplicate Codex markers or Hook registrations as incomplete', async () => {
    await createInstalledFixture()
    await createCodexModeFixture()
    const codexHome = join(testHome, '.codex')
    await fs.appendFile(
      join(codexHome, 'AGENTS.md'),
      '<!-- CCG:START — Managed by CCG Workflow. Do not edit this block manually. -->\nduplicate\n<!-- CCG:END -->\n'
    )
    const hooks = await fs.readJson(join(codexHome, 'hooks.json'))
    hooks.hooks.UserPromptSubmit.push(hooks.hooks.UserPromptSubmit[0])
    await fs.writeJson(join(codexHome, 'hooks.json'), hooks)

    const output = await captureConsole(doctor)

    expect(output).toContain('Incomplete; missing:')
    expect(output).toContain('AGENTS.md (CCG block)')
    expect(output).toContain('hooks.json (CCG registration)')
  })

  it('reports a noncanonical Codex start marker as incomplete', async () => {
    await createInstalledFixture()
    await createCodexModeFixture()
    await fs.writeFile(join(testHome, '.codex', 'AGENTS.md'), '<!-- CCG:START-old -->\n# CCG\n<!-- CCG:END -->\n')

    const output = await captureConsole(doctor)

    expect(output).toContain('Incomplete; missing:')
    expect(output).toContain('AGENTS.md (CCG block)')
  })
})

describe('status', () => {
  it('reports user-owned Codex instructions as not installed CCG mode', async () => {
    await createInstalledFixture()
    await fs.ensureDir(join(testHome, '.codex'))
    await fs.writeFile(join(testHome, '.codex', 'AGENTS.md'), '# User instructions\n')

    const output = await captureConsole(status)

    expect(output).toMatch(/Codex mode\s+not installed/)
  })

  it('reports complete CCG Codex runtime as installed', async () => {
    await createInstalledFixture()
    await createCodexModeFixture()

    const output = await captureConsole(status)

    expect(output).toMatch(/Codex mode\s+installed/)
  })

  it('reports matching private versions and session-neutral task metadata', async () => {
    await createInstalledFixture()
    const stateId = '11111111-1111-4111-8111-111111111111'
    await fs.ensureDir(join(projectRoot, '.ccg', 'tasks', 'sync-upstream'))
    await fs.ensureDir(join(projectRoot, '.ccg', 'sessions'))
    await fs.writeJson(join(projectRoot, '.ccg', 'state.json'), {
      schemaVersion: 2,
      stateId,
      revision: 1,
      updatedAt: new Date().toISOString(),
    })
    await fs.writeJson(join(projectRoot, '.ccg', 'tasks', 'sync-upstream', 'task.json'), {
      id: 'sync-upstream',
      status: 'open',
    })
    await fs.writeJson(join(projectRoot, '.ccg', 'sessions', `claude-${'a'.repeat(64)}.json`), {
      schemaVersion: 1,
      stateId,
      revision: 1,
      activeTaskId: 'sync-upstream',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    process.chdir(projectRoot)

    const output = await captureConsole(status)

    expect(output).toContain('3.6.7-aug.1')
    expect(output).toContain('(matches)')
    expect(output).toContain('v5.15.0-aug.1')
    expect(output).toContain('schema=v2, open=1, bindings=1')
    expect(output).not.toContain('Active task')
  })

  it('reports the current session task when CCG_SESSION_KEY is available', async () => {
    await createInstalledFixture()
    await fs.ensureDir(join(projectRoot, '.ccg'))
    await fs.writeJson(join(projectRoot, '.ccg', 'state.json'), {
      schemaVersion: 2,
      stateId: '11111111-1111-4111-8111-111111111111',
      revision: 1,
      updatedAt: new Date().toISOString(),
    })
    process.env.CCG_SESSION_KEY = `claude-${'b'.repeat(64)}`
    execFileSyncMock.mockImplementation((command, args) => {
      if (String(command) === process.execPath && Array.isArray(args) && args.includes('resolve')) {
        return Buffer.from(`${JSON.stringify({ ok: true, kind: 'active', activeTaskId: 'session-task' })}\n`)
      }
      return Buffer.from('codeagent-wrapper version 5.15.0-aug.1\n')
    })
    process.chdir(projectRoot)

    const output = await captureConsole(status)

    expect(output).toContain('in_progress: session-task')
  })

  it('reports an invalid session key instead of falling back to session-neutral metadata', async () => {
    await createInstalledFixture()
    await fs.ensureDir(join(projectRoot, '.ccg'))
    await fs.writeJson(join(projectRoot, '.ccg', 'state.json'), {
      schemaVersion: 2,
      stateId: '11111111-1111-4111-8111-111111111111',
      revision: 1,
      updatedAt: new Date().toISOString(),
    })
    process.env.CCG_SESSION_KEY = 'raw-session-id'
    process.chdir(projectRoot)

    const output = await captureConsole(status)

    expect(output).toContain('session-key-invalid')
    expect(output).not.toContain('schema=v2')
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
