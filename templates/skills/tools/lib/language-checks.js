'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  TIMEOUT,
  FLAT_CONFIGS,
  canonical,
  projectRoot,
  nearest,
  eslintConfig,
  localModule,
  execute,
  issue,
  unavailable,
  checked,
  nativeConfig,
} = require('./language-checks-runtime.js');
const { ruff, clangTidy } = require('./language-checks-native.js');
const { goVet } = require('./language-checks-go.js');
const { clippy } = require('./language-checks-rust.js');
const { typescriptWorker, typescriptCli } = require('./language-checks-typescript.js');

const JS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts']);
const CPP = new Set(['.c', '.cc', '.cpp', '.cxx', '.h', '.hh', '.hpp', '.hxx']);

function runWorker(job) {
  const deadline = Date.now() + TIMEOUT;
  const result = execute(process.execPath, [__filename, '--language-check-worker'], job.root, JSON.stringify(job), {
    // 独立管道避免工具日志混入诊断，并保留标准输出的回调语义
    stdio: ['pipe', 'ignore', 'ignore', 'pipe'],
  });
  if (result.reason) return unavailable(job.tool, job.root, job.files, result.reason);
  try {
    const output = JSON.parse(result.output[3]);
    if (job.tool === 'typescript' && output?.compilerApi === false) return typescriptCli(job, deadline);
    if (!output || !Array.isArray(output.checks) || !Array.isArray(output.issues) || !Array.isArray(output.uncovered))
      throw new Error();
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
  return definition.node.type === 'ImportNamespaceSpecifier' ? binding.members.shift() : definition.node.imported?.name;
}

function registrationCallback(node, context) {
  const call = node.parent;
  if (call?.type !== 'CallExpression' || call.arguments.length < 2 || call.arguments.at(-1) !== node) return false;
  const binding = registrationBinding(call.callee);
  if (binding.node.type !== 'Identifier') return false;
  const imported = registrationName(binding, context);
  const modifiers = new Set([
    'each',
    'for',
    'only',
    'skip',
    'todo',
    'concurrent',
    'sequential',
    'shuffle',
    'skipIf',
    'runIf',
  ]);
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
        'max-lines-per-function': [
          'warn',
          { max: job.limits.maxFunctionLength, skipBlankLines: true, skipComments: true },
        ],
        'max-params': ['warn', job.limits.maxParameters],
      },
    },
  };
}

async function eslintFiles(eslint, files) {
  const active = [];
  for (const file of files) {
    if (!(await eslint.isPathIgnored(file)) && (await eslint.calculateConfigForFile(file))) active.push(file);
  }
  return active;
}

function invalidEslintDiagnostic(diagnostic) {
  return (
    (diagnostic.fatal && !Number.isInteger(diagnostic.line)) ||
    /^Definition for rule /u.test(diagnostic.message) ||
    /TSConfig does not|not found by the project service/u.test(diagnostic.message) ||
    /configured to run.*parserOptions|Cannot read file.*tsconfig/u.test(diagnostic.message)
  );
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
      issues.push(
        issue(
          'eslint',
          diagnostic.severity === 2 ? 'error' : 'warning',
          file,
          diagnostic.line,
          diagnostic.ruleId || 'parse-error'
        )
      );
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
    requested: job.files,
    covered,
    issues,
    reason: 'Project-local ESLint API; project configuration; AST threshold rules are warnings',
  });
}

function languageTool(extension) {
  if (JS.has(extension)) return 'eslint';
  if (extension === '.py' || extension === '.pyi') return 'ruff';
  if (extension === '.go') return 'go-vet';
  if (extension === '.rs') return 'clippy';
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

function nativeJob(file, tool, add, append) {
  const names = tool === 'go-vet' ? ['go.mod', 'go.work'] : ['Cargo.toml'];
  const config = nativeConfig(file, names);
  if (config) return add(tool, path.dirname(config), file, config);
  return append(unavailable(tool, path.dirname(file), [file], 'No native project manifest was found'));
}

function languageJobs(file, tool, add, append) {
  if (tool === 'go-vet' || tool === 'clippy') return nativeJob(file, tool, add, append);
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
  if (job.tool === 'go-vet') return goVet(job);
  if (job.tool === 'clippy') return clippy(job);
  if (job.tool === 'ruff') return ruff(job.root, job.files, job.targetVersion);
  if (job.tool === 'clang-tidy') return clangTidy(job.config, job.files);
  if (unmanagedJavaScript(job)) return null;
  return job.modulePath
    ? runWorker(job)
    : unavailable(job.tool, job.root, job.files, 'Project-local tool dependency was not found');
}

function runLanguageChecks(files, limits, targetVersion) {
  const output = { checks: [], issues: [], uncovered: [] };
  const groups = new Map();
  const append = (result) => {
    output.checks.push(...result.checks);
    output.issues.push(...result.issues);
    output.uncovered.push(...result.uncovered);
  };
  const add = (tool, root, file, config) => {
    const modulePath = tool === 'eslint' || tool === 'typescript' ? localModule(file, tool, root) : undefined;
    const key = `${tool}\0${modulePath || root}\0${tool === 'typescript' ? '' : config || root}`;
    if (!groups.has(key))
      groups.set(key, { tool, root, files: [], configs: [], config, modulePath, limits, targetVersion });
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
  Promise.resolve()
    .then(async () => {
      job = JSON.parse(fs.readFileSync(0, 'utf8'));
      return job.tool === 'eslint' ? await eslintWorker(job) : typescriptWorker(job);
    })
    .catch(() =>
      unavailable(
        job ? job.tool : 'unsupported',
        job ? job.root : process.cwd(),
        job ? job.files : [],
        'Project tool or configuration could not be analyzed'
      )
    )
    .then((result) => fs.writeFileSync(3, JSON.stringify(result)));
}
