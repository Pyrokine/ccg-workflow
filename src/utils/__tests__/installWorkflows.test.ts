import fs from 'fs-extra'
import { readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { getAllCommandIds, installWorkflows, syncRoutingTemplates } from '../installer'

const ALL_IDS = getAllCommandIds()

// Collect all .md files recursively
function collectMdFiles(dir: string): string[] {
  const files: string[] = []
  if (!fs.existsSync(dir)) return files
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...collectMdFiles(full))
    else if (entry.name.endsWith('.md')) files.push(full)
  }
  return files
}

// ─────────────────────────────────────────────────────────────
// E2E: installWorkflows with additional backend prompts
// ─────────────────────────────────────────────────────────────
describe('installWorkflows E2E — additional backend prompts', () => {
  const tmpDir = join(tmpdir(), `ccg-test-prompts-${Date.now()}`)

  afterAll(async () => {
    await fs.remove(tmpDir)
  })

  it('installs prompts for all supported wrapper backends', async () => {
    const result = await installWorkflows(['go'], tmpDir, true, {
      mcpProvider: 'skip',
      skipBinary: true,
      routing: {
        mode: 'smart',
        frontend: { models: ['grok'], primary: 'grok' },
        backend: { models: ['opencode'], primary: 'opencode' },
        review: {
          profiles: [
            { id: 'gpt', model: 'gpt-5.6-sol', effort: 'xhigh' },
            { id: 'grok', model: 'grok-4.5', effort: 'high' },
          ],
        },
        grokModel: 'grok-4.5',
        kimiModel: 'kimi-code',
        opencodeModel: 'anthropic/claude-opus-5',
      },
    })

    expect(result.success).toBe(true)
    for (const model of ['claude', 'grok', 'opencode']) {
      const prompt = join(tmpDir, '.ccg', 'prompts', model, 'analyzer.md')
      expect(await fs.pathExists(prompt), `${model} analyzer prompt missing`).toBe(true)
      expect(result.installedPrompts).toContain(`${model}/analyzer`)
    }
    for (const model of ['codex', 'antigravity', 'kimi']) {
      expect(await fs.pathExists(join(tmpDir, '.ccg', 'prompts', model))).toBe(false)
    }

    const builder = readFileSync(join(tmpDir, '.ccg', 'prompts', 'opencode', 'builder.md'), 'utf-8')
    expect(builder).toContain('Exact sections in `<ccg-specs>`')
    expect(builder).toContain('The dispatch must supply the active task ID and task revision')
    expect(builder).not.toContain('If the project has `.ccg/spec/`')
  })
})

// ─────────────────────────────────────────────────────────────
// E2E: retired Skill Registry commands
// ─────────────────────────────────────────────────────────────
describe('installWorkflows E2E — retired Impeccable commands', () => {
  const tmpDir = join(tmpdir(), `ccg-test-retired-skills-${Date.now()}`)

  afterAll(async () => {
    await fs.remove(tmpDir)
  })

  it('removes generated commands that are no longer invocable and preserves user files', async () => {
    const commandsDir = join(tmpDir, 'commands', 'ccg')
    const retiredPath = join(commandsDir, 'adapt.md')
    const userPath = join(commandsDir, 'polish.md')
    await fs.ensureDir(commandsDir)
    await fs.writeFile(
      retiredPath,
      `Read ${join(tmpDir, 'skills', 'ccg', 'impeccable', 'adapt', 'SKILL.md').replaceAll('\\', '/')}\n`,
      'utf-8'
    )
    await fs.writeFile(userPath, 'user-owned command\n', 'utf-8')

    const result = await installWorkflows(['go'], tmpDir, true, {
      mcpProvider: 'skip',
      skipBinary: true,
    })

    expect(result.success).toBe(true)
    expect(await fs.pathExists(retiredPath)).toBe(false)
    expect(await fs.readFile(userPath, 'utf-8')).toBe('user-owned command\n')
  })
})

// ─────────────────────────────────────────────────────────────
// E2E: routing-only template refresh
// ─────────────────────────────────────────────────────────────
describe('syncRoutingTemplates', () => {
  const tmpDir = join(tmpdir(), `ccg-test-routing-sync-${Date.now()}`)
  const invalidDir = join(tmpdir(), `ccg-test-routing-invalid-${Date.now()}`)

  afterAll(async () => {
    await Promise.all([fs.remove(tmpDir), fs.remove(invalidDir)])
  })

  it('updates routing artifacts and Hook runtime without touching the binary', async () => {
    const settingsPath = join(tmpDir, 'settings.json')
    const binaryPath = join(tmpDir, 'bin', 'codeagent-wrapper')
    const oldHookPath = join(tmpDir, 'hooks', 'ccg', 'workflow-state.js')
    await fs.ensureDir(join(tmpDir, 'bin'))
    await fs.ensureDir(join(tmpDir, 'hooks', 'ccg'))
    await fs.writeJson(settingsPath, {
      preserved: true,
      hooks: {
        PostToolUse: [
          {
            matcher: 'Write',
            hooks: [{ type: 'command', command: 'node /tmp/user-post-tool.js' }],
          },
        ],
      },
    })
    await fs.writeFile(oldHookPath, '// old CCG Hook\n', 'utf-8')
    await fs.writeFile(binaryPath, 'preserve binary', 'utf-8')

    const result = await syncRoutingTemplates(['go'], tmpDir, {
      routing: {
        mode: 'smart',
        frontend: { models: ['grok'], primary: 'grok' },
        backend: { models: ['opencode'], primary: 'opencode' },
        review: {
          profiles: [
            { id: 'gpt', model: 'gpt-5.6-sol', effort: 'xhigh' },
            { id: 'grok', model: 'grok-4.5', effort: 'high' },
          ],
        },
        grokModel: 'grok-4.5',
        opencodeModel: 'anthropic/claude-opus-5',
      },
    })

    expect(result.success).toBe(true)
    expect(readFileSync(binaryPath, 'utf-8')).toBe('preserve binary')
    expect(readFileSync(oldHookPath, 'utf-8')).toContain('authority refresh after prompts and external results')
    const settings = await fs.readJson(settingsPath)
    expect(settings.preserved).toBe(true)
    expect(JSON.stringify(settings.hooks.PostToolUse)).toContain('/tmp/user-post-tool.js')
    expect(JSON.stringify(settings.hooks.PostToolUse)).toContain('workflow-state.js')
    expect(settings.hooks.PostToolUseFailure.at(-1).matcher).toBe('Bash|Agent')
    const goPath = join(tmpDir, 'commands', 'ccg', 'go.md')
    expect(await fs.pathExists(goPath)).toBe(true)
    expect(await fs.pathExists(join(tmpDir, '.ccg', 'engine', 'model-router.md'))).toBe(true)
    const goCommand = readFileSync(goPath, 'utf-8')
    expect(goCommand).toContain(join(tmpDir, 'hooks', 'ccg', 'task-state.js').replace(/\\/g, '/'))
    expect(goCommand).not.toContain('~/.claude/hooks/ccg/task-state.js')
    const installedCcgDir = join(tmpDir, '.ccg').replace(/\\/g, '/')
    const reviewStrategy = readFileSync(join(tmpDir, '.ccg', 'engine', 'strategies', 'review-audit.md'), 'utf-8')
    expect(reviewStrategy).toContain(`Read("${installedCcgDir}/engine/model-router.md")`)
    for (const file of collectMdFiles(join(tmpDir, '.ccg', 'engine'))) {
      expect(readFileSync(file, 'utf-8'), file).not.toMatch(/(?:~|\/home\/py)\/\.claude/)
    }
    expect(await fs.pathExists(join(tmpDir, '.ccg', 'prompts', 'grok', 'analyzer.md'))).toBe(true)
    expect(await fs.pathExists(join(tmpDir, '.ccg', 'prompts', 'opencode', 'analyzer.md'))).toBe(true)
  })

  it('stops before replacing Hook or routing files when settings are invalid', async () => {
    const settingsPath = join(invalidDir, 'settings.json')
    const commandPath = join(invalidDir, 'commands', 'ccg', 'go.md')
    const hookPath = join(invalidDir, 'hooks', 'ccg', 'workflow-state.js')
    await fs.ensureDir(join(invalidDir, 'commands', 'ccg'))
    await fs.ensureDir(join(invalidDir, 'hooks', 'ccg'))
    await fs.writeFile(settingsPath, '{invalid', 'utf-8')
    await fs.writeFile(commandPath, 'preserve command\n', 'utf-8')
    await fs.writeFile(hookPath, 'preserve Hook\n', 'utf-8')

    const result = await syncRoutingTemplates(['go'], invalidDir, {
      routing: {
        mode: 'smart',
        frontend: { models: ['antigravity'], primary: 'antigravity' },
        backend: { models: ['codex'], primary: 'codex' },
        review: {
          profiles: [
            { id: 'gpt', model: 'gpt-5.6-sol', effort: 'xhigh' },
            { id: 'grok', model: 'grok-4.5', effort: 'high' },
          ],
        },
      },
    })

    expect(result.success).toBe(false)
    expect(result.errors.join('\n')).toContain('invalid JSON')
    expect(await fs.readFile(settingsPath, 'utf-8')).toBe('{invalid')
    expect(await fs.readFile(commandPath, 'utf-8')).toBe('preserve command\n')
    expect(await fs.readFile(hookPath, 'utf-8')).toBe('preserve Hook\n')
  })

  it('fills missing review profiles in refreshed templates', async () => {
    const result = await syncRoutingTemplates(['spec-review'], tmpDir, {
      routing: {
        mode: 'smart',
        frontend: { models: ['antigravity'], primary: 'antigravity' },
        backend: { models: ['codex'], primary: 'codex' },
        review: {
          profiles: [{ id: 'gpt', model: 'gpt-5.6-sol', effort: 'xhigh' }],
        },
      },
    })

    expect(result.success).toBe(true)
    const command = readFileSync(join(tmpDir, 'commands', 'ccg', 'spec-review.md'), 'utf-8')
    expect(command).toContain('--claude-model gpt-5.6-sol --claude-effort xhigh')
    expect(command).toContain('--claude-model grok-4.5 --claude-effort high')
  })

  it('backs up replaced commands and engine files', async () => {
    const commandPath = join(tmpDir, 'commands', 'ccg', 'go.md')
    const enginePath = join(tmpDir, '.ccg', 'engine', 'model-router.md')
    await fs.ensureDir(join(tmpDir, 'commands', 'ccg'))
    await fs.ensureDir(join(tmpDir, '.ccg', 'engine'))
    await fs.writeFile(commandPath, 'custom command', 'utf-8')
    await fs.writeFile(enginePath, 'custom engine', 'utf-8')

    const result = await syncRoutingTemplates(['go'], tmpDir, {
      routing: {
        mode: 'smart',
        frontend: { models: ['claude'], primary: 'claude' },
        backend: { models: ['claude'], primary: 'claude' },
        review: {
          profiles: [
            { id: 'gpt', model: 'gpt-5.6-sol', effort: 'xhigh' },
            { id: 'grok', model: 'grok-4.5', effort: 'high' },
          ],
        },
      },
    })

    expect(result.backupPath).toBe(join(tmpDir, '.ccg', 'backup', 'routing-templates'))
    expect(result.backedUpFiles).toEqual(
      expect.arrayContaining([
        join(result.backupPath!, 'commands', 'ccg', 'go.md'),
        join(result.backupPath!, '.ccg', 'engine', 'model-router.md'),
      ])
    )
    expect(readFileSync(join(result.backupPath!, 'commands', 'ccg', 'go.md'), 'utf-8')).toBe('custom command')
    expect(readFileSync(join(result.backupPath!, '.ccg', 'engine', 'model-router.md'), 'utf-8')).toBe('custom engine')
    const manifest = await fs.readJson(join(result.backupPath!, 'manifest.json'))
    expect(manifest['commands/ccg/go.md']).toMatchObject({
      originalSha256: expect.any(String),
      replacementSha256: expect.any(String),
    })
    expect(manifest['.ccg/engine/model-router.md']).toMatchObject({
      originalSha256: expect.any(String),
      replacementSha256: expect.any(String),
    })
    expect(readFileSync(commandPath, 'utf-8')).toContain('## Pure Claude Code mode')
  })

  it('injects Pure Claude Code mode into all refreshed commands and engine files', async () => {
    const pureClaudeRouting = {
      mode: 'smart',
      frontend: { models: ['claude'], primary: 'claude' },
      backend: { models: ['claude'], primary: 'claude' },
      review: {
        profiles: [
          { id: 'gpt' as const, model: 'gpt-5.6-sol', effort: 'xhigh' as const },
          { id: 'grok' as const, model: 'grok-4.5', effort: 'high' as const },
        ],
      },
    }
    const result = await syncRoutingTemplates(ALL_IDS, tmpDir, { routing: pureClaudeRouting })

    expect(result.success).toBe(true)
    for (const file of collectMdFiles(join(tmpDir, 'commands', 'ccg'))) {
      expect(readFileSync(file, 'utf-8'), file).toContain('## Pure Claude Code mode')
    }
    for (const file of collectMdFiles(join(tmpDir, '.ccg', 'engine'))) {
      expect(readFileSync(file, 'utf-8'), file).toContain('## Pure Claude Code mode')
    }
  })
})

// ─────────────────────────────────────────────────────────────
// E2E: installWorkflows with mcpProvider='skip'
// ─────────────────────────────────────────────────────────────
describe('installWorkflows E2E — mcpProvider="skip"', () => {
  const tmpDir = join(tmpdir(), `ccg-test-skip-${Date.now()}`)

  afterAll(async () => {
    await fs.remove(tmpDir)
  })

  it('installs all workflows without errors', async () => {
    const result = await installWorkflows(ALL_IDS, tmpDir, true, {
      mcpProvider: 'skip',
      skipBinary: true,
    })
    expect(result.success).toBe(true)
    expect(result.errors).toEqual([])
    expect(result.installedCommands.length).toBeGreaterThan(0)
  }, 15000)

  it('generated command files contain no mcp__ace-tool references', async () => {
    const cmdDir = join(tmpDir, 'commands', 'ccg')
    const files = collectMdFiles(cmdDir)
    expect(files.length).toBeGreaterThan(0)

    for (const file of files) {
      const content = readFileSync(file, 'utf-8')
      const rel = file.replace(tmpDir + '/', '')
      expect(content, `${rel} should not contain mcp__ace-tool`).not.toContain('mcp__ace-tool__search_context')
      expect(content, `${rel} should not contain {{MCP_SEARCH_TOOL}}`).not.toContain('{{MCP_SEARCH_TOOL}}')
      expect(content, `${rel} should not contain {{MCP_SEARCH_PARAM}}`).not.toContain('{{MCP_SEARCH_PARAM}}')
    }
  })

  it('generated agent files contain no mcp__ace-tool references', async () => {
    const agentDir = join(tmpDir, 'agents', 'ccg')
    const files = collectMdFiles(agentDir)
    expect(files.length).toBeGreaterThan(0)

    for (const file of files) {
      const content = readFileSync(file, 'utf-8')
      const rel = file.replace(tmpDir + '/', '')
      expect(content, `${rel} should not contain mcp__ace-tool`).not.toContain('mcp__ace-tool__search_context')
      expect(content, `${rel} should not contain {{MCP_SEARCH_TOOL}}`).not.toContain('{{MCP_SEARCH_TOOL}}')
    }
  })

  it('plan.md contains Glob + Grep fallback guidance', async () => {
    const content = readFileSync(join(tmpDir, 'commands', 'ccg', 'plan.md'), 'utf-8')
    expect(content).toContain('Glob + Grep')
    expect(content).toContain('MCP 未配置')
  })

  it('execute.md contains Glob + Grep fallback guidance', async () => {
    const content = readFileSync(join(tmpDir, 'commands', 'ccg', 'execute.md'), 'utf-8')
    expect(content).toContain('Glob + Grep')
    expect(content).toContain('MCP 未配置')
  })

  it('planner.md frontmatter has no MCP tool in tools declaration', async () => {
    const content = readFileSync(join(tmpDir, 'agents', 'ccg', 'planner.md'), 'utf-8')
    const toolsLine = content.split('\n').find((l) => l.startsWith('tools:'))
    expect(toolsLine).toBe('tools: Read, Write')
  })
})

// ─────────────────────────────────────────────────────────────
// E2E: installWorkflows with mcpProvider='ace-tool' (control)
// ─────────────────────────────────────────────────────────────
describe('installWorkflows E2E — mcpProvider="ace-tool" (control)', () => {
  const tmpDir = join(tmpdir(), `ccg-test-ace-${Date.now()}`)

  afterAll(async () => {
    await fs.remove(tmpDir)
  })

  it('installs all workflows and injects ace-tool references', async () => {
    const result = await installWorkflows(ALL_IDS, tmpDir, true, {
      mcpProvider: 'ace-tool',
      skipBinary: true,
    })
    expect(result.success).toBe(true)
    expect(result.errors).toEqual([])
  })

  it('generated files contain mcp__ace-tool__search_context (correct injection)', async () => {
    const planContent = readFileSync(join(tmpDir, 'commands', 'ccg', 'plan.md'), 'utf-8')
    expect(planContent).toContain('mcp__ace-tool__search_context')
    expect(planContent).not.toContain('{{MCP_SEARCH_TOOL}}')
  })

  it('generated agent files contain mcp__ace-tool__search_context', async () => {
    const plannerContent = readFileSync(join(tmpDir, 'agents', 'ccg', 'planner.md'), 'utf-8')
    expect(plannerContent).toContain('mcp__ace-tool__search_context')
    expect(plannerContent).not.toContain('{{MCP_SEARCH_TOOL}}')
  })
})
