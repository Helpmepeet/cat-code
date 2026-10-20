import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

import {
  getCodexLeaseForOwner,
  resetCodexLeaseManagerForTest,
  seedCodexLeaseForTest,
} from '../services/api/codexAccountLeaseManager.js'
import type { ToolUseContext } from '../Tool.js'
import { createFileStateCacheWithSizeLimit } from './fileStateCache.js'
import type { CacheSafeParams } from './forkedAgent.js'
import { asSystemPrompt } from './systemPromptType.js'

let queryError: Error | undefined
let lastQueryParams: { maxTurns?: number } | undefined
let onQuery: ((context: ToolUseContext) => void) | undefined
let queryStubActive = false

const actualQuery = await import('../query.js')
const realQuery = actualQuery.query
const realQueryNamespace = { ...actualQuery }

mock.module('../query.js', () => {
  const query = mock(async function* (
    params: { maxTurns?: number; toolUseContext: ToolUseContext },
  ) {
    if (!queryStubActive) {
      yield* realQuery(params as never)
      return
    }
    lastQueryParams = params
    onQuery?.(params.toolUseContext)
    if (queryError) {
      throw queryError
    }
  })
  return { ...realQueryNamespace, query }
})

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
    systemPrompt: asSystemPrompt([]),
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

describe('runForkedAgent turn cap', () => {
  beforeEach(() => {
    queryStubActive = true
  })

  afterEach(() => {
    queryStubActive = false
    lastQueryParams = undefined
    resetCodexLeaseManagerForTest()
    mock.restore()
  })

  // The background forks (agent summary, prompt suggestion, session memory,
  // auto dream) deny tool calls via canUseTool. A denial returns a tool_result
  // and re-enters the query loop, and query() bounds turns ONLY when maxTurns
  // is set, so these forks depend on maxTurns actually reaching query(). If it
  // is dropped in between, every one of them silently becomes unbounded again.
  test('forwards maxTurns to query', async () => {
    const { runForkedAgent } = await import('./forkedAgent.js')
    await runForkedAgent({
      promptMessages: [],
      cacheSafeParams: createCacheSafeParams(),
      canUseTool: async () => ({ behavior: 'allow', updatedInput: {} }),
      querySource: 'session_memory',
      forkLabel: 'test',
      skipTranscript: true,
      maxTurns: 5,
    })

    expect(lastQueryParams?.maxTurns).toBe(5)
  })

  test('leaves maxTurns undefined when the caller omits it', async () => {
    await runForkedAgentWithOwner()

    expect(lastQueryParams?.maxTurns).toBeUndefined()
  })
})

describe('runForkedAgent Codex resource cleanup', () => {
  beforeEach(() => {
    queryStubActive = true
  })

  afterEach(() => {
    queryStubActive = false
    queryError = undefined
    onQuery = undefined
    resetCodexLeaseManagerForTest()
    mock.restore()
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

  for (const fails of [false, true]) {
    test(`clears only owned skill hooks when a cache-sharing fork ${fails ? 'fails' : 'completes'}`, async () => {
      const { runForkedAgent } = await import('./forkedAgent.js')
      const { registerSkillHooks } = await import('./hooks/registerSkillHooks.js')
      const { getDefaultAppState } = await import('../state/AppStateStore.js')
      const params = createCacheSafeParams()
      let app = getDefaultAppState()
      const setAppState = (update: (prev: typeof app) => typeof app) => { app = update(app) }
      params.toolUseContext.getAppState = () => app
      params.toolUseContext.setAppState = setAppState
      const hooks = { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command' as const, command: 'echo guard' }] }] }
      registerSkillHooks(setAppState, 'parent', hooks, 'guard')
      registerSkillHooks(setAppState, 'other-worker', hooks, 'guard')
      onQuery = context => {
        registerSkillHooks(context.setAppStateForTasks!, context.agentId!, hooks, 'guard')
        expect(app.sessionHooks.has('owned-worker')).toBe(true)
      }
      queryError = fails ? new Error('fork failed') : undefined
      const run = runForkedAgent({
        promptMessages: [], cacheSafeParams: params,
        canUseTool: async () => ({ behavior: 'deny', message: 'Unexpected tool', decisionReason: { type: 'other', reason: 'Unexpected tool' } }),
        querySource: 'session_memory', forkLabel: 'hook-cleanup',
        overrides: { agentId: 'owned-worker' as never }, skipTranscript: true, maxTurns: 5,
      })
      if (fails) await expect(run).rejects.toThrow('fork failed')
      else await run
      expect([...app.sessionHooks.keys()]).toEqual(['parent', 'other-worker'])
    })
  }
})
