import { afterEach, describe, expect, mock, test } from 'bun:test'

import { getSessionId } from '../../bootstrap/state.js'
import * as realCodexLeaseManager from '../../services/api/codexAccountLeaseManager.js'
import * as realWebSocketTransport from '../../services/api/codex-websocket-transport.js'

const releaseCodexLease = mock(() => {})
const clearWebSocketSession = mock(() => {})

mock.module('../../services/api/codexAccountLeaseManager.js', () => ({
  ...realCodexLeaseManager,
  releaseCodexLease,
}))

mock.module('../../services/api/codex-websocket-transport.js', () => ({
  ...realWebSocketTransport,
  clearWebSocketSession,
}))

describe('releaseSynchronousAgentCodexResources', () => {
  afterEach(() => {
    releaseCodexLease.mockClear()
    clearWebSocketSession.mockClear()
  })

  test('releases the synchronous agent owner and its session-scoped WebSocket', async () => {
    const { releaseSynchronousAgentCodexResources } = await import(
      './AgentTool.js'
    )

    releaseSynchronousAgentCodexResources('sync-agent')

    expect(releaseCodexLease).toHaveBeenCalledWith('sync-agent')
    expect(clearWebSocketSession).toHaveBeenCalledWith(
      `${getSessionId()}/sync-agent`,
    )
  })
})
