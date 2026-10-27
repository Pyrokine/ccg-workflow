'use strict';

const fs = require('fs');
const path = require('path');

/**
 * 验证工具共享库
 * 消灭 verify-* 脚本间的重复代码
 */

// --- CLI 参数解析 ---

function parseCliArgs(argv, extraFlags) {
  const args = argv.slice(2);
  const result = { target: '.', targets: [], verbose: false, json: false, ...(extraFlags || {}) };
  let positional = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (positional) result.targets.push(arg);
    else if (arg === '--') positional = true;
    else if (arg === '-v' || arg === '--verbose') result.verbose = true;
    else if (arg === '--json') result.json = true;
    else if (arg === '-h' || arg === '--help') result.help = true;
    else if (arg === '--language-checks' && Object.hasOwn(result, 'languageChecks')) result.languageChecks = true;
    else if ((arg === '--base' || arg.startsWith('--base=')) && Object.hasOwn(result, 'base')) {
      const value = arg === '--base' ? args[++i] : arg.slice(7);
      if (!value || value.startsWith('-')) throw new Error('--base requires a revision');
      if (result.base !== undefined) throw new Error('--base may only be supplied once');
      result.base = value;
    }
    else if (arg === '--mode' || arg.startsWith('--mode=')) {
      const value = arg === '--mode' ? args[++i] : arg.slice(7);
      if (!value || value.startsWith('-')) throw new Error('--mode requires a value');
      if (result.mode !== undefined) throw new Error('--mode may only be supplied once');
      result.mode = value;
    } else if (arg === '--exclude' || arg.startsWith('--exclude=')) {
      const values = arg === '--exclude' ? [] : [arg.slice(10)];
      if (arg === '--exclude') {
        while (i + 1 < args.length && !args[i + 1].startsWith('-')) values.push(args[++i]);
      }
      if (values.length === 0 || values.some((value) => !value)) throw new Error('--exclude requires a value');
      result.exclude = [...(result.exclude || []), ...values];
    } else if (arg.startsWith('-')) throw new Error(`Unknown argument: ${arg}`);
    else result.targets.push(arg);
  }
  if (result.targets.length === 0) result.targets.push(result.target);
  result.targets = [...new Set(result.targets.map((target) => path.resolve(target)))];
  result.target = result.targets[0];
  return result;
}

function runCli(main) {
  try {
    main();
  } catch (error) {
    const result = { passed: false, complete: false, error: error.message || String(error) };
    if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
    else console.error(result.error);
    process.exitCode = 2;
  }
}

// 目录中的非源码文件不计入分析范围，显式请求的未支持文件必须报告
const SOURCE_EXTENSIONS = new Set([
  '.py',
  '.pyi',
  '.js',
  '.mjs',
  '.cjs',
  '.jsx',
  '.ts',
  '.mts',
  '.cts',
  '.tsx',
  '.go',
  '.java',
  '.kt',
  '.kts',
  '.rs',
  '.c',
  '.cc',
  '.cpp',
  '.cxx',
  '.h',
  '.hh',
  '.hpp',
  '.hxx',
  '.php',
  '.rb',
  '.sh',
  '.bash',
  '.ps1',
  '.cs',
  '.swift',
]);

function collectSourceFiles(targets, extensions, excludes) {
  const files = [];
  const errors = [];
  const seen = new Set();
  const excluded = new Set(excludes);
  const requested = [...new Set(targets.map((target) => path.resolve(target)))];
  const coverage = [];
  const addError = (target, code, message) => errors.push({ path: target, code, message });
  function visit(target, explicit, count) {
    let stat;
    try {
      stat = explicit ? fs.statSync(target) : fs.lstatSync(target);
    } catch (error) {
      addError(target, error.code || 'STAT_FAILED', error.message);
      return;
    }
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      let entries;
      try {
        entries = fs.readdirSync(target, { withFileTypes: true });
      } catch (error) {
        addError(target, error.code || 'READ_DIRECTORY_FAILED', error.message);
        return;
      }
      for (const entry of entries) {
        if (!excluded.has(entry.name)) visit(path.join(target, entry.name), false, count);
      }
      return;
    }
    if (!stat.isFile()) {
      if (explicit) addError(target, 'UNSUPPORTED_PATH', 'Target is not a regular file or directory');
      return;
    }
    const ext = path.extname(target).toLowerCase();
    if (!extensions.has(ext)) {
      if (explicit || SOURCE_EXTENSIONS.has(ext)) {
        addError(target, 'UNSUPPORTED_TYPE', `No analyzer supports ${ext || 'this file type'}`);
      }
      return;
    }
    count.value++;
    let canonical;
    try {
      canonical = fs.realpathSync(target);
    } catch (error) {
      addError(target, error.code || 'REALPATH_FAILED', error.message);
      return;
    }
    if (!seen.has(canonical)) {
      seen.add(canonical);
      files.push(target);
    }
  }
  for (const target of requested) {
    const count = { value: 0 };
    const before = errors.length;
    visit(target, true, count);
    coverage.push({ path: target, eligible_files: count.value });
    if (count.value === 0 && errors.length === before) {
      addError(target, 'NO_SUPPORTED_FILES', 'No supported source files were found');
    }
  }
  return { files, errors, coverage, requested_paths: requested };
}

// --- 报告格式化 ---

const SEP = '='.repeat(60);
const DASH = '-'.repeat(40);
const ICONS = {
  error: '\u2717',
  warning: '\u26A0',
  info: '\u2139',
  critical: '\u{1F534}',
  high: '\u{1F7E0}',
  medium: '\u{1F7E1}',
  low: '\u{1F535}',
};

function reportHeader(title, fields) {
  const lines = [SEP, title, SEP];
  for (const [k, v] of Object.entries(fields)) {
    lines.push(`\n${k}: ${v}`);
  }
  return lines;
}

function reportIssues(issues, verbose, groupBy) {
  if (!issues.length) return [];
  if (issues.some((issue) => issue.origin)) {
    const lines = [];
    for (const [origin, label] of [['new', '新增问题'], ['unclassified', '来源未判定'], ['existing', '既有问题']]) {
      const selected = issues.filter((issue) => issue.origin === origin);
      if (!selected.length) continue;
      lines.push(`\n${label}: ${selected.length}`);
      if (origin === 'existing' && !verbose) {
        lines.push('  ' + Object.entries(countBySeverity(selected)).map(([level, count]) => `${level}: ${count}`).join(' | '));
        lines.push('  使用 -v 展开位置与说明');
      } else {
        lines.push(...reportIssues(selected.map(({ origin: _origin, ...issue }) => issue), verbose, groupBy));
      }
    }
    return lines;
  }
  const lines = ['\n' + DASH, '问题列表:', DASH];

  if (groupBy) {
    const groups = {};
    for (const i of issues) (groups[i[groupBy]] || (groups[i[groupBy]] = [])).push(i);
    for (const cat of Object.keys(groups).sort()) {
      const items = groups[cat];
      lines.push(`\n【${cat}】(${items.length} 个)`);
      for (const i of verbose ? items : items.slice(0, 10)) {
        lines.push(
          `  ${ICONS[i.severity] || '\u2139'} ` + `${i.file_path || ''}${i.line_number ? ':' + i.line_number : ''}`
        );
        lines.push(`    ${i.message}`);
        if (verbose && i.suggestion) lines.push(`    \u{1F4A1} ${i.suggestion}`);
        if (verbose && i.recommendation) lines.push(`    \u{1F4A1} ${i.recommendation}`);
      }
      if (!verbose && items.length > 10) lines.push(`  ... 及其他 ${items.length - 10} 个问题`);
    }
  } else {
    for (const i of issues) {
      const icon = ICONS[i.severity] || '\u2139';
      lines.push(`  ${icon} [${i.severity.toUpperCase()}] ${i.message}`);
      if (i.path && verbose) lines.push(`    路径: ${i.path}`);
    }
  }
  return lines;
}

function reportFooter() {
  return ['\n' + SEP];
}

function buildReport(title, fields, issues, verbose, groupBy) {
  return [...reportHeader(title, fields), ...reportIssues(issues, verbose, groupBy), ...reportFooter()].join('\n');
}

// --- 通用计数 ---

function countBySeverity(issues, field) {
  field = field || 'severity';
  const counts = {};
  for (const i of issues) counts[i[field]] = (counts[i[field]] || 0) + 1;
  return counts;
}

function hasFatal(issues, fatalLevels) {
  fatalLevels = fatalLevels || ['error'];
  return issues.some((i) => fatalLevels.includes(i.severity));
}

module.exports = {
  parseCliArgs,
  runCli,
  collectSourceFiles,
  buildReport,
  reportHeader,
  reportIssues,
  reportFooter,
  countBySeverity,
  hasFatal,
  SEP,
  DASH,
  ICONS,
};
