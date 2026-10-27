import fs from 'fs-extra'
import { homedir } from 'node:os'
import { join } from 'pathe'
import { installMcpServer } from '../utils/installer'

const GROK_SEARCH_PROMPT = [
  '## 0. Language and Format Standards',
  '',
  '- **Interaction Language**: Tools and models must interact exclusively in **English**; ' +
    'user outputs must be in **Chinese**.',
  '- MUST ULRTA Thinking in ENGLISH!',
  '- **Formatting Requirements**: Use standard Markdown formatting. ' +
    'Code blocks and specific text results should be marked with backticks. ' +
    'Skilled in applying four or more ````markdown wrappers.',
  '',
  '## 1. Search and Evidence Standards',
  'Typically, the results of web searches only constitute third-party suggestions and are not directly credible; ' +
    'they must be cross-verified with sources to provide users with absolutely authoritative and correct answers.',
  '',
  '### Search Trigger Conditions',
  'Strictly distinguish between internal and external knowledge. ' +
    'Avoid speculation based on general internal knowledge. When uncertain, explicitly inform the user.',
  '',
  'For example, when using the \\`fastapi\\` library to encapsulate an API endpoint, ' +
    'despite possessing common-sense knowledge internally, ' +
    'you must still rely on the latest search results or official documentation for reliable implementation.',
  '',
  '### Search Execution Guidelines',
  '',
  '- Use the \\`mcp__grok-search\\` tool for web searches',
  '- Execute independent search requests in parallel; sequential execution applies only when dependencies exist',
  '- Evaluate search results for quality: analyze relevance, source credibility, cross-source consistency, ' +
    'and completeness. Conduct supplementary searches if gaps exist',
  '',
  '### Source Quality Standards',
  '',
  '- Key factual claims must be supported by >=2 independent sources. ' +
    'If relying on a single source, explicitly state this limitation',
  '- Conflicting sources: Present evidence from both sides, assess credibility and timeliness, ' +
    'identify the stronger evidence, or declare unresolved discrepancies',
  '- Empirical conclusions must include confidence levels (High/Medium/Low)',
  '- Citation format: [Author/Organization, Year/Date, Section/URL]. Fabricated references are strictly prohibited',
  '',
  '## 2. Reasoning and Expression Principles',
  '',
  '- Be concise, direct, and information-dense: Use lists for discrete items; paragraphs for arguments',
  '- Challenge flawed premises: When user logic contains errors, pinpoint specific issues with evidence',
  '- All conclusions must specify: Applicable conditions, scope boundaries, and known limitations',
  '- Avoid greetings, pleasantries, filler adjectives, and emotional expressions',
  '- When uncertain: State unknowns and reasons before presenting confirmed facts',
  '',
].join('\n')

export async function writeGrokPromptToRules(prompt = GROK_SEARCH_PROMPT): Promise<void> {
  const rulesDir = join(homedir(), '.claude', 'rules')
  const rulePath = join(rulesDir, 'ccg-grok-search.md')

  // Clean up legacy CLAUDE.md injection if present
  const claudeMdPath = join(homedir(), '.claude', 'CLAUDE.md')
  if (await fs.pathExists(claudeMdPath)) {
    const content = await fs.readFile(claudeMdPath, 'utf-8')
    if (content.includes('CCG-GROK-SEARCH-PROMPT')) {
      const cleaned = content.replace(
        /\n*<!-- CCG-GROK-SEARCH-PROMPT-START -->[\s\S]*?<!-- CCG-GROK-SEARCH-PROMPT-END -->\n*/g,
        ''
      )
      await fs.writeFile(claudeMdPath, cleaned, 'utf-8')
    }
  }

  await fs.ensureDir(rulesDir)
  await fs.writeFile(rulePath, prompt, 'utf-8')
}

export async function appendGrokSearchPrompt(): Promise<void> {
  await writeGrokPromptToRules(GROK_SEARCH_PROMPT.replaceAll('\\' + String.fromCharCode(96), String.fromCharCode(96)))
}

export async function installGrokSearchMcp(keys: {
  tavilyKey?: string
  firecrawlKey?: string
  grokApiUrl?: string
  grokApiKey?: string
}): Promise<{ success: boolean; message: string }> {
  const env: Record<string, string> = {}
  if (keys.tavilyKey) env.TAVILY_API_KEY = keys.tavilyKey
  if (keys.firecrawlKey) env.FIRECRAWL_API_KEY = keys.firecrawlKey
  if (keys.grokApiUrl) env.GROK_API_URL = keys.grokApiUrl
  if (keys.grokApiKey) env.GROK_API_KEY = keys.grokApiKey

  return installMcpServer(
    'grok-search',
    'uvx',
    ['--from', 'git+https://github.com/GuDaStudio/GrokSearch@grok-with-tavily', 'grok-search'],
    env
  )
}
