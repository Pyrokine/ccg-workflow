import fs from 'fs-extra'
import { basename } from 'pathe'
import { SPONSORS } from './sponsors'
import { asRecord, parseJsonRecord } from './installer-codex-content'
import {
  CODEX_MANAGED_FILES,
  codexFileSha256,
  type CodexOriginalFile,
  type CodexManagedFile,
  type CodexModeManifest,
  type CodexInstallPlan,
  type CodexBackup,
  type CodexBackupEntry,
} from './installer-codex-files'

export function isCodexSponsorProvider(value: unknown, sponsorId: string): boolean {
  const sponsor = SPONSORS.find(({ id }) => id === sponsorId)
  const provider = asRecord(value)
  return Boolean(
    sponsor &&
    provider &&
    Object.keys(provider).length === Object.keys(sponsor.codex).length &&
    Object.entries(sponsor.codex).every(([key, expected]) => provider[key] === expected)
  )
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function isBackupName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value !== '.' &&
    value !== '..' &&
    basename(value) === value &&
    /^[A-Za-z0-9._-]+$/.test(value)
  )
}

function isFileMode(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 0o777
}

function parseOriginalFile(value: unknown): CodexOriginalFile {
  const original = asRecord(value)
  const backupName = original?.backupName
  const mode = original?.mode
  const sha256 = original?.sha256
  if (!original || !isBackupName(backupName) || !isFileMode(mode) || !isSha256(sha256)) {
    throw new Error('Codex mode ownership manifest contains an invalid original-file entry')
  }
  return { backupName, mode, sha256 }
}

function parseManagedFile(value: unknown, expected: Set<string>, seen: Set<string>): CodexManagedFile {
  const entry = asRecord(value)
  const relativePath = entry?.relativePath
  const installedSha256 = entry?.installedSha256
  if (
    !entry ||
    typeof relativePath !== 'string' ||
    !expected.has(relativePath) ||
    seen.has(relativePath) ||
    !isSha256(installedSha256)
  ) {
    throw new Error('Codex mode ownership manifest contains an invalid managed-file entry')
  }
  const original = entry.original === null ? null : parseOriginalFile(entry.original)
  seen.add(relativePath)
  return { relativePath, installedSha256, original }
}

function parseSponsorIds(values: unknown[]): string[] {
  const knownSponsors = new Set(SPONSORS.map(({ id }) => id))
  const sponsorProviderIds: string[] = []
  const seenSponsors = new Set<string>()
  for (const value of values) {
    if (typeof value !== 'string' || !knownSponsors.has(value) || seenSponsors.has(value)) {
      throw new Error('Codex mode ownership manifest contains an invalid sponsor provider')
    }
    seenSponsors.add(value)
    sponsorProviderIds.push(value)
  }
  return sponsorProviderIds
}

export function parseCodexModeManifest(content: string): CodexModeManifest {
  const root = parseJsonRecord(content, 'Codex mode ownership manifest')
  if (root.schemaVersion !== 1 || !Array.isArray(root.files) || !Array.isArray(root.sponsorProviderIds)) {
    throw new Error('Codex mode ownership manifest has an unsupported structure')
  }
  const expectedFiles = new Set(CODEX_MANAGED_FILES)
  const seenFiles = new Set<string>()
  const files = root.files.map((value) => parseManagedFile(value, expectedFiles, seenFiles))
  if (seenFiles.size !== expectedFiles.size) {
    throw new Error('Codex mode ownership manifest does not cover every managed runtime file')
  }
  return { schemaVersion: 1, files, sponsorProviderIds: parseSponsorIds(root.sponsorProviderIds) }
}

async function originalFileFromBackup(backup: CodexBackup, entry: CodexBackupEntry): Promise<CodexOriginalFile | null> {
  if (!entry.existed) return null
  if (!entry.backupPath || entry.mode === undefined) {
    throw new Error(`Codex backup entry is incomplete: ${entry.relativePath}`)
  }
  const content = await fs.readFile(entry.backupPath)
  return { backupName: basename(backup.path), mode: entry.mode, sha256: codexFileSha256(content) }
}

export async function buildCodexModeManifest(
  plan: CodexInstallPlan,
  backup: CodexBackup,
  sponsorResults: Array<{ id: string; status: string }>
): Promise<CodexModeManifest> {
  const previousFiles = new Map(plan.previousManifest?.files.map((file) => [file.relativePath, file]) || [])
  const backupEntries = new Map(backup.entries.map((entry) => [entry.relativePath, entry]))
  const plannedFiles = new Map(plan.files.map((file) => [file.relativePath, file]))
  const files: CodexManagedFile[] = []
  for (const relativePath of CODEX_MANAGED_FILES) {
    const planned = plannedFiles.get(relativePath)
    const backupEntry = backupEntries.get(relativePath)
    if (!planned || !backupEntry) throw new Error(`Codex ownership data is incomplete: ${relativePath}`)
    const previous = previousFiles.get(relativePath)
    const original = previous ? previous.original : await originalFileFromBackup(backup, backupEntry)
    files.push({ relativePath, installedSha256: codexFileSha256(planned.content), original })
  }
  const sponsorProviderIds = new Set(plan.retainedSponsorProviderIds)
  for (const result of sponsorResults) {
    if (result.status === 'added') sponsorProviderIds.add(result.id)
  }
  return { schemaVersion: 1, files, sponsorProviderIds: [...sponsorProviderIds] }
}
