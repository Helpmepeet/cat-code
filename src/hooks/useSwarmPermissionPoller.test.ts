import { afterEach, describe, expect, test } from 'bun:test'

import {
  clearAllPendingCallbacks,
  hasPermissionCallback,
  registerPermissionCallback,
  unregisterPermissionCallback,
} from './useSwarmPermissionPoller.js'

afterEach(() => {
  clearAllPendingCallbacks()
})

describe('swarm permission callback registry', () => {
  test('removes an aborted worker request so a late leader reply cannot claim it', () => {
    const requestId = 'permission-aborted-before-response'
    registerPermissionCallback({
      requestId,
      toolUseId: 'tool-use-1',
      onAllow() {},
      onReject() {},
    })

    unregisterPermissionCallback(requestId)

    expect(hasPermissionCallback(requestId)).toBe(false)
  })
})
