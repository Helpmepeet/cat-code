import { afterEach, describe, expect, mock, test } from 'bun:test'

import type { AppState } from '../state/AppState.js'
import type { SetAppState } from '../Task.js'
import type { QueryParams } from '../query.js'
import type { ToolUseContext } from '../Tool.js'
import { asAgentId } from '../types/ids.js'
import type { Message } from '../types/message.js'

let lastQueryParams: QueryParams | undefined

// Capture synchronously: startBackgroundSession calls query() while building
// the for-await head, so an async generator body would not have run yet.
mock.module('../query.js', () => ({
  query: mock((params: QueryParams) => {
    lastQueryParams = params
    return (async function* () {})()
  }),
}))

// Spread the real modules so only the disk-touching entry points are faked —
// both are imported by unrelated modules in this graph.
const realSessionStorage = await import('../utils/sessionStorage.js')
mock.module('../utils/sessionStorage.js', () => ({
  ...realSessionStorage,
  getAgentTranscriptPath: () => '/dev/null',
  recordSidechainTranscript: async () => {},
}))

const realDiskOutput = await import('../utils/task/diskOutput.js')
mock.module('../utils/task/diskOutput.js', () => ({
  ...realDiskOutput,
  initTaskOutputAsSymlink: async () => '/dev/null',
  getTaskOutputPath: () => '/dev/null',
  evictTaskOutput: async () => {},
}))

/**
 * The foreground REPL context: agentId unset and the main-thread querySource,
 * exactly what REPL.tsx hands startBackgroundSession (getToolUseContext plus
 * getQuerySourceForREPL).
 */
function createForegroundQueryParams(): Omit<QueryParams, 'messages'> {
  const toolUseContext = {
    abortController: new AbortController(),
    options: {},
    getAppState: () => ({ toolPermissionContext: {} }),
    setAppState: () => {},
    messages: [],
  } as unknown as ToolUseContext

  return {
    systemPrompt: [],
    userContext: {},
    systemContext: {},
    canUseTool: async () => ({ behavior: 'allow', updatedInput: {} }),
    toolUseContext,
    querySource: 'repl_main_thread',
  } as unknown as Omit<QueryParams, 'messages'>
}

function createSetAppState(): SetAppState {
  let state = { tasks: {} } as unknown as AppState
  return f => {
    state = f(state)
  }
}

/**
 * The drain gate, copied from query.ts (`isMainThread`). A loop that answers
 * true here takes every queued command with `cmd.agentId === undefined` and
 * then removeFromQueue()s it — so two loops answering true race for the user's
 * input.
 */
function drainsAsMainThread(querySource: string): boolean {
  return querySource.startsWith('repl_main_thread') || querySource === 'sdk'
}

/**
 * The Codex lease owner id, from query.ts (registers 'main-thread' when
 * `!toolUseContext.agentId`) and claude.ts getRetryOwnerId (same fallback).
 * Two owners sharing one id share one lease entry, and the first to finish
 * deletes it out from under the other.
 */
function leaseOwnerIdFor(agentId: string | undefined): string {
  return agentId ?? 'main-thread'
}

describe('a backgrounded main session does not impersonate the foreground', () => {
  afterEach(() => {
    lastQueryParams = undefined
  })

  test('the query context carries the task identity, not the main thread', async () => {
    const { startBackgroundSession } = await import('./LocalMainSessionTask.js')
    const foreground = createForegroundQueryParams()

    const taskId = startBackgroundSession({
      messages: [] as Message[],
      queryParams: foreground,
      description: 'backgrounded turn',
      setAppState: createSetAppState(),
    })

    expect(lastQueryParams).toBeDefined()
    expect(lastQueryParams!.toolUseContext.agentId).toBe(asAgentId(taskId))
    expect(lastQueryParams!.querySource).toBe('agent:builtin:main-session')

    // The caller's own context is untouched, so the foreground keeps its
    // identity when it runs again.
    expect(foreground.toolUseContext.agentId).toBeUndefined()
    expect(foreground.querySource).toBe('repl_main_thread')
  })

  test('the drain gate classifies the two loops differently', async () => {
    const { startBackgroundSession } = await import('./LocalMainSessionTask.js')
    const foreground = createForegroundQueryParams()

    startBackgroundSession({
      messages: [] as Message[],
      queryParams: foreground,
      description: 'backgrounded turn',
      setAppState: createSetAppState(),
    })

    expect(drainsAsMainThread(foreground.querySource as string)).toBe(true)
    expect(drainsAsMainThread(lastQueryParams!.querySource as string)).toBe(
      false,
    )
  })

  test('the two loops key the Codex lease to different owners', async () => {
    const { startBackgroundSession } = await import('./LocalMainSessionTask.js')
    const foreground = createForegroundQueryParams()

    startBackgroundSession({
      messages: [] as Message[],
      queryParams: foreground,
      description: 'backgrounded turn',
      setAppState: createSetAppState(),
    })

    const foregroundOwner = leaseOwnerIdFor(foreground.toolUseContext.agentId)
    const backgroundOwner = leaseOwnerIdFor(
      lastQueryParams!.toolUseContext.agentId,
    )

    expect(foregroundOwner).toBe('main-thread')
    expect(backgroundOwner).not.toBe('main-thread')
    expect(backgroundOwner).not.toBe(foregroundOwner)
  })
})
