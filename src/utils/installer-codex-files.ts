import { createHash, randomUUID } from 'node:crypto'
import fs from 'fs-extra'
import { dirname, join } from 'pathe'

export const TASK_STATE_RUNTIME_FILES = ['package.json', 'task-utils.js', 'task-state.js']
export const CODEX_MANAGED_BLOCK_START_PREFIX = '<!-- CCG:START'
export const CODEX_MANAGED_BLOCK_START =
  '<!-- CCG:START — Managed by CCG Workflow. Do not edit this block manually. -->'
export const CODEX_MANAGED_BLOCK_END = '<!-- CCG:END -->'
export const CODEX_MODE_MANIFEST = '.ccg/codex-mode.json'
export const CODEX_MANAGED_FILES = [
  'agents/ccg-implement.toml',
  'agents/ccg-review.toml',
  'agents/ccg-research.toml',
  'hooks/ccg-workflow.py',
  ...TASK_STATE_RUNTIME_FILES.map((file) => `hooks/ccg/${file}`),
]
export const CODEX_BACKUP_FILES = [
  'AGENTS.md',
  'config.toml',
  'hooks.json',
  ...CODEX_MANAGED_FILES,
  CODEX_MODE_MANIFEST,
]

export type JsonRecord = Record<string, unknown>

export type CodexPlannedFile = {
  relativePath: string
  content: string
  mode: number
}

export type CodexBackupEntry = {
  relativePath: string
  existed: boolean
  mode?: number
  backupPath?: string
}

export type CodexBackup = {
  path: string
  entries: CodexBackupEntry[]
}

export type CodexOriginalFile = {
  backupName: string
  mode: number
  sha256: string
}

export type CodexManagedFile = {
  relativePath: string
  installedSha256: string
  original: CodexOriginalFile | null
}

export type CodexModeManifest = {
  schemaVersion: 1
  files: CodexManagedFile[]
  sponsorProviderIds: string[]
}

export type CodexInstallPlan = {
  files: CodexPlannedFile[]
  activeProvider: unknown
  previousManifest: CodexModeManifest | null
  retainedSponsorProviderIds: string[]
}

export function codexFileSha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

export async function lstatOptional(path: string): Promise<import('node:fs').Stats | undefined> {
  return fs.lstat(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  })
}

export async function assertSafeCodexDirectory(path: string): Promise<boolean> {
  const current = await lstatOptional(path)
  if (!current) return false
  if (!current.isDirectory() || current.isSymbolicLink()) {
    throw new Error(`Refusing to use non-regular Codex directory: ${path}`)
  }
  return true
}

export async function ensureSafeCodexDirectory(path: string): Promise<void> {
  if (await assertSafeCodexDirectory(path)) return
  await fs.mkdir(path, { mode: 0o700 })
}

export async function assertCodexPathLayout(codexHome: string): Promise<void> {
  if (!(await assertSafeCodexDirectory(codexHome))) return
  for (const relativePath of ['agents', 'hooks', 'hooks/ccg', '.ccg', '.ccg/backups']) {
    const path = join(codexHome, relativePath)
    const current = await lstatOptional(path)
    if (current && (!current.isDirectory() || current.isSymbolicLink())) {
      throw new Error(`Refusing to use non-regular Codex directory: ${path}`)
    }
  }
}

export async function ensureCodexPathLayout(codexHome: string): Promise<void> {
  for (const path of [
    codexHome,
    join(codexHome, 'agents'),
    join(codexHome, 'hooks'),
    join(codexHome, 'hooks', 'ccg'),
  ]) {
    await ensureSafeCodexDirectory(path)
  }
}

export async function readOptionalCodexFile(path: string): Promise<{ content: string; mode: number } | null> {
  const current = await lstatOptional(path)
  if (!current) return null
  if (!current.isFile() || current.isSymbolicLink()) {
    throw new Error(`Refusing to read non-regular Codex file: ${path}`)
  }
  return { content: await fs.readFile(path, 'utf-8'), mode: current.mode & 0o777 }
}

export async function readRequiredCodexSource(path: string): Promise<string> {
  const current = await lstatOptional(path)
  if (!current?.isFile() || current.isSymbolicLink()) {
    throw new Error(`Required Codex mode source file not found: ${path}`)
  }
  return fs.readFile(path, 'utf-8')
}

export async function writeCodexFileAtomic(path: string, content: string | Buffer, defaultMode: number): Promise<void> {
  const current = await lstatOptional(path)
  if (current && (!current.isFile() || current.isSymbolicLink())) {
    throw new Error(`Refusing to replace non-regular Codex file: ${path}`)
  }

  const mode = current ? current.mode & 0o777 : defaultMode
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(tempPath, content, { flag: 'wx', mode })
    await fs.chmod(tempPath, mode)
    await fs.rename(tempPath, path)
  } finally {
    await fs.remove(tempPath).catch(() => undefined)
  }
}

export async function removeRegularCodexFile(path: string): Promise<boolean> {
  const current = await lstatOptional(path)
  if (!current) return false
  if (!current.isFile() || current.isSymbolicLink()) {
    throw new Error(`Refusing to remove non-regular Codex file: ${path}`)
  }
  await fs.remove(path)
  return true
}

export async function createCodexBackup(codexHome: string): Promise<CodexBackup> {
  const ccgDir = join(codexHome, '.ccg')
  const backupsDir = join(ccgDir, 'backups')
  await ensureSafeCodexDirectory(ccgDir)
  await ensureSafeCodexDirectory(backupsDir)
  const backupName = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`
  const backupPath = join(backupsDir, backupName)
  await ensureSafeCodexDirectory(backupPath)
  const filesPath = join(backupPath, 'files')
  await ensureSafeCodexDirectory(filesPath)

  const entries: CodexBackupEntry[] = []
  for (const relativePath of CODEX_BACKUP_FILES) {
    const source = join(codexHome, relativePath)
    const current = await lstatOptional(source)
    if (!current) {
      entries.push({ relativePath, existed: false })
      continue
    }
    if (!current.isFile() || current.isSymbolicLink()) {
      throw new Error(`Refusing to back up non-regular Codex file: ${source}`)
    }
    const backupFile = join(filesPath, relativePath)
    await fs.ensureDir(dirname(backupFile), { mode: 0o700 })
    await fs.copyFile(source, backupFile)
    await fs.chmod(backupFile, current.mode & 0o777)
    entries.push({
      relativePath,
      existed: true,
      mode: current.mode & 0o777,
      backupPath: backupFile,
    })
  }

  await writeCodexFileAtomic(
    join(backupPath, 'manifest.json'),
    `${JSON.stringify({ schemaVersion: 1, createdAt: new Date().toISOString(), files: entries }, null, 2)}\n`,
    0o600
  )
  return { path: backupPath, entries }
}

export async function restoreCodexBackup(codexHome: string, backup: CodexBackup): Promise<void> {
  for (const entry of [...backup.entries].reverse()) {
    const target = join(codexHome, entry.relativePath)
    if (!entry.existed) {
      await removeRegularCodexFile(target)
      continue
    }
    if (!entry.backupPath || entry.mode === undefined) {
      throw new Error(`Codex backup entry is incomplete: ${entry.relativePath}`)
    }
    const source = await lstatOptional(entry.backupPath)
    if (!source?.isFile() || source.isSymbolicLink()) {
      throw new Error(`Codex backup file is unavailable: ${entry.relativePath}`)
    }
    await writeCodexFileAtomic(target, await fs.readFile(entry.backupPath), entry.mode)
  }
}

async function originalBackupPath(codexHome: string, backupName: string, relativePath: string): Promise<string> {
  const backupsRoot = join(codexHome, '.ccg', 'backups')
  const backupDir = join(backupsRoot, backupName)
  const filesDir = join(backupDir, 'files')
  for (const directory of [backupsRoot, backupDir, filesDir]) {
    if (!(await assertSafeCodexDirectory(directory))) {
      throw new Error(`Codex original-file backup directory is unavailable: ${relativePath}`)
    }
  }

  let parent = filesDir
  for (const segment of dirname(relativePath).split('/')) {
    if (segment === '.') continue
    parent = join(parent, segment)
    if (!(await assertSafeCodexDirectory(parent))) {
      throw new Error(`Codex original-file backup directory is unavailable: ${relativePath}`)
    }
  }

  return join(filesDir, relativePath)
}

export async function readCodexOriginalFile(
  codexHome: string,
  managedFile: CodexManagedFile
): Promise<{ content: Buffer; mode: number } | null> {
  const original = managedFile.original
  if (!original) return null

  const sourcePath = await originalBackupPath(codexHome, original.backupName, managedFile.relativePath)
  const source = await lstatOptional(sourcePath)
  if (!source?.isFile() || source.isSymbolicLink()) {
    throw new Error(`Codex original-file backup is unavailable: ${managedFile.relativePath}`)
  }
  const content = await fs.readFile(sourcePath)
  if (codexFileSha256(content) !== original.sha256) {
    throw new Error(`Codex original-file backup checksum mismatch: ${managedFile.relativePath}`)
  }
  return { content, mode: original.mode }
}

export async function removeOrRestoreCodexManagedFile(
  codexHome: string,
  managedFile: CodexManagedFile
): Promise<'removed' | 'restored' | 'missing' | 'preserved'> {
  const targetPath = join(codexHome, managedFile.relativePath)
  const current = await readOptionalCodexFile(targetPath)
  if (current && codexFileSha256(current.content) !== managedFile.installedSha256) return 'preserved'

  const original = await readCodexOriginalFile(codexHome, managedFile)
  if (original) {
    await writeCodexFileAtomic(targetPath, original.content, original.mode)
    return 'restored'
  }
  if (!current) return 'missing'
  await removeRegularCodexFile(targetPath)
  return 'removed'
}
