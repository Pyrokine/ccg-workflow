import ansis from 'ansis'
import { homedir } from 'node:os'
import { join, resolve } from 'pathe'
import type { InitOptions } from '../types'
import { installInit } from './init-install'
import { runInitSteps, showNoninteractiveSummary } from './init-interactive'
import { buildRouting, createInitState, initializeLanguage, restoreInitState } from './init-state'

export async function init(options: InitOptions = {}): Promise<void> {
  const installDir = resolve(options.installDir || join(homedir(), '.claude'))
  console.log()
  console.log(ansis.cyan.bold(`  CCG - Claude Code + GPT + Grok`))
  console.log(ansis.gray(`  Multi-Model Collaboration Workflow`))
  console.log()
  const language = await initializeLanguage(options)
  const state = createInitState(options, installDir, language)
  await restoreInitState(state)
  if (!options.skipPrompt && !(await runInitSteps(state))) {
    return
  }
  const routing = buildRouting(state)
  if (options.skipPrompt || options.force) {
    showNoninteractiveSummary(state)
  }
  await installInit(state, routing)
}
