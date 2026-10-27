import fs from 'fs-extra'
import { readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { getAllCommandIds, installWorkflows, uninstallWorkflows } from '../installer'

// D. installWorkflows E2E — contextweaver provider
// ─────────────────────────────────────────────────────────────
describe('installWorkflows E2E — mcpProvider="contextweaver"', () => {
  const tmpDir = join(tmpdir(), `ccg-test-cw-${Date.now()}`)

  afterAll(async () => {
    await fs.remove(tmpDir)
  })

  it('installs all workflows without errors', async () => {
    const result = await installWorkflows(getAllCommandIds(), tmpDir, true, {
      mcpProvider: 'contextweaver',
      skipBinary: true,
    })
    expect(result.success).toBe(true)
    expect(result.errors).toEqual([])
  }, 30_000)

  it('generated command files contain contextweaver references', async () => {
    const planContent = readFileSync(join(tmpDir, 'commands', 'ccg', 'plan.md'), 'utf-8')
    expect(planContent).toContain('mcp__contextweaver__codebase-retrieval')
    expect(planContent).not.toContain('{{MCP_SEARCH_TOOL}}')
    expect(planContent).not.toContain('mcp__ace-tool')
  })

  it('generated agent planner uses contextweaver in tools', async () => {
    const content = readFileSync(join(tmpDir, 'agents', 'ccg', 'planner.md'), 'utf-8')
    expect(content).toContain('mcp__contextweaver__codebase-retrieval')
  })
})

// ─────────────────────────────────────────────────────────────
// E. uninstallWorkflows E2E
// ─────────────────────────────────────────────────────────────
describe('uninstallWorkflows E2E', () => {
  const tmpDir = join(tmpdir(), `ccg-test-uninstall-${Date.now()}`)

  afterAll(async () => {
    await fs.remove(tmpDir)
  })

  it('installs then uninstalls cleanly', async () => {
    // First install
    const installResult = await installWorkflows(getAllCommandIds(), tmpDir, true, {
      mcpProvider: 'ace-tool',
      skipBinary: true,
    })
    expect(installResult.success).toBe(true)

    // Verify files exist
    expect(fs.existsSync(join(tmpDir, 'commands', 'ccg', 'workflow.md'))).toBe(true)

    // Now uninstall
    const uninstallResult = await uninstallWorkflows(tmpDir)
    expect(uninstallResult.success).toBe(true)
    expect(uninstallResult.removedCommands.length).toBeGreaterThan(0)

    // Verify commands directory removed
    expect(fs.existsSync(join(tmpDir, 'commands', 'ccg'))).toBe(false)
  })

  it('uninstall removes CCG hooks and preserves user hooks', async () => {
    const hookDir = join(tmpDir, 'hooks', 'ccg')
    await fs.ensureDir(hookDir)
    await fs.writeFile(join(hookDir, 'workflow-state.js'), '// ccg hook')
    await fs.writeJson(join(tmpDir, 'settings.json'), {
      hooks: {
        SessionStart: [
          {
            hooks: [
              { type: 'command', command: `node ${join(tmpDir, 'hooks', 'ccg', 'workflow-state.js')}` },
              { type: 'command', command: 'node /tmp/user-hook.js' },
            ],
          },
        ],
        Stop: [
          {
            hooks: [{ type: 'command', command: 'node C:\\Users\\x\\.claude\\hooks\\ccg\\workflow-state.js' }],
          },
        ],
      },
    })

    const result = await uninstallWorkflows(tmpDir)
    expect(result.success).toBe(true)
    expect(result.removedHooks).toBe(true)
    expect(fs.existsSync(hookDir)).toBe(false)

    const settings = await fs.readJson(join(tmpDir, 'settings.json'))
    expect(settings.hooks.SessionStart[0].hooks).toEqual([{ type: 'command', command: 'node /tmp/user-hook.js' }])
    expect(settings.hooks.Stop).toBeUndefined()
  })

  it('uninstall on empty dir succeeds without errors', async () => {
    const emptyDir = join(tmpdir(), `ccg-test-empty-${Date.now()}`)
    const result = await uninstallWorkflows(emptyDir)
    expect(result.success).toBe(true)
    expect(result.errors).toEqual([])
    await fs.remove(emptyDir)
  })
})

// ─────────────────────────────────────────────────────────────
// F. Binary installation
// ─────────────────────────────────────────────────────────────
describe('installWorkflows — binary installation', () => {
  const tmpDir = join(tmpdir(), `ccg-test-bin-${Date.now()}`)

  afterAll(async () => {
    await fs.remove(tmpDir)
  })

  it('installs codeagent-wrapper binary for current platform', async () => {
    const binaryName = process.platform === 'win32' ? 'codeagent-wrapper.exe' : 'codeagent-wrapper'
    const binDir = join(tmpDir, 'bin')
    const binaryPath = join(binDir, binaryName)
    await fs.ensureDir(binDir)
    await fs.writeFile(binaryPath, '#!/usr/bin/env sh\necho "codeagent-wrapper version 5.15.0-aug.1"\n', 'utf-8')
    if (process.platform !== 'win32') {
      await fs.chmod(binaryPath, 0o755)
    }

    const result = await installWorkflows(['workflow'], tmpDir, true, {
      mcpProvider: 'skip',
    })

    expect(result.binInstalled).toBe(true)
    expect(result.binPath).toBeTruthy()
    expect(fs.existsSync(join(result.binPath!, binaryName))).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────
// G. Prompts installation
// ─────────────────────────────────────────────────────────────
describe('installWorkflows — prompts installation', () => {
  const tmpDir = join(tmpdir(), `ccg-test-prompts-${Date.now()}`)

  afterAll(async () => {
    await fs.remove(tmpDir)
  })

  it('installs Claude prompts for the default routes', async () => {
    const result = await installWorkflows(getAllCommandIds(), tmpDir, true, {
      mcpProvider: 'skip',
      skipBinary: true,
    })
    expect(result.success).toBe(true)
    expect(result.installedPrompts.length).toBeGreaterThan(0)

    const promptsDir = join(tmpDir, '.ccg', 'prompts')
    expect(fs.existsSync(join(promptsDir, 'claude'))).toBe(true)
    expect(fs.existsSync(join(promptsDir, 'codex'))).toBe(false)
    expect(fs.existsSync(join(promptsDir, 'antigravity'))).toBe(false)

    const claudeFiles = readdirSync(join(promptsDir, 'claude')).filter((file) => file.endsWith('.md'))
    expect(claudeFiles.length).toBeGreaterThanOrEqual(5)
  })
})

// ─────────────────────────────────────────────────────────────
// H. Persistent task Hook installation
// ─────────────────────────────────────────────────────────────
describe('installWorkflows — persistent task Hooks', () => {
  const tmpDir = join(tmpdir(), `ccg test hooks ${Date.now()}`)
  const invalidDir = join(tmpdir(), `ccg-test-invalid-settings-${Date.now()}`)

  afterAll(async () => {
    await Promise.all([fs.remove(tmpDir), fs.remove(invalidDir)])
  })

  it('installs the complete CommonJS runtime and registers supported events', async () => {
    const result = await installWorkflows(['go'], tmpDir, true, {
      mcpProvider: 'skip',
      skipBinary: true,
    })
    expect(result.success).toBe(true)

    const hookDir = join(tmpDir, 'hooks', 'ccg')
    for (const file of [
      'package.json',
      'task-utils.js',
      'task-state.js',
      'workflow-state.js',
      'session-start.js',
      'subagent-context.js',
      'skill-router.js',
    ]) {
      expect(fs.existsSync(join(hookDir, file)), `${file} missing`).toBe(true)
    }
    expect(await fs.readJson(join(hookDir, 'package.json'))).toEqual({ type: 'commonjs' })

    const settings = await fs.readJson(join(tmpDir, 'settings.json'))
    expect(settings.hooks.SessionStart).toEqual([
      {
        matcher: 'startup|resume|clear|compact|fork',
        hooks: [{ type: 'command', command: `node "${join(hookDir, 'session-start.js')}"`, timeout: 15 }],
      },
    ])
    expect(settings.hooks.PreToolUse).toEqual([
      {
        matcher: 'Bash|Agent',
        hooks: [{ type: 'command', command: `node "${join(hookDir, 'subagent-context.js')}"`, timeout: 15 }],
      },
    ])
    expect(settings.hooks.UserPromptSubmit[0].hooks).toEqual([
      { type: 'command', command: `node "${join(hookDir, 'workflow-state.js')}"`, timeout: 10 },
      { type: 'command', command: `node "${join(hookDir, 'skill-router.js')}"`, timeout: 5 },
    ])
    expect(settings.hooks.PostToolUse).toEqual([
      {
        matcher: 'Bash|Agent|TaskOutput',
        hooks: [{ type: 'command', command: `node "${join(hookDir, 'workflow-state.js')}"`, timeout: 10 }],
      },
    ])
    expect(settings.hooks.PostToolUseFailure).toEqual([
      {
        matcher: 'Bash|Agent',
        hooks: [{ type: 'command', command: `node "${join(hookDir, 'workflow-state.js')}"`, timeout: 10 }],
      },
    ])
  })

  it('replaces old CCG commands while preserving every user Hook entry', async () => {
    const oldCcg = `node ${join(tmpDir, 'hooks', 'ccg', 'old-session.js')}`
    await fs.writeJson(join(tmpDir, 'settings.json'), {
      hooks: {
        SessionStart: [
          {
            matcher: 'startup',
            hooks: [
              { type: 'command', command: oldCcg },
              { type: 'command', command: 'node /tmp/user-startup.js' },
            ],
          },
          {
            matcher: 'compact',
            hooks: [{ type: 'command', command: 'node /tmp/user-compact.js' }],
          },
        ],
      },
    })

    const result = await installWorkflows(['go'], tmpDir, true, {
      mcpProvider: 'skip',
      skipBinary: true,
    })
    expect(result.success).toBe(true)

    const settings = await fs.readJson(join(tmpDir, 'settings.json'))
    const serialized = JSON.stringify(settings.hooks.SessionStart)
    expect(serialized).not.toContain('old-session.js')
    expect(serialized).toContain('/tmp/user-startup.js')
    expect(serialized).toContain('/tmp/user-compact.js')
    expect(settings.hooks.SessionStart).toHaveLength(3)
  })

  it('does not overwrite malformed settings JSON', async () => {
    await fs.ensureDir(invalidDir)
    const settingsPath = join(invalidDir, 'settings.json')
    await fs.writeFile(settingsPath, '{malformed', 'utf-8')

    const result = await installWorkflows(['go'], invalidDir, true, {
      mcpProvider: 'skip',
      skipBinary: true,
    })
    expect(result.success).toBe(false)
    expect(result.errors.join('\n')).toContain('invalid JSON')
    expect(await fs.readFile(settingsPath, 'utf-8')).toBe('{malformed')
  })
})

// ─────────────────────────────────────────────────────────────
// I. Skills namespace isolation (skills/ccg/)
// ─────────────────────────────────────────────────────────────
describe('skills namespace isolation', () => {
  const tmpDir = join(tmpdir(), `ccg-test-skills-${Date.now()}`)

  afterAll(async () => {
    await fs.remove(tmpDir)
  })

  it('installs skills under skills/ccg/ namespace', { timeout: 30_000 }, async () => {
    const result = await installWorkflows(['workflow'], tmpDir, true, {
      mcpProvider: 'skip',
      skipBinary: true,
    })
    expect(result.success).toBe(true)
    expect(result.installedSkills).toBeGreaterThanOrEqual(6)

    // Skills must be under skills/ccg/, not skills/ root
    expect(fs.existsSync(join(tmpDir, 'skills', 'ccg', 'SKILL.md'))).toBe(true)
    expect(fs.existsSync(join(tmpDir, 'skills', 'ccg', 'package.json'))).toBe(true)
    expect(fs.existsSync(join(tmpDir, 'skills', 'ccg', 'tools'))).toBe(true)
    expect(fs.existsSync(join(tmpDir, 'skills', 'ccg', 'orchestration'))).toBe(true)

    // Red-team notes remain in git but are never installed by default.
    expect(fs.existsSync(join(tmpDir, 'skills', 'ccg', 'domains', 'security'))).toBe(false)
    expect(fs.existsSync(join(tmpDir, 'skills', 'ccg', 'domains', 'ai'))).toBe(true)
  })

  it('uninstall only removes skills/ccg/, preserves user skills', async () => {
    // Simulate a user-created skill at skills/my-custom-skill/SKILL.md
    const userSkillDir = join(tmpDir, 'skills', 'my-custom-skill')
    await fs.ensureDir(userSkillDir)
    await fs.writeFile(join(userSkillDir, 'SKILL.md'), '# My Custom Skill')

    // Uninstall CCG
    const result = await uninstallWorkflows(tmpDir)
    expect(result.success).toBe(true)
    expect(result.removedSkills.length).toBeGreaterThan(0)

    // CCG skills gone
    expect(fs.existsSync(join(tmpDir, 'skills', 'ccg'))).toBe(false)

    // User skill preserved!
    expect(fs.existsSync(join(userSkillDir, 'SKILL.md'))).toBe(true)

    // Cleanup
    await fs.remove(userSkillDir)
  })

  it('migrates old v1.7.73 layout to skills/ccg/', { timeout: 30_000 }, async () => {
    const migrateDir = join(tmpdir(), `ccg-test-migrate-${Date.now()}`)

    // Simulate old layout: skills/{tools,orchestration,SKILL.md,run_skill.js}
    const oldSkills = join(migrateDir, 'skills')
    await fs.ensureDir(join(oldSkills, 'tools', 'verify-security'))
    await fs.ensureDir(join(oldSkills, 'orchestration', 'multi-agent'))
    await fs.writeFile(join(oldSkills, 'SKILL.md'), '# Old Root')
    await fs.writeFile(join(oldSkills, 'run_skill.js'), '// old')
    await fs.writeFile(join(oldSkills, 'tools', 'verify-security', 'SKILL.md'), '# Old Security')
    await fs.writeFile(join(oldSkills, 'orchestration', 'multi-agent', 'SKILL.md'), '# Old Multi-Agent')

    // Also add a user skill that should NOT be migrated
    await fs.ensureDir(join(oldSkills, 'brainstorming'))
    await fs.writeFile(join(oldSkills, 'brainstorming', 'SKILL.md'), '# User Brainstorming')

    // Install triggers migration
    const result = await installWorkflows(['workflow'], migrateDir, true, {
      mcpProvider: 'skip',
      skipBinary: true,
    })
    expect(result.success).toBe(true)

    // CCG skills moved to skills/ccg/
    expect(fs.existsSync(join(migrateDir, 'skills', 'ccg', 'SKILL.md'))).toBe(true)
    expect(fs.existsSync(join(migrateDir, 'skills', 'ccg', 'tools'))).toBe(true)
    expect(fs.existsSync(join(migrateDir, 'skills', 'ccg', 'orchestration'))).toBe(true)

    // User skill untouched at original location
    expect(fs.existsSync(join(migrateDir, 'skills', 'brainstorming', 'SKILL.md'))).toBe(true)

    // Old CCG items no longer at root level
    expect(fs.existsSync(join(migrateDir, 'skills', 'tools'))).toBe(false)
    expect(fs.existsSync(join(migrateDir, 'skills', 'orchestration'))).toBe(false)

    await fs.remove(migrateDir)
  })
})
