import type { Context } from '@deepseek-ai/cordis'
import type * as React from 'react'

/** React's general createElement overload accepts both DOM tags and components. */
export type CreateElement = (
  type: React.ElementType,
  props?: object | null,
  ...children: React.ReactNode[]
) => React.ReactElement

export type BrowserReact = Omit<typeof React, 'createElement'> & { createElement: CreateElement }

/** The context proxy exposes the registry and reflection service methods. */
export type BrowserContext = Context & Pick<Context['registry'], 'plugin'> & Pick<Context['reflect'], 'provide' | 'get'>
