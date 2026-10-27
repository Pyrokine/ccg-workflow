import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const runner = resolve(import.meta.dirname, '../../../templates/skills/run_skill.js')
const cleanup = new Set<string>()

function fixture(name: string, source: string) {
  const root = mkdtempSync(join(tmpdir(), 'ccg-runner-'))
  cleanup.add(root)
  const script = join(root, 'tools', name, 'scripts', 'check.js')
  mkdirSync(dirname(script), { recursive: true })
  writeFileSync(script, source)
  const lock = join(root, `sage_skill_${createHash('md5').update(root).digest('hex').slice(0, 12)}.lock`)
  const env = { ...process.env, SAGE_SKILLS_DIR: root, TMPDIR: root, TMP: root, TEMP: root }
  return { root, lock, env }
}

afterEach(() => {
  for (const root of cleanup) rmSync(root, { recursive: true, force: true })
  cleanup.clear()
})

describe('skill runner process contract', () => {
  it.skipIf(process.platform === 'win32')('propagates a real child signal as a failure', () => {
    const { root, env } = fixture('verify-quality', 'process.kill(process.pid, "SIGTERM")\n')
    const result = spawnSync(process.execPath, [runner, 'verify-quality', root], { env, encoding: 'utf8' })
    expect(result.status).toBe(143)
  })

  it('does not wait for a write lock during read-only verification', () => {
    const { root, lock, env } = fixture('verify-quality', 'console.log(JSON.stringify({passed:true}))\n')
    writeFileSync(lock, 'writer')
    const result = spawnSync(process.execPath, [runner, 'verify-quality', root, '--json'], {
      env,
      encoding: 'utf8',
      timeout: 1500,
      killSignal: 'SIGKILL',
    })
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ passed: true })
    expect(readFileSync(lock, 'utf8')).toBe('writer')
  })

  it.skipIf(process.platform === 'win32').each(['SIGINT', 'SIGTERM'] as const)(
    'retains a write lock until the child handles %s',
    async (signal) => {
      const { root, lock, env } = fixture(
        'gen-docs',
        `
process.on('${signal}', () => setTimeout(() => process.exit(0), 250));
console.error('CHILD_READY');
setInterval(() => {}, 1000);\n`
      )
      const child = spawn(process.execPath, [runner, 'gen-docs', root, '--json'], { env })
      const closed = new Promise<number | null>((done, reject) => {
        child.once('error', reject)
        child.once('close', done)
      })
      try {
        await new Promise<void>((done, reject) => {
          const timer = setTimeout(() => reject(new Error('Child did not become ready')), 3000)
          child.stderr.on('data', (data) => {
            if (String(data).includes('CHILD_READY')) {
              clearTimeout(timer)
              done()
            }
          })
        })
        expect(existsSync(lock)).toBe(true)
        expect(statSync(lock).mode & 0o777).toBe(0o600)
        child.kill(signal)
        await new Promise((done) => setTimeout(done, 50))
        expect(existsSync(lock)).toBe(true)
        expect(await closed).toBe(signal === 'SIGINT' ? 130 : 143)
        expect(existsSync(lock)).toBe(false)
      } finally {
        if (child.exitCode === null) child.kill('SIGTERM')
        await closed
      }
    }
  )

  it('reports a lock creation failure rather than running without mutual exclusion', () => {
    const { root, env } = fixture('gen-docs', 'console.log(JSON.stringify({passed:true}))\n')
    const preload = join(root, 'deny.cjs')
    writeFileSync(
      preload,
      `
const fs = require('node:fs');
const open = fs.openSync;
fs.openSync = function(file, ...args) {
  if (String(file).includes('sage_skill_')) throw Object.assign(new Error('Injected lock denial'), {code:'EACCES'});
  return open.call(this, file, ...args);
};\n`
    )
    const result = spawnSync(process.execPath, ['--require', preload, runner, 'gen-docs', root, '--json'], {
      env,
      encoding: 'utf8',
    })
    expect(result.status).toBe(2)
    expect(JSON.parse(result.stdout)).toMatchObject({ complete: false, passed: false, error: 'Injected lock denial' })
  })

  it('rejects prototype property names as unknown skills', () => {
    const { root, env } = fixture('verify-quality', 'console.log("not executed")\n')
    const result = spawnSync(process.execPath, [runner, 'constructor', root, '--json'], { env, encoding: 'utf8' })
    expect(result.status).toBe(2)
    expect(JSON.parse(result.stdout)).toMatchObject({ complete: false, passed: false })
    expect(result.stdout).not.toContain('not executed')
  })

  it('keeps write-lock waiting messages out of JSON stdout', async () => {
    const { root, lock, env } = fixture('gen-docs', 'console.log(JSON.stringify({passed:true}))\n')
    writeFileSync(lock, 'writer')
    const child = spawn(process.execPath, [runner, 'gen-docs', root, '--json'], { env })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (data) => {
      stdout += data
    })
    child.stderr.on('data', (data) => {
      stderr += data
    })
    const released = setTimeout(() => unlinkSync(lock), 250)
    const status = await new Promise<number | null>((resolveStatus, reject) => {
      child.once('error', reject)
      child.once('close', resolveStatus)
    }).finally(() => clearTimeout(released))
    expect(status).toBe(0)
    expect(JSON.parse(stdout)).toEqual({ passed: true })
    expect(stderr).toContain('等待锁释放')
  })
})
