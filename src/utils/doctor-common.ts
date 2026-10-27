import fs from 'fs-extra'
import type { SkillManagerOptions } from './skill-manager'

export type DoctorStatus = 'pass' | 'warn' | 'fail' | 'skip'
export interface DoctorCheck {
  id: string
  label: string
  status: DoctorStatus
  detail: string
  remediation: string | null
}
export interface DoctorReport {
  schemaVersion: 1
  version: string
  mode: 'claude' | 'codex' | 'both' | 'skills' | 'none'
  backends: string[]
  checks: DoctorCheck[]
  failureCount: number
  warningCount: number
}
export interface DoctorDependencies {
  home?: string
  installDir?: string
  codexDir?: string
  configPath?: string
  platform?: NodeJS.Platform
  nodeVersion?: string
  exec?: (file: string, args: string[]) => string | null
  output?: (text: string) => void
  setExitCode?: (code: number) => void
  skillPaths?: Partial<Record<'claude' | 'codex', SkillManagerOptions>>
  root?: string
}
export type RecordValue = Record<string, unknown>

export function record(value: unknown): RecordValue {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as RecordValue) : {}
}

export async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await fs.lstat(path)).isFile()
  } catch {
    return false
  }
}

export async function readText(path: string): Promise<string | null> {
  try {
    return await fs.readFile(path, 'utf8')
  } catch {
    return null
  }
}

export async function files(path: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(path, { withFileTypes: true })
    return entries.filter((e) => e.isFile()).map((e) => e.name)
  } catch {
    return []
  }
}

export function check(
  id: string,
  label: string,
  status: DoctorStatus,
  detail: string,
  remediation?: string
): DoctorCheck {
  return {
    id,
    label,
    status,
    detail,
    remediation:
      status === 'pass' || status === 'skip' ? null : remediation || 'Run npx ccg-workflow to repair the installation.',
  }
}
