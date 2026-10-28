import type { DoctorDependencies } from '../../utils/doctor-checks'
import fs from 'fs-extra'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { stringify } from 'smol-toml'
import { doctor } from '../doctor'
import { collectDoctorReport } from '../../utils/doctor-checks'
import { installSkills } from '../../utils/skill-manager'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { TASK_STATE_RUNTIME_FILES } from '../../utils/installer-data'

let home: string
let exec: ReturnType<typeof vi.fn<NonNullable<DoctorDependencies['exec']>>>
const hookFiles = [
  ...TASK_STATE_RUNTIME_FILES,
  'workflow-state.js',
  'session-start.js',
  'subagent-context.js',
  'skill-router.js',
]
const hookEvents = {
  UserPromptSubmit: ['workflow-state.js', 'skill-router.js'],
  SessionStart: ['session-start.js'],
  PreToolUse: ['subagent-context.js'],
  PostToolUse: ['workflow-state.js'],
  PostToolUseFailure: ['workflow-state.js'],
}
function deps(extra: DoctorDependencies = {}): DoctorDependencies {
  return { home, root: join(home, 'project'), nodeVersion: 'v22.13.0', platform: 'darwin', exec, ...extra }
}
async function config(frontend = 'claude', backend = 'claude', review = ['gpt', 'grok']) {
  await fs.outputFile(
    join(home, '.claude', '.ccg', 'config.toml'),
    stringify({
      general: { version: '3.6.8', language: 'zh-CN' },
      routing: {
        frontend: { primary: frontend, models: [frontend] },
        backend: { primary: backend, models: [backend] },
        review: { profiles: review.map((id) => ({ id })), strategy: 'parallel' },
      },
    })
  )
}
async function claudeInstall() {
  await fs.outputFile(join(home, '.claude', 'commands', 'ccg.md'), '# CCG')
  await fs.ensureDir(join(home, '.claude', 'hooks', 'ccg'))
  for (const name of hookFiles)
    await fs.copyFile(
      join(import.meta.dirname, '../../../templates/hooks', name),
      join(home, '.claude', 'hooks', 'ccg', name)
    )
  const hooks = Object.fromEntries(
    Object.entries(hookEvents).map(([event, names]) => [
      event,
      [
        {
          hooks: names.map((name) => ({
            type: 'command',
            command: `node "${join(home, '.claude', 'hooks', 'ccg', name)}"`,
          })),
        },
      ],
    ])
  )
  await fs.outputJSON(join(home, '.claude', 'settings.json'), { hooks, env: { SECRET_TOKEN: 'super-secret-value' } })
  await fs.outputFile(join(home, '.claude', 'rules', 'ccg-skills.md'), 'rule')
  await fs.outputFile(join(home, '.claude', 'rules', 'ccg-engine.md'), 'rule')
}
async function codexInstall() {
  await fs.outputFile(join(home, '.codex', '.ccg-version'), '3.6.8')
  await fs.outputFile(join(home, '.codex', 'config.toml'), '[features]\nfixture = true\n')
  await fs.outputFile(
    join(home, '.codex', 'AGENTS.md'),
    '<!-- CCG:START — Managed by CCG Workflow. Do not edit this block manually. -->\nCCG\n<!-- CCG:END -->\n'
  )
  for (const file of [
    '.ccg/codex-mode.json',
    'agents/ccg-implement.toml',
    'agents/ccg-review.toml',
    'agents/ccg-research.toml',
    'hooks/ccg-workflow.py',
  ]) {
    await fs.outputFile(join(home, '.codex', file), 'managed')
  }
  await fs.ensureDir(join(home, '.codex', 'hooks', 'ccg'))
  for (const name of TASK_STATE_RUNTIME_FILES)
    await fs.copyFile(
      join(import.meta.dirname, '../../../templates/hooks', name),
      join(home, '.codex', 'hooks', 'ccg', name)
    )
  await fs.outputJSON(join(home, '.codex', 'hooks.json'), {
    hooks: {
      UserPromptSubmit: [
        { hooks: [{ type: 'command', command: `python3 "${join(home, '.codex', 'hooks', 'ccg-workflow.py')}"` }] },
      ],
    },
  })
  await fs.outputFile(join(home, '.claude', 'bin', 'codeagent-wrapper'), 'binary')
}

async function nativeInstall(target: 'claude' | 'codex') {
  const templatesDir = join(home, 'templates')
  await fs.outputFile(
    join(templatesDir, 'sample', 'SKILL.md'),
    '---\nname: sample\ndescription: Sample native skill\n---\n# Sample\n'
  )
  const root = join(home, target === 'claude' ? '.claude' : '.agents')
  const paths = { templatesDir, nativeDir: join(root, 'skills'), storeDir: join(root, '.ccg-skills') }
  await installSkills(['sample'], { ...paths, target })
  return paths
}
beforeEach(async () => {
  home = await fs.mkdtemp(join(tmpdir(), 'ccg-doctor-'))
  exec = vi.fn(() => 'tool version 1.2.3')
})
afterEach(async () => {
  await fs.remove(home)
})

describe('CCG doctor inventory', () => {
  it('prints parseable JSON from a fresh CLI process and isolated HOME', () => {
    const loader = createRequire(import.meta.url).resolve('tsx')
    const cli = fileURLToPath(new URL('../../cli.ts', import.meta.url))
    const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home, CCG_SESSION_KEY: undefined }
    const child = spawnSync(process.execPath, ['--import', pathToFileURL(loader).href, cli, 'doctor', '--json'], {
      cwd: home,
      env,
      encoding: 'utf8',
      timeout: 20_000,
    })
    expect(child.error).toBeUndefined()
    expect(child.status).toBe(1)
    const report = JSON.parse(child.stdout)
    expect(report).toMatchObject({ schemaVersion: 1, mode: 'none' })
    expect(report.failureCount).toBeGreaterThan(0)
    expect(child.stdout).not.toContain('\x1B')
    expect(child.stdout).not.toContain('i18next is maintained')
  })

  it.each([
    ['v22.12.0', 'fail'],
    ['v22.13.0', 'pass'],
    ['v23.0.0', 'fail'],
    ['v24.18.0', 'fail'],
    ['v24.19.0', 'pass'],
    ['v25.0.0', 'pass'],
  ])('uses the package Node gate for %s', async (nodeVersion, expected) => {
    const report = await collectDoctorReport(deps({ nodeVersion }))
    expect(report.checks.find((c) => c.id === 'runtime.node')?.status).toBe(expected)
  })
  it('does not treat unrelated Codex AGENTS.md or a non-version marker as installed', async () => {
    await fs.outputFile(join(home, '.codex', 'AGENTS.md'), '# User rules')
    await fs.outputFile(join(home, '.codex', '.ccg-version'), 'unrelated')
    const report = await collectDoctorReport(deps())
    expect(report.mode).toBe('none')
    expect(report.checks.find((c) => c.id === 'installation.mode')?.status).toBe('fail')
    expect(exec).not.toHaveBeenCalled()
  })

  it('checks pure Claude mode without external model CLIs or the wrapper', async () => {
    await config()
    await claudeInstall()
    exec.mockReturnValue(null)
    const report = await collectDoctorReport(deps())
    expect(report.mode).toBe('claude')
    expect(report.failureCount).toBe(0)
    expect(report.checks.find((c) => c.id === 'routing.pure-claude')?.status).toBe('pass')
    expect(report.checks.some((c) => c.id === 'codex.skills')).toBe(false)
    expect(exec).not.toHaveBeenCalled()
  })

  it('checks primary CLI routes while GPT/Grok profiles remain temporary Claude sessions', async () => {
    await config('claude', 'codex')
    await claudeInstall()
    exec.mockImplementation((file: string) => (file === 'codex' ? null : '1.2.3'))
    const report = await collectDoctorReport(deps())
    expect(report.backends).toEqual(['claude', 'codex'])
    expect(report.checks.find((c) => c.id === 'cli.codex')?.status).toBe('fail')
    expect(report.checks.find((c) => c.id === 'review.profiles')?.detail).toContain('temporary Claude sessions')
    expect(exec.mock.calls.map((call) => call[0])).toEqual(['claude', 'codex'])
    expect(report.checks.some((c) => c.id === 'cli.grok')).toBe(false)
  })

  it('checks Codex artifacts without requiring Claude hooks or commands', async () => {
    await codexInstall()
    await config('codex', 'codex')
    const report = await collectDoctorReport(deps())
    expect(report.mode).toBe('codex')
    expect(report.failureCount).toBe(0)
    expect(report.checks.some((c) => c.id === 'claude.hooks')).toBe(false)
    expect(report.checks.find((c) => c.id === 'codex.hook-registration')?.status).toBe('pass')
    expect(report.checks.some((c) => c.id === 'claude.skills')).toBe(false)
  })

  it('checks standalone Codex host without treating absent Claude config or delegation tools as damaged', async () => {
    await codexInstall()
    await fs.remove(join(home, '.claude'))
    const report = await collectDoctorReport(deps())
    expect(report.mode).toBe('codex')
    expect(report.failureCount).toBe(0)
    expect(report.backends).toEqual(['codex'])
    expect(report.checks.find((c) => c.id === 'config')?.status).toBe('skip')
    expect(report.checks.find((c) => c.id === 'binary.wrapper')).toMatchObject({
      status: 'warn',
      detail: expect.stringContaining('unavailable'),
    })
    expect(report.checks.find((c) => c.id === 'codex.role-prompts')?.status).toBe('warn')
    expect(exec.mock.calls.map((call) => call[0])).toEqual(['codex'])
    exec.mockReturnValue(null)
    const missingHost = await collectDoctorReport(deps())
    expect(missingHost.checks.find((c) => c.id === 'cli.codex')?.status).toBe('fail')
  })

  it('still requires Claude config in both modes and valid Codex artifacts in standalone mode', async () => {
    await codexInstall()
    await claudeInstall()
    const both = await collectDoctorReport(deps())
    expect(both.mode).toBe('both')
    expect(both.checks.find((c) => c.id === 'config')?.status).toBe('fail')
    await fs.remove(join(home, '.claude'))
    await fs.outputFile(join(home, '.codex', 'config.toml'), 'invalid = "unterminated')
    const malformed = await collectDoctorReport(deps())
    expect(malformed.checks.find((c) => c.id === 'codex.config')?.status).toBe('fail')
  })

  it('checks installed Codex delegation drivers as warnings and shows remediation in text', async () => {
    await codexInstall()
    await fs.remove(join(home, '.claude'))
    await fs.appendFile(join(home, '.codex', 'AGENTS.md'), '--backend antigravity\n--backend claude\n')
    exec.mockImplementation((file: string) => (file === 'codex' ? '1.2.3' : null))
    const output = vi.fn()
    const report = await doctor({}, deps({ output, setExitCode: vi.fn() }))
    expect(report.failureCount).toBe(0)
    expect(report.checks.find((c) => c.id === 'cli.delegation.antigravity')?.status).toBe('warn')
    expect(report.checks.find((c) => c.id === 'cli.delegation.claude')?.status).toBe('warn')
    const text = output.mock.calls.map((call) => call[0]).join('\n')
    expect(text).toContain(`No failures; ${report.warningCount} warning(s).`)
    expect(text).toContain('Run ccg init')
    expect(text).not.toContain('All checks passed.')
  })

  it('fails malformed config and unknown backend without echoing config content', async () => {
    await config('codex', 'secret-unknown-backend')
    await claudeInstall()
    const unknown = await collectDoctorReport(deps())
    expect(unknown.checks.find((c) => c.id === 'routing.backends')?.status).toBe('fail')
    expect(JSON.stringify(unknown)).not.toContain('secret-unknown-backend')
    await fs.outputFile(join(home, '.claude', '.ccg', 'config.toml'), 'secret-token = "unterminated')
    const malformed = await collectDoctorReport(deps())
    expect(malformed.checks.find((c) => c.id === 'config')?.status).toBe('fail')
    expect(JSON.stringify(malformed)).not.toContain('secret-token')
  })

  it.each([[['gpt', 'gpt']], [['unknown-profile']]])(
    'reports invalid review profiles %j as failed',
    async (profiles) => {
      await config('claude', 'claude', profiles)
      await claudeInstall()
      const report = await collectDoctorReport(deps())
      expect(report.checks.find((c) => c.id === 'review.profiles')?.status).toBe('fail')
      expect(report.checks.find((c) => c.id === 'routing.backends')?.status).toBe('fail')
    }
  )

  it('requires all six named scripts and all six handlers across five events', async () => {
    await config()
    await claudeInstall()
    await fs.remove(join(home, '.claude', 'hooks', 'ccg', 'task-utils.js'))
    await fs.outputFile(join(home, '.claude', 'hooks', 'ccg', 'unrelated.js'), '// not a replacement')
    const report = await collectDoctorReport(deps())
    expect(report.checks.find((c) => c.id === 'claude.hooks')).toMatchObject({
      status: 'fail',
      detail: `${hookFiles.length - 1}/${hookFiles.length} scripts; missing: task-utils.js`,
    })
    await fs.outputJSON(join(home, '.claude', 'settings.json'), {
      hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'node /wrong/hooks/ccg/skill-router.js' }] }] },
    })
    const invalid = await collectDoctorReport(deps())
    expect(invalid.checks.find((c) => c.id === 'claude.hook-registration')).toMatchObject({
      status: 'fail',
      detail: '0/6 handlers across 0/5 events in settings.json',
    })
  })

  it('reports missing controller dependencies in both host installations', async () => {
    await config()
    await claudeInstall()
    await codexInstall()
    for (const host of ['.claude', '.codex']) {
      await fs.remove(join(home, host, 'hooks', 'ccg', 'task-state-store.js'))
    }
    const report = await collectDoctorReport(deps())
    for (const id of ['claude.hooks', 'codex.agents']) {
      expect(report.checks.find((check) => check.id === id)).toMatchObject({
        status: 'fail',
        detail: expect.stringContaining('task-state-store.js'),
      })
    }
  })

  it('outputs standalone JSON without ANSI or secrets and sets nonzero failure exit code', async () => {
    await config()
    await claudeInstall()
    const output = vi.fn()
    const setExitCode = vi.fn()
    const healthy = await doctor({ json: true }, deps({ output, setExitCode }))
    expect(output).toHaveBeenCalledTimes(1)
    const text = output.mock.calls[0][0]
    expect(JSON.parse(text)).toEqual(healthy)
    expect(text).not.toContain('\x1B')
    expect(text).not.toContain('super-secret-value')
    expect(healthy.schemaVersion).toBe(1)
    expect(setExitCode).toHaveBeenLastCalledWith(0)
    await fs.remove(join(home, '.claude', 'settings.json'))
    await doctor({ json: true }, deps({ output, setExitCode }))
    expect(setExitCode).toHaveBeenLastCalledWith(1)
  })

  it('uses platform-specific Windows npm shims and native executables', async () => {
    await config('antigravity', 'opencode')
    await claudeInstall()
    await collectDoctorReport(deps({ platform: 'win32' }))
    expect(exec.mock.calls.map((call) => call[0])).toEqual(['agy.exe', 'opencode.exe'])
    expect(exec.mock.calls.every((call) => JSON.stringify(call[1]) === '["--version"]')).toBe(true)
  })

  it('marks a corrupt native skill manifest as failure and legacy skills as warnings', async () => {
    await config()
    await claudeInstall()
    await fs.outputFile(join(home, '.claude', 'skills', 'ccg', 'SKILL.md'), '# Legacy CCG')
    const legacy = await collectDoctorReport(deps())
    expect(legacy.checks.find((c) => c.id === 'claude.skills')?.status).toBe('warn')
    await fs.ensureDir(join(home, '.claude', 'skills'))
    await fs.outputFile(join(home, '.claude', '.ccg-skills', 'manifest.json'), 'invalid-json')
    const corrupt = await collectDoctorReport(deps())
    expect(corrupt.checks.find((c) => c.id === 'claude.skills')?.status).toBe('fail')
  })

  it('allows healthy skills-only installs without requiring routing, commands, hooks or model CLIs', async () => {
    const templatesDir = join(home, 'templates')
    await fs.outputFile(
      join(templatesDir, 'sample', 'SKILL.md'),
      '---\nname: sample\ndescription: Sample native skill\n---\n# Sample\n'
    )
    const paths = {
      templatesDir,
      nativeDir: join(home, '.agents', 'skills'),
      storeDir: join(home, '.agents', '.ccg-skills'),
    }
    await installSkills(['sample'], { target: 'codex', ...paths })
    const report = await collectDoctorReport(deps({ skillPaths: { codex: paths } }))
    expect(report.mode).toBe('skills')
    expect(report.failureCount).toBe(0)
    expect(report.checks.find((c) => c.id === 'codex.skills')).toMatchObject({
      status: 'pass',
      detail: '1/1 managed skills healthy',
    })
    expect(report.checks.some((c) => c.id === 'binary.wrapper' || c.id === 'claude.hooks')).toBe(false)
    expect(exec).not.toHaveBeenCalled()
  })

  it.each(['claude', 'codex'] as const)(
    'checks the other native host without changing %s workflow mode',
    async (workflow) => {
      if (workflow === 'claude') {
        await config()
        await claudeInstall()
      } else await codexInstall()
      const target = workflow === 'claude' ? 'codex' : 'claude'
      const paths = await nativeInstall(target)
      const report = await collectDoctorReport(deps({ skillPaths: { [target]: paths } }))
      expect(report.mode).toBe(workflow)
      expect(report.checks.find((c) => c.id === `${target}.skills`)).toMatchObject({
        status: 'pass',
        detail: '1/1 managed skills healthy',
      })
      expect(report.failureCount).toBe(0)
    }
  )

  it.each([
    { workflow: 'claude', target: 'codex', damage: 'manifest' },
    { workflow: 'claude', target: 'codex', damage: 'alias' },
    { workflow: 'codex', target: 'claude', damage: 'manifest' },
    { workflow: 'codex', target: 'claude', damage: 'alias' },
  ] as const)(
    'fails $workflow workflow diagnostics for a damaged $target native $damage',
    async ({ workflow, target, damage }) => {
      if (workflow === 'claude') {
        await config()
        await claudeInstall()
      } else await codexInstall()
      const paths = await nativeInstall(target)
      if (damage === 'manifest') await fs.writeFile(join(paths.storeDir, 'manifest.json'), 'invalid-json')
      else await fs.unlink(join(paths.nativeDir, 'ccg-sample'))
      const output = vi.fn()
      const setExitCode = vi.fn()
      const report = await doctor({ json: true }, deps({ skillPaths: { [target]: paths }, output, setExitCode }))
      expect(report.mode).toBe(workflow)
      expect(report.checks.find((c) => c.id === `${target}.skills`)?.status).toBe('fail')
      expect(report.failureCount).toBeGreaterThan(0)
      expect(setExitCode).toHaveBeenLastCalledWith(1)
      expect(JSON.parse(output.mock.calls[0][0])).toEqual(report)
    }
  )
})
