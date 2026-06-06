import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { PassThrough } from 'stream'
import stripAnsi from 'strip-ansi'
import * as React from 'react'

import { Box, render, Text, ThemeProvider } from '../../ink.js'
import { AppStateProvider, getDefaultAppState } from '../../state/AppState.js'
import { Notifications } from './Notifications.js'

describe('Notifications', () => {
  const originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = originalAnthropicApiKey ?? 'test-key'
  })

  afterEach(() => {
    if (originalAnthropicApiKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY
    } else {
      process.env.ANTHROPIC_API_KEY = originalAnthropicApiKey
    }
  })

  test('renders Box-rooted JSX notifications outside Text context', async () => {
    const stdout = new PassThrough() as unknown as NodeJS.WriteStream & {
      columns: number
    }
    stdout.columns = 100
    let output = ''
    ;(stdout as unknown as PassThrough).on('data', chunk => {
      output += chunk.toString()
    })
    const stdin = new PassThrough() as unknown as NodeJS.ReadStream
    const stderr = new PassThrough() as unknown as NodeJS.WriteStream
    const defaultState = getDefaultAppState()
    const noop = () => undefined

    const instance = await render(
      <ThemeProvider>
        <AppStateProvider
          initialState={{
            ...defaultState,
            notifications: {
              current: {
                key: 'box-jsx-notification',
                jsx: (
                  <Box>
                    <Text>boxed notification</Text>
                  </Box>
                ),
                priority: 'immediate',
              },
              queue: [],
            },
          }}
        >
          <Notifications
            apiKeyStatus="valid"
            autoUpdaterResult={null}
            debug={false}
            isAutoUpdating={false}
            verbose={false}
            messages={[]}
            onAutoUpdaterResult={noop}
            onChangeIsUpdating={noop}
            ideSelection={undefined}
          />
        </AppStateProvider>
      </ThemeProvider>,
      {
        stdout,
        stdin,
        stderr,
        exitOnCtrlC: false,
        patchConsole: false,
      },
    )

    await new Promise(resolve => setTimeout(resolve, 30))
    instance.unmount()
    expect(stripAnsi(output)).toContain('boxed notification')
  })

  test('renders blocked local agent notification when not viewing the agent', async () => {
    const stdout = new PassThrough() as unknown as NodeJS.WriteStream & {
      columns: number
    }
    stdout.columns = 100
    let output = ''
    ;(stdout as unknown as PassThrough).on('data', chunk => {
      output += chunk.toString()
    })
    const stdin = new PassThrough() as unknown as NodeJS.ReadStream
    const stderr = new PassThrough() as unknown as NodeJS.WriteStream
    const defaultState = getDefaultAppState()
    const noop = () => undefined

    const instance = await render(
      <ThemeProvider>
        <AppStateProvider
          initialState={{
            ...defaultState,
            tasks: {
              'agent-curie': {
                id: 'agent-curie',
                type: 'local_agent',
                status: 'completed',
                description: 'Implementor',
                startTime: Date.now(),
                outputFile: '',
                outputOffset: 0,
                notified: true,
                agentId: 'agent-curie',
                prompt: 'test prompt',
                agentName: 'Curie',
                agentType: 'implementor',
                retrieved: false,
                lastReportedToolCount: 0,
                lastReportedTokenCount: 0,
                isBackgrounded: true,
                pendingMessages: [],
                retain: false,
                diskLoaded: false,
                handoffStatus: 'blocked',
                blockReason: 'Need a decision.',
              },
            },
          }}
        >
          <Notifications
            apiKeyStatus="valid"
            autoUpdaterResult={null}
            debug={false}
            isAutoUpdating={false}
            verbose={false}
            messages={[]}
            onAutoUpdaterResult={noop}
            onChangeIsUpdating={noop}
            ideSelection={undefined}
          />
        </AppStateProvider>
      </ThemeProvider>,
      {
        stdout,
        stdin,
        stderr,
        exitOnCtrlC: false,
        patchConsole: false,
      },
    )

    await new Promise(resolve => setTimeout(resolve, 30))
    instance.unmount()
    const plain = stripAnsi(output)
    expect(plain).toContain('@Curie (implementor) needs your input')
    expect(plain).toContain('↵ to open')
  })

  test('renders verification verdict notification when not viewing the agent', async () => {
    const stdout = new PassThrough() as unknown as NodeJS.WriteStream & {
      columns: number
    }
    stdout.columns = 100
    let output = ''
    ;(stdout as unknown as PassThrough).on('data', chunk => {
      output += chunk.toString()
    })
    const stdin = new PassThrough() as unknown as NodeJS.ReadStream
    const stderr = new PassThrough() as unknown as NodeJS.WriteStream
    const defaultState = getDefaultAppState()
    const noop = () => undefined

    const instance = await render(
      <ThemeProvider>
        <AppStateProvider
          initialState={{
            ...defaultState,
            tasks: {
              'agent-noether': {
                id: 'agent-noether',
                type: 'local_agent',
                status: 'completed',
                description: 'Verification',
                startTime: Date.now(),
                outputFile: '',
                outputOffset: 0,
                notified: true,
                agentId: 'agent-noether',
                prompt: 'test prompt',
                agentName: 'Noether',
                agentType: 'verification',
                retrieved: false,
                lastReportedToolCount: 0,
                lastReportedTokenCount: 0,
                isBackgrounded: true,
                pendingMessages: [],
                retain: false,
                diskLoaded: false,
                verdict: 'PASS',
              },
            },
          }}
        >
          <Notifications
            apiKeyStatus="valid"
            autoUpdaterResult={null}
            debug={false}
            isAutoUpdating={false}
            verbose={false}
            messages={[]}
            onAutoUpdaterResult={noop}
            onChangeIsUpdating={noop}
            ideSelection={undefined}
          />
        </AppStateProvider>
      </ThemeProvider>,
      {
        stdout,
        stdin,
        stderr,
        exitOnCtrlC: false,
        patchConsole: false,
      },
    )

    await new Promise(resolve => setTimeout(resolve, 30))
    instance.unmount()
    expect(stripAnsi(output)).toContain('@Noether (verification) — PASS')
  })
})
