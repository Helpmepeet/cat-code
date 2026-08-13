import { afterEach, describe, expect, mock, test } from 'bun:test'

import {
  getCodexLeaseForOwner,
  resetCodexLeaseManagerForTest,
  seedCodexLeaseForTest,
} from '../services/api/codexAccountLeaseManager.js'
import type { ToolUseContext } from '../Tool.js'
import { createFileStateCacheWithSizeLimit } from './fileStateCache.js'
import type { CacheSafeParams } from './forkedAgent.js'

let queryError: Error | undefined

mock.module('../query.js', () => ({
  query: mock(async function* () {
    if (queryError) {
      throw queryError
    }
  }),
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
    resetCodexLeaseManagerForTest()
  })

  test('releases the isolated tool-context owner after completion without a transcript ID', async () => {
    seedCodexLeaseForTest({
      ownerId: 'tool-context-owner',
      ownerType: 'subagent',
      ownerLabel: 'Forked agent',
      accountId: 'account-a',
    })
    await runForkedAgentWithOwner()

    expect(getCodexLeaseForOwner('tool-context-owner')).toBeUndefined()
  })

  test('releases the isolated tool-context owner when the query fails', async () => {
    queryError = new Error('query failed')
    seedCodexLeaseForTest({
      ownerId: 'tool-context-owner',
      ownerType: 'subagent',
      ownerLabel: 'Forked agent',
      accountId: 'account-a',
    })

    await expect(runForkedAgentWithOwner()).rejects.toThrow('query failed')

    expect(getCodexLeaseForOwner('tool-context-owner')).toBeUndefined()
  })
})
