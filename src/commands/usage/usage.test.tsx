import { describe, expect, mock, test } from 'bun:test'
import * as React from 'react'

import type { LocalJSXCommandContext } from '../../commands.js'

function MockSettings(): React.ReactNode {
  return null
}

await mock.module('../../components/Settings/Settings.js', () => ({
  Settings: MockSettings,
}))

describe('/usage command', () => {
  test('is available only for OpenAI sessions', async () => {
    const command = (await import('./index.js')).default

    expect(command.description).toBe('Show Codex usage limits')
    expect(command.availability).toEqual(['openai'])
  })

  test('ignores reset arguments and still opens the Settings Usage tab', async () => {
    const { call } = await import('./usage.js')
    const { Settings } = await import('../../components/Settings/Settings.js')
    const onDone = mock(() => undefined)

    const result = await call(
      onDone,
      {} as LocalJSXCommandContext,
      'reset',
    )

    expect(onDone).not.toHaveBeenCalled()
    expect(React.isValidElement(result)).toBe(true)
    expect((result as React.ReactElement).type).toBe(Settings)
    expect((result as React.ReactElement<{ defaultTab?: string }>).props.defaultTab).toBe(
      'Usage',
    )
  })
})
