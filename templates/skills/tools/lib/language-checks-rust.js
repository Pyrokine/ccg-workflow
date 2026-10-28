'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { AnalysisError, canonical, checked, issue, runNative } = require('./language-checks-runtime.js');

function rustDiagnostic(diagnostic, root) {
  if (!diagnostic || !Array.isArray(diagnostic.spans)) throw new Error();
  const severity = { error: 'error', warning: 'warning', note: 'info', help: 'info', 'failure-note': 'info' }[
    diagnostic.level
  ];
  if (!severity) throw new Error();
  const spans = diagnostic.spans.filter((span) => span.is_primary);
  if (!spans.length && severity === 'error') {
    throw new AnalysisError('Rust reported an error without an analyzable source location');
  }
  return spans.map((span) => {
    if (typeof span.file_name !== 'string' || !Number.isInteger(span.line_start)) throw new Error();
    const file = canonical(path.resolve(root, span.file_name));
    return issue('clippy', severity, file, span.line_start, diagnostic.code?.code || 'rustc');
  });
}

function cargoProject(context, job) {
  const options = ['--manifest-path', job.config, '--frozen', '--offline'];
  const result = context.run(['metadata', '--format-version', '1', '--no-deps', ...options], job.root, [0, 101]);
  if (result.status !== 0)
    throw new AnalysisError('Cargo metadata requires an existing lockfile, cached dependencies and toolchain');
  const project = JSON.parse(result.stdout);
  if (typeof project.workspace_root !== 'string' || !Array.isArray(project.packages)) throw new Error();
  if (!fs.existsSync(path.join(project.workspace_root, 'Cargo.lock'))) {
    throw new AnalysisError('Cargo.lock is required for offline locked analysis');
  }
  if (
    !project.packages.length ||
    project.packages.some((entry) => typeof entry.id !== 'string' || typeof entry.manifest_path !== 'string')
  )
    throw new Error();
  return { ...project, options };
}

function cargoRecords(text) {
  const records = text
    .split(/\r?\n/u)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
  if (!records.length || records.some((entry) => !entry || typeof entry.reason !== 'string')) throw new Error();
  const allowed = ['compiler-message', 'compiler-artifact', 'build-script-executed', 'build-finished'];
  if (records.some((entry) => !allowed.includes(entry.reason))) throw new Error();
  return records;
}

function rustIssues(records, project) {
  const issues = [];
  const packages = new Set(project.packages.map((entry) => entry.id));
  for (const record of records.filter((entry) => entry.reason === 'compiler-message')) {
    if (!packages.has(record.package_id)) throw new Error();
    issues.push(...rustDiagnostic(record.message, project.workspace_root));
  }
  return issues;
}

function depInfoSources(content, root) {
  const text = content.replace(/\\\r?\n/gu, ' ');
  const separator = text.indexOf(': ');
  if (separator < 0) throw new AnalysisError('Rust dependency inventory could not be read');
  const dependencies = text.slice(separator + 2).split('\n', 1)[0];
  const tokens = dependencies.match(/(?:\\[\s\S]|[^\s\\])+/gu) || [];
  return tokens.map((token) => {
    const name = token.replace(/\\([\\\s#:$])/gu, '$1').replace(/\$\$/gu, '$');
    return canonical(path.resolve(root, name));
  });
}

function rustInventory(target, root) {
  const files = new Set();
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && entry.name.endsWith('.d')) {
        for (const source of depInfoSources(fs.readFileSync(file, 'utf8'), root)) files.add(source);
      }
    }
  }
  if (fs.existsSync(target)) visit(target);
  return files;
}

function clippy(job) {
  return runNative(job, 'cargo', (context) => {
    const target = path.join(context.temporary, 'target');
    Object.assign(context.env, {
      RUSTUP_AUTO_INSTALL: '0',
      RUSTUP_NO_UPDATE_CHECK: '1',
      CARGO_NET_OFFLINE: 'true',
      CARGO_INCREMENTAL: '0',
      CARGO_TARGET_DIR: target,
    });
    const project = cargoProject(context, job);
    const result = context.run(
      ['clippy', ...project.options, '--no-deps', '--all-targets', '--message-format=json', '--target-dir', target],
      job.root,
      [0, 101]
    );
    if (result.status !== 0 && !result.stdout.trim()) {
      throw new AnalysisError('Cargo could not complete offline locked analysis; check dependency cache and toolchain');
    }
    const records = cargoRecords(result.stdout);
    const issues = rustIssues(records, project);
    const completed = records.filter((entry) => entry.reason === 'build-finished');
    if (
      completed.length !== 1 ||
      typeof completed[0].success !== 'boolean' ||
      completed[0].success !== (result.status === 0)
    )
      throw new Error();
    if (result.status !== 0 && !issues.some((entry) => entry.severity === 'error')) {
      throw new AnalysisError('Cargo could not complete offline locked analysis; check dependency cache and toolchain');
    }
    const sources = rustInventory(target, project.workspace_root);
    return checked(job.tool, project.workspace_root, {
      requested: job.files,
      covered: job.files.filter((file) => sources.has(canonical(file))),
      issues,
      reason:
        'Cargo/Clippy JSON and fresh rustc dependency inventory; all targets; frozen, offline, temporary build output',
    });
  });
}

module.exports = { clippy };
