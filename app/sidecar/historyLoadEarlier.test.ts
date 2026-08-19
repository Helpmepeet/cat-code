/**
 * `history.loadEarlier` — boundary + live-path tests
 * (decisions/HISTORY-LOAD-EARLIER.md).
 *
 * Two halves, deliberately not mixed:
 *
 *  - BOUNDARY (SECURITY-MINIMUM §2 R2/R4). The frame is app-owned inbound
 *    vocabulary, so it gets the same treatment every other one does: a valid
 *    frame is accepted, and an extra property, a wrong-typed session address, a
 *    missing correlation id, and a second concurrent request are each refused.
 *    These use an injected reader because what is under test is the boundary,
 *    not the read.
 *
 *  - LIVE PATH (CLAUDE.md §8 rule 1). A REAL transcript is written to disk and
 *    the server runs with its REAL default reader, so the recovered messages
 *    can only have come from `loadDisplayTranscriptFromJsonlPath` reading that
 *    file: their text is never handed to the server. Delete the loader call in
 *    `historyLoadEarlier.ts` and these fail — the deeper read comes back empty,
 *    the anchor is not found, and the result is a refusal.
 */

import { afterEach, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppSessionController } from '../../src/app-runtime/AppSessionController.js'
import {
  getSessionProjectDir,
  getSessionId,
  switchSession,
} from '../../src/bootstrap/state.js'
import type { SDKMessage } from '../../src/entrypoints/agentSdkTypes.js'
import { asSessionId } from '../../src/types/ids.js'
import { loadDisplayTranscriptFromJsonlPath } from '../../src/utils/sessionStorage.js'
import { FrameDecoder, encodeFrame } from '../shared/framing.js'
import {
  MAX_HISTORY_LOAD_EARLIER_BYTES,
  MAX_OUTBOUND_FRAME_BYTES,
} from '../shared/limits.js'
import {
  PROTOCOL_VERSION,
  type ClientFrame,
  type ServerFrame,
} from '../shared/protocol.js'
import { projectResumedHistory } from './historyProjection.js'
import type { EarlierHistoryRead } from './historyLoadEarlier.js'
import { buildProbeToolUseMessage } from './probeAdapter.js'
import { SidecarServer, type SidecarSocketLike } from './sidecarServer.js'

const SESSION = 'load-earlier-session'
const ENGINE_SESSION = 'engine-load-earlier-session'

/** Decodes at the OUTBOUND cap, like the real supervisor decoder. */
function makeSocket() {
  const decoder = new FrameDecoder(MAX_OUTBOUND_FRAME_BYTES)
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

function frame(message: unknown, sessionId: unknown = SESSION): Buffer {
  return encodeFrame({
    protocolVersion: PROTOCOL_VERSION,
    sessionId,
    message,
  })
}

let servers: SidecarServer[] = []
function makeServer(options: {
  history?: readonly SDKMessage[]
  historySourceTruncated?: boolean
  loadEarlierHistory?: () => Promise<EarlierHistoryRead>
}): SidecarServer {
  const server = new SidecarServer({
    sessionId: SESSION,
    engineSessionId: ENGINE_SESSION,
    controller: new AppSessionController({
      async *runTurn() {
        yield buildProbeToolUseMessage()
      },
    }),
    ...(options.history ? { history: options.history } : {}),
    ...(options.historySourceTruncated
      ? { historySourceTruncated: true }
      : {}),
    ...(options.loadEarlierHistory
      ? { loadEarlierHistory: options.loadEarlierHistory }
      : {}),
    log: () => {},
  })
  servers.push(server)
  return server
}

let tempDirs: string[] = []
let restoreSession: (() => void) | null = null

afterEach(() => {
  for (const server of servers) server.close()
  servers = []
  restoreSession?.()
  restoreSession = null
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
  tempDirs = []
})

/* ------------------------------------------------------------------------- *
 * Boundary
 * ------------------------------------------------------------------------- */

/** A restored user message in the shape `toSDKMessages` emits. */
function historyMessage(uuid: string, text: string): SDKMessage {
  return {
    type: 'user',
    message: { role: 'user', content: text },
    session_id: ENGINE_SESSION,
    parent_tool_use_id: null,
    uuid,
    timestamp: '2026-08-19T00:00:00.000Z',
    isSynthetic: false,
  } as unknown as SDKMessage
}

function results(received: ServerFrame[]) {
  return received.filter(f => f.kind === 'history.loadEarlier.result')
}

function errors(received: ServerFrame[]) {
  return received.filter(f => f.kind === 'error')
}

/**
 * The live path is genuinely asynchronous (a real file read), so poll for the
 * answer instead of guessing a sleep. A fixed sleep here is a flake: the first
 * read in a process pays module-load cost the later ones do not.
 */
async function waitForResult(
  received: ServerFrame[],
  requestId: string,
  timeoutMs = 20_000,
): Promise<ServerFrame> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = results(received).find(
      f => (f as { requestId: string }).requestId === requestId,
    )
    if (found) return found
    if (Date.now() > deadline) {
      throw new Error(`no history.loadEarlier.result for ${requestId}`)
    }
    await Bun.sleep(5)
  }
}

test('a valid history.loadEarlier frame is accepted and answered', async () => {
  const older = historyMessage('older-1', 'recovered')
  const anchor = historyMessage('anchor-1', 'on screen')
  const server = makeServer({
    history: [anchor],
    historySourceTruncated: true,
    loadEarlierHistory: async () => ({
      messages: [older, anchor],
      truncated: false,
    }),
  })
  const { socket, received } = makeSocket()
  const connection = server.addConnection(socket)
  // The attach-time truncation notice is not this verb's answer; start after it.
  const attached = received.length

  server.handleData(
    connection,
    frame({ type: 'history.loadEarlier', requestId: 'req-1' }),
  )
  await Bun.sleep(0)

  expect(errors(received.slice(attached))).toHaveLength(0)
  expect(results(received)).toEqual([
    {
      kind: 'history.loadEarlier.result',
      protocolVersion: PROTOCOL_VERSION,
      sessionId: SESSION,
      requestId: 'req-1',
      ok: true,
      message: 'Earlier messages loaded.',
      added: 1,
      complete: true,
    },
  ])
})

test('an unknown extra property is REJECTED, not stripped', async () => {
  let read = 0
  const anchor = historyMessage('anchor-1', 'on screen')
  const server = makeServer({
    history: [anchor],
    loadEarlierHistory: async () => {
      read += 1
      return { messages: [anchor], truncated: false }
    },
  })
  const { socket, received } = makeSocket()
  const connection = server.addConnection(socket)

  server.handleData(
    connection,
    frame({ type: 'history.loadEarlier', requestId: 'req-1', before: 'uuid-9' }),
  )
  await Bun.sleep(0)

  expect(read).toBe(0)
  expect(results(received)).toHaveLength(0)
  const [error] = errors(received)
  expect(error).toMatchObject({ kind: 'error', code: 'bad_request' })
  expect((error as { message: string }).message).toContain('before')
})

test('a wrong-typed sessionId does not address this sidecar', async () => {
  let read = 0
  const anchor = historyMessage('anchor-1', 'on screen')
  const server = makeServer({
    history: [anchor],
    loadEarlierHistory: async () => {
      read += 1
      return { messages: [anchor], truncated: false }
    },
  })
  const { socket, received } = makeSocket()
  const connection = server.addConnection(socket)

  server.handleData(
    connection,
    frame({ type: 'history.loadEarlier', requestId: 'req-1' }, { id: SESSION }),
  )
  await Bun.sleep(0)

  expect(read).toBe(0)
  expect(results(received)).toHaveLength(0)
  expect(errors(received)[0]).toMatchObject({
    code: 'bad_request',
    message: 'sessionId does not address this sidecar',
  })
})

test('a missing requestId is rejected', async () => {
  let read = 0
  const anchor = historyMessage('anchor-1', 'on screen')
  const server = makeServer({
    history: [anchor],
    loadEarlierHistory: async () => {
      read += 1
      return { messages: [anchor], truncated: false }
    },
  })
  const { socket, received } = makeSocket()
  const connection = server.addConnection(socket)

  server.handleData(connection, frame({ type: 'history.loadEarlier' }))
  await Bun.sleep(0)

  expect(read).toBe(0)
  expect(results(received)).toHaveLength(0)
  expect(errors(received)[0]).toMatchObject({ code: 'bad_request' })
})

test('a second request while one is in flight is refused, never queued', async () => {
  const older = historyMessage('older-1', 'recovered')
  const anchor = historyMessage('anchor-1', 'on screen')
  let reads = 0
  let release: (() => void) | null = null
  const server = makeServer({
    history: [anchor],
    loadEarlierHistory: async () => {
      reads += 1
      await new Promise<void>(resolve => {
        release = resolve
      })
      // Deliberately still truncated, so the head-reached latch does not engage
      // and the probe at the end of this test measures the IN-FLIGHT guard
      // releasing rather than the already-whole fast path.
      return { messages: [older, anchor], truncated: true }
    },
  })
  const { socket, received } = makeSocket()
  const connection = server.addConnection(socket)

  server.handleData(
    connection,
    frame({ type: 'history.loadEarlier', requestId: 'req-1' }),
  )
  await Bun.sleep(0)
  server.handleData(
    connection,
    frame({ type: 'history.loadEarlier', requestId: 'req-2' }),
  )
  await Bun.sleep(0)

  // The second one is answered immediately and never reaches the reader.
  expect(reads).toBe(1)
  expect(results(received)).toEqual([
    {
      kind: 'history.loadEarlier.result',
      protocolVersion: PROTOCOL_VERSION,
      sessionId: SESSION,
      requestId: 'req-2',
      ok: false,
      message: 'Still loading earlier messages.',
      added: 0,
      complete: false,
    },
  ])

  release!()
  await Bun.sleep(0)
  await Bun.sleep(0)

  // The first one still completes; the refusal did not disturb it, and the
  // guard released so a later request can run.
  expect(results(received)[1]).toMatchObject({ requestId: 'req-1', ok: true })
  expect(reads).toBe(1)
  server.handleData(
    connection,
    frame({ type: 'history.loadEarlier', requestId: 'req-3' }),
  )
  await Bun.sleep(0)
  await Bun.sleep(0)
  expect(reads).toBe(2)
})

/* ------------------------------------------------------------------------- *
 * Live path — a real transcript file, read by the real engine loader
 * ------------------------------------------------------------------------- */

/**
 * Write a real linear transcript JSONL and point the engine's session identity
 * at it, so `getTranscriptPath()` resolves to this file — the same way a
 * resumed sidecar's does. Returns the messages' text, which exists ONLY on
 * disk.
 */
function mintTranscript(count: number, bodyChars = 24): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'catcode-load-earlier-'))
  tempDirs.push(dir)
  const sessionId = randomUUID()
  const previousId = getSessionId()
  const previousDir = getSessionProjectDir()
  restoreSession = () => switchSession(previousId, previousDir)

  const texts: string[] = []
  const lines: string[] = []
  let parentUuid: string | null = null
  for (let index = 0; index < count; index++) {
    const uuid = randomUUID()
    const text = `message-${index}-${'x'.repeat(bodyChars)}`
    texts.push(text)
    lines.push(
      JSON.stringify({
        type: 'user',
        uuid,
        parentUuid,
        isSidechain: false,
        sessionId,
        cwd: dir,
        userType: 'external',
        version: 'test',
        timestamp: new Date(Date.UTC(2026, 7, 19, 0, 0, index)).toISOString(),
        message: { role: 'user', content: text },
      }),
    )
    parentUuid = uuid
  }
  writeFileSync(join(dir, `${sessionId}.jsonl`), `${lines.join('\n')}\n`)
  switchSession(asSessionId(sessionId), dir)
  return texts
}

/**
 * The tail a restored sidecar would already have replayed, built the way
 * `index.ts` builds it: the same engine loader under the restore caps, then the
 * same display projection.
 */
async function replayedTail(maxMessages: number): Promise<SDKMessage[]> {
  const { getTranscriptPath } = await import('../../src/utils/sessionStorage.js')
  const display = await loadDisplayTranscriptFromJsonlPath(getTranscriptPath(), {
    maxMessages,
    maxBytes: 4 * 1024 * 1024,
  })
  return projectResumedHistory(display.messages)
}

function replayedText(received: ServerFrame[]): string[] {
  return received
    .filter(f => f.kind === 'event' && f.replay === true)
    .map(f => {
      const event = (f as { event: { message: { message: { content: unknown } } } })
        .event
      return String(event.message.message.content)
    })
}

test('the missing prefix comes from the REAL loader reading the REAL file', async () => {
  const texts = mintTranscript(6)
  const tail = await replayedTail(2)
  expect(tail).toHaveLength(2)

  // The server is given ONLY the tail. Nothing else on disk was handed to it,
  // so anything it recovers below had to come from the loader.
  const server = makeServer({ history: tail, historySourceTruncated: true })
  const { socket, received } = makeSocket()
  const connection = server.addConnection(socket)
  const beforeRequest = received.length

  server.handleData(
    connection,
    frame({ type: 'history.loadEarlier', requestId: 'live-1' }),
  )
  await waitForResult(received, 'live-1')

  const recovered = received.slice(beforeRequest)
  expect(replayedText(recovered)).toEqual(texts.slice(0, 4))
  expect(results(recovered)).toEqual([
    {
      kind: 'history.loadEarlier.result',
      protocolVersion: PROTOCOL_VERSION,
      sessionId: SESSION,
      requestId: 'live-1',
      ok: true,
      message: 'Earlier messages loaded.',
      added: 4,
      complete: true,
    },
  ])

  // Asking again recovers nothing: the anchor moved back over what went out.
  server.handleData(
    connection,
    frame({ type: 'history.loadEarlier', requestId: 'live-2' }),
  )
  await waitForResult(received, 'live-2')
  expect(results(received).at(-1)).toMatchObject({
    requestId: 'live-2',
    ok: true,
    added: 0,
    complete: true,
  })
})

test(
  'completeness is reported honestly in BOTH directions, against a real file',
  async () => {
    // Just over the read ceiling, so the loader's own `truncated` fires on a
    // real file rather than on an injected flag. Few, large messages keep the
    // frame count (and the test) small while the bytes do the work.
    const bodyChars = 512 * 1024
    const count = Math.ceil(MAX_HISTORY_LOAD_EARLIER_BYTES / bodyChars) + 4
    mintTranscript(count, bodyChars)
    const tail = await replayedTail(2)
    expect(tail).toHaveLength(2)

    const server = makeServer({ history: tail, historySourceTruncated: true })
    const { socket, received } = makeSocket()
    const connection = server.addConnection(socket)

    server.handleData(
      connection,
      frame({ type: 'history.loadEarlier', requestId: 'live-truncated' }),
    )
    const result = (await waitForResult(received, 'live-truncated')) as unknown as {
      ok: boolean
      added: number
      complete: boolean
      message: string
    }
    expect(result.ok).toBe(true)
    // It recovered a real prefix, and said so, while reporting that the head of
    // the transcript is still out of reach above the ceiling.
    expect(result.added).toBeGreaterThan(0)
    expect(result.added).toBeLessThan(count - 2)
    expect(result.complete).toBe(false)
    expect(result.message).toBe(
      'Earlier messages loaded. Some older ones are still out of reach.',
    )
  },
  30_000,
)

/* ------------------------------------------------------------------------- *
 * Per-reader recovery state
 * ------------------------------------------------------------------------- */

test('a second connection can still recover after the first one already did', async () => {
  const older = historyMessage('older-1', 'recovered')
  const anchor = historyMessage('anchor-1', 'on screen')
  let reads = 0
  const server = makeServer({
    history: [anchor],
    historySourceTruncated: true,
    loadEarlierHistory: async () => {
      reads += 1
      return { messages: [older, anchor], truncated: false }
    },
  })

  const first = makeSocket()
  const firstConnection = server.addConnection(first.socket)
  server.handleData(
    firstConnection,
    frame({ type: 'history.loadEarlier', requestId: 'first' }),
  )
  await Bun.sleep(0)
  expect(results(first.received).at(-1)).toMatchObject({
    requestId: 'first',
    ok: true,
    added: 1,
    complete: true,
  })

  // The renderer reloads. The new connection is replayed the SAME original
  // tail, so its own request has to reach back from THAT tail, not from where
  // the previous reader's recovery left off.
  const second = makeSocket()
  const secondConnection = server.addConnection(second.socket)
  const attached = second.received.length
  server.handleData(
    secondConnection,
    frame({ type: 'history.loadEarlier', requestId: 'second' }),
  )
  await Bun.sleep(0)

  expect(reads).toBe(2)
  expect(replayedText(second.received.slice(attached))).toEqual(['recovered'])
  expect(results(second.received).at(-1)).toMatchObject({
    requestId: 'second',
    ok: true,
    added: 1,
    complete: true,
  })
})

test('a truncated source with an empty replay reads deeper instead of contradicting itself', async () => {
  // Everything loaded was dropped before the wire, so this reader was sent no
  // history at all while the source says more exists above. The old answer said
  // "nothing to load" and "more remains" in the same frame.
  const first = historyMessage('m-1', 'oldest')
  const second = historyMessage('m-2', 'newer')
  let reads = 0
  const server = makeServer({
    historySourceTruncated: true,
    loadEarlierHistory: async () => {
      reads += 1
      return { messages: [first, second], truncated: false }
    },
  })
  const { socket, received } = makeSocket()
  const connection = server.addConnection(socket)
  const attached = received.length

  server.handleData(
    connection,
    frame({ type: 'history.loadEarlier', requestId: 'empty-replay' }),
  )
  await Bun.sleep(0)

  expect(reads).toBe(1)
  expect(replayedText(received.slice(attached))).toEqual(['oldest', 'newer'])
  expect(results(received)).toEqual([
    {
      kind: 'history.loadEarlier.result',
      protocolVersion: PROTOCOL_VERSION,
      sessionId: SESSION,
      requestId: 'empty-replay',
      ok: true,
      message: 'Earlier messages loaded.',
      added: 2,
      complete: true,
    },
  ])
})

test('a reader whose transcript is already whole never reads disk again', async () => {
  const older = historyMessage('older-1', 'recovered')
  const anchor = historyMessage('anchor-1', 'on screen')
  let reads = 0
  const server = makeServer({
    history: [anchor],
    historySourceTruncated: true,
    loadEarlierHistory: async () => {
      reads += 1
      return { messages: [older, anchor], truncated: false }
    },
  })
  const { socket, received } = makeSocket()
  const connection = server.addConnection(socket)

  server.handleData(
    connection,
    frame({ type: 'history.loadEarlier', requestId: 'req-1' }),
  )
  await Bun.sleep(0)
  expect(reads).toBe(1)
  expect(results(received).at(-1)).toMatchObject({ added: 1, complete: true })

  server.handleData(
    connection,
    frame({ type: 'history.loadEarlier', requestId: 'req-2' }),
  )
  await Bun.sleep(0)

  // Answered from the latch: no second 16 MiB read, no subagent files.
  expect(reads).toBe(1)
  expect(results(received).at(-1)).toEqual({
    kind: 'history.loadEarlier.result',
    protocolVersion: PROTOCOL_VERSION,
    sessionId: SESSION,
    requestId: 'req-2',
    ok: true,
    message: 'No earlier messages to load.',
    added: 0,
    complete: true,
  })
})

test('an incomplete read does NOT latch, so the head stays reachable', async () => {
  const oldest = historyMessage('m-1', 'oldest')
  const older = historyMessage('m-2', 'older')
  const anchor = historyMessage('anchor-1', 'on screen')
  let reads = 0
  const server = makeServer({
    history: [anchor],
    historySourceTruncated: true,
    loadEarlierHistory: async () => {
      reads += 1
      // First read stops at the ceiling; a later one reaches further back.
      return reads === 1
        ? { messages: [older, anchor], truncated: true }
        : { messages: [oldest, older, anchor], truncated: false }
    },
  })
  const { socket, received } = makeSocket()
  const connection = server.addConnection(socket)

  server.handleData(
    connection,
    frame({ type: 'history.loadEarlier', requestId: 'req-1' }),
  )
  await Bun.sleep(0)
  expect(results(received).at(-1)).toMatchObject({ added: 1, complete: false })

  server.handleData(
    connection,
    frame({ type: 'history.loadEarlier', requestId: 'req-2' }),
  )
  await Bun.sleep(0)

  expect(reads).toBe(2)
  expect(results(received).at(-1)).toMatchObject({
    requestId: 'req-2',
    ok: true,
    added: 1,
    complete: true,
  })
})
