import fs from 'fs-extra'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { afterEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { getSkillCatalog, installSkills, listSkills } from '../skill-manager'
import { collectNativeSkills, collectSkills, installSkillCommands, parseFrontmatter } from '../skill-registry'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.remove(directory)))
})

describe('skill frontmatter', () => {
  it('keeps single-line fields, malformed-line handling and prototype protection', () => {
    expect(parseFrontmatter('body without frontmatter')).toBeNull()
    const metadata = parseFrontmatter(
      [
        '---',
        'name: fixture',
        'description: "A fixture: with a colon"',
        'user-invocable: true',
        'allowed-tools: Bash, Read',
        'argument-hint: [target] [--json]',
        'malformed line',
        '__proto__: ignored',
        'constructor: ignored',
        'prototype: ignored',
        '---',
      ].join('\n')
    )
    expect(Object.getPrototypeOf(metadata)).toBeNull()
    expect(metadata).toEqual({
      name: 'fixture',
      description: 'A fixture: with a colon',
      'user-invocable': 'true',
      'allowed-tools': 'Bash, Read',
      'argument-hint': '[target] [--json]',
    })
  })

  it('reads folded scalars with paragraph breaks, indentation and CRLF', () => {
    const metadata = parseFrontmatter(
      [
        '---',
        'description: >-',
        '  First line: keep # text and apostrophes.',
        '  Continue this paragraph.',
        '',
        '  Another paragraph.',
        'name: fixture',
        '---',
      ].join('\r\n')
    )
    expect(metadata).toEqual({
      name: 'fixture',
      description: 'First line: keep # text and apostrophes. Continue this paragraph.\nAnother paragraph.',
    })
  })

  it('preserves folded descriptions through discovery, command generation and native installation', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'ccg-folded-metadata-'))
    directories.push(root)
    const templatesDir = join(root, 'templates')
    const description = "Read the user's files: keep # markers and preserve behavior."
    await fs.outputFile(
      join(templatesDir, 'quality', 'SKILL.md'),
      [
        '---',
        'name: quality',
        'description: >-',
        "  Read the user's files: keep # markers",
        '  and preserve behavior.',
        'user-invocable: true',
        'allowed-tools: Bash, Read',
        'argument-hint: [target] [--json]',
        '---',
        '# Quality',
        '',
      ].join('\n')
    )
    const expected = {
      name: 'quality',
      description,
      userInvocable: true,
      allowedTools: ['Bash', 'Read'],
      argumentHint: '[target] [--json]',
    }
    expect(collectSkills(templatesDir)).toMatchObject([expected])
    expect(collectNativeSkills(templatesDir)).toMatchObject([expected])
    expect(getSkillCatalog({ templatesDir })).toMatchObject([expected])

    const commandsDir = join(root, 'commands')
    expect(await installSkillCommands(templatesDir, join(root, 'installed'), commandsDir, new Set())).toEqual([
      'quality',
    ])
    const command = await fs.readFile(join(commandsDir, 'quality.md'), 'utf8')
    expect(parse(command.match(/^---\n(?<metadata>[\s\S]*?)\n---/)!.groups!.metadata)).toEqual({ description })
    expect(command).toContain(description)

    const options = { templatesDir, nativeDir: join(root, 'native'), storeDir: join(root, 'store'), version: 'fixture' }
    await installSkills(['quality'], options)
    const entry = await fs.readFile(join(options.nativeDir, 'ccg-quality', 'SKILL.md'), 'utf8')
    expect(parseFrontmatter(entry)).toMatchObject({ name: 'ccg-quality', description })
    expect(await listSkills(options)).toMatchObject([{ name: 'quality', description, installed: true, healthy: true }])
  })
})
