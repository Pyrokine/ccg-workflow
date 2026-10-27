import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { dependency, distributions, fixture, loadModule, root, write } from './language-checks-fixtures'
import type { Analyze } from './language-checks-fixtures'

const thresholds = { maxComplexity: 10, maxFunctionLength: 50, maxParameters: 5 }
const longBody = '  work();\n'.repeat(55)

describe.each(distributions)('%s test registration thresholds', (distribution) => {
  const { runLanguageChecks } = loadModule(join(root, distribution, 'lib/language-checks.js')) as {
    runLanguageChecks: Analyze
  }

  function analyze(content: string) {
    const directory = fixture()
    dependency(directory, 'eslint')
    write(directory, 'package.json', '{"type":"module"}')
    write(directory, 'eslint.config.cjs', 'module.exports = [{}];')
    const source = write(directory, 'source.test.js', content)
    const result = runLanguageChecks([source], thresholds)
    expect(result.uncovered).toEqual([])
    expect(result.checks).toEqual([expect.objectContaining({ tool: 'eslint', status: 'passed', files: [source] })])
    return result.issues
  }

  it.each([
    ["import { describe, it } from 'vitest';", 'describe'],
    ["import { describe as group, it } from 'vitest';", 'group'],
    ["import * as tests from 'vitest';", 'tests.describe.each([1, 2])'],
  ])('exempts only the outer length of imported registration: %s', (header, registration) => {
    const test = registration.startsWith('tests.') ? 'tests.it' : 'it'
    const content =
      `${header}\n${registration}('suite', () => {\n` + `  ${test}('case', () => {});\n`.repeat(55) + '});\n'
    expect(analyze(content)).toEqual([])
  })

  it.each([
    ['production function', `function describe() {\n${longBody}}\n`, 1],
    ['unrelated import', `import { describe } from './production.js';\ndescribe('suite', () => {\n${longBody}});\n`, 1],
    [
      'shadowed import',
      "import { describe } from 'vitest';\nfunction register(describe) {\n" +
        `describe('suite', () => {\n${longBody}});\n}\n`,
      2,
    ],
  ])('reports real long functions for %s', (_scenario, content, count) => {
    expect(analyze(content).filter((issue) => issue.rule_id === 'max-lines-per-function')).toHaveLength(count)
  })

  it.each(['it', 'test'])('still checks a long %s inside an exempt registration container', (test) => {
    const content =
      `import { describe, ${test} } from 'vitest';\ndescribe('suite', () => {\n` +
      `  ${test}('case', () => {\n${longBody}  });\n});\n`
    expect(analyze(content)).toEqual([expect.objectContaining({ rule_id: 'max-lines-per-function', line_number: 3 })])
  })

  it.each([
    ['arrow default', '(setup = () => {', '}) => {'],
    ['named default', 'function (setup = function prepare() {', '}) {'],
  ])('checks long functions in the registration %s', (_scenario, head, body) => {
    const content =
      `import { describe, it } from 'vitest';\ndescribe('suite', ${head}\n` +
      `${longBody}${body} it('case', () => {}); });\n`
    expect(analyze(content)).toEqual([expect.objectContaining({ rule_id: 'max-lines-per-function', line_number: 2 })])
  })

  it('checks long function declarations inside registration containers', () => {
    const content =
      "import { describe } from 'vitest';\ndescribe('suite', () => {\n" + `function prepare() {\n${longBody}}\n});\n`
    expect(analyze(content)).toEqual([expect.objectContaining({ rule_id: 'max-lines-per-function', line_number: 3 })])
  })

  it('retains complexity and parameter checks on imported registration callbacks', () => {
    const content =
      "import { describe } from 'vitest';\ndescribe('suite', (a,b,c,d,e,f) => {\n" +
      '  if (a) work();\n'.repeat(10) +
      '});\n'
    expect(analyze(content)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rule_id: 'complexity', line_number: 2 }),
        expect.objectContaining({ rule_id: 'max-params', line_number: 2 }),
      ])
    )
  })

  it.each([50, 51])('keeps the production function length boundary at 50 lines: %s', (lines) => {
    const issues = analyze(`function work() {\n${'  operation();\n'.repeat(lines - 2)}}\n`)
    expect(issues.filter((issue) => issue.rule_id === 'max-lines-per-function')).toHaveLength(Number(lines > 50))
  })

  it.each([10, 11])('keeps the production complexity boundary at 10: %s', (complexity) => {
    const issues = analyze(`function work(a) {\n${'  if (a) operation();\n'.repeat(complexity - 1)}}\n`)
    expect(issues.filter((issue) => issue.rule_id === 'complexity')).toHaveLength(Number(complexity > 10))
  })

  it.each([5, 6])('keeps the production parameter boundary at 5: %s', (count) => {
    const parameters = Array.from({ length: count }, (_, index) => `parameter${index}`).join(', ')
    const issues = analyze(`function work(${parameters}) {}\n`)
    expect(issues.filter((issue) => issue.rule_id === 'max-params')).toHaveLength(Number(count > 5))
  })
})
