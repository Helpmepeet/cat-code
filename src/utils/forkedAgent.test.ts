import { afterEach, describe, expect, mock, test } from 'bun:test'

import { getSessionId } from '../bootstrap/state.js'
import * as realCodexLeaseManager from '../services/api/codexAccountLeaseManager.js'
import * as realWebSocketTransport from '../services/api/codex-websocket-transport.js'
import type { ToolUseContext } from '../Tool.js'
import { createFileStateCacheWithSizeLimit } from './fileStateCache.js'
import type { CacheSafeParams } from './forkedAgent.js'

const releaseCodexLease = mock(() => {})
const clearWebSocketSession = mock(() => {})
let queryError: Error | undefined

mock.module('../query.js', () => ({
  query: mock(async function* () {
    if (queryError) {
      throw queryError
    }
  }),
}))

mock.module('../services/api/codexAccountLeaseManager.js', () => ({
  ...realCodexLeaseManager,
  releaseCodexLease,
}))

mock.module('../services/api/codex-websocket-transport.js', () => ({
  ...realWebSocketTransport,
  clearWebSocketSession,
}))

function createCacheSafeParams(): CacheSafeParams {
  const toolUseContext = {
    abortController: new AbortController(),
    readFileState: createFileStateCacheWithSizeLimit(10),
    getAppState: () => ({
      toolPermissionContext: {
        shouldAvoidPermissionPrompts: false,
      },
    }),
    setAppState: () => {},
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
    options: {},
    messages: [],
  } as unknown as ToolUseContext

  return {
    systemPrompt: [],
    userContext: {},
    systemContext: {},
    toolUseContext,
    forkContextMessages: [],
  }
}

async function runForkedAgentWithOwner(): Promise<void> {
  const { runForkedAgent } = await import('./forkedAgent.js')
  await runForkedAgent({
    promptMessages: [],
    cacheSafeParams: createCacheSafeParams(),
    canUseTool: async () => ({ behavior: 'allow', updatedInput: {} }),
    querySource: 'session_memory',
    forkLabel: 'test',
    overrides: { agentId: 'tool-context-owner' as never },
    skipTranscript: true,
  })
}

describe('runForkedAgent Codex resource cleanup', () => {
  afterEach(() => {
    queryError = undefined
    releaseCodexLease.mockClear()
    clearWebSocketSession.mockClear()
  })

  test('releases the isolated tool-context owner after completion without a transcript ID', async () => {
    await runForkedAgentWithOwner()

    expect(releaseCodexLease).toHaveBeenCalledWith('tool-context-owner')
    expect(clearWebSocketSession).toHaveBeenCalledWith(
      `${getSessionId()}/tool-context-owner`,
    )
  })

  test('releases the isolated tool-context owner when the query fails', async () => {
    queryError = new Error('query failed')

    await expect(runForkedAgentWithOwner()).rejects.toThrow('query failed')

    expect(releaseCodexLease).toHaveBeenCalledWith('tool-context-owner')
    expect(clearWebSocketSession).toHaveBeenCalledWith(
      `${getSessionId()}/tool-context-owner`,
    )
  })
})
