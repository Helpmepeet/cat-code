/**
 * Boundary tests for the `context-breakdown.request` inbound frame
 * (SECURITY-MINIMUM §2 R2: every new inbound kind is validated AT THE SIDECAR,
 * with a test that both accepts a valid frame and rejects invalid ones).
 *
 * Lives in its own file rather than `sidecarServer.test.ts` because that suite's
 * `makeServer` helper is a 15-deep positional signature; a request that needs
 * only the breakdown domain is clearer constructed directly.
 *
 * What acceptance actually decides is narrow, and that is the point of the frame:
 * it carries no renderer-authored state, so a valid frame chooses only WHETHER to
 * spend the analysis, never what the analysis reads.
 */
import { afterEach, expect, test } from 'bun:test'
import { AppSessionController } from '../../src/app-runtime/AppSessionController.js'
import type { AppSessionControllerAdapter } from '../../src/app-runtime/AppSessionController.js'
import type { AppSessionEvent } from '../../src/app-runtime/sessionEvents.js'
import { SidecarServer, type SidecarSocketLike } from './sidecarServer.js'
import { FrameDecoder, encodeFrame } from '../shared/framing.js'
import { MAX_FRAME_BYTES } from '../shared/limits.js'
import {
  PROTOCOL_VERSION,
  type ClientFrame,
  type ContextBreakdownSnapshot,
  type ServerFrame,
  type SessionId,
} from '../shared/protocol.js'
import {
  createContextBreakdownState,
  reduceContextBreakdownState,
  selectContextBreakdown,
} from '../renderer/src/contextBreakdownState.js'
import { getDefaultAppState } from '../../src/state/AppStateStore.js'
import type { SDKMessage } from '../shared/engine-types.snapshot.js'
import type { SidecarContextBreakdownDomain } from './contextBreakdownDomain.js'

const SESSION = 'test-session'
const ENGINE_SESSION = 'engine-test-session'

const BREAKDOWN: ContextBreakdownSnapshot = {
  categories: [
    { label: 'System prompt', tokens: 4_200, colorKey: 'promptBorder', deferred: false },
  ],
  usedTokens: 4_200,
  freeTokens: 195_800,
  contextWindow: 200_000,
  model: 'gpt-5.6-luna',
}

let servers: SidecarServer[] = []
afterEach(() => {
  for (const server of servers) server.close()
  servers = []
})

function makeSocket() {
  const decoder = new FrameDecoder(MAX_FRAME_BYTES)
  const received: ServerFrame[] = []
  const socket: SidecarSocketLike = {
    write(data) {
      for (const result of decoder.push(Buffer.from(data))) {
        if (result.kind === 'frame') received.push(result.payload as ServerFrame)
      }
    },
    end() {},
  }
  return { socket, received }
}

function probeAdapter(): AppSessionControllerAdapter {
  return {
    // eslint-disable-next-line require-yield
    async *runTurn() {
      return
    },
  }
}

class TestSessionController {
  private readonly listeners = new Set<(event: AppSessionEvent) => void>()
  subscribe(listener: (event: AppSessionEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  emit(event: AppSessionEvent): void {
    for (const listener of this.listeners) listener(event)
  }
  getAbortState() {
    return { status: 'idle' as const }
  }
  getGoalSnapshot() {
    return null
  }
  getPendingPermissionRequests() {
    return []
  }
  isTurnActive() {
    return false
  }
  waitUntilIdle() {
    return Promise.resolve()
  }
  abort() {}
}

function makeServer(
  contextBreakdown?: SidecarContextBreakdownDomain,
  overrides?: Partial<ConstructorParameters<typeof SidecarServer>[0]>,
) {
  const server = new SidecarServer({
    sessionId: SESSION,
    engineSessionId: ENGINE_SESSION,
    controller: new AppSessionController(probeAdapter()),
    ...(contextBreakdown ? { contextBreakdown } : {}),
    log: () => {},
    ...overrides,
  })
  servers.push(server)
  return server
}

function clientFrame(message: unknown): Buffer {
  return encodeFrame({
    protocolVersion: PROTOCOL_VERSION,
    sessionId: SESSION,
    message,
  } as ClientFrame)
}

/** Domain that records how many analyses were actually asked for. */
function countingDomain(
  result: ContextBreakdownSnapshot | null = BREAKDOWN,
): { domain: SidecarContextBreakdownDomain; calls: () => number } {
  let calls = 0
  return {
    domain: {
      snapshot: async () => {
        calls++
        return result
      },
    },
    calls: () => calls,
  }
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

test('accepts a valid request and answers with a context-breakdown.snapshot', async () => {
  const { domain, calls } = countingDomain()
  const server = makeServer(domain)
  const { socket, received } = makeSocket()
  const connection = server.addConnection(socket)
  await flush()
  expect(calls()).toBe(0)
  received.length = 0

  server.handleData(
    connection,
    clientFrame({ type: 'context-breakdown.request', requestId: 'req-1' }),
  )
  await flush()

  expect(calls()).toBe(1)
  const snapshot = received.find(f => f.kind === 'context-breakdown.snapshot')
  expect(snapshot).toBeDefined()
  expect(
    (snapshot as Extract<ServerFrame, { kind: 'context-breakdown.snapshot' }>)
      .breakdown,
  ).toEqual(BREAKDOWN)
  expect(received.find(f => f.kind === 'error')).toBeUndefined()
})

// The freshness floor: the analysis costs a whole-transcript read plus ~10 token
// counts, and the numbers only move when a turn completes, so a reopen moments
// later is answered from the last snapshot rather than recomputed.
test('a request inside the freshness floor is answered without recomputing', async () => {
  const { domain, calls } = countingDomain()
  const server = makeServer(domain)
  const { socket, received } = makeSocket()
  const connection = server.addConnection(socket)
  await flush()
  expect(calls()).toBe(0)

  server.handleData(
    connection,
    clientFrame({ type: 'context-breakdown.request', requestId: 'initial' }),
  )
  await flush()
  const afterInitialRequest = calls()
  expect(afterInitialRequest).toBe(1)
  received.length = 0

  for (let i = 0; i < 5; i++) {
    server.handleData(
      connection,
      clientFrame({ type: 'context-breakdown.request', requestId: `req-${i}` }),
    )
  }
  await flush()

  // Every request uses the first click's snapshot.
  expect(calls()).toBe(afterInitialRequest)
  expect(
    received.filter(f => f.kind === 'context-breakdown.snapshot'),
  ).toHaveLength(5)
})

test('a failed analysis neither caches nor strands the next request', async () => {
  let calls = 0
  const domain: SidecarContextBreakdownDomain = {
    snapshot: async () => {
      calls++
      if (calls === 1) throw new Error('transcript temporarily unavailable')
      return BREAKDOWN
    },
  }
  const server = makeServer(domain)
  const { socket, received } = makeSocket()
  const connection = server.addConnection(socket)
  await flush()
  expect(calls).toBe(0)

  server.handleData(
    connection,
    clientFrame({ type: 'context-breakdown.request', requestId: 'initial' }),
  )
  await flush()

  // A failed click analysis leaves no cache or error frame and does not strand retry.
  expect(calls).toBe(1)
  expect(received.find(f => f.kind === 'context-breakdown.snapshot')).toBeUndefined()
  expect(received.find(f => f.kind === 'error')).toBeUndefined()

  server.handleData(
    connection,
    clientFrame({ type: 'context-breakdown.request', requestId: 'retry-1' }),
  )
  await flush()

  expect(calls).toBe(2)
  expect(received.find(f => f.kind === 'context-breakdown.snapshot')).toBeDefined()
})

// Fail closed: a malformed frame must not reach the (expensive) analysis.
test('rejects malformed requests without running the analysis', async () => {
  const { domain, calls } = countingDomain()
  const server = makeServer(domain)
  const { socket } = makeSocket()
  const connection = server.addConnection(socket)
  await flush()
  const beforeCalls = calls()

  const invalid: unknown[] = [
    // Missing requestId.
    { type: 'context-breakdown.request' },
    // Empty requestId.
    { type: 'context-breakdown.request', requestId: '' },
    // Non-string requestId.
    { type: 'context-breakdown.request', requestId: 42 },
    // requestId over the text cap.
    { type: 'context-breakdown.request', requestId: 'x'.repeat(100_000) },
    // Right shape, wrong verb — must not fall through to this handler.
    { type: 'context-breakdown.refresh', requestId: 'req-1' },
  ]
  for (const message of invalid) {
    server.handleData(connection, clientFrame(message))
  }
  await flush()

  expect(calls()).toBe(beforeCalls)
})

test('an unallowlisted neighbouring type is not accepted by this handler', async () => {
  const { domain, calls } = countingDomain()
  const server = makeServer(domain)
  const { socket, received } = makeSocket()
  const connection = server.addConnection(socket)
  await flush()
  const beforeCalls = calls()
  received.length = 0

  server.handleData(
    connection,
    clientFrame({ type: 'context-breakdown', requestId: 'req-1' }),
  )
  await flush()

  expect(calls()).toBe(beforeCalls)
  // Unknown vocabulary is refused by the allowlist, not silently ignored.
  expect(received.find(f => f.kind === 'error')).toBeDefined()
})

// The analysis is expensive, so a renderer that spams the popover must not be
// able to multiply the work: overlapping requests coalesce.
test('overlapping requests coalesce instead of stacking analyses', async () => {
  let calls = 0
  let release: () => void = () => {}
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  const domain: SidecarContextBreakdownDomain = {
    snapshot: async () => {
      calls++
      await gate
      return BREAKDOWN
    },
  }
  const server = makeServer(domain)
  const { socket } = makeSocket()
  const connection = server.addConnection(socket)
  await flush()

  const frame = clientFrame({
    type: 'context-breakdown.request',
    requestId: 'req-1',
  })
  server.handleData(connection, frame)
  server.handleData(connection, frame)
  server.handleData(connection, frame)
  await flush()

  // The first request is in flight; the three requests collapse into one rerun.
  expect(calls).toBe(1)
  release()
  await flush()
  await flush()
  expect(calls).toBe(2)
})

test('a session with no breakdown domain ignores the request without erroring', async () => {
  const server = makeServer()
  const { socket, received } = makeSocket()
  const connection = server.addConnection(socket)
  await flush()
  received.length = 0

  server.handleData(
    connection,
    clientFrame({ type: 'context-breakdown.request', requestId: 'req-1' }),
  )
  await flush()

  expect(received.find(f => f.kind === 'context-breakdown.snapshot')).toBeUndefined()
  expect(received.find(f => f.kind === 'error')).toBeUndefined()
})

test('turn boundary or compact boundary invalidation bypasses the 15-second freshness floor', async () => {
  const { domain, calls } = countingDomain()
  const controller = new TestSessionController()
  const server = makeServer(domain, { controller: controller as unknown as AppSessionController })
  const { socket } = makeSocket()
  const connection = server.addConnection(socket)
  await flush()

  // First request computes snapshot
  server.handleData(
    connection,
    clientFrame({ type: 'context-breakdown.request', requestId: 'req-1' }),
  )
  await flush()
  expect(calls()).toBe(1)

  // Immediate second request uses cache
  server.handleData(
    connection,
    clientFrame({ type: 'context-breakdown.request', requestId: 'req-2' }),
  )
  await flush()
  expect(calls()).toBe(1)

  // Turn status invalidation event occurs
  controller.emit({ type: 'turn.status', activeTurn: true })
  await flush()

  // Third request recomputes, bypassing freshness floor
  server.handleData(
    connection,
    clientFrame({ type: 'context-breakdown.request', requestId: 'req-3' }),
  )
  await flush()
  expect(calls()).toBe(2)

  // Compact boundary invalidation
  controller.emit({
    type: 'message',
    message: {
      type: 'system',
      subtype: 'compact_boundary',
      parent_tool_use_id: null,
    } as unknown as SDKMessage,
  })
  await flush()

  // Fourth request recomputes again
  server.handleData(
    connection,
    clientFrame({ type: 'context-breakdown.request', requestId: 'req-4' }),
  )
  await flush()
  expect(calls()).toBe(3)
})

test('generation counter discards in-flight analysis if invalidated while computing', async () => {
  let calls = 0
  let resolveSnapshot: ((val: ContextBreakdownSnapshot) => void) | null = null
  const domain: SidecarContextBreakdownDomain = {
    snapshot: async () => {
      calls++
      return new Promise<ContextBreakdownSnapshot>(resolve => {
        resolveSnapshot = resolve
      })
    },
  }
  const controller = new TestSessionController()
  const server = makeServer(domain, { controller: controller as unknown as AppSessionController })
  const { socket, received } = makeSocket()
  const connection = server.addConnection(socket)
  await flush()
  received.length = 0

  // Start request 1 (in-flight)
  server.handleData(
    connection,
    clientFrame({ type: 'context-breakdown.request', requestId: 'req-1' }),
  )
  await flush()
  expect(calls).toBe(1)
  expect(resolveSnapshot).toBeDefined()

  // Invalidation occurs while request 1 is still computing
  controller.emit({ type: 'turn.status', activeTurn: true })
  await flush()

  // Resolve the first snapshot with stale data
  const STALE_BREAKDOWN = { ...BREAKDOWN, usedTokens: 10_000 }
  resolveSnapshot!(STALE_BREAKDOWN)
  await flush()

  // The stale snapshot must be discarded: not broadcast, not cached
  expect(received.find(f => f.kind === 'context-breakdown.snapshot')).toBeUndefined()

  // Next request recomputes because generation mismatch discarded the stale snapshot
  server.handleData(
    connection,
    clientFrame({ type: 'context-breakdown.request', requestId: 'req-2' }),
  )
  await flush()
  expect(calls).toBe(2)

  // Fresh snapshot resolves
  const FRESH_BREAKDOWN = { ...BREAKDOWN, usedTokens: 20_000 }
  resolveSnapshot!(FRESH_BREAKDOWN)
  await flush()

  const snapshotFrame = received.find(f => f.kind === 'context-breakdown.snapshot') as Extract<
    ServerFrame,
    { kind: 'context-breakdown.snapshot' }
  >
  expect(snapshotFrame).toBeDefined()
  expect(snapshotFrame.breakdown).toEqual(FRESH_BREAKDOWN)
})

test('permission mode change or idle edit-from-message invalidates cached breakdown', async () => {
  const { domain, calls } = countingDomain()
  let permMode = 'ask'
  const permListeners = new Set<(ctx: { mode: string }) => void>()
  const permissions = {
    getToolPermissionContext: () => ({
      ...getDefaultAppState().toolPermissionContext,
      mode: permMode as any,
    }),
    subscribeToolPermissionContext: (cb: (ctx: { mode: string }) => void) => {
      permListeners.add(cb)
      return () => permListeners.delete(cb)
    },
    getDisplayFacts: () => ({
      managedRulesOnly: false,
      permissionClassifierEnabled: false,
    }),
  }

  let editCalls = 0
  const sessionActions = {
    selectUserMessage: (_id: string) => ({ ok: true as const, selectedPrompt: 'hello' }),
    editFromMessage: async (_id: string) => {
      editCalls++
      return { ok: true as const, retainedMessages: [] }
    },
    branchFromMessage: async () => ({ ok: true as const, forkedSessionId: 'fork-1' }),
  }

  const server = makeServer(domain, {
    permissions: permissions as any,
    sessionActions: sessionActions as any,
    projectHistory: async () => ({ history: [], truncated: false }),
  })
  const { socket } = makeSocket()
  const connection = server.addConnection(socket)
  await flush()

  // Initial request
  server.handleData(
    connection,
    clientFrame({ type: 'context-breakdown.request', requestId: 'req-1' }),
  )
  await flush()
  expect(calls()).toBe(1)

  // Immediate retry is cached
  server.handleData(
    connection,
    clientFrame({ type: 'context-breakdown.request', requestId: 'req-2' }),
  )
  await flush()
  expect(calls()).toBe(1)

  // Permission mode changes
  permMode = 'auto'
  for (const listener of permListeners) {
    listener({ ...getDefaultAppState().toolPermissionContext, mode: 'auto' as any })
  }
  await flush()

  // Third request recomputes
  server.handleData(
    connection,
    clientFrame({ type: 'context-breakdown.request', requestId: 'req-3' }),
  )
  await flush()
  expect(calls()).toBe(2)

  // Idle edit-from-message arrives
  server.handleData(
    connection,
    clientFrame({
      type: 'session.editFromMessage',
      requestId: 'edit-1',
      userMessageId: '11111111-2222-3333-4444-555555555555',
    }),
  )
  await flush()
  expect(editCalls).toBe(1)

  // Fourth request recomputes after editFromMessage
  server.handleData(
    connection,
    clientFrame({ type: 'context-breakdown.request', requestId: 'req-4' }),
  )
  await flush()
  expect(calls()).toBe(3)
})

test('failed analysis cannot resurrect old data after invalidation', async () => {
  let calls = 0
  let shouldFail = false
  const domain: SidecarContextBreakdownDomain = {
    snapshot: async () => {
      calls++
      if (shouldFail) throw new Error('Analysis failed')
      return BREAKDOWN
    },
  }
  const controller = new TestSessionController()
  const server = makeServer(domain, { controller: controller as unknown as AppSessionController })
  const { socket, received } = makeSocket()
  const connection = server.addConnection(socket)
  await flush()

  // First request succeeds
  server.handleData(
    connection,
    clientFrame({ type: 'context-breakdown.request', requestId: 'req-1' }),
  )
  await flush()
  expect(calls).toBe(1)
  expect(received.filter(f => f.kind === 'context-breakdown.snapshot')).toHaveLength(1)
  received.length = 0

  // Invalidation occurs
  controller.emit({ type: 'turn.status', activeTurn: false })
  await flush()

  // Second request fails
  shouldFail = true
  server.handleData(
    connection,
    clientFrame({ type: 'context-breakdown.request', requestId: 'req-2' }),
  )
  await flush()
  expect(calls).toBe(2)
  // No snapshot sent, old data was not resurrected
  expect(received.filter(f => f.kind === 'context-breakdown.snapshot')).toHaveLength(0)

  // Third request succeeds again
  shouldFail = false
  server.handleData(
    connection,
    clientFrame({ type: 'context-breakdown.request', requestId: 'req-3' }),
  )
  await flush()
  expect(calls).toBe(3)
  expect(received.filter(f => f.kind === 'context-breakdown.snapshot')).toHaveLength(1)
})

test('in-flight breakdown analysis is discarded if permission mode changes before it resolves', async () => {
  let calls = 0
  let resolveSnapshot: ((val: ContextBreakdownSnapshot) => void) | null = null
  const domain: SidecarContextBreakdownDomain = {
    snapshot: async () => {
      calls++
      return new Promise<ContextBreakdownSnapshot>(resolve => {
        resolveSnapshot = resolve
      })
    },
  }
  let permMode = 'ask'
  const permListeners = new Set<(ctx: { mode: string }) => void>()
  const permissions = {
    getToolPermissionContext: () => ({
      ...getDefaultAppState().toolPermissionContext,
      mode: permMode as any,
    }),
    subscribeToolPermissionContext: (cb: (ctx: { mode: string }) => void) => {
      permListeners.add(cb)
      return () => permListeners.delete(cb)
    },
    getDisplayFacts: () => ({
      managedRulesOnly: false,
      permissionClassifierEnabled: false,
    }),
  }

  const server = makeServer(domain, { permissions: permissions as any })
  const { socket, received } = makeSocket()
  const connection = server.addConnection(socket)
  await flush()
  received.length = 0

  // Start request 1 (in-flight)
  server.handleData(
    connection,
    clientFrame({ type: 'context-breakdown.request', requestId: 'req-1' }),
  )
  await flush()
  expect(calls).toBe(1)
  expect(resolveSnapshot).toBeDefined()

  // Permission mode changes while in flight
  permMode = 'auto'
  for (const listener of permListeners) {
    listener({ ...getDefaultAppState().toolPermissionContext, mode: 'auto' as any })
  }
  await flush()

  // Resolve request 1 with stale data
  const STALE_BREAKDOWN = { ...BREAKDOWN, usedTokens: 11_000 }
  resolveSnapshot!(STALE_BREAKDOWN)
  await flush()

  // Stale snapshot must NOT be broadcast
  expect(received.find(f => f.kind === 'context-breakdown.snapshot')).toBeUndefined()

  // Next request runs fresh analysis
  server.handleData(
    connection,
    clientFrame({ type: 'context-breakdown.request', requestId: 'req-2' }),
  )
  await flush()
  expect(calls).toBe(2)

  const FRESH_BREAKDOWN = { ...BREAKDOWN, usedTokens: 22_000 }
  resolveSnapshot!(FRESH_BREAKDOWN)
  await flush()

  const snapshotFrame = received.find(f => f.kind === 'context-breakdown.snapshot') as Extract<
    ServerFrame,
    { kind: 'context-breakdown.snapshot' }
  >
  expect(snapshotFrame).toBeDefined()
  expect(snapshotFrame.breakdown).toEqual(FRESH_BREAKDOWN)
})

test('in-flight breakdown analysis is discarded if idle editFromMessage succeeds before it resolves', async () => {
  let calls = 0
  let resolveSnapshot: ((val: ContextBreakdownSnapshot) => void) | null = null
  const domain: SidecarContextBreakdownDomain = {
    snapshot: async () => {
      calls++
      return new Promise<ContextBreakdownSnapshot>(resolve => {
        resolveSnapshot = resolve
      })
    },
  }
  const sessionActions = {
    selectUserMessage: (_id: string) => ({ ok: true as const, selectedPrompt: 'hello' }),
    editFromMessage: async (_id: string) => ({ ok: true as const, retainedMessages: [] }),
    branchFromMessage: async () => ({ ok: true as const, forkedSessionId: 'fork-1' }),
  }

  const server = makeServer(domain, {
    sessionActions: sessionActions as any,
    projectHistory: async () => ({ history: [], truncated: false }),
  })
  const { socket, received } = makeSocket()
  const connection = server.addConnection(socket)
  await flush()
  received.length = 0

  // Start request 1 (in-flight)
  server.handleData(
    connection,
    clientFrame({ type: 'context-breakdown.request', requestId: 'req-1' }),
  )
  await flush()
  expect(calls).toBe(1)
  expect(resolveSnapshot).toBeDefined()

  // Idle editFromMessage succeeds while request 1 is in-flight
  server.handleData(
    connection,
    clientFrame({
      type: 'session.editFromMessage',
      requestId: 'edit-1',
      userMessageId: '11111111-2222-3333-4444-555555555555',
    }),
  )
  await flush()

  // Resolve request 1 with stale data
  const STALE_BREAKDOWN = { ...BREAKDOWN, usedTokens: 12_000 }
  resolveSnapshot!(STALE_BREAKDOWN)
  await flush()

  // Stale snapshot must NOT be broadcast
  expect(received.find(f => f.kind === 'context-breakdown.snapshot')).toBeUndefined()

  // Next request runs fresh analysis
  server.handleData(
    connection,
    clientFrame({ type: 'context-breakdown.request', requestId: 'req-2' }),
  )
  await flush()
  expect(calls).toBe(2)

  const FRESH_BREAKDOWN = { ...BREAKDOWN, usedTokens: 24_000 }
  resolveSnapshot!(FRESH_BREAKDOWN)
  await flush()

  const snapshotFrame = received.find(f => f.kind === 'context-breakdown.snapshot') as Extract<
    ServerFrame,
    { kind: 'context-breakdown.snapshot' }
  >
  expect(snapshotFrame).toBeDefined()
  expect(snapshotFrame.breakdown).toEqual(FRESH_BREAKDOWN)
})

test('idle edit succeeds -> projection fails -> renderer breakdown becomes unavailable', async () => {
  const { domain } = countingDomain()
  const sessionActions = {
    selectUserMessage: (_id: string) => ({ ok: true as const, selectedPrompt: 'hello' }),
    editFromMessage: async (_id: string) => ({ ok: true as const, retainedMessages: [] }),
    branchFromMessage: async () => ({ ok: true as const, forkedSessionId: 'fork-1' }),
  }

  const server = makeServer(domain, {
    sessionActions: sessionActions as any,
    projectHistory: async () => {
      throw new Error('History projection failed')
    },
  })
  const { socket, received } = makeSocket()
  const connection = server.addConnection(socket)
  await flush()

  // Renderer state begins with a cached breakdown for this session
  let rendererState = reduceContextBreakdownState(createContextBreakdownState(), {
    type: 'frame',
    frame: {
      kind: 'context-breakdown.snapshot',
      protocolVersion: PROTOCOL_VERSION,
      sessionId: SESSION as SessionId,
      breakdown: BREAKDOWN,
    },
  })
  expect(selectContextBreakdown(rendererState, SESSION as SessionId)).toEqual(BREAKDOWN)

  received.length = 0

  // Idle editFromMessage succeeds in engine, but projectHistory throws
  server.handleData(
    connection,
    clientFrame({
      type: 'session.editFromMessage',
      requestId: 'edit-fail-proj',
      userMessageId: '11111111-2222-3333-4444-555555555555',
    }),
  )
  await flush()

  // Sidecar must broadcast transcript.reset before refusing
  const resetFrame = received.find(f => f.kind === 'transcript.reset')
  expect(resetFrame).toBeDefined()

  const actionResultFrame = received.find(
    f => f.kind === 'session-action.result' && f.verb === 'editFromMessage',
  ) as Extract<ServerFrame, { kind: 'session-action.result' }> | undefined
  expect(actionResultFrame).toBeDefined()
  expect(actionResultFrame?.ok).toBe(false)

  // Pass all broadcast frames to the renderer state
  for (const f of received) {
    rendererState = reduceContextBreakdownState(rendererState, {
      type: 'frame',
      frame: f,
    })
  }

  // Renderer breakdown state is now cleared (unavailable)
  expect(selectContextBreakdown(rendererState, SESSION as SessionId)).toBeNull()
})
