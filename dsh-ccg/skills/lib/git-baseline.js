'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function resolveTarget(requested) {
  let directory = path.resolve(requested);
  const suffix = [];
  while (true) {
    try {
      if (fs.lstatSync(directory).isDirectory()) break;
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    }
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error('Cannot resolve target directory: ' + requested);
    suffix.unshift(path.basename(directory));
    directory = parent;
  }
  directory = fs.realpathSync(directory);
  return { directory, target: path.join(directory, ...suffix) };
}

function baselineIssueGroups(files, issues) {
  const groups = new Map();
  for (const entry of issues) {
    entry.origin = 'unclassified';
    if (entry.tool) entry.change_scope = files.includes(entry.file_path) ? 'unknown' : 'outside_request';
    if (!groups.has(entry.file_path)) groups.set(entry.file_path, []);
    groups.get(entry.file_path).push(entry);
  }
  return groups;
}

function baselineRepositories(files, base, result) {
  const roots = new Map(),
    groups = new Map();
  for (const file of files) {
    try {
      const canonical = fs.realpathSync(file);
      const directory = path.dirname(canonical);
      if (!roots.has(directory)) {
        roots.set(directory, null);
        roots.set(directory, git(directory, 'rev-parse', '--show-toplevel').replace(/\n$/, ''));
      }
      const root = roots.get(directory);
      if (!root) throw new Error('Git repository is unavailable');
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root).push({ file, canonical, name: path.relative(root, canonical).split(path.sep).join('/') });
    } catch {
      result.baseline.push({
        status: 'unavailable',
        ref: base || 'HEAD',
        path: file,
        reason: 'Git repository is unavailable',
      });
      if (base !== undefined)
        result.errors.push({
          path: file,
          code: 'BASELINE_UNAVAILABLE',
          message: 'Explicit baseline requires a readable Git repository',
        });
    }
  }
  return groups;
}

function baselineName(changes, entry) {
  return changes.get(entry.name)?.old_path || entry.name;
}

function regularBaselineBlob(object) {
  return !object || (object.kind === 'blob' && /^100(?:644|755)$/u.test(object.mode));
}

function baselineContent(object, context) {
  if (!object) return '';
  if (!context.blobs.has(object.oid)) context.blobs.set(object.oid, git(context.root, 'cat-file', 'blob', object.oid));
  return context.blobs.get(object.oid);
}

function baselineCounts(previous, content) {
  const lines = content.split('\n'),
    counts = new Map();
  for (const entry of previous) {
    const key = fingerprint(entry, lines);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function compareCurrentIssues(issues, context) {
  for (const entry of issues) {
    if (entry.tool) {
      entry.change_scope =
        !context.object ||
        context.ranges.some(([start, count]) => entry.line_number >= start && entry.line_number < start + count)
          ? 'changed_lines'
          : 'unchanged_lines';
      continue;
    }
    const key = fingerprint(entry, context.lines);
    const count = context.counts.get(key) || 0;
    entry.origin = count ? 'existing' : 'new';
    if (count) context.counts.set(key, count - 1);
  }
}

function compareBaselineEntry(entry, context) {
  const current = context.byFile.get(entry.file) || [];
  if (!current.length) return;
  const previousName = baselineName(context.changes, entry);
  const object = context.tree.get(previousName);
  if (!regularBaselineBlob(object)) return;
  const content = baselineContent(object, context);
  const previous = object ? context.analyze(path.join(context.root, previousName), content) : [];
  const lines = (context.contents.get(entry.file) ?? fs.readFileSync(entry.file, 'utf8')).split('\n');
  const ranges =
    current.some((issue) => issue.tool) && object ? changedLines(context.root, context.revision, entry.name) : [];
  compareCurrentIssues(current, { object, lines, ranges, counts: baselineCounts(previous, content) });
}

function compareRepository(root, entries, byFile, context) {
  const revision = git(root, 'rev-parse', '--verify', '--end-of-options', context.record.ref + '^{commit}').trim();
  const changes = new Map(readNameStatus(root, [revision]).map((change) => [change.path, change]));
  const names = [...new Set(entries.map((entry) => baselineName(changes, entry)))];
  const tree = readTree(root, revision, names);
  const state = { ...context, root, revision, changes, tree, byFile, blobs: new Map() };
  context.record.revision = revision;
  for (const entry of entries) compareBaselineEntry(entry, state);
  context.record.status = 'available';
}

function resetBaselineIssues(issues) {
  for (const entry of issues) {
    entry.origin = 'unclassified';
    if (entry.tool) entry.change_scope = 'unknown';
  }
}

function git(root, ...args) {
  return execFileSync(
    'git',
    ['--literal-pathspecs', '-c', 'core.quotepath=false', '-c', 'diff.relative=false', ...args],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000, maxBuffer: 32 * 1024 * 1024 }
  );
}

function targetRepositories(targets) {
  const groups = new Map();
  for (const requested of targets) {
    const { directory, target } = resolveTarget(requested);
    const root = git(directory, 'rev-parse', '--show-toplevel').replace(/\n$/, '');
    const relative = path.relative(root, target).split(path.sep).join('/');
    if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) {
      throw new Error('Target is outside the resolved repository: ' + requested);
    }
    if (!groups.has(root)) groups.set(root, { root, requested: [], paths: new Set() });
    const group = groups.get(root);
    group.requested.push(requested);
    group.paths.add(relative);
  }
  return [...groups.values()].map((group) => ({
    root: group.root,
    requested: group.requested,
    pathspecs: group.paths.has('') ? [] : [...group.paths],
  }));
}

function readNameStatus(root, args, pathspecs = []) {
  const parts = git(
    root,
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--find-renames',
    '--name-status',
    '-z',
    ...args,
    '--',
    ...pathspecs
  ).split('\0');
  const changes = [];
  for (let index = 0; index < parts.length && parts[index];) {
    const status = parts[index++];
    const from = parts[index++];
    const to = /^[RC]/.test(status) ? parts[index++] : from;
    if (!status || from === undefined || to === undefined) throw new Error('Invalid git name-status output');
    changes.push({ status, path: to, ...(from !== to ? { old_path: from } : {}) });
  }
  return changes;
}

function fingerprint(issue, lines) {
  const anchor = issue.line_number ? (lines[issue.line_number - 1] || '').trim() : '';
  return JSON.stringify([issue.rule_id || issue.category, issue.severity, anchor]);
}

function readTree(root, revision, names) {
  const tree = new Map();
  if (!names.length) return tree;
  const records = git(root, 'ls-tree', '-r', '-z', '--full-tree', revision, '--', ...names).split('\0');
  for (const record of records) {
    if (!record) continue;
    const separator = record.indexOf('\t');
    if (separator < 0) throw new Error('Invalid git tree output');
    const [mode, kind, oid] = record.slice(0, separator).split(' ');
    tree.set(record.slice(separator + 1), { mode, kind, oid });
  }
  return tree;
}

function changedLines(root, revision, name) {
  const diff = git(root, 'diff', '--no-ext-diff', '--no-textconv', '--unified=0', revision, '--', name);
  return [...diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)].map((match) => [
    Number(match[1]),
    Number(match[2] ?? 1),
  ]);
}

function compareBaseline(files, issues, analyze, base, contents = new Map()) {
  const baseline = [],
    errors = [];
  const byFile = baselineIssueGroups(files, issues);
  const groups = baselineRepositories(files, base, { baseline, errors });
  for (const [root, entries] of groups) {
    const record = { repository_root: root, ref: base || 'HEAD', status: 'unavailable' };
    baseline.push(record);
    try {
      compareRepository(root, entries, byFile, { record, analyze, contents });
    } catch {
      record.reason = 'Git baseline comparison failed';
      if (base !== undefined)
        errors.push({
          path: root,
          code: 'BASELINE_UNAVAILABLE',
          message: 'Explicit baseline could not be resolved or analyzed',
        });
      for (const entry of entries) resetBaselineIssues(byFile.get(entry.file) || []);
    }
  }
  const originCounts = { new: 0, existing: 0, unclassified: 0 };
  for (const entry of issues) originCounts[entry.origin]++;
  return { baseline, origin_counts: originCounts, errors };
}

module.exports = { git, targetRepositories, readNameStatus, compareBaseline };
