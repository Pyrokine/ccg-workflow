#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { parseCliArgs, runCli, buildReport, hasFatal } = require(path.join(__dirname, '..', '..', 'lib', 'shared.js'));

const REQUIRED_FILES = { 'README.md': '模块说明文档', 'DESIGN.md': '设计决策文档' };
const ALT_SRC_DIRS = ['src', 'lib', 'pkg', 'internal', 'cmd', 'app'];
const ALT_TEST_DIRS = ['tests', 'test', '__tests__', 'spec'];
const ROOT_SCRIPT_FILES = new Set([
  'install.sh',
  'uninstall.sh',
  'install.ps1',
  'uninstall.ps1',
  'Dockerfile',
  'Makefile',
]);
const CODE_EXTS = new Set(['.py', '.go', '.rs', '.ts', '.js', '.java', '.sh', '.ps1']);
const TEST_PATTERNS = ['test_', '_test.', '.test.', 'spec_', '_spec.'];

function scanStructure(p, depth = 3) {
  const s = { name: path.basename(p), type: 'dir', children: [] };
  if (depth <= 0) return s;
  for (const name of fs.readdirSync(p).sort()) {
    if (name.startsWith('.')) continue;
    const full = path.join(p, name);
    const stat = fs.lstatSync(full);
    if (stat.isFile()) s.children.push({ name, type: 'file', size: stat.size });
    else if (stat.isDirectory()) s.children.push(scanStructure(full, depth - 1));
  }
  return s;
}

function rglob(dir, test) {
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith('.') || name === 'node_modules') continue;
    const full = path.join(dir, name);
    const stat = fs.lstatSync(full);
    if (stat.isFile() && test(name)) return true;
    if (stat.isDirectory()) {
      if (rglob(full, test)) return true;
    }
  }
  return false;
}

function scanModule(target) {
  const modulePath = path.resolve(target);
  const issues = [];
  const add = (severity, message, p) => issues.push({ severity, message, path: p || null });

  if (!fs.existsSync(modulePath)) {
    add('error', `路径不存在: ${modulePath}`);
    return { modulePath, issues, structure: {} };
  }
  if (!fs.statSync(modulePath).isDirectory()) {
    add('error', `不是目录: ${modulePath}`);
    return { modulePath, issues, structure: {} };
  }

  const structure = scanStructure(modulePath);

  // required files
  for (const [file, desc] of Object.entries(REQUIRED_FILES)) {
    const fp = path.join(modulePath, file);
    if (!fs.existsSync(fp)) add('error', `缺少必需文档: ${file} (${desc})`, fp);
    else if (fs.statSync(fp).size < 50) add('warning', `文档内容过少: ${file} (< 50 bytes)`, fp);
  }

  // source dirs
  const entries = fs.readdirSync(modulePath);
  const stats = new Map(entries.map((name) => [name, fs.statSync(path.join(modulePath, name))]));
  let srcFound = ALT_SRC_DIRS.some((d) => stats.get(d)?.isDirectory());
  const rootCode = entries.filter((n) => stats.get(n).isFile() && CODE_EXTS.has(path.extname(n)));
  const rootScript = entries.filter((n) => stats.get(n).isFile() && ROOT_SCRIPT_FILES.has(n));
  if (rootCode.length || rootScript.length) {
    srcFound = true;
    if (rootCode.length > 5) {
      add('warning', `根目录代码文件过多 (${rootCode.length}个)，建议整理到 src/ 目录`);
    }
  }
  if (!srcFound) add('warning', '未找到源码目录或代码文件');

  // test dirs
  let testFound = ALT_TEST_DIRS.some((d) => stats.get(d)?.isDirectory());
  if (!testFound) testFound = rglob(modulePath, (n) => TEST_PATTERNS.some((p) => n.includes(p)));
  if (!testFound) add('warning', '未找到测试目录或测试文件');

  // doc quality
  const readme = path.join(modulePath, 'README.md');
  if (fs.existsSync(readme)) {
    const c = fs.readFileSync(readme, 'utf-8');
    if (!c.includes('#')) add('warning', 'README.md 缺少标题', readme);
    const docKeys = ['usage', 'install', '使用', '安装', 'example', '示例'];
    if (!docKeys.some((k) => c.toLowerCase().includes(k))) add('info', 'README.md 建议添加使用说明或示例', readme);
  }
  const design = path.join(modulePath, 'DESIGN.md');
  if (fs.existsSync(design)) {
    const c = fs.readFileSync(design, 'utf-8');
    const designKeys = ['决策', 'decision', '选择', 'choice', '权衡', 'trade'];
    if (!designKeys.some((k) => c.toLowerCase().includes(k))) add('info', 'DESIGN.md 建议记录设计决策和权衡', design);
  }

  return { modulePath, issues, structure };
}

function formatStructure(s, indent = 0) {
  const pre = '  '.repeat(indent);
  if (s.type === 'dir') {
    const lines = [`${pre}\u{1F4C1} ${s.name}/`];
    for (const ch of s.children || []) lines.push(formatStructure(ch, indent + 1));
    return lines.join('\n');
  }
  const sz = (s.size || 0) < 1024 ? `(${s.size} B)` : `(${Math.floor(s.size / 1024)} KB)`;
  return `${pre}\u{1F4C4} ${s.name} ${sz}`;
}

function formatReport(r, verbose) {
  const errs = r.issues.filter((i) => i.severity === 'error').length;
  const warns = r.issues.filter((i) => i.severity === 'warning').length;
  const passed = !hasFatal(r.issues);
  const fields = {
    模块路径: r.modulePath,
    扫描结果: passed ? '\u2713 通过' : '\u2717 未通过',
    统计: `错误: ${errs} | 警告: ${warns}`,
  };
  const issues = r.issues.map((i) => ({
    severity: i.severity,
    message: i.message,
    path: i.path,
    file_path: i.path || '',
    line_number: null,
  }));
  let report = buildReport('模块完整性扫描报告', fields, issues, verbose);
  if (verbose && r.structure.name) {
    report += '\n' + '-'.repeat(40) + '\n目录结构:\n' + '-'.repeat(40) + '\n' + formatStructure(r.structure);
  }
  return report;
}

// CLI
function main() {
  const opts = parseCliArgs(process.argv);
  if (opts.help) {
    console.log('Usage: module_scanner.js [directories...] [-v] [--json]');
    return;
  }
  if (opts.mode || opts.exclude) throw new Error('verify-module supports paths, --verbose, --json and --help');
  const results = opts.targets.map((target) => {
    if (!fs.statSync(target).isDirectory()) throw new Error('Target is not a directory: ' + target);
    const result = scanModule(target);
    return {
      module_path: result.modulePath,
      passed: !hasFatal(result.issues),
      complete: true,
      error_count: result.issues.filter((issue) => issue.severity === 'error').length,
      warning_count: result.issues.filter((issue) => issue.severity === 'warning').length,
      issues: result.issues,
      report: result,
    };
  });
  const passed = results.every((result) => result.passed);
  if (opts.json) {
    const clean = results.map(({ report, ...result }) => result);
    console.log(JSON.stringify(clean.length === 1 ? clean[0] : { passed, complete: true, results: clean }, null, 2));
  } else {
    console.log(results.map((result) => formatReport(result.report, opts.verbose)).join('\n\n'));
  }
  process.exitCode = passed ? 0 : 1;
}

if (require.main === module) runCli(main);
