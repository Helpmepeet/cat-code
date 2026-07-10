import { describe, expect, mock, test } from 'bun:test'
import * as React from 'react'

import type { LocalJSXCommandContext } from '../../commands.js'
import commandFactory from './index.js'
import { call, Login } from './login.js'

describe('/login command', () => {
  test('is described as OpenAI login', () => {
    const command = commandFactory()

    expect(command.description).toBe('Sign in with your OpenAI account')
  })

  test('opens the shared login flow in OpenAI-only mode', async () => {
    const onDone = mock(() => undefined)
    const result = await call(onDone, {} as LocalJSXCommandContext)

    expect(React.isValidElement(result)).toBe(true)
    expect((result as React.ReactElement).type).toBe(Login)
    expect((result as React.ReactElement<{ openAIOnly?: boolean }>).props.openAIOnly).toBe(true)
  })
})
