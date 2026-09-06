import { describe, expect, test } from 'bun:test'
import { CLAUDE_CLI_TOOL_NAME } from '../tools/ClaudeCliTool/constants.js'
import { AGENT_TOOL_NAME } from '../tools/AgentTool/constants.js'
import { ASK_ORCHESTRATOR_TOOL_NAME } from '../tools/AskOrchestratorTool/prompt.js'
import { SEND_MESSAGE_TOOL_NAME } from '../tools/SendMessageTool/constants.js'
import { resolveWorkerCapabilities } from './agentCapabilities.js'

describe('resolveWorkerCapabilities', () => {
  test('reports every capability false for an empty resolved pool', () => {
    expect(resolveWorkerCapabilities([])).toEqual({
      mayDelegateExternally: false,
      mayDelegateInternally: false,
      canAskOrchestrator: false,
      canSendMessage: false,
    })
  })

  test('flags mayDelegateExternally only when ClaudeCli is in the resolved pool', () => {
    expect(
      resolveWorkerCapabilities(['Read', CLAUDE_CLI_TOOL_NAME]).mayDelegateExternally,
    ).toBe(true)
    expect(resolveWorkerCapabilities(['Read']).mayDelegateExternally).toBe(
      false,
    )
  })

  test('flags mayDelegateInternally only when Agent is in the resolved pool', () => {
    expect(
      resolveWorkerCapabilities(['Read', AGENT_TOOL_NAME]).mayDelegateInternally,
    ).toBe(true)
    expect(resolveWorkerCapabilities(['Read']).mayDelegateInternally).toBe(
      false,
    )
  })

  test('flags the two escalation channels independently', () => {
    const both = resolveWorkerCapabilities([
      ASK_ORCHESTRATOR_TOOL_NAME,
      SEND_MESSAGE_TOOL_NAME,
    ])
    expect(both.canAskOrchestrator).toBe(true)
    expect(both.canSendMessage).toBe(true)

    const neither = resolveWorkerCapabilities(['Read'])
    expect(neither.canAskOrchestrator).toBe(false)
    expect(neither.canSendMessage).toBe(false)
  })

  test('accepts a Set the same as any other iterable', () => {
    const names = new Set(['Read', CLAUDE_CLI_TOOL_NAME])
    expect(resolveWorkerCapabilities(names).mayDelegateExternally).toBe(true)
  })
})
