import { describe, expect, it } from 'vitest'
import { distributions, git, repository, run, write } from './quality-gates-fixtures'

describe.each(distributions)('%s feedback coverage', (distribution) => {
  it.each(['.c', '.cc', '.cpp', '.cxx', '.h', '.hh', '.hpp', '.hxx'])(
    'checks credentials, dynamic commands and unbounded input in %s',
    (extension) => {
      const root = repository()
      const source = write(
        root,
        'source' + extension,
        [
          'const char api_key[] = "synthetic-credential-value";',
          'std::system(command.c_str());',
          'gets(buffer);',
          'scanf("%d %s", &number, buffer);',
          'fscanf(stream, "%[a-z]", buffer);',
        ].join('\n')
      )
      const result = run(distribution, 'security', [source], root)
      expect(result.status).toBe(1)
      expect(result.output).toMatchObject({ complete: true, files_scanned: 1, scan_errors: [] })
      expect(result.output.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ rule_id: 'HARDCODED_SECRET', line_number: 1 }),
          expect.objectContaining({ rule_id: 'C_DYNAMIC_COMMAND', line_number: 2 }),
          expect.objectContaining({ rule_id: 'C_UNBOUNDED_INPUT', line_number: 3 }),
          expect.objectContaining({ rule_id: 'C_UNBOUNDED_SCANF', line_number: 4 }),
          expect.objectContaining({ rule_id: 'C_UNBOUNDED_SCANF_SOURCE', line_number: 5 }),
        ])
      )
      expect(result.stdout).not.toContain('synthetic-credential-value')
    }
  )

  it('preserves safe C++ calls, bounded formats, comments and raw-string examples', () => {
    const root = repository()
    const source = write(
      root,
      'source.cpp',
      [
        'char buffer[32];',
        'fgets(buffer, sizeof(buffer), stdin);',
        'scanf("%31s", buffer);',
        'scanf("%%s %*s %d %31s", &number, buffer);',
        'sscanf("source", "%31s", buffer);',
        'std::system("fixed command");',
        '// system(input); gets(buffer); scanf("%s", buffer);',
        '/* scanf("%s", buffer);',
        'gets(buffer); system(input); */',
        'const char *sample = R"guide(system(input); gets(buffer); scanf("%s", buffer);)guide";',
        'const char *example = R"guide(api_key = "synthetic-credential-value";)guide";',
      ].join('\n')
    )
    const result = run(distribution, 'security', [source], root)
    expect(result.status).toBe(0)
    expect(result.output).toMatchObject({ complete: true, passed: true, findings: [] })
  })

  it('recognizes unsafe input after escaped percent signs and ignores inline comment samples', () => {
    const root = repository()
    const source = write(
      root,
      'source.c',
      [
        'scanf("%%%s", buffer);',
        'sscanf("source", "%s", buffer);',
        'int answer = 42; /* scanf("%s", buffer); system(input); */',
        '#define VALUE 42 // gets(buffer);',
      ].join('\n')
    )
    const result = run(distribution, 'security', [source], root)
    expect(result.output.findings?.map((finding) => finding.line_number)).toEqual([1, 2])
  })

  it.each(['working', 'staged', 'committed'])(
    'reads related document changes outside the requested source scope in %s mode',
    (mode) => {
      const root = repository()
      const mod = 'skills/helper'
      write(root, `${mod}/SKILL.md`, '# Helper\n\n[Usage](references/usage.md)\n')
      write(root, `${mod}/references/usage.md`, '# Usage\n')
      write(root, `${mod}/scripts/main.py`, 'value = 1\n')
      git(root, 'add', '.')
      git(root, 'commit', '-qm', 'test: document baseline')
      const source = write(root, `${mod}/scripts/main.py`, 'value = 2\n'.repeat(60))
      write(root, `${mod}/references/usage.md`, '# Usage\n\nUpdated interface\n')
      if (mode !== 'working') git(root, 'add', '.')
      if (mode === 'committed') git(root, 'commit', '-qm', 'test: documented source change')
      if (mode !== 'working') write(root, `${mod}/references/usage.md`, '# Usage\n')
      const result = run(distribution, 'change', [source, '--mode', mode], root)
      expect(result.status).toBe(0)
      expect(result.output.changes).toHaveLength(1)
      expect(result.output.changes?.[0].path).toBe(`${mod}/scripts/main.py`)
      expect(result.output.doc_sync).toEqual({
        [`${mod}/SKILL.md`]: { exists: true, updated: false },
        [`${mod}/references/usage.md`]: { exists: true, updated: true },
      })
      expect(result.output.issues?.filter((issue) => issue.message.includes('相关文档未更新'))).toEqual([])
    }
  )

  it('distinguishes staged document state from untracked working documentation', () => {
    const root = repository()
    const source = write(root, 'module/source.py', 'value = 1\n')
    git(root, 'add', '.')
    git(root, 'commit', '-qm', 'test: source baseline')
    write(root, 'module/source.py', 'value = 2\n'.repeat(60))
    git(root, 'add', '.')
    write(root, 'module/README.md', '# Module\n\nUpdated interface\n')
    const working = run(distribution, 'change', [source], root)
    const staged = run(distribution, 'change', [source, '--mode', 'staged'], root)
    expect(working.output.doc_sync?.['module/README.md']).toEqual({ exists: true, updated: true })
    expect(staged.output.doc_sync?.['module/README.md']).toEqual({ exists: true, updated: false })
    expect(working.output.changes?.map((change) => change.path)).toEqual(['module/source.py'])
  })
})
