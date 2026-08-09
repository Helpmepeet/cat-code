import { afterEach, describe, expect, mock, test } from 'bun:test'

import type { PermissionContext } from '../PermissionContext.js'
import {
  clearAllPendingCallbacks,
  hasPermissionCallback,
} from '../../useSwarmPermissionPoller.js'

const actualAgentSwarms = await import('../../../utils/agentSwarmsEnabled.js')
mock.module('../../../utils/agentSwarmsEnabled.js', () => ({
  ...actualAgentSwarms,
  isAgentSwarmsEnabled: () => true,
}))

const actualPermissionSync = await import(
  '../../../utils/swarm/permissionSync.js'
)
mock.module('../../../utils/swarm/permissionSync.js', () => ({
  ...actualPermissionSync,
  createPermissionRequest: () => ({ id: 'failed-permission-delivery' }),
  isSwarmWorker: () => true,
  sendPermissionRequestViaMailbox: async () => false,
}))

const { handleSwarmWorkerPermission } = await import(
  './swarmWorkerHandler.js'
)

afterEach(() => {
  clearAllPendingCallbacks()
})

describe('handleSwarmWorkerPermission', () => {
  test('settles and cleans up when the permission request cannot reach the leader', async () => {
    const abortController = new AbortController()
    let appState = { pendingWorkerRequest: undefined as unknown }
    const cancelAndAbort = mock((feedback?: string) => ({
      behavior: 'ask' as const,
      message: feedback ?? 'cancelled',
    }))
    const ctx = {
      tool: { name: 'Bash' },
      toolUseID: 'tool-use-1',
      input: { command: 'pwd' },
      toolUseContext: {
        abortController,
        setAppState: (updater: (state: typeof appState) => typeof appState) => {
          appState = updater(appState)
        },
      },
      cancelAndAbort,
      handleUserAllow: async () => ({ behavior: 'allow' as const }),
      logCancelled: () => {},
      logDecision: () => {},
    } as unknown as PermissionContext

    const decision = await handleSwarmWorkerPermission({
      ctx,
      description: 'Run pwd',
      updatedInput: undefined,
      suggestions: undefined,
    })

    expect(decision).toEqual({
      behavior: 'ask',
      message: 'Permission request could not be delivered to the team leader.',
    })
    expect(cancelAndAbort).toHaveBeenCalledWith(
      'Permission request could not be delivered to the team leader.',
    )
    expect(appState.pendingWorkerRequest).toBeNull()
    expect(hasPermissionCallback('failed-permission-delivery')).toBe(false)
  })
})
