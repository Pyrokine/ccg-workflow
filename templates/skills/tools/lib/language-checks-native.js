'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { canonical, executable, execute, issue, unavailable, checked } = require('./language-checks-runtime.js');

function ruffIssues(result, covered) {
  const diagnostics = JSON.parse(result.stdout);
  if (!Array.isArray(diagnostics)) throw new Error();
  const issues = diagnostics.map((diagnostic) => {
    if (
      !diagnostic ||
      typeof diagnostic.filename !== 'string' ||
      !diagnostic.location ||
      typeof diagnostic.code !== 'string'
    ) {
      throw new Error();
    }
    const file = covered.find((entry) => canonical(entry) === canonical(diagnostic.filename));
    if (!file) throw new Error();
    return issue('ruff', 'error', file, diagnostic.location.row, diagnostic.code);
  });
  if ((result.status === 1) !== issues.length > 0) throw new Error();
  return issues;
}

function ruff(root, files, targetVersion) {
  const command = executable('ruff');
  if (!command) return unavailable('ruff', root, files, 'Ruff is not installed');
  const flags = ['check', '--no-cache', '--no-fix', '--no-fix-only', '--force-exclude'];
  if (targetVersion !== undefined) flags.push('--target-version', targetVersion);
  const env = { ...process.env };
  delete env.RUFF_OUTPUT_FILE;
  // Ruff 诊断 JSON 不包含无问题文件，单独枚举覆盖范围以避免重复分析
  const inventory = execute(command, [...flags, '--show-files', '--', ...files], root, undefined, { env });
  if (inventory.reason) return unavailable('ruff', root, files, inventory.reason);
  if (inventory.status !== 0) return unavailable('ruff', root, files, 'Ruff could not enumerate project files');
  const listed = new Set(
    inventory.stdout
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((file) => canonical(path.resolve(root, file)))
  );
  const covered = files.filter((file) => listed.has(canonical(file)));
  if (!covered.length)
    return checked('ruff', root, { requested: files, covered: [], issues: [], reason: 'Ruff CLI; no cache or fixes' });
  const result = execute(command, [...flags, '--output-format', 'json', '--', ...covered], root, undefined, { env });
  if (result.reason) return unavailable('ruff', root, files, result.reason);
  try {
    return checked('ruff', root, {
      requested: files,
      covered,
      issues: ruffIssues(result, covered),
      reason: 'Ruff CLI; project configuration; no cache or fixes',
    });
  } catch {
    return unavailable('ruff', root, files, 'Ruff returned invalid diagnostic output');
  }
}

function compilationFiles(database, files) {
  const root = path.dirname(database);
  const entries = JSON.parse(fs.readFileSync(database, 'utf8'));
  if (!Array.isArray(entries)) throw new Error();
  const recorded = new Set(
    entries.map((entry) => {
      if (
        typeof entry.directory !== 'string' ||
        typeof entry.file !== 'string' ||
        (!Array.isArray(entry.arguments) && typeof entry.command !== 'string')
      )
        throw new Error();
      return canonical(path.resolve(root, entry.directory, entry.file));
    })
  );
  return files.filter((file) => recorded.has(canonical(file)));
}

function clangSeverity(kind, rule) {
  if (rule?.includes('-warnings-as-errors')) return 'error';
  return { warning: 'warning', note: 'info' }[kind] || 'error';
}

function clangDiagnostic(line, root) {
  const match = /^(.*):(\d+):(\d+): (warning|error|fatal error|note): .*?(?: \[([\w.,-]+)\])?$/u.exec(line);
  if (!match) {
    return {
      invalid:
        /^(?:error:|Error:|LLVM ERROR|unable to handle compilation|Could not auto-detect|no checks enabled)/iu.test(
          line.trim()
        ),
      unknown:
        Boolean(line.trim()) &&
        !/^\d+ warnings? generated\.|^Suppressed \d+ warnings?|^Use -header-filter|^Error while processing/u.test(line),
    };
  }
  const file = path.resolve(root, match[1]);
  if (!fs.existsSync(file)) return { invalid: true };
  const rule = match[5] ? match[5].split(',')[0] : 'clang-diagnostic';
  return { finding: issue('clang-tidy', clangSeverity(match[4], match[5]), file, Number(match[2]), rule) };
}

function clangResults(result, root) {
  const issues = [];
  let invalid = false;
  let unknown = false;
  for (const line of `${result.stdout}\n${result.stderr}`.split(/\r?\n/u)) {
    const diagnostic = clangDiagnostic(line, root);
    if (diagnostic.finding) issues.push(diagnostic.finding);
    invalid ||= diagnostic.invalid;
    unknown ||= diagnostic.unknown;
  }
  const failedWithoutError = result.status === 1 && !issues.some((entry) => entry.severity === 'error');
  if (invalid || (unknown && !issues.length) || failedWithoutError) throw new Error();
  return issues;
}

function clangTidy(database, files) {
  const root = path.dirname(database);
  const command = executable('clang-tidy');
  if (!command) return unavailable('clang-tidy', root, files, 'clang-tidy is not installed');
  let covered;
  try {
    covered = compilationFiles(database, files);
  } catch {
    return unavailable('clang-tidy', root, files, 'Compilation database could not be read');
  }
  if (!covered.length)
    return unavailable('clang-tidy', root, files, 'No requested file has a compilation database entry');
  const result = execute(command, ['-p', root, '--quiet', ...covered], root);
  if (result.reason) return unavailable('clang-tidy', root, files, result.reason);
  try {
    return checked('clang-tidy', root, {
      requested: files,
      covered,
      issues: clangResults(result, root),
      reason: 'clang-tidy CLI; existing compilation database; no build or fixes',
    });
  } catch {
    return unavailable('clang-tidy', root, files, 'clang-tidy failed or returned invalid diagnostics');
  }
}

module.exports = { ruff, clangTidy };
