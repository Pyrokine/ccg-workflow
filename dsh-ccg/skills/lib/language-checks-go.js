'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { AnalysisError, canonical, checked, runNative } = require('./language-checks-runtime.js');

function copyCacheEntry(entry, directory, destination, download, checkDeadline) {
  const from = path.join(directory, entry.name);
  const to = path.join(destination, entry.name);
  if (entry.isDirectory() && !download && entry.name.includes('@')) {
    fs.symlinkSync(from, to, 'junction');
  } else if (entry.isDirectory()) {
    copyCacheDirectory(from, to, download, checkDeadline);
  } else if (download && entry.isFile()) {
    if (entry.name === 'list') {
      fs.copyFileSync(from, to);
    } else {
      fs.symlinkSync(from, to);
    }
  }
}

function copyCacheDirectory(directory, destination, download, checkDeadline) {
  checkDeadline();
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    checkDeadline();
    if (/\.(?:lock|tmp)$/u.test(entry.name)) {
      continue;
    }
    if (entry.name === 'cache' && !download) {
      const cache = path.join(directory, 'cache', 'download');
      if (fs.existsSync(cache)) {
        copyCacheDirectory(cache, path.join(destination, 'cache', 'download'), true, checkDeadline);
      }
    } else {
      copyCacheEntry(entry, directory, destination, download, checkDeadline);
    }
  }
  checkDeadline();
}

function workspaceFlags(parsed, workspace) {
  const flags = [];
  for (const entry of parsed.Use) {
    if (typeof entry.DiskPath !== 'string') {
      throw new AnalysisError('Go workspace module paths are invalid');
    }
    flags.push('-dropuse=' + entry.DiskPath, '-use=' + path.resolve(path.dirname(workspace), entry.DiskPath));
  }
  for (const entry of parsed.Replace || []) {
    if (entry.New.Version) {
      continue;
    }
    const old = entry.Old.Path + (entry.Old.Version ? '@' + entry.Old.Version : '');
    flags.push('-replace=' + old + '=' + path.resolve(path.dirname(workspace), entry.New.Path));
  }
  return flags;
}

function recordGoFiles(directory, names, overlay, sources) {
  if (names !== undefined && !Array.isArray(names)) {
    throw new Error();
  }
  for (const name of names || []) {
    if (typeof name !== 'string') {
      throw new Error();
    }
    const original = path.resolve(directory, name);
    if (overlay.get(original) === '') {
      continue;
    }
    if (fs.existsSync(original)) {
      sources.add(canonical(original));
    }
    if (overlay.has(original)) {
      sources.add(overlay.get(original));
    }
  }
}

function packageSources(entry, overlay, sources) {
  if (typeof entry.Dir !== 'string' || entry.Error || entry.DepsErrors?.length) {
    throw new AnalysisError('Go package or dependency configuration is incomplete');
  }
  for (const key of ['GoFiles', 'CgoFiles', 'TestGoFiles', 'XTestGoFiles']) {
    recordGoFiles(entry.Dir, entry[key], overlay, sources);
  }
}

/**
 * @param {unknown} record
 * @returns {asserts record is Record<string, unknown>}
 */
function assertGoRecord(record) {
  if (!record || Array.isArray(record) || typeof record !== 'object') {
    throw new Error();
  }
}

function vetAnalyzerIssues(rule, diagnostics, job, sources) {
  const { issue } = require('./language-checks-runtime.js');
  if (!Array.isArray(diagnostics)) {
    throw new Error();
  }
  return diagnostics.map((diagnostic) => {
    if (typeof diagnostic?.posn !== 'string') {
      throw new Error();
    }
    const { file, line } = goPosition(diagnostic.posn, job.root, sources);
    return issue(job.tool, 'error', file, line, rule);
  });
}

function jsonObjects(text) {
  const content = text.replace(/^# [^\r\n]*(?:\r?\n|$)/gmu, '').trim();
  return content ? content.split(/\r?\n(?=\{)/u).map((entry) => JSON.parse(entry)) : [];
}

function seedModuleCache(source, target, checkDeadline) {
  if (!source || !fs.existsSync(source)) {
    return;
  }
  copyCacheDirectory(source, target, false, checkDeadline);
}

function validateCacheParent(stat, creatingChild) {
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new AnalysisError('Go cache path contains a symlink or non-directory');
  }
  if ((stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0) {
    throw new AnalysisError('Go cache parent directory is writable by other users');
  }
  if (creatingChild && stat.uid === process.geteuid() && (stat.mode & 0o300) !== 0o300) {
    throw new AnalysisError('Go cache parent directory is not writable and searchable by its owner');
  }
}

function checkCacheParents(directory) {
  let missing = false;
  for (let current = directory; ; current = path.dirname(current)) {
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
      missing = true;
    }
    if (stat) {
      validateCacheParent(stat, missing);
      missing = false;
    }
    if (path.dirname(current) === current) {
      return;
    }
  }
}

function prepareCacheDirectory(directory, privateDirectory) {
  try {
    fs.mkdirSync(directory, { recursive: !privateDirectory, mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') {
      throw error;
    }
  }
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new AnalysisError('Go cache directory is a symlink or non-directory');
  }
  if (stat.uid !== process.geteuid()) {
    throw new AnalysisError('Go cache directory belongs to another user');
  }
  if ((stat.mode & (privateDirectory ? 0o077 : 0o022)) !== 0) {
    throw new AnalysisError('Go cache directory permissions are not private');
  }
  if ((stat.mode & 0o700) !== 0o700) {
    throw new AnalysisError('Go cache directory is not readable, writable and searchable by its owner');
  }
  fs.accessSync(directory, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
}

function buildCacheLocation(env) {
  if (process.platform === 'win32' || typeof process.geteuid !== 'function') {
    throw new AnalysisError('Private Go cache ownership checks are unavailable on this platform');
  }
  const root =
    process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Caches')
      : env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  if (!path.isAbsolute(root)) {
    throw new AnalysisError('Go user cache location must be absolute');
  }
  return { root, directory: path.join(root, 'ccg', 'go-build') };
}

function checkBuildCacheOverlap(directory, original) {
  if (!original || original === 'off') {
    return;
  }
  const inherited = fs.existsSync(original) ? canonical(original) : path.resolve(original);
  const relativePaths = [path.relative(inherited, directory), path.relative(directory, inherited)];
  if (
    relativePaths.some(
      (relative) =>
        !relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
    )
  ) {
    throw new AnalysisError('CCG Go cache would overlap the original GOCACHE');
  }
}

function configureBuildCache(context) {
  const { env, temporary } = context;
  context.phase('build-cache');
  context.goCache = { mode: 'temporary', path: path.join(temporary, 'cache'), reason: '' };
  try {
    const { root, directory } = buildCacheLocation(env);
    checkBuildCacheOverlap(directory, env.GOCACHE);
    checkCacheParents(directory);
    prepareCacheDirectory(root, false);
    prepareCacheDirectory(path.dirname(directory), true);
    prepareCacheDirectory(directory, true);
    context.goCache = { mode: 'persistent', path: directory, reason: 'CCG-private build artifacts managed by Go' };
  } catch (error) {
    context.goCache.reason =
      error instanceof AnalysisError
        ? error.message
        : 'Private Go cache preparation failed: ' + (error.code || 'I/O error');
    fs.mkdirSync(context.goCache.path, { mode: 0o700 });
  }
  env.GOCACHE = context.goCache.path;
  context.checkDeadline();
}

function configureGo(context) {
  const { env, temporary } = context;
  configureBuildCache(context);
  Object.assign(env, {
    GOPROXY: 'off',
    GONOPROXY: 'none',
    GOSUMDB: 'off',
    GOVCS: '*:off',
    GOTOOLCHAIN: 'local',
    GOTELEMETRY: 'off',
    GOCACHEPROG: '',
    GOTMPDIR: path.join(temporary, 'tmp'),
  });
  fs.mkdirSync(env.GOTMPDIR);
  const result = context.run(['env', '-json', 'GOMOD', 'GOWORK', 'GOFLAGS', 'GOMODCACHE']);
  if (result.status !== 0) {
    throw new AnalysisError('Go project environment could not be read');
  }
  const settings = JSON.parse(result.stdout);
  for (const key of ['GOMOD', 'GOWORK', 'GOFLAGS', 'GOMODCACHE']) {
    if (typeof settings[key] !== 'string') {
      throw new AnalysisError('Go returned an invalid project environment');
    }
  }
  if ((!settings.GOMOD || settings.GOMOD === '/dev/null') && !settings.GOWORK) {
    throw new AnalysisError('No Go module or workspace was found');
  }
  env.GOMODCACHE = path.join(temporary, 'modules');
  context.phase('cache-seed');
  seedModuleCache(settings.GOMODCACHE, env.GOMODCACHE, context.checkDeadline);
  context.phase('workspace');
  if (settings.GOWORK && settings.GOWORK !== 'off') {
    isolateWorkspace(context, settings.GOWORK);
  }
  return settings;
}

function isolateWorkspace(context, workspace) {
  const inspected = context.run(['work', 'edit', '-json', workspace]);
  if (inspected.status !== 0) {
    throw new AnalysisError('Go workspace could not be read');
  }
  const parsed = JSON.parse(inspected.stdout);
  if (!Array.isArray(parsed.Use)) {
    throw new AnalysisError('Go workspace has no module list');
  }
  const target = path.join(context.temporary, 'go.work');
  fs.copyFileSync(workspace, target);
  if (fs.existsSync(workspace + '.sum')) {
    fs.copyFileSync(workspace + '.sum', target + '.sum');
  }
  const vendor = path.join(path.dirname(workspace), 'vendor');
  if (fs.existsSync(vendor)) {
    fs.symlinkSync(vendor, path.join(context.temporary, 'vendor'), 'junction');
  }
  const edited = context.run(['work', 'edit', ...workspaceFlags(parsed, workspace), target]);
  if (edited.status !== 0) {
    throw new AnalysisError('Go workspace could not be isolated');
  }
  context.env.GOWORK = target;
}

function goArguments(flags) {
  const values = flags.match(/'[^']*'|"[^"]*"|\S+/gu) || [];
  return values.map((value) => (/^['"]/u.test(value) ? value.slice(1, -1) : value));
}

function defaultVendor(context, manifest, workspace) {
  const result = context.run([workspace ? 'work' : 'mod', 'edit', '-json', manifest]);
  if (result.status !== 0) {
    throw new AnalysisError('Go vendor build context could not be read');
  }
  const version = /^(?<major>\d+)\.(?<minor>\d+)/u.exec(JSON.parse(result.stdout).Go || '');
  if (!version) {
    throw new AnalysisError('Go vendor build version could not be determined');
  }
  const minimum = workspace ? 22 : 14;
  return Number(version[1]) > 1 || (Number(version[1]) === 1 && Number(version[2]) >= minimum);
}

function goBuildMode(context, settings) {
  const explicit = goArguments(settings.GOFLAGS)
    .filter((value) => value.startsWith('-mod='))
    .at(-1);
  if (explicit) {
    return explicit === '-mod=vendor' ? '-mod=vendor' : '-mod=readonly';
  }
  const workspace = Boolean(settings.GOWORK && settings.GOWORK !== 'off');
  const manifest = workspace ? settings.GOWORK : settings.GOMOD;
  if (!fs.existsSync(path.join(path.dirname(manifest), 'vendor', 'modules.txt'))) {
    return '-mod=readonly';
  }
  return defaultVendor(context, manifest, workspace) ? '-mod=vendor' : '-mod=readonly';
}

function goOverlay(flags, root) {
  const args = goArguments(flags);
  const flag = args.filter((value) => value.startsWith('-overlay=')).at(-1);
  if (!flag) {
    if (flags.includes('-overlay')) {
      throw new AnalysisError('Go overlay path could not be resolved');
    }
    return new Map();
  }
  const parsed = JSON.parse(fs.readFileSync(path.resolve(root, flag.slice(9)), { encoding: 'utf8' }));
  if (!parsed.Replace || typeof parsed.Replace !== 'object' || Array.isArray(parsed.Replace)) {
    throw new AnalysisError('Go overlay mappings are invalid');
  }
  return new Map(
    Object.entries(parsed.Replace).map(([original, replacement]) => {
      if (typeof replacement !== 'string') {
        throw new AnalysisError('Go overlay mappings are invalid');
      }
      const target = replacement ? canonical(path.resolve(root, replacement)) : '';
      return [path.resolve(root, original), target];
    })
  );
}

function goInventory(result, overlay) {
  if (result.status !== 0 || result.stderr.trim()) {
    throw new AnalysisError('Go package inventory could not be read');
  }
  const packages = jsonObjects(result.stdout);
  if (!packages.length) {
    throw new AnalysisError('Go returned no package inventory');
  }
  const sources = new Set();
  for (const entry of packages) {
    packageSources(entry, overlay, sources);
  }
  return sources;
}

function goPosition(position, root, sources) {
  const match =
    /^(?<file>.*):(?<line>\d+):(?<column>\d+)$/u.exec(position) || /^(?<file>.*):(?<line>\d+)$/u.exec(position);
  if (!match) {
    throw new Error();
  }
  const file = canonical(path.resolve(root, match[1]));
  if (!sources.has(file)) {
    throw new Error();
  }
  return { file, line: Number(match[2]) };
}

function vetIssues(records, job, sources) {
  const issues = [];
  for (const record of records) {
    assertGoRecord(record);
    for (const analyzers of Object.values(record)) {
      assertGoRecord(analyzers);
      for (const [rule, diagnostics] of Object.entries(/** @type {Record<string, unknown>} */ (analyzers))) {
        issues.push(...vetAnalyzerIssues(rule, diagnostics, job, sources));
      }
    }
  }
  return issues;
}

function goCompileIssues(text, job, sources) {
  const { issue } = require('./language-checks-runtime.js');
  const issues = [];
  for (const line of text.split(/\r?\n/u)) {
    if (!line.trim() || line.startsWith('# ') || /^\s/u.test(line)) {
      continue;
    }
    const match = /^(?:vet: )?(?<position>.*\.go:\d+(?::\d+)?): /u.exec(line);
    if (!match) {
      throw new Error();
    }
    const location = goPosition(match[1], job.root, sources);
    issues.push(issue(job.tool, 'error', location.file, location.line, 'compile-error'));
  }
  if (!issues.length) {
    throw new Error();
  }
  return issues;
}

function goVet(job) {
  return runNative(job, 'go', (context) => {
    const settings = configureGo(context);
    context.phase('build-context');
    const overlay = goOverlay(settings.GOFLAGS, job.root);
    const mode = goBuildMode(context, settings);
    const packages = [
      ...new Set(job.files.map((file) => './' + path.relative(job.root, path.dirname(file)).split(path.sep).join('/'))),
    ];
    const inventory = context.run(['list', mode, '-json', '-test', ...packages]);
    context.phase('inventory');
    const sources = goInventory(inventory, overlay);
    const result = context.run(['vet', mode, '-json', ...packages]);
    context.phase('diagnostics');
    const text = result.stdout + '\n' + result.stderr;
    let issues;
    try {
      issues = vetIssues(jsonObjects(text), job, sources);
    } catch {
      if (result.status === 0) {
        throw new AnalysisError('Go vet returned invalid diagnostic output');
      }
      issues = goCompileIssues(text, job, sources);
    }
    if (result.status !== 0 && !issues.length) {
      throw new AnalysisError('Go vet failed without source diagnostics');
    }
    return checked(job.tool, job.root, {
      requested: job.files,
      covered: job.files.filter((file) => sources.has(canonical(file))),
      issues,
      reason:
        'Go list test inventory and go vet JSON; project build conditions and overlay; offline, read-only modules',
    });
  });
}

module.exports = { goVet };
