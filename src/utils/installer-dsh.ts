/**
 * 将根项目附带的 dsh-ccg 安装到 DeepSeek Harness profile
 *
 * 插件复制到固定目录，避免源码目录移动或临时包缓存清理导致 profile 引用失效
 * profile 同时需要依赖和 dsh.profile.bundles 条目，再由自己的包管理器安装依赖
 */

import { execFileSync, type SpawnSyncOptions } from 'node:child_process'
import { homedir } from 'node:os'
import fs from 'fs-extra'
import { join } from 'pathe'
import { PACKAGE_ROOT } from './installer-template'
import {
  DSH_PLUGIN_NAME,
  errorMessage,
  lstatIfExists,
  requirePlainDirectory,
  requirePlainFile,
  requireContainedPath,
  writeJsonAtomic,
  stagePlugin,
} from './installer-dsh-files'

export { DSH_PLUGIN_NAME } from './installer-dsh-files'

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
  /** Profiles whose plugin dependency was declared and linked. */
  profiles: string[]
  /** What went wrong, when nothing could be done. */
  message?: string
  /** Non-fatal notes worth showing (a profile whose linker failed, say). */
  warnings: string[]
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
    const profile = await readDshProfile(profilesDir, name)
    if (profile) profiles.push(profile)
  }
  return profiles
}

async function readDshProfile(profilesDir: string, name: string): Promise<DshProfile | null> {
  if (name === 'node_modules' || name.startsWith('.')) return null
  const dir = join(profilesDir, name)
  const directoryStat = await lstatIfExists(dir)
  if (!directoryStat || !directoryStat.isDirectory() || directoryStat.isSymbolicLink()) return null
  await requireContainedPath(profilesDir, dir, 'DSH profile')

  return readProfileManifest(name, dir)
}

async function readProfileManifest(name: string, dir: string): Promise<DshProfile | null> {
  const manifest = join(dir, 'package.json')
  const manifestStat = await lstatIfExists(manifest)
  if (!manifestStat || !manifestStat.isFile() || manifestStat.isSymbolicLink()) return null

  try {
    const pkg = await fs.readJson(manifest)
    const bundles = pkg?.dsh?.profile?.bundles
    if (!Array.isArray(bundles)) return null
    return { name, dir, installed: bundles.includes(DSH_PLUGIN_NAME) }
  } catch {
    // A profile whose manifest does not parse is one this installer must not
    // rewrite — it would turn a hand-edit into a lost file.
  }
  return null
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
  // A live link uses the managed copy without retaining an old package snapshot.
  const spec = `link:${pluginDir}`
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
 * Build a launcher invocation without letting cmd.exe expand profile names.
 * A Windows shim's name stays bare so `%~dp0` resolves to its own directory.
 */
export function profileLinkCommand(bin: string, args: string[], platform = process.platform) {
  if (platform !== 'win32') return { file: bin, args, windowsVerbatimArguments: false }
  if (!/^[\w.-]+$/.test(bin)) throw new Error(`Unsupported launcher name: ${bin}`)
  if (!args.every((value) => /^[\p{L}\p{N}_. -]+$/u.test(value))) {
    throw new Error('Unsupported Windows profile name: shell metacharacters are not allowed')
  }
  const command = [bin, ...args.map((value) => `"${value}"`)].join(' ')
  return {
    file: process.env.ComSpec || 'cmd.exe',
    args: ['/d', '/s', '/c', `"${command}"`],
    windowsVerbatimArguments: true,
  }
}

/**
 * Ask the profile's launcher to link its declared dependencies.
 * pnpm is used only when the launcher is absent, preserving compatibility refusals.
 *
 * @param dir - the profile directory.
 * @param name - the profile name.
 * @returns an error message, or undefined on success.
 */
function linkProfile(dir: string, name: string): string | undefined {
  const attempts: Array<[string, string[]]> = [
    ['dsh', ['plugin', '--profile', name, 'install']],
    ['pnpm', ['install']],
  ]
  let last = 'no package manager found'
  for (const [bin, args] of attempts) {
    try {
      const command = profileLinkCommand(bin, args)
      const options = {
        cwd: dir,
        env: { ...process.env, DSH_HOME: join(dir, '..', '..') },
        stdio: 'pipe',
        timeout: 180_000,
        windowsVerbatimArguments: command.windowsVerbatimArguments,
      } satisfies SpawnSyncOptions
      execFileSync(command.file, command.args, options)
      return undefined
    } catch (error: unknown) {
      last = errorMessage(error).trim().split('\n').slice(-3).join('\n')
      const failure = error as { code?: string; status?: number } | null
      const missing = failure?.code === 'ENOENT' || failure?.status === 9009
      if (bin === 'dsh') {
        if (!missing) return last
        console.warn('未找到 dsh，改用 pnpm 安装 profile 依赖')
      }
    }
  }
  return last
}

async function installProfiles(
  profiles: DshProfile[],
  pluginDir: string,
  link: ProfileLinker,
  warnings: string[]
): Promise<string[]> {
  const wired: string[] = []
  for (const profile of profiles) {
    try {
      await wireProfile(profile.dir, pluginDir)
      const failure = link(profile.dir, profile.name)
      if (failure !== undefined) {
        warnings.push(
          `${profile.name}: declared, but linking failed — ` +
            `run \`dsh plugin --profile ${profile.name} install\`\n${failure}`
        )
        continue
      }
      wired.push(profile.name)
    } catch (error: unknown) {
      warnings.push(`${profile.name}: ${errorMessage(error)}`)
    }
  }
  return wired
}

function selectDshProfiles(found: DshProfile[], requested?: string[]): DshProfile[] {
  return requested?.length ? found.filter((profile) => requested.includes(profile.name)) : found
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

    const wanted = selectDshProfiles(found, options.profiles)
    if (wanted.length === 0) {
      return { success: false, profiles: [], warnings, message: `No profile matched: ${options.profiles!.join(', ')}` }
    }

    const pluginDir = dshPluginDir(dshHome)
    const stageWarning = await stagePlugin(pluginDir, dshHome, bundledPluginDir())
    if (stageWarning) warnings.push(stageWarning)

    const wired = await installProfiles(wanted, pluginDir, link, warnings)

    return { success: wired.length > 0, profiles: wired, warnings }
  } catch (error: unknown) {
    return { success: false, profiles: [], warnings, message: errorMessage(error) }
  }
}

async function unwireProfile(dir: string): Promise<boolean> {
  const manifest = join(dir, 'package.json')
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
  if (!changed) return false

  await writeJsonAtomic(manifest, pkg)
  return true
}

async function removePluginDirectory(dshHome: string): Promise<void> {
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
      if (!(await unwireProfile(profile.dir))) continue
      const failure = link(profile.dir, profile.name)
      if (failure !== undefined)
        warnings.push(`${profile.name}: removed from the manifest, but \`install\` failed — run it yourself to prune`)
      changedProfiles.push(profile.name)
    }

    await removePluginDirectory(dshHome)
    return { success: true, profiles: changedProfiles, warnings }
  } catch (error: unknown) {
    return { success: false, profiles: [], warnings, message: errorMessage(error) }
  }
}
