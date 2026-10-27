import { execFileSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { injectHookConfig, PACKAGE_ROOT } from '../installer-template'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((p) => rm(p, { recursive: true, force: true })))
})

async function runHook(
  config: Parameters<typeof injectHookConfig>[1],
  prompt: string,
  setup?: (dir: string) => Promise<void>
) {
  const root = await mkdtemp(join(tmpdir(), 'ccg-hook-routing-'))
  directories.push(root)
  const installDir = join(root, "CCG O'Neil `cache` $home")
  const hookDir = join(installDir, 'hooks', 'ccg')
  await mkdir(hookDir, { recursive: true })
  const template = await readFile(join(PACKAGE_ROOT, 'templates', 'hooks', 'skill-router.js'), 'utf8')
  const script = injectHookConfig(template, config, installDir)
  expect(script).not.toMatch(/\{\{[A-Z_]+\}\}/)
  await writeFile(join(hookDir, 'skill-router.js'), script)
  await copyFile(join(PACKAGE_ROOT, 'templates', 'hooks', 'task-utils.js'), join(hookDir, 'task-utils.js'))
  await setup?.(installDir)
  const output = execFileSync(process.execPath, [join(hookDir, 'skill-router.js')], {
    input: JSON.stringify({ prompt }),
    encoding: 'utf8',
    cwd: root,
  })
  return output ? (JSON.parse(output).hookSpecificOutput.additionalContext as string) : ''
}

describe('installed routing suggestions', () => {
  it('uses configured primary backends and escapes model flags without granting execution', async () => {
    const context = await runHook(
      {
        routing: {
          frontend: { primary: 'grok' },
          backend: { primary: 'opencode' },
          grokModel: 'grok-example',
          opencodeModel: 'deepseek/model-example',
        },
      },
      '双模型分析当前项目'
    )
    expect(context).toContain('--backend grok --grok-model &apos;grok-example&apos;')
    expect(context).toContain('--backend opencode --opencode-model &apos;deepseek/model-example&apos;')
    expect(context).toContain('O&apos;Neil `cache` $home')
    expect(context).not.toContain('--backend codex')
    expect(context).toContain('<ccg-model-suggestion>')
    expect(context).not.toContain('请立即执行')
  })
  it('lists one configured backend only once', async () => {
    const context = await runHook(
      { routing: { frontend: { primary: 'codex' }, backend: { primary: 'codex' } } },
      '双模型分析当前项目'
    )
    expect(context.match(/--backend codex/g)).toHaveLength(1)
  })
  it('keeps Pure Claude analysis on native Agents', async () => {
    const context = await runHook(
      { routing: { frontend: { primary: 'claude' }, backend: { primary: 'claude' } } },
      '双模型分析当前项目'
    )
    expect(context).toContain('Claude Code 原生 Agent')
    expect(context).not.toContain('--backend claude')
    expect(context).not.toContain('codeagent-wrapper')
  })
  it('keeps an explicit backend request distinct from the primary routes', async () => {
    const context = await runHook(
      { routing: { frontend: { primary: 'grok' }, backend: { primary: 'opencode' } } },
      '请codex分析当前项目'
    )
    expect(context).toContain('--backend codex')
    expect(context).not.toContain('--backend opencode')
  })
  it('uses independent temporary GPT/Grok review profiles even with other primary backends', async () => {
    const context = await runHook(
      {
        routing: {
          frontend: { primary: 'grok' },
          backend: { primary: 'opencode' },
          review: {
            profiles: [
              { id: 'gpt', model: 'custom-gpt', effort: 'max' },
              { id: 'grok', model: 'custom-grok', effort: 'low' },
            ],
          },
        },
      },
      '双模型审查当前代码'
    )
    expect(context).toContain('routing.review.profiles')
    expect(context).toContain('gpt=custom-gpt / max')
    expect(context).toContain('grok=custom-grok / low')
    expect(context).toContain('--backend claude --no-session-persistence')
    expect(context).not.toContain('--backend opencode')
  })
})

async function longKnowledge(dir: string) {
  const root = join(dir, 'skills', 'ccg', 'domains', 'architecture')
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'api-design.md'), 'x'.repeat(50_000))
}

describe('installed knowledge context', () => {
  it('retains the 16 KiB read bound and truncation diagnostic for legacy skills', async () => {
    const context = await runHook({}, 'api设计要怎么做', longKnowledge)
    expect(context).toContain('<ccg-domain-knowledge>')
    expect(context).toContain('SKILL_CONTEXT_TRUNCATED:domains/architecture/api-design.md:16KiB/120-lines')
    expect(Buffer.byteLength(context)).toBeLessThan(17 * 1024)
  })
  it.each([[], ['verify-quality']])('keeps native selection %j from duplicating legacy knowledge', async (...names) => {
    const context = await runHook({ skillsProfile: names as string[] }, 'api设计要怎么做', longKnowledge)
    expect(context).toBe('')
  })
})
