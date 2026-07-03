/**
 * F2 — renderer attachment state machine, including the failure modes the first
 * remediation missed: React StrictMode double-signals the mount effect (so the
 * renderer calls `rendererReady` TWICE per load), and a live frame can arrive
 * between those two signals. The gate must replay exactly once per load and
 * never double-deliver.
 */

import { expect, test } from 'bun:test'

import { AttachmentGate } from './attachmentGate.js'
import { FrameReplayBuffer } from './replayBuffer.js'
import { PROTOCOL_VERSION, type ServerFrame, type SessionId } from '../shared/protocol.js'

const SID: SessionId = 'sess-1'

function readyFrame(): ServerFrame {
  return {
    kind: 'ready',
    protocolVersion: PROTOCOL_VERSION,
    sessionId: SID,
    payload: {
      type: 'app.ready',
      protocolVersion: PROTOCOL_VERSION,
      inputEnabled: true,
      activeTurn: false,
      abort: { status: 'idle' },
      goalSnapshot: null,
      pendingPermissionRequests: [],
    },
  }
}

function pong(nonce: string): ServerFrame {
  return { kind: 'pong', protocolVersion: PROTOCOL_VERSION, sessionId: SID, nonce }
}

/** Collect everything the gate would deliver to the renderer, in order. */
function drive(steps: (gate: AttachmentGate, out: ServerFrame[]) => void): ServerFrame[] {
  const gate = new AttachmentGate()
  const out: ServerFrame[] = []
  steps(gate, out)
  return out
}

test('frames produced before readiness are buffered, then replayed once on attach', () => {
  const out = drive((gate, sink) => {
    sink.push(...gate.onFrame(SID, readyFrame())) // pre-attach: nothing live
    sink.push(...gate.onFrame(SID, pong('probe')))
    sink.push(...gate.onRendererReady()) // replay
  })
  expect(out.map(f => f.kind)).toEqual(['ready', 'pong'])
})

test('nothing is delivered live before readiness', () => {
  const gate = new AttachmentGate()
  expect(gate.onFrame(SID, readyFrame())).toEqual([])
  expect(gate.isAttached).toBe(false)
})

test('after attach, frames are forwarded live (not re-buffered for a second replay)', () => {
  const gate = new AttachmentGate()
  gate.onFrame(SID, readyFrame())
  gate.onRendererReady()
  expect(gate.isAttached).toBe(true)
  expect(gate.onFrame(SID, pong('live')).map(f => f.kind)).toEqual(['pong'])
})

test('StrictMode double rendererReady replays only ONCE (no duplicate ready/probe)', () => {
  const out = drive((gate, sink) => {
    sink.push(...gate.onFrame(SID, readyFrame()))
    sink.push(...gate.onFrame(SID, pong('probe')))
    sink.push(...gate.onRendererReady()) // signal 1: replay
    sink.push(...gate.onRendererReady()) // signal 2 (StrictMode): must be empty
  })
  expect(out.map(f => f.kind)).toEqual(['ready', 'pong'])
  expect(out.filter(f => f.kind === 'ready')).toHaveLength(1)
})

test('a live frame between the two StrictMode signals is delivered exactly once', () => {
  // subscribe → ready+probe buffered → signal1 replays → LIVE frame → signal2.
  // The live frame must appear once (delivered live), not again on signal2.
  const out = drive((gate, sink) => {
    gate.onFrame(SID, readyFrame())
    gate.onFrame(SID, pong('probe'))
    sink.push(...gate.onRendererReady()) // replay: ready, probe
    sink.push(...gate.onFrame(SID, pong('live'))) // live: live
    sink.push(...gate.onRendererReady()) // StrictMode repeat: empty
  })
  const nonces = out.filter(f => f.kind === 'pong').map(f => (f.kind === 'pong' ? f.nonce : ''))
  expect(out.map(f => f.kind)).toEqual(['ready', 'pong', 'pong'])
  expect(nonces).toEqual(['probe', 'live'])
  // 'live' appears exactly once.
  expect(nonces.filter(n => n === 'live')).toHaveLength(1)
})

test('reload re-arms: navigation start makes the next rendererReady replay again', () => {
  const out = drive((gate, sink) => {
    gate.onFrame(SID, readyFrame())
    gate.onFrame(SID, pong('probe'))
    sink.push(...gate.onRendererReady()) // first load: ready, probe
    sink.length = 0 // ignore first load's delivery; focus on the reload
    gate.onNavigationStart() // reload begins
    expect(gate.isAttached).toBe(false)
    sink.push(...gate.onRendererReady()) // reloaded renderer catches up again
  })
  expect(out.map(f => f.kind)).toEqual(['ready', 'pong'])
})

test('a frame arriving during a reload (post-nav, pre-ready) is buffered then replayed', () => {
  const out = drive((gate, sink) => {
    gate.onFrame(SID, readyFrame())
    gate.onRendererReady()
    gate.onNavigationStart() // reload; live-forwarding is now off
    sink.push(...gate.onFrame(SID, pong('mid-reload'))) // must NOT go live
    sink.push(...gate.onRendererReady()) // replay includes it
  })
  // The mid-reload frame was not delivered live (empty during reload window)…
  // …and shows up in the post-reload replay after the ready head.
  expect(out.map(f => f.kind)).toEqual(['ready', 'pong'])
  expect(out.some(f => f.kind === 'pong' && f.nonce === 'mid-reload')).toBe(true)
})

test('reset() (macOS window-all-closed) drops the buffer and detaches', () => {
  const gate = new AttachmentGate()
  gate.onFrame(SID, readyFrame())
  gate.onRendererReady()
  gate.reset()
  expect(gate.isAttached).toBe(false)
  // After reset the next readiness signal has nothing to replay.
  expect(gate.onRendererReady()).toEqual([])
})

test('an injected buffer is used (cap/retention delegated to FrameReplayBuffer)', () => {
  const gate = new AttachmentGate(new FrameReplayBuffer(1))
  gate.onFrame(SID, readyFrame())
  gate.onFrame(SID, pong('a'))
  gate.onFrame(SID, pong('b')) // evicts 'a' at cap 1
  const out = gate.onRendererReady()
  expect(out.map(f => f.kind)).toEqual(['ready', 'pong'])
  expect(out[1]).toMatchObject({ nonce: 'b' })
})
