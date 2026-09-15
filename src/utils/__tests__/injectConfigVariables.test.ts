import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { injectConfigVariables } from '../installer'

// Helper: find package root (mirrors the logic in installer.ts)
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

// ─────────────────────────────────────────────────────────────
// A. skip provider — the core bug fix
// ─────────────────────────────────────────────────────────────
describe('mcpProvider = "skip"', () => {
  const skipConfig = { mcpProvider: 'skip' }

  it('removes MCP tool from agent frontmatter tools declaration', () => {
    const input = 'tools: Read, Write, {{MCP_SEARCH_TOOL}}'
    const result = injectConfigVariables(input, skipConfig)
    expect(result).toBe('tools: Read, Write')
    expect(result).not.toContain('MCP_SEARCH_TOOL')
  })

  it('replaces code blocks containing MCP tool invocation (JS-style)', () => {
    const input = [
      '```',
      '{{MCP_SEARCH_TOOL}}({',
      '  query: "<semantic query>",',
      '  project_root_path: "/path/to/project"',
      '})',
      '```',
    ].join('\n')
    const result = injectConfigVariables(input, skipConfig)
    expect(result).toContain('> MCP 未配置。使用 `Glob` 定位文件 + `Grep` 搜索关键符号 + `Read` 读取文件内容。')
    expect(result).not.toContain('{{MCP_SEARCH_TOOL}}')
    expect(result).not.toContain('```')
  })

  it('replaces code blocks containing MCP tool invocation (JSON-style)', () => {
    const input = [
      '```',
      '{{MCP_SEARCH_TOOL}} {',
      '  "project_root_path": "{{项目路径}}",',
      '  "query": "可复用的 UI 组件"',
      '}',
      '```',
    ].join('\n')
    const result = injectConfigVariables(input, skipConfig)
    expect(result).toContain('> MCP 未配置')
    expect(result).not.toContain('{{MCP_SEARCH_TOOL}}')
  })

  it('replaces inline backtick references', () => {
    const input = '调用 `{{MCP_SEARCH_TOOL}}` 检索相关代码'
    const result = injectConfigVariables(input, skipConfig)
    expect(result).toBe('调用 `Glob + Grep`（MCP 未配置） 检索相关代码')
    expect(result).not.toContain('{{MCP_SEARCH_TOOL}}')
  })

  it('replaces bare (non-backtick, non-code-block) references as safety net', () => {
    const input = 'Use {{MCP_SEARCH_TOOL}} to search codebase.'
    const result = injectConfigVariables(input, skipConfig)
    expect(result).toBe('Use Glob + Grep to search codebase.')
    expect(result).not.toContain('{{MCP_SEARCH_TOOL}}')
  })

  it('removes {{MCP_SEARCH_PARAM}} references', () => {
    const input = 'param: {{MCP_SEARCH_PARAM}}'
    const result = injectConfigVariables(input, skipConfig)
    expect(result).toBe('param: ')
    expect(result).not.toContain('{{MCP_SEARCH_PARAM}}')
  })

  it('handles multiple patterns in a single template correctly', () => {
    // Simulates the planner.md template structure
    const input = [
      '---',
      'tools: Read, Write, {{MCP_SEARCH_TOOL}}',
      '---',
      '',
      '### Step 2',
      '',
      '```',
      '{{MCP_SEARCH_TOOL}} {',
      '  "project_root_path": "{{项目路径}}",',
      '  "query": "{{相关功能关键词}}"',
      '}',
      '```',
      '',
      '调用 `{{MCP_SEARCH_TOOL}}` 检索相关代码',
    ].join('\n')
    const result = injectConfigVariables(input, skipConfig)

    // frontmatter cleaned
    expect(result).toContain('tools: Read, Write')
    expect(result).not.toContain('tools: Read, Write,')

    // code block replaced
    expect(result).toContain('> MCP 未配置')
    expect(result).not.toContain('```\n{{MCP_SEARCH_TOOL}}')

    // inline backtick replaced
    expect(result).toContain('`Glob + Grep`（MCP 未配置）')

    // no MCP references remain
    expect(result).not.toContain('{{MCP_SEARCH_TOOL}}')
    expect(result).not.toContain('mcp__ace-tool__search_context')
  })

  it('does not inject mcp__ace-tool__search_context when skip is selected', () => {
    const input = '调用 `{{MCP_SEARCH_TOOL}}` 检索'
    const result = injectConfigVariables(input, skipConfig)
    expect(result).not.toContain('mcp__ace-tool')
    expect(result).not.toContain('mcp__contextweaver')
  })
})

// ─────────────────────────────────────────────────────────────
// B. contextweaver provider
// ─────────────────────────────────────────────────────────────
describe('mcpProvider = "contextweaver"', () => {
  const cwConfig = { mcpProvider: 'contextweaver' }

  it('replaces {{MCP_SEARCH_TOOL}} with contextweaver tool name', () => {
    const input = '调用 `{{MCP_SEARCH_TOOL}}` 检索'
    const result = injectConfigVariables(input, cwConfig)
    expect(result).toContain('mcp__contextweaver__codebase-retrieval')
    expect(result).not.toContain('{{MCP_SEARCH_TOOL}}')
  })

  it('replaces {{MCP_SEARCH_PARAM}} with information_request', () => {
    const input = '{{MCP_SEARCH_PARAM}}'
    const result = injectConfigVariables(input, cwConfig)
    expect(result).toBe('information_request')
  })
})

// ─────────────────────────────────────────────────────────────
// C. ace-tool provider (default)
// ─────────────────────────────────────────────────────────────
describe('mcpProvider = "ace-tool" (default)', () => {
  it('replaces {{MCP_SEARCH_TOOL}} with ace-tool tool name', () => {
    const input = '调用 `{{MCP_SEARCH_TOOL}}` 检索'
    const result = injectConfigVariables(input, { mcpProvider: 'ace-tool' })
    expect(result).toContain('mcp__ace-tool__search_context')
  })

  it('replaces {{MCP_SEARCH_PARAM}} with query', () => {
    const input = '{{MCP_SEARCH_PARAM}}'
    const result = injectConfigVariables(input, { mcpProvider: 'ace-tool' })
    expect(result).toBe('query')
  })

  it('defaults to ace-tool when mcpProvider is not specified', () => {
    const input = '{{MCP_SEARCH_TOOL}}'
    const result = injectConfigVariables(input, {})
    expect(result).toBe('mcp__ace-tool__search_context')
  })

  it('defaults to ace-tool when mcpProvider is undefined', () => {
    const input = '{{MCP_SEARCH_TOOL}}'
    const result = injectConfigVariables(input, { mcpProvider: undefined })
    expect(result).toBe('mcp__ace-tool__search_context')
  })
})

// ─────────────────────────────────────────────────────────────
// D. Integration test with real templates
// ─────────────────────────────────────────────────────────────
describe('integration: real templates with skip mode', () => {
  // Collect all .md files under templates/commands/ (including agents/)
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

  const legacyDir = join(PACKAGE_ROOT, 'templates', 'commands-legacy')
  const templateFiles = [
    ...collectTemplateFiles(TEMPLATES_DIR),
    ...(existsSync(legacyDir) ? collectTemplateFiles(legacyDir) : []),
  ]
  const filesWithMcpRef = templateFiles.filter((f) => {
    const content = readFileSync(f, 'utf-8')
    return content.includes('{{MCP_SEARCH_TOOL}}')
  })

  it('finds templates containing {{MCP_SEARCH_TOOL}}', () => {
    expect(filesWithMcpRef.length).toBeGreaterThanOrEqual(14)
  })

  for (const file of filesWithMcpRef) {
    const relativePath = file.replace(PACKAGE_ROOT + '/', '')

    it(`${relativePath}: no MCP tool references remain after skip processing`, () => {
      const content = readFileSync(file, 'utf-8')
      const result = injectConfigVariables(content, { mcpProvider: 'skip' })

      // No raw template variables should remain
      expect(result).not.toContain('{{MCP_SEARCH_TOOL}}')
      expect(result).not.toContain('{{MCP_SEARCH_PARAM}}')

      // No ace-tool references should be injected
      expect(result).not.toContain('mcp__ace-tool__search_context')

      // No contextweaver references should be injected
      expect(result).not.toContain('mcp__contextweaver__codebase-retrieval')
    })
  }
})

// ─────────────────────────────────────────────────────────────
// E. Review profile defaults
// ─────────────────────────────────────────────────────────────
describe('review profile defaults', () => {
  it('fills missing profiles and preserves valid overrides', () => {
    const input = [
      '{{REVIEW_PROFILES}}',
      '{{REVIEW_GPT_MODEL}} / {{REVIEW_GPT_EFFORT}}',
      '{{REVIEW_GROK_MODEL}} / {{REVIEW_GROK_EFFORT}}',
    ].join('\n')
    const result = injectConfigVariables(input, {
      routing: {
        review: {
          profiles: [{ id: 'gpt', model: 'gpt-5.6-sol', effort: 'max' }],
        },
      },
    })

    expect(result).toBe(
      [
        '[{"id":"gpt","model":"gpt-5.6-sol","effort":"max"},{"id":"grok","model":"grok-4.6","effort":"high"}]',
        'gpt-5.6-sol / max',
        'grok-4.6 / high',
      ].join('\n')
    )
  })
})

// ─────────────────────────────────────────────────────────────
// F. GEMINI_MODEL_FLAG removal
// ─────────────────────────────────────────────────────────────
describe('GEMINI_MODEL_FLAG removal', () => {
  it('strips the placeholder unconditionally', () => {
    const input = [
      '--backend antigravity {{GEMINI_MODEL_FLAG}}- "/w"',
      '--backend codex {{GEMINI_MODEL_FLAG}}- "/w"',
      '--backend <codex|antigravity> {{GEMINI_MODEL_FLAG}}- "/w"',
    ].join('\n')
    const result = injectConfigVariables(input, {
      routing: {
        frontend: { primary: 'antigravity' },
        backend: { primary: 'codex' },
      },
    })

    expect(result).toBe(
      ['--backend antigravity - "/w"', '--backend codex - "/w"', '--backend <codex|antigravity> - "/w"'].join('\n')
    )
    expect(result).not.toContain('--gemini-model')
    expect(result).not.toContain('{{GEMINI_MODEL_FLAG}}')
  })
})

// ─────────────────────────────────────────────────────────────
// F. Additional backend model flags
// ─────────────────────────────────────────────────────────────
describe('additional backend model flags', () => {
  it('injects Grok model flags only into Grok routes', () => {
    const input = [
      '--backend codex {{GROK_MODEL_FLAG}}- "/w"',
      '--backend grok {{GROK_MODEL_FLAG}}- "/w"',
      '--backend <codex|grok> {{GROK_MODEL_FLAG}}- "/w"',
    ].join('\n')
    const result = injectConfigVariables(input, {
      routing: {
        frontend: { models: ['grok'], primary: 'grok' },
        backend: { models: ['codex'], primary: 'codex' },
        grokModel: 'grok-4.6',
      },
    })

    expect(result).toBe(
      [
        '--backend codex - "/w"',
        '--backend grok --grok-model grok-4.6 - "/w"',
        '--backend <codex|grok --grok-model grok-4.6> - "/w"',
      ].join('\n')
    )
  })

  it('removes Kimi and OpenCode model flags when their backends are inactive', () => {
    const input = '--backend codex {{KIMI_MODEL_FLAG}}{{OPENCODE_MODEL_FLAG}}- "/w"'
    const result = injectConfigVariables(input, {
      routing: {
        frontend: { models: ['antigravity'], primary: 'antigravity' },
        backend: { models: ['codex'], primary: 'codex' },
        kimiModel: 'kimi-code',
        opencodeModel: 'anthropic/claude-opus-5',
      },
    })

    expect(result).toBe('--backend codex - "/w"')
  })

  it('only injects OpenCode model flags on OpenCode backend lines', () => {
    const input = [
      '--backend claude {{OPENCODE_MODEL_FLAG}}- "/w"',
      '--backend opencode {{OPENCODE_MODEL_FLAG}}- "/w"',
    ].join('\n')
    const result = injectConfigVariables(input, {
      routing: {
        backend: { models: ['opencode'], primary: 'opencode' },
        opencodeModel: 'anthropic/claude-opus-5',
      },
    })

    expect(result).toBe(
      ['--backend claude - "/w"', '--backend opencode --opencode-model anthropic/claude-opus-5 - "/w"'].join('\n')
    )
  })

  it('injects model flags into direct hard-coded backend calls', () => {
    const input = [
      'codeagent-wrapper --backend grok - "/w"',
      'codeagent-wrapper --backend codex - "/w"',
      'codeagent-wrapper --backend opencode - "/w"',
    ].join('\n')
    const result = injectConfigVariables(input, {
      routing: {
        frontend: { models: ['grok'], primary: 'grok' },
        backend: { models: ['opencode'], primary: 'opencode' },
        grokModel: 'grok-4.6',
        opencodeModel: 'anthropic/claude-opus-5',
      },
    })

    expect(result).toBe(
      [
        'codeagent-wrapper --backend grok --grok-model grok-4.6 - "/w"',
        'codeagent-wrapper --backend codex - "/w"',
        'codeagent-wrapper --backend opencode --opencode-model anthropic/claude-opus-5 - "/w"',
      ].join('\n')
    )
  })

  it('injects model flags for conditional primary routes', () => {
    const input = 'codeagent-wrapper --backend <{{BACKEND_PRIMARY}}|{{FRONTEND_PRIMARY}}> - "/w"'
    const result = injectConfigVariables(input, {
      routing: {
        frontend: { models: ['grok'], primary: 'grok' },
        backend: { models: ['opencode'], primary: 'opencode' },
        grokModel: 'grok-4.6',
        opencodeModel: 'anthropic/claude-opus-5',
      },
    })

    expect(result).toBe(
      'codeagent-wrapper --backend <opencode --opencode-model anthropic/claude-opus-5|grok --grok-model grok-4.6> - "/w"'
    )
  })

  it('adds a runtime short-circuit to every generated template when both primary routes use Claude', () => {
    const config = {
      routing: {
        frontend: { models: ['claude'], primary: 'claude' },
        backend: { models: ['claude'], primary: 'claude' },
      },
    }

    for (const input of [
      '---\ndescription: test\n---\ncodeagent-wrapper --backend claude',
      'template without wrapper',
    ]) {
      const result = injectConfigVariables(input, config)
      expect(result).toContain('## Pure Claude Code mode')
      expect(result).toContain('This section overrides every later primary-route `codeagent-wrapper` example')
      expect(result).toContain('CCG_ROLE: research')
      expect(result).toContain('CCG_ROLE: implement')
    }
  })
})

// ─────────────────────────────────────────────────────────────
// G. Integration: real templates never emit --gemini-model
// ─────────────────────────────────────────────────────────────
describe('integration: real templates with antigravity+codex config', () => {
  const config = {
    routing: {
      frontend: { primary: 'antigravity' },
      backend: { primary: 'codex' },
    },
  }

  const expectedCleanTemplates = ['commands-legacy/backend.md', 'commands-legacy/codex-exec.md']

  for (const rel of expectedCleanTemplates) {
    it(`${rel}: no --gemini-model after injection`, () => {
      const content = readFileSync(join(PACKAGE_ROOT, 'templates', rel), 'utf-8')
      const result = injectConfigVariables(content, config)

      expect(result).not.toContain('--gemini-model')
    })
  }
})
