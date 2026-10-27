#!/usr/bin/env node
'use strict';

const path = require('path');
const fs = require('fs');
const { parseCliArgs, runCli, buildReport, DASH } = require(path.join(__dirname, '..', '..', 'lib', 'shared.js'));
const { git, targetRepositories, readNameStatus } = require(path.join(__dirname, '..', '..', 'lib', 'git-baseline.js'));

const CODE_EXT = new Set([
  '.py', '.go', '.rs', '.ts', '.mts', '.cts', '.js', '.mjs', '.cjs', '.jsx', '.tsx', '.java',
  '.c', '.cc', '.cpp', '.cxx', '.h', '.hh', '.hpp', '.hxx',
]);
const DOC_EXT = new Set(['.md', '.rst', '.txt', '.adoc']);
const TEST_PATTERNS = [
  /(?:^|\/)(?:tests?|__tests__|specs?)(?:\/|$)/,
  /(?:^|\/)(?:test|spec)[_.][^/]+$/,
  /[._](?:test|spec)\.[^/]+$/,
];
const CONFIG_FILES = new Set([
  'package.json',
  'pyproject.toml',
  'go.mod',
  'cargo.toml',
  'pom.xml',
  'makefile',
  'dockerfile',
]);
const CONFIG_EXT = new Set(['.yaml', '.yml', '.json', '.toml', '.ini']);

function normalizePath(p) {
  let s = p.trim();
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    s = s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  if (s.startsWith('./')) s = s.slice(2);
  return s;
}

function classifyFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const name = path.basename(filePath).toLowerCase();
  const lower = '/' + filePath.toLowerCase();
  return {
    path: filePath,
    type: 'modified',
    additions: 0,
    deletions: 0,
    is_code: CODE_EXT.has(ext),
    is_doc: DOC_EXT.has(ext),
    is_test: TEST_PATTERNS.some((pattern) => pattern.test(lower)),
    is_config: CONFIG_FILES.has(name) || CONFIG_EXT.has(ext),
  };
}

function parseNameStatusLine(line) {
  const parts = Array.isArray(line) ? line : line.split('\t');
  if (parts.length < 2) return null;
  const status = parts[0][0];
  const p = Array.isArray(line) ? parts[parts.length - 1] : normalizePath(parts[parts.length - 1]);
  if (!p) return null;
  const c = classifyFile(p);
  const map = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed' };
  if (map[status]) c.type = map[status];
  return c;
}

function parsePorcelainLine(line) {
  if (!Array.isArray(line) && line.length < 3) return null;
  const status = Array.isArray(line) ? line[0] : line.slice(0, 2);
  let raw = Array.isArray(line) ? line[1] : line.slice(3);
  if (!raw) return null;
  if (!Array.isArray(line) && raw.includes(' -> ')) raw = raw.split(' -> ')[1];
  const p = Array.isArray(line) ? raw : normalizePath(raw);
  if (!p) return null;
  const c = classifyFile(p);
  if (status.includes('?') || status.includes('A')) c.type = 'added';
  else if (status.includes('R')) c.type = 'renamed';
  else if (status.includes('M')) c.type = 'modified';
  else if (status.includes('D')) c.type = 'deleted';
  return c;
}

function readGitChanges(root, args, pathspecs) {
  const changes = readNameStatus(root, args, pathspecs).map((entry) => {
    const change = parseNameStatusLine([entry.status, entry.path]);
    if (!change) throw new Error('Invalid git name-status output');
    if (entry.old_path) change.old_path = entry.old_path;
    return change;
  });
  applyNumstat(changes, args, root, pathspecs);
  return changes;
}

function getGitChanges(base = 'HEAD~1', target = 'HEAD', root = process.cwd(), pathspecs = []) {
  return readGitChanges(root, [base, target], pathspecs);
}

function applyNumstat(changes, args, root = process.cwd(), pathspecs = []) {
  const parts = git(root, 'diff', '--no-ext-diff', '--numstat', '-z', ...args, '--', ...pathspecs).split('\0');
  const stats = new Map();
  for (let i = 0; i < parts.length && parts[i];) {
    const entry = parts[i++];
    const first = entry.indexOf('\t');
    const second = entry.indexOf('\t', first + 1);
    if (first < 0 || second < 0) throw new Error('Invalid git numstat output');
    let name = entry.slice(second + 1);
    if (!name) {
      i++;
      name = parts[i++];
    }
    stats.set(name, [Number(entry.slice(0, first)) || 0, Number(entry.slice(first + 1, second)) || 0]);
  }
  for (const change of changes) {
    if (stats.has(change.path)) [change.additions, change.deletions] = stats.get(change.path);
  }
}

function countFileLines(filePath) {
  const stat = fs.lstatSync(filePath);
  if (stat.isDirectory()) return 0;
  const content = stat.isSymbolicLink() ? fs.readlinkSync(filePath) : fs.readFileSync(filePath, 'utf8');
  if (!content) return 0;
  const newlines = (content.match(/\n/g) || []).length;
  return content.endsWith('\n') ? newlines : newlines + 1;
}

function getStagedChanges(root = process.cwd(), pathspecs = []) {
  return readGitChanges(root, ['--cached'], pathspecs);
}

function getWorkingChanges(root = process.cwd(), pathspecs = []) {
  const parts = git(root, 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...pathspecs).split('\0');
  const changes = [];
  const untracked = new Set();
  for (let i = 0; i < parts.length && parts[i];) {
    const entry = parts[i++];
    const status = entry.slice(0, 2);
    const change = parsePorcelainLine([status, entry.slice(3)]);
    if (!change) throw new Error('Invalid git status output');
    if (/[RC]/.test(status)) change.old_path = parts[i++];
    if (status === '??') untracked.add(change.path);
    changes.push(change);
  }
  const staged = changes.map((change) => ({ ...change, additions: 0, deletions: 0 }));
  const unstaged = changes.map((change) => ({ ...change, additions: 0, deletions: 0 }));
  applyNumstat(staged, ['--cached'], root, pathspecs);
  applyNumstat(unstaged, [], root, pathspecs);
  for (let i = 0; i < changes.length; i++) {
    const change = changes[i];
    change.additions = staged[i].additions + unstaged[i].additions;
    change.deletions = staged[i].deletions + unstaged[i].deletions;
    if (untracked.has(change.path)) {
      change.additions = countFileLines(path.join(root, change.path));
    }
  }
  return changes;
}

const MODULE_DOC = /^(?:README|DESIGN)(?:[._-][\w-]+)?\.(?:md|rst|txt|adoc)$/i;

function directoryEntries(directory) {
  try {
    if (!fs.lstatSync(directory).isDirectory()) return [];
    return fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return [];
    throw error;
  }
}

function moduleForPath(filePath, root) {
  let directory = path.posix.dirname(filePath);
  while (true) {
    if (directoryEntries(path.join(root, directory)).some((entry) => entry.isFile() && MODULE_DOC.test(entry.name))) {
      return directory;
    }
    if (directory === '.') break;
    directory = path.posix.dirname(directory);
  }
  return filePath.includes('/') ? filePath.split('/')[0] : '.';
}

function identifyModules(changes, root = process.cwd()) {
  return new Set(changes.map((change) => moduleForPath(change.path, root)));
}

function relatedDocuments(root, mod, changes) {
  const directory = path.join(root, mod);
  const docs = new Set();
  const add = (candidate) => {
    const relative = path.relative(root, candidate);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return;
    try {
      if (fs.lstatSync(candidate).isFile()) docs.add(relative.split(path.sep).join('/'));
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    }
  };
  for (const entry of directoryEntries(directory)) {
    if (!entry.isFile() || !MODULE_DOC.test(entry.name)) continue;
    const file = path.join(directory, entry.name);
    add(file);
    const content = fs.readFileSync(file, 'utf8');
    for (const match of content.matchAll(/\[[^\]\n]*\]\(([^\s)#?]+)(?:#[^\s)]*)?\)/g)) {
      if (!/^[\w+.-]+:|^\/\//.test(match[1]) && DOC_EXT.has(path.extname(match[1]).toLowerCase())) {
        add(path.resolve(directory, match[1]));
      }
    }
  }
  const names = new Set(['readme', 'design', 'index', path.basename(directory).toLowerCase()]);
  for (const change of changes) names.add(path.basename(change.path, path.extname(change.path)).toLowerCase());
  for (const entry of directoryEntries(path.join(directory, 'docs'))) {
    if (entry.isFile() && DOC_EXT.has(path.extname(entry.name).toLowerCase()) &&
        names.has(path.basename(entry.name, path.extname(entry.name)).toLowerCase())) {
      add(path.join(directory, 'docs', entry.name));
    }
  }
  return [...docs].sort();
}

function checkDocSync(changes, modules, root = process.cwd()) {
  const docStatus = {};
  const docSync = {};
  const issues = [];
  const codeChanges = changes.filter((change) => change.is_code && !change.is_test);
  const docPaths = new Set(changes.filter((change) => change.is_doc && change.type !== 'deleted').map((change) => change.path));
  for (const mod of modules) {
    const modCode = codeChanges.filter((change) => moduleForPath(change.path, root) === mod);
    if (!modCode.length) continue;
    const docs = relatedDocuments(root, mod, modCode);
    for (const doc of docs) {
      docStatus[doc] = docPaths.has(doc);
      docSync[doc] = { exists: true, updated: docPaths.has(doc) };
    }
    const total = modCode.reduce((sum, change) => sum + change.additions + change.deletions, 0);
    if (total <= 50 || docs.some((doc) => docPaths.has(doc))) continue;
    issues.push({
      severity: docs.length ? 'warning' : 'info',
      message: docs.length
        ? `模块 ${mod} 变更 ${total} 行，相关文档未更新，请确认说明是否需要调整`
        : `模块 ${mod} 变更 ${total} 行，未找到关联文档，请人工判断说明需求`,
      related_files: [...modCode.map((change) => change.path), ...docs],
    });
  }
  return { docStatus, docSync, issues };
}

function analyzeImpact(changes) {
  const issues = [];
  const code = changes.filter((c) => c.is_code && !c.is_test);
  const tests = changes.filter((c) => c.is_test);
  if (code.length && !tests.length) {
    const total = code.reduce((s, c) => s + c.additions + c.deletions, 0);
    if (total > 30) {
      issues.push({
        severity: 'warning',
        message: `代码变更 ${total} 行，但没有对应的测试更新`,
        related_files: code.map((c) => c.path),
      });
    }
  }
  const configs = changes.filter((c) => c.is_config);
  if (configs.length) {
    issues.push({
      severity: 'info',
      message: '配置文件有变更，请确认是否需要更新文档',
      related_files: configs.map((c) => c.path),
    });
  }
  const deleted = changes.filter((c) => c.type === 'deleted');
  if (deleted.length) {
    issues.push({
      severity: 'info',
      message: `删除了 ${deleted.length} 个文件，请确认相关引用已清理`,
      related_files: deleted.map((c) => c.path),
    });
  }
  return issues;
}

function analyzeChanges(mode, root, pathspecs) {
  let changes;
  if (mode === 'staged') changes = getStagedChanges(root, pathspecs);
  else if (mode === 'committed') changes = getGitChanges('HEAD~1', 'HEAD', root, pathspecs);
  else changes = getWorkingChanges(root, pathspecs);

  const issues = [];
  let modules = new Set(),
    docStatus = {},
    docSync = {};
  if (changes.length) {
    modules = identifyModules(changes, root);
    const ds = checkDocSync(changes, modules, root);
    docStatus = ds.docStatus;
    docSync = ds.docSync;
    issues.push(...ds.issues, ...analyzeImpact(changes));
  }
  const passed = !issues.some((i) => i.severity === 'error');
  const totalAdd = changes.reduce((s, c) => s + c.additions, 0);
  const totalDel = changes.reduce((s, c) => s + c.deletions, 0);
  return { changes, issues, modules, docStatus, docSync, passed, totalAdd, totalDel };
}

function formatReport(r, verbose) {
  const fields = {
    变更文件: r.changes.length,
    新增行数: `+${r.totalAdd}`,
    删除行数: `-${r.totalDel}`,
    受影响模块: [...r.modules].join(', ') || '无',
    分析结果: r.passed ? '✓ 通过' : '✗ 需要关注',
  };
  let report = buildReport('变更分析报告', fields, r.issues, verbose);

  if (r.changes.length && verbose) {
    const lines = ['\n' + DASH, '变更文件列表:', DASH];
    const icons = { added: '➕', modified: '📝', deleted: '➖', renamed: '📋' };
    for (const c of r.changes) {
      const tags = [];
      if (c.is_code) tags.push('代码');
      if (c.is_doc) tags.push('文档');
      if (c.is_test) tags.push('测试');
      if (c.is_config) tags.push('配置');
      const t = tags.length ? ` [${tags.join(', ')}]` : '';
      lines.push(`  ${icons[c.type] || '📝'} ${c.path}${t} (+${c.additions}/-${c.deletions})`);
    }
    report += '\n' + lines.join('\n');
  }

  if (verbose && Object.keys(r.docStatus).length) {
    const lines = ['\n' + DASH, '文档变更状态:', DASH];
    for (const [doc, updated] of Object.entries(r.docStatus)) {
      lines.push(`  ${updated ? '本次已修改' : '本次未修改'} ${doc}`);
    }
    report += '\n' + lines.join('\n');
  }

  return report;
}

// CLI
function main() {
  const opts = parseCliArgs(process.argv);
  if (opts.help) {
    console.log('Usage: change_analyzer.js [paths...] [--mode working|staged|committed] [-v] [--json]');
    return;
  }
  const mode = opts.mode || 'working';
  if (!['working', 'staged', 'committed'].includes(mode)) throw new Error('Unknown change mode: ' + mode);
  if (opts.exclude) throw new Error('verify-change uses target path scopes, not --exclude');
  const results = targetRepositories(opts.targets).map((group) => {
    const result = analyzeChanges(mode, group.root, group.pathspecs);
    for (const requested of group.requested) {
      if (fs.existsSync(requested)) continue;
      const relative = path.relative(group.root, requested).split(path.sep).join('/');
      const hasChange = result.changes.some((change) =>
        [change.path, change.old_path].some((name) => name && (name === relative || name.startsWith(relative + '/')))
      );
      if (!hasChange && !git(group.root, 'ls-files', '-z', '--', relative)) {
        throw new Error('Target does not exist in the repository or selected changes: ' + requested);
      }
    }
    return {
      repository_root: group.root,
      requested_paths: group.requested,
      complete: true,
      passed: result.passed,
      total_additions: result.totalAdd,
      total_deletions: result.totalDel,
      affected_modules: [...result.modules],
      changes: result.changes,
      issues: result.issues,
      doc_sync_status: result.docStatus,
      doc_sync: result.docSync,
      report: result,
    };
  });
  const passed = results.every((result) => result.passed);
  if (opts.json) {
    const clean = results.map(({ report, ...result }) => result);
    console.log(
      JSON.stringify(clean.length === 1 ? clean[0] : { passed, complete: true, repositories: clean }, null, 2)
    );
  } else {
    console.log(
      results
        .map((result) => 'Repository: ' + result.repository_root + '\n' + formatReport(result.report, opts.verbose))
        .join('\n\n')
    );
  }
  process.exitCode = passed ? 0 : 1;
}

if (require.main === module) runCli(main);

module.exports = {
  normalizePath,
  classifyFile,
  parsePorcelainLine,
  parseNameStatusLine,
  getGitChanges,
  getStagedChanges,
  getWorkingChanges,
  identifyModules,
};
