'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function git(root, ...args) {
  return execFileSync('git',
    ['--literal-pathspecs', '-c', 'core.quotepath=false', '-c', 'diff.relative=false', ...args],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000, maxBuffer: 32 * 1024 * 1024 });
}

function targetRepositories(targets) {
  const groups = new Map();
  for (const requested of targets) {
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
    const target = path.join(directory, ...suffix);
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
  const parts = git(root, 'diff', '--no-ext-diff', '--no-textconv', '--find-renames', '--name-status', '-z',
    ...args, '--', ...pathspecs).split('\0');
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
  return [...diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)]
    .map((match) => [Number(match[1]), Number(match[2] ?? 1)]);
}

function compareBaseline(files, issues, analyze, base, contents = new Map()) {
  const baseline = [];
  const errors = [];
  const groups = new Map();
  const roots = new Map();
  const byFile = new Map();
  for (const issue of issues) {
    issue.origin = 'unclassified';
    if (issue.tool) issue.change_scope = files.includes(issue.file_path) ? 'unknown' : 'outside_request';
    if (!byFile.has(issue.file_path)) byFile.set(issue.file_path, []);
    byFile.get(issue.file_path).push(issue);
  }
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
      baseline.push({ status: 'unavailable', ref: base || 'HEAD', path: file, reason: 'Git repository is unavailable' });
      if (base !== undefined) errors.push({ path: file, code: 'BASELINE_UNAVAILABLE', message: 'Explicit baseline requires a readable Git repository' });
    }
  }

  for (const [root, entries] of groups) {
    const record = { repository_root: root, ref: base || 'HEAD', status: 'unavailable' };
    baseline.push(record);
    try {
      const revision = git(root, 'rev-parse', '--verify', '--end-of-options', `${record.ref}^{commit}`).trim();
      const changes = new Map(readNameStatus(root, [revision]).map((change) => [change.path, change]));
      const names = [...new Set(entries.map((entry) => changes.get(entry.name)?.old_path || entry.name))];
      const tree = readTree(root, revision, names);
      const blobs = new Map();
      record.revision = revision;
      for (const entry of entries) {
        const current = byFile.get(entry.file) || [];
        if (!current.length) continue;
        const previousName = changes.get(entry.name)?.old_path || entry.name;
        const object = tree.get(previousName);
        if (object && (object.kind !== 'blob' || !/^100(?:644|755)$/.test(object.mode))) continue;
        let content = '';
        if (object) {
          if (!blobs.has(object.oid)) blobs.set(object.oid, git(root, 'cat-file', 'blob', object.oid));
          content = blobs.get(object.oid);
        }
        const previous = object ? analyze(path.join(root, previousName), content) : [];
        const oldLines = content.split('\n');
        const counts = new Map();
        for (const issue of previous) {
          const key = fingerprint(issue, oldLines);
          counts.set(key, (counts.get(key) || 0) + 1);
        }
        const currentLines = (contents.get(entry.file) ?? fs.readFileSync(entry.file, 'utf8')).split('\n');
        const ranges = current.some((issue) => issue.tool) && object ? changedLines(root, revision, entry.name) : [];
        for (const issue of current) {
          if (issue.tool) {
            issue.change_scope = !object || ranges.some(([start, count]) => issue.line_number >= start && issue.line_number < start + count)
              ? 'changed_lines' : 'unchanged_lines';
            continue;
          }
          const key = fingerprint(issue, currentLines);
          const count = counts.get(key) || 0;
          issue.origin = count ? 'existing' : 'new';
          if (count) counts.set(key, count - 1);
        }
      }
      record.status = 'available';
    } catch {
      record.reason = 'Git baseline comparison failed';
      if (base !== undefined) errors.push({ path: root, code: 'BASELINE_UNAVAILABLE', message: 'Explicit baseline could not be resolved or analyzed' });
      for (const entry of entries) {
        for (const issue of byFile.get(entry.file) || []) {
          issue.origin = 'unclassified';
          if (issue.tool) issue.change_scope = 'unknown';
        }
      }
    }
  }
  const originCounts = { new: 0, existing: 0, unclassified: 0 };
  for (const issue of issues) originCounts[issue.origin]++;
  return { baseline, origin_counts: originCounts, errors };
}

module.exports = { git, targetRepositories, readNameStatus, compareBaseline };
