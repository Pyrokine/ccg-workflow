#!/usr/bin/env node
// CCG Skill Router Hook — UserPromptSubmit
// Detects domain keywords in user message and injects relevant skill content.
// Fires alongside workflow-state.js on every user prompt.

'use strict';

try {
  const fs = require('fs');
  const path = require('path');
  const { outputHook, readHookInput, readFileBounded, escapeXml } = require('./task-utils.js');

  const input = readHookInput();
  let userMessage = input.prompt || input.message || input.content || '';
  if (typeof userMessage === 'object') userMessage = JSON.stringify(userMessage);

  if (!userMessage || userMessage.length < 5) process.exit(0);

  const msgLower = userMessage.toLowerCase();

  // Keyword → skill file routing table
  const ROUTES = [
    {
      keywords: ['渗透', '红队', 'pentest', 'exploit', 'c2', '横向', '提权', 'bypass', 'red team'],
      skill: 'domains/security/red-team.md',
      name: '红队渗透',
    },
    {
      keywords: ['蓝队', '告警', 'ioc', '应急', '取证', 'siem', 'edr', 'blue team', 'incident'],
      skill: 'domains/security/blue-team.md',
      name: '蓝队防御',
    },
    {
      keywords: ['sqli', 'xss', 'ssrf', 'rce', 'injection', 'owasp', 'web渗透', 'api安全'],
      skill: 'domains/security/pentest.md',
      name: 'Web渗透',
    },
    {
      keywords: ['代码审计', '污点分析', 'sink', 'source', '危险函数', 'code audit'],
      skill: 'domains/security/code-audit.md',
      name: '代码审计',
    },
    {
      keywords: ['逆向', 'pwn', 'fuzzing', '栈溢出', '堆溢出', 'rop', 'binary', 'reversing'],
      skill: 'domains/security/vuln-research.md',
      name: '漏洞研究',
    },
    {
      keywords: ['osint', '威胁情报', '威胁建模', 'att&ck', 'threat', 'threat hunting'],
      skill: 'domains/security/threat-intel.md',
      name: '威胁情报',
    },
    {
      keywords: ['api设计', 'rest', 'graphql', 'grpc', 'endpoint', 'versioning', 'api design'],
      skill: 'domains/architecture/api-design.md',
      name: 'API设计',
    },
    {
      keywords: ['缓存', 'redis', 'memcached', 'cache', 'cdn', 'invalidation'],
      skill: 'domains/architecture/caching.md',
      name: '缓存架构',
    },
    {
      keywords: ['kubernetes', 'docker', 'k8s', '微服务', 'service mesh', 'cloud native'],
      skill: 'domains/architecture/cloud-native.md',
      name: '云原生',
    },
    {
      keywords: ['kafka', 'rabbitmq', '消息队列', 'event driven', 'pub/sub', 'message queue'],
      skill: 'domains/architecture/message-queue.md',
      name: '消息队列',
    },
    {
      keywords: ['rag', 'retrieval', '向量', 'embedding', 'chunking', 'vector'],
      skill: 'domains/ai/rag-system.md',
      name: 'RAG系统',
    },
    {
      keywords: ['ai agent', 'tool use', 'function calling', 'agent框架', 'orchestration'],
      skill: 'domains/ai/agent-dev.md',
      name: 'Agent开发',
    },
    {
      keywords: ['prompt injection', 'jailbreak', 'guardrail', 'llm安全'],
      skill: 'domains/ai/llm-security.md',
      name: 'LLM安全',
    },
  ];

  // Find matching skills
  const matched = ROUTES.filter((route) => route.keywords.some((kw) => msgLower.includes(kw)));

  const REVIEWER_ACTION = {
    model: 'review-profiles',
    role: 'reviewer',
    action: 'GPT、Grok 双路交叉审查代码变更',
  };
  const GPT_REVIEWER_ACTION = {
    model: 'gpt-review-profile',
    role: 'reviewer',
    action: 'GPT 后端审查视角检查代码变更',
  };
  const GROK_REVIEWER_ACTION = {
    model: 'grok-review-profile',
    role: 'reviewer',
    action: 'Grok 前端审查视角检查代码变更',
  };

  // ── Model action triggers ──
  // Detect when user wants to use a specific model for a task
  const MODEL_ACTIONS = [
    {
      keywords: ['codex审查', 'codex 审查', 'codex review', '用codex看', '让codex检查', 'codex检查'],
      ...GPT_REVIEWER_ACTION,
    },
    {
      keywords: ['codex分析', 'codex 分析', 'codex analyze', '用codex分析'],
      model: 'codex',
      role: 'analyzer',
      action: '分析当前项目/代码',
    },
    {
      keywords: ['codex调试', 'codex 调试', 'codex debug', '用codex调试'],
      model: 'codex',
      role: 'debugger',
      action: '诊断问题',
    },
    {
      keywords: ['codex测试', 'codex 测试', 'codex test', '用codex写测试'],
      model: 'codex',
      role: 'tester',
      action: '生成测试用例',
    },
    {
      keywords: ['antigravity审查', 'antigravity 审查', 'agy审查', 'agy 审查', '用antigravity看', '用agy看'],
      ...GROK_REVIEWER_ACTION,
    },
    {
      keywords: ['antigravity分析', 'antigravity 分析', 'agy分析', 'agy 分析', '用antigravity分析', '用agy分析'],
      model: 'antigravity',
      role: 'analyzer',
      action: '分析当前项目/代码',
    },
    {
      keywords: ['antigravity前端', 'antigravity 前端', 'agy前端', 'agy 前端', '用antigravity做前端', '用agy做前端'],
      model: 'antigravity',
      role: 'frontend',
      action: '前端开发分析',
    },
    {
      keywords: ['三模型审查', '三模型 审查', '双模型审查', '双模型 审查', '两个模型审查', 'dual review'],
      ...REVIEWER_ACTION,
    },
    {
      keywords: ['双模型分析', '双模型 分析', '两个模型分析', 'dual analyze'],
      model: 'both',
      role: 'analyzer',
      action: '双模型并行分析',
    },
  ];

  const modelAction = MODEL_ACTIONS.find((a) => a.keywords.some((kw) => msgLower.includes(kw)));
  if (modelAction) {
    const homeDir = process.env.HOME || process.env.USERPROFILE || '';
    const wrapperPath = path.join(homeDir, '.claude', 'bin', 'codeagent-wrapper');

    let actionInstructions;
    if (modelAction.model === 'review-profiles') {
      actionInstructions = `<ccg-model-action>
用户请求 GPT、Grok 双 profile 审查。请立即执行：

1. 获取工作目录: WORKDIR=$(pwd)
2. 读取 ${path.join(homeDir, '.claude', '.ccg', 'config.toml')} 中 routing.review.profiles 的 GPT、Grok model 与 effort。缺少配置时使用 gpt-5.6-sol / xhigh 和 grok-4.5 / high。
3. 在同一条消息中并行启动 GPT、Grok 两个 reviewer，均使用 run_in_background: true。GPT 调用 ${wrapperPath} --lite --progress --backend claude --no-session-persistence --claude-model <GPT model> --claude-effort <GPT effort>；Grok 调用 ${wrapperPath} --lite --progress --backend claude --no-session-persistence --claude-model <Grok model> --claude-effort <Grok effort>。两者均使用 ${path.join(homeDir, '.claude', '.ccg', 'prompts', 'claude', 'reviewer.md')}。GPT 审查后端逻辑、正确性、安全、回归与测试缺口，Grok 审查前端交互、可访问性、设计一致性与前端安全。
4. reviewer 不使用 resume 或 SESSION_ID。等待两个结果后由主 Claude 汇总并确认 finding。
</ccg-model-action>`;
    } else if (modelAction.model === 'gpt-review-profile') {
      actionInstructions = `<ccg-model-action>
用户请求 Codex 审查视角。该视角由 GPT profile 通过当前 Claude Code provider 执行。请立即执行：

1. 获取工作目录: WORKDIR=$(pwd)
2. 读取 ${path.join(homeDir, '.claude', '.ccg', 'config.toml')} 中 GPT profile 的 model 与 effort。缺少配置时使用 gpt-5.6-sol / xhigh。
3. 使用 ${wrapperPath} --lite --progress --backend claude --no-session-persistence --claude-model <GPT model> --claude-effort <GPT effort> 启动一个 reviewer，ROLE_FILE 为 ${path.join(homeDir, '.claude', '.ccg', 'prompts', 'claude', 'reviewer.md')}。审查后端逻辑、正确性、安全、回归与测试缺口。
4. 不使用 resume 或 SESSION_ID。等待结果后确认 finding。
</ccg-model-action>`;
    } else if (modelAction.model === 'grok-review-profile') {
      actionInstructions = `<ccg-model-action>
用户请求 Antigravity 审查视角。该视角由 Grok profile 通过当前 Claude Code provider 执行。请立即执行：

1. 获取工作目录: WORKDIR=$(pwd)
2. 读取 ${path.join(homeDir, '.claude', '.ccg', 'config.toml')} 中 Grok profile 的 model 与 effort。缺少配置时使用 grok-4.5 / high。
3. 使用 ${wrapperPath} --lite --progress --backend claude --no-session-persistence --claude-model <Grok model> --claude-effort <Grok effort> 启动一个 reviewer，ROLE_FILE 为 ${path.join(homeDir, '.claude', '.ccg', 'prompts', 'claude', 'reviewer.md')}。审查前端交互、可访问性、设计一致性与前端安全。
4. 不使用 resume 或 SESSION_ID。等待结果后确认 finding。
</ccg-model-action>`;
    } else if (modelAction.model === 'both') {
      actionInstructions = `<ccg-model-action>
用户请求双模型${modelAction.role === 'reviewer' ? '审查' : '分析'}。请立即执行：

1. 获取工作目录: WORKDIR=$(pwd)
2. 读取 ${path.join(homeDir, '.claude', '.ccg', 'config.toml')}，确定 routing.backend.primary 与 routing.frontend.primary。缺少配置时两者均使用 Claude Code。
3. 若 backend.primary 与 frontend.primary 均为 Claude，直接在同一条消息中并行创建两个独立 Claude Code Agent，两个 prompt 都包含 CCG_ROLE: research 与任务 ${modelAction.action}。不得调用 codeagent-wrapper 或任何外部 CLI。
4. 仅当用户已将某条 primary route 明确配置为 Codex、Antigravity、Grok、Kimi Code 或 OpenCode 时，才为该条 route 调用对应外部 CLI。为 Grok、Kimi Code 或 OpenCode 主路由读取 grokModel、kimiModel 或 opencodeModel，并将对应的 --grok-model、--kimi-model 或 --opencode-model 参数附在 --backend 后。

   External route (<configured external primary>):
   ${wrapperPath} --lite --progress --backend <configured external primary 和可选型号参数> - "$WORKDIR" <<'EOF'
   ROLE_FILE: ${path.join(homeDir, '.claude', '.ccg', 'prompts', '<configured external primary>', modelAction.role + '.md')}
   <TASK>${modelAction.action}</TASK>
   EOF

   某条 primary route 为 Claude 时，为该条 route 创建独立 Claude Code Agent，不得以 wrapper 的 Claude backend 替代。

5. 等待结果，综合输出
</ccg-model-action>`;
    } else {
      actionInstructions = `<ccg-model-action>
用户请求使用 ${modelAction.model} 执行${modelAction.action}。请立即执行：

1. 获取工作目录: WORKDIR=$(pwd)
2. 调用模型:

   ${wrapperPath} --lite --progress --backend ${modelAction.model} - "$WORKDIR" <<'EOF'
   ROLE_FILE: ${path.join(homeDir, '.claude', '.ccg', 'prompts', modelAction.model, modelAction.role + '.md')}
   <TASK>${modelAction.action}</TASK>
   EOF

3. 等待结果并输出
</ccg-model-action>`;
    }

    outputHook('UserPromptSubmit', actionInstructions);
    process.exit(0);
  }

  // ── Domain knowledge injection ──
  if (matched.length === 0) process.exit(0);

  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  const skillsBase = path.join(homeDir, '.claude', 'skills', 'ccg');

  if (!fs.existsSync(skillsBase)) process.exit(0);

  const injections = [];
  const diagnostics = [];
  for (const match of matched.slice(0, 2)) {
    const skillPath = path.join(skillsBase, match.skill);
    if (!fs.existsSync(skillPath)) continue;

    try {
      const source = readFileBounded(skillPath, 16 * 1024);
      if (!source.ok) {
        diagnostics.push(`${source.code}:${match.skill}`);
        continue;
      }
      const lines = source.content.split('\n');
      const excerpt = lines.slice(0, 120).join('\n');
      injections.push(
        `## ${match.name} (auto-injected)\n${excerpt}${source.truncated || lines.length > 120 ? '\n...(truncated, full: ' + match.skill + ')' : ''}`
      );
    } catch (error) {
      diagnostics.push(`SKILL_READ_FAILED:${match.skill}:${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (injections.length === 0 && diagnostics.length === 0) process.exit(0);

  const sections = [];
  if (injections.length > 0)
    sections.push(`<ccg-domain-knowledge>\n${injections.join('\n\n---\n\n')}\n</ccg-domain-knowledge>`);
  if (diagnostics.length > 0)
    sections.push(
      `<ccg-domain-knowledge-diagnostics>\n${diagnostics.map((item) => escapeXml(item)).join('\n')}\n</ccg-domain-knowledge-diagnostics>`
    );
  outputHook('UserPromptSubmit', sections.join('\n\n'));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const escapedMessage = message.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: `<ccg-skill-router-error>CCG_SKILL_ROUTER_ERROR\n${escapedMessage}</ccg-skill-router-error>`,
      },
    })}\n`
  );
}
