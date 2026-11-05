import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { deny, distributions, fixture, packageRoot, write } from './quality-gates-fixtures'

function generate(distribution: string, root: string, flags: string[], preload?: string) {
  const result = spawnSync(
    process.execPath,
    [
      ...(preload ? ['--require', preload] : []),
      join(packageRoot, distribution, 'gen-docs/scripts/doc_generator.js'),
      root,
      '--json',
      ...flags,
    ],
    { cwd: root, encoding: 'utf8' }
  )
  expect(result.error).toBeUndefined()
  expect(result.signal).toBeNull()
  expect(result.stdout, result.stderr).not.toBe('')
  return { status: result.status, output: JSON.parse(result.stdout) as { status: string; messages: string[] } }
}

describe.each(distributions)('%s document generation', (distribution) => {
  it.each(['both', 'readme', 'design'] as const)('replaces only the selected %s documents', (selection) => {
    const root = fixture()
    write(root, 'source.js', 'export function example() { return 1 }\n')
    const readme = write(root, 'README.md', '# Existing README\n')
    const design = write(root, 'DESIGN.md', '# Existing design\n')
    const flags = selection === 'readme' ? ['--readme-only'] : selection === 'design' ? ['--design-only'] : []
    const result = generate(distribution, root, ['--force', ...flags])
    expect(result.status).toBe(0)
    expect(result.output.status).toBe('success')
    if (selection === 'design') {
      expect(readFileSync(readme, 'utf8')).toBe('# Existing README\n')
    } else {
      expect(readFileSync(readme, 'utf8')).toContain('example')
    }
    if (selection === 'readme') {
      expect(readFileSync(design, 'utf8')).toBe('# Existing design\n')
    } else {
      expect(readFileSync(design, 'utf8')).toContain('设计文档')
    }
  })

  it('rejects conflicting selections before changing documents', () => {
    const root = fixture()
    const readme = write(root, 'README.md', '# Existing README\n')
    const design = write(root, 'DESIGN.md', '# Existing design\n')
    const result = generate(distribution, root, ['--force', '--readme-only', '--design-only'])
    expect(result.status).toBe(1)
    expect(result.output.status).toBe('error')
    expect(result.output.messages.join('\n')).toContain('--readme-only')
    expect(readFileSync(readme, 'utf8')).toBe('# Existing README\n')
    expect(readFileSync(design, 'utf8')).toBe('# Existing design\n')
  })

  it.each(['.gitignore', 'source.js'])('reports unreadable %s without replacing documents', (name) => {
    const root = fixture()
    const source = write(root, 'source.js', 'export function example() { return 1 }\n')
    const ignored = write(root, '.gitignore', 'node_modules/\n')
    const readme = write(root, 'README.md', '# Existing README\n')
    const design = write(root, 'DESIGN.md', '# Existing design\n')
    const preload = deny(root, 'readFileSync', name === '.gitignore' ? ignored : source)
    const result = generate(distribution, root, ['--force'], preload)
    expect(result.status).toBe(1)
    expect(result.output.status).toBe('error')
    expect(result.output.messages.join('\n')).toContain('Injected read denial')
    expect(readFileSync(readme, 'utf8')).toBe('# Existing README\n')
    expect(readFileSync(design, 'utf8')).toBe('# Existing design\n')
  })
})
