import { describe, expect, it } from 'vitest'
import { createDefaultConfig, createDefaultRouting, normalizeRoutingForInstall } from '../config'

describe('createDefaultRouting', () => {
  it('returns antigravity as frontend primary', () => {
    const routing = createDefaultRouting()
    expect(routing.frontend.primary).toBe('antigravity')
    expect(routing.frontend.models).toEqual(['antigravity', 'codex'])
    expect(routing.frontend.strategy).toBe('fallback')
  })

  it('returns codex as backend primary', () => {
    const routing = createDefaultRouting()
    expect(routing.backend.primary).toBe('codex')
    expect(routing.backend.models).toEqual(['codex'])
    expect(routing.backend.strategy).toBe('fallback')
  })

  it('returns codex and antigravity for review', () => {
    const routing = createDefaultRouting()
    expect(routing.review.models).toEqual(['codex', 'antigravity'])
    expect(routing.review.strategy).toBe('single')
  })

  it('does not inject proxy by default', () => {
    const routing = createDefaultRouting()
    expect(routing.proxy).toBeUndefined()
  })

  it('defaults to smart mode', () => {
    const routing = createDefaultRouting()
    expect(routing.mode).toBe('smart')
  })
})

describe('normalizeRoutingForInstall', () => {
  it('keeps antigravity frontend routing active', () => {
    const routing = normalizeRoutingForInstall({
      frontend: {
        models: ['antigravity', 'codex'],
        primary: 'antigravity',
        strategy: 'fallback',
      },
      backend: {
        models: ['codex'],
        primary: 'codex',
        strategy: 'fallback',
      },
      review: {
        models: ['codex', 'antigravity'],
        strategy: 'parallel',
      },
      proxy: {
        models: ['antigravity'],
        http: 'http://legacy.invalid:8891',
        https: 'http://legacy.invalid:8891',
      },
      mode: 'smart',
    })

    expect(routing.frontend).toEqual({
      models: ['antigravity', 'codex'],
      primary: 'antigravity',
      strategy: 'fallback',
    })
    expect(routing.backend).toEqual({
      models: ['codex'],
      primary: 'codex',
      strategy: 'fallback',
    })
    expect(routing.review.models).toEqual(['codex', 'antigravity'])
    expect(routing.proxy).toEqual({
      models: ['antigravity'],
      http: 'http://legacy.invalid:8891',
      https: 'http://legacy.invalid:8891',
    })
  })

  it('canonicalizes hand-written agy routing to antigravity', () => {
    const routing = normalizeRoutingForInstall({
      frontend: {
        models: ['gemini'],
        primary: 'gemini',
        strategy: 'fallback',
      },
      backend: {
        models: ['agy'],
        primary: 'agy',
        strategy: 'fallback',
      },
      review: {
        models: ['agy', 'gemini'],
        strategy: 'parallel',
      },
      mode: 'smart',
    })

    expect(routing.frontend.primary).toBe('antigravity')
    expect(routing.backend).toEqual({
      models: ['antigravity'],
      primary: 'antigravity',
      strategy: 'fallback',
    })
    expect(routing.review.models).toEqual(['antigravity'])
  })

  it('keeps explicitly configured agy proxy as antigravity proxy', () => {
    const routing = normalizeRoutingForInstall({
      proxy: {
        models: ['agy'],
        http: 'http://proxy.invalid:8891',
      },
    })

    expect(routing.proxy).toEqual({
      models: ['antigravity'],
      http: 'http://proxy.invalid:8891',
      https: 'http://proxy.invalid:8891',
    })
  })

  it('does not migrate legacy gemini proxy to antigravity', () => {
    const routing = normalizeRoutingForInstall({
      proxy: {
        models: ['gemini'],
        http: 'http://legacy.invalid:8891',
        https: 'http://legacy.invalid:8891',
      },
    })

    expect(routing.proxy).toBeUndefined()
  })
})

describe('createDefaultConfig', () => {
  const baseOptions = {
    language: 'zh-CN' as const,
    routing: createDefaultRouting(),
    installedWorkflows: ['workflow', 'plan'],
  }

  it('sets version from package.json', () => {
    const config = createDefaultConfig(baseOptions)
    // version should be a semver string
    expect(config.general.version).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('sets language correctly', () => {
    const config = createDefaultConfig(baseOptions)
    expect(config.general.language).toBe('zh-CN')
  })

  it('sets createdAt as ISO string', () => {
    const config = createDefaultConfig(baseOptions)
    // Should parse without error
    expect(() => new Date(config.general.createdAt)).not.toThrow()
    expect(new Date(config.general.createdAt).toISOString()).toBe(config.general.createdAt)
  })

  it('stores installed workflows', () => {
    const config = createDefaultConfig(baseOptions)
    expect(config.workflows.installed).toEqual(['workflow', 'plan'])
  })

  it('defaults mcpProvider to fast-context', () => {
    const config = createDefaultConfig(baseOptions)
    expect(config.mcp.provider).toBe('fast-context')
  })

  it('respects custom mcpProvider', () => {
    const config = createDefaultConfig({ ...baseOptions, mcpProvider: 'contextweaver' })
    expect(config.mcp.provider).toBe('contextweaver')
  })

  it('defaults liteMode to true', () => {
    const config = createDefaultConfig(baseOptions)
    expect(config.performance?.liteMode).toBe(true)
  })

  it('respects liteMode = false', () => {
    const config = createDefaultConfig({ ...baseOptions, liteMode: false })
    expect(config.performance?.liteMode).toBe(false)
  })

  it('sets paths with home directory', () => {
    const config = createDefaultConfig(baseOptions)
    expect(config.paths.commands).toContain('.claude')
    expect(config.paths.prompts).toContain('.ccg')
    expect(config.paths.backup).toContain('.ccg')
  })

  it('preserves routing config exactly', () => {
    const routing = createDefaultRouting()
    const config = createDefaultConfig({ ...baseOptions, routing })
    expect(config.routing).toEqual(routing)
  })
})
