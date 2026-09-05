/**
 * dsh-ccg — installing CCG's role matrix into a DeepSeek Harness profile.
 *
 * The plugin ships inside this package (`dsh-ccg/`) rather than as a package of
 * its own, so a DSH user gets it from the same `npx ccg-workflow` everyone else
 * runs and there is only one version number to reason about.
 *
 * That choice is what forces the copy below. A harness profile declares its
 * plugins as ordinary dependencies, and pointing one at PACKAGE_ROOT would work
 * exactly until the next `npx` run: npx unpacks into a cache directory it is
 * free to evict, and the profile would then fail to resolve a plugin that used
 * to be there. So the plugin is copied to a stable path this installer owns,
 * and the profile depends on that.
 *
 * A profile needs BOTH halves to load a plugin — the dependency and an entry in
 * `dsh.profile.bundles` — and `pnpm add` only writes the first. Both are
 * written here, then the profile's own package manager is asked to link it.
 */

import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { isAbsolute, relative } from 'node:path'
import { homedir } from 'node:os'
import fs from 'fs-extra'
import { basename, dirname, join } from 'pathe'
import { PACKAGE_ROOT } from './installer-template'

/** Package name the profile depends on and lists in its bundles. */
export const DSH_PLUGIN_NAME = 'dsh-ccg'

/**
 * The harness home to install into.
 *
 * `DSH_HOME` is how the harness itself is pointed at another home, and a user
 * who sets it has no second home at `~/.dsh` for this to fall back to: writing
 * there would report success while the profile that actually boots never gains
 * the plugin. Reading the same variable is the only way the two agree.
 */
export function defaultDshHome(): string {
  const configured = process.env.DSH_HOME?.trim()
  return configured !== undefined && configured !== '' ? configured : join(homedir(), '.dsh')
}

/** Where the plugin is copied to, so the profile has a path that outlives npx. */
export function dshPluginDir(dshHome = defaultDshHome()): string {
  return join(dshHome, 'ccg', DSH_PLUGIN_NAME)
}

/** Where the plugin ships inside this package. */
export function bundledPluginDir(): string {
  return join(PACKAGE_ROOT, DSH_PLUGIN_NAME)
}

export type DshProfile = {
  /** Profile directory name, e.g. `web`. */
  name: string
  /** Absolute path to the profile directory. */
  dir: string
  /** Whether this profile already lists the plugin in its bundles. */
  installed: boolean
}

/**
 * Runs the profile's package manager. Injectable so a test can exercise the
 * manifest rewriting — the part with the invariants — without spawning a real
 * installer into a temporary directory.
 */
export type ProfileLinker = (dir: string, name: string) => string | undefined

export type DshInstallResult = {
  success: boolean
  /** Profiles the plugin was wired into. */
  profiles: string[]
  /** What went wrong, when nothing could be done. */
  message?: string
  /** Non-fatal notes worth showing (a profile whose linker failed, say). */
  warnings: string[]
}

function errorMessage(error: unknown): string {
  if (error && typeof error === 'object') {
    const details = error as { stderr?: unknown; message?: unknown }
    if (details.stderr !== undefined) return String(details.stderr)
    if (details.message !== undefined) return String(details.message)
  }
  return String(error)
}

async function lstatIfExists(path: string) {
  try {
    return await fs.lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

async function requirePlainDirectory(path: string, label: string): Promise<void> {
  const stat = await fs.lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a non-symlink directory: ${path}`)
  }
}

async function requirePlainFile(path: string, label: string): Promise<void> {
  const stat = await fs.lstat(path)
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a non-symlink regular file: ${path}`)
  }
}

async function requireContainedPath(root: string, candidate: string, label: string): Promise<void> {
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

/**
 * Whether a DeepSeek Harness home exists at all.
 *
 * Used to decide whether to offer the option rather than to gate the install:
 * a user who has not run dsh yet has no profile to install into.
 */
export async function hasDshHome(dshHome = defaultDshHome()): Promise<boolean> {
  const profilesDir = join(dshHome, 'profiles')
  try {
    await requirePlainDirectory(dshHome, 'DSH_HOME')
    await requirePlainDirectory(profilesDir, 'DSH profiles directory')
    await requireContainedPath(dshHome, profilesDir, 'DSH profiles directory')
    return true
  } catch {
    return false
  }
}

/**
 * Find the profiles a plugin can be installed into.
 *
 * A profile is a directory under `~/.dsh/profiles` carrying a package.json with
 * a `dsh.profile.bundles` list — that list is what actually loads plugins, so a
 * directory without it is not a profile no matter what else it holds. The
 * shared `node_modules` directory sits alongside them and is skipped.
 *
 * @param dshHome - the harness home; defaults to `~/.dsh`.
 * @returns one entry per profile, in directory order.
 */
export async function findDshProfiles(dshHome = defaultDshHome()): Promise<DshProfile[]> {
  const profilesDir = join(dshHome, 'profiles')
  if (!(await lstatIfExists(profilesDir))) return []

  await requirePlainDirectory(dshHome, 'DSH_HOME')
  await requirePlainDirectory(profilesDir, 'DSH profiles directory')
  await requireContainedPath(dshHome, profilesDir, 'DSH profiles directory')

  const profiles: DshProfile[] = []
  for (const name of (await fs.readdir(profilesDir)).sort()) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const dir = join(profilesDir, name)
    const directoryStat = await lstatIfExists(dir)
    if (!directoryStat || !directoryStat.isDirectory() || directoryStat.isSymbolicLink()) continue
    await requireContainedPath(profilesDir, dir, 'DSH profile')

    const manifest = join(dir, 'package.json')
    const manifestStat = await lstatIfExists(manifest)
    if (!manifestStat || !manifestStat.isFile() || manifestStat.isSymbolicLink()) continue

    try {
      const pkg = await fs.readJson(manifest)
      const bundles = pkg?.dsh?.profile?.bundles
      if (!Array.isArray(bundles)) continue
      profiles.push({ name, dir, installed: bundles.includes(DSH_PLUGIN_NAME) })
    } catch {
      // A profile whose manifest does not parse is one this installer must not
      // rewrite — it would turn a hand-edit into a lost file.
    }
  }
  return profiles
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
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
async function stagePlugin(target: string, dshHome: string): Promise<string | undefined> {
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

  const source = bundledPluginDir()
  if (!(await fs.pathExists(join(source, 'package.json')))) {
    throw new Error(
      `dsh-ccg was not found inside this package (looked in ${source}). ` + 'Reinstall with `npx ccg-workflow@latest`.'
    )
  }

  const staged = join(parent, `.${basename(target)}.stage-${randomUUID()}`)
  const backup = join(parent, `.${basename(target)}.backup-${randomUUID()}`)

  let originalMoved = false
  try {
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
    if (originalMoved && !(await fs.pathExists(target)) && (await fs.pathExists(backup))) {
      try {
        await fs.rename(backup, target)
      } catch (restoreError) {
        throw new Error(
          `Failed to update ${target}: ${errorMessage(error)}; restoring the previous plugin also failed`,
          {
            cause: restoreError,
          }
        )
      }
    }
    throw error
  }
}

/**
 * Add the dependency and the bundle entry to one profile's manifest.
 *
 * @param dir - the profile directory.
 * @param pluginDir - where the plugin was staged.
 * @returns whether the manifest changed.
 */
async function wireProfile(dir: string, pluginDir: string): Promise<boolean> {
  await requirePlainDirectory(dir, 'DSH profile')
  const manifest = join(dir, 'package.json')
  await requirePlainFile(manifest, 'DSH profile manifest')
  const pkg = await fs.readJson(manifest)
  const spec = `file:${pluginDir}`
  let changed = false

  pkg.dependencies ??= {}
  if (pkg.dependencies[DSH_PLUGIN_NAME] !== spec) {
    pkg.dependencies[DSH_PLUGIN_NAME] = spec
    changed = true
  }

  pkg.dsh ??= {}
  pkg.dsh.profile ??= {}
  const bundles: string[] = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : []
  if (!bundles.includes(DSH_PLUGIN_NAME)) {
    // Appended, never inserted: bundle order is patch order, and moving an
    // existing entry would silently re-layer someone else's configuration.
    bundles.push(DSH_PLUGIN_NAME)
    pkg.dsh.profile.bundles = bundles
    changed = true
  }

  if (changed) await writeJsonAtomic(manifest, pkg)
  return changed
}

/**
 * Ask the profile's own package manager to link what was just declared.
 *
 * `dsh --profile <name> plugin <args>` forwards to pnpm inside the profile
 * directory, which is how the harness itself does this — so it is used first
 * and pnpm/npm are only fallbacks for a machine where the launcher is not on
 * PATH.
 *
 * @param dir - the profile directory.
 * @param name - the profile name.
 * @returns an error message, or undefined on success.
 */
function linkProfile(dir: string, name: string): string | undefined {
  const attempts: Array<[string, string[]]> = [
    ['dsh', ['plugin', '--profile', name, 'install']],
    ['pnpm', ['install']],
    ['npm', ['install']],
  ]
  let last = 'no package manager found'
  for (const [bin, args] of attempts) {
    try {
      execFileSync(bin, args, { cwd: dir, stdio: 'pipe', timeout: 180_000 })
      return undefined
    } catch (error: unknown) {
      last = errorMessage(error).trim().split('\n').slice(-3).join('\n')
    }
  }
  return last
}

/**
 * Install the plugin into the named profiles.
 *
 * @param options - `{ profiles, dshHome }`; omitted `profiles` means every one found.
 * @returns which profiles were wired, plus anything that only half worked.
 */
export async function installDshPlugin(
  options: {
    profiles?: string[]
    dshHome?: string
    link?: ProfileLinker
  } = {}
): Promise<DshInstallResult> {
  const dshHome = options.dshHome ?? defaultDshHome()
  const link = options.link ?? linkProfile
  const warnings: string[] = []

  try {
    const found = await findDshProfiles(dshHome)
    if (found.length === 0) {
      return {
        success: false,
        profiles: [],
        warnings,
        message:
          `No DeepSeek Harness profile found under ${join(dshHome, 'profiles')}. ` +
          'Run `dsh web` once to create one, then try again.',
      }
    }

    const wanted = options.profiles?.length
      ? found.filter((profile) => options.profiles!.includes(profile.name))
      : found
    if (wanted.length === 0) {
      return { success: false, profiles: [], warnings, message: `No profile matched: ${options.profiles?.join(', ')}` }
    }

    const pluginDir = dshPluginDir(dshHome)
    const stageWarning = await stagePlugin(pluginDir, dshHome)
    if (stageWarning) warnings.push(stageWarning)

    const wired: string[] = []
    for (const profile of wanted) {
      try {
        await wireProfile(profile.dir, pluginDir)
        const failure = link(profile.dir, profile.name)
        // The manifest is correct either way; only the link is missing, and the
        // user can finish it with one command. Reporting it as a total failure
        // would be worse than telling them exactly what is left.
        if (failure) {
          warnings.push(
            `${profile.name}: declared, but linking failed — run \`dsh plugin --profile ${profile.name} install\`\n${failure}`
          )
        }
        wired.push(profile.name)
      } catch (error: unknown) {
        warnings.push(`${profile.name}: ${errorMessage(error)}`)
      }
    }

    return { success: wired.length > 0, profiles: wired, warnings }
  } catch (error: unknown) {
    return { success: false, profiles: [], warnings, message: errorMessage(error) }
  }
}

/**
 * Remove the plugin from every profile that carries it, and delete the copy.
 *
 * @param options - `{ dshHome }`.
 * @returns which profiles were changed.
 */
export async function uninstallDshPlugin(
  options: {
    dshHome?: string
    link?: ProfileLinker
  } = {}
): Promise<DshInstallResult> {
  const dshHome = options.dshHome ?? defaultDshHome()
  const link = options.link ?? linkProfile
  const warnings: string[] = []

  try {
    const changedProfiles: string[] = []
    for (const profile of await findDshProfiles(dshHome)) {
      const manifest = join(profile.dir, 'package.json')
      const pkg = await fs.readJson(manifest)
      let changed = false

      if (pkg?.dependencies?.[DSH_PLUGIN_NAME] !== undefined) {
        delete pkg.dependencies[DSH_PLUGIN_NAME]
        changed = true
      }
      const bundles: unknown = pkg?.dsh?.profile?.bundles
      if (Array.isArray(bundles) && bundles.includes(DSH_PLUGIN_NAME)) {
        pkg.dsh.profile.bundles = bundles.filter((entry) => entry !== DSH_PLUGIN_NAME)
        changed = true
      }
      if (!changed) continue

      await writeJsonAtomic(manifest, pkg)
      const failure = link(profile.dir, profile.name)
      if (failure)
        warnings.push(`${profile.name}: removed from the manifest, but \`install\` failed — run it yourself to prune`)
      changedProfiles.push(profile.name)
    }

    const pluginDir = dshPluginDir(dshHome)
    const pluginStat = await lstatIfExists(pluginDir)
    if (pluginStat) {
      if (!pluginStat.isDirectory() || pluginStat.isSymbolicLink()) {
        throw new Error(`DSH plugin target must be a non-symlink directory: ${pluginDir}`)
      }
      await requirePlainDirectory(dshHome, 'DSH_HOME')
      await requireContainedPath(dshHome, pluginDir, 'DSH plugin target')
      await fs.remove(pluginDir)
    }
    return { success: true, profiles: changedProfiles, warnings }
  } catch (error: unknown) {
    return { success: false, profiles: [], warnings, message: errorMessage(error) }
  }
}
