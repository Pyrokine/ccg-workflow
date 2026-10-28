'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const childProcess = require('node:child_process');
const { createRequire } = require('node:module');

const TIMEOUT = 30000;
const MAX_OUTPUT = 8 * 1024 * 1024;
const FLAT_CONFIGS = [
  'eslint.config.js',
  'eslint.config.mjs',
  'eslint.config.cjs',
  'eslint.config.ts',
  'eslint.config.mts',
  'eslint.config.cts',
];
const ESLINT_CONFIGS = [
  ...FLAT_CONFIGS,
  '.eslintrc.js',
  '.eslintrc.cjs',
  '.eslintrc.json',
  '.eslintrc.yaml',
  '.eslintrc.yml',
  '.eslintrc',
];

function stopProcessGroup(pid) {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    if (error.code !== 'ESRCH') return 'Analysis process group could not be terminated';
  }
  return undefined;
}

function processResult(result, acceptedStatuses) {
  if (result.error) {
    const reasons = { ETIMEDOUT: 'Analysis timed out', ENOBUFS: 'Analysis output exceeded the limit' };
    return { reason: reasons[result.error.code] || 'Analysis process could not run' };
  }
  if (result.signal) return { reason: 'Analysis process terminated by a signal' };
  if (!acceptedStatuses.includes(result.status)) return { reason: 'Analysis process failed' };
  return result;
}

function ancestors(directory) {
  const result = [];
  for (let current = directory; ; current = path.dirname(current)) {
    result.push(current);
    if (path.dirname(current) === current) return result;
  }
}

function canonical(file) {
  return fs.realpathSync(file);
}

function workspacePatterns(directory) {
  const manifest = path.join(directory, 'package.json');
  const workspace = fs.existsSync(manifest) ? JSON.parse(fs.readFileSync(manifest, 'utf8')).workspaces : undefined;
  const patterns = Array.isArray(workspace) ? workspace : workspace?.packages;
  const pnpm = path.join(directory, 'pnpm-workspace.yaml');
  if (!fs.existsSync(pnpm)) return patterns;
  const block = /^packages:\s*\n((?:[ \t]+[^\n]*\n?)*)/mu.exec(fs.readFileSync(pnpm, 'utf8'));
  return block ? [...block[1].matchAll(/^\s*-\s*['"]?([^'"\n]+?)['"]?\s*$/gmu)].map((match) => match[1]) : patterns;
}

function workspaceIncludes(directory, project) {
  const patterns = workspacePatterns(directory);
  if (!Array.isArray(patterns)) return false;
  const relative = path.relative(directory, project).split(path.sep).join('/');
  const included = patterns.some(
    (pattern) => typeof pattern === 'string' && !pattern.startsWith('!') && path.matchesGlob(relative, pattern)
  );
  const excluded = patterns.some(
    (pattern) => typeof pattern === 'string' && pattern.startsWith('!') && path.matchesGlob(relative, pattern.slice(1))
  );
  return included && !excluded;
}

function hasProjectFile(directory, names) {
  return names.some((name) => fs.existsSync(path.join(directory, name)));
}

function projectDirectories(file) {
  const directories = ancestors(path.dirname(file));
  const repository = directories.findIndex((directory) => fs.existsSync(path.join(directory, '.git')));
  const available = repository < 0 ? directories : directories.slice(0, repository + 1);
  const standalone = [...ESLINT_CONFIGS, 'tsconfig.json', 'ruff.toml', '.ruff.toml'];
  const fallback =
    repository < 0 ? available.find((directory) => hasProjectFile(directory, standalone)) : available[repository];
  const project =
    available.find((directory) => hasProjectFile(directory, ['package.json', 'pyproject.toml'])) ||
    fallback ||
    path.dirname(file);
  let boundary = project;
  for (const directory of available.slice(available.indexOf(project))) {
    if (workspaceIncludes(directory, project)) boundary = directory;
  }
  return directories.slice(0, directories.indexOf(boundary) + 1);
}

function nearest(file, names) {
  for (const directory of projectDirectories(file)) {
    for (const name of names) {
      const candidate = path.join(directory, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

function projectRoot(file) {
  const directories = projectDirectories(file);
  return (
    directories.find((directory) =>
      ['package.json', 'pyproject.toml', '.git'].some((name) => fs.existsSync(path.join(directory, name)))
    ) || directories[directories.length - 1]
  );
}

function eslintConfig(file) {
  const directories = projectDirectories(file);
  const parents = ancestors(path.dirname(file));
  const repository = parents.findIndex((directory) => fs.existsSync(path.join(directory, '.git')));
  if (repository >= 0) {
    for (const directory of parents.slice(directories.length, repository + 1)) {
      if (fs.existsSync(path.join(directory, 'package.json'))) directories.push(directory);
    }
  }
  for (const directory of directories) {
    for (const name of ESLINT_CONFIGS) {
      const config = path.join(directory, name);
      if (fs.existsSync(config)) return config;
    }
    const manifest = path.join(directory, 'package.json');
    if (fs.existsSync(manifest) && JSON.parse(fs.readFileSync(manifest, 'utf8')).eslintConfig) return manifest;
  }
  return undefined;
}

function localModule(file, name, root) {
  const directories = projectDirectories(file);
  if (name === 'eslint' && !directories.includes(root)) {
    const parents = ancestors(path.dirname(file));
    const boundary = parents.indexOf(root);
    if (boundary >= 0) directories.push(...parents.slice(directories.length, boundary + 1));
  }
  for (const directory of directories) {
    const candidate = path.join(directory, 'node_modules', name);
    if (!fs.existsSync(candidate)) continue;
    const resolved = createRequire(path.join(directory, 'package.json')).resolve(name);
    const relative = path.relative(canonical(candidate), canonical(resolved));
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative))
      throw new Error('Tool resolved outside its local package');
    return resolved;
  }
  return undefined;
}

function executable(name) {
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const directory of (process.env.PATH || '').split(path.delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = path.resolve(directory, name + extension);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        /* 继续检查其他 PATH 项 */
      }
    }
  }
  return undefined;
}

function execute(command, args, cwd, input, options = {}) {
  const { acceptedStatuses = [0, 1], timeout = TIMEOUT, ...spawnOptions } = options;
  const result = childProcess.spawnSync(command, args, {
    cwd,
    input,
    ...spawnOptions,
    encoding: 'utf8',
    timeout: Math.min(timeout, TIMEOUT),
    killSignal: 'SIGKILL',
    maxBuffer: MAX_OUTPUT,
    windowsHide: true,
    shell: false,
  });
  const groupError = spawnOptions.detached && result.pid ? stopProcessGroup(result.pid) : undefined;
  if (groupError) return { reason: groupError };
  return processResult(result, acceptedStatuses);
}

function issue(tool, severity, file, line, rule) {
  const ruleId =
    typeof rule === 'string' &&
    /^[\w@/:.-]{1,100}$/.test(rule) &&
    !/(?:sk-|ghp_|github_pat_|gh[ousr]_)[A-Za-z0-9_-]{16,}/u.test(rule)
      ? rule
      : tool;
  return {
    severity,
    category: 'language',
    message: `${tool}：${severity}（${ruleId}，诊断内容已脱敏）`,
    file_path: file,
    line_number: Number.isInteger(line) && line > 0 ? line : 0,
    rule_id: ruleId,
    tool,
    line_content: '[redacted]',
  };
}

function unavailable(tool, root, files, reason) {
  return {
    checks: [
      {
        tool,
        status: 'unavailable',
        files: [],
        project_root: root,
        requested_files: files,
        skipped_files: files,
        diagnostics: 0,
        reason,
      },
    ],
    issues: [],
    uncovered: files.map((file) => ({ path: file, reason: `${tool}: ${reason}` })),
  };
}

function checked(tool, root, { requested, covered, issues, reason }) {
  const skipped = requested.filter((file) => !covered.includes(file));
  return {
    checks: [
      {
        tool,
        status: covered.length
          ? issues.some((entry) => entry.severity === 'error')
            ? 'failed'
            : 'passed'
          : 'unavailable',
        files: covered,
        project_root: root,
        requested_files: requested,
        skipped_files: skipped,
        diagnostics: issues.length,
        reason: covered.length ? reason : 'No requested files were analyzed',
      },
    ],
    issues,
    uncovered: skipped.map((file) => ({
      path: file,
      reason: `${tool}: file excluded or outside the analysis project`,
    })),
  };
}

class AnalysisError extends Error {}

function nativeConfig(file, names) {
  for (const directory of ancestors(path.dirname(file))) {
    for (const name of names) {
      const candidate = path.join(directory, name);
      if (fs.existsSync(candidate)) return candidate;
    }
    if (fs.existsSync(path.join(directory, '.git'))) break;
  }
  return undefined;
}

function nativeContext(job, command, temporary) {
  const env = { ...process.env };
  const deadline = Date.now() + TIMEOUT;
  return {
    env,
    temporary,
    run(args, cwd = job.root, acceptedStatuses = [0, 1]) {
      const timeout = deadline - Date.now();
      if (timeout <= 0) throw new AnalysisError('Analysis timed out');
      const result = execute(command, args, cwd, undefined, {
        env,
        timeout,
        acceptedStatuses,
        detached: process.platform !== 'win32',
      });
      if (result.reason) throw new AnalysisError(result.reason);
      return result;
    },
  };
}

function runNative(job, name, analyze) {
  const command = executable(name);
  if (!command) return unavailable(job.tool, job.root, job.files, `${name} is not installed`);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ccg-language-'));
  try {
    return analyze(nativeContext(job, command, temporary));
  } catch (error) {
    const reason = error instanceof AnalysisError ? error.message : 'Native tool or project could not be analyzed';
    return unavailable(job.tool, job.root, job.files, reason);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

module.exports = {
  TIMEOUT,
  MAX_OUTPUT,
  FLAT_CONFIGS,
  AnalysisError,
  nativeConfig,
  runNative,
  ancestors,
  canonical,
  workspacePatterns,
  workspaceIncludes,
  hasProjectFile,
  projectDirectories,
  nearest,
  projectRoot,
  eslintConfig,
  localModule,
  executable,
  execute,
  issue,
  unavailable,
  checked,
};
