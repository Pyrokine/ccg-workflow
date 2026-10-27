import { rename } from 'node:fs/promises'
import ansis from 'ansis'
import fs from 'fs-extra'
import { join } from 'pathe'
import type { InstallContext } from './installer-context'

/**
 * Expected codeagent-wrapper binary version.
 * Must match the `version` constant in codeagent-wrapper/main.go.
 * When this differs from the installed binary, update triggers re-download.
 */
const EXPECTED_BINARY_VERSION = '5.15.0-aug.1'

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
export async function installBinaryFile(ctx: InstallContext): Promise<void> {
  const binDir = join(ctx.installDir, 'bin')
  const wrapperName = process.platform === 'win32' ? 'codeagent-wrapper.exe' : 'codeagent-wrapper'
  const destBinary = join(binDir, wrapperName)
  const tempBinary = join(binDir, `.${wrapperName}.${process.pid}.${Date.now()}.download`)

  try {
    await fs.ensureDir(binDir)

    const binaryName = getBinaryName()
    if (!binaryName) {
      ctx.result.errors.push(`Unsupported platform: ${process.platform}`)
      return
    }

    if (await verifyBinaryFileVersion(destBinary)) {
      ctx.result.binPath = binDir
      ctx.result.binInstalled = true
      return
    }

    if (!(await downloadBinaryFromRelease(binaryName, tempBinary))) {
      ctx.result.errors.push(
        `Failed to download binary: ${binaryName} from GitHub Release (after 3 attempts). ` +
          `Check network or visit https://github.com/${GITHUB_REPO}/releases/tag/${RELEASE_TAG}`
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
