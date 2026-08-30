/**
 * Sidecar turn lifecycle (item A1,
 * `docs/reports/2026-08-10-overnight-hang-log-request.md`).
 *
 * Drives a real `AppSessionController` with adapters that hang exactly where
 * the 2026-08-10 turn did, so the records are produced by the same code path
 * production uses rather than by injecting the events under test.
 */

import { afterEach, expect, test } from 'bun:test'
import { AppSessionController } from '../../src/app-runtime/AppSessionController.js'
import type { AppSessionControllerAdapter } from '../../src/app-runtime/AppSessionController.js'
import { PROTOCOL_VERSION, type ClientFrame } from '../shared/protocol.js'
import { encodeFrame } from '../shared/framing.js'
import { SidecarServer, type SidecarTurnLifecycleEvent } from './sidecarServer.js'
import type { SidecarSocketLike } from './sidecarServer.js'
import { createOperationalRecord, parseOperationalRecord } from '../shared/operationalLog.js'

const SESSION = 'turn-lifecycle-session'
const ENGINE_SESSION = 'engine-turn-lifecycle-session'
/** Short enough to keep the suite fast, long enough to survive a slow machine. */
const STALL_MS = 40

const servers: SidecarServer[] = []
afterEach(() => {
  for (const server of servers) server.close()
  servers.length = 0
})

function makeServer(adapter: AppSessionControllerAdapter, turnStallMs = STALL_MS) {
  const events: SidecarTurnLifecycleEvent[] = []
  const server = new SidecarServer({
    sessionId: SESSION,
    engineSessionId: ENGINE_SESSION,
    controller: new AppSessionController(adapter),
    onTurnLifecycle: event => events.push(event),
    turnStallMs,
    log: () => {},
  })
  servers.push(server)
  const socket: SidecarSocketLike = { write() {}, end() {} }
  const connection = server.addConnection(socket)
  return { server, events, connection }
}

function submit(server: SidecarServer, connection: ReturnType<SidecarServer['addConnection']>): void {
  const frame: ClientFrame = {
    protocolVersion: PROTOCOL_VERSION,
    sessionId: SESSION,
    message: { type: 'app.submit', requestId: 'req-1', prompt: 'hello' },
  }
  server.handleData(connection, encodeFrame(frame))
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** An assistant message shaped as the engine emits one, with no result after it. */
function assistantMessage() {
  return {
    type: 'assistant' as const,
    message: {
      id: 'msg_1',
      type: 'message' as const,
      role: 'assistant' as const,
      model: 'test-model',
      content: [{ type: 'text' as const, text: 'working' }],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
    parent_tool_use_id: null,
    session_id: ENGINE_SESSION,
    uuid: '00000000-0000-4000-8000-000000000001',
  }
}

test('a turn that finishes pairs started with completed and never reports a stall', async () => {
  const { server, events, connection } = makeServer({
    async *runTurn() {
      yield assistantMessage() as never
    },
  })
  submit(server, connection)
  await sleep(STALL_MS * 4)

  expect(events.map(event => event.kind)).toEqual(['started', 'completed'])
  const completed = events[1] as Extract<SidecarTurnLifecycleEvent, { kind: 'completed' }>
  expect(completed.outcome).toBe('ok')
  expect(completed.durationMs).toBeGreaterThanOrEqual(0)
})

test('a turn that goes quiet before its result is reported once, as awaiting_result', async () => {
  const held: { release: (() => void) | null } = { release: null }
  const { server, events, connection } = makeServer({
    async *runTurn() {
      yield assistantMessage() as never
      // The turn hangs here with the assistant message already out: quiet, and
      // still running. This is the shape the whole record exists for.
      await new Promise<void>(resolve => { held.release = resolve })
    },
  })
  submit(server, connection)
  await sleep(STALL_MS * 4)

  const stalls = events.filter(event => event.kind === 'stalled')
  expect(stalls).toHaveLength(1)
  expect(stalls[0]).toMatchObject({ phase: 'awaiting_result' })
  expect((stalls[0] as Extract<SidecarTurnLifecycleEvent, { kind: 'stalled' }>).elapsedMs)
    .toBeGreaterThanOrEqual(STALL_MS)

  // Staying hung for another several thresholds costs no further records: the
  // count is bounded by turns, not by the duration of the failure (§5).
  await sleep(STALL_MS * 6)
  expect(events.filter(event => event.kind === 'stalled')).toHaveLength(1)
  // And the diagnostic did not abort the turn it reported (§3).
  expect(events.some(event => event.kind === 'completed')).toBe(false)
  held.release?.()
})

test('a turn quiet after its result names the post-turn path', async () => {
  const held: { release: (() => void) | null } = { release: null }
  const { server, events, connection } = makeServer({
    async *runTurn() {
      yield assistantMessage() as never
      yield {
        type: 'result' as const,
        subtype: 'success' as const,
        duration_ms: 1,
        duration_api_ms: 1,
        is_error: false,
        num_turns: 1,
        result: 'done',
        session_id: ENGINE_SESSION,
        total_cost_usd: 0,
        usage: { input_tokens: 1, output_tokens: 1 },
        uuid: '00000000-0000-4000-8000-000000000002',
      } as never
      // The engine finished the turn and something after it never settled. The
      // 2026-08-10 hang, exactly.
      await new Promise<void>(resolve => { held.release = resolve })
    },
  })
  submit(server, connection)
  await sleep(STALL_MS * 4)

  expect(events.filter(event => event.kind === 'stalled')).toMatchObject([{ phase: 'post_result' }])
  held.release?.()
})

/** A result frame as the engine emits one, success or failure. */
function resultMessage(isError: boolean, uuidSuffix = '3') {
  return {
    type: 'result' as const,
    subtype: isError ? ('error_during_execution' as const) : ('success' as const),
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: isError,
    num_turns: 1,
    result: isError ? '' : 'done',
    session_id: ENGINE_SESSION,
    total_cost_usd: 0,
    usage: { input_tokens: 1, output_tokens: 1 },
    uuid: `00000000-0000-4000-8000-00000000000${uuidSuffix}`,
  }
}

async function outcomeOf(
  adapter: AppSessionControllerAdapter,
): Promise<string | undefined> {
  const { server, events, connection } = makeServer(adapter)
  submit(server, connection)
  await sleep(STALL_MS * 4)
  const completed = events.find(event => event.kind === 'completed')
  return (completed as Extract<SidecarTurnLifecycleEvent, { kind: 'completed' }> | undefined)
    ?.outcome
}

test('a successful result on a resolved turn is recorded as ok', async () => {
  expect(
    await outcomeOf({
      async *runTurn() {
        yield assistantMessage() as never
        yield resultMessage(false) as never
      },
    }),
  ).toBe('ok')
})

test('an error result on a resolved turn is recorded as failed', async () => {
  // The engine returns most failures as a result frame, not a rejection, so
  // reading only the submit promise logged a turn that ended in an error as
  // `ok` and hid the failure from the record it was written to preserve.
  expect(
    await outcomeOf({
      async *runTurn() {
        yield assistantMessage() as never
        yield resultMessage(true) as never
      },
    }),
  ).toBe('failed')
})

test('a rejected turn is still recorded as failed', async () => {
  expect(
    await outcomeOf({
      // eslint-disable-next-line require-yield
      async *runTurn() {
        throw new Error('adapter blew up')
      },
    }),
  ).toBe('failed')
})

test('an interruption that recovers to a final successful result stays ok', async () => {
  // The shape a recovered transport interruption produces: partial output, no
  // intermediate error result, one successful result at the end.
  expect(
    await outcomeOf({
      async *runTurn() {
        yield assistantMessage() as never
        yield assistantMessage() as never
        yield resultMessage(false) as never
      },
    }),
  ).toBe('ok')
})

test('a turn still producing events is not reported stalled', async () => {
  const held: { release: (() => void) | null } = { release: null }
  const { server, events, connection } = makeServer({
    async *runTurn() {
      // Steady output across several stall windows: long is not stalled, and a
      // record here would fire on every slow turn the app ever runs.
      for (let index = 0; index < 8; index++) {
        yield assistantMessage() as never
        await sleep(STALL_MS / 4)
      }
      await new Promise<void>(resolve => { held.release = resolve })
    },
  })
  submit(server, connection)
  await sleep(STALL_MS * 2)
  expect(events.filter(event => event.kind === 'stalled')).toHaveLength(0)

  // Output stops; the same turn is then reported once.
  await sleep(STALL_MS * 5)
  expect(events.filter(event => event.kind === 'stalled')).toHaveLength(1)
  held.release?.()
})

test('a turn that never produced an event at all reports an unknown phase', async () => {
  const held: { release: (() => void) | null } = { release: null }
  const { server, events, connection } = makeServer({
    async *runTurn() {
      await new Promise<void>(resolve => { held.release = resolve })
    },
  })
  submit(server, connection)
  await sleep(STALL_MS * 4)

  // Nothing held distinguishes "the engine never started" from "it started and
  // said nothing", so the record says so rather than guessing (§4).
  expect(events.filter(event => event.kind === 'stalled')).toMatchObject([{ phase: 'unknown' }])
  held.release?.()
})

test('a turn waiting on an unanswered permission is not reported stalled', async () => {
  const held: { release: (() => void) | null } = { release: null }
  const { server, events, connection } = makeServer({
    async *runTurn({ onPermissionRequest }) {
      // The user has not answered yet. That wait is designed and its pending
      // request is state this server holds, so silence here is not a stall.
      void onPermissionRequest({
        requestId: 'perm-1',
        request: {
          subtype: 'can_use_tool',
          tool_name: 'Bash',
          input: { command: 'ls' },
          tool_use_id: 'toolu_1',
        },
      })
      await new Promise<void>(resolve => { held.release = resolve })
    },
  })
  submit(server, connection)
  await sleep(STALL_MS * 5)

  expect(events.filter(event => event.kind === 'stalled')).toHaveLength(0)

  // The suppression is conditional on the pending request, not a blanket mute:
  // once it is answered and the turn still says nothing, the stall is reported.
  server.handleData(connection, encodeFrame({
    protocolVersion: PROTOCOL_VERSION,
    sessionId: SESSION,
    message: {
      type: 'permission.response',
      requestId: 'perm-1',
      response: { behavior: 'deny', message: 'no' },
    },
  } satisfies ClientFrame))
  await sleep(STALL_MS * 5)
  expect(events.filter(event => event.kind === 'stalled')).toHaveLength(1)
  held.release?.()
})

test('every turn record the sidecar writes is admitted by the closed vocabulary', () => {
  const context = { launchId: 'launch', processInstanceId: 'process' }
  // These are exactly the three writes in `app/sidecar/index.ts`. A field key
  // outside the vocabulary THROWS inside the logger, so a record that never
  // validated would take the write path down with it rather than log anything.
  const written = [
    createOperationalRecord({ level: 'info', event: 'session.turn.started', process: 'sidecar', appSessionId: SESSION, engineSessionId: ENGINE_SESSION }, context),
    createOperationalRecord({ level: 'info', event: 'session.turn.completed', process: 'sidecar', appSessionId: SESSION, engineSessionId: ENGINE_SESSION, fields: { durationMs: 12, reason: 'ok' } }, context),
    createOperationalRecord({ level: 'warn', event: 'session.turn.stalled', process: 'sidecar', appSessionId: SESSION, engineSessionId: ENGINE_SESSION, fields: { phase: 'post_result', elapsedMs: 900000 } }, context),
  ]
  expect(written.map(record => record.event)).toEqual([
    'session.turn.started', 'session.turn.completed', 'session.turn.stalled',
  ])
  // The export parser is a second, independent pass; a record it rejects is
  // evidence that never reaches a diagnostics bundle.
  for (const record of written) expect(parseOperationalRecord(JSON.parse(JSON.stringify(record)))).not.toBeNull()
  // `phase` is not a free-form slot it opened on every other event.
  expect(() => createOperationalRecord(
    { level: 'warn', event: 'frame.dropped', process: 'sidecar', fields: { phase: 'post_result' } },
    context,
  )).toThrow()
})
