import { createHash, randomUUID } from 'node:crypto'
import { rename } from 'node:fs/promises'
import ansis from 'ansis'
import fs from 'fs-extra'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'pathe'
import { parse as parseToml } from 'smol-toml'
import type { InstallResult } from '../types'
import { normalizeRoutingForInstall, readCcgConfig } from './config'
import { configureAllSponsorsForCodex, removeSponsorsFromCodex } from './installer-codex-api'
import { getAllCommandIds, getLegacyCommandIds, getWorkflowById } from './installer-data'
import { injectConfigVariables, PACKAGE_ROOT, replaceHomePathsInTemplate } from './installer-template'
import { collectSkills, installSkillCommands } from './skill-registry'
import { SPONSORS } from './sponsors'

// ═══════════════════════════════════════════════════════
// Re-exports — all consumers import from './installer'
// These re-exports preserve backward compatibility.
// ═══════════════════════════════════════════════════════

export {
  getAllCommandIds,
  getCoreCommandIds,
  getLegacyCommandIds,
  getWorkflowById,
  getWorkflowConfigs,
  getWorkflowPreset,
  WORKFLOW_PRESETS,
} from './installer-data'
export type { WorkflowPreset } from './installer-data'

export { injectConfigVariables } from './installer-template'

export {
  APIMART_CODEX_PROVIDER,
  APIMART_CODEX_PROVIDER_ID,
  PACKYCODE_CODEX_PROVIDER,
  PACKYCODE_CODEX_PROVIDER_ID,
  configureAllSponsorsForCodex,
  configureApiMartForCodex,
  configurePackyCodeForCodex,
  configureSponsorForCodex,
  removeAllSponsorsFromCodex,
  removeApiMartFromCodex,
  removePackyCodeFromCodex,
  removeSponsorFromCodex,
} from './installer-codex-api'
export type {
  CodexApiResult,
  CodexProviderStatus,
  CodexSponsorResult,
  CodexSponsorsResult,
} from './installer-codex-api'

export {
  SPONSORS,
  getSponsor,
  promptSponsorInit,
  promptSponsorMenuKey,
  sponsorCopy,
  sponsorInquirerChoices,
} from './sponsors'
export type { CodexProviderSpec, SponsorGateway } from './sponsors'

export {
  installAceTool,
  installAceToolRs,
  installContextWeaver,
  installFastContext,
  installMcpServer,
  syncMcpToCodex,
  uninstallAceTool,
  uninstallContextWeaver,
  uninstallFastContext,
  uninstallMcpServer,
} from './installer-mcp'
export type { ContextWeaverConfig } from './installer-mcp'

export { removeFastContextPrompt, writeFastContextPrompt } from './installer-prompt'

export { collectInvocableSkills, collectSkills, parseFrontmatter } from './skill-registry'
export type { SkillMeta } from './skill-registry'

// ═══════════════════════════════════════════════════════
// Binary version tracking
// ═══════════════════════════════════════════════════════

/**
 * Expected codeagent-wrapper binary version.
 * Must match the `version` constant in codeagent-wrapper/main.go.
 * When this differs from the installed binary, update triggers re-download.
 */
const EXPECTED_BINARY_VERSION = '5.15.0-aug.1'

// ═══════════════════════════════════════════════════════
// Install context — shared across sub-functions
// ═══════════════════════════════════════════════════════

interface InstallConfig {
  routing: {
    mode: string
    frontend: { models: string[]; primary: string }
    backend: { models: string[]; primary: string }
    review: {
      profiles: Array<{
        id: 'gpt' | 'grok'
        model?: string
        effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
      }>
      strategy?: string
    }
    proxy?: { models?: string[]; http?: string; https?: string }
    grokModel?: string
    kimiModel?: string
    opencodeModel?: string
  }
  liteMode: boolean
  mcpProvider: string
  skipImpeccable?: boolean
  skipBinary?: boolean
}

interface InstallContext {
  installDir: string
  force: boolean
  config: InstallConfig
  templateDir: string
  result: InstallResult
}

// ═══════════════════════════════════════════════════════
// Binary download
// ═══════════════════════════════════════════════════════

const GITHUB_REPO = 'Pyrokine/ccg-workflow'
const RELEASE_TAG = 'preset'
const BINARY_SOURCE = {
  name: 'GitHub Release',
  url: `https://github.com/${GITHUB_REPO}/releases/download/${RELEASE_TAG}`,
  timeoutMs: 120_000,
}

/**
 * Download binary from a single URL with retry.
 * Uses curl for proxy support (reads HTTPS_PROXY / ALL_PROXY env vars automatically).
 * Falls back to Node.js fetch if curl is unavailable.
 */
async function downloadFromUrl(url: string, destPath: string, timeoutMs: number, maxAttempts = 2): Promise<boolean> {
  const timeoutSec = Math.ceil(timeoutMs / 1000)

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // Prefer curl — auto-reads HTTPS_PROXY / ALL_PROXY for proxy support
      const { execSync } = await import('node:child_process')
      execSync(`curl -fsSL --max-time ${timeoutSec} -o "${destPath}" "${url}"`, {
        stdio: 'pipe',
        timeout: timeoutMs + 5000,
      })

      if (process.platform !== 'win32') {
        await fs.chmod(destPath, 0o755)
      }
      return true
    } catch {
      // curl failed — try Node.js fetch as fallback (no proxy support)
      try {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), timeoutMs)

        const response = await fetch(url, { redirect: 'follow', signal: controller.signal })
        if (!response.ok) {
          clearTimeout(timer)
          if (attempt < maxAttempts) {
            await new Promise((resolve) => setTimeout(resolve, attempt * 2000))
            continue
          }
          return false
        }

        const buffer = Buffer.from(await response.arrayBuffer())
        clearTimeout(timer)

        await fs.writeFile(destPath, buffer)
        if (process.platform !== 'win32') {
          await fs.chmod(destPath, 0o755)
        }
        return true
      } catch {
        if (attempt < maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, attempt * 2000))
          continue
        }
        return false
      }
    }
  }
  return false
}

/** Download codeagent-wrapper binary from the fork GitHub Release. */
async function downloadBinaryFromRelease(binaryName: string, destPath: string): Promise<boolean> {
  const url = `${BINARY_SOURCE.url}/${binaryName}`
  return downloadFromUrl(url, destPath, BINARY_SOURCE.timeoutMs)
}

// ═══════════════════════════════════════════════════════
// Shared file-copy helper
// ═══════════════════════════════════════════════════════

async function backupRoutingTemplate(ctx: InstallContext, destFile: string, content: string): Promise<void> {
  if (!(await fs.pathExists(destFile))) {
    return
  }

  const existing = await fs.readFile(destFile, 'utf-8')
  if (existing === content) {
    return
  }

  const backupRoot = join(ctx.installDir, '.ccg', 'backup', 'routing-templates')
  const relativePath = destFile.slice(ctx.installDir.length + 1)
  const manifestPath = join(backupRoot, 'manifest.json')
  const manifest = (await fs.pathExists(manifestPath))
    ? ((await fs.readJson(manifestPath)) as Record<
        string,
        { originalSha256: string; replacementSha256: string; snapshots?: string[] }
      >)
    : {}
  const existingSha256 = createHash('sha256').update(existing).digest('hex')
  const replacementSha256 = createHash('sha256').update(content).digest('hex')
  const previous = manifest[relativePath]

  if (previous?.replacementSha256 === existingSha256) {
    return
  }

  const primaryBackup = join(backupRoot, relativePath)
  const backupFile = previous ? `${primaryBackup}.${existingSha256.slice(0, 12)}` : primaryBackup
  if (!(await fs.pathExists(backupFile))) {
    await fs.ensureDir(dirname(backupFile))
    await fs.copy(destFile, backupFile, { overwrite: false })
    ctx.result.backupPath = backupRoot
    ctx.result.backedUpFiles ??= []
    ctx.result.backedUpFiles.push(backupFile)
  }

  if (previous) {
    previous.snapshots = [...new Set([...(previous.snapshots || []), existingSha256])]
  } else {
    manifest[relativePath] = { originalSha256: existingSha256, replacementSha256 }
  }
  await fs.writeJson(manifestPath, manifest, { spaces: 2 })
}

/**
 * Copy .md templates from srcDir → destDir with optional variable injection.
 * Returns list of installed file stems (filename without .md).
 */
async function copyMdTemplates(
  ctx: InstallContext,
  srcDir: string,
  destDir: string,
  options: { inject?: boolean; backupExisting?: boolean } = {}
): Promise<string[]> {
  const installed: string[] = []
  if (!(await fs.pathExists(srcDir))) {
    // Log warning — helps diagnose "0 commands installed" issues
    console.error(`[CCG] Template source directory not found: ${srcDir}`)
    return installed
  }

  await fs.ensureDir(destDir)
  const files = await fs.readdir(srcDir)
  for (const file of files) {
    if (!file.endsWith('.md')) continue
    const sourceFile = join(srcDir, file)
    const destFile = join(destDir, file)
    if (ctx.force || !(await fs.pathExists(destFile))) {
      let content = await fs.readFile(sourceFile, 'utf-8')
      if (options.inject) content = injectConfigVariables(content, ctx.config)
      content = replaceHomePathsInTemplate(content, ctx.installDir)

      if (options.backupExisting) {
        await backupRoutingTemplate(ctx, destFile, content)
      }

      await fs.writeFile(destFile, content, 'utf-8')
      installed.push(file.replace('.md', ''))
    }
  }
  return installed
}

async function createCodexInstallConfig(): Promise<InstallConfig> {
  const config = await readCcgConfig()
  return {
    routing: normalizeRoutingForInstall(config?.routing),
    liteMode: config?.performance?.liteMode ?? true,
    mcpProvider: config?.mcp?.provider || 'fast-context',
    skipImpeccable: config?.performance?.skipImpeccable ?? false,
    skipBinary: false,
  }
}

function renderCodexPaths(content: string): string {
  const userHome = homedir().replace(/\\/g, '/')
  return content.replace(/~\//g, `${userHome}/`)
}

function renderCodexTemplate(content: string, config: InstallConfig): string {
  return renderCodexPaths(injectConfigVariables(content, config))
}

const TASK_STATE_RUNTIME_FILES = ['package.json', 'task-utils.js', 'task-state.js']
const CODEX_MANAGED_BLOCK_START_PREFIX = '<!-- CCG:START'
const CODEX_MANAGED_BLOCK_START = '<!-- CCG:START — Managed by CCG Workflow. Do not edit this block manually. -->'
const CODEX_MANAGED_BLOCK_END = '<!-- CCG:END -->'
const CODEX_MODE_MANIFEST = '.ccg/codex-mode.json'
const CODEX_MANAGED_FILES = [
  'agents/ccg-implement.toml',
  'agents/ccg-review.toml',
  'agents/ccg-research.toml',
  'hooks/ccg-workflow.py',
  ...TASK_STATE_RUNTIME_FILES.map((file) => `hooks/ccg/${file}`),
]
const CODEX_BACKUP_FILES = ['AGENTS.md', 'config.toml', 'hooks.json', ...CODEX_MANAGED_FILES, CODEX_MODE_MANIFEST]

type JsonRecord = Record<string, unknown>

type CodexPlannedFile = {
  relativePath: string
  content: string
  mode: number
}

type CodexBackupEntry = {
  relativePath: string
  existed: boolean
  mode?: number
  backupPath?: string
}

type CodexBackup = {
  path: string
  entries: CodexBackupEntry[]
}

type CodexOriginalFile = {
  backupName: string
  mode: number
  sha256: string
}

type CodexManagedFile = {
  relativePath: string
  installedSha256: string
  original: CodexOriginalFile | null
}

type CodexModeManifest = {
  schemaVersion: 1
  files: CodexManagedFile[]
  sponsorProviderIds: string[]
}

type CodexInstallPlan = {
  files: CodexPlannedFile[]
  activeProvider: unknown
  previousManifest: CodexModeManifest | null
  retainedSponsorProviderIds: string[]
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : null
}

function codexFileSha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

function isCodexSponsorProvider(value: unknown, sponsorId: string): boolean {
  const sponsor = SPONSORS.find(({ id }) => id === sponsorId)
  const provider = asRecord(value)
  return Boolean(
    sponsor &&
    provider &&
    Object.keys(provider).length === Object.keys(sponsor.codex).length &&
    Object.entries(sponsor.codex).every(([key, expected]) => provider[key] === expected)
  )
}

function parseCodexModeManifest(content: string): CodexModeManifest {
  const root = parseJsonRecord(content, 'Codex mode ownership manifest')
  if (root.schemaVersion !== 1 || !Array.isArray(root.files) || !Array.isArray(root.sponsorProviderIds)) {
    throw new Error('Codex mode ownership manifest has an unsupported structure')
  }

  const expectedFiles = new Set(CODEX_MANAGED_FILES)
  const files: CodexManagedFile[] = []
  const seenFiles = new Set<string>()
  for (const value of root.files) {
    const entry = asRecord(value)
    const relativePath = entry?.relativePath
    const installedSha256 = entry?.installedSha256
    if (
      !entry ||
      typeof relativePath !== 'string' ||
      !expectedFiles.has(relativePath) ||
      seenFiles.has(relativePath) ||
      typeof installedSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(installedSha256)
    ) {
      throw new Error('Codex mode ownership manifest contains an invalid managed-file entry')
    }

    let original: CodexOriginalFile | null = null
    if (entry.original !== null) {
      const originalRecord = asRecord(entry.original)
      const backupName = originalRecord?.backupName
      const mode = originalRecord?.mode
      const sha256 = originalRecord?.sha256
      if (
        !originalRecord ||
        typeof backupName !== 'string' ||
        backupName === '.' ||
        backupName === '..' ||
        basename(backupName) !== backupName ||
        !/^[A-Za-z0-9._-]+$/.test(backupName) ||
        !Number.isInteger(mode) ||
        (mode as number) < 0 ||
        (mode as number) > 0o777 ||
        typeof sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(sha256)
      ) {
        throw new Error('Codex mode ownership manifest contains an invalid original-file entry')
      }
      original = { backupName, mode: mode as number, sha256 }
    }

    seenFiles.add(relativePath)
    files.push({ relativePath, installedSha256, original })
  }
  if (seenFiles.size !== expectedFiles.size) {
    throw new Error('Codex mode ownership manifest does not cover every managed runtime file')
  }

  const knownSponsors = new Set(SPONSORS.map(({ id }) => id))
  const sponsorProviderIds: string[] = []
  const seenSponsors = new Set<string>()
  for (const value of root.sponsorProviderIds) {
    if (typeof value !== 'string' || !knownSponsors.has(value) || seenSponsors.has(value)) {
      throw new Error('Codex mode ownership manifest contains an invalid sponsor provider')
    }
    seenSponsors.add(value)
    sponsorProviderIds.push(value)
  }

  return { schemaVersion: 1, files, sponsorProviderIds }
}

async function lstatOptional(path: string): Promise<import('node:fs').Stats | undefined> {
  return fs.lstat(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  })
}

async function assertSafeCodexDirectory(path: string): Promise<boolean> {
  const current = await lstatOptional(path)
  if (!current) return false
  if (!current.isDirectory() || current.isSymbolicLink()) {
    throw new Error(`Refusing to use non-regular Codex directory: ${path}`)
  }
  return true
}

async function ensureSafeCodexDirectory(path: string): Promise<void> {
  if (await assertSafeCodexDirectory(path)) return
  await fs.mkdir(path, { mode: 0o700 })
}

async function assertCodexPathLayout(codexHome: string): Promise<void> {
  if (!(await assertSafeCodexDirectory(codexHome))) return
  for (const relativePath of ['agents', 'hooks', 'hooks/ccg', '.ccg', '.ccg/backups']) {
    const path = join(codexHome, relativePath)
    const current = await lstatOptional(path)
    if (current && (!current.isDirectory() || current.isSymbolicLink())) {
      throw new Error(`Refusing to use non-regular Codex directory: ${path}`)
    }
  }
}

async function ensureCodexPathLayout(codexHome: string): Promise<void> {
  for (const path of [
    codexHome,
    join(codexHome, 'agents'),
    join(codexHome, 'hooks'),
    join(codexHome, 'hooks', 'ccg'),
  ]) {
    await ensureSafeCodexDirectory(path)
  }
}

async function readOptionalCodexFile(path: string): Promise<{ content: string; mode: number } | null> {
  const current = await lstatOptional(path)
  if (!current) return null
  if (!current.isFile() || current.isSymbolicLink()) {
    throw new Error(`Refusing to read non-regular Codex file: ${path}`)
  }
  return { content: await fs.readFile(path, 'utf-8'), mode: current.mode & 0o777 }
}

async function readRequiredCodexSource(path: string): Promise<string> {
  const current = await lstatOptional(path)
  if (!current?.isFile() || current.isSymbolicLink()) {
    throw new Error(`Required Codex mode source file not found: ${path}`)
  }
  return fs.readFile(path, 'utf-8')
}

async function writeCodexFileAtomic(path: string, content: string | Buffer, defaultMode: number): Promise<void> {
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

async function removeRegularCodexFile(path: string): Promise<boolean> {
  const current = await lstatOptional(path)
  if (!current) return false
  if (!current.isFile() || current.isSymbolicLink()) {
    throw new Error(`Refusing to remove non-regular Codex file: ${path}`)
  }
  await fs.remove(path)
  return true
}

function markerOffsets(content: string, marker: string): number[] {
  const offsets: number[] = []
  let offset = 0
  while (offset < content.length) {
    const found = content.indexOf(marker, offset)
    if (found < 0) break
    offsets.push(found)
    offset = found + marker.length
  }
  return offsets
}

function locateCodexManagedBlock(content: string): { start: number; end: number } | null {
  const startPrefixes = markerOffsets(content, CODEX_MANAGED_BLOCK_START_PREFIX)
  const starts = markerOffsets(content, CODEX_MANAGED_BLOCK_START)
  const ends = markerOffsets(content, CODEX_MANAGED_BLOCK_END)
  if (startPrefixes.length === 0 && ends.length === 0) return null
  if (
    startPrefixes.length !== 1 ||
    starts.length !== 1 ||
    startPrefixes[0] !== starts[0] ||
    ends.length !== 1 ||
    starts[0] >= ends[0]
  ) {
    throw new Error('Codex AGENTS.md contains damaged or duplicate CCG managed-block markers')
  }
  return { start: starts[0], end: ends[0] + CODEX_MANAGED_BLOCK_END.length }
}

function extractCodexManagedBlock(content: string): string {
  const location = locateCodexManagedBlock(content)
  if (!location || content.slice(0, location.start).trim() || content.slice(location.end).trim()) {
    throw new Error('Codex AGENTS.md template must contain exactly one standalone CCG managed block')
  }
  return content.slice(location.start, location.end)
}

function renderCodexManagedBlock(template: string, config: InstallConfig): string {
  extractCodexManagedBlock(template)
  const rendered = renderCodexTemplate(template, config)
  const location = locateCodexManagedBlock(rendered)
  if (!location || rendered.slice(location.end).trim()) {
    throw new Error('Rendered Codex AGENTS.md template has content after the CCG managed block')
  }

  const prefix = rendered.slice(0, location.start).trim()
  const block = rendered.slice(location.start, location.end)
  if (!prefix) return block
  const startMarkerEnd = block.indexOf('-->') + 3
  const body = block.slice(startMarkerEnd).replace(/^\s*/, '')
  return `${block.slice(0, startMarkerEnd)}\n\n${prefix}\n\n${body}`
}

function mergeCodexManagedBlock(existing: string | null, block: string): string {
  if (existing === null || existing.length === 0) return `${block}\n`
  const location = locateCodexManagedBlock(existing)
  if (location) return `${existing.slice(0, location.start)}${block}${existing.slice(location.end)}`
  const separator = existing.endsWith('\n') ? '\n' : '\n\n'
  return `${existing}${separator}${block}\n`
}

function removeCodexManagedBlock(existing: string): { content: string; changed: boolean } {
  const location = locateCodexManagedBlock(existing)
  if (!location) return { content: existing, changed: false }
  let content = `${existing.slice(0, location.start)}${existing.slice(location.end)}`
  if (!content.trim()) return { content: '', changed: true }
  if (content.startsWith('\n') && location.start === 0) content = content.slice(1)
  if (content.endsWith('\n\n') && location.end === existing.length) content = content.slice(0, -1)
  return { content, changed: true }
}

function parseJsonRecord(content: string, label: string): JsonRecord {
  let value: unknown
  try {
    value = JSON.parse(content)
  } catch (error) {
    throw new Error(`${label} is invalid JSON`, { cause: error })
  }
  const record = asRecord(value)
  if (!record) throw new Error(`${label} root must be an object`)
  return record
}

function isCodexWorkflowHookCommand(command: unknown, codexHome: string): boolean {
  if (typeof command !== 'string') return false
  const normalized = command.replace(/\\/g, '/').trim()
  const match = /^python3\s+(?:"([^"]+)"|'([^']+)'|(\S+))$/.exec(normalized)
  const scriptPath = match?.[1] || match?.[2] || match?.[3]
  if (!scriptPath) return false
  const expected = join(codexHome, 'hooks', 'ccg-workflow.py').replace(/\\/g, '/')
  return scriptPath === expected || scriptPath === '~/.codex/hooks/ccg-workflow.py'
}

function removeCodexWorkflowHooks(root: JsonRecord, codexHome: string): { root: JsonRecord; changed: boolean } {
  const configuredHooks = root.hooks
  if (configuredHooks === undefined) return { root: { ...root }, changed: false }
  const hooks = asRecord(configuredHooks)
  if (!hooks) throw new Error('Codex hooks.json hooks must be an object')

  const nextHooks: JsonRecord = { ...hooks }
  let changed = false
  for (const [event, value] of Object.entries(hooks)) {
    if (!Array.isArray(value)) throw new Error(`Codex hooks.json hooks.${event} must be an array`)
    const entries = value
      .map((entry) => {
        const entryRecord = asRecord(entry)
        if (!entryRecord || !Array.isArray(entryRecord.hooks)) return entry
        const kept = entryRecord.hooks.filter((hook) => {
          const hookRecord = asRecord(hook)
          return !hookRecord || !isCodexWorkflowHookCommand(hookRecord.command, codexHome)
        })
        if (kept.length === entryRecord.hooks.length) return entry
        changed = true
        return kept.length > 0 ? { ...entryRecord, hooks: kept } : null
      })
      .filter((entry) => entry !== null)
    if (entries.length > 0) nextHooks[event] = entries
    else delete nextHooks[event]
  }

  const nextRoot = { ...root }
  if (Object.keys(nextHooks).length > 0) nextRoot.hooks = nextHooks
  else delete nextRoot.hooks
  return { root: nextRoot, changed }
}

function canonicalCodexHookDefinition(content: string, codexHome: string): JsonRecord {
  const root = parseJsonRecord(content, 'Codex hooks template')
  const hooks = asRecord(root.hooks)
  const entries = hooks?.UserPromptSubmit
  if (!Array.isArray(entries) || entries.length !== 1) {
    throw new Error('Codex hooks template must define exactly one UserPromptSubmit entry')
  }
  const entry = asRecord(entries[0])
  const commands = entry?.hooks
  if (
    !entry ||
    !Array.isArray(commands) ||
    commands.length !== 1 ||
    !isCodexWorkflowHookCommand(asRecord(commands[0])?.command, codexHome)
  ) {
    throw new Error('Codex hooks template does not contain the expected CCG command Hook')
  }
  return JSON.parse(JSON.stringify(entry)) as JsonRecord
}

function mergeCodexHooks(existing: string | null, definition: JsonRecord, codexHome: string): string {
  const root = existing === null ? {} : parseJsonRecord(existing, 'Codex hooks.json')
  const cleaned = removeCodexWorkflowHooks(root, codexHome).root
  const hooks = asRecord(cleaned.hooks) || {}
  const existingEntries = hooks.UserPromptSubmit
  if (existingEntries !== undefined && !Array.isArray(existingEntries)) {
    throw new Error('Codex hooks.json hooks.UserPromptSubmit must be an array')
  }
  cleaned.hooks = {
    ...hooks,
    UserPromptSubmit: [...((existingEntries || []) as unknown[]), definition],
  }
  return `${JSON.stringify(cleaned, null, 2)}\n`
}

function removeCodexHookRegistration(
  existing: string,
  codexHome: string
): { content: string; changed: boolean; empty: boolean } {
  const root = parseJsonRecord(existing, 'Codex hooks.json')
  const cleaned = removeCodexWorkflowHooks(root, codexHome)
  return {
    content: `${JSON.stringify(cleaned.root, null, 2)}\n`,
    changed: cleaned.changed,
    empty: Object.keys(cleaned.root).length === 0,
  }
}

function parseCodexConfig(content: string | null): JsonRecord {
  if (content === null) return {}
  const config = asRecord(parseToml(content))
  if (!config) throw new Error('Codex config.toml root must be a TOML table')
  return config
}

function assertCodexModeFeatures(config: JsonRecord): void {
  const features = config.features
  if (features === undefined) return
  const featureTable = asRecord(features)
  if (!featureTable) throw new Error('Codex config.toml features must be a TOML table')
  if (featureTable.hooks === false) {
    throw new Error('Codex config.toml explicitly disables the hooks feature required by CCG Codex mode')
  }
  if (featureTable.multi_agent === false) {
    throw new Error('Codex config.toml explicitly disables the multi_agent feature required by CCG Codex mode')
  }
}

async function createCodexBackup(codexHome: string): Promise<CodexBackup> {
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

async function restoreCodexBackup(codexHome: string, backup: CodexBackup): Promise<void> {
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

async function readCodexOriginalFile(
  codexHome: string,
  managedFile: CodexManagedFile
): Promise<{ content: Buffer; mode: number } | null> {
  const original = managedFile.original
  if (!original) return null

  const backupsRoot = join(codexHome, '.ccg', 'backups')
  const backupDir = join(backupsRoot, original.backupName)
  const filesDir = join(backupDir, 'files')
  for (const directory of [backupsRoot, backupDir, filesDir]) {
    if (!(await assertSafeCodexDirectory(directory))) {
      throw new Error(`Codex original-file backup directory is unavailable: ${managedFile.relativePath}`)
    }
  }

  let parent = filesDir
  for (const segment of dirname(managedFile.relativePath).split('/')) {
    if (segment === '.') continue
    parent = join(parent, segment)
    if (!(await assertSafeCodexDirectory(parent))) {
      throw new Error(`Codex original-file backup directory is unavailable: ${managedFile.relativePath}`)
    }
  }

  const sourcePath = join(filesDir, managedFile.relativePath)
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

async function buildCodexModeManifest(
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
    let original = previous?.original ?? null
    if (!previous && backupEntry.existed) {
      if (!backupEntry.backupPath || backupEntry.mode === undefined) {
        throw new Error(`Codex backup entry is incomplete: ${relativePath}`)
      }
      const originalContent = await fs.readFile(backupEntry.backupPath)
      original = {
        backupName: basename(backup.path),
        mode: backupEntry.mode,
        sha256: codexFileSha256(originalContent),
      }
    }
    files.push({ relativePath, installedSha256: codexFileSha256(planned.content), original })
  }

  const sponsorProviderIds = new Set(plan.retainedSponsorProviderIds)
  for (const result of sponsorResults) {
    if (result.status === 'added') sponsorProviderIds.add(result.id)
  }
  return { schemaVersion: 1, files, sponsorProviderIds: [...sponsorProviderIds] }
}

async function removeOrRestoreCodexManagedFile(
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

async function prepareCodexInstall(
  codexTemplateDir: string,
  codexHome: string,
  config: InstallConfig
): Promise<CodexInstallPlan> {
  await assertCodexPathLayout(codexHome)

  const agentsTemplate = await readRequiredCodexSource(join(codexTemplateDir, 'AGENTS.md'))
  const managedBlock = renderCodexManagedBlock(agentsTemplate, config)
  const existingAgents = await readOptionalCodexFile(join(codexHome, 'AGENTS.md'))

  const hooksTemplate = renderCodexPaths(await readRequiredCodexSource(join(codexTemplateDir, 'hooks.json')))
  const hookDefinition = canonicalCodexHookDefinition(hooksTemplate, codexHome)
  const existingHooks = await readOptionalCodexFile(join(codexHome, 'hooks.json'))

  const existingConfig = await readOptionalCodexFile(join(codexHome, 'config.toml'))
  const parsedConfig = parseCodexConfig(existingConfig?.content ?? null)
  assertCodexModeFeatures(parsedConfig)

  const manifestFile = await readOptionalCodexFile(join(codexHome, CODEX_MODE_MANIFEST))
  const previousManifest = manifestFile ? parseCodexModeManifest(manifestFile.content) : null
  if (previousManifest) {
    for (const managedFile of previousManifest.files) {
      if (managedFile.original) await readCodexOriginalFile(codexHome, managedFile)
    }
  }
  const providers = asRecord(parsedConfig.model_providers)
  const retainedSponsorProviderIds =
    previousManifest?.sponsorProviderIds.filter((id) => providers && isCodexSponsorProvider(providers[id], id)) || []

  const files: CodexPlannedFile[] = [
    {
      relativePath: 'AGENTS.md',
      content: mergeCodexManagedBlock(existingAgents?.content ?? null, managedBlock),
      mode: existingAgents?.mode ?? 0o644,
    },
    {
      relativePath: 'hooks.json',
      content: mergeCodexHooks(existingHooks?.content ?? null, hookDefinition, codexHome),
      mode: existingHooks?.mode ?? 0o600,
    },
  ]

  for (const name of ['ccg-implement.toml', 'ccg-review.toml', 'ccg-research.toml']) {
    files.push({
      relativePath: `agents/${name}`,
      content: await readRequiredCodexSource(join(codexTemplateDir, 'agents', name)),
      mode: 0o644,
    })
  }
  files.push({
    relativePath: 'hooks/ccg-workflow.py',
    content: renderCodexPaths(await readRequiredCodexSource(join(codexTemplateDir, 'hooks', 'ccg-workflow.py'))),
    mode: 0o644,
  })
  for (const name of TASK_STATE_RUNTIME_FILES) {
    files.push({
      relativePath: `hooks/ccg/${name}`,
      content: await readRequiredCodexSource(join(PACKAGE_ROOT, 'templates', 'hooks', name)),
      mode: 0o644,
    })
  }

  for (const file of CODEX_BACKUP_FILES) {
    await readOptionalCodexFile(join(codexHome, file))
  }
  return {
    files,
    activeProvider: parsedConfig.model_provider,
    previousManifest,
    retainedSponsorProviderIds,
  }
}

async function verifyCodexInstall(
  codexHome: string,
  plan: CodexInstallPlan,
  expectedManifest: CodexModeManifest
): Promise<void> {
  for (const file of plan.files) {
    const installed = await readOptionalCodexFile(join(codexHome, file.relativePath))
    if (!installed || installed.content !== file.content) {
      throw new Error(`Codex mode verification failed for ${file.relativePath}`)
    }
  }

  const configFile = await readOptionalCodexFile(join(codexHome, 'config.toml'))
  const config = parseCodexConfig(configFile?.content ?? null)
  assertCodexModeFeatures(config)
  const providers = asRecord(config.model_providers)
  for (const sponsor of SPONSORS) {
    if (!providers || !Object.prototype.hasOwnProperty.call(providers, sponsor.id)) {
      throw new Error(`Codex mode verification failed for model_providers.${sponsor.id}`)
    }
  }
  if (JSON.stringify(config.model_provider) !== JSON.stringify(plan.activeProvider)) {
    throw new Error('Codex mode installation changed the active model provider')
  }

  const manifestFile = await readOptionalCodexFile(join(codexHome, CODEX_MODE_MANIFEST))
  if (!manifestFile) throw new Error('Codex mode ownership manifest is missing')
  const manifest = parseCodexModeManifest(manifestFile.content)
  if (JSON.stringify(manifest) !== JSON.stringify(expectedManifest)) {
    throw new Error('Codex mode ownership manifest verification failed')
  }
}

function isCcgHookCommand(command: unknown): boolean {
  return typeof command === 'string' && command.replace(/\\/g, '/').includes('/hooks/ccg/')
}

// ═══════════════════════════════════════════════════════
// Install sub-steps
// ═══════════════════════════════════════════════════════

/**
 * Install slash command .md files from templates/commands/
 */
async function installCommandFiles(
  ctx: InstallContext,
  workflowIds: string[],
  options: { backupExisting?: boolean } = {}
): Promise<void> {
  const commandsDir = join(ctx.installDir, 'commands', 'ccg')
  const legacyIds = new Set(getLegacyCommandIds())

  for (const workflowId of workflowIds) {
    const workflow = getWorkflowById(workflowId)
    if (!workflow) {
      ctx.result.errors.push(`Unknown workflow: ${workflowId}`)
      continue
    }

    for (const cmd of workflow.commands) {
      // Route to correct source directory: core → commands/, legacy → commands-legacy/
      const srcSubdir = legacyIds.has(workflowId) ? 'commands-legacy' : 'commands'
      const srcFile = join(ctx.templateDir, srcSubdir, `${cmd}.md`)
      const destFile = join(commandsDir, `${cmd}.md`)

      try {
        if (await fs.pathExists(srcFile)) {
          if (ctx.force || !(await fs.pathExists(destFile))) {
            let content = await fs.readFile(srcFile, 'utf-8')
            content = injectConfigVariables(content, ctx.config)
            content = replaceHomePathsInTemplate(content, ctx.installDir)

            if (options.backupExisting) {
              await backupRoutingTemplate(ctx, destFile, content)
            }

            await fs.writeFile(destFile, content, 'utf-8')
          }
          ctx.result.installedCommands.push(cmd)
        } else {
          const placeholder = `---
description: "${workflow.descriptionEn}"
---

# /ccg:${cmd}

${workflow.description}

> This command is part of CCG multi-model collaboration system.
`
          await fs.writeFile(destFile, placeholder, 'utf-8')
          ctx.result.installedCommands.push(cmd)
        }
      } catch (error) {
        ctx.result.errors.push(`Failed to install ${cmd}: ${error}`)
        ctx.result.success = false
      }
    }
  }
}

/**
 * Install agent .md files from templates/commands/agents/
 */
async function installAgentFiles(ctx: InstallContext): Promise<void> {
  try {
    await copyMdTemplates(ctx, join(ctx.templateDir, 'commands', 'agents'), join(ctx.installDir, 'agents', 'ccg'), {
      inject: true,
    })
  } catch (error) {
    ctx.result.errors.push(`Failed to install agents: ${error}`)
    ctx.result.success = false
  }
}

/**
 * Install expert prompt .md files for supported wrapper backends.
 */
async function installPromptFiles(ctx: InstallContext): Promise<void> {
  const promptsTemplateDir = join(ctx.templateDir, 'prompts')
  const configuredModels = new Set([
    ...ctx.config.routing.frontend.models,
    ...ctx.config.routing.backend.models,
    'claude',
  ])
  const promptsDir = join(ctx.installDir, '.ccg', 'prompts')
  if (!(await fs.pathExists(promptsTemplateDir))) {
    ctx.result.errors.push(`Prompts template directory not found: ${promptsTemplateDir}`)
    return
  }

  for (const model of ['codex', 'claude', 'antigravity', 'grok', 'kimi', 'opencode']) {
    if (!configuredModels.has(model) && model !== 'claude') {
      continue
    }
    try {
      const installed = await copyMdTemplates(ctx, join(promptsTemplateDir, model), join(promptsDir, model))
      for (const name of installed) {
        ctx.result.installedPrompts.push(`${model}/${name}`)
      }
    } catch (error) {
      ctx.result.errors.push(`Failed to install ${model} prompts: ${error}`)
      ctx.result.success = false
    }
  }
}

/**
 * Recursively collect skill names (directories containing SKILL.md, excludes root).
 * Used by both install (count) and uninstall (list names).
 */
async function collectSkillNames(dir: string, depth = 0): Promise<string[]> {
  const names: string[] = []
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory()) {
        names.push(...(await collectSkillNames(join(dir, entry.name), depth + 1)))
      } else if (entry.name === 'SKILL.md' && depth > 0) {
        names.push(basename(dir))
      }
    }
  } catch (error) {
    // Only suppress ENOENT (dir not found); log other errors that indicate real problems
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      console.error(`[CCG] Failed to read skills directory ${dir}: ${code || error}`)
    }
  }
  return names
}

/**
 * Remove a directory and collect .md file stems. Returns [] if dir doesn't exist.
 */
async function removeDirCollectMdNames(dir: string): Promise<string[]> {
  if (!(await fs.pathExists(dir))) return []
  const files = await fs.readdir(dir)
  const names = files.filter((f) => f.endsWith('.md')).map((f) => f.replace('.md', ''))
  await fs.remove(dir)
  return names
}

/**
 * Install skill files from templates/skills/ → ~/.claude/skills/ccg/
 * Includes v1.7.73 legacy layout migration.
 */
async function installSkillFiles(ctx: InstallContext): Promise<void> {
  const skillsTemplateDir = join(ctx.templateDir, 'skills')
  const skillsDestDir = join(ctx.installDir, 'skills', 'ccg')

  // Report error instead of silently returning when template dir is missing
  if (!(await fs.pathExists(skillsTemplateDir))) {
    ctx.result.errors.push(`Skills template directory not found: ${skillsTemplateDir}`)
    return
  }

  try {
    // Migration: move old v1.7.73 layout into skills/ccg/ namespace
    const oldSkillsRoot = join(ctx.installDir, 'skills')
    const ccgLegacyItems = ['tools', 'orchestration', 'SKILL.md', 'run_skill.js']
    const needsMigration = !(await fs.pathExists(skillsDestDir)) && (await fs.pathExists(join(oldSkillsRoot, 'tools')))
    if (needsMigration) {
      await fs.ensureDir(skillsDestDir)
      for (const item of ccgLegacyItems) {
        const oldPath = join(oldSkillsRoot, item)
        const newPath = join(skillsDestDir, item)
        if (await fs.pathExists(oldPath)) {
          try {
            await fs.move(oldPath, newPath, { overwrite: true })
          } catch (moveErr) {
            // Windows: file locking can cause move to fail — log but continue
            ctx.result.errors.push(`Skills migration: failed to move ${item}: ${moveErr}`)
          }
        }
      }
    }

    // Recursive copy: preserves full directory tree
    // Always overwrite to ensure fresh install gets all files
    await fs.copy(skillsTemplateDir, skillsDestDir, {
      overwrite: true,
      errorOnExist: false,
    })

    // Drop red-team / pentest notes even when installing from a git checkout.
    // They are also excluded from local tarballs because security scanners may
    // flag the reference content. Users who need them can copy from GitHub.
    const securityDir = join(skillsDestDir, 'domains', 'security')
    if (await fs.pathExists(securityDir)) {
      await fs.remove(securityDir)
    }

    // Post-copy: apply template variable replacement to .md files
    const replacePathsInDir = async (dir: string): Promise<void> => {
      const entries = await fs.readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        const fullPath = join(dir, entry.name)
        if (entry.isDirectory()) {
          await replacePathsInDir(fullPath)
        } else if (entry.name.endsWith('.md')) {
          const content = await fs.readFile(fullPath, 'utf-8')
          const processed = replaceHomePathsInTemplate(content, ctx.installDir)
          if (processed !== content) {
            await fs.writeFile(fullPath, processed, 'utf-8')
          }
        }
      }
    }
    await replacePathsInDir(skillsDestDir)

    // Post-copy validation: verify at least one SKILL.md was actually copied
    const installedSkills = await collectSkillNames(skillsDestDir)
    ctx.result.installedSkills = installedSkills.length

    if (installedSkills.length === 0) {
      ctx.result.errors.push(
        `Skills copy completed but no SKILL.md found in ${skillsDestDir}. ` +
          `Possible cause: file locking (antivirus), permission denied, or path too long. ` +
          `Try running as administrator or disabling antivirus real-time scanning temporarily.`
      )
    }
  } catch (error) {
    ctx.result.errors.push(`Failed to install skills: ${error}`)
    ctx.result.success = false
  }
}

async function removeRetiredImpeccableCommands(skillsTemplateDir: string, commandsDir: string): Promise<void> {
  const retired = collectSkills(skillsTemplateDir).filter(
    (skill) => skill.category === 'impeccable' && !skill.userInvocable
  )
  for (const skill of retired) {
    const commandPath = join(commandsDir, `${skill.name}.md`)
    if (!(await fs.pathExists(commandPath))) continue

    const content = (await fs.readFile(commandPath, 'utf-8')).replaceAll('\\', '/')
    const relPath = skill.relPath.replaceAll('\\', '/')
    if (content.includes(`/skills/ccg/${relPath}/SKILL.md`)) {
      await fs.remove(commandPath)
    }
  }
}

/**
 * Auto-generate slash commands for user-invocable skills via Skill Registry.
 *
 * Scans templates/skills/ for SKILL.md files with `user-invocable: true` frontmatter,
 * then generates ~/.claude/commands/ccg/{name}.md for each — SKIPPING any name that
 * already exists in installer-data.ts to avoid conflicts with complex multi-model commands.
 */
async function installSkillGeneratedCommands(ctx: InstallContext): Promise<void> {
  const skillsTemplateDir = join(ctx.templateDir, 'skills')
  const skillsInstallDir = join(ctx.installDir, 'skills', 'ccg')
  const commandsDir = join(ctx.installDir, 'commands', 'ccg')

  if (!(await fs.pathExists(skillsTemplateDir))) return

  try {
    await removeRetiredImpeccableCommands(skillsTemplateDir, commandsDir)
    const existingCommandNames = new Set(getAllCommandIds())

    const skipCategories: import('./skill-registry').SkillCategory[] = []
    if (ctx.config.skipImpeccable) {
      skipCategories.push('impeccable')
    }

    const generated = await installSkillCommands(
      skillsTemplateDir,
      skillsInstallDir,
      commandsDir,
      existingCommandNames,
      skipCategories
    )

    if (generated.length > 0) {
      ctx.result.installedCommands.push(...generated)
      ctx.result.installedSkillCommands = generated.length
    }
  } catch (error) {
    // Non-fatal: skill command generation failure shouldn't block installation
    ctx.result.errors.push(`Skill Registry command generation warning: ${error}`)
  }
}

/**
 * Install the optional Codex-led runtime without replacing user-owned Codex configuration.
 */
export async function installCodexMode(): Promise<{ success: boolean; message: string }> {
  const codexTemplateDir = join(PACKAGE_ROOT, 'templates', 'codex')
  if (!(await fs.pathExists(codexTemplateDir))) {
    return { success: false, message: 'Codex template directory not found' }
  }

  const codexHome = join(homedir(), '.codex')
  let backup: CodexBackup | undefined
  try {
    const config = await createCodexInstallConfig()
    const plan = await prepareCodexInstall(codexTemplateDir, codexHome, config)
    await ensureCodexPathLayout(codexHome)
    backup = await createCodexBackup(codexHome)

    for (const file of plan.files) {
      await writeCodexFileAtomic(join(codexHome, file.relativePath), file.content, file.mode)
    }

    const sponsorApis = await configureAllSponsorsForCodex()
    if (!sponsorApis.success) throw new Error(sponsorApis.message)
    const manifest = await buildCodexModeManifest(plan, backup, sponsorApis.results)
    await writeCodexFileAtomic(join(codexHome, CODEX_MODE_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, 0o600)
    await verifyCodexInstall(codexHome, plan, manifest)

    return {
      success: true,
      message: `Codex mode installed:\n  ~/.codex/AGENTS.md (CCG block merged)\n  ~/.codex/config.toml (user settings preserved; sponsor providers registered but not activated)\n  ~/.codex/hooks.json (CCG Hook merged)\n  ~/.codex/hooks/ccg-workflow.py\n  ~/.codex/hooks/ccg/task-state.js\n  ~/.codex/agents/ccg-implement.toml\n  ~/.codex/agents/ccg-review.toml\n  ~/.codex/agents/ccg-research.toml\n  Backup: ${backup.path.replace(homedir(), '~')}`,
    }
  } catch (error) {
    if (!backup) return { success: false, message: `Failed to install Codex mode: ${error}` }
    try {
      await restoreCodexBackup(codexHome, backup)
      return {
        success: false,
        message: `Failed to install Codex mode: ${error}. Original files restored from ${backup.path.replace(homedir(), '~')}`,
      }
    } catch (restoreError) {
      return {
        success: false,
        message: `Failed to install Codex mode: ${error}. Restore also failed: ${restoreError}. Backup: ${backup.path.replace(homedir(), '~')}`,
      }
    }
  }
}

/**
 * Remove only CCG-managed Codex content and preserve user-owned instructions and Hooks.
 */
export async function uninstallCodexMode(): Promise<{ success: boolean; removed: string[]; skipped: string[] }> {
  const codexHome = join(homedir(), '.codex')
  const removed: string[] = []
  const skipped: string[] = []
  let backup: CodexBackup | undefined

  try {
    if (!(await assertSafeCodexDirectory(codexHome))) {
      return { success: true, removed, skipped: ['~/.codex/ (not present)'] }
    }
    await assertCodexPathLayout(codexHome)

    const agentsPath = join(codexHome, 'AGENTS.md')
    const agentsFile = await readOptionalCodexFile(agentsPath)
    const agentsResult = agentsFile ? removeCodexManagedBlock(agentsFile.content) : null

    const hooksPath = join(codexHome, 'hooks.json')
    const hooksFile = await readOptionalCodexFile(hooksPath)
    const hooksResult = hooksFile ? removeCodexHookRegistration(hooksFile.content, codexHome) : null

    const configFile = await readOptionalCodexFile(join(codexHome, 'config.toml'))
    parseCodexConfig(configFile?.content ?? null)
    const manifestFile = await readOptionalCodexFile(join(codexHome, CODEX_MODE_MANIFEST))
    const manifest = manifestFile ? parseCodexModeManifest(manifestFile.content) : null
    const existingRuntimeFiles: string[] = []
    for (const relativePath of CODEX_MANAGED_FILES) {
      if (await readOptionalCodexFile(join(codexHome, relativePath))) existingRuntimeFiles.push(relativePath)
    }
    if (!manifest && (existingRuntimeFiles.length > 0 || agentsResult?.changed || hooksResult?.changed)) {
      throw new Error('Codex mode ownership manifest is missing; reinstall Codex mode before uninstalling')
    }
    if (manifest) {
      for (const managedFile of manifest.files) {
        if (managedFile.original) await readCodexOriginalFile(codexHome, managedFile)
      }
    }

    await ensureCodexPathLayout(codexHome)
    backup = await createCodexBackup(codexHome)

    if (agentsFile && agentsResult?.changed) {
      if (agentsResult.content) {
        await writeCodexFileAtomic(agentsPath, agentsResult.content, agentsFile.mode)
      } else {
        await removeRegularCodexFile(agentsPath)
      }
      removed.push('~/.codex/AGENTS.md [CCG block]')
    } else if (agentsFile) {
      skipped.push('~/.codex/AGENTS.md (no CCG block)')
    }

    if (hooksFile && hooksResult?.changed) {
      if (hooksResult.empty) {
        await removeRegularCodexFile(hooksPath)
      } else {
        await writeCodexFileAtomic(hooksPath, hooksResult.content, hooksFile.mode)
      }
      removed.push('~/.codex/hooks.json [CCG registration]')
    } else if (hooksFile) {
      skipped.push('~/.codex/hooks.json (no CCG registration)')
    }

    if (manifest) {
      for (const managedFile of manifest.files) {
        const action = await removeOrRestoreCodexManagedFile(codexHome, managedFile)
        if (action === 'removed') removed.push(`~/.codex/${managedFile.relativePath}`)
        else if (action === 'restored') removed.push(`~/.codex/${managedFile.relativePath} (original restored)`)
        else if (action === 'preserved') {
          skipped.push(`~/.codex/${managedFile.relativePath} (modified after installation; preserved)`)
        }
      }
    }

    const sponsorApis = await removeSponsorsFromCodex(manifest?.sponsorProviderIds || [])
    if (!sponsorApis.success) throw new Error(sponsorApis.message)
    for (const result of sponsorApis.results) {
      if (result.status === 'removed') {
        removed.push(`~/.codex/config.toml [model_providers.${result.id}]`)
      } else if (result.status === 'preserved') {
        skipped.push(`~/.codex/config.toml [model_providers.${result.id}] (modified after installation; preserved)`)
      }
    }
    if (manifestFile) {
      await removeRegularCodexFile(join(codexHome, CODEX_MODE_MANIFEST))
      removed.push('~/.codex/.ccg/codex-mode.json')
    }
    skipped.push('~/.codex/config.toml (user settings preserved)')
    skipped.push(`${backup.path.replace(homedir(), '~')} (pre-uninstall backup)`)

    const taskHooksDir = join(codexHome, 'hooks', 'ccg')
    if ((await assertSafeCodexDirectory(taskHooksDir)) && (await fs.readdir(taskHooksDir)).length === 0) {
      await fs.remove(taskHooksDir)
      removed.push('~/.codex/hooks/ccg/ (empty)')
    }
    for (const dir of ['agents', 'hooks']) {
      const dirPath = join(codexHome, dir)
      if ((await assertSafeCodexDirectory(dirPath)) && (await fs.readdir(dirPath)).length === 0) {
        await fs.remove(dirPath)
        removed.push(`~/.codex/${dir}/ (empty)`)
      }
    }

    return { success: true, removed, skipped }
  } catch (error) {
    if (!backup) return { success: false, removed, skipped: [...skipped, `Error: ${error}`] }
    try {
      await ensureCodexPathLayout(codexHome)
      await restoreCodexBackup(codexHome, backup)
      return {
        success: false,
        removed: [],
        skipped: [...skipped, `Error: ${error}`, `Original files restored from ${backup.path.replace(homedir(), '~')}`],
      }
    } catch (restoreError) {
      return {
        success: false,
        removed,
        skipped: [
          ...skipped,
          `Error: ${error}`,
          `Restore failed: ${restoreError}`,
          `Backup: ${backup.path.replace(homedir(), '~')}`,
        ],
      }
    }
  }
}

/**
 * Install rule .md files from templates/rules/ → ~/.claude/rules/
 */
async function installRuleFiles(ctx: InstallContext): Promise<void> {
  try {
    const installed = await copyMdTemplates(ctx, join(ctx.templateDir, 'rules'), join(ctx.installDir, 'rules'))
    if (installed.length > 0) ctx.result.installedRules = true
  } catch (error) {
    ctx.result.errors.push(`Failed to install rules: ${error}`)
  }
}

/** Resolve platform-specific binary name. Returns null for unsupported platforms. */
function getBinaryName(): string | null {
  const osMap: Record<string, string> = { darwin: 'darwin', linux: 'linux', win32: 'windows' }
  const os = osMap[process.platform]
  if (!os) return null
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64'
  const ext = process.platform === 'win32' ? '.exe' : ''
  return `codeagent-wrapper-${os}-${arch}${ext}`
}

/**
 * Check if codeagent-wrapper binary exists and is functional.
 * Returns true if the binary passes `--version` check.
 */
export async function verifyBinary(installDir: string): Promise<boolean> {
  const binDir = join(installDir, 'bin')
  const wrapperName = process.platform === 'win32' ? 'codeagent-wrapper.exe' : 'codeagent-wrapper'
  const wrapperPath = join(binDir, wrapperName)

  if (!(await fs.pathExists(wrapperPath))) return false

  try {
    const { execSync } = await import('node:child_process')
    execSync(`"${wrapperPath}" --version`, { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

async function verifyBinaryFileVersion(binaryPath: string): Promise<boolean> {
  try {
    const { execFileSync } = await import('node:child_process')
    const output = execFileSync(binaryPath, ['--version'], { stdio: 'pipe' }).toString().trim()
    const version = output.replace(/^.*version\s*/, '')
    return version === EXPECTED_BINARY_VERSION
  } catch {
    return false
  }
}

/**
 * Check if installed binary version matches expected version.
 * Returns true if version matches, false if outdated or unreadable.
 */
export async function verifyBinaryVersion(installDir: string): Promise<boolean> {
  const binDir = join(installDir, 'bin')
  const wrapperName = process.platform === 'win32' ? 'codeagent-wrapper.exe' : 'codeagent-wrapper'
  return verifyBinaryFileVersion(join(binDir, wrapperName))
}

/**
 * Show prominent red-box warning when codeagent-wrapper binary download failed.
 * Used by both init and update flows to provide manual fix instructions.
 */
export function showBinaryDownloadWarning(binDir: string): void {
  const binaryExt = process.platform === 'win32' ? '.exe' : ''
  const platformLabel =
    process.platform === 'darwin'
      ? process.arch === 'arm64'
        ? 'darwin-arm64'
        : 'darwin-amd64'
      : process.platform === 'linux'
        ? process.arch === 'arm64'
          ? 'linux-arm64'
          : 'linux-amd64'
        : process.arch === 'arm64'
          ? 'windows-arm64'
          : 'windows-amd64'
  const binaryFileName = `codeagent-wrapper-${platformLabel}${binaryExt}`
  const destFileName = `codeagent-wrapper${binaryExt}`
  const releaseUrl = `https://github.com/${GITHUB_REPO}/releases/tag/${RELEASE_TAG}`

  console.log()
  console.log(ansis.red.bold(`  ╔════════════════════════════════════════════════════════════╗`))
  console.log(ansis.red.bold(`  ║  ⚠  codeagent-wrapper 下载失败                            ║`))
  console.log(ansis.red.bold(`  ║     Binary download failed (network issue)                 ║`))
  console.log(ansis.red.bold(`  ╚════════════════════════════════════════════════════════════╝`))
  console.log()
  console.log(ansis.yellow(`  多模型协作命令 (/ccg:workflow, /ccg:plan 等) 需要此文件才能工作`))
  console.log(ansis.yellow(`  Multi-model commands require this binary to work.`))
  console.log()
  console.log(ansis.cyan(`  手动修复 / Manual fix:`))
  console.log()
  console.log(ansis.white(`    1. 下载 / Download:`))
  console.log(ansis.cyan(`       ${releaseUrl}`))
  console.log(ansis.gray(`       → 找到 ${ansis.white(binaryFileName)} 并下载`))
  console.log()
  console.log(ansis.white(`    2. 放到 / Place at:`))
  const displayPath =
    process.platform === 'win32' ? `${binDir.replace(/\//g, '\\')}\\${destFileName}` : `${binDir}/${destFileName}`
  console.log(ansis.cyan(`       ${displayPath}`))
  console.log()
  if (process.platform !== 'win32') {
    console.log(ansis.white(`    3. 加权限 / Make executable:`))
    console.log(ansis.cyan(`       chmod +x "${binDir}/${destFileName}"`))
    console.log()
  }
  console.log(ansis.white(`    或重新安装 / Or re-install:`))
  console.log(ansis.cyan(`       npx ccg-workflow@latest`))
  console.log()
}

/**
 * Download and install codeagent-wrapper binary for current platform.
 * Skips download if binary already exists and passes `--version` check.
 */
async function installBinaryFile(ctx: InstallContext): Promise<void> {
  const binDir = join(ctx.installDir, 'bin')
  const wrapperName = process.platform === 'win32' ? 'codeagent-wrapper.exe' : 'codeagent-wrapper'
  const destBinary = join(binDir, wrapperName)
  const tempBinary = join(binDir, `.${wrapperName}.${process.pid}.${Date.now()}.download`)

  try {
    await fs.ensureDir(binDir)

    const binaryName = getBinaryName()
    if (!binaryName) {
      ctx.result.errors.push(`Unsupported platform: ${process.platform}`)
      ctx.result.success = false
      return
    }

    if (await verifyBinaryFileVersion(destBinary)) {
      ctx.result.binPath = binDir
      ctx.result.binInstalled = true
      return
    }

    if (!(await downloadBinaryFromRelease(binaryName, tempBinary))) {
      ctx.result.errors.push(
        `Failed to download binary: ${binaryName} from GitHub Release (after 3 attempts). Check network or visit https://github.com/${GITHUB_REPO}/releases/tag/${RELEASE_TAG}`
      )
      return
    }

    if (!(await verifyBinaryFileVersion(tempBinary))) {
      ctx.result.errors.push(`Binary verification failed: expected codeagent-wrapper ${EXPECTED_BINARY_VERSION}`)
      return
    }

    await rename(tempBinary, destBinary)
    ctx.result.binPath = binDir
    ctx.result.binInstalled = true
  } catch (error) {
    ctx.result.errors.push(`Failed to install codeagent-wrapper (non-blocking): ${error}`)
  } finally {
    await fs.remove(tempBinary).catch(() => undefined)
  }
}

// ═══════════════════════════════════════════════════════
// CCG 3.0 Engine installation
// ═══════════════════════════════════════════════════════

/**
 * Install engine files from templates/engine/ → ~/.claude/.ccg/engine/
 * Includes model-router.md, phase-guide.md, and strategy files.
 * All .md files receive variable injection + path replacement.
 */
async function installEngineFiles(ctx: InstallContext, options: { backupExisting?: boolean } = {}): Promise<void> {
  const engineSrcDir = join(ctx.templateDir, 'engine')
  if (!(await fs.pathExists(engineSrcDir))) return

  const engineDestDir = join(ctx.installDir, '.ccg', 'engine')

  try {
    // Copy top-level engine .md files (model-router.md, phase-guide.md)
    await copyMdTemplates(ctx, engineSrcDir, engineDestDir, { inject: true, ...options })

    // Copy strategy files
    const strategiesSrc = join(engineSrcDir, 'strategies')
    const strategiesDest = join(engineDestDir, 'strategies')
    if (await fs.pathExists(strategiesSrc)) {
      await copyMdTemplates(ctx, strategiesSrc, strategiesDest, { inject: true, ...options })
    }
  } catch (error) {
    ctx.result.errors.push(`Failed to install engine files: ${error}`)
  }
}

// ═══════════════════════════════════════════════════════
// CCG 3.0 Hook installation
// ═══════════════════════════════════════════════════════

const HOOK_FILES = [
  'package.json',
  'task-utils.js',
  'task-state.js',
  'workflow-state.js',
  'session-start.js',
  'subagent-context.js',
  'skill-router.js',
]

/**
 * Install CCG hook scripts to ~/.claude/hooks/ccg/
 */
async function installHookScripts(ctx: InstallContext): Promise<boolean> {
  const hooksSrcDir = join(ctx.templateDir, 'hooks')
  if (!(await fs.pathExists(hooksSrcDir))) {
    ctx.result.errors.push(`Hook template directory not found: ${hooksSrcDir}`)
    ctx.result.success = false
    return false
  }

  const hooksDestDir = join(ctx.installDir, 'hooks', 'ccg')
  await fs.ensureDir(hooksDestDir)

  try {
    for (const file of HOOK_FILES) {
      const src = join(hooksSrcDir, file)
      if (!(await fs.pathExists(src))) {
        throw new Error(`Required hook runtime file not found: ${src}`)
      }
      await fs.copy(src, join(hooksDestDir, file), { overwrite: true })
    }
    return true
  } catch (error) {
    ctx.result.errors.push(`Failed to install hook scripts: ${error}`)
    ctx.result.success = false
    return false
  }
}

const CCG_HOOK_EVENTS = ['UserPromptSubmit', 'SessionStart', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure'] as const

async function readHookSettings(ctx: InstallContext): Promise<Record<string, unknown> | null> {
  const settingsPath = join(ctx.installDir, 'settings.json')
  let settings: Record<string, unknown> = {}
  if (await fs.pathExists(settingsPath)) {
    const rawSettings = await fs.readFile(settingsPath, 'utf-8')
    try {
      const parsed = JSON.parse(rawSettings)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        ctx.result.errors.push('Failed to register hooks in settings.json: root value must be an object')
        ctx.result.success = false
        return null
      }
      settings = parsed as Record<string, unknown>
    } catch (error) {
      ctx.result.errors.push(`Failed to register hooks in settings.json: invalid JSON (${error})`)
      ctx.result.success = false
      return null
    }
  }

  const configuredHooks = settings.hooks
  if (
    configuredHooks !== undefined &&
    (!configuredHooks || typeof configuredHooks !== 'object' || Array.isArray(configuredHooks))
  ) {
    ctx.result.errors.push('Failed to register hooks in settings.json: hooks must be an object')
    ctx.result.success = false
    return null
  }
  const hooks = (configuredHooks || {}) as Record<string, unknown>
  for (const event of CCG_HOOK_EVENTS) {
    if (hooks[event] !== undefined && !Array.isArray(hooks[event])) {
      ctx.result.errors.push(`Failed to register hooks in settings.json: hooks.${event} must be an array`)
      ctx.result.success = false
      return null
    }
  }
  return settings
}

/**
 * Register CCG hooks in ~/.claude/settings.json.
 * Merges with existing hooks — does not overwrite user's other hooks.
 */
async function registerHooksInSettings(ctx: InstallContext): Promise<void> {
  const settingsPath = join(ctx.installDir, 'settings.json')
  const hooksDir = join(ctx.installDir, 'hooks', 'ccg')
  const quoteCommandPath = (filePath: string): string => `"${filePath.replace(/"/g, '\\"')}"`

  try {
    const settings = await readHookSettings(ctx)
    if (!settings) return
    const hooks = { ...((settings.hooks || {}) as Record<string, unknown>) }

    const ccgHookDefs: Record<string, Record<string, unknown>> = {
      UserPromptSubmit: {
        hooks: [
          { type: 'command', command: `node ${quoteCommandPath(join(hooksDir, 'workflow-state.js'))}`, timeout: 10 },
          { type: 'command', command: `node ${quoteCommandPath(join(hooksDir, 'skill-router.js'))}`, timeout: 5 },
        ],
      },
      SessionStart: {
        matcher: 'startup|resume|clear|compact|fork',
        hooks: [
          { type: 'command', command: `node ${quoteCommandPath(join(hooksDir, 'session-start.js'))}`, timeout: 15 },
        ],
      },
      PreToolUse: {
        matcher: 'Bash|Agent',
        hooks: [
          { type: 'command', command: `node ${quoteCommandPath(join(hooksDir, 'subagent-context.js'))}`, timeout: 15 },
        ],
      },
      PostToolUse: {
        matcher: 'Bash|Agent|TaskOutput',
        hooks: [
          { type: 'command', command: `node ${quoteCommandPath(join(hooksDir, 'workflow-state.js'))}`, timeout: 10 },
        ],
      },
      PostToolUseFailure: {
        matcher: 'Bash|Agent',
        hooks: [
          { type: 'command', command: `node ${quoteCommandPath(join(hooksDir, 'workflow-state.js'))}`, timeout: 10 },
        ],
      },
    }

    for (const [event, definition] of Object.entries(ccgHookDefs)) {
      const existing = hooks[event]
      if (existing !== undefined && !Array.isArray(existing)) {
        ctx.result.errors.push(`Failed to register hooks in settings.json: hooks.${event} must be an array`)
        ctx.result.success = false
        return
      }

      const preservedEntries: Record<string, unknown>[] = []
      for (const entry of (existing || []) as Record<string, unknown>[]) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          preservedEntries.push(entry)
          continue
        }
        const commands = entry.hooks
        if (!Array.isArray(commands)) {
          preservedEntries.push(entry)
          continue
        }
        const preservedCommands = commands.filter((hook) => {
          if (!hook || typeof hook !== 'object' || Array.isArray(hook)) return true
          return !isCcgHookCommand((hook as Record<string, unknown>).command)
        })
        if (preservedCommands.length > 0) preservedEntries.push({ ...entry, hooks: preservedCommands })
      }
      hooks[event] = [...preservedEntries, definition]
    }

    settings.hooks = hooks
    const tempSettingsPath = `${settingsPath}.ccg-${process.pid}.tmp`
    try {
      await fs.writeFile(tempSettingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf-8')
      await rename(tempSettingsPath, settingsPath)
    } finally {
      await fs.remove(tempSettingsPath).catch(() => undefined)
    }
  } catch (error) {
    ctx.result.errors.push(`Failed to register hooks in settings.json: ${error}`)
    ctx.result.success = false
  }
}

// ═══════════════════════════════════════════════════════
// Public API: install / uninstall
// ═══════════════════════════════════════════════════════

export async function installWorkflows(
  workflowIds: string[],
  installDir: string,
  force = false,
  config?: {
    routing?: {
      mode?: string
      frontend?: { models?: string[]; primary?: string }
      backend?: { models?: string[]; primary?: string }
      review?: {
        profiles?: Array<{
          id: 'gpt' | 'grok'
          model?: string
          effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
        }>
        strategy?: string
      }
      proxy?: { models?: string[]; http?: string; https?: string }
      grokModel?: string
      kimiModel?: string
      opencodeModel?: string
    }
    liteMode?: boolean
    mcpProvider?: string
    skipImpeccable?: boolean
    skipBinary?: boolean
  }
): Promise<InstallResult> {
  const ctx: InstallContext = {
    installDir,
    force,
    config: {
      routing: (config?.routing as InstallConfig['routing']) || {
        mode: 'smart',
        frontend: { models: ['claude'], primary: 'claude' },
        backend: { models: ['claude'], primary: 'claude' },
        review: {
          profiles: [
            { id: 'gpt', model: 'gpt-5.6-sol', effort: 'xhigh' },
            { id: 'grok', model: 'grok-4.6', effort: 'high' },
          ],
          strategy: 'parallel',
        },
      },
      liteMode: config?.liteMode ?? true,
      mcpProvider: config?.mcpProvider || 'fast-context',
      skipImpeccable: config?.skipImpeccable || false,
      skipBinary: config?.skipBinary || false,
    },
    templateDir: join(PACKAGE_ROOT, 'templates'),
    result: {
      success: true,
      installedCommands: [],
      installedPrompts: [],
      errors: [],
      configPath: '',
    },
  }

  // ── Pre-flight: validate template directory exists ──
  // This is the #1 root cause of "silent install failure" on Windows:
  // if PACKAGE_ROOT resolved wrong, templateDir doesn't exist and every
  // sub-step silently returns empty results while reporting success.
  if (!(await fs.pathExists(ctx.templateDir))) {
    const errorMsg =
      `Template directory not found: ${ctx.templateDir} (PACKAGE_ROOT=${PACKAGE_ROOT}). ` +
      `This usually means the npm package is incomplete or the cache is corrupted. ` +
      `Try: npm cache clean --force && npx ccg-workflow@latest`
    ctx.result.errors.push(errorMsg)
    ctx.result.success = false
    return ctx.result
  }

  // Ensure base directories
  await fs.ensureDir(join(installDir, 'commands', 'ccg'))
  await fs.ensureDir(join(installDir, '.ccg'))
  await fs.ensureDir(join(installDir, '.ccg', 'prompts'))
  await fs.ensureDir(join(installDir, '.ccg', 'engine', 'strategies'))

  // Execute each install step
  await installCommandFiles(ctx, workflowIds)
  await installEngineFiles(ctx)
  const hooksInstalled = await installHookScripts(ctx)
  if (hooksInstalled) {
    await registerHooksInSettings(ctx)
  }
  await installAgentFiles(ctx)
  await installPromptFiles(ctx)
  await installSkillFiles(ctx)
  await installSkillGeneratedCommands(ctx)
  await installRuleFiles(ctx)
  if (!ctx.config.skipBinary) {
    await installBinaryFile(ctx)
  }

  // ── Post-flight: validate installation produced results ──
  // Catch the case where all sub-steps silently returned empty
  if (ctx.result.installedCommands.length === 0 && ctx.result.errors.length === 0) {
    ctx.result.errors.push(
      `No commands were installed (expected ${workflowIds.length}). ` +
        `Template dir: ${ctx.templateDir}. ` +
        `This may indicate a corrupted package or file permission issue.`
    )
    ctx.result.success = false
  }

  ctx.result.configPath = join(installDir, 'commands', 'ccg')
  return ctx.result
}

/**
 * Refresh routing-dependent CCG artifacts and the Hook runtime they depend on.
 * Skills, MCP servers, and the wrapper binary remain untouched.
 */
export async function syncRoutingTemplates(
  workflowIds: string[],
  installDir: string,
  config: {
    routing: InstallConfig['routing']
    liteMode?: boolean
    mcpProvider?: string
    skipImpeccable?: boolean
  }
): Promise<InstallResult> {
  const ctx: InstallContext = {
    installDir,
    force: true,
    config: {
      routing: config.routing,
      liteMode: config.liteMode ?? true,
      mcpProvider: config.mcpProvider || 'fast-context',
      skipImpeccable: config.skipImpeccable ?? false,
      skipBinary: true,
    },
    templateDir: join(PACKAGE_ROOT, 'templates'),
    result: {
      success: true,
      installedCommands: [],
      installedPrompts: [],
      errors: [],
      configPath: join(installDir, 'commands', 'ccg'),
    },
  }

  if (!(await fs.pathExists(ctx.templateDir))) {
    ctx.result.errors.push(`Template directory not found: ${ctx.templateDir}`)
    ctx.result.success = false
    return ctx.result
  }

  await fs.ensureDir(join(installDir, 'commands', 'ccg'))
  await fs.ensureDir(join(installDir, '.ccg', 'prompts'))
  await fs.ensureDir(join(installDir, '.ccg', 'engine', 'strategies'))

  if (!(await readHookSettings(ctx))) return ctx.result
  if (!(await installHookScripts(ctx))) return ctx.result
  await registerHooksInSettings(ctx)
  if (!ctx.result.success) return ctx.result

  await installCommandFiles(ctx, workflowIds, { backupExisting: true })
  await installEngineFiles(ctx, { backupExisting: true })
  await installPromptFiles(ctx)
  return ctx.result
}

// ═══════════════════════════════════════════════════════
// Uninstall
// ═══════════════════════════════════════════════════════

export interface UninstallResult {
  success: boolean
  removedCommands: string[]
  removedPrompts: string[]
  removedAgents: string[]
  removedSkills: string[]
  removedRules: boolean
  removedHooks: boolean
  removedBin: boolean
  errors: string[]
}

/**
 * Uninstall workflows by removing their command files.
 * @param options.preserveBinary — when true, skip binary removal (used during update)
 */
export async function uninstallWorkflows(
  installDir: string,
  options?: { preserveBinary?: boolean }
): Promise<UninstallResult> {
  const result: UninstallResult = {
    success: true,
    removedCommands: [],
    removedPrompts: [],
    removedAgents: [],
    removedSkills: [],
    removedRules: false,
    removedHooks: false,
    removedBin: false,
    errors: [],
  }

  const commandsDir = join(installDir, 'commands', 'ccg')
  const agentsDir = join(installDir, 'agents', 'ccg')
  const skillsDir = join(installDir, 'skills', 'ccg')
  const rulesDir = join(installDir, 'rules')
  const hooksDir = join(installDir, 'hooks', 'ccg')
  const settingsPath = join(installDir, 'settings.json')
  const binDir = join(installDir, 'bin')
  const ccgConfigDir = join(installDir, '.ccg')

  // Remove CCG commands directory
  try {
    result.removedCommands = await removeDirCollectMdNames(commandsDir)
  } catch (error) {
    result.errors.push(`Failed to remove commands directory: ${error}`)
    result.success = false
  }

  // Remove CCG agents directory
  try {
    result.removedAgents = await removeDirCollectMdNames(agentsDir)
  } catch (error) {
    result.errors.push(`Failed to remove agents directory: ${error}`)
    result.success = false
  }

  // Remove CCG skills directory only (skills/ccg/) — preserves user's own skills
  if (await fs.pathExists(skillsDir)) {
    try {
      result.removedSkills = await collectSkillNames(skillsDir)
      await fs.remove(skillsDir)
    } catch (error) {
      result.errors.push(`Failed to remove skills: ${error}`)
      result.success = false
    }
  }

  // Remove CCG rules files
  if (await fs.pathExists(rulesDir)) {
    try {
      for (const ruleFile of ['ccg-skills.md', 'ccg-grok-search.md', 'ccg-skill-routing.md']) {
        const rulePath = join(rulesDir, ruleFile)
        if (await fs.pathExists(rulePath)) {
          await fs.remove(rulePath)
          result.removedRules = true
        }
      }
    } catch (error) {
      result.errors.push(`Failed to remove rules: ${error}`)
    }
  }

  // Remove CCG hook scripts and deregister CCG hook entries
  if (await fs.pathExists(hooksDir)) {
    try {
      await fs.remove(hooksDir)
      result.removedHooks = true
    } catch (error) {
      result.errors.push(`Failed to remove hooks: ${error}`)
      result.success = false
    }
  }

  if (await fs.pathExists(settingsPath)) {
    try {
      const settings = await fs.readJson(settingsPath)
      const hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : null
      let changed = false
      if (hooks) {
        for (const event of Object.keys(hooks)) {
          const eventHooks = Array.isArray(hooks[event]) ? hooks[event] : []
          const kept = eventHooks
            .map((entry: Record<string, unknown>) => {
              const commands = Array.isArray(entry.hooks) ? entry.hooks : []
              const keptCommands = commands.filter((hook) => !isCcgHookCommand(hook?.command))
              if (keptCommands.length !== commands.length) changed = true
              return keptCommands.length > 0 ? { ...entry, hooks: keptCommands } : null
            })
            .filter(Boolean)
          if (kept.length > 0) {
            hooks[event] = kept
          } else {
            delete hooks[event]
            if (eventHooks.length > 0) changed = true
          }
        }
        if (Object.keys(hooks).length === 0) {
          delete settings.hooks
          changed = true
        }
        if (changed) {
          const tempSettingsPath = `${settingsPath}.ccg-uninstall-${process.pid}.tmp`
          try {
            await fs.writeFile(tempSettingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf-8')
            await rename(tempSettingsPath, settingsPath)
          } finally {
            await fs.remove(tempSettingsPath).catch(() => undefined)
          }
          result.removedHooks = true
        }
      }
    } catch (error) {
      result.errors.push(`Failed to deregister hooks from settings.json: ${error}`)
    }
  }

  // Remove codeagent-wrapper binary (skip during update to avoid unnecessary re-download)
  if (!options?.preserveBinary && (await fs.pathExists(binDir))) {
    try {
      const wrapperName = process.platform === 'win32' ? 'codeagent-wrapper.exe' : 'codeagent-wrapper'
      const wrapperPath = join(binDir, wrapperName)
      if (await fs.pathExists(wrapperPath)) {
        await fs.remove(wrapperPath)
        result.removedBin = true
      }
    } catch (error) {
      result.errors.push(`Failed to remove binary: ${error}`)
      result.success = false
    }
  }

  // Remove .ccg config directory
  if (await fs.pathExists(ccgConfigDir)) {
    try {
      await fs.remove(ccgConfigDir)
      result.removedPrompts.push('ALL_PROMPTS_AND_CONFIGS')
    } catch (error) {
      result.errors.push(`Failed to remove .ccg directory: ${error}`)
    }
  }

  return result
}
