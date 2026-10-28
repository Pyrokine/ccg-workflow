'use strict';

const fs = require('fs');
const path = require('path');

/**
 * 验证工具共享库
 * 消灭 verify-* 脚本间的重复代码
 */

// --- CLI 参数解析 ---

function parseCliValue(result, args, index, name) {
  const fields = { '--base': 'base', '--mode': 'mode', '--target-version': 'targetVersion' };
  const field = fields[name];
  if (!field || (field !== 'mode' && !Object.hasOwn(result, field))) {
    throw new Error('Unknown argument: ' + args[index]);
  }
  const inline = args[index].includes('=');
  const value = inline ? args[index].slice(name.length + 1) : args[++index];
  const description = { base: 'a revision', mode: 'a value', targetVersion: 'a Ruff target version such as py38' }[
    field
  ];
  if (!value || value.startsWith('-')) throw new Error(name + ' requires ' + description);
  if (result[field] !== undefined) throw new Error(name + ' may only be supplied once');
  if (field === 'targetVersion' && !/^py3\d+$/u.test(value)) throw new Error(name + ' requires ' + description);
  result[field] = value;
  return index;
}

function parseExcludes(result, args, index) {
  const inline = args[index].startsWith('--exclude=');
  const values = inline ? [args[index].slice(10)] : [];
  if (!inline) {
    while (index + 1 < args.length && !args[index + 1].startsWith('-')) values.push(args[++index]);
  }
  if (!values.length || values.some((value) => !value)) throw new Error('--exclude requires a value');
  result.exclude = [...(result.exclude || []), ...values];
  return index;
}

function parseCliFlag(result, args, index) {
  const arg = args[index];
  const toggles = { '-v': 'verbose', '--verbose': 'verbose', '--json': 'json', '-h': 'help', '--help': 'help' };
  if (Object.hasOwn(toggles, arg)) {
    result[toggles[arg]] = true;
    return index;
  }
  if (arg === '--language-checks' && Object.hasOwn(result, 'languageChecks')) {
    result.languageChecks = true;
    return index;
  }
  const name = arg.split('=', 1)[0];
  return name === '--exclude' ? parseExcludes(result, args, index) : parseCliValue(result, args, index, name);
}

function sourceError(context, target, error, fallback) {
  context.errors.push({ path: target, code: error.code || fallback, message: error.message });
}

function visitDirectory(target, count, context) {
  let entries;
  try {
    entries = fs.readdirSync(target, { withFileTypes: true });
  } catch (error) {
    sourceError(context, target, error, 'READ_DIRECTORY_FAILED');
    return;
  }
  for (const entry of entries) {
    if (!context.excluded.has(entry.name)) visitSource(path.join(target, entry.name), false, count, context);
  }
}

function addSourceFile(target, explicit, count, context) {
  let ext;
  try {
    ext = sourceExtension(target);
  } catch (error) {
    sourceError(context, target, error, 'READ_FAILED');
    return;
  }
  if (!context.extensions.has(ext)) {
    if (explicit || SOURCE_EXTENSIONS.has(ext)) {
      context.errors.push({
        path: target,
        code: 'UNSUPPORTED_TYPE',
        message: 'No analyzer supports ' + (ext || 'this file type'),
      });
    }
    return;
  }
  count.value++;
  let canonical;
  try {
    canonical = fs.realpathSync(target);
  } catch (error) {
    sourceError(context, target, error, 'REALPATH_FAILED');
    return;
  }
  if (!context.seen.has(canonical)) {
    context.seen.add(canonical);
    context.files.push(target);
  }
}

function visitSource(target, explicit, count, context) {
  let stat;
  try {
    stat = explicit ? fs.statSync(target) : fs.lstatSync(target);
  } catch (error) {
    sourceError(context, target, error, 'STAT_FAILED');
    return;
  }
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) return visitDirectory(target, count, context);
  if (stat.isFile()) return addSourceFile(target, explicit, count, context);
  if (explicit) {
    context.errors.push({
      path: target,
      code: 'UNSUPPORTED_PATH',
      message: 'Target is not a regular file or directory',
    });
  }
}

function reportOriginIssues(issues, verbose, groupBy) {
  const lines = [];
  for (const [origin, label] of [
    ['new', '新增问题'],
    ['unclassified', '来源未判定'],
    ['existing', '既有问题'],
  ]) {
    const selected = issues.filter((issue) => issue.origin === origin);
    if (!selected.length) continue;
    lines.push('\n' + label + ': ' + selected.length);
    if (origin === 'existing' && !verbose) {
      lines.push(
        '  ' +
          Object.entries(countBySeverity(selected))
            .map(([level, count]) => level + ': ' + count)
            .join(' | ')
      );
      lines.push('  使用 -v 展开位置与说明');
    } else {
      lines.push(
        ...reportIssues(
          selected.map(({ origin: _origin, ...entry }) => entry),
          verbose,
          groupBy
        )
      );
    }
  }
  return lines;
}

function reportIssueLines(entry, verbose) {
  const icon = ICONS[entry.severity] || '\u2139';
  const position = (entry.file_path || '') + (entry.line_number ? ':' + entry.line_number : '');
  const lines = ['  ' + icon + ' ' + position, '    ' + entry.message];
  if (entry.context) lines.push('    上下文: ' + entry.context + '，需复核实际用途');
  if (verbose && entry.suggestion) lines.push('    \u{1F4A1} ' + entry.suggestion);
  if (verbose && entry.recommendation) lines.push('    \u{1F4A1} ' + entry.recommendation);
  return lines;
}

function reportIssueGroups(issues, verbose, groupBy) {
  const groups = {};
  for (const entry of issues) (groups[entry[groupBy]] || (groups[entry[groupBy]] = [])).push(entry);
  const lines = [];
  for (const category of Object.keys(groups).sort()) {
    const items = groups[category];
    lines.push('\n【' + category + '】(' + items.length + ' 个)');
    for (const entry of verbose ? items : items.slice(0, 10)) lines.push(...reportIssueLines(entry, verbose));
    if (!verbose && items.length > 10) lines.push('  ... 及其他 ' + (items.length - 10) + ' 个问题');
  }
  return lines;
}

function parseCliArgs(argv, extraFlags) {
  const args = argv.slice(2);
  const result = { target: '.', targets: [], verbose: false, json: false, ...(extraFlags || {}) };
  let positional = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (positional) result.targets.push(arg);
    else if (arg === '--') positional = true;
    else if (!arg.startsWith('-')) result.targets.push(arg);
    else index = parseCliFlag(result, args, index);
  }
  if (!result.targets.length) result.targets.push(result.target);
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

function sourceExtension(filePath, content) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext) return ext;
  if (content === undefined) {
    const fd = fs.openSync(filePath, 'r');
    try {
      const buffer = Buffer.alloc(256);
      content = buffer.subarray(0, fs.readSync(fd, buffer, 0, buffer.length, 0)).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  }
  const shebang = content.split('\n', 1)[0];
  return /^#!\s*\/(?:\S*\/)?(?:env\s+(?:-S\s+)?(?:sh|bash|dash|ksh|zsh)|(?:sh|bash|dash|ksh|zsh))(?:\s|$)/.test(shebang)
    ? '.sh'
    : '';
}

function collectSourceFiles(targets, extensions, excludes) {
  const context = { files: [], errors: [], seen: new Set(), excluded: new Set(excludes), extensions };
  const requested = [...new Set(targets.map((target) => path.resolve(target)))];
  const coverage = [];
  for (const target of requested) {
    const count = { value: 0 };
    const before = context.errors.length;
    visitSource(target, true, count, context);
    coverage.push({ path: target, eligible_files: count.value });
    if (!count.value && context.errors.length === before) {
      context.errors.push({
        path: target,
        code: 'NO_SUPPORTED_FILES',
        message: 'No supported source files were found',
      });
    }
  }
  return { files: context.files, errors: context.errors, coverage, requested_paths: requested };
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
  if (issues.some((issue) => issue.origin)) return reportOriginIssues(issues, verbose, groupBy);
  const lines = ['\n' + DASH, '问题列表:', DASH];
  if (groupBy) return [...lines, ...reportIssueGroups(issues, verbose, groupBy)];
  for (const entry of issues) {
    const icon = ICONS[entry.severity] || '\u2139';
    lines.push('  ' + icon + ' [' + entry.severity.toUpperCase() + '] ' + entry.message);
    if (entry.path && verbose) lines.push('    路径: ' + entry.path);
  }
  return lines;
}

function reportBaselines(entries, targets) {
  return [
    ...new Set(
      entries.map((entry) => {
        const requestedRoot =
          !entry.repository_root &&
          targets.find((target) => {
            const relative = path.relative(target, entry.path);
            return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
          });
        const root = entry.repository_root || requestedRoot || path.dirname(entry.path);
        return `${root}: ${entry.ref}: ${entry.status}${entry.reason ? ' (' + entry.reason + ')' : ''}`;
      })
    ),
  ].join('\n');
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
  sourceExtension,
  buildReport,
  reportHeader,
  reportIssues,
  reportBaselines,
  reportFooter,
  countBySeverity,
  hasFatal,
  SEP,
  DASH,
  ICONS,
};
