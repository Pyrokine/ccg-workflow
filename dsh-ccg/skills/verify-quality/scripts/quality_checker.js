#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { parseCliArgs, runCli, collectSourceFiles, buildReport, reportBaselines, hasFatal } = require(
  path.join(__dirname, '..', '..', 'lib', 'shared.js')
);

const { compareBaseline } = require(path.join(__dirname, '..', '..', 'lib', 'git-baseline.js'));

// 质量规则配置
const MAX_LINE_LENGTH = 120;
const MAX_FUNCTION_LENGTH = 50;
const MAX_FILE_LENGTH = 500;
const MAX_COMPLEXITY = 10;
const MAX_PARAMETERS = 5;
const MIN_FUNCTION_NAME_LENGTH = 2;

const EXCLUDE_DIRS = new Set([
  '.git',
  'node_modules',
  '__pycache__',
  '.venv',
  'venv',
  'dist',
  'build',
  'target',
  'vendor',
  'third_party',
  'third-party',
  '.tox',
]);
const CODE_EXTENSIONS = new Set([
  '.py',
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
  '.rs',
  '.c',
  '.cc',
  '.cpp',
  '.cxx',
  '.h',
  '.hh',
  '.hpp',
  '.hxx',
]);

const COMMENT_PREFIXES = {
  '.js': '//',
  '.ts': '//',
  '.go': '//',
  '.java': '//',
  '.c': '//',
  '.cpp': '//',
  '.rs': '//',
};

// --- Analysis ---

function sourceMetrics(filePath, lines) {
  return {
    path: filePath,
    lines: lines.length,
    code_lines: 0,
    comment_lines: 0,
    blank_lines: 0,
    functions: 0,
    classes: 0,
    max_complexity: 0,
    avg_function_length: 0,
  };
}

function metricIssues(filePath, metrics, lines) {
  const issues = [];
  for (const [index, line] of lines.entries()) {
    if (line.length > MAX_LINE_LENGTH)
      issues.push({
        severity: 'info',
        category: '格式',
        rule_id: 'LINE_LENGTH',
        message: '行过长 (' + line.length + ' > ' + MAX_LINE_LENGTH + ')',
        file_path: filePath,
        line_number: index + 1,
        suggestion: null,
      });
  }
  if (metrics.code_lines > MAX_FILE_LENGTH)
    issues.push({
      severity: 'warning',
      category: '复杂度',
      rule_id: 'FILE_LENGTH',
      message: '文件过长 (' + metrics.code_lines + ' 行代码 > ' + MAX_FILE_LENGTH + ')',
      file_path: filePath,
      suggestion: '考虑拆分为多个模块',
      line_number: null,
    });
  return issues;
}

function measurePythonLines(lines, metrics) {
  let inMultiline = false;
  for (const line of lines) {
    const stripped = line.trim();
    if (!stripped) metrics.blank_lines++;
    else if (stripped.startsWith('#')) metrics.comment_lines++;
    else if (/"""|'''/u.test(stripped)) {
      const double = (stripped.match(/"""/gu) || []).length;
      const single = (stripped.match(/'''/gu) || []).length;
      if (double !== 2 && single !== 2) inMultiline = !inMultiline;
      metrics.comment_lines++;
    } else if (inMultiline) metrics.comment_lines++;
    else metrics.code_lines++;
  }
}

function pythonFunctionLength(funcLines, indent) {
  // Calculate function length by finding next line at same or lesser indent
  let length = 1;
  for (let index = 1; index < funcLines.length; index++) {
    const line = funcLines[index];
    if (line.trim() === '') {
      length++;
      continue;
    }
    const currentIndent = line.match(/^(\s*)/u)[1].length;
    if (currentIndent <= indent && line.trim() !== '') break;
    length++;
  }
  return length;
}

function pythonComplexity(lines) {
  // Estimate complexity from function body
  let complexity = 1;
  for (const line of lines) {
    const text = line.trim();
    if (/^(if|elif|while|for)(?:\s|\()/u.test(text)) complexity++;
    if (/^except(\s|:)/u.test(text)) complexity++;
    if (/\s(and|or)\s/u.test(text)) complexity++;
    if (/\sfor\s/u.test(text) && /\sin\s/u.test(text) && (text.includes('[') || text.includes('('))) complexity++;
  }
  return complexity;
}

function pythonFunction(match, content, lines) {
  const line = content.substring(0, match.index).split('\n').length;
  const params = match[3].trim()
    ? match[3]
        .split(',')
        .map((value) => value.trim())
        .filter((value) => value && value !== 'self' && value !== 'cls')
    : [];
  const length = pythonFunctionLength(lines.slice(line), match[1].length); // lines after def
  return {
    name: match[2],
    line,
    length,
    complexity: pythonComplexity(lines.slice(line, line + length - 1)),
    parameters: params.length,
  };
}

function pythonFunctionIssues(filePath, fn) {
  const { name, line, length, complexity, parameters } = fn;
  const issues = [];
  // Check function length
  if (length > MAX_FUNCTION_LENGTH)
    issues.push({
      severity: 'warning',
      category: '复杂度',
      rule_id: 'FUNCTION_LENGTH',
      message: "函数 '" + name + "' 过长 (" + length + ' 行 > ' + MAX_FUNCTION_LENGTH + ')',
      file_path: filePath,
      line_number: line,
      suggestion: '考虑拆分为多个小函数',
    });
  // Check complexity
  if (complexity > MAX_COMPLEXITY)
    issues.push({
      severity: 'warning',
      category: '复杂度',
      rule_id: 'FUNCTION_COMPLEXITY',
      message: "函数 '" + name + "' 圈复杂度估算过高 (" + complexity + ' > ' + MAX_COMPLEXITY + ')',
      file_path: filePath,
      line_number: line,
      suggestion: '减少嵌套层级，提取子函数',
    });
  // Check parameter count
  if (parameters > MAX_PARAMETERS)
    issues.push({
      severity: 'warning',
      category: '设计',
      rule_id: 'FUNCTION_PARAMETERS',
      message: "函数 '" + name + "' 参数过多 (" + parameters + ' > ' + MAX_PARAMETERS + ')',
      file_path: filePath,
      line_number: line,
      suggestion: '考虑使用配置对象或数据类封装参数',
    });
  return issues;
}

function pythonNamingIssues(filePath, fn) {
  // Check naming
  const { name, line } = fn;
  const special = new Set(['setUp', 'tearDown', 'setUpClass', 'tearDownClass', 'setUpModule', 'tearDownModule']);
  const issues = [];
  const exempt = name.startsWith('_') || special.has(name) || name.startsWith('visit_');
  if (!exempt && !/^[a-z][a-z0-9_]*$/u.test(name))
    issues.push({
      severity: 'info',
      category: '命名',
      rule_id: 'FUNCTION_NAME_STYLE',
      message: "函数名 '" + name + "' 不符合 snake_case 规范",
      file_path: filePath,
      line_number: line,
      suggestion: '函数名应使用 snake_case',
    });
  if (name.length < MIN_FUNCTION_NAME_LENGTH)
    issues.push({
      severity: 'warning',
      category: '命名',
      rule_id: 'FUNCTION_NAME_LENGTH',
      message: "函数名 '" + name + "' 过短",
      file_path: filePath,
      line_number: line,
      suggestion: '使用更具描述性的函数名',
    });
  return issues;
}

function pythonClasses(filePath, content) {
  const classes = [...content.matchAll(/^( *)class\s+(\w+)/gm)];
  const issues = [];
  for (const match of classes) {
    if (!/^[A-Z][a-zA-Z0-9]*$/u.test(match[2]))
      issues.push({
        severity: 'warning',
        category: '命名',
        rule_id: 'CLASS_NAME_STYLE',
        message: "类名 '" + match[2] + "' 不符合 PascalCase 规范",
        file_path: filePath,
        line_number: content.substring(0, match.index).split('\n').length,
        suggestion: '类名应使用 PascalCase，如 MyClassName',
      });
  }
  return { count: classes.length, issues };
}

function scanSelectedFiles(files, result) {
  const contents = new Map();
  for (const file of files) {
    try {
      const content = fs.readFileSync(file, 'utf8');
      const { metrics, issues } = analyzeFile(file, content);
      contents.set(file, content);
      result.files_scanned++;
      result.file_metrics.push(metrics);
      result.issues.push(...issues);
      result.total_lines += metrics.lines;
      result.total_code_lines += metrics.code_lines;
    } catch (error) {
      result.scan_errors.push({ path: file, code: error.code || 'READ_FAILED', message: error.message });
    }
  }
  return contents;
}

function analyzeLanguages(files, result, targetVersion) {
  const { runLanguageChecks } = require(path.join(__dirname, '..', '..', 'lib', 'language-checks.js'));
  const language = runLanguageChecks(
    files,
    { maxComplexity: MAX_COMPLEXITY, maxFunctionLength: MAX_FUNCTION_LENGTH, maxParameters: MAX_PARAMETERS },
    targetVersion
  );
  result.checks = language.checks;
  result.uncovered = language.uncovered;
  result.issues.push(...language.issues);
}

function languageComplete(result) {
  return (
    result.checks.length > 0 &&
    result.uncovered.length === 0 &&
    result.checks.every((check) => ['passed', 'failed'].includes(check.status))
  );
}

function analyzeGenericFile(filePath, content = fs.readFileSync(filePath, 'utf-8')) {
  const lines = content.split('\n');
  const metrics = sourceMetrics(filePath, lines);
  const prefix = COMMENT_PREFIXES[path.extname(filePath).toLowerCase()] || '//';
  for (const line of lines) {
    const stripped = line.trim();
    if (!stripped) metrics.blank_lines++;
    else if (stripped.startsWith(prefix) || stripped.startsWith('/*') || stripped.startsWith('*'))
      metrics.comment_lines++;
    else metrics.code_lines++;
  }
  return { metrics, issues: metricIssues(filePath, metrics, lines) };
}

function analyzePythonFile(filePath, content = fs.readFileSync(filePath, 'utf-8')) {
  const lines = content.split('\n');
  const metrics = sourceMetrics(filePath, lines);
  measurePythonLines(lines, metrics);
  const issues = metricIssues(filePath, metrics, lines);
  // Regex-based Python analysis (no AST available in Node)
  const functions = [...content.matchAll(/^( *)(?:async\s+)?def\s+(\w+)\s*\(([^)]*)\)/gm)].map((match) =>
    pythonFunction(match, content, lines)
  );
  for (const fn of functions) {
    metrics.max_complexity = Math.max(metrics.max_complexity, fn.complexity);
    issues.push(...pythonFunctionIssues(filePath, fn), ...pythonNamingIssues(filePath, fn));
  }
  const classes = pythonClasses(filePath, content);
  metrics.classes = classes.count;
  issues.push(...classes.issues);
  metrics.functions = functions.length;
  if (functions.length)
    metrics.avg_function_length = functions.reduce((sum, fn) => sum + fn.length, 0) / functions.length;
  return { metrics, issues };
}

// --- Directory scan ---

function analyzeFile(file, content) {
  return path.extname(file).toLowerCase() === '.py'
    ? analyzePythonFile(file, content)
    : analyzeGenericFile(file, content);
}

function scanDirectory(targets, excludeDirs, options = {}) {
  const selected = collectSourceFiles(targets, CODE_EXTENSIONS, excludeDirs);
  const result = {
    scan_path: selected.requested_paths.join(', '),
    requested_paths: selected.requested_paths,
    coverage: selected.coverage,
    scan_errors: selected.errors,
    analysis_mode: options.languageChecks ? 'language' : 'text',
    checks: [],
    uncovered: [],
    complete: false,
    files_scanned: 0,
    total_lines: 0,
    total_code_lines: 0,
    issues: [],
    file_metrics: [],
  };
  const contents = scanSelectedFiles(selected.files, result);
  const files = [...contents.keys()];
  if (options.languageChecks && files.length) analyzeLanguages(files, result, options.targetVersion);
  const compared = compareBaseline(
    files,
    result.issues,
    (file, content) => analyzeFile(file, content).issues,
    options.base,
    contents
  );
  result.baseline = compared.baseline;
  result.origin_counts = compared.origin_counts;
  result.scan_errors.push(...compared.errors);
  result.complete =
    result.files_scanned > 0 &&
    result.scan_errors.length === 0 &&
    (!options.languageChecks || languageComplete(result));
  return result;
}

// --- Reporting ---

function passed(result) {
  return result.complete && !hasFatal(result.issues) && !result.checks.some((check) => check.status === 'failed');
}

function reportUncovered(result) {
  const groups = new Map();
  for (const entry of result.uncovered) {
    const check = result.checks.find(
      (item) => item.skipped_files.includes(entry.path) && entry.reason.startsWith(item.tool + ':')
    );
    const root = check?.project_root || path.dirname(entry.path);
    const label = `${root}: ${entry.reason}`;
    groups.set(label, (groups.get(label) || 0) + 1);
  }
  return [...groups].map(([label, count]) => `${label} (${count} 个文件)`).join('\n') || '无';
}

function formatReport(result, verbose) {
  const errs = result.issues.filter((i) => i.severity === 'error').length;
  const warns = result.issues.filter((i) => i.severity === 'warning').length;
  const fields = {
    扫描路径: result.scan_path,
    扫描文件: result.files_scanned,
    检查范围: result.analysis_mode === 'language' ? '文本规则与语言工具' : '文本规则（未请求语言检查）',
    语言工具:
      [
        ...new Set(
          result.checks.map(
            (check) =>
              `${check.tool} (${check.project_root}): ${check.status}` +
              (check.reason && check.status !== 'unavailable' ? ' (' + check.reason + ')' : '')
          )
        ),
      ].join('\n') || '未执行',
    语言未覆盖: reportUncovered(result),
    比较基线: reportBaselines(result.baseline, result.requested_paths),
    分析完整性: result.complete ? '完整' : '未完成',
    未分析: result.scan_errors.map((error) => error.path + ': ' + error.message).join('\n') || '无',
    总行数: result.total_lines,
    代码行数: result.total_code_lines,
    检查结果: passed(result) ? '✓ 通过' : '✗ 需要关注',
    统计: `错误: ${errs} | 警告: ${warns}`,
  };
  let report = buildReport('代码质量检查报告', fields, result.issues, verbose, 'category');

  if (verbose && result.file_metrics.length) {
    const complex = result.file_metrics
      .filter((m) => m.max_complexity > 0)
      .sort((a, b) => b.max_complexity - a.max_complexity)
      .slice(0, 5);
    if (complex.length) {
      const lines = ['\n' + '-'.repeat(40), 'Python 启发式复杂度估算:', '-'.repeat(40)];
      for (const m of complex) lines.push(`  ${m.path}: 复杂度 ${m.max_complexity}, ${m.functions} 个函数`);
      report += '\n' + lines.join('\n');
    }
  }
  return report;
}

// --- CLI ---

function main() {
  const opts = parseCliArgs(process.argv, { languageChecks: false, base: undefined, targetVersion: undefined });
  if (opts.help) {
    console.log(
      'Usage: quality_checker.js [paths...] [--language-checks] [--target-version py38] ' +
        '[--base ref] [-v] [--json] [--exclude dirs...]'
    );
    return;
  }
  if (opts.mode) throw new Error('--mode is only supported by verify-change');
  const result = scanDirectory(opts.targets, new Set([...EXCLUDE_DIRS, ...(opts.exclude || [])]), opts);

  if (opts.json) {
    const output = {
      scan_path: result.scan_path,
      requested_paths: result.requested_paths,
      coverage: result.coverage,
      scan_errors: result.scan_errors,
      complete: result.complete,
      files_scanned: result.files_scanned,
      total_lines: result.total_lines,
      total_code_lines: result.total_code_lines,
      analysis_mode: result.analysis_mode,
      checks: result.checks,
      uncovered: result.uncovered,
      baseline: result.baseline,
      origin_counts: result.origin_counts,
      passed: passed(result),
      error_count: result.issues.filter((i) => i.severity === 'error').length,
      warning_count: result.issues.filter((i) => i.severity === 'warning').length,
      issues: result.issues,
    };
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log(formatReport(result, opts.verbose));
  }

  process.exitCode = !result.complete ? 2 : passed(result) ? 0 : 1;
}

if (require.main === module) runCli(main);
