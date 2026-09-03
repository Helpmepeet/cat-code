/**
 * F2 — restored-history replay unit tests (decisions/RESTORE-HISTORY.md).
 *
 * Drives SidecarServer with an injectable in-memory socket (the
 * sidecarServer.test.ts harness pattern) and a synthetic restored history,
 * asserting the attach-time contract: ready first, then the history as
 * `replay: true` event frames in chronological order, live events unflagged;
 * caps keep the NEWEST contiguous tail; any omission is announced with the
 * truncation-boundary error frame BEFORE the tail.
 */

import { afterEach, expect, test } from 'bun:test'
import { AppSessionController } from '../../src/app-runtime/AppSessionController.js'
import type { SDKMessage } from '../../src/entrypoints/agentSdkTypes.js'
import { FrameDecoder } from '../shared/framing.js'
import {
  MAX_HISTORY_REPLAY_BYTES,
  MAX_HISTORY_REPLAY_FRAMES,
  MAX_OUTBOUND_FRAME_BYTES,
} from '../shared/limits.js'
import {
  HISTORY_REPLAY_TRUNCATION_REQUEST_ID,
  type ServerFrame,
} from '../shared/protocol.js'
import { buildProbeToolUseMessage } from './probeAdapter.js'
import { SidecarServer, type SidecarSocketLike } from './sidecarServer.js'

const SESSION = 'history-session'
const ENGINE_SESSION = 'engine-history-session'

/**
 * In-memory socket decoding what the server writes. Uses the OUTBOUND cap
 * (like the real supervisor decoder) so large replay frames decode.
 */
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

/**
 * A minimal restored user message in the exact shape `toSDKMessages` emits for
 * a `type:'user'` CliMessage (mappers.ts:129-146: role/content envelope,
 * session_id, parent_tool_use_id:null, uuid, timestamp, isSynthetic).
 */
function historyUserMessage(uuid: string, text: string): SDKMessage {
  return {
    type: 'user',
    message: { role: 'user', content: text },
    session_id: ENGINE_SESSION,
    parent_tool_use_id: null,
    uuid,
    timestamp: '2026-07-05T00:00:00.000Z',
    isSynthetic: false,
  } as unknown as SDKMessage
}

let servers: SidecarServer[] = []
function makeServer(
  history: readonly SDKMessage[],
  historySourceTruncated = false,
  readGeneratedImage?: (filePath: string) => Promise<Uint8Array | null>,
): SidecarServer {
  const server = new SidecarServer({
    sessionId: SESSION,
    engineSessionId: ENGINE_SESSION,
    controller: new AppSessionController({
      async *runTurn() {
        yield buildProbeToolUseMessage()
      },
    }),
    history,
    historySourceTruncated,
    ...(readGeneratedImage ? { readGeneratedImage } : {}),
    log: () => {},
  })
  servers.push(server)
  return server
}

afterEach(() => {
  for (const s of servers) s.close()
  servers = []
})

test('attach replays history after ready as replay:true event frames in order; live events are unflagged', async () => {
  const history = [
    historyUserMessage('u-1', 'remember this nonce: F2-nonce'),
    historyUserMessage('u-2', 'second restored message'),
  ]
  const server = makeServer(history)
  const { socket, received } = makeSocket()

  const connection = server.addConnection(socket)
  // `activity` closes the attach burst, before history replay
  // (HOST-REQUEST-PLANE §4 step 4a). This server has no snapshot domains, so
  // the burst is that one frame.
  expect(received.map(f => f.kind)).toEqual(['ready', 'activity', 'event', 'event'])

  const replayFrames = received.filter(f => f.kind === 'event')
  for (const frame of replayFrames) {
    if (frame.kind !== 'event') continue
    expect(frame.replay).toBe(true)
    expect(frame.sessionId).toBe(SESSION)
    expect(frame.event.type).toBe('message')
  }
  // Chronological order preserved (oldest first), content intact.
  expect(JSON.stringify(replayFrames[0])).toContain('F2-nonce')
  expect(JSON.stringify(replayFrames[1])).toContain('second restored message')

  // A live controller event after attach carries NO replay flag. Read the last
  // EVENT rather than the last frame: a turn now closes with an `activity`
  // presence frame (HOST-REQUEST-PLANE §4 step 4a), and this test is about the
  // replay flag on transcript traffic, not about which frame arrives last.
  await server['controller'].submit('live-turn')
  const live = received.filter(f => f.kind === 'event').at(-1)!
  expect(live.kind).toBe('event')
  expect('replay' in live).toBe(false)
  void connection
})

test('a fresh session (no history) sends no transcript frames on attach', () => {
  const server = makeServer([])
  const { socket, received } = makeSocket()
  server.addConnection(socket)
  // Ready plus the attach burst, which for a domain-less server is the single
  // `activity` presence frame. What matters is what is ABSENT: no `event`, no
  // truncation boundary — a fresh session replays nothing.
  expect(received.map(f => f.kind)).toEqual(['ready', 'activity'])
})

test('restored GenerateImage history cannot authorize a generated-image file read', () => {
  const toolUseId = 'toolu_restored_image'
  const history = [
    {
      type: 'assistant',
      message: {
        id: 'msg_restored_image',
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: toolUseId,
            name: 'GenerateImage',
            input: { prompt: 'restored image' },
          },
        ],
      },
      session_id: ENGINE_SESSION,
      parent_tool_use_id: null,
      uuid: '00000000-0000-4000-8000-000000000201',
      timestamp: '2026-08-09T00:00:00.000Z',
    },
    {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: toolUseId,
            content: 'Generated image',
          },
        ],
      },
      tool_use_result: {
        filePath: '/tmp/restored-image.png',
        model: 'gpt-image-2',
        size: '1024x1024',
        outputFormat: 'png',
        bytes: 4,
      },
      session_id: ENGINE_SESSION,
      parent_tool_use_id: null,
      uuid: '00000000-0000-4000-8000-000000000202',
      timestamp: '2026-08-09T00:00:01.000Z',
      isSynthetic: true,
    },
  ] as unknown as SDKMessage[]
  let reads = 0
  const server = makeServer(history, false, async () => {
    reads++
    return Uint8Array.from([0, 1, 2, 3])
  })
  const { socket, received } = makeSocket()

  server.addConnection(socket)

  expect(reads).toBe(0)
  expect(
    received.some(frame => frame.kind === 'generated-image-preview'),
  ).toBe(false)
})

test('frames cap keeps the NEWEST contiguous tail and announces the loss BEFORE it', () => {
  const total = MAX_HISTORY_REPLAY_FRAMES + 1
  const history = Array.from({ length: total }, (_, i) =>
    historyUserMessage(`u-${i}`, `restored message ${i}`),
  )
  const server = makeServer(history)
  const { socket, received } = makeSocket()
  server.addConnection(socket)

  // ready → attach burst (`activity`) → truncation boundary → exactly the cap
  // of newest events. The boundary still precedes every retained frame, which
  // is the property this test is about.
  expect(received[0]!.kind).toBe('ready')
  expect(received[1]!.kind).toBe('activity')
  const boundary = received[2]!
  expect(boundary.kind).toBe('error')
  if (boundary.kind === 'error') {
    expect(boundary.requestId).toBe(HISTORY_REPLAY_TRUNCATION_REQUEST_ID)
    expect(boundary.retryable).toBe(false)
  }
  const events = received.slice(3)
  expect(events.length).toBe(MAX_HISTORY_REPLAY_FRAMES)
  // The oldest message (index 0) was dropped; the tail is contiguous newest.
  expect(JSON.stringify(events[0])).toContain('"restored message 1"')
  expect(JSON.stringify(events[events.length - 1])).toContain(
    `"restored message ${total - 1}"`,
  )
})

test('byte cap: oversized history retains only the newest frames that fit, loss announced', () => {
  // Three messages of ~2.5 MiB each: only the newest fits under the 4 MiB cap.
  const big = 'x'.repeat(Math.ceil(MAX_HISTORY_REPLAY_BYTES * 0.6))
  const history = [
    historyUserMessage('u-old', `old ${big}`),
    historyUserMessage('u-mid', `mid ${big}`),
    historyUserMessage('u-new', 'newest small restored message'),
  ]
  const server = makeServer(history)
  const { socket, received } = makeSocket()
  server.addConnection(socket)

  expect(received[0]!.kind).toBe('ready')
  // `activity` closes the attach burst before history replay begins.
  expect(received[1]!.kind).toBe('activity')
  const boundary = received[2]!
  expect(boundary.kind).toBe('error')
  if (boundary.kind === 'error') {
    expect(boundary.requestId).toBe(HISTORY_REPLAY_TRUNCATION_REQUEST_ID)
  }
  // Newest tail: the small newest message + the mid one that still fits; the
  // oldest overflows and everything older stops (contiguous, no gaps).
  const events = received.slice(3)
  expect(events.length).toBe(2)
  expect(JSON.stringify(events[0])).toContain('mid ')
  expect(JSON.stringify(events[1])).toContain('newest small restored message')
})

test('a loader-truncated archival prefix is announced even when retained frames fit', () => {
  const server = makeServer(
    [historyUserMessage('u-new', 'newest retained display message')],
    true,
  )
  const { socket, received } = makeSocket()
  server.addConnection(socket)

  expect(received[0]!.kind).toBe('ready')
  expect(received[1]!.kind).toBe('activity')
  expect(received[2]).toMatchObject({
    kind: 'error',
    requestId: HISTORY_REPLAY_TRUNCATION_REQUEST_ID,
  })
  expect(JSON.stringify(received[3])).toContain(
    'newest retained display message',
  )
})
