import { createRequire } from 'node:module'
import { join } from 'node:path'
import fs from 'fs-extra'
import { describe, expect, it } from 'vitest'
import { TASK_STATE_RUNTIME_FILES } from '../installer-codex-files'
import { cleanupPaths, createProject, DEFAULT_SESSION_KEY, hooksDir, runScript } from './task-state-fixtures'

const require = createRequire(import.meta.url)
const controller = require(join(hooksDir, 'task-state.js'))
const internalModules = TASK_STATE_RUNTIME_FILES.filter((file) => file.startsWith('task-state-'))

describe('task controller module contract', () => {
  it('keeps the public error identity and loads every listed dependency without cycles', async () => {
    const root = await createProject()
    expect(controller.TaskStateError).toBe(require(join(hooksDir, 'task-state-core.js')).TaskStateError)
    expect(() => controller.execute('toString', { root, 'session-key': DEFAULT_SESSION_KEY }, {})).toThrow(
      controller.TaskStateError
    )
    const visited = new Set<string>()
    const visiting = new Set<string>()
    function visit(file: string): void {
      if (visited.has(file)) return
      expect(visiting.has(file), `circular dependency: ${file}`).toBe(false)
      visiting.add(file)
      const loaded = require.cache[file]
      expect(loaded, `module not consumed: ${file}`).toBeDefined()
      for (const dependency of loaded?.children || []) {
        if (dependency.filename.startsWith(hooksDir)) visit(dependency.filename)
      }
      visiting.delete(file)
      visited.add(file)
    }
    visit(join(hooksDir, 'task-state.js'))
    for (const file of internalModules) expect(visited.has(join(hooksDir, file)), file).toBe(true)
  })

  it.each(internalModules)('reports a missing %s from an isolated controller process', async (missing) => {
    const root = await createProject()
    const runtime = join(root, 'runtime')
    cleanupPaths.add(runtime)
    await fs.ensureDir(runtime)
    for (const file of TASK_STATE_RUNTIME_FILES) {
      if (file !== missing) await fs.copyFile(join(hooksDir, file), join(runtime, file))
    }
    const result = runScript(join(runtime, 'task-state.js'), ['--help'], undefined, root)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('MODULE_NOT_FOUND')
    expect(result.stderr).toContain(missing)
  })
})
