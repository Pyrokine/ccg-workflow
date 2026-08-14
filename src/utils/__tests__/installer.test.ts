import fs from 'fs-extra'
import { readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  getAllCommandIds,
  getWorkflowById,
  getWorkflowConfigs,
  injectConfigVariables,
  installWorkflows,
  uninstallWorkflows,
} from '../installer'

// Helper: find package root
function findPackageRoot(): string {
  let dir = import.meta.dirname
  for (let i = 0; i < 10; i++) {
    try {
      readFileSync(join(dir, 'package.json'))
      return dir
    } catch {
      dir = join(dir, '..')
    }
  }
  throw new Error('Could not find package root')
}

const PACKAGE_ROOT = findPackageRoot()
const TEMPLATES_DIR = join(PACKAGE_ROOT, 'templates', 'commands')
const LEGACY_TEMPLATES_DIR = join(PACKAGE_ROOT, 'templates', 'commands-legacy')

// ─────────────────────────────────────────────────────────────
// A. Workflow registry consistency
// ─────────────────────────────────────────────────────────────
describe('workflow registry', () => {
  it('getAllCommandIds returns at least 20 commands', () => {
    const ids = getAllCommandIds()
    expect(ids.length).toBeGreaterThanOrEqual(20)
  })

  it('every command ID has a matching template file', () => {
    const ids = getAllCommandIds()
    for (const id of ids) {
      const workflow = getWorkflowById(id)
      expect(workflow, `workflow config missing for: ${id}`).toBeDefined()
      for (const cmd of workflow!.commands) {
        const corePath = join(TEMPLATES_DIR, `${cmd}.md`)
        const legacyPath = join(LEGACY_TEMPLATES_DIR, `${cmd}.md`)
        expect(
          fs.existsSync(corePath) || fs.existsSync(legacyPath),
          `template missing: ${cmd}.md (checked commands/ and commands-legacy/)`
        ).toBe(true)
      }
    }
  })

  it('every template file has a matching workflow config', () => {
    const coreFiles = readdirSync(TEMPLATES_DIR)
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.replace('.md', ''))
    const legacyFiles = fs.existsSync(LEGACY_TEMPLATES_DIR)
      ? readdirSync(LEGACY_TEMPLATES_DIR)
          .filter((f) => f.endsWith('.md'))
          .map((f) => f.replace('.md', ''))
      : []
    const allTemplates = [...coreFiles, ...legacyFiles]
    const allCommands = getAllCommandIds().flatMap((id) => getWorkflowById(id)!.commands)

    for (const template of allTemplates) {
      expect(allCommands.includes(template), `template "${template}.md" has no workflow config`).toBe(true)
    }
  })

  it('getWorkflowConfigs returns sorted by order', () => {
    const configs = getWorkflowConfigs()
    for (let i = 1; i < configs.length; i++) {
      expect(configs[i].order).toBeGreaterThanOrEqual(configs[i - 1].order)
    }
  })

  it('all workflows have both name and nameEn', () => {
    const configs = getWorkflowConfigs()
    for (const config of configs) {
      expect(config.name, `${config.id} missing name`).toBeTruthy()
      expect(config.nameEn, `${config.id} missing nameEn`).toBeTruthy()
    }
  })

  it('all workflow IDs are unique', () => {
    const ids = getAllCommandIds()
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('getWorkflowById returns undefined for unknown id', () => {
    expect(getWorkflowById('nonexistent')).toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────
// B. injectConfigVariables — routing & liteMode
// ─────────────────────────────────────────────────────────────
describe('injectConfigVariables — routing variables', () => {
  it('injects frontend primary model', () => {
    const input = 'primary: {{FRONTEND_PRIMARY}}'
    const result = injectConfigVariables(input, {
      routing: { frontend: { models: ['antigravity'], primary: 'antigravity' } },
    })
    expect(result).toBe('primary: antigravity')
  })

  it('injects backend primary model', () => {
    const input = 'primary: {{BACKEND_PRIMARY}}'
    const result = injectConfigVariables(input, {
      routing: { backend: { models: ['codex'], primary: 'codex' } },
    })
    expect(result).toBe('primary: codex')
  })

  it('injects frontend models as JSON', () => {
    const input = 'models: {{FRONTEND_MODELS}}'
    const result = injectConfigVariables(input, {
      routing: { frontend: { models: ['antigravity', 'claude'] } },
    })
    expect(result).toBe('models: ["antigravity","claude"]')
  })

  it('injects review profiles and Claude provider arguments', () => {
    const input = [
      'profiles: {{REVIEW_PROFILES}}',
      'gpt: {{REVIEW_GPT_MODEL}} / {{REVIEW_GPT_EFFORT}}',
      'grok: {{REVIEW_GROK_MODEL}} / {{REVIEW_GROK_EFFORT}}',
    ].join('\n')
    const result = injectConfigVariables(input, {
      routing: {
        review: {
          profiles: [
            { id: 'gpt', model: 'gpt-5.6-sol', effort: 'xhigh' },
            { id: 'grok', model: 'grok-4.5', effort: 'high' },
          ],
        },
      },
    })
    expect(result).toBe(
      [
        'profiles: [{"id":"gpt","model":"gpt-5.6-sol","effort":"xhigh"},{"id":"grok","model":"grok-4.5","effort":"high"}]',
        'gpt: gpt-5.6-sol / xhigh',
        'grok: grok-4.5 / high',
      ].join('\n')
    )
  })

  it('fills missing external review profiles with the configured defaults', () => {
    const input = [
      'profiles: {{REVIEW_PROFILES}}',
      'gpt: {{REVIEW_GPT_MODEL}} / {{REVIEW_GPT_EFFORT}}',
      'grok: {{REVIEW_GROK_MODEL}} / {{REVIEW_GROK_EFFORT}}',
    ].join('\n')
    const result = injectConfigVariables(input, {
      routing: {
        review: {
          profiles: [{ id: 'gpt', model: 'gpt-5.6-sol', effort: 'xhigh' }],
        },
      },
    })
    expect(result).toBe(
      [
        'profiles: [{"id":"gpt","model":"gpt-5.6-sol","effort":"xhigh"},{"id":"grok","model":"grok-4.5","effort":"high"}]',
        'gpt: gpt-5.6-sol / xhigh',
        'grok: grok-4.5 / high',
      ].join('\n')
    )
  })

  it('strips the Gemini model flag placeholder', () => {
    expect(injectConfigVariables('{{GEMINI_MODEL_FLAG}}', {})).toBe('')
  })

  it('injects routing mode', () => {
    const input = 'mode: {{ROUTING_MODE}}'
    const result = injectConfigVariables(input, {
      routing: { mode: 'smart' },
    })
    expect(result).toBe('mode: smart')
  })

  it('defaults to standard routing when not specified', () => {
    const input = '{{FRONTEND_PRIMARY}} / {{BACKEND_PRIMARY}}'
    const result = injectConfigVariables(input, {})
    expect(result).toBe('antigravity / codex')
  })
})

describe('injectConfigVariables — liteMode', () => {
  it('injects --lite flag when liteMode is true', () => {
    const input = 'codeagent-wrapper {{LITE_MODE_FLAG}}--backend codex'
    const result = injectConfigVariables(input, { liteMode: true })
    expect(result).toBe('codeagent-wrapper --lite --backend codex')
  })

  it('injects empty string when liteMode is false', () => {
    const input = 'codeagent-wrapper {{LITE_MODE_FLAG}}--backend codex'
    const result = injectConfigVariables(input, { liteMode: false })
    expect(result).toBe('codeagent-wrapper --backend codex')
  })

  it('injects --lite flag when liteMode is not specified', () => {
    const input = 'codeagent-wrapper {{LITE_MODE_FLAG}}--backend codex'
    const result = injectConfigVariables(input, {})
    expect(result).toBe('codeagent-wrapper --lite --backend codex')
  })
})

// ─────────────────────────────────────────────────────────────
// C. Template variable completeness
// ─────────────────────────────────────────────────────────────
describe('template variable completeness', () => {
  function collectTemplateFiles(dir: string): string[] {
    const files: string[] = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        files.push(...collectTemplateFiles(fullPath))
      } else if (entry.name.endsWith('.md')) {
        files.push(fullPath)
      }
    }
    return files
  }

  const allTemplates = collectTemplateFiles(TEMPLATES_DIR)

  it('finds template files', () => {
    expect(allTemplates.length).toBeGreaterThan(0)
  })

  it('all codeagent-wrapper backend invocations include lite flag placeholder', () => {
    for (const file of allTemplates) {
      const content = readFileSync(file, 'utf-8')
      const relativePath = file.replace(PACKAGE_ROOT + '/', '')
      const invocations = content.match(/codeagent-wrapper[^\n"]*--backend[^\n"]*/g) || []
      const missing = invocations.filter((cmd) => !cmd.includes('{{LITE_MODE_FLAG}}'))
      expect(missing, `${relativePath}: ${missing.join('\n')}`).toEqual([])
    }
  })

  for (const file of allTemplates) {
    const relativePath = file.replace(PACKAGE_ROOT + '/', '')

    it(`${relativePath}: no unprocessed {{variables}} after full injection`, () => {
      const content = readFileSync(file, 'utf-8')
      const result = injectConfigVariables(content, {
        routing: {
          mode: 'smart',
          frontend: { models: ['antigravity', 'codex'], primary: 'antigravity' },
          backend: { models: ['codex'], primary: 'codex' },
          review: {
            profiles: [
              { id: 'gpt', model: 'gpt-5.6-sol', effort: 'xhigh' },
              { id: 'grok', model: 'grok-4.5', effort: 'high' },
            ],
          },
        },
        liteMode: false,
        mcpProvider: 'ace-tool',
      })

      // Find any remaining {{ }} template variables
      const remaining = result.match(/\{\{[A-Z_]+\}\}/g) || []
      // Filter out known non-CCG variables (user-facing placeholders like {{项目路径}})
      const ccgVars = remaining.filter((v) => !v.includes('项目') && !v.includes('相关') && !v.includes('WORKDIR'))
      expect(ccgVars, `unprocessed variables in ${relativePath}: ${ccgVars.join(', ')}`).toEqual([])
    })
  }
})

// ─────────────────────────────────────────────────────────────
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
    await fs.writeFile(binaryPath, '#!/usr/bin/env sh\necho "codeagent-wrapper version 5.14.0-aug.1"\n', 'utf-8')
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

  it('installs codex, antigravity, and claude prompts', async () => {
    const result = await installWorkflows(getAllCommandIds(), tmpDir, true, {
      mcpProvider: 'skip',
      skipBinary: true,
    })
    expect(result.success).toBe(true)
    expect(result.installedPrompts.length).toBeGreaterThan(0)

    const promptsDir = join(tmpDir, '.ccg', 'prompts')
    expect(fs.existsSync(join(promptsDir, 'codex'))).toBe(true)
    expect(fs.existsSync(join(promptsDir, 'antigravity'))).toBe(true)

    const codexFiles = readdirSync(join(promptsDir, 'codex')).filter((f) => f.endsWith('.md'))
    const antigravityFiles = readdirSync(join(promptsDir, 'antigravity')).filter((f) => f.endsWith('.md'))
    expect(codexFiles.length).toBeGreaterThanOrEqual(5)
    expect(antigravityFiles.length).toBeGreaterThanOrEqual(5)
  })
})

// ─────────────────────────────────────────────────────────────
// H. Skills namespace isolation (skills/ccg/)
// ─────────────────────────────────────────────────────────────
describe('skills namespace isolation', () => {
  const tmpDir = join(tmpdir(), `ccg-test-skills-${Date.now()}`)

  afterAll(async () => {
    await fs.remove(tmpDir)
  })

  it('installs skills under skills/ccg/ namespace', async () => {
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
