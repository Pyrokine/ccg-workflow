'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ancestors, canonical, execute, issue, checked, unavailable } = require('./language-checks-runtime.js');

function typescriptProjects(configs, ts) {
  const projects = new Map();
  function load(config) {
    config = canonical(config);
    if (projects.has(config)) return;
    const parsed = ts.getParsedCommandLineOfConfigFile(
      config,
      { noEmit: true },
      {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic() {},
      }
    );
    if (!parsed || parsed.errors.length) throw new Error();
    projects.set(config, parsed);
    for (const reference of parsed.projectReferences || []) load(ts.resolveProjectReferencePath(reference));
  }
  for (const config of configs) load(config);
  return projects;
}

function typescriptApiIssue(ts, diagnostic) {
  const line =
    diagnostic.start === undefined ? 0 : diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line + 1;
  const severity =
    diagnostic.category === ts.DiagnosticCategory.Error
      ? 'error'
      : diagnostic.category === ts.DiagnosticCategory.Warning
        ? 'warning'
        : 'info';
  return issue('typescript', severity, diagnostic.file.fileName, line, `TS${diagnostic.code}`);
}

function typescriptProgram(job, ts, config, parsed) {
  if (!parsed.fileNames.length) return null;
  const program = ts.createProgram({
    rootNames: parsed.fileNames,
    options: parsed.options,
    projectReferences: parsed.projectReferences,
    configFileParsingDiagnostics: parsed.errors,
  });
  const sources = new Set(program.getSourceFiles().map((file) => canonical(file.fileName)));
  const inputs = job.files.filter((file) => sources.has(canonical(file)));
  if (!inputs.length) return null;
  const diagnostics = ts.getPreEmitDiagnostics(program);
  const invalid = diagnostics.some(
    (diagnostic) =>
      !diagnostic.file || canonical(diagnostic.file.fileName) === config || [6305, 6306, 6310].includes(diagnostic.code)
  );
  if (invalid)
    return unavailable('typescript', job.root, job.files, 'TypeScript project configuration could not be analyzed');
  return checked('typescript', path.dirname(config), {
    requested: inputs,
    covered: inputs,
    issues: diagnostics.map((diagnostic) => typescriptApiIssue(ts, diagnostic)),
    reason: 'Project-local TypeScript compiler API; project scope; no emit or build-info writes',
  });
}

function typescriptCoverage(job, result, covered) {
  const skipped = job.files.filter((file) => /\.[cm]?tsx?$/u.test(file) && !covered.has(file));
  if (!covered.size)
    return skipped.length
      ? unavailable('typescript', job.root, skipped, 'No requested files belong to the TypeScript program')
      : { checks: [], issues: [], uncovered: [] };
  return {
    checks: result.checks,
    issues: result.issues,
    uncovered: skipped.map((file) => ({ path: file, reason: 'typescript: file is outside the TypeScript programs' })),
  };
}

function typescriptWorker(job) {
  const ts = require(job.modulePath);
  if (typeof ts.getParsedCommandLineOfConfigFile !== 'function' || typeof ts.createProgram !== 'function') {
    return { compilerApi: false };
  }
  const result = { checks: [], issues: [] };
  const covered = new Set();
  for (const [config, parsed] of typescriptProjects(job.configs, ts)) {
    const project = typescriptProgram(job, ts, config, parsed);
    if (!project) continue;
    if (project.uncovered.length) return project;
    result.checks.push(...project.checks);
    result.issues.push(...project.issues);
    for (const file of project.checks[0].files) covered.add(file);
  }
  return typescriptCoverage(job, result, covered);
}

function typescriptCliExecutable(modulePath) {
  const root = ancestors(path.dirname(modulePath)).find((directory) =>
    fs.existsSync(path.join(directory, 'package.json'))
  );
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (typeof manifest.bin?.tsc !== 'string')
    return {
      reason: 'Project-local TypeScript package provides neither the compiler API nor bin.tsc',
    };
  const cli = canonical(path.resolve(root, manifest.bin.tsc));
  const relative = path.relative(canonical(root), cli);
  if (
    relative === '..' ||
    relative.startsWith('..' + path.sep) ||
    path.isAbsolute(relative) ||
    !fs.statSync(cli).isFile()
  ) {
    return { reason: 'Project-local TypeScript CLI is outside its package' };
  }
  return { cli };
}

function invokeTypescript(context, config, flags) {
  const timeout = context.deadline - Date.now();
  if (timeout <= 0) throw new Error('Analysis timed out');
  const result = execute(
    process.execPath,
    [
      context.cli,
      '--project',
      config,
      '--noEmit',
      '--pretty',
      'false',
      '--tsBuildInfoFile',
      path.join(context.temporary, 'check.tsbuildinfo'),
      ...flags,
    ],
    path.dirname(config),
    undefined,
    { timeout, acceptedStatuses: [0, 1, 2] }
  );
  if (result.reason) throw new Error(result.reason);
  return result;
}

function typescriptCliInventory(context, config) {
  const settings = invokeTypescript(context, config, ['--showConfig']);
  if (settings.status !== 0 || settings.stderr.trim()) {
    throw new Error('TypeScript project configuration could not be analyzed');
  }
  const parsed = JSON.parse(settings.stdout);
  const inventory = invokeTypescript(context, config, ['--listFilesOnly']);
  if (inventory.status !== 0 || inventory.stderr.trim())
    throw new Error('TypeScript project files could not be enumerated');
  const sources = new Set(
    inventory.stdout
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((file) => canonical(path.resolve(path.dirname(config), file)))
  );
  return { parsed, sources };
}

function loadTypescriptCli(context, config) {
  config = canonical(config);
  if (context.projects.has(config)) return;
  context.projects.add(config);
  const { parsed, sources } = typescriptCliInventory(context, config);
  const inputs = context.job.files.filter((file) => sources.has(canonical(file)));
  if (inputs.length) {
    const diagnostics = typescriptDiagnostics(invokeTypescript(context, config, []), config, sources);
    for (const file of inputs) context.covered.add(file);
    const result = checked('typescript', path.dirname(config), {
      requested: inputs,
      covered: inputs,
      issues: diagnostics,
      reason: 'Project-local TypeScript CLI; project file inventory; no emit; temporary build-info only',
    });
    context.issues.push(...result.issues);
    context.checks.push(...result.checks);
  }
  for (const reference of parsed.references || []) {
    const target = path.resolve(path.dirname(config), reference.path);
    loadTypescriptCli(context, /\.json$/iu.test(target) ? target : path.join(target, 'tsconfig.json'));
  }
}

function typescriptCli(job, deadline) {
  const executable = typescriptCliExecutable(job.modulePath);
  if (executable.reason) return unavailable('typescript', job.root, job.files, executable.reason);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ccg-tsc-'));
  const context = {
    job,
    deadline,
    temporary,
    cli: executable.cli,
    projects: new Set(),
    checks: [],
    issues: [],
    covered: new Set(),
  };
  try {
    for (const config of job.configs) loadTypescriptCli(context, config);
    return typescriptCoverage(job, context, context.covered);
  } catch (error) {
    const known = [
      'Analysis timed out',
      'Analysis output exceeded the limit',
      'Analysis process could not run',
      'Analysis process terminated by a signal',
      'Analysis process failed',
    ];
    const reason = known.includes(error.message)
      ? error.message
      : 'TypeScript CLI or project configuration could not be analyzed';
    return unavailable('typescript', job.root, job.files, reason);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function typescriptCliIssue(line, config, sources) {
  const match = /^(.*)\((\d+),(\d+)\): (error|warning|message|suggestion) TS(\d+):/u.exec(line);
  if (!match) throw new Error();
  const file = canonical(path.resolve(path.dirname(config), match[1]));
  if (file === config || !sources.has(file) || ['6305', '6306', '6310'].includes(match[5])) throw new Error();
  const severity = { error: 'error', warning: 'warning' }[match[4]] || 'info';
  return issue('typescript', severity, file, Number(match[2]), `TS${match[5]}`);
}

function typescriptDiagnostics(result, config, sources) {
  if (result.stderr.trim()) throw new Error();
  const diagnostics = [];
  for (const line of result.stdout.split(/\r?\n/u)) {
    if (!line.trim() || (diagnostics.length && /^\s/u.test(line))) continue;
    diagnostics.push(typescriptCliIssue(line, config, sources));
  }
  if ((result.status !== 0) !== diagnostics.some((entry) => entry.severity === 'error')) throw new Error();
  return diagnostics;
}

module.exports = { typescriptWorker, typescriptCli };
