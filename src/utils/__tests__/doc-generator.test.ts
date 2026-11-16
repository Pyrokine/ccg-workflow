import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
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
  it.each(['main.py', '__main__.py', 'cli.py', 'app.py'])('uses the discovered Python %s entry', (entry) => {
    const root = join(fixture(), 'script-module with spaces')
    write(root, `cli tools/${entry}`, 'def work(value):\n    return value\n')
    const result = generate(distribution, root, [])
    expect(result.status).toBe(0)
    const readme = readFileSync(join(root, 'README.md'), 'utf8')
    expect(readme).toContain(`python './cli tools/${entry}'`)
    expect(readme).toContain('命令骨架')
    expect(readme).toContain('参数')
    expect(readme).toContain('`work()`')
    expect(readme).not.toMatch(/from .* import main|python -m|obj\.process\(|obj = main\(/)
  })

  it.each(['single', 'double'] as const)('quotes guarded script paths with %s-quoted main guards', (quotes) => {
    const root = join(fixture(), 'script-module with spaces')
    const entry = "cli tools/run-tool's task.py"
    const marker = join(root, 'executed')
    const guard = quotes === 'single' ? "'__main__'" : '"__main__"'
    write(
      root,
      entry,
      `from pathlib import Path\ndef work():\n    Path(${JSON.stringify(marker)}).touch()\n` +
        `if __name__ == ${guard}:\n    work()\n`
    )
    expect(generate(distribution, root, ['--readme-only']).status).toBe(0)
    const readme = readFileSync(join(root, 'README.md'), 'utf8')
    const command = readme.match(/```bash\n(?<command>[\s\S]*?)\n```/)?.[1]
    expect(command).toContain("python './cli tools/run-tool'\\''s task.py'")
    expect(spawnSync('bash', ['-n'], { input: command, encoding: 'utf8' }).status).toBe(0)
    expect(existsSync(marker)).toBe(false)
    expect(readme).not.toMatch(/from .* import main|obj\.process\(/)
  })

  it('keeps a Python library as an API skeleton without inventing an entry or calls', () => {
    const root = join(fixture(), 'library-module')
    write(
      root,
      'library.py',
      '"""Library description"""\nclass Service:\n    pass\ndef work(value):\n    return value\n'
    )
    write(root, 'requirements.txt', 'example-package>=1\n')
    expect(generate(distribution, root, []).status).toBe(0)
    const readme = readFileSync(join(root, 'README.md'), 'utf8')
    expect(readme).toContain('Library description')
    expect(readme).toContain('example-package')
    expect(readme).toContain('`Service`')
    expect(readme).toContain('`work()`')
    expect(readme).toContain('library.py')
    expect(readme).toContain('填写')
    expect(readme).not.toMatch(/### 运行|```python|from .* import main|obj\.process\(/)
  })

  it.each(['""""""', "''''''"])('handles an empty Python module docstring: %s', (docstring) => {
    const root = fixture()
    write(root, 'library.py', `${docstring}\ndef work():\n    return 1\n`)
    const result = generate(distribution, root, ['--readme-only'])
    expect(result.status).toBe(0)
    expect(result.output.status).toBe('success')
    expect(readFileSync(join(root, 'README.md'), 'utf8')).toContain('`work()`')
  })

  it('ignores Python entry guards and API definitions inside comments and strings', () => {
    const root = fixture()
    write(
      root,
      'library.py',
      [
        '# if __name__ == "__main__":',
        "'''",
        'if __name__ == "__main__":',
        '    pass',
        'def phantom():',
        '    pass',
        'class Phantom:',
        '    pass',
        "'''",
        'text = "if __name__ == \'__main__\':"',
        'def work(value):',
        '    return value',
        '',
      ].join('\n')
    )
    write(root, 'test_script.py', 'if __name__ == "__main__":\n    pass\n')
    expect(generate(distribution, root, ['--readme-only']).status).toBe(0)
    const readme = readFileSync(join(root, 'README.md'), 'utf8')
    expect(readme).not.toMatch(/### 运行|```python|`phantom\(\)`|`Phantom`/)
    expect(readme).toContain('`work()`')
  })

  it.each([
    ['go', 'func Work() {}\n', 'Work', 'Go'],
    ['rs', 'pub fn work() {}\n', 'work', 'Rust'],
    ['js', 'export function work() {}\n', 'work', 'JavaScript'],
    ['ts', 'export function work() {}\n', 'work', 'TypeScript'],
  ])('keeps discovered %s APIs without fabricated imports or methods', (extension, source, name, language) => {
    const root = join(fixture(), 'script-module')
    write(root, `src/library.${extension}`, source)
    expect(generate(distribution, root, []).status).toBe(0)
    const readme = readFileSync(join(root, 'README.md'), 'utf8')
    expect(readme).toContain(`\`${name}()\``)
    expect(readme).toContain('填写')
    expect(readme).not.toMatch(
      /Object::new|\.process\(|\.Process\(|\.New\(|new main|import |require\(|use .*::|npm start|cargo run|go run/
    )
    expect(readFileSync(join(root, 'DESIGN.md'), 'utf8')).toContain(`**语言**: ${language}`)
  })

  it('preserves existing documents without --force', () => {
    const root = fixture()
    write(root, 'main.py', 'raise RuntimeError("must not execute")\n')
    const readme = write(root, 'README.md', '# Existing README\n')
    const design = write(root, 'DESIGN.md', '# Existing design\n')
    const result = generate(distribution, root, [])
    expect(result.status).toBe(0)
    expect(result.output.messages.join('\n')).toContain('已存在')
    expect(readFileSync(readme, 'utf8')).toBe('# Existing README\n')
    expect(readFileSync(design, 'utf8')).toBe('# Existing design\n')
  })

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

  it.each(['.gitignore', 'source.js', 'source.py'])('reports unreadable %s without replacing documents', (name) => {
    const root = fixture()
    const source =
      name === 'source.py'
        ? write(root, 'source.py', 'def example():\n    return 1\n')
        : write(root, 'source.js', 'export function example() { return 1 }\n')
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
