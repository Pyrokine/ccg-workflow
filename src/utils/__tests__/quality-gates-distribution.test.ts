import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { collectInvocableSkills, generateCommandContent } from '../skill-registry'
import { packageRoot, distributions, scripts, write, lintProject, repository } from './quality-gates-fixtures'

it('executes language checks through the generated command and runner', () => {
  const root = lintProject()
  const source = write(root, 'source.js', 'debugger;\n')
  const skills = join(packageRoot, 'templates', 'skills')
  const catalog = collectInvocableSkills(skills)
  const quality = catalog.find((skill) => skill.name === 'verify-quality')
  if (!quality) throw new Error('Quality skill is missing')
  const text = generateCommandContent(quality, skills)
  const command = /^node "([^"]+)" verify-quality --language-checks \$ARGUMENTS$/m.exec(text)
  if (!command) throw new Error('Generated quality command does not request language checks')
  const result = spawnSync(process.execPath, [command[1], 'verify-quality', '--language-checks', source, '--json'], {
    cwd: root,
    env: { ...process.env, SAGE_SKILLS_DIR: skills },
    encoding: 'utf8',
  })
  expect(result.status).toBe(1)
  expect(JSON.parse(result.stdout)).toMatchObject({ complete: true, passed: false, analysis_mode: 'language' })
  const security = catalog.find((skill) => skill.name === 'verify-security')
  if (!security) throw new Error('Security skill is missing')
  expect(generateCommandContent(security, skills)).not.toContain('--language-checks')
})

it('executes change analysis through the generated command and runner with shared helpers', () => {
  const root = repository()
  const source = write(root, 'src/clean.ts', 'export const value = 2\n')
  const skills = join(packageRoot, 'templates', 'skills')
  const change = collectInvocableSkills(skills).find((skill) => skill.name === 'verify-change')
  if (!change) throw new Error('Change skill is missing')
  const command = /^node "([^"]+)" verify-change \$ARGUMENTS$/m.exec(generateCommandContent(change, skills))
  if (!command) throw new Error('Generated change command is missing')
  const result = spawnSync(process.execPath, [command[1], 'verify-change', source, '--json'], {
    cwd: root,
    env: { ...process.env, SAGE_SKILLS_DIR: skills },
    encoding: 'utf8',
  })
  expect(result.status, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toMatchObject({
    complete: true,
    passed: true,
    changes: [{ path: 'src/clean.ts', type: 'modified' }],
  })
})

it('ships the same shared libraries and four scanners in both distributions', () => {
  const libraries = [
    'lib/shared.js',
    'lib/git-baseline.js',
    'lib/language-checks.js',
    'lib/language-checks-runtime.js',
    'lib/language-checks-native.js',
    'lib/language-checks-go.js',
    'lib/language-checks-rust.js',
    'lib/language-checks-typescript.js',
    'lib/change-tests.js',
  ]
  for (const file of [...libraries, ...Object.values(scripts)]) {
    expect(readFileSync(join(packageRoot, distributions[0], file), 'utf8')).toBe(
      readFileSync(join(packageRoot, distributions[1], file), 'utf8')
    )
  }
})
