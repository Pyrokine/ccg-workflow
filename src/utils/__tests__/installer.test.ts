import fs from 'fs-extra'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { getAllCommandIds, getWorkflowById, getWorkflowConfigs, injectConfigVariables } from '../installer'

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
            { id: 'grok', model: 'grok-4.6', effort: 'high' },
          ],
        },
      },
    })
    expect(result).toBe(
      [
        'profiles: [{"id":"gpt","model":"gpt-5.6-sol","effort":"xhigh"},{"id":"grok",' +
          '"model":"grok-4.6","effort":"high"}]',
        'gpt: gpt-5.6-sol / xhigh',
        'grok: grok-4.6 / high',
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
        'profiles: [{"id":"gpt","model":"gpt-5.6-sol","effort":"xhigh"},{"id":"grok",' +
          '"model":"grok-4.6","effort":"high"}]',
        'gpt: gpt-5.6-sol / xhigh',
        'grok: grok-4.6 / high',
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

  it('defaults to Pure Claude Code routing when not specified', () => {
    const input = '{{FRONTEND_PRIMARY}} / {{BACKEND_PRIMARY}}'
    const result = injectConfigVariables(input, {})
    expect(result).toBe('claude / claude')
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
              { id: 'grok', model: 'grok-4.6', effort: 'high' },
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
