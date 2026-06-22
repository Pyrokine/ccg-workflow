import fs from 'fs-extra'
import { homedir } from 'node:os'
import { dirname, join } from 'pathe'

// ═══════════════════════════════════════════════════════
// Fast Context global prompt injection
// ═══════════════════════════════════════════════════════

const FAST_CONTEXT_PROMPT_PRIMARY = `# fast-context MCP 工具使用指南

## 核心原则

**任何需要理解代码上下文、探索性搜索、或自然语言定位代码的场景，优先使用 \`mcp__fast-context__fast_context_search\`**`

const FAST_CONTEXT_PROMPT_AUXILIARY = `# fast-context MCP 工具使用指南（辅助模式）

## 核心原则

**主检索工具为 ace-tool（\`mcp__ace-tool__search_context\`）。当 ace-tool 无法满足语义搜索需求时，使用 \`mcp__fast-context__fast_context_search\` 作为补充。**

适合使用 fast-context 的场景：
- 用自然语言描述要找的逻辑（如"部署流程"、"事件处理"）
- 跨模块、跨层级的调用链路追踪
- 中文语义搜索（工具支持中英文双语查询）`

const FC_MARKER_START = '<!-- CCG-FAST-CONTEXT-START -->'
const FC_MARKER_END = '<!-- CCG-FAST-CONTEXT-END -->'

/**
 * Write fast-context search guidance to:
 * 1. ~/.claude/rules/ccg-fast-context.md (Claude Code — auto-loaded via rules/)
 * 2. ~/.codex/AGENTS.md (Codex CLI — auto-loaded as global instructions)
 */
export async function writeFastContextPrompt(auxiliaryMode = false): Promise<void> {
  const promptContent = auxiliaryMode ? FAST_CONTEXT_PROMPT_AUXILIARY : FAST_CONTEXT_PROMPT_PRIMARY
  const markerStart = FC_MARKER_START
  const markerEnd = FC_MARKER_END
  const markedBlock = `\n${markerStart}\n${promptContent}\n${markerEnd}\n`
  const markerRegex = new RegExp(
    `\\n?${markerStart.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${markerEnd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n?`
  )

  // Helper: append or replace marked block in a file
  async function injectIntoFile(filePath: string): Promise<void> {
    const dir = dirname(filePath)
    await fs.ensureDir(dir)
    if (await fs.pathExists(filePath)) {
      let content = await fs.readFile(filePath, 'utf-8')
      if (content.includes(markerStart)) {
        content = content.replace(markerRegex, markedBlock)
      } else {
        content += markedBlock
      }
      await fs.writeFile(filePath, content, 'utf-8')
    } else {
      await fs.writeFile(filePath, markedBlock.trim() + '\n', 'utf-8')
    }
  }

  // 1. Claude Code rules (standalone file, not appended)
  const rulesDir = join(homedir(), '.claude', 'rules')
  await fs.ensureDir(rulesDir)
  await fs.writeFile(join(rulesDir, 'ccg-fast-context.md'), promptContent, 'utf-8')

  // 2. Codex CLI global instructions (~/.codex/AGENTS.md)
  await injectIntoFile(join(homedir(), '.codex', 'AGENTS.md'))
}

/**
 * Remove fast-context prompts from all locations
 */
export async function removeFastContextPrompt(): Promise<void> {
  const markerRegex = new RegExp(
    `\\n?${FC_MARKER_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${FC_MARKER_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n?`
  )

  // Helper: remove marked block from a file
  async function removeFromFile(filePath: string): Promise<void> {
    if (await fs.pathExists(filePath)) {
      let content = await fs.readFile(filePath, 'utf-8')
      if (content.includes(FC_MARKER_START)) {
        content = content.replace(markerRegex, '')
        await fs.writeFile(filePath, content, 'utf-8')
      }
    }
  }

  // 1. Remove Claude Code rules file
  const rulePath = join(homedir(), '.claude', 'rules', 'ccg-fast-context.md')
  if (await fs.pathExists(rulePath)) {
    await fs.remove(rulePath)
  }

  // 2. Remove from Codex AGENTS.md
  await removeFromFile(join(homedir(), '.codex', 'AGENTS.md'))
}
