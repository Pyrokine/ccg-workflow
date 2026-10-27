'use strict';

const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');

const TIMEOUT = 30000;
const MAX_OUTPUT = 8 * 1024 * 1024;
const JS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts']);
const CPP = new Set(['.c', '.cc', '.cpp', '.cxx', '.h', '.hh', '.hpp', '.hxx']);
const FLAT_CONFIGS = ['eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts', 'eslint.config.mts', 'eslint.config.cts'];
const ESLINT_CONFIGS = [...FLAT_CONFIGS, '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json', '.eslintrc.yaml', '.eslintrc.yml', '.eslintrc'];

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
  const included = patterns.some((pattern) => typeof pattern === 'string'
    && !pattern.startsWith('!') && path.matchesGlob(relative, pattern));
  const excluded = patterns.some((pattern) => typeof pattern === 'string'
    && pattern.startsWith('!') && path.matchesGlob(relative, pattern.slice(1)));
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
  const fallback = repository < 0 ? available.find((directory) => hasProjectFile(directory, standalone)) : available[repository];
  const project = available.find((directory) => hasProjectFile(directory, ['package.json', 'pyproject.toml']))
    || fallback || path.dirname(file);
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
  return directories.find((directory) => ['package.json', 'pyproject.toml', '.git'].some((name) => fs.existsSync(path.join(directory, name)))) || directories[directories.length - 1];
}

function eslintConfig(file) {
  for (const directory of projectDirectories(file)) {
    for (const name of ESLINT_CONFIGS) {
      const config = path.join(directory, name);
      if (fs.existsSync(config)) return config;
    }
    const manifest = path.join(directory, 'package.json');
    if (fs.existsSync(manifest) && JSON.parse(fs.readFileSync(manifest, 'utf8')).eslintConfig) return manifest;
  }
  return undefined;
}

function localModule(file, name) {
  for (const directory of projectDirectories(file)) {
    const candidate = path.join(directory, 'node_modules', name);
    if (fs.existsSync(candidate)) return require.resolve(candidate);
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
      } catch { /* 继续检查其他 PATH 项 */ }
    }
  }
  return undefined;
}

function execute(command, args, cwd, input, options = {}) {
  const result = childProcess.spawnSync(command, args, {
    cwd,
    input,
    ...options,
    encoding: 'utf8',
    timeout: TIMEOUT,
    killSignal: 'SIGKILL',
    maxBuffer: MAX_OUTPUT,
    windowsHide: true,
    shell: false,
  });
  if (result.error) {
    const reason = result.error.code === 'ETIMEDOUT' ? 'Analysis timed out' : result.error.code === 'ENOBUFS' ? 'Analysis output exceeded the limit' : 'Analysis process could not run';
    return { reason };
  }
  if (result.signal) return { reason: 'Analysis process terminated by a signal' };
  if (result.status !== 0 && result.status !== 1) return { reason: 'Analysis process failed' };
  return result;
}

function issue(tool, severity, file, line, rule) {
  const ruleId = typeof rule === 'string' && /^[\w@/.-]{1,100}$/.test(rule) && !/(?:sk-|ghp_|github_pat_|gh[ousr]_)[A-Za-z0-9_-]{16,}/u.test(rule) ? rule : tool;
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
    checks: [{ tool, status: 'unavailable', files: [], project_root: root, requested_files: files, skipped_files: files, diagnostics: 0, reason }],
    issues: [],
    uncovered: files.map((file) => ({ path: file, reason: `${tool}: ${reason}` })),
  };
}

function checked(tool, root, { requested, covered, issues, reason }) {
  const skipped = requested.filter((file) => !covered.includes(file));
  return {
    checks: [{ tool, status: covered.length ? (issues.some((entry) => entry.severity === 'error') ? 'failed' : 'passed') : 'unavailable', files: covered, project_root: root, requested_files: requested, skipped_files: skipped, diagnostics: issues.length, reason: covered.length ? reason : 'No requested files were analyzed' }],
    issues,
    uncovered: skipped.map((file) => ({ path: file, reason: `${tool}: file excluded or outside the analysis project` })),
  };
}

function runWorker(job) {
  const result = execute(process.execPath, [__filename, '--language-check-worker'], job.root, JSON.stringify(job), {
    // 独立管道避免工具日志混入诊断，并保留标准输出的回调语义
    stdio: ['pipe', 'ignore', 'ignore', 'pipe'],
  });
  if (result.reason) return unavailable(job.tool, job.root, job.files, result.reason);
  try {
    const output = JSON.parse(result.output[3]);
    if (!output || !Array.isArray(output.checks) || !Array.isArray(output.issues) || !Array.isArray(output.uncovered)) throw new Error();
    return output;
  } catch {
    return unavailable(job.tool, job.root, job.files, 'Analysis returned invalid output');
  }
}

function registrationBinding(node, members = []) {
  if (node.type === 'CallExpression') return registrationBinding(node.callee, members);
  if (node.type === 'MemberExpression' && !node.computed) {
    return registrationBinding(node.object, [node.property.name, ...members]);
  }
  return { node, members };
}

function importDefinition(node, context) {
  const source = context.sourceCode || context.getSourceCode();
  let scope = source.getScope ? source.getScope(node) : context.getScope();
  while (scope && !scope.set.has(node.name)) scope = scope.upper;
  return scope?.set.get(node.name)?.defs.find((entry) => entry.type === 'ImportBinding');
}

function registrationName(binding, context) {
  const definition = importDefinition(binding.node, context);
  if (!definition || definition.parent.source.value !== 'vitest') return undefined;
  return definition.node.type === 'ImportNamespaceSpecifier'
    ? binding.members.shift() : definition.node.imported?.name;
}

function registrationCallback(node, context) {
  const call = node.parent;
  if (call?.type !== 'CallExpression' || call.arguments.length < 2 || call.arguments.at(-1) !== node) return false;
  const binding = registrationBinding(call.callee);
  if (binding.node.type !== 'Identifier') return false;
  const imported = registrationName(binding, context);
  const modifiers = new Set(['each', 'for', 'only', 'skip', 'todo', 'concurrent', 'sequential', 'shuffle', 'skipIf', 'runIf']);
  return ['describe', 'suite'].includes(imported) && binding.members.every((member) => modifiers.has(member));
}

function registrationCollector(registrations) {
  return {
    meta: { schema: [] },
    create(context) {
      const entry = { source: context.sourceCode || context.getSourceCode(), functions: new Set() };
      registrations.set(context.filename || context.getFilename(), entry);
      const collect = (node) => {
        if (registrationCallback(node, context)) entry.functions.add(node);
      };
      return { FunctionExpression: collect, ArrowFunctionExpression: collect };
    },
  };
}

function registrationMessage(diagnostic, entry) {
  if (diagnostic.ruleId !== 'max-lines-per-function' || !entry) return false;
  const index = entry.source.getIndexFromLoc({ line: diagnostic.line, column: diagnostic.column - 1 });
  let node = entry.source.getNodeByRangeIndex(index);
  while (node && !['ArrowFunctionExpression', 'FunctionExpression', 'FunctionDeclaration'].includes(node.type)) {
    node = node.parent;
  }
  return entry.functions.has(node);
}

function eslintOptions(job, registrations, flat) {
  const plugin = 'ccg-quality-registration';
  return {
    cwd: job.root,
    fix: false,
    cache: false,
    plugins: { [plugin]: { rules: { collect: registrationCollector(registrations) } } },
    overrideConfigFile: job.config,
    errorOnUnmatchedPattern: false,
    overrideConfig: {
      ...(!flat ? { plugins: [plugin] } : {}),
      rules: {
        [`${plugin}/collect`]: 'warn',
        complexity: ['warn', job.limits.maxComplexity],
        'max-lines-per-function': ['warn', { max: job.limits.maxFunctionLength, skipBlankLines: true, skipComments: true }],
        'max-params': ['warn', job.limits.maxParameters],
      },
    },
  };
}

async function eslintFiles(eslint, files) {
  const active = [];
  for (const file of files) {
    if (!(await eslint.isPathIgnored(file)) && await eslint.calculateConfigForFile(file)) active.push(file);
  }
  return active;
}

function invalidEslintDiagnostic(diagnostic) {
  return (diagnostic.fatal && !Number.isInteger(diagnostic.line))
    || /^Definition for rule /u.test(diagnostic.message)
    || /(?:TSConfig does not|not found by the project service|configured to run.*parserOptions|Cannot read file.*tsconfig)/u.test(diagnostic.message);
}

function eslintResults(active, results, registrations) {
  const covered = [];
  const issues = [];
  for (const result of results) {
    const file = active.find((entry) => canonical(entry) === canonical(result.filePath));
    if (!file || !Array.isArray(result.messages)) throw new Error();
    covered.push(file);
    for (const diagnostic of result.messages) {
      if (invalidEslintDiagnostic(diagnostic)) throw new Error();
      // 注册容器的长度包含全部子用例，测试本体仍按相同阈值检查
      if (registrationMessage(diagnostic, registrations.get(result.filePath))) continue;
      issues.push(issue('eslint', diagnostic.severity === 2 ? 'error' : 'warning', file, diagnostic.line, diagnostic.ruleId || 'parse-error'));
    }
  }
  return { covered, issues };
}

async function eslintWorker(job) {
  if (!job.config) return unavailable('eslint', job.root, job.files, 'No project ESLint configuration was found');
  const api = require(job.modulePath);
  const flat = FLAT_CONFIGS.includes(path.basename(job.config));
  const ESLint = api.loadESLint ? await api.loadESLint({ useFlatConfig: flat }) : api.ESLint;
  const registrations = new Map();
  const eslint = new ESLint(eslintOptions(job, registrations, flat));
  const active = await eslintFiles(eslint, job.files);
  const results = active.length ? await eslint.lintFiles(active) : [];
  const { covered, issues } = eslintResults(active, results, registrations);
  return checked('eslint', job.root, {
    requested: job.files, covered, issues,
    reason: 'Project-local ESLint API; project configuration; AST threshold rules are warnings',
  });
}

function typescriptWorker(job) {
  const ts = require(job.modulePath);
  const projects = new Map();
  function load(config) {
    config = canonical(config);
    if (projects.has(config)) return;
    const parsed = ts.getParsedCommandLineOfConfigFile(config, { noEmit: true }, { ...ts.sys, onUnRecoverableConfigFileDiagnostic() {} });
    if (!parsed || parsed.errors.length) throw new Error();
    projects.set(config, parsed);
    for (const reference of parsed.projectReferences || []) load(ts.resolveProjectReferencePath(reference));
  }
  for (const config of job.configs) load(config);
  const checks = [];
  const issues = [];
  const covered = new Set();
  for (const [config, parsed] of projects) {
    if (!parsed.fileNames.length) continue;
    const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options, projectReferences: parsed.projectReferences, configFileParsingDiagnostics: parsed.errors });
    const sources = new Set(program.getSourceFiles().map((file) => canonical(file.fileName)));
    const inputs = job.files.filter((file) => sources.has(canonical(file)));
    if (!inputs.length) continue;
    for (const file of inputs) covered.add(file);
    const diagnostics = ts.getPreEmitDiagnostics(program);
    const invalid = diagnostics.some((diagnostic) => !diagnostic.file || canonical(diagnostic.file.fileName) === config || [6305, 6306, 6310].includes(diagnostic.code));
    if (invalid) return unavailable('typescript', job.root, job.files, 'TypeScript project configuration could not be analyzed');
    const projectIssues = diagnostics.map((diagnostic) => {
      const line = diagnostic.start === undefined ? 0 : diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line + 1;
      const severity = diagnostic.category === ts.DiagnosticCategory.Error ? 'error' : diagnostic.category === ts.DiagnosticCategory.Warning ? 'warning' : 'info';
      return issue('typescript', severity, diagnostic.file.fileName, line, `TS${diagnostic.code}`);
    });
    issues.push(...projectIssues);
    checks.push({ tool: 'typescript', status: projectIssues.some((entry) => entry.severity === 'error') ? 'failed' : 'passed', files: inputs, project_root: path.dirname(config), requested_files: inputs, skipped_files: [], diagnostics: projectIssues.length, reason: 'Project-local TypeScript compiler API; project scope; no emit or build-info writes' });
  }
  const skipped = job.files.filter((file) => /\.[cm]?tsx?$/u.test(file) && !covered.has(file));
  if (!covered.size) return skipped.length ? unavailable('typescript', job.root, skipped, 'No requested files belong to the TypeScript program') : { checks: [], issues: [], uncovered: [] };
  return { checks, issues, uncovered: skipped.map((file) => ({ path: file, reason: 'typescript: file is outside the TypeScript programs' })) };
}

function ruff(root, files) {
  const command = executable('ruff');
  if (!command) return unavailable('ruff', root, files, 'Ruff is not installed');
  const flags = ['check', '--no-cache', '--no-fix', '--no-fix-only', '--force-exclude'];
  const env = { ...process.env };
  delete env.RUFF_OUTPUT_FILE;
  // Ruff 诊断 JSON 不包含无问题文件，单独枚举覆盖范围以避免重复分析
  const inventory = execute(command, [...flags, '--show-files', '--', ...files], root, undefined, { env });
  if (inventory.reason) return unavailable('ruff', root, files, inventory.reason);
  if (inventory.status !== 0) return unavailable('ruff', root, files, 'Ruff could not enumerate project files');
  const listed = new Set(inventory.stdout.split(/\r?\n/u).filter(Boolean).map((file) => canonical(path.resolve(root, file))));
  const covered = files.filter((file) => listed.has(canonical(file)));
  if (!covered.length) return checked('ruff', root, {
    requested: files, covered: [], issues: [], reason: 'Ruff CLI; no cache or fixes',
  });
  const result = execute(command, [...flags, '--output-format', 'json', '--', ...covered], root, undefined, { env });
  if (result.reason) return unavailable('ruff', root, files, result.reason);
  try {
    const diagnostics = JSON.parse(result.stdout);
    if (!Array.isArray(diagnostics)) throw new Error();
    const issues = diagnostics.map((diagnostic) => {
      if (!diagnostic || typeof diagnostic.filename !== 'string' || !diagnostic.location || typeof diagnostic.code !== 'string') throw new Error();
      const file = covered.find((entry) => canonical(entry) === canonical(diagnostic.filename));
      if (!file) throw new Error();
      return issue('ruff', 'error', file, diagnostic.location.row, diagnostic.code);
    });
    if ((result.status === 1) !== (issues.length > 0)) throw new Error();
    return checked('ruff', root, {
      requested: files, covered, issues, reason: 'Ruff CLI; project configuration; no cache or fixes',
    });
  } catch {
    return unavailable('ruff', root, files, 'Ruff returned invalid diagnostic output');
  }
}

function compilationFiles(database, files) {
  const root = path.dirname(database);
  const entries = JSON.parse(fs.readFileSync(database, 'utf8'));
  if (!Array.isArray(entries)) throw new Error();
  const recorded = new Set(entries.map((entry) => {
    if (typeof entry.directory !== 'string' || typeof entry.file !== 'string'
      || (!Array.isArray(entry.arguments) && typeof entry.command !== 'string')) throw new Error();
    return canonical(path.resolve(root, entry.directory, entry.file));
  }));
  return files.filter((file) => recorded.has(canonical(file)));
}

function clangSeverity(kind, rule) {
  if (rule?.includes('-warnings-as-errors')) return 'error';
  return { warning: 'warning', note: 'info' }[kind] || 'error';
}

function clangDiagnostic(line, root) {
  const match = /^(.*):(\d+):(\d+): (warning|error|fatal error|note): .*?(?: \[([\w.,-]+)\])?$/u.exec(line);
  if (!match) {
    return {
      invalid: /^(?:error:|Error:|LLVM ERROR|unable to handle compilation|Could not auto-detect|no checks enabled)/iu.test(line.trim()),
      unknown: Boolean(line.trim()) && !/^\d+ warnings? generated\.|^Suppressed \d+ warnings?|^Use -header-filter|^Error while processing/u.test(line),
    };
  }
  const file = path.resolve(root, match[1]);
  if (!fs.existsSync(file)) return { invalid: true };
  const rule = match[5] ? match[5].split(',')[0] : 'clang-diagnostic';
  return { finding: issue('clang-tidy', clangSeverity(match[4], match[5]), file, Number(match[2]), rule) };
}

function clangResults(result, root) {
  const issues = [];
  let invalid = false;
  let unknown = false;
  for (const line of `${result.stdout}\n${result.stderr}`.split(/\r?\n/u)) {
    const diagnostic = clangDiagnostic(line, root);
    if (diagnostic.finding) issues.push(diagnostic.finding);
    invalid ||= diagnostic.invalid;
    unknown ||= diagnostic.unknown;
  }
  const failedWithoutError = result.status === 1 && !issues.some((entry) => entry.severity === 'error');
  if (invalid || (unknown && !issues.length) || failedWithoutError) throw new Error();
  return issues;
}

function clangTidy(database, files) {
  const root = path.dirname(database);
  const command = executable('clang-tidy');
  if (!command) return unavailable('clang-tidy', root, files, 'clang-tidy is not installed');
  let covered;
  try {
    covered = compilationFiles(database, files);
  } catch {
    return unavailable('clang-tidy', root, files, 'Compilation database could not be read');
  }
  if (!covered.length) return unavailable('clang-tidy', root, files, 'No requested file has a compilation database entry');
  const result = execute(command, ['-p', root, '--quiet', ...covered], root);
  if (result.reason) return unavailable('clang-tidy', root, files, result.reason);
  try {
    return checked('clang-tidy', root, {
      requested: files, covered, issues: clangResults(result, root),
      reason: 'clang-tidy CLI; existing compilation database; no build or fixes',
    });
  } catch {
    return unavailable('clang-tidy', root, files, 'clang-tidy failed or returned invalid diagnostics');
  }
}

function languageTool(extension) {
  if (JS.has(extension)) return 'eslint';
  if (extension === '.py' || extension === '.pyi') return 'ruff';
  return CPP.has(extension) ? 'clang-tidy' : 'unsupported';
}

function javascriptJobs(file, add, append) {
  const config = eslintConfig(file);
  const root = config ? path.dirname(config) : projectRoot(file);
  add('eslint', root, file, config);
  const tsconfig = nearest(file, ['tsconfig.json']);
  if (tsconfig) add('typescript', path.dirname(tsconfig), file, tsconfig);
  else if (/\.[cm]?tsx?$/u.test(path.extname(file).toLowerCase())) {
    append(unavailable('typescript', root, [file], 'No tsconfig.json was found'));
  }
}

function languageJobs(file, tool, add, append) {
  if (tool === 'eslint') return javascriptJobs(file, add, append);
  if (tool === 'ruff') {
    const config = nearest(file, ['.ruff.toml', 'ruff.toml', 'pyproject.toml']);
    return add('ruff', config ? path.dirname(config) : projectRoot(file), file, config);
  }
  if (tool === 'clang-tidy') {
    const database = nearest(file, ['compile_commands.json', 'build/compile_commands.json']);
    if (database) return add('clang-tidy', path.dirname(database), file, database);
    return append(unavailable('clang-tidy', projectRoot(file), [file], 'No compilation database was found'));
  }
  return append(unavailable('unsupported', projectRoot(file), [file], 'No language analyzer supports this file type'));
}

function unmanagedJavaScript(job) {
  if (job.tool !== 'typescript' || job.modulePath || job.files.some((file) => /\.[cm]?tsx?$/u.test(file))) return false;
  return job.configs.every((config) => {
    const raw = JSON.parse(fs.readFileSync(config, 'utf8'));
    return raw.compilerOptions?.allowJs === false || (!raw.extends && !raw.compilerOptions?.allowJs);
  });
}

function languageJob(job) {
  if (job.tool === 'ruff') return ruff(job.root, job.files);
  if (job.tool === 'clang-tidy') return clangTidy(job.config, job.files);
  if (unmanagedJavaScript(job)) return null;
  return job.modulePath ? runWorker(job)
    : unavailable(job.tool, job.root, job.files, 'Project-local tool dependency was not found');
}

function runLanguageChecks(files, limits) {
  const output = { checks: [], issues: [], uncovered: [] };
  const groups = new Map();
  const append = (result) => {
    output.checks.push(...result.checks);
    output.issues.push(...result.issues);
    output.uncovered.push(...result.uncovered);
  };
  const add = (tool, root, file, config) => {
    const modulePath = tool === 'eslint' || tool === 'typescript' ? localModule(file, tool) : undefined;
    const key = `${tool}\0${modulePath || root}\0${tool === 'typescript' ? '' : config || root}`;
    if (!groups.has(key)) groups.set(key, { tool, root, files: [], configs: [], config, modulePath, limits });
    const job = groups.get(key);
    job.files.push(file);
    if (config && !job.configs.includes(config)) job.configs.push(config);
  };
  const seen = new Set();
  for (const file of files) {
    let tool = 'unsupported';
    try {
      const real = canonical(file);
      if (seen.has(real)) continue;
      seen.add(real);
      tool = languageTool(path.extname(file).toLowerCase());
      languageJobs(file, tool, add, append);
    } catch {
      append(unavailable(tool, path.dirname(file), [file], 'Language analysis could not inspect the requested path'));
    }
  }
  for (const job of groups.values()) {
    try {
      const result = languageJob(job);
      if (result) append(result);
    } catch {
      append(unavailable(job.tool, job.root, job.files, 'Language analysis could not complete'));
    }
  }
  return output;
}

module.exports = { runLanguageChecks };

if (require.main === module && process.argv[2] === '--language-check-worker') {
  let job;
  Promise.resolve().then(async () => {
    job = JSON.parse(fs.readFileSync(0, 'utf8'));
    return job.tool === 'eslint' ? await eslintWorker(job) : typescriptWorker(job);
  }).catch(() => unavailable(job ? job.tool : 'unsupported', job ? job.root : process.cwd(), job ? job.files : [], 'Project tool or configuration could not be analyzed')).then((result) => fs.writeFileSync(3, JSON.stringify(result)));
}
