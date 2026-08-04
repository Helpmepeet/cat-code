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
import { SidecarServer, type SidecarSocketLike } from './sidecarServer.js'
import { FrameDecoder, encodeFrame } from '../shared/framing.js'
import { MAX_FRAME_BYTES } from '../shared/limits.js'
import {
  PROTOCOL_VERSION,
  type ClientFrame,
  type ContextBreakdownSnapshot,
  type ServerFrame,
} from '../shared/protocol.js'
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

function makeServer(contextBreakdown?: SidecarContextBreakdownDomain) {
  const server = new SidecarServer({
    sessionId: SESSION,
    engineSessionId: ENGINE_SESSION,
    controller: new AppSessionController(probeAdapter()),
    ...(contextBreakdown ? { contextBreakdown } : {}),
    log: () => {},
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
  const beforeCalls = calls()
  received.length = 0

  server.handleData(
    connection,
    clientFrame({ type: 'context-breakdown.request', requestId: 'req-1' }),
  )
  await flush()

  expect(calls()).toBe(beforeCalls + 1)
  const snapshot = received.find(f => f.kind === 'context-breakdown.snapshot')
  expect(snapshot).toBeDefined()
  expect(
    (snapshot as Extract<ServerFrame, { kind: 'context-breakdown.snapshot' }>)
      .breakdown,
  ).toEqual(BREAKDOWN)
  expect(received.find(f => f.kind === 'error')).toBeUndefined()
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

  // The attach analysis is in flight; the three requests collapse into ONE rerun.
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
