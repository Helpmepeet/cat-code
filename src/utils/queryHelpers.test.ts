import { describe, expect, test } from 'bun:test'
import {
  createAssistantAPIErrorMessage,
  createAssistantMessage,
  createUserMessage,
  NO_RESPONSE_REQUESTED,
} from './messages.js'
import { normalizeMessage } from './queryHelpers.js'
import type { Message } from '../types/message.js'

describe('normalizeMessage internal no-response handling', () => {
  test('does not emit the silent API fallback to live SDK consumers', () => {
    const internal = createAssistantAPIErrorMessage({
      content: NO_RESPONSE_REQUESTED,
    })

    expect([...normalizeMessage(internal)]).toEqual([])
  })

  test('still emits genuine assistant-authored text with the same words', () => {
    const genuine = createAssistantMessage({ content: NO_RESPONSE_REQUESTED })

    expect(JSON.stringify([...normalizeMessage(genuine)])).toContain(
      NO_RESPONSE_REQUESTED,
    )
  })

  test('emits the API-error classification on the SDK assistant frame', () => {
    const apiError = createAssistantAPIErrorMessage({
      content: 'OAuth token revoked · Please run /login',
      error: 'authentication_failed',
    })

    expect([...normalizeMessage(apiError)]).toMatchObject([
      {
        type: 'assistant',
        error: 'authentication_failed',
      },
    ])
  })

  test('carries the engine-minted subagent name on every nested full frame', () => {
    const agentProgress = (nested: Message): Message => ({
      type: 'progress',
      uuid: '00000000-0000-4000-8000-000000000001',
      parentToolUseID: 'toolu_parent',
      data: {
        type: 'agent_progress',
        message: nested,
        prompt: 'inspect the seam',
        agentId: 'agent-1',
        agentName: ' @Ada ',
      },
    })

    const assistant = [...normalizeMessage(agentProgress(createAssistantMessage({ content: 'Working.' })))]
    const user = [...normalizeMessage(agentProgress(createUserMessage({ content: 'Initial task.' })))]
    expect(assistant[0]).toMatchObject({
      type: 'assistant',
      parent_tool_use_id: 'toolu_parent',
      agent_name: 'Ada',
    })
    expect(user[0]).toMatchObject({
      type: 'user',
      parent_tool_use_id: 'toolu_parent',
      agent_name: 'Ada',
    })
  })
})
