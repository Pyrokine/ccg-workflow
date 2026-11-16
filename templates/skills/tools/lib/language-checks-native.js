'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  TIMEOUT,
  canonical,
  executable,
  execute,
  issue,
  unavailable,
  checked,
  AnalysisError,
  runNative,
} = require('./language-checks-runtime.js');

function ruffIssues(result, covered) {
  const diagnostics = JSON.parse(result.stdout);
  if (!Array.isArray(diagnostics)) {
    throw new Error();
  }
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
    if (!file) {
      throw new Error();
    }
    return issue('ruff', 'error', file, diagnostic.location.row, diagnostic.code);
  });
  if ((result.status === 1) !== issues.length > 0) {
    throw new Error();
  }
  return issues;
}

function ruff(root, files, targetVersion) {
  const command = executable('ruff');
  if (!command) {
    return unavailable('ruff', root, files, 'Ruff is not installed');
  }
  const flags = ['check', '--no-cache', '--no-fix', '--no-fix-only', '--force-exclude'];
  if (targetVersion !== undefined) {
    flags.push('--target-version', targetVersion);
  }
  const env = { ...process.env };
  delete env.RUFF_OUTPUT_FILE;
  // Ruff 诊断 JSON 不包含无问题文件，单独枚举覆盖范围以避免重复分析
  const inventory = execute(command, [...flags, '--show-files', '--', ...files], root, undefined, { env });
  if (inventory.reason) {
    return unavailable('ruff', root, files, inventory.reason);
  }
  if (inventory.status !== 0) {
    return unavailable('ruff', root, files, 'Ruff could not enumerate project files');
  }
  const listed = new Set(
    inventory.stdout
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((file) => canonical(path.resolve(root, file)))
  );
  const covered = files.filter((file) => listed.has(canonical(file)));
  if (!covered.length) {
    return checked('ruff', root, { requested: files, covered: [], issues: [], reason: 'Ruff CLI; no cache or fixes' });
  }
  const result = execute(command, [...flags, '--output-format', 'json', '--', ...covered], root, undefined, { env });
  if (result.reason) {
    return unavailable('ruff', root, files, result.reason);
  }
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
  const entries = JSON.parse(fs.readFileSync(database, { encoding: 'utf8' }));
  if (!Array.isArray(entries)) {
    throw new Error();
  }
  const recorded = new Set(
    entries.map((entry) => {
      if (
        typeof entry.directory !== 'string' ||
        typeof entry.file !== 'string' ||
        (!Array.isArray(entry.arguments) && typeof entry.command !== 'string')
      ) {
        throw new Error();
      }
      return canonical(path.resolve(root, entry.directory, entry.file));
    })
  );
  return files.filter((file) => recorded.has(canonical(file)));
}

function clangSeverity(kind, rule) {
  if (rule?.includes('-warnings-as-errors')) {
    return 'error';
  }
  return { warning: 'warning', note: 'info' }[kind] || 'error';
}

function clangDiagnostic(line, root) {
  const match = new RegExp(
    String.raw`^(?<file>.*):(?<line>\d+):(?<column>\d+): ` +
      String.raw`(?<severity>warning|error|fatal error|note): .*?(?: \[(?<rule>[\w.,-]+)\])?$`,
    'u'
  ).exec(line);
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
  if (!fs.existsSync(file)) {
    return { invalid: true };
  }
  const rule = match[5] ? match[5].split(',')[0] : 'clang-diagnostic';
  return { finding: issue('clang-tidy', clangSeverity(match[4], match[5]), file, Number(match[2]), rule) };
}

function clangResults(result, root) {
  const issues = [];
  let invalid = false;
  let unknown = false;
  for (const line of `${result.stdout}\n${result.stderr}`.split(/\r?\n/u)) {
    const diagnostic = clangDiagnostic(line, root);
    if (diagnostic.finding) {
      issues.push(diagnostic.finding);
    }
    invalid ||= diagnostic.invalid;
    unknown ||= diagnostic.unknown;
  }
  const failedWithoutError = result.status === 1 && !issues.some((entry) => entry.severity === 'error');
  if (invalid || (unknown && !issues.length) || failedWithoutError) {
    throw new AnalysisError('clang-tidy failed or returned invalid diagnostics');
  }
  return issues;
}

function clangTidy(database, files) {
  database = path.resolve(database);
  const root = path.dirname(database);
  return runNative({ tool: 'clang-tidy', root, files }, 'clang-tidy', (context) => {
    if (path.basename(database) !== 'compile_commands.json') {
      throw new AnalysisError('Compilation database must be named compile_commands.json');
    }
    let covered;
    try {
      covered = fs.statSync(database).isFile() ? compilationFiles(database, files) : null;
    } catch (error) {
      throw error instanceof AnalysisError
        ? error
        : new AnalysisError('Compilation database could not be read or parsed');
    }
    if (covered === null) {
      throw new AnalysisError('Compilation database must be a regular file');
    }
    if (!covered.length) {
      throw new AnalysisError('No requested file has a compilation database entry');
    }
    const result = context.run(['-p', root, '--quiet', ...covered]);
    return checked('clang-tidy', root, {
      requested: files,
      covered,
      issues: clangResults(result, root),
      reason: 'clang-tidy CLI; existing compilation database; no build or fixes',
    });
  });
}

function shellSyntax(root, files) {
  const results = { checks: [], issues: [], uncovered: [] };
  const deadline = Date.now() + TIMEOUT;
  const env = { ...process.env };
  delete env.BASH_ENV;
  delete env.ENV;
  for (const file of files) {
    const header = fs.readFileSync(file, { encoding: 'utf8' }).split('\n', 1)[0];
    const interpreter =
      /^#!.*\b(?<interpreter>bash|dash|ksh|zsh|sh)(?:\s|$)/u.exec(header)?.groups.interpreter ||
      (path.extname(file).toLowerCase() === '.bash' ? 'bash' : 'sh');
    const command = executable(interpreter);
    let result;
    const remaining = deadline - Date.now();
    if (!command || remaining <= 0) {
      result = unavailable(
        'shell-syntax',
        root,
        [file],
        command ? 'Shell syntax analysis timed out' : `${interpreter} is not installed`
      );
    } else {
      const execution = execute(command, ['-n', file], root, undefined, {
        env,
        timeout: remaining,
        acceptedStatuses: [0, 1, 2],
      });
      result = execution.reason
        ? unavailable('shell-syntax', root, [file], execution.reason)
        : checked('shell-syntax', root, {
            requested: [file],
            covered: [file],
            issues: execution.status === 0 ? [] : [issue('shell-syntax', 'error', file, 0, 'syntax-error')],
            reason: `${interpreter} -n; syntax only; script is not executed`,
          });
    }
    results.checks.push(...result.checks);
    results.issues.push(...result.issues);
    results.uncovered.push(...result.uncovered);
  }
  return results;
}

function powershellSyntax(root, files) {
  const command = executable('pwsh') || executable('powershell');
  if (!command) {
    return unavailable('powershell-syntax', root, files, 'PowerShell is not installed');
  }
  const deadline = Date.now() + TIMEOUT;
  const issues = [];
  const script =
    '$ErrorActionPreference="Stop"; try { $tokens=$null; $errors=$null; ' +
    '[System.Management.Automation.Language.Parser]::ParseFile(' +
    '$env:CCG_CHECK_FILE, [ref]$tokens, [ref]$errors) > $null; ' +
    'if($errors.Count){exit 1}; exit 0 } catch { exit 2 }';
  for (const file of files) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return unavailable('powershell-syntax', root, files, 'PowerShell syntax analysis timed out');
    }
    const result = execute(command, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], root, undefined, {
      env: { ...process.env, CCG_CHECK_FILE: file },
      timeout: remaining,
    });
    if (result.reason) {
      return unavailable('powershell-syntax', root, files, result.reason);
    }
    if (result.status !== 0) {
      issues.push(issue('powershell-syntax', 'error', file, 0, 'syntax-error'));
    }
  }
  return checked('powershell-syntax', root, {
    requested: files,
    covered: files,
    issues,
    reason: 'PowerShell Parser.ParseFile; syntax only; no profiles or script execution',
  });
}

function jsonSyntax(root, files) {
  const issues = [];
  for (const file of files) {
    try {
      JSON.parse(fs.readFileSync(file, { encoding: 'utf8' }));
    } catch (error) {
      if (!(error instanceof SyntaxError)) {
        throw error;
      }
      issues.push(issue('json-syntax', 'error', file, 0, 'syntax-error'));
    }
  }
  return checked('json-syntax', root, {
    requested: files,
    covered: files,
    issues,
    reason: 'JSON.parse; syntax only; no schema validation',
  });
}

module.exports = { ruff, clangTidy, shellSyntax, powershellSyntax, jsonSyntax };
