import { randomUUID } from 'node:crypto'
import { isAbsolute, relative } from 'node:path'
import fs from 'fs-extra'
import { basename, dirname, join } from 'pathe'

/** Package name the profile depends on and lists in its bundles. */
export const DSH_PLUGIN_NAME = 'dsh-ccg'

export function errorMessage(error: unknown): string {
  if (error && typeof error === 'object') {
    const details = error as { stderr?: unknown; message?: unknown }
    const stderr = details.stderr === undefined ? '' : String(details.stderr).trim()
    if (stderr) return stderr
    if (details.message !== undefined) return String(details.message)
  }
  return String(error)
}

export async function lstatIfExists(path: string) {
  try {
    return await fs.lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

export async function requirePlainDirectory(path: string, label: string): Promise<void> {
  const stat = await fs.lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a non-symlink directory: ${path}`)
  }
}

export async function requirePlainFile(path: string, label: string): Promise<void> {
  const stat = await fs.lstat(path)
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a non-symlink regular file: ${path}`)
  }
}

export async function requireContainedPath(root: string, candidate: string, label: string): Promise<void> {
  const [realRoot, realCandidate] = await Promise.all([fs.realpath(root), fs.realpath(candidate)])
  const relativePath = relative(realRoot, realCandidate)
  if (
    relativePath === '..' ||
    relativePath.startsWith('../') ||
    relativePath.startsWith('..\\') ||
    isAbsolute(relativePath)
  ) {
    throw new Error(`${label} resolves outside DSH_HOME: ${candidate}`)
  }
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await requirePlainFile(path, 'DSH profile manifest')
  const current = await fs.lstat(path)
  const tempPath = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`)
  try {
    await fs.writeJson(tempPath, value, { spaces: 2 })
    await fs.chmod(tempPath, current.mode & 0o777)
    await fs.rename(tempPath, path)
  } catch (error) {
    try {
      await fs.remove(tempPath)
    } catch (cleanupError) {
      throw new Error(`Failed to write ${path}: ${errorMessage(error)}; temporary file cleanup also failed`, {
        cause: cleanupError,
      })
    }
    throw error
  }
}

async function preparePluginTarget(target: string, dshHome: string): Promise<string> {
  await requirePlainDirectory(dshHome, 'DSH_HOME')
  const parent = dirname(target)
  const parentStat = await lstatIfExists(parent)
  if (!parentStat) {
    await fs.mkdir(parent)
  } else if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error(`DSH plugin parent must be a non-symlink directory: ${parent}`)
  }
  await requirePlainDirectory(parent, 'DSH plugin parent')
  await requireContainedPath(dshHome, parent, 'DSH plugin parent')

  const targetStat = await lstatIfExists(target)
  if (targetStat && (!targetStat.isDirectory() || targetStat.isSymbolicLink())) {
    throw new Error(`DSH plugin target must be a non-symlink directory: ${target}`)
  }
  if (targetStat) await requireContainedPath(dshHome, target, 'DSH plugin target')
  return parent
}

async function copyBundledPlugin(source: string, staged: string): Promise<void> {
  await fs.ensureDir(staged)
  // Only what the harness loads. `test/` and a local node_modules symlink exist
  // in the repo checkout and have no business in a user's dsh home.
  for (const entry of [
    'src',
    'skills',
    'package.json',
    'cordis.patch.yml',
    'README.md',
    'README.zh-CN.md',
    'LICENSE',
  ]) {
    const from = join(source, entry)
    if (await fs.pathExists(from)) await fs.copy(from, join(staged, entry))
  }
}

async function restorePluginBackup(
  target: string,
  backup: string,
  originalMoved: boolean,
  error: unknown
): Promise<void> {
  if (originalMoved && !(await fs.pathExists(target)) && (await fs.pathExists(backup))) {
    try {
      await fs.rename(backup, target)
    } catch (restoreError) {
      throw new Error(`Failed to update ${target}: ${errorMessage(error)}; restoring the previous plugin also failed`, {
        cause: restoreError,
      })
    }
  }
}

/**
 * Copy the plugin to its stable home, replacing any earlier copy.
 *
 * Replaced rather than merged: a file dropped from a later version would
 * otherwise linger and keep being loaded.
 *
 * @param target - destination directory.
 * @returns a cleanup warning, or undefined on success.
 * @throws if this package does not carry the plugin.
 */
export async function stagePlugin(target: string, dshHome: string, source: string): Promise<string | undefined> {
  const parent = await preparePluginTarget(target, dshHome)
  if (!(await fs.pathExists(join(source, 'package.json')))) {
    throw new Error(
      `dsh-ccg was not found inside this package (looked in ${source}). ` +
        'Restore the bundled dsh-ccg directory and rebuild CCG from this checkout.'
    )
  }

  const staged = join(parent, `.${basename(target)}.stage-${randomUUID()}`)
  const backup = join(parent, `.${basename(target)}.backup-${randomUUID()}`)

  let originalMoved = false
  try {
    await copyBundledPlugin(source, staged)

    const currentTarget = await lstatIfExists(target)
    if (currentTarget) {
      if (!currentTarget.isDirectory() || currentTarget.isSymbolicLink()) {
        throw new Error(`DSH plugin target must be a non-symlink directory: ${target}`)
      }
      await requireContainedPath(dshHome, target, 'DSH plugin target')
      await fs.rename(target, backup)
      originalMoved = true
    }

    try {
      await fs.rename(staged, target)
    } catch (error) {
      if (originalMoved) await fs.rename(backup, target)
      throw error
    }

    if (originalMoved) {
      try {
        await fs.remove(backup)
      } catch (error) {
        return `Updated ${DSH_PLUGIN_NAME}, but could not remove backup ${backup}: ${error}`
      }
    }
    return undefined
  } catch (error) {
    await fs.remove(staged).catch(() => undefined)
    await restorePluginBackup(target, backup, originalMoved, error)
    throw error
  }
}
