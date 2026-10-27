import { join } from 'pathe'
import type { InstallResult } from '../types'
import { normalizeRoutingForInstall } from './config'
import { PACKAGE_ROOT } from './installer-template'

export interface InstallOptions {
  routing?: {
    mode?: string
    frontend?: { models?: string[]; primary?: string }
    backend?: { models?: string[]; primary?: string }
    review?: {
      profiles?: Array<{
        id: 'gpt' | 'grok'
        model?: string
        effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
      }>
      strategy?: string
    }
    proxy?: { models?: string[]; http?: string; https?: string }
    grokModel?: string
    kimiModel?: string
    opencodeModel?: string
  }
  liteMode?: boolean
  mcpProvider?: string
  skipImpeccable?: boolean
  skipBinary?: boolean
  skillsProfile?: string[]
  skillsMode?: 'legacy' | 'native'
}

export interface InstallConfig {
  routing: {
    mode: string
    frontend: { models: string[]; primary: string }
    backend: { models: string[]; primary: string }
    review: {
      profiles: Array<{
        id: 'gpt' | 'grok'
        model?: string
        effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
      }>
      strategy?: string
    }
    proxy?: { models?: string[]; http?: string; https?: string }
    grokModel?: string
    kimiModel?: string
    opencodeModel?: string
  }
  liteMode: boolean
  mcpProvider: string
  skipImpeccable?: boolean
  skipBinary?: boolean
  skillsProfile?: string[]
  skillsMode?: 'legacy' | 'native'
}

export interface InstallContext {
  installDir: string
  force: boolean
  config: InstallConfig
  templateDir: string
  result: InstallResult
}

export function workflowInstallConfig(config: InstallOptions = {}): InstallConfig {
  return {
    routing: normalizeRoutingForInstall(config.routing),
    liteMode: config.liteMode ?? true,
    mcpProvider: config.mcpProvider || 'fast-context',
    skipImpeccable: config.skipImpeccable || false,
    skipBinary: config.skipBinary || false,
    skillsProfile: config.skillsMode === 'legacy' ? undefined : config.skillsProfile,
    skillsMode: config.skillsMode,
  }
}

export function createInstallContext(
  installDir: string,
  force: boolean,
  config: InstallConfig,
  configPath = ''
): InstallContext {
  return {
    installDir,
    force,
    config,
    templateDir: join(PACKAGE_ROOT, 'templates'),
    result: {
      success: true,
      installedCommands: [],
      installedPrompts: [],
      errors: [],
      configPath,
    },
  }
}
