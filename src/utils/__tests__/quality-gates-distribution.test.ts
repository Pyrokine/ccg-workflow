import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { collectInvocableSkills, generateCommandContent } from '../skill-registry'
import { packageRoot, distributions, scripts, write, lintProject } from './quality-gates-fixtures'

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

it('ships the same shared libraries and four scanners in both distributions', () => {
  for (const file of ['lib/shared.js', 'lib/git-baseline.js', 'lib/language-checks.js', ...Object.values(scripts)]) {
    expect(readFileSync(join(packageRoot, distributions[0], file), 'utf8')).toBe(
      readFileSync(join(packageRoot, distributions[1], file), 'utf8')
    )
  }
})
