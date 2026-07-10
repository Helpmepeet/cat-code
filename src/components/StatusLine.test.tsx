import { afterEach, describe, expect, mock, test } from 'bun:test'
import { PassThrough } from 'stream'
import * as React from 'react'

import { render, ThemeProvider } from '../ink.js'
import {
  AppStateProvider,
  getDefaultAppState,
  useSetAppState,
} from '../state/AppState.js'

describe('StatusLine', () => {
  afterEach(() => {
    mock.restore()
    delete (globalThis as typeof globalThis & { MACRO?: { VERSION: string } }).MACRO
  })

  test('passes session effort and fast mode state to the status line command and refreshes when they change', async () => {
    ;(globalThis as typeof globalThis & { MACRO?: { VERSION: string } }).MACRO = {
      VERSION: 'test-version',
    }

    const statusInputs: Array<{
      effortLevel?: string
      fast_mode_state?: string
    }> = []
    await mock.module('../utils/hooks.js', () => ({
      createBaseHookInput: () => ({
        session_id: 'test-session',
        transcript_path: '/tmp/test-session.jsonl',
        cwd: '/repo',
      }),
      executeStatusLineCommand: mock(async input => {
        statusInputs.push(
          input as { effortLevel?: string; fast_mode_state?: string },
        )
        return `effort:${(input as { effortLevel?: string }).effortLevel ?? ''}`
      }),
    }))
    await mock.module('../utils/config.js', () => ({
      checkHasTrustDialogAccepted: () => true,
    }))
    await mock.module('../utils/fastMode.js', () => ({
      getFastModeState: mock(
        (_model: unknown, fastModeUserEnabled: boolean | undefined) =>
          fastModeUserEnabled ? 'on' : 'off',
      ),
    }))

    const { StatusLine } = await import('./StatusLine.js')

    function Harness() {
      const setAppState = useSetAppState()

      React.useEffect(() => {
        const timer = setTimeout(() => {
          setAppState(prev => ({
            ...prev,
            effortValue: 'max',
            fastMode: true,
          }))
        }, 20)

        return () => clearTimeout(timer)
      }, [setAppState])

      return (
        <StatusLine
          messagesRef={{ current: [] }}
          lastAssistantMessageId={null}
          latestUsageSignature={null}
        />
      )
    }

    const stdout = new PassThrough() as unknown as NodeJS.WriteStream & {
      columns: number
    }
    stdout.columns = 100
    const stdin = new PassThrough() as unknown as NodeJS.ReadStream
    const stderr = new PassThrough() as unknown as NodeJS.WriteStream

    const defaultState = getDefaultAppState()
    const instance = await render(
      <ThemeProvider>
        <AppStateProvider
          initialState={{
            ...defaultState,
            settings: {
              ...defaultState.settings,
              statusLine: {
                type: 'command',
                command: 'test-statusline',
              },
            },
            mainLoopModelForSession: 'gpt-5.6-terra',
            effortValue: 'high',
            fastMode: false,
          }}
        >
          <Harness />
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

    await new Promise(resolve => setTimeout(resolve, 450))
    instance.unmount()

    expect(statusInputs.map(input => input.effortLevel)).toContain('high')
    expect(statusInputs.map(input => input.fast_mode_state)).toContain('off')
    expect(statusInputs.at(-1)?.effortLevel).toBe('max')
    expect(statusInputs.at(-1)?.fast_mode_state).toBe('on')
  })
})
