import ansis from 'ansis'
import inquirer from 'inquirer'
import { i18n } from '../i18n'
import type { ModelType } from '../types'
import { promptOpencodeModel } from '../utils/model-selection'

export interface ExecutionModels {
  grokModel: string
  kimiModel: string
  opencodeModel: string
}

export function modelChoices(): Array<{ name: string; value: ModelType }> {
  return [
    { name: `Claude Code ${ansis.green(`(${i18n.t('init:model.recommended')})`)}`, value: 'claude' },
    { name: 'Grok', value: 'grok' },
    { name: 'Kimi Code', value: 'kimi' },
    { name: 'Codex', value: 'codex' },
    { name: 'Antigravity', value: 'antigravity' },
    { name: 'OpenCode', value: 'opencode' },
  ]
}

export async function promptExecutionModels(
  state: ExecutionModels,
  selectedModels: Set<ModelType>,
  isZh: boolean
): Promise<void> {
  if (selectedModels.has('grok')) {
    const { model } = await inquirer.prompt<{ model: string }>([
      {
        type: 'input',
        name: 'model',
        message: i18n.t('init:model.grokModel'),
        default: state.grokModel || 'grok-4.6',
        validate: (value: string) => value.trim() !== '' || i18n.t('init:model.modelRequired'),
      },
    ])
    state.grokModel = model.trim()
  }
  if (selectedModels.has('kimi')) {
    const { model } = await inquirer.prompt<{ model: string }>([
      {
        type: 'input',
        name: 'model',
        message: i18n.t('init:model.kimiModel'),
        default: state.kimiModel,
      },
    ])
    state.kimiModel = model.trim()
  }
  if (selectedModels.has('opencode')) {
    state.opencodeModel = await promptOpencodeModel(state.opencodeModel, isZh)
  }
}
