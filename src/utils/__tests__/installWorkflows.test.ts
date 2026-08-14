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
  })
})

// ─────────────────────────────────────────────────────────────
// E2E: routing-only template refresh
// ─────────────────────────────────────────────────────────────
describe('syncRoutingTemplates', () => {
  const tmpDir = join(tmpdir(), `ccg-test-routing-sync-${Date.now()}`)

  afterAll(async () => {
    await fs.remove(tmpDir)
  })

  it('updates only routing-dependent artifacts', async () => {
    const settingsPath = join(tmpDir, 'settings.json')
    const binaryPath = join(tmpDir, 'bin', 'codeagent-wrapper')
    await fs.ensureDir(join(tmpDir, 'bin'))
    await fs.writeFile(settingsPath, 'preserve settings', 'utf-8')
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
    expect(readFileSync(settingsPath, 'utf-8')).toBe('preserve settings')
    expect(readFileSync(binaryPath, 'utf-8')).toBe('preserve binary')
    expect(await fs.pathExists(join(tmpDir, 'commands', 'ccg', 'go.md'))).toBe(true)
    expect(await fs.pathExists(join(tmpDir, '.ccg', 'engine', 'model-router.md'))).toBe(true)
    const installedCcgDir = join(tmpDir, '.ccg').replace(/\\/g, '/')
    const reviewStrategy = readFileSync(join(tmpDir, '.ccg', 'engine', 'strategies', 'review-audit.md'), 'utf-8')
    expect(reviewStrategy).toContain(`Read("${installedCcgDir}/engine/model-router.md")`)
    for (const file of collectMdFiles(join(tmpDir, '.ccg', 'engine'))) {
      expect(readFileSync(file, 'utf-8'), file).not.toMatch(/(?:~|\/home\/py)\/\.claude/)
    }
    expect(await fs.pathExists(join(tmpDir, '.ccg', 'prompts', 'grok', 'analyzer.md'))).toBe(true)
    expect(await fs.pathExists(join(tmpDir, '.ccg', 'prompts', 'opencode', 'analyzer.md'))).toBe(true)
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
