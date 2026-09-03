/**
 * P3-8 lifetime regression companion — the DESCRIPTOR STATE-MACHINE invariant
 * test (P3-8 rider: "regression companion (b)").
 *
 * Random LEGAL HostEvent sequences are folded through `reduceShellState` and the
 * three lifetime invariants are checked after EVERY event:
 *
 *   I1  "a close eventually removes the tab":      a session that reaches a clean
 *       close (exited + restorable) or a removal is NOT in selectLiveSessions.
 *   I2  "tab ⇒ live record ∨ tombstone":           every id in state.tabs has a
 *       descriptor in state.byId (no ghost tab).
 *   I3  "restorable ⇒ engineSessionId ≠ null":     every descriptor the reducer
 *       holds with restorable:true has a non-null engineSessionId.
 *
 * The legal-transition vocabulary is derived from the REAL host's guarantees
 * (host.ts descriptorFromRow / isRestorable / mapStatus), NOT from FakeSupervisor's
 * orderings. FakeSupervisor emits a SYNCHRONOUS kill-exit the real supervisor never
 * can (host.test.ts:81-90 admits it), and that exact divergence hid the P3-5b crash
 * bug — so this generator models the descriptor shapes the real Host produces:
 *
 *   spawning  → { status:'spawning',     restorable:false, engineSessionId:null }
 *   ready     → { status:'ready',        restorable:false, engineSessionId:ID   }
 *   crash     → { status:'disconnected', restorable:true,  engineSessionId:ID   }  (P3-5b kill/close parity; had become ready)
 *   close     → { status:'exited',       restorable:true,  engineSessionId:ID   }  (clean close, keeps row)
 *   crash-pre → { status:'disconnected', restorable:false, engineSessionId:null }  (crash before ready — never got an engine id → NOT restorable, row reaped by §9-A5)
 *   removed   → session-removed (reap: bound / missing transcript / clean+null id)
 *
 * A session that crashes/closes BEFORE ready has engineSessionId=null; the real
 * host makes such a row NON-restorable (isRestorable requires engineSessionId),
 * so I3 is a real host guarantee this generator must respect (never emit
 * restorable:true with a null id) AND the reducer must never fabricate a
 * violation.
 *
 * Run: `bun test app/renderer/src/shellStateInvariants.test.ts`
 */

import { expect, test } from 'bun:test'

import {
  createShellState,
  reduceShellState,
  selectLiveSessions,
  type ShellState,
} from './shellState.js'
import type { HostEvent, SessionDescriptor } from '../../shared/hostApi.js'
import type { SessionId } from '../../shared/protocol.js'

/* ── A tiny seeded RNG so a failure is reproducible from its printed seed ── */
function makeRng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    // xorshift32
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    s >>>= 0
    return s / 0xffffffff
  }
}

/** Per-session lifecycle phase — the legal states the REAL host walks a row through. */
type Phase = 'none' | 'spawning' | 'ready' | 'crashed' | 'closed' | 'crashed-pre' | 'removed'

type SessionModel = {
  id: SessionId
  engineSessionId: string | null
  phase: Phase
  createdAt: number
  lastAttachedAt: number
}

/**
 * Build the descriptor the REAL host would emit for a session in `phase`. This
 * is the single source of the legal (status, restorable, engineSessionId) tuples
 * — kept faithful to host.ts descriptorFromRow / isRestorable.
 */
function descriptorFor(m: SessionModel): SessionDescriptor {
  const base = {
    appSessionId: m.id,
    cwd: '/tmp/x',
    title: null,
    forked: false,
    name: null,
    createdBy: null,
    peerWakeBlocked: false,
    titleUpdatedAt: null,
    createdAt: m.createdAt,
    lastAttachedAt: m.lastAttachedAt,
    lastMessageSentAt: null,
    // The model's phases are crash/close shapes; a park is a separate axis this
    // invariant suite does not model, so every descriptor it builds is unparked.
    parked: false,
  }
  switch (m.phase) {
    case 'spawning':
      return { ...base, engineSessionId: null, status: 'spawning', restorable: false }
    case 'ready':
      return { ...base, engineSessionId: m.engineSessionId, status: 'ready', restorable: false }
    case 'crashed':
      // Had become ready (engine id present) then its sidecar died: the P3-5b
      // kill/close-parity descriptor — disconnected + restorable, tab kept.
      return { ...base, engineSessionId: m.engineSessionId, status: 'disconnected', restorable: true }
    case 'closed':
      return { ...base, engineSessionId: m.engineSessionId, status: 'exited', restorable: true }
    case 'crashed-pre':
      // Crashed before ready: no engine id ⇒ NOT restorable (host guarantee).
      return { ...base, engineSessionId: null, status: 'disconnected', restorable: false }
    default:
      throw new Error(`no descriptor for phase ${m.phase}`)
  }
}

/** The legal next phases from a given phase (the real host's transition graph). */
function legalNext(phase: Phase): Phase[] {
  switch (phase) {
    case 'none':
      return ['spawning']
    case 'spawning':
      // → ready, or die before ready (crashed-pre), or a spawn that never readies
      //   gets reaped (removed).
      return ['ready', 'crashed-pre', 'removed']
    case 'ready':
      // → crash (sidecar dies), clean close, or restart-in-place (back to spawning).
      return ['crashed', 'closed', 'spawning']
    case 'crashed':
      // A crashed (restorable) row: restore re-spawns it, or it's removed (reaped).
      return ['spawning', 'removed']
    case 'closed':
      // A cleanly-closed (restorable) row: restore re-spawns it, or removed.
      return ['spawning', 'removed']
    case 'crashed-pre':
      // Non-restorable dead row → reaped.
      return ['removed']
    case 'removed':
      return [] // terminal
  }
}

/** Emit the HostEvent that drives a session into `next` from its current phase. */
function eventFor(m: SessionModel, next: Phase, tick: number): HostEvent {
  if (next === 'removed') {
    return { type: 'session-removed', appSessionId: m.id }
  }
  // A first appearance is session-added; a subsequent change is session-status.
  const firstAppearance = m.phase === 'none'
  const advanced: SessionModel = {
    ...m,
    phase: next,
    // ready mints the engine id (the two-id bridge on the ready frame); a restart
    // re-announces the same engine id.
    engineSessionId:
      next === 'ready'
        ? (m.engineSessionId ?? `engine-${m.id}`)
        : m.engineSessionId,
    lastAttachedAt: tick,
  }
  const session = descriptorFor(advanced)
  return firstAppearance
    ? { type: 'session-added', session }
    : { type: 'session-status', session }
}

/** Assert the three invariants hold on `state`. Throws with context on violation. */
function checkInvariants(state: ShellState, models: Map<SessionId, SessionModel>, step: number): void {
  // I2 — tab ⇒ descriptor present.
  for (const id of Object.keys(state.tabs) as SessionId[]) {
    if (!state.byId[id]) {
      throw new Error(`[step ${step}] I2 violated: tab ${id} has no descriptor (ghost tab)`)
    }
  }
  // I3 — restorable ⇒ engineSessionId ≠ null.
  for (const id of Object.keys(state.byId) as SessionId[]) {
    const d = state.byId[id]
    if (d.restorable && d.engineSessionId === null) {
      throw new Error(`[step ${step}] I3 violated: ${id} restorable but engineSessionId=null`)
    }
  }
  // I1 — a session in a closed/removed model phase must not be a LIVE tab.
  const liveIds = new Set(selectLiveSessions(state).map(d => d.appSessionId))
  for (const [id, m] of models) {
    if (m.phase === 'closed' || m.phase === 'removed') {
      if (liveIds.has(id)) {
        throw new Error(`[step ${step}] I1 violated: ${m.phase} session ${id} still a live tab`)
      }
    }
  }
}

test('descriptor state-machine: 400 random legal event sequences preserve the three lifetime invariants', () => {
  const SEQUENCES = 400
  const STEPS_PER_SEQ = 40
  const MAX_SESSIONS = 5

  for (let seqIdx = 0; seqIdx < SEQUENCES; seqIdx++) {
    const seed = 0x9e3779b9 ^ (seqIdx * 2654435761)
    const rng = makeRng(seed)
    let state = createShellState()
    const models = new Map<SessionId, SessionModel>()
    let tick = 1

    // Seed a couple of sessions in phase 'none'.
    const sessionCount = 1 + Math.floor(rng() * MAX_SESSIONS)
    for (let i = 0; i < sessionCount; i++) {
      const id = `s${seqIdx}-${i}` as SessionId
      models.set(id, { id, engineSessionId: null, phase: 'none', createdAt: tick, lastAttachedAt: tick })
    }

    for (let step = 0; step < STEPS_PER_SEQ; step++) {
      // Pick a session with at least one legal transition.
      const actionable = [...models.values()].filter(m => legalNext(m.phase).length > 0)
      if (actionable.length === 0) break
      const m = actionable[Math.floor(rng() * actionable.length)]
      const nexts = legalNext(m.phase)
      const next = nexts[Math.floor(rng() * nexts.length)]

      const event = eventFor(m, next, ++tick)
      // Advance the model to mirror what the event asserts.
      models.set(m.id, {
        ...m,
        phase: next,
        engineSessionId:
          next === 'ready' ? (m.engineSessionId ?? `engine-${m.id}`) : m.engineSessionId,
        lastAttachedAt: tick,
      })

      state = reduceShellState(state, event)

      try {
        checkInvariants(state, models, step)
      } catch (err) {
        throw new Error(
          `seed=${seed} seqIdx=${seqIdx} step=${step} event=${JSON.stringify(event)}\n${
            err instanceof Error ? err.message : String(err)
          }`,
        )
      }
    }
  }
})

/**
 * Targeted case the random walk should also cover but is worth pinning explicitly
 * (it is the exact P3-5b bug shape): ready → crash keeps the tab AND stays in the
 * roster; a subsequent restore (→ spawning → ready) makes it a live tab again;
 * a clean close then revokes tab membership while keeping the restore-offer.
 */
test('explicit P3-5b shape: ready→crash keeps tab, restore relives it, close revokes tab', () => {
  const id = 'p35b' as SessionId
  let state = createShellState()
  const engineSessionId = 'engine-p35b'
  const base = {
    appSessionId: id,
    cwd: '/tmp/x',
    title: null,
    forked: false,
    name: null,
    createdBy: null,
    peerWakeBlocked: false,
    titleUpdatedAt: null,
    createdAt: 1,
    lastAttachedAt: 1,
    lastMessageSentAt: null,
    parked: false,
  }

  // spawn → ready
  state = reduceShellState(state, {
    type: 'session-added',
    session: { ...base, engineSessionId: null, status: 'spawning', restorable: false },
  })
  state = reduceShellState(state, {
    type: 'session-status',
    session: { ...base, engineSessionId, status: 'ready', restorable: false },
  })
  expect(selectLiveSessions(state).map(d => d.appSessionId)).toEqual([id])

  // crash: disconnected + restorable — tab KEPT (kill/close parity).
  state = reduceShellState(state, {
    type: 'session-status',
    session: { ...base, engineSessionId, status: 'disconnected', restorable: true },
  })
  expect(selectLiveSessions(state).map(d => d.appSessionId)).toEqual([id])
  expect(state.byId[id].restorable).toBe(true)

  // restore: spawning → ready — live tab again.
  state = reduceShellState(state, {
    type: 'session-status',
    session: { ...base, engineSessionId: null, status: 'spawning', restorable: false },
  })
  state = reduceShellState(state, {
    type: 'session-status',
    session: { ...base, engineSessionId, status: 'ready', restorable: false },
  })
  expect(selectLiveSessions(state).map(d => d.appSessionId)).toEqual([id])

  // clean close: exited + restorable — tab REVOKED, row kept as offer.
  state = reduceShellState(state, {
    type: 'session-status',
    session: { ...base, engineSessionId, status: 'exited', restorable: true },
  })
  expect(selectLiveSessions(state).map(d => d.appSessionId)).toEqual([])
  expect(state.byId[id]).toBeDefined()
  expect(state.byId[id].restorable).toBe(true)
})
