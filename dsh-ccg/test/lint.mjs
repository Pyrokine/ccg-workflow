import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const source = new URL('../src/', import.meta.url)
for (const entry of readdirSync(source, { withFileTypes: true })) {
  if (entry.isFile() && entry.name.endsWith('.js')) {
    execFileSync(process.execPath, ['--check', fileURLToPath(new URL(entry.name, source))], { stdio: 'inherit' })
  }
}
