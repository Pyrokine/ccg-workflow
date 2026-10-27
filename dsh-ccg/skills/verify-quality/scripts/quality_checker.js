#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { parseCliArgs, runCli, collectSourceFiles, buildReport, hasFatal } = require(
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

const EXCLUDE_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv', 'dist', 'build', '.tox']);
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

function analyzeGenericFile(filePath, content = fs.readFileSync(filePath, 'utf-8')) {
  const metrics = {
    path: filePath,
    lines: 0,
    code_lines: 0,
    comment_lines: 0,
    blank_lines: 0,
    functions: 0,
    classes: 0,
    max_complexity: 0,
    avg_function_length: 0,
  };
  const issues = [];

  const lines = content.split('\n');
  metrics.lines = lines.length;
  const prefix = COMMENT_PREFIXES[path.extname(filePath).toLowerCase()] || '//';

  for (let i = 0; i < lines.length; i++) {
    const stripped = lines[i].trim();
    if (!stripped) metrics.blank_lines++;
    else if (stripped.startsWith(prefix) || stripped.startsWith('/*') || stripped.startsWith('*'))
      metrics.comment_lines++;
    else metrics.code_lines++;

    if (lines[i].length > MAX_LINE_LENGTH) {
      issues.push({
        severity: 'info',
        category: '格式',
        rule_id: 'LINE_LENGTH',
        message: `行过长 (${lines[i].length} > ${MAX_LINE_LENGTH})`,
        file_path: filePath,
        line_number: i + 1,
        suggestion: null,
      });
    }
  }

  if (metrics.code_lines > MAX_FILE_LENGTH) {
    issues.push({
      severity: 'warning',
      category: '复杂度',
      rule_id: 'FILE_LENGTH',
      message: `文件过长 (${metrics.code_lines} 行代码 > ${MAX_FILE_LENGTH})`,
      file_path: filePath,
      suggestion: '考虑拆分为多个模块',
      line_number: null,
    });
  }

  return { metrics, issues };
}

function analyzePythonFile(filePath, content = fs.readFileSync(filePath, 'utf-8')) {
  const metrics = {
    path: filePath,
    lines: 0,
    code_lines: 0,
    comment_lines: 0,
    blank_lines: 0,
    functions: 0,
    classes: 0,
    max_complexity: 0,
    avg_function_length: 0,
  };
  const issues = [];

  const lines = content.split('\n');
  metrics.lines = lines.length;
  let inMultiline = false;

  for (let i = 0; i < lines.length; i++) {
    const stripped = lines[i].trim();
    if (!stripped) {
      metrics.blank_lines++;
    } else if (stripped.startsWith('#')) {
      metrics.comment_lines++;
    } else if (stripped.includes('"""') || stripped.includes("'''")) {
      const dq = (stripped.match(/"""/g) || []).length;
      const sq = (stripped.match(/'''/g) || []).length;
      if (dq === 2 || sq === 2) {
        metrics.comment_lines++;
      } else {
        inMultiline = !inMultiline;
        metrics.comment_lines++;
      }
    } else if (inMultiline) {
      metrics.comment_lines++;
    } else {
      metrics.code_lines++;
    }

    if (lines[i].length > MAX_LINE_LENGTH) {
      issues.push({
        severity: 'info',
        category: '格式',
        rule_id: 'LINE_LENGTH',
        message: `行过长 (${lines[i].length} > ${MAX_LINE_LENGTH})`,
        file_path: filePath,
        line_number: i + 1,
        suggestion: null,
      });
    }
  }

  if (metrics.code_lines > MAX_FILE_LENGTH) {
    issues.push({
      severity: 'warning',
      category: '复杂度',
      rule_id: 'FILE_LENGTH',
      message: `文件过长 (${metrics.code_lines} 行代码 > ${MAX_FILE_LENGTH})`,
      file_path: filePath,
      suggestion: '考虑拆分为多个模块',
      line_number: null,
    });
  }

  // Regex-based Python analysis (no AST available in Node)
  const funcRegex = /^( *)(?:async\s+)?def\s+(\w+)\s*\(([^)]*)\)/gm;
  const classRegex = /^( *)class\s+(\w+)/gm;
  const functions = [];
  let match;

  while ((match = funcRegex.exec(content)) !== null) {
    const lineNum = content.substring(0, match.index).split('\n').length;
    const name = match[2];
    const indent = match[1].length;
    const params = match[3].trim()
      ? match[3]
          .split(',')
          .map((p) => p.trim())
          .filter((p) => p && p !== 'self' && p !== 'cls')
      : [];

    // Calculate function length by finding next line at same or lesser indent
    const funcLines = lines.slice(lineNum); // lines after def
    let length = 1;
    for (let j = 1; j < funcLines.length; j++) {
      const l = funcLines[j];
      if (l.trim() === '') {
        length++;
        continue;
      }
      const curIndent = l.match(/^(\s*)/)[1].length;
      if (curIndent <= indent && l.trim() !== '') break;
      length++;
    }

    // Estimate complexity from function body
    const bodyLines = lines.slice(lineNum, lineNum + length - 1);
    let complexity = 1;
    for (const bl of bodyLines) {
      const s = bl.trim();
      if (/^(if|elif|while|for)\s/.test(s) || /^(if|elif|while|for)\(/.test(s)) complexity++;
      if (/^except(\s|:)/.test(s)) complexity++;
      if (/\s(and|or)\s/.test(s)) complexity++;
      if (/\sfor\s/.test(s) && /\sin\s/.test(s) && (s.includes('[') || s.includes('('))) complexity++;
    }

    functions.push({ name, line: lineNum, length, complexity, parameters: params.length });
    metrics.max_complexity = Math.max(metrics.max_complexity, complexity);

    // Check function length
    if (length > MAX_FUNCTION_LENGTH) {
      issues.push({
        severity: 'warning',
        category: '复杂度',
        rule_id: 'FUNCTION_LENGTH',
        message: `函数 '${name}' 过长 (${length} 行 > ${MAX_FUNCTION_LENGTH})`,
        file_path: filePath,
        line_number: lineNum,
        suggestion: '考虑拆分为多个小函数',
      });
    }
    // Check complexity
    if (complexity > MAX_COMPLEXITY) {
      issues.push({
        severity: 'warning',
        category: '复杂度',
        rule_id: 'FUNCTION_COMPLEXITY',
        message: `函数 '${name}' 圈复杂度估算过高 (${complexity} > ${MAX_COMPLEXITY})`,
        file_path: filePath,
        line_number: lineNum,
        suggestion: '减少嵌套层级，提取子函数',
      });
    }
    // Check parameter count
    if (params.length > MAX_PARAMETERS) {
      issues.push({
        severity: 'warning',
        category: '设计',
        rule_id: 'FUNCTION_PARAMETERS',
        message: `函数 '${name}' 参数过多 (${params.length} > ${MAX_PARAMETERS})`,
        file_path: filePath,
        line_number: lineNum,
        suggestion: '考虑使用配置对象或数据类封装参数',
      });
    }
    // Check naming
    const SPECIAL = new Set(['setUp', 'tearDown', 'setUpClass', 'tearDownClass', 'setUpModule', 'tearDownModule']);
    if (!name.startsWith('_') && !SPECIAL.has(name) && !name.startsWith('visit_')) {
      if (!/^[a-z][a-z0-9_]*$/.test(name)) {
        issues.push({
          severity: 'info',
          category: '命名',
          rule_id: 'FUNCTION_NAME_STYLE',
          message: `函数名 '${name}' 不符合 snake_case 规范`,
          file_path: filePath,
          line_number: lineNum,
          suggestion: '函数名应使用 snake_case',
        });
      }
    }
    if (name.length < MIN_FUNCTION_NAME_LENGTH) {
      issues.push({
        severity: 'warning',
        category: '命名',
        rule_id: 'FUNCTION_NAME_LENGTH',
        message: `函数名 '${name}' 过短`,
        file_path: filePath,
        line_number: lineNum,
        suggestion: '使用更具描述性的函数名',
      });
    }
  }

  while ((match = classRegex.exec(content)) !== null) {
    const lineNum = content.substring(0, match.index).split('\n').length;
    const name = match[2];
    metrics.classes++;
    if (!/^[A-Z][a-zA-Z0-9]*$/.test(name)) {
      issues.push({
        severity: 'warning',
        category: '命名',
        rule_id: 'CLASS_NAME_STYLE',
        message: `类名 '${name}' 不符合 PascalCase 规范`,
        file_path: filePath,
        line_number: lineNum,
        suggestion: '类名应使用 PascalCase，如 MyClassName',
      });
    }
  }

  metrics.functions = functions.length;
  if (functions.length > 0) {
    metrics.avg_function_length = functions.reduce((s, f) => s + f.length, 0) / functions.length;
  }

  return { metrics, issues };
}

// --- Directory scan ---

function analyzeFile(file, content) {
  return path.extname(file).toLowerCase() === '.py' ? analyzePythonFile(file, content) : analyzeGenericFile(file, content);
}

function scanDirectory(targets, excludeDirs, options = {}) {
  const selected = collectSourceFiles(targets, CODE_EXTENSIONS, excludeDirs);
  const contents = new Map();
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

  for (const full of selected.files) {
    try {
      const content = fs.readFileSync(full, 'utf8');
      const { metrics, issues } = analyzeFile(full, content);
      contents.set(full, content);
      result.files_scanned++;
      result.file_metrics.push(metrics);
      result.issues.push(...issues);
      result.total_lines += metrics.lines;
      result.total_code_lines += metrics.code_lines;
    } catch (error) {
      result.scan_errors.push({ path: full, code: error.code || 'READ_FAILED', message: error.message });
    }
  }
  const files = [...contents.keys()];
  if (options.languageChecks && files.length) {
    const { runLanguageChecks } = require(path.join(__dirname, '..', '..', 'lib', 'language-checks.js'));
    const language = runLanguageChecks(files, {
      maxComplexity: MAX_COMPLEXITY,
      maxFunctionLength: MAX_FUNCTION_LENGTH,
      maxParameters: MAX_PARAMETERS,
    });
    result.checks = language.checks;
    result.uncovered = language.uncovered;
    result.issues.push(...language.issues);
  }
  const compared = compareBaseline(files, result.issues, (file, content) => analyzeFile(file, content).issues, options.base, contents);
  result.baseline = compared.baseline;
  result.origin_counts = compared.origin_counts;
  result.scan_errors.push(...compared.errors);
  result.complete = result.files_scanned > 0 && result.scan_errors.length === 0 &&
    (!options.languageChecks || (result.checks.length > 0 && result.uncovered.length === 0 &&
      result.checks.every((check) => ['passed', 'failed'].includes(check.status))));
  return result;
}

// --- Reporting ---

function passed(result) {
  return result.complete && !hasFatal(result.issues) && !result.checks.some((check) => check.status === 'failed');
}

function formatReport(result, verbose) {
  const errs = result.issues.filter((i) => i.severity === 'error').length;
  const warns = result.issues.filter((i) => i.severity === 'warning').length;
  const fields = {
    扫描路径: result.scan_path,
    扫描文件: result.files_scanned,
    检查范围: result.analysis_mode === 'language' ? '文本规则与语言工具' : '文本规则（未请求语言检查）',
    语言工具: result.checks.map((check) => `${check.tool}: ${check.status}${check.reason ? ' (' + check.reason + ')' : ''}`).join('\n') || '未执行',
    语言未覆盖: result.uncovered.map((entry) => `${entry.path}: ${entry.reason}`).join('\n') || '无',
    比较基线: result.baseline.map((entry) => `${entry.ref}: ${entry.status}${entry.reason ? ' (' + entry.reason + ')' : ''}`).join('\n'),
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
  const opts = parseCliArgs(process.argv, { languageChecks: false, base: undefined });
  if (opts.help) {
    console.log('Usage: quality_checker.js [paths...] [--language-checks] [--base ref] [-v] [--json] [--exclude dirs...]');
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
