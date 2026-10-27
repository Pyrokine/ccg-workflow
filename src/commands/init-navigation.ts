import ansis from 'ansis'
import inquirer from 'inquirer'
import { i18n } from '../i18n'

type NavigationChoice = InstanceType<typeof inquirer.Separator> | { name: string; value: string }

export type StepId = 'api' | 'model' | 'mcp' | 'perf'
export type StepReturn = 'next' | 'back' | 'cancel'
export type SummaryAction = 'confirm' | 'cancel' | StepId

// Sentinel values injected into list choices for navigation.
export const BACK_SENTINEL = '__ccg_back__'
export const CANCEL_SENTINEL = '__ccg_cancel__'

/**
 * Build navigation sentinels to append to a step's first list prompt.
 * Always includes cancel; includes back only when canGoBack is true.
 */
export function navSentinels(canGoBack: boolean): NavigationChoice[] {
  const items: NavigationChoice[] = [new inquirer.Separator()]
  if (canGoBack) {
    items.push({
      name: `${ansis.cyan('←')} ${i18n.t('init:nav.back')}`,
      value: BACK_SENTINEL,
    })
  }
  items.push({
    name: `${ansis.red('×')} ${i18n.t('init:nav.cancel')}`,
    value: CANCEL_SENTINEL,
  })
  return items
}
