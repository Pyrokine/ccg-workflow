#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
const CPP_EXTENSIONS = ['.c', '.cc', '.cpp', '.cxx', '.h', '.hh', '.hpp', '.hxx'];

// prettier-ignore
const SECURITY_RULES = [
  {
    id: 'SQL_INJECTION_DYNAMIC', category: '注入',
    severity: 'critical',
    pattern: new RegExp(
      '\\b(execute|query|raw)\\s*\\(\\s*' +
      '(f["\']|["\'][^"\'\\n]*["\']\\s*\\+\\s*|["\'][^"\'\\n]*["\']\\s*%\\s*[^,)]|["\'][^"\'\\n]*["\']' +
      '\\.format\\s*\\()', 'i'),
    extensions: ['.py', '.js', '.ts', '.go', '.java', '.php'],
    message: '可能存在 SQL 注入风险',
    recommendation: '使用参数化查询或 ORM',
  },
  {
    id: 'SQL_INJECTION_FSTRING', category: '注入',
    severity: 'critical',
    pattern: /cursor\.(execute|executemany)\s*\(\s*f["']/i,
    extensions: ['.py'],
    message: '使用 f-string 构造 SQL 语句',
    recommendation: '使用参数化查询',
  },
  {
    id: 'COMMAND_INJECTION', category: '注入',
    severity: 'critical',
    pattern: /(os\.system|os\.popen|subprocess\.call|subprocess\.run|subprocess\.Popen)\s*\([^)]*shell\s*=\s*True/i,
    extensions: ['.py'],
    message: '使用 shell=True 可能导致命令注入',
    recommendation: '避免 shell=True，使用列表参数',
  },
  {
    id: 'COMMAND_INJECTION_EVAL', category: '注入',
    severity: 'critical',
    pattern: /\b(eval|exec)\s*\([^)]*\b(input|request|argv|args)/i,
    extensions: ['.py'],
    message: 'eval/exec 执行用户输入',
    recommendation: '避免对用户输入使用 eval/exec',
  },
  {
    id: 'HARDCODED_SECRET', category: '敏感信息',
    severity: 'high',
    pattern: new RegExp(
      String.raw`(?<!\w)(password|passwd|pwd|secret|api_key|apikey|token|auth_token)` +
      String.raw`\s*(?:\[\s*\d*\s*\])?\s*(?::\s*&?(?:str|String)\s*)?=\s*["'][^"']{8,}["']`, 'i'),
    excludePattern: /(example|placeholder|changeme|xxx|your[_-]|TODO|FIXME|<.*>|\*{3,})/i,
    extensions: [
      '.py', '.js', '.ts', '.go', '.java', '.php',
      '.rb', '.rs', '.sh', '.bash', '.yaml', '.yml', '.json', '.env', ...CPP_EXTENSIONS,
    ],
    message: '可能存在硬编码密钥/密码',
    recommendation: '使用环境变量或密钥管理服务',
  },
  {
    id: 'HARDCODED_AWS_KEY', category: '敏感信息',
    severity: 'critical',
    pattern: /AKIA[0-9A-Z]{16}/,
    extensions: ['*'],
    message: '发现 AWS Access Key',
    recommendation: '立即轮换密钥，使用 IAM 角色或环境变量',
  },
  {
    id: 'HARDCODED_PRIVATE_KEY', category: '敏感信息',
    severity: 'critical',
    pattern: /-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/,
    extensions: ['*'],
    message: '发现私钥',
    recommendation: '私钥不应提交到代码库',
  },
  {
    id: 'XSS_INNERHTML', category: 'XSS', severity: 'high',
    pattern: /\.innerHTML\s*=|\.outerHTML\s*=|document\.write\s*\(/i,
    extensions: ['.js', '.ts', '.jsx', '.tsx', '.html'],
    message: '直接操作 innerHTML 可能导致 XSS',
    recommendation: '使用 textContent 或框架的安全绑定',
  },
  {
    id: 'XSS_DANGEROUSLY', category: 'XSS',
    severity: 'medium',
    pattern: /dangerouslySetInnerHTML/i,
    extensions: ['.js', '.ts', '.jsx', '.tsx'],
    message: '使用 dangerouslySetInnerHTML',
    recommendation: '确保内容已经过净化处理',
  },
  {
    id: 'UNSAFE_PICKLE', category: '反序列化',
    severity: 'high',
    pattern: /pickle\.loads?\s*\(|yaml\.load\s*\([^)]*Loader\s*=\s*yaml\.Loader/i,
    extensions: ['.py'],
    message: '不安全的反序列化',
    recommendation: '使用 yaml.safe_load() 或验证数据来源',
  },
  {
    id: 'WEAK_CRYPTO_MD5', category: '加密',
    severity: 'medium',
    pattern: /\b(md5|MD5)\s*\(|hashlib\.md5\s*\(/i,
    extensions: ['.py', '.js', '.ts', '.go', '.java', '.php'],
    message: '使用弱哈希算法 MD5',
    recommendation: '使用 bcrypt/argon2 或 SHA-256+',
  },
  {
    id: 'WEAK_CRYPTO_SHA1', category: '加密',
    severity: 'low',
    pattern: /\b(sha1|SHA1)\s*\(|hashlib\.sha1\s*\(/i,
    extensions: ['.py', '.js', '.ts', '.go', '.java', '.php'],
    message: '使用弱哈希算法 SHA1',
    recommendation: '使用 SHA-256 或更强的算法',
  },
  {
    id: 'PATH_TRAVERSAL', category: '路径遍历',
    severity: 'high',
    pattern: new RegExp(
      '(open|read|write|os\\.path\\.join)\\s*\\([^\\n]*' +
      '(request|input|argv|args|params|query|form|path_param)\\b', 'i'),
    extensions: ['.py'],
    message: '可能存在路径遍历风险',
    recommendation: '验证并规范化用户输入的路径',
  },
  {
    id: 'PATHLIB_INPUT_IO', category: '路径遍历', severity: 'high',
    pattern: new RegExp(String.raw`\bPath\s*\([^\n]*(request|input|argv|args|params|query|form|path_param)\b` +
      String.raw`[^\n]*\)\s*\.(open|read_text|read_bytes|write_text|write_bytes|unlink|rmdir)\s*\(`, 'i'),
    extensions: ['.py'],
    message: '来自输入的 Path 被用于文件操作',
    recommendation: '验证并限制文件访问范围',
  },
  {
    id: 'SHELL_DYNAMIC_EXEC', category: '注入', severity: 'critical',
    pattern: /(?:^|[;|&]\s*|\s)(?:eval\s+[^\n]*\$|(?:sh|bash|dash|ksh|zsh)\s+-c\s+[^\n]*\$)/,
    extensions: ['.sh', '.bash'],
    message: 'Shell 将动态内容作为命令执行',
    recommendation: '使用固定程序和独立参数，验证动态输入',
  },
  {
    id: 'RUST_SHELL_COMMAND', category: '注入', severity: 'critical',
    pattern: /Command\s*::\s*new\s*\(\s*"(?:sh|bash|cmd(?:\.exe)?|powershell(?:\.exe)?)"\s*\)/,
    extensions: ['.rs'],
    message: 'Rust 通过命令解释器执行命令，需复核参数来源',
    recommendation: '直接调用目标程序并独立传递参数',
  },
  {
    id: 'C_DYNAMIC_COMMAND', category: '注入', severity: 'critical',
    pattern: /(?<![\w.])(?:system|_wsystem|popen|_popen)\s*\(\s*[^\s),]/,
    extensions: CPP_EXTENSIONS,
    codeOnly: true,
    message: '命令解释器调用包含动态表达式，需复核输入来源',
    recommendation: '直接调用固定程序并独立传递参数',
  },
  {
    id: 'C_UNBOUNDED_INPUT', category: '输入', severity: 'high',
    pattern: /(?<![\w.])(?:gets|_getws)\s*\(/,
    extensions: CPP_EXTENSIONS,
    codeOnly: true,
    message: '输入函数未限制写入长度',
    recommendation: '使用带缓冲区长度的输入函数并检查返回值',
  },
  {
    id: 'C_UNBOUNDED_SCANF', category: '输入', severity: 'high',
    pattern: /(?<![\w.])(?:scanf|wscanf)\s*\(\s*L?"((?:\\.|[^"\\])*)"/,
    extensions: CPP_EXTENSIONS,
    codePrefix: true,
    unboundedFormat: true,
    message: 'scanf 字符串转换未限制字段宽度',
    recommendation: '按目标缓冲区容量设置字段宽度并检查返回值',
  },
  {
    id: 'C_UNBOUNDED_SCANF_SOURCE', category: '输入', severity: 'high',
    pattern: new RegExp(String.raw`(?<![\w.])(?:fscanf|sscanf|fwscanf|swscanf)\s*\(\s*` +
      String.raw`(?:[^,"()]+|L?"(?:\\.|[^"\\])*")\s*,\s*L?"((?:\\.|[^"\\])*)"`),
    extensions: CPP_EXTENSIONS,
    codePrefix: true,
    unboundedFormat: true,
    message: 'scanf 字符串转换未限制字段宽度',
    recommendation: '按目标缓冲区容量设置字段宽度并检查返回值',
  },
  {
    id: 'SSRF', category: 'SSRF', severity: 'high',
    pattern: new RegExp(
      '(requests\\.(get|post|put|delete|head)|urllib\\.request\\.urlopen)' +
      '\\s*\\([^\\n]*(request|input|argv|args|params|query|url)\\b', 'i'),
    extensions: ['.py'],
    message: '可能存在 SSRF 风险',
    recommendation: '验证并限制目标 URL',
  },
  {
    id: 'DEBUG_CODE', category: '调试', severity: 'low',
    pattern: /(?<![\w.$])debugger\b(?=\s*(?:;|}|$))/,
    extensions: ['.js', '.ts'],
    codeOnly: true,
    message: '发现 debugger 语句',
    recommendation: '移除生产代码中的断点',
  },
  {
    id: 'DEBUG_BREAKPOINT', category: '调试', severity: 'low',
    pattern: /(?<![\w.])(?:pdb\.set_trace|breakpoint)\s*\(/,
    extensions: ['.py'],
    codeOnly: true,
    message: '发现 Python 断点调用',
    recommendation: '移除生产代码中的断点',
  },
  {
    id: 'INSECURE_RANDOM', category: '加密',
    severity: 'medium',
    pattern: /\brandom\.(random|randint|choice|shuffle)\s*\(/i,
    extensions: ['.py'],
    message: '使用不安全的随机数生成器',
    recommendation: '安全场景使用 secrets 模块',
  },
  {
    id: 'XXE', category: 'XXE', severity: 'high',
    pattern: /etree\.(parse|fromstring)\s*\([^)]*\)|xml\.dom\.minidom\.parse/i,
    extensions: ['.py'],
    message: 'XML 解析可能存在 XXE 风险',
    recommendation: '禁用外部实体: XMLParser(resolve_entities=False)',
  },
];

const CODE_EXTENSIONS = new Set([
  ...CPP_EXTENSIONS,
  '.py',
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.mts',
  '.cts',
  '.jsx',
  '.tsx',
  '.go',
  '.java',
  '.php',
  '.rb',
  '.rs',
  '.sh',
  '.bash',
  '.yaml',
  '.yml',
  '.json',
]);
const DEFAULT_EXCLUDES = [
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
  'tests',
  'test',
  '__tests__',
  'spec',
];

function ruleLineIgnored(line, cpp) {
  if (!cpp && /^(?:#|\/\/|\*|\/\*)/u.test(line.trim())) return true;
  return /^\s*(id|pattern|severity|message|recommendation|extensions|excludePattern|category)\s*:/.test(line);
}

function ruleExcluded(rule, line) {
  if (!rule.excludePattern) return false;
  const excluded = rule.excludePattern.test(line);
  rule.excludePattern.lastIndex = 0;
  return excluded;
}

function codeMatchRequired(rule, cpp) {
  return rule.codePrefix || (cpp && rule.id === 'HARDCODED_SECRET');
}

function executableLines(content, python) {
  const blank = (text) => text.replace(/[^\r\n]/g, ' ');
  if (python) {
    const literals = /#[^\n]*|'''[\s\S]*?(?:'''|$)|"""[\s\S]*?(?:"""|$)|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'/g;
    return content.replace(literals, blank).split('\n');
  }
  // 保留表达式前缀，区分作为值的正则与除法后的可执行语句
  const prefix =
    String.raw`(^|[=(:,;!?&|^~%*<>{\[]|(?<!\+)\+(?!\+)|(?<!-)-(?!-)|` +
    String.raw`(?<![\w.$])\b(?:return|throw|yield|case|else|do)\b)`;
  const spacing = String.raw`(?:\s|/\*[\s\S]*?\*/|//[^\n]*(?:\n|$))*`;
  const expression = String.raw`/(?![/*])(?:\\[^\r\n]|\[(?:\\[^\r\n]|[^\]\\\r\n])*\]|[^/\\[\r\n])+/[dgimsuvy]*`;
  const other =
    /\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`/;
  const tokens = new RegExp(prefix + spacing + expression + '|' + other.source, 'g');
  return content
    .replace(tokens, (text, before) => {
      const kept = before || '';
      return kept + blank(text.slice(kept.length));
    })
    .split('\n');
}

function cppSource(content) {
  const blank = (text) => text.replace(/[^\r\n]/gu, ' ');
  const tokens = new RegExp(
    [
      String.raw`R"([^ ()\\\t\r\n]{0,16})\([\s\S]*?\)\1"`,
      String.raw`//[^\n]*|/\*[\s\S]*?(?:\*/|$)`,
      String.raw`"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'`,
    ].join('|'),
    'g'
  );
  return {
    lines: content.replace(tokens, (text) => (/^\/[/*]/u.test(text) ? blank(text) : text)).split('\n'),
    executable: content.replace(tokens, blank).split('\n'),
  };
}

function scanSource(filePath, content) {
  let ext = sourceExtension(filePath, content);
  if (['.mjs', '.cjs', '.jsx'].includes(ext)) ext = '.js';
  if (['.mts', '.cts', '.tsx'].includes(ext)) ext = '.ts';
  const cpp = CPP_EXTENSIONS.includes(ext);
  const testPattern =
    /(?:^|\/)(?:tests?|__tests__|specs?)(?:\/|$)|(?:^|\/)(?:test|spec)[_.][^/]+$|[._](?:test|spec)\.[^/]+$/i;
  const views = cpp
    ? cppSource(content)
    : {
        lines: content.split('\n'),
        executable: executableLines(content, ext === '.py'),
      };
  return { ...views, ext, cpp, testFile: testPattern.test(filePath.split(path.sep).join('/')) };
}

function unboundedFormat(format) {
  const conversions = /%(?:%|(?:\d+\$)?(\*)?(\d+)?(?:hh|ll|[hljztL])?([a-zA-Z]|\[))/gu;
  return [...format.matchAll(conversions)].some(
    (match) => !match[1] && (!match[2] || Number(match[2]) === 0) && ['s', '['].includes(match[3])
  );
}

function matchRule(rule, line, code, cpp) {
  if (ruleLineIgnored(line, cpp)) return null;
  const match = rule.pattern.exec(rule.codeOnly ? code : line);
  rule.pattern.lastIndex = 0;
  if (!match || ruleExcluded(rule, line)) return null;
  if (codeMatchRequired(rule, cpp) && !code.slice(match.index, match.index + match[0].length).trim()) return null;
  if (rule.unboundedFormat && !unboundedFormat(match[1])) return null;
  return match;
}

function securityFinding(rule, location, source, match) {
  const { filePath, index } = location;
  const executed = source.executable[index].slice(match.index, match.index + match[0].length).trim();
  const context = executed ? (source.testFile ? 'test_code' : 'source') : source.testFile ? 'test_fixture' : 'literal';
  return {
    rule_id: rule.id,
    severity: rule.severity,
    category: rule.category,
    message: rule.message,
    file_path: filePath,
    line_number: index + 1,
    line_content: '[redacted]',
    context,
    review_required: true,
    recommendation: rule.recommendation,
  };
}

function scanFile(filePath, rules, content = fs.readFileSync(filePath, 'utf-8')) {
  const findings = [];
  const source = scanSource(filePath, content);
  for (const rule of rules) {
    if (!rule.extensions.includes('*') && !rule.extensions.includes(source.ext)) continue;
    for (const [index, line] of source.lines.entries()) {
      const match = matchRule(rule, line, source.executable[index], source.cpp);
      if (match) findings.push(securityFinding(rule, { filePath, index }, source, match));
    }
  }
  return findings;
}

const {
  buildReport,
  reportBaselines,
  countBySeverity,
  parseCliArgs,
  runCli,
  collectSourceFiles,
  sourceExtension,
} = require(path.join(__dirname, '..', '..', 'lib', 'shared.js'));
const { compareBaseline } = require(path.join(__dirname, '..', '..', 'lib', 'git-baseline.js'));

function scanDirectory(targets, excludeDirs, base) {
  const selected = collectSourceFiles(targets, CODE_EXTENSIONS, excludeDirs);
  const findings = [];
  const contents = new Map();
  let filesScanned = 0;
  for (const target of selected.files) {
    try {
      const content = fs.readFileSync(target, 'utf8');
      findings.push(...scanFile(target, SECURITY_RULES, content));
      contents.set(target, content);
      filesScanned++;
    } catch (error) {
      selected.errors.push({ path: target, code: error.code || 'READ_FAILED', message: error.message });
    }
  }
  findings.sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9));
  const compared = compareBaseline(
    [...contents.keys()],
    findings,
    (file, content) => scanFile(file, SECURITY_RULES, content),
    base,
    contents
  );
  selected.errors.push(...compared.errors);
  const complete = filesScanned > 0 && selected.errors.length === 0;
  const passed = complete && !findings.some((f) => f.severity === 'critical' || f.severity === 'high');
  return {
    scan_path: selected.requested_paths.join(', '),
    requested_paths: selected.requested_paths,
    coverage: selected.coverage,
    scan_errors: selected.errors,
    complete,
    files_scanned: filesScanned,
    baseline: compared.baseline,
    origin_counts: compared.origin_counts,
    passed,
    findings,
  };
}

function formatReport(result, verbose) {
  const counts = countBySeverity(result.findings);
  const fields = {
    扫描路径: result.scan_path,
    扫描文件: result.files_scanned,
    比较基线: reportBaselines(result.baseline, result.requested_paths),
    分析完整性: result.complete ? '完整' : '未完成',
    未分析: result.scan_errors.map((error) => error.path + ': ' + error.message).join('\n') || '无',
    扫描结果: !result.complete ? '未完成' : result.passed ? '\u2713 通过' : '\u2717 发现高危问题',
    统计:
      `严重: ${counts.critical || 0} | 高危: ${counts.high || 0}` +
      ` | 中危: ${counts.medium || 0} | 低危: ${counts.low || 0}`,
  };
  return buildReport('代码安全扫描报告', fields, result.findings, verbose, 'category');
}

function main() {
  const opts = parseCliArgs(process.argv, { exclude: [], base: undefined });
  if (opts.help) {
    console.log('Usage: security_scanner.js [paths...] [--base ref] [-v] [--json] [--exclude dirs...]');
    return;
  }
  if (opts.mode) throw new Error('--mode is only supported by verify-change');
  const verbose = opts.verbose;
  const jsonOut = opts.json;
  const excludeDirs = [...DEFAULT_EXCLUDES, ...opts.exclude];
  const result = scanDirectory(opts.targets, excludeDirs, opts.base);

  if (jsonOut) {
    console.log(
      JSON.stringify(
        {
          scan_path: result.scan_path,
          requested_paths: result.requested_paths,
          coverage: result.coverage,
          scan_errors: result.scan_errors,
          complete: result.complete,
          files_scanned: result.files_scanned,
          passed: result.passed,
          counts: countBySeverity(result.findings),
          baseline: result.baseline,
          origin_counts: result.origin_counts,
          findings: result.findings,
        },
        null,
        2
      )
    );
  } else {
    console.log(formatReport(result, verbose));
  }
  process.exitCode = !result.complete ? 2 : result.passed ? 0 : 1;
}

if (require.main === module) runCli(main);

module.exports = { scanFile, SECURITY_RULES };
