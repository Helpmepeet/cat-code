import type { ToolUseBlock } from '@anthropic-ai/sdk/resources/index.mjs'
import { describe, expect, test } from 'bun:test'
import type { AppState } from '../../state/AppStateStore.js'
import type { ToolUseContext } from '../../Tool.js'
import { createPtcloveToolStatusTracker } from './ptcloveToolStatus.js'

function createContext(): {
  context: ToolUseContext
  getState: () => AppState
  setState: (next: AppState) => void
} {
  let state = {
    ptcloveCurrentTool: null,
  } as AppState
  return {
    context: {
      setAppState(update) {
        state = update(state)
      },
    } as unknown as ToolUseContext,
    getState: () => state,
    setState: next => {
      state = next
    },
  }
}

function toolUse(
  id: string,
  name: string,
  input: Record<string, unknown>,
): ToolUseBlock {
  return {
    type: 'tool_use',
    id,
    name,
    input,
  }
}

describe('ptclove tool status tracker', () => {
  test('falls back to another active tool when the newest concurrent tool completes', () => {
    const { context, getState } = createContext()
    const tracker = createPtcloveToolStatusTracker(context)

    tracker.start(
      toolUse('bash-1', 'Bash', { command: 'swift build --package-path app' }),
    )
    expect(getState().ptcloveCurrentTool).toMatchObject({
      toolUseID: 'bash-1',
      name: 'Running swift build --package-path',
      summary: 'Running swift build --package-path app',
    })

    tracker.start(toolUse('read-1', 'Read', { file_path: '/tmp/App.swift' }))
    expect(getState().ptcloveCurrentTool).toMatchObject({
      toolUseID: 'read-1',
      name: 'Reading App.swift',
      summary: 'Reading /tmp/App.swift',
      targetPath: '/tmp/App.swift',
    })

    tracker.complete('read-1')
    expect(getState().ptcloveCurrentTool).toMatchObject({
      toolUseID: 'bash-1',
      name: 'Running swift build --package-path',
    })

    tracker.complete('bash-1')
    expect(getState().ptcloveCurrentTool).toBeNull()
  })

  test('clear only removes tools owned by that tracker', () => {
    const { context, getState, setState } = createContext()
    const tracker = createPtcloveToolStatusTracker(context)
    tracker.start(toolUse('bash-1', 'Bash', { command: 'git status --short' }))

    setState({
      ...getState(),
      ptcloveCurrentTool: {
        toolUseID: 'other-tracker',
        name: 'Reading file',
        summary: 'Reading file',
      },
    })

    tracker.clear()
    expect(getState().ptcloveCurrentTool).toMatchObject({
      toolUseID: 'other-tracker',
    })
  })
})
