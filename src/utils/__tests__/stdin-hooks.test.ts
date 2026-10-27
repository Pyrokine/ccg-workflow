import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const hooksDir = resolve(import.meta.dirname, '../../../templates/hooks')
const utilsPath = join(hooksDir, 'task-utils.js')
const cleanupPaths: string[] = []

async function readDelayedInput(input: Buffer, keepOpen = false): Promise<Record<string, unknown>> {
  const source = `
    process.stdin._handle.setBlocking(false);
    const fs = require('node:fs');
    const readSync = fs.readSync;
    let waits = 0;
    fs.readSync = (...args) => {
      try { return readSync(...args); }
      catch (error) { if (error.code === 'EAGAIN') waits++; throw error; }
    };
    const { readHookInput } = require(${JSON.stringify(utilsPath)});
    process.stderr.write('ready');
    try { process.stdout.write(JSON.stringify({ input: readHookInput(), waits })); }
    catch (error) { process.stdout.write(JSON.stringify({ error: error.message, waits })); }
  `
  return new Promise((resolveChild, reject) => {
    const child = spawn(process.execPath, ['-e', source], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    const timers: NodeJS.Timeout[] = [
      setTimeout(() => {
        child.kill()
        reject(new Error('stdin reader did not finish within 3 seconds'))
      }, 3000),
    ]
    child.stdout.setEncoding('utf-8')
    child.stdout.on('data', (chunk: string) => (stdout += chunk))
    child.on('error', reject)
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE') reject(error)
    })
    child.stderr.once('data', () => {
      if (keepOpen) return
      timers.push(setTimeout(() => child.stdin.write(input.subarray(0, 13)), 40))
      timers.push(setTimeout(() => child.stdin.end(input.subarray(13)), 100))
    })
    child.on('close', (status) => {
      timers.forEach(clearTimeout)
      try {
        expect(status).toBe(0)
        resolveChild(JSON.parse(stdout) as Record<string, unknown>)
      } catch (error) {
        reject(error)
      }
    })
  })
}

function readWithFailure(code: string, transientReads: number): Record<string, unknown> {
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      `
        const fs = require('node:fs');
        const readSync = fs.readSync;
        let failures = ${transientReads};
        fs.readSync = (...args) => {
          if (args[0] === 0 && failures-- > 0) {
            throw Object.assign(new Error('read failure'), { code: ${JSON.stringify(code)} });
          }
          return readSync(...args);
        };
        const { readHookInput } = require(${JSON.stringify(utilsPath)});
        try { process.stdout.write(JSON.stringify({ input: readHookInput(32) })); }
        catch (error) { process.stdout.write(JSON.stringify({ error: error.message, code: error.code })); }
      `,
    ],
    { input: '{"prompt":"hello"}', encoding: 'utf-8', timeout: 3000 }
  )
  expect(result.error).toBeUndefined()
  expect(result.status).toBe(0)
  return JSON.parse(result.stdout) as Record<string, unknown>
}

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('bounded Hook stdin', () => {
  it('waits for a delayed segmented pipe and preserves split UTF-8 characters', async () => {
    const input = Buffer.from('{"prompt":"需求分段读取"}', 'utf-8')
    const result = await readDelayedInput(input)
    expect(result.input).toEqual({ prompt: '需求分段读取' })
    expect(result.waits).toBeGreaterThan(0)
  })

  it('reports a timeout when a nonblocking pipe remains unreadable', async () => {
    const result = await readDelayedInput(Buffer.alloc(0), true)
    expect(result.error).toBe('HOOK_INPUT_TIMEOUT')
    expect(result.waits).toBeGreaterThan(0)
  })

  it.each(['EAGAIN', 'EWOULDBLOCK'])('retries %s without replaying the caller', (code) => {
    expect(readWithFailure(code, 2)).toEqual({ input: { prompt: 'hello' } })
  })

  it('preserves non-transient read errors', () => {
    expect(readWithFailure('EBADF', 1)).toEqual({ error: 'read failure', code: 'EBADF' })
  })

  it.each([
    ['exact byte limit', '{"prompt":"界"}', 16, { prompt: '界' }, undefined],
    ['over byte limit', '{"prompt":"界"}', 15, undefined, 'HOOK_INPUT_TOO_LARGE'],
    ['invalid JSON', '{broken', 32, undefined, 'HOOK_INPUT_INVALID'],
    ['JSON array', '[]', 32, undefined, 'HOOK_INPUT_INVALID'],
    ['empty input', '', 32, {}, undefined],
  ])('preserves the %s contract', (_name, input, limit, expectedInput, expectedError) => {
    const result = spawnSync(
      process.execPath,
      [
        '-e',
        `
          const { readHookInput } = require(${JSON.stringify(utilsPath)});
          try { process.stdout.write(JSON.stringify({ input: readHookInput(${limit}) })); }
          catch (error) { process.stdout.write(JSON.stringify({ error: error.message })); }
        `,
      ],
      { input, encoding: 'utf-8', timeout: 3000 }
    )
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual(expectedError ? { error: expectedError } : { input: expectedInput })
  })

  it.each(['session-start.js', 'workflow-state.js', 'subagent-context.js', 'skill-router.js', 'task-state.js'])(
    'keeps %s input validation after a temporarily unreadable stdin',
    async (script) => {
      const root = await mkdtemp(join(tmpdir(), 'ccg-stdin-hooks-'))
      cleanupPaths.push(root)
      const args =
        script === 'task-state.js' ? ['resolve', '--root', root, '--session-key', `claude-${'a'.repeat(64)}`] : []
      const result = spawnSync(
        process.execPath,
        [
          '-e',
          `
            const fs = require('node:fs');
            const readSync = fs.readSync;
            let first = true;
            fs.readSync = (...args) => {
              if (args[0] === 0 && first) {
                first = false;
                throw Object.assign(new Error('read failure'), { code: 'EAGAIN' });
              }
              return readSync(...args);
            };
            process.argv = [process.execPath, ${JSON.stringify(join(hooksDir, script))}, ...${JSON.stringify(args)}];
            require('node:module').runMain();
          `,
        ],
        { input: '{broken', encoding: 'utf-8', cwd: root, timeout: 3000 }
      )
      expect(result.error).toBeUndefined()
      expect(result.stderr).toBe('')
      if (script === 'task-state.js') {
        expect(result.status).toBe(2)
        expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, code: 'INVALID_REQUEST' })
      } else {
        expect(result.status).toBe(0)
        expect(JSON.parse(result.stdout).hookSpecificOutput.additionalContext).toContain('HOOK_INPUT_INVALID')
      }
    }
  )
})
