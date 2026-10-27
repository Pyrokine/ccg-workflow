#!/usr/bin/env node
/**
 * Skills 运行入口
 * 跨平台统一调用各 skill 脚本
 *
 * 用法:
 *     node run_skill.js <skill_name> [args...]
 *
 * 示例:
 *     node run_skill.js verify-module ./my-project -v
 *     node run_skill.js verify-security ./src --json
 *     node run_skill.js verify-change --mode staged
 *     node run_skill.js verify-quality ./src --language-checks
 *     node run_skill.js gen-docs ./new-module --force
 */

const { spawn } = require('child_process');
const { readdirSync, realpathSync, unlinkSync, closeSync, openSync } = require('fs');
const { join, resolve, basename } = require('path');
const { createHash } = require('crypto');
const { tmpdir, constants } = require('os');
const { setTimeout: sleepMs } = require('timers/promises');

function getSkillsDir() {
  const override = process.env.SAGE_SKILLS_DIR;
  return override ? resolve(override) : __dirname;
}

function discoverSkills(skillsDir) {
  const found = {};
  const toolsDir = join(skillsDir, 'tools');
  for (const name of readdirSync(toolsDir).sort()) {
    let scripts;
    try {
      scripts = readdirSync(join(toolsDir, name, 'scripts')).sort();
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue;
      throw error;
    }
    const jsFile = scripts.find((file) => file.endsWith('.js'));
    if (jsFile) found[name] = join(toolsDir, name, 'scripts', jsFile);
  }
  return found;
}

function getScriptPath(skillName) {
  const available = discoverSkills(getSkillsDir());
  if (!Object.hasOwn(available, skillName)) {
    throw new Error(`未知的 skill '${skillName}'，可用的 skills: ${Object.keys(available).join(', ') || '(无)'}`);
  }
  return available[skillName];
}

async function acquireTargetLock(args, signal) {
  const separator = args.indexOf('--');
  let target = (separator < 0 ? args : args.slice(0, separator)).find((arg) => !arg.startsWith('-'));
  if (!target && separator >= 0) target = args[separator + 1];
  target = resolve(target || process.cwd());
  try {
    target = realpathSync(target);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const hash = createHash('md5').update(target).digest('hex').slice(0, 12);
  const lockPath = join(tmpdir(), `sage_skill_${hash}.lock`);
  const deadline = Date.now() + 30000;
  let waiting = false;
  while (true) {
    signal.throwIfAborted();
    try {
      return { fd: openSync(lockPath, 'wx', 0o600), lockPath };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (!waiting) console.error(`等待锁释放: ${target}`);
      waiting = true;
      if (Date.now() >= deadline) throw new Error(`等待锁超时: ${target}`);
      await sleepMs(200, undefined, { signal });
    }
  }
}

function releaseLock(lock) {
  if (!lock) return;
  try {
    closeSync(lock.fd);
  } finally {
    unlinkSync(lock.lockPath);
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.length || args[0] === '-h' || args[0] === '--help') {
    console.log(basename(__filename) + ' <skill_name> [args...]');
    process.exitCode = args.length ? 0 : 1;
    return;
  }

  const abort = new AbortController();
  let child;
  let lock;
  let requestedSignal;
  let escalation;
  const terminate = (signal) => {
    if (!child?.pid) return;
    try {
      if (process.platform === 'win32') child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch (error) {
      if (error.code !== 'ESRCH') console.error(`停止子进程失败: ${error.code || 'UNKNOWN'}`);
    }
  };
  const interrupt = (signal) => {
    if (requestedSignal) {
      terminate('SIGKILL');
      return;
    }
    requestedSignal = signal;
    abort.abort();
    terminate(signal);
    escalation = setTimeout(() => terminate('SIGKILL'), 5000);
    escalation.unref();
  };
  const onInt = () => interrupt('SIGINT');
  const onTerm = () => interrupt('SIGTERM');
  process.on('SIGINT', onInt);
  process.on('SIGTERM', onTerm);

  try {
    const skillName = args[0];
    const scriptPath = getScriptPath(skillName);
    const scriptArgs = args.slice(1);
    if (!skillName.startsWith('verify-')) lock = await acquireTargetLock(scriptArgs, abort.signal);
    abort.signal.throwIfAborted();
    child = spawn(process.execPath, [scriptPath, ...scriptArgs], {
      stdio: 'inherit',
      detached: process.platform !== 'win32',
    });
    let spawnFailed = false;
    const exit = await new Promise((done) => {
      child.once('error', (error) => {
        spawnFailed = true;
        console.error(`执行错误: ${error.code || 'UNKNOWN'}`);
      });
      child.once('close', (code, signal) => done({ code, signal }));
    });
    const signal = requestedSignal || exit.signal;
    process.exitCode = signal ? 128 + (constants.signals[signal] || 1) : spawnFailed ? 1 : (exit.code ?? 1);
  } catch (error) {
    if (requestedSignal) process.exitCode = 128 + (constants.signals[requestedSignal] || 1);
    else {
      const result = { passed: false, complete: false, error: error.message };
      if (args.includes('--json')) console.log(JSON.stringify(result));
      else console.error(result.error);
      process.exitCode = 2;
    }
  } finally {
    clearTimeout(escalation);
    process.removeListener('SIGINT', onInt);
    process.removeListener('SIGTERM', onTerm);
    try {
      releaseLock(lock);
    } catch (error) {
      console.error(`释放写入锁失败: ${error.code || 'UNKNOWN'}`);
      if (!process.exitCode) process.exitCode = 1;
    }
  }
}

main();
