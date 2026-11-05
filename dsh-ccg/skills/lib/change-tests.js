'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { git } = require('./git-baseline.js');

function rustTestStart(line, attributesOnly) {
  return (
    /^\s*#\s*\[\s*(?:(?:\w+::)*test\b|cfg\s*\(\s*test\s*\))/.test(line) ||
    (!attributesOnly && /^\s*(?:pub\s+)?mod\s+tests\b/.test(line))
  );
}

function updateRustTestState(line, state) {
  for (const brace of line.match(/[{}]/g) || []) {
    state.depth += brace === '{' ? 1 : -1;
    if (brace === '{') {
      state.opened = true;
    }
  }
  if ((state.opened && state.depth === 0) || (!state.opened && /;\s*$/.test(line))) {
    state.active = false;
    state.opened = false;
  }
}

function rustTestLines(content, attributesOnly = false) {
  // shortcut: 仅识别显式测试项，需识别宏生成测试或复杂 cfg 时使用 Rust 语法分析器
  const blank = (text) => text.replace(/[^\r\n]/g, ' ');
  const code = content.replace(
    /\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|r(?<hashes>#+)?"[\s\S]*?"\k<hashes>|"(?:\\[\s\S]|[^"\\])*"|'(?:\\.|[^'\\])'/g,
    blank
  );
  const tests = new Set();
  const state = { active: false, depth: 0, opened: false };
  for (const [index, line] of code.split('\n').entries()) {
    if (!state.active && rustTestStart(line, attributesOnly)) {
      state.active = true;
    }
    if (!state.active) {
      continue;
    }
    tests.add(index + 1);
    updateRustTestState(line, state);
  }
  return tests;
}

function inlineCurrent(change, mode, root, comparison) {
  if (change.type === 'deleted') {
    return '';
  }
  const file = path.join(root, change.path);
  if (mode === 'working') {
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  }
  const current = mode === 'staged' ? '' : comparison.target;
  return git(root, 'show', `${current}:${change.path}`);
}

function inlineVersions(change, mode, root, comparison) {
  const previous = mode === 'committed' ? comparison.base : 'HEAD';
  const old = change.type === 'added' ? '' : git(root, 'show', `${previous}:${change.old_path || change.path}`);
  return [old, inlineCurrent(change, mode, root, comparison)].map((content) => ({
    lines: content.split('\n'),
    tests: rustTestLines(content),
  }));
}

function inlineTouched(change, diff, states) {
  const hunks = [
    ...diff.matchAll(/^@@ -(?<oldStart>\d+)(?:,(?<oldCount>\d+))? \+(?<newStart>\d+)(?:,(?<newCount>\d+))? @@/gm),
  ];
  const touched = [new Set(), new Set()];
  for (const match of hunks) {
    for (let side = 0; side < 2; side++) {
      const start = Number(match[1 + side * 2]);
      const count = Number(match[2 + side * 2] ?? 1);
      for (let line = start; line < start + count; line++) {
        touched[side].add(line);
      }
    }
  }
  if (!hunks.length && change.type === 'added') {
    states[1].lines.forEach((_line, index) => touched[1].add(index + 1));
  }
  return touched;
}

function classifyInlineTests(states, touched) {
  let hasTests = false;
  let onlyTests = true;
  for (let side = 0; side < 2; side++) {
    for (const line of touched[side]) {
      if (!states[side].lines[line - 1]?.trim()) {
        continue;
      }
      if (states[side].tests.has(line)) {
        hasTests = true;
      } else {
        onlyTests = false;
      }
    }
  }
  return { has_test_changes: hasTests, test_only: hasTests && onlyTests };
}

function identifyInlineTests(changes, mode, root, comparison = { base: 'HEAD~1', target: 'HEAD' }) {
  const diffArgs = {
    working: ['HEAD'],
    staged: ['--cached'],
    committed: [comparison.base, comparison.target],
  }[mode];
  for (const change of changes) {
    if (!change.path.endsWith('.rs') || change.is_test) {
      continue;
    }
    const file = path.join(root, change.path);
    if (mode === 'working' && fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) {
      continue;
    }
    const diff =
      change.type === 'added' && mode === 'working'
        ? ''
        : git(root, 'diff', '--no-ext-diff', '--no-textconv', '--unified=0', ...diffArgs, '--', change.path);
    const states = inlineVersions(change, mode, root, comparison);
    Object.assign(change, classifyInlineTests(states, inlineTouched(change, diff, states)));
  }
}

module.exports = { identifyInlineTests, rustTestLines };
