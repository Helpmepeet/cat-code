import { describe, expect, test } from 'bun:test'
import { PassThrough } from 'stream'
import stripAnsi from 'strip-ansi'
import * as React from 'react'

import { render, ThemeProvider } from '../../ink.js'
import { AppStateProvider, getDefaultAppState } from '../../state/AppState.js'
import type { LocalAgentTaskState } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { AsyncAgentDetailDialog } from './AsyncAgentDetailDialog.js'
import { BackgroundTask } from './BackgroundTask.js'

function makeLocalAgentTask(
  overrides: Partial<LocalAgentTaskState> = {},
): LocalAgentTaskState {
  return {
    id: 'agent-curie',
    type: 'local_agent',
    status: 'completed',
    description: 'Implementor task',
    startTime: Date.now(),
    outputFile: '',
    outputOffset: 0,
    notified: false,
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
    ...overrides,
  }
}

async function renderToPlainText(node: React.ReactNode): Promise<string> {
  const stdout = new PassThrough() as unknown as NodeJS.WriteStream & {
    columns: number
  }
  stdout.columns = 120
  let output = ''
  ;(stdout as unknown as PassThrough).on('data', chunk => {
    output += chunk.toString()
  })
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream & {
    isTTY: boolean
    setRawMode: (enabled: boolean) => void
    ref: () => void
    unref: () => void
  }
  stdin.isTTY = true
  stdin.setRawMode = () => undefined
  stdin.ref = () => undefined
  stdin.unref = () => undefined
  const stderr = new PassThrough() as unknown as NodeJS.WriteStream
  const defaultState = getDefaultAppState()

  const instance = await render(
    <ThemeProvider>
      <AppStateProvider initialState={defaultState}>{node}</AppStateProvider>
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
  return stripAnsi(output)
}

describe('AsyncAgentDetailDialog', () => {
  test('renders blocked local agents as needing input with resume hint', async () => {
    const output = await renderToPlainText(
      <AsyncAgentDetailDialog
        agent={makeLocalAgentTask({
          handoffStatus: 'blocked',
          blockReason: 'Should I update the public API too?',
        })}
        onDone={() => undefined}
      />,
    )

    expect(output).toContain('@Curie › implementor')
    expect(output).toContain('Needs input')
    expect(output).toContain('Should I update the public API too?')
    expect(output).toContain('resume with @Curie')
    expect(output).not.toContain('Completed')
  })

  test('renders verification verdicts near the top of the detail dialog', async () => {
    const output = await renderToPlainText(
      <AsyncAgentDetailDialog
        agent={makeLocalAgentTask({
          agentName: 'Noether',
          agentType: 'verification',
          description: 'Verification task',
          verdict: 'FAIL',
        })}
        onDone={() => undefined}
      />,
    )

    expect(output).toContain('@Noether › verification')
    expect(output).toContain('VERDICT: FAIL')
    expect(output).toContain('resume with @Noether')
  })
})

describe('BackgroundTask local agent row', () => {
  test('renders blocked local agents as needing input instead of done', async () => {
    const output = await renderToPlainText(
      <BackgroundTask
        task={makeLocalAgentTask({
          handoffStatus: 'blocked',
          blockReason: 'Need a decision.',
        })}
      />,
    )

    expect(output).toContain('@Curie · implementor')
    expect(output).toContain('needs input')
    expect(output).not.toContain('done')
  })
})
