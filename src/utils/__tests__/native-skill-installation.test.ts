import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'pathe'
import fs from 'fs-extra'
import { afterEach, describe, expect, it } from 'vitest'
import { installWorkflows, syncRoutingTemplates, uninstallWorkflows } from '../installer'
import { installedNames, listSkills } from '../skill-manager'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((p) => fs.remove(p)))
})

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'ccg-native-install-'))
  directories.push(root)
  await fs.ensureDir(join(root, 'bin'))
  const binary = join(root, 'bin', 'codeagent-wrapper')
  await fs.writeFile(binary, '#!/usr/bin/env node\nconsole.log("codeagent-wrapper version 5.15.0-aug.1")\n', {
    mode: 0o755,
  })
  return root
}

const paths = (root: string) => ({
  target: 'claude' as const,
  nativeDir: join(root, 'skills'),
  storeDir: join(root, '.ccg-skills'),
})

function runSkillRouter(root: string, prompt: string): string {
  return execFileSync(process.execPath, [join(root, 'hooks', 'ccg', 'skill-router.js')], {
    input: JSON.stringify({ prompt }),
    encoding: 'utf8',
  })
}

describe('native skill integration', () => {
  it('installs only the selected native entry, injects routing, and uninstalls its alias', async () => {
    const root = await setup()
    const result = await installWorkflows(['go'], root, true, {
      skillsProfile: ['verify-quality'],
      mcpProvider: 'skip',
      routing: {
        frontend: { primary: 'grok' },
        backend: { primary: 'opencode' },
        opencodeModel: 'deepseek/model-example',
      },
    })
    expect(result.success).toBe(true)
    expect(result.installedSkills).toBe(1)
    expect(await installedNames(paths(root))).toEqual(['verify-quality'])
    expect((await listSkills(paths(root))).filter((s) => s.installed)).toMatchObject([
      { name: 'verify-quality', healthy: true },
    ])
    expect(await fs.pathExists(join(root, 'skills', 'ccg'))).toBe(false)
    const knowledgeRules = await fs.readFile(join(root, 'rules', 'ccg-skill-routing.md'), 'utf8')
    expect(knowledgeRules).toContain('/ccg-verify-quality')
    expect(knowledgeRules).not.toContain('domains/development')
    const output = runSkillRouter(root, '双模型分析')
    expect(JSON.parse(output).hookSpecificOutput.additionalContext).toContain(
      '--opencode-model &apos;deepseek/model-example&apos;'
    )
    const refreshed = await syncRoutingTemplates(['go'], root, {
      skillsProfile: ['verify-quality'],
      skillsMode: 'native',
      mcpProvider: 'skip',
      routing: {
        mode: 'smart',
        frontend: { models: ['codex'], primary: 'codex' },
        backend: { models: ['codex'], primary: 'codex' },
        review: { profiles: [{ id: 'gpt' }, { id: 'grok' }] },
      },
    })
    expect(refreshed.success).toBe(true)
    const domainOutput = runSkillRouter(root, 'redis caching')
    expect(domainOutput).toBe('')
    expect(await installedNames(paths(root))).toEqual(['verify-quality'])
    await fs.ensureDir(join(root, 'skills', 'my-own-skill'))
    await fs.writeFile(join(root, 'skills', 'my-own-skill', 'SKILL.md'), 'personal')
    const removed = await uninstallWorkflows(root)
    expect(removed.success).toBe(true)
    expect(removed.removedSkills).toContain('ccg-verify-quality')
    expect(await fs.pathExists(join(root, 'skills', 'ccg-verify-quality'))).toBe(false)
    expect(await fs.readFile(join(root, 'skills', 'my-own-skill', 'SKILL.md'), 'utf8')).toBe('personal')
    expect(await fs.pathExists(join(root, '.ccg-skills', 'snapshots'))).toBe(true)
  }, 30_000)

  it('executes the enhanced gate from installed native resources', async () => {
    const root = await setup()
    const installed = await installWorkflows(['go'], root, true, {
      skillsProfile: ['verify-quality'],
      mcpProvider: 'skip',
    })
    expect(installed.success).toBe(true)
    const entry = await fs.readFile(join(root, 'skills', 'ccg-verify-quality', 'SKILL.md'), 'utf8')
    expect(entry).toContain('--language-checks')
    const resource = /resources for this skill are in `([^`]+)`/.exec(entry)?.[1]
    if (!resource) throw new Error('Installed skill does not identify its resource directory')
    const script = join(resource, 'scripts', 'quality_checker.js')
    expect(await fs.pathExists(join(resource, '..', 'lib', 'language-checks.js'))).toBe(true)
    expect(await fs.pathExists(join(resource, '..', 'lib', 'git-baseline.js'))).toBe(true)
    const project = join(root, 'project')
    await fs.outputJson(join(project, 'package.json'), { type: 'module' })
    await fs.outputFile(join(project, 'eslint.config.cjs'), 'module.exports = [{rules:{"no-debugger":"error"}}];\n')
    await fs.ensureDir(join(project, 'node_modules'))
    await fs.symlink(
      resolve(import.meta.dirname, '../../../node_modules/eslint'),
      join(project, 'node_modules', 'eslint'),
      'junction'
    )
    const source = join(project, 'source.js')
    await fs.writeFile(source, 'debugger;\n')
    const result = spawnSync(process.execPath, [script, source, '--language-checks', '--json'], {
      cwd: project,
      encoding: 'utf8',
    })
    expect(result.status).toBe(1)
    expect(JSON.parse(result.stdout)).toMatchObject({
      complete: true,
      passed: false,
      analysis_mode: 'language',
      checks: [expect.objectContaining({ tool: 'eslint', status: 'failed', files: [source] })],
    })
  }, 30_000)

  it('explicit compatibility mode disables managed aliases and preserves their cache', async () => {
    const root = await setup()
    await installWorkflows(['go'], root, true, { skillsProfile: ['verify-quality'], mcpProvider: 'skip' })
    const result = await installWorkflows(['go'], root, true, { skillsMode: 'legacy', mcpProvider: 'skip' })
    expect(result.success).toBe(true)
    expect(await installedNames(paths(root))).toEqual([])
    expect(await fs.pathExists(join(root, 'skills', 'ccg-verify-quality'))).toBe(false)
    expect(await fs.pathExists(join(root, 'skills', 'ccg', 'tools', 'verify-quality', 'SKILL.md'))).toBe(true)
    expect(await fs.pathExists(join(root, '.ccg-skills', 'snapshots'))).toBe(true)
  }, 30_000)

  it('returns an installation failure while preserving a conflicting user skill', async () => {
    const root = await setup()
    await fs.ensureDir(join(root, 'skills', 'ccg-verify-quality'))
    const userFile = join(root, 'skills', 'ccg-verify-quality', 'SKILL.md')
    await fs.writeFile(userFile, 'user-owned')
    const result = await installWorkflows(['go'], root, true, {
      skillsProfile: ['verify-quality'],
      mcpProvider: 'skip',
    })
    expect(result.success).toBe(false)
    expect(result.errors.join('\n')).toMatch(/conflict|ownership|preserved/i)
    expect(await fs.readFile(userFile, 'utf8')).toBe('user-owned')
  }, 30_000)

  it('preserves custom rule text when native mode is installed and refreshed', async () => {
    const root = await setup()
    const rules = ['ccg-skills.md', 'ccg-skill-routing.md'].map((name) => join(root, 'rules', name))
    for (const path of rules) await fs.outputFile(path, 'USER_RULE: keep this instruction\n')
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await installWorkflows(['go'], root, true, {
        skillsProfile: [],
        mcpProvider: 'skip',
        skipBinary: true,
      })
      expect(result.success).toBe(true)
      for (const path of rules) {
        const text = await fs.readFile(path, 'utf8')
        expect(text).toContain('USER_RULE: keep this instruction')
        expect(text).toContain('No optional CCG native skills are selected.')
        expect(text.split('CCG_NATIVE_SKILLS_START')).toHaveLength(2)
      }
    }
  })

  it('runs CommonJS Hooks inside an ESM project and preserves package metadata fields', async () => {
    const root = await setup()
    await fs.writeJson(join(root, 'package.json'), { type: 'module' })
    await fs.ensureDir(join(root, 'hooks', 'ccg'))
    await fs.writeJson(join(root, 'hooks', 'ccg', 'package.json'), { name: 'local-hook-metadata' })
    const result = await installWorkflows(['go'], root, true, {
      skillsProfile: [],
      mcpProvider: 'skip',
      routing: {
        frontend: { primary: 'codex' },
        backend: { primary: 'codex' },
      },
    })
    expect(result.success).toBe(true)
    expect(await fs.readJson(join(root, 'hooks', 'ccg', 'package.json'))).toMatchObject({
      name: 'local-hook-metadata',
      type: 'commonjs',
    })
    const output = runSkillRouter(root, '双模型分析')
    expect(JSON.parse(output).hookSpecificOutput.additionalContext).toContain('--backend codex')
  }, 30_000)
})
