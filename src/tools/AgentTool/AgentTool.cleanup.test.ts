import { afterEach, describe, expect, test } from 'bun:test'

import {
  getCodexLeaseForOwner,
  resetCodexLeaseManagerForTest,
  seedCodexLeaseForTest,
} from '../../services/api/codexAccountLeaseManager.js'

describe('releaseSynchronousAgentCodexResources', () => {
  afterEach(() => {
    resetCodexLeaseManagerForTest()
  })

  test('releases the synchronous agent owner', async () => {
    const { releaseSynchronousAgentCodexResources } = await import(
      './AgentTool.js'
    )
    seedCodexLeaseForTest({
      ownerId: 'sync-agent',
      ownerType: 'subagent',
      ownerLabel: 'Synchronous agent',
      accountId: 'account-a',
    })

    releaseSynchronousAgentCodexResources('sync-agent')

    expect(getCodexLeaseForOwner('sync-agent')).toBeUndefined()
  })
})
