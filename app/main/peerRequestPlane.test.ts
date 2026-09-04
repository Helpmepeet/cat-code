/**
 * Host-request-plane tests (decisions/HOST-REQUEST-PLANE.md §6).
 *
 * The plane is driven through its real entry point with fake collaborators, so
 * every rule below is exercised as production runs it: one `host.request` in,
 * one `host.result` out, with the same validation, the same guards and the same
 * stores. The fakes stand in for the host, the registry and main's `forward`
 * only — nothing in this file reimplements a rule the module owns.
 */

import { describe, expect, test } from 'bun:test'
import {
  createPeerRequestPlane,
  validateHostRequest,
  type PeerRegistryRow,
  type PeerRequestPlaneDeps,
} from './peerRequestPlane.js'
import {
  MAX_HOST_REQUEST_FRAMES_PER_WINDOW,
  MAX_HOST_REQUESTS_PER_WINDOW,
  MAX_PEER_DELIVERY_ATTEMPTS,
  MAX_PEER_HOPS,
  MAX_PEER_TEXT_BYTES,
  MAX_PENDING_PEER_MESSAGES,
  PEER_SEND_BURST,
} from '../shared/limits.js'
import {
  PROTOCOL_VERSION,
  type HostRequestVerb,
  type PeerDeliverMessage,
  type SidecarClientMessage,
} from '../shared/protocol.js'

const ALEX = 'aaaaaaaa-0000-4000-8000-000000000001'
const BEAR = 'bbbbbbbb-0000-4000-8000-000000000002'
const CORAL = 'cccccccc-0000-4000-8000-000000000003'
const DUNE = 'dddddddd-0000-4000-8000-000000000004'
const WORKSPACE = '/w/one'

/** Let every queued microtask run, so parked awaits reach their next step. */
function settle(): Promise<void> {
  return new Promise<void>(resolve => {
    setImmediate(resolve)
  })
}

function row(
  appSessionId: string,
  name: string,
  overrides: Partial<PeerRegistryRow> = {},
): PeerRegistryRow {
  return {
    appSessionId,
    engineSessionId: `engine-${name.toLowerCase()}`,
    cwd: WORKSPACE,
    name,
    lastAttachedAt: 1_000,
    lastMessageSentAt: null,
    shutdown: null,
    ...overrides,
  }
}

type Sent = { sessionId: string; message: SidecarClientMessage }
type LogLine = {
  appSessionId: string
  from: string
  to: string
  kind: string
  messageId: string
  outcome: string
}

/**
 * One harness, wired the way main wires it. `live` decides `isLive`, and the
 * ready timeout is driven off a manual clock so a wake test does not sit for
 * thirty seconds.
 */
function harness(
  options: {
    rows?: PeerRegistryRow[]
    live?: Set<string>
    /** Rows whose socket can take a frame right now. Defaults to `live`. */
    ready?: Set<string>
    createResult?: PeerRequestPlaneDeps['createSessionInWorkspace']
    restoreResult?: PeerRequestPlaneDeps['restoreSession']
    forwardFails?: Set<string>
  } = {},
) {
  const rows = options.rows ?? [row(ALEX, 'Alex'), row(BEAR, 'Bear')]
  const live = options.live ?? new Set([ALEX, BEAR])
  const ready = options.ready
  const restored: string[] = []
  const sent: Sent[] = []
  const logged: LogLine[] = []
  const timers: Array<{ fn: () => void; fired: boolean }> = []
  let ids = 0
  let clock = 10_000

  const plane = createPeerRequestPlane({
    rows: () => rows,
    isLive: id => live.has(id),
    isReady: id => (ready ?? live).has(id),
    createSessionInWorkspace:
      options.createResult ??
      (async () => ({ ok: false, error: { code: 'session_limit', message: 'nope' } })),
    restoreSession: appSessionId => {
      restored.push(appSessionId)
      return (options.restoreResult ?? (async () => ({ ok: true })))(appSessionId)
    },
    forward: (sessionId, message) => {
      sent.push({ sessionId, message })
      return options.forwardFails?.has(sessionId) === true ? 'session_not_found' : null
    },
    logRouted: (appSessionId, fields) => logged.push({ appSessionId, ...fields }),
    now: () => clock,
    newId: () => `msg-${++ids}`,
    setTimer: fn => {
      const entry = { fn, fired: false }
      timers.push(entry)
      return entry
    },
    clearTimer: handle => {
      const entry = handle as { fired: boolean }
      entry.fired = true
    },
  })

  return {
    plane,
    rows,
    live,
    restored,
    sent,
    logged,
    advance: (ms: number) => {
      clock += ms
    },
    /** Fire every still-armed wake timeout, as the event loop would. */
    expireWakes: () => {
      for (const entry of timers) {
        if (!entry.fired) {
          entry.fired = true
          entry.fn()
        }
      }
    },
    results: () =>
      sent
        .map(entry => entry.message)
        .filter(
          (message): message is Extract<SidecarClientMessage, { type: 'host.result' }> =>
            message.type === 'host.result',
        ),
    lastResult: () => {
      const all = sent
        .map(entry => entry.message)
        .filter(
          (message): message is Extract<SidecarClientMessage, { type: 'host.result' }> =>
            message.type === 'host.result',
        )
      return all[all.length - 1]
    },
    deliveries: () =>
      sent.filter(
        (entry): entry is { sessionId: string; message: PeerDeliverMessage } =>
          entry.message.type === 'peer.deliver',
      ),
  }
}

function request(
  verb: HostRequestVerb,
  args: Record<string, unknown> = {},
  requestId = 'req-1',
): Record<string, unknown> {
  return {
    kind: 'host.request',
    protocolVersion: PROTOCOL_VERSION,
    sessionId: ALEX,
    requestId,
    verb,
    args,
  }
}

/* ------------------------------------------------------------------------- *
 * HR1 — fail closed
 * ------------------------------------------------------------------------- */

describe('HR1 validation', () => {
  test('an unknown verb is a typed error, never a throw or a silent drop', async () => {
    const h = harness()
    await h.plane.handleRequest(ALEX, request('peers.destroy' as HostRequestVerb))
    expect(h.lastResult()).toEqual({
      type: 'host.result',
      requestId: 'req-1',
      ok: false,
      error: { code: 'unknown_verb', message: 'unknown verb peers.destroy' },
    })
  })

  test('an extra top-level key is REJECTED, not stripped', async () => {
    const h = harness()
    await h.plane.handleRequest(ALEX, {
      ...request('peers.list'),
      from: BEAR,
    })
    expect(h.lastResult()?.ok).toBe(false)
    expect(h.lastResult()?.error?.code).toBe('bad_request')
  })

  test('an extra ARG is rejected, so a forged field cannot ride a valid verb', async () => {
    const h = harness()
    await h.plane.handleRequest(
      ALEX,
      request('peer.deliver', { to: 'Bear', text: 'hi', hops: [] }),
    )
    expect(h.lastResult()?.error?.code).toBe('bad_request')
    expect(h.deliveries()).toHaveLength(0)
  })

  test('a missing requestId is answered with nothing at all', async () => {
    const h = harness()
    const frame = request('peers.list')
    delete frame.requestId
    await h.plane.handleRequest(ALEX, frame)
    // There is no id to address an answer to, so silence is the only option —
    // and no work was done, which is what fail-closed means here.
    expect(h.sent).toHaveLength(0)
  })

  test('a wrong-typed arg is a typed error', async () => {
    const h = harness()
    await h.plane.handleRequest(ALEX, request('peer.deliver', { to: 7, text: 'hi' }))
    expect(h.lastResult()?.error?.code).toBe('bad_request')
  })

  test('an oversize text is refused before anything is routed', async () => {
    const h = harness()
    await h.plane.handleRequest(
      ALEX,
      request('peer.deliver', { to: 'Bear', text: 'x'.repeat(MAX_PEER_TEXT_BYTES + 1) }),
    )
    expect(h.lastResult()?.error?.code).toBe('too_large')
    expect(h.deliveries()).toHaveLength(0)
  })

  test('a request flood is refused at main, not at the channel', async () => {
    const h = harness()
    for (let i = 0; i < MAX_HOST_REQUESTS_PER_WINDOW; i++) {
      await h.plane.handleRequest(ALEX, request('peers.list', {}, `req-${i}`))
    }
    expect(h.results().every(result => result.ok)).toBe(true)
    await h.plane.handleRequest(ALEX, request('peers.list', {}, 'over'))
    expect(h.lastResult()?.error?.code).toBe('rate_limited')
  })

  test('the window slides, so a paced caller is never refused', async () => {
    const h = harness()
    for (let i = 0; i < MAX_HOST_REQUESTS_PER_WINDOW; i++) {
      await h.plane.handleRequest(ALEX, request('peers.list', {}, `req-${i}`))
    }
    h.advance(60_001)
    await h.plane.handleRequest(ALEX, request('peers.list', {}, 'later'))
    expect(h.lastResult()?.ok).toBe(true)
  })
})

/* ------------------------------------------------------------------------- *
 * HR3 — scope
 * ------------------------------------------------------------------------- */

describe('HR3 scoping', () => {
  test('peers.list shows only named rows in the caller workspace, never the caller', async () => {
    const h = harness({
      rows: [
        row(ALEX, 'Alex'),
        row(BEAR, 'Bear'),
        row(CORAL, 'Coral', { cwd: '/w/other' }),
        row('dddddddd-0000-4000-8000-000000000004', '', { name: undefined }),
      ],
    })
    await h.plane.handleRequest(ALEX, request('peers.list'))
    const value = h.lastResult()?.value as { peers: Array<{ name: string }> }
    expect(value.peers.map(peer => peer.name)).toEqual(['Bear'])
  })

  test('a deliver naming a row in another cwd is session_not_found', async () => {
    const h = harness({
      rows: [row(ALEX, 'Alex'), row(CORAL, 'Coral', { cwd: '/w/other' })],
      live: new Set([ALEX, CORAL]),
    })
    await h.plane.handleRequest(ALEX, request('peer.deliver', { to: 'Coral', text: 'hi' }))
    expect(h.lastResult()?.error?.code).toBe('session_not_found')
    expect(h.deliveries()).toHaveLength(0)
  })

  test('a caller with no registry row can name nobody', async () => {
    const h = harness({ rows: [row(BEAR, 'Bear')] })
    await h.plane.handleRequest(ALEX, request('peers.list'))
    expect(h.lastResult()?.error?.code).toBe('session_not_found')
  })
})

/* ------------------------------------------------------------------------- *
 * peers.list content
 * ------------------------------------------------------------------------- */

describe('peers.list', () => {
  test('carries engineSessionId, presence for live rows only, and a resolved creator', async () => {
    const h = harness({
      rows: [
        row(ALEX, 'Alex'),
        row(BEAR, 'Bear', { createdBy: ALEX }),
        row(CORAL, 'Coral', { shutdown: 'parked', createdBy: 'gone-id' }),
      ],
      live: new Set([ALEX, BEAR]),
    })
    h.plane.recordActivity(BEAR, 'needs_user')
    h.plane.recordActivity(CORAL, 'running')

    await h.plane.handleRequest(ALEX, request('peers.list'))
    const value = h.lastResult()?.value as {
      peers: Array<Record<string, unknown>>
    }
    const bear = value.peers.find(peer => peer.name === 'Bear')
    const coral = value.peers.find(peer => peer.name === 'Coral')

    expect(bear).toMatchObject({
      status: 'live',
      presence: 'needs_user',
      engineSessionId: 'engine-bear',
      createdBy: { appSessionId: ALEX, name: 'Alex' },
    })
    // Presence is a LIVE-only fact: a stale value must not survive into a
    // parked row's descriptor.
    expect(coral).toMatchObject({ status: 'parked' })
    expect(coral).not.toHaveProperty('presence')
    // A creator whose row is gone resolves to a null NAME, never to a reused one.
    expect(coral?.createdBy).toEqual({ appSessionId: 'gone-id', name: null })
  })

  test('reports the model and effort a row announced, for live and parked rows only', async () => {
    // The point of reading this off the row's own run-controls rather than off
    // the create that asked for it: Coral was never created by an agent and so
    // never had a spawn value, and Bear's is whatever it is running NOW.
    const h = harness({
      rows: [
        row(ALEX, 'Alex'),
        row(BEAR, 'Bear'),
        row(CORAL, 'Coral', { shutdown: 'parked' }),
        row(DUNE, 'Dune', { shutdown: 'clean' }),
      ],
      live: new Set([ALEX, BEAR]),
    })
    h.plane.recordRunControls(BEAR, { model: 'gpt-5.6-luna', effort: 'low' })
    h.plane.recordRunControls(CORAL, { model: 'gpt-5.6-sol', effort: 'high' })
    h.plane.recordRunControls(DUNE, { model: 'gpt-5.6-sol', effort: 'high' })

    await h.plane.handleRequest(ALEX, request('peers.list'))
    const peers = (h.lastResult()?.value as { peers: Array<Record<string, unknown>> }).peers
    const find = (name: string) => peers.find(peer => peer.name === name)

    expect(find('Bear')).toMatchObject({
      status: 'live',
      model: 'gpt-5.6-luna',
      effort: 'low',
    })
    // A parked row KEEPS its value, unlike presence: its engine is gone, so
    // nothing can move the model while it is parked, and this is the row a
    // caller is deciding whether to wake.
    expect(find('Coral')).toMatchObject({
      status: 'parked',
      model: 'gpt-5.6-sol',
      effort: 'high',
    })
    // A closed row carries none, even when main heard one before it closed.
    expect(find('Dune')).not.toHaveProperty('model')
    expect(find('Dune')).not.toHaveProperty('effort')
  })

  test('a row that has not announced, or whose engine could not resolve one, carries no model', async () => {
    // Absent means "nobody measured it", exactly as it does for presence. The
    // null case is the engine's own failure to resolve, and it must not be
    // rendered as a model called null.
    const h = harness({
      rows: [row(ALEX, 'Alex'), row(BEAR, 'Bear'), row(CORAL, 'Coral')],
      live: new Set([ALEX, BEAR, CORAL]),
    })
    h.plane.recordRunControls(CORAL, { model: null, effort: null })

    await h.plane.handleRequest(ALEX, request('peers.list'))
    const peers = (h.lastResult()?.value as { peers: Array<Record<string, unknown>> }).peers
    for (const peer of peers) {
      expect(peer).not.toHaveProperty('model')
      expect(peer).not.toHaveProperty('effort')
    }
  })

  test('a model change moves the row without a respawn', async () => {
    const h = harness()
    h.plane.recordRunControls(BEAR, { model: 'gpt-5.6-luna', effort: 'low' })
    h.plane.recordRunControls(BEAR, { model: 'gpt-5.6-sol', effort: 'high' })

    await h.plane.handleRequest(ALEX, request('peers.list'))
    const peers = (h.lastResult()?.value as { peers: Array<Record<string, unknown>> }).peers
    expect(peers.find(peer => peer.name === 'Bear')).toMatchObject({
      model: 'gpt-5.6-sol',
      effort: 'high',
    })
  })

  test('orders live before parked before closed', async () => {
    const h = harness({
      rows: [
        row(ALEX, 'Alex'),
        row(CORAL, 'Coral', { shutdown: 'clean' }),
        row(BEAR, 'Bear', { shutdown: 'parked' }),
        row('eeeeeeee-0000-4000-8000-000000000005', 'Onyx'),
      ],
      live: new Set([ALEX, 'eeeeeeee-0000-4000-8000-000000000005']),
    })
    await h.plane.handleRequest(ALEX, request('peers.list'))
    const value = h.lastResult()?.value as { peers: Array<{ name: string }> }
    expect(value.peers.map(peer => peer.name)).toEqual(['Onyx', 'Bear', 'Coral'])
  })
})

/* ------------------------------------------------------------------------- *
 * §4 — deliver
 * ------------------------------------------------------------------------- */

describe('peer.deliver', () => {
  test('a live recipient is queued and the frame carries MAIN-stamped identity', async () => {
    const h = harness()
    await h.plane.handleRequest(ALEX, request('peer.deliver', { to: 'Bear', text: 'ping' }))

    expect(h.lastResult()?.value).toEqual({ messageId: 'msg-1', outcome: 'queued_live' })
    expect(h.deliveries()).toHaveLength(1)
    expect(h.deliveries()[0]).toEqual({
      sessionId: BEAR,
      message: {
        type: 'peer.deliver',
        messageId: 'msg-1',
        from: 'Alex',
        fromSessionId: ALEX,
        text: 'ping',
      },
    })
  })

  test('the name resolves case-insensitively but the workspace scope does not widen', async () => {
    const h = harness()
    await h.plane.handleRequest(ALEX, request('peer.deliver', { to: 'bear', text: 'ping' }))
    expect(h.lastResult()?.value).toMatchObject({ outcome: 'queued_live' })
  })

  test('a parked recipient is restored and the message waits for its ready', async () => {
    const restores: string[] = []
    const h = harness({
      rows: [row(ALEX, 'Alex'), row(BEAR, 'Bear', { shutdown: 'parked' })],
      live: new Set([ALEX]),
      restoreResult: async id => {
        restores.push(id)
        return { ok: true }
      },
    })
    const pending = h.plane.handleRequest(
      ALEX,
      request('peer.deliver', { to: 'Bear', text: 'wake up' }),
    )
    // Let the restore promise settle so the wake waiter is armed.
    await Promise.resolve()
    await Promise.resolve()
    expect(restores).toEqual([BEAR])
    // Nothing is forwarded before ready: the row has no process to receive it.
    expect(h.deliveries()).toHaveLength(0)

    h.plane.onReady(BEAR)
    await pending
    expect(h.lastResult()?.value).toEqual({ messageId: 'msg-1', outcome: 'queued_wake' })
    expect(h.deliveries()).toHaveLength(1)
  })

  test('a wake that never readies is refused wake_failed, never session_not_found', async () => {
    const h = harness({
      rows: [row(ALEX, 'Alex'), row(BEAR, 'Bear', { shutdown: 'clean' })],
      live: new Set([ALEX]),
    })
    const pending = h.plane.handleRequest(
      ALEX,
      request('peer.deliver', { to: 'Bear', text: 'wake up' }),
    )
    await Promise.resolve()
    await Promise.resolve()
    h.expireWakes()
    await pending
    // HR3 reserves session_not_found for a row the caller may not name, and this
    // one it may — conflating them would tell the model its peer does not exist.
    expect(h.lastResult()?.value).toEqual({
      messageId: 'msg-1',
      outcome: 'refused:wake_failed',
    })
  })

  test('a request racing a user-initiated restore is delivered, not answered not-found', async () => {
    // `already restoring` and `already live` both answer `session_not_found`
    // from the host today (host.ts). Treating that as a missing row would fail
    // exactly the case where the row is about to be perfectly reachable.
    const h = harness({
      rows: [row(ALEX, 'Alex'), row(BEAR, 'Bear', { shutdown: 'parked' })],
      live: new Set([ALEX]),
      restoreResult: async () => ({
        ok: false,
        error: { code: 'session_not_found', message: 'session is already restoring' },
      }),
    })
    const pending = h.plane.handleRequest(
      ALEX,
      request('peer.deliver', { to: 'Bear', text: 'hello' }),
    )
    await Promise.resolve()
    await Promise.resolve()
    h.plane.onReady(BEAR)
    await pending
    expect(h.lastResult()?.value).toEqual({ messageId: 'msg-1', outcome: 'queued_wake' })
    expect(h.deliveries()).toHaveLength(1)
  })

  test('a not-live row with peerWakeBlocked is refused user_stopped', async () => {
    const h = harness({
      rows: [
        row(ALEX, 'Alex'),
        row(BEAR, 'Bear', { shutdown: 'parked', peerWakeBlocked: true }),
      ],
      live: new Set([ALEX]),
    })
    await h.plane.handleRequest(ALEX, request('peer.deliver', { to: 'Bear', text: 'hi' }))
    expect(h.lastResult()?.value).toMatchObject({ outcome: 'refused:user_stopped' })
    expect(h.deliveries()).toHaveLength(0)
  })

  test('a LIVE row ignores peerWakeBlocked: the flag is about reopening', async () => {
    const h = harness({
      rows: [row(ALEX, 'Alex'), row(BEAR, 'Bear', { peerWakeBlocked: true })],
    })
    await h.plane.handleRequest(ALEX, request('peer.deliver', { to: 'Bear', text: 'hi' }))
    expect(h.lastResult()?.value).toMatchObject({ outcome: 'queued_live' })
  })
})

/* ------------------------------------------------------------------------- *
 * §4 steps 2-3 — the loop and channel guards
 * ------------------------------------------------------------------------- */

describe('loop and channel guards', () => {
  test('two peers answering each other stop at MAX_PEER_HOPS with no prompt help', async () => {
    const h = harness()
    let sender = ALEX
    let recipient = BEAR
    const outcomes: string[] = []
    // Each turn is a fresh body so the dedup window cannot be what stops it, and
    // the clock advances so the token bucket cannot be either. The ONLY guard
    // left is the chain.
    for (let i = 0; i < MAX_PEER_HOPS + 4; i++) {
      h.advance(3_000)
      await h.plane.handleRequest(
        sender,
        request(
          'peer.deliver',
          { to: recipient === BEAR ? 'Bear' : 'Alex', text: `turn ${i}` },
          `req-${i}`,
        ),
      )
      const value = h.lastResult()?.value as { outcome: string } | undefined
      outcomes.push(value?.outcome ?? 'error')
      const next = recipient
      recipient = sender
      sender = next
    }
    // It stops, it stops mechanically, and it stops AT the cap rather than on
    // the first reply (which is what a literal contains-the-recipient test
    // would have done, making MAX_PEER_HOPS unreachable).
    expect(outcomes.slice(0, MAX_PEER_HOPS).every(outcome => outcome.startsWith('queued'))).toBe(
      true,
    )
    expect(outcomes[MAX_PEER_HOPS]).toBe('refused:hop_runaway')
    // And it STAYS stopped. A refused hop has to advance the pair's chain or the
    // two directions drift by one and the exchange leaks a message every other
    // attempt, forever — which is a stop that does not stop.
    expect(outcomes.slice(MAX_PEER_HOPS)).toEqual(
      outcomes.slice(MAX_PEER_HOPS).map(() => 'refused:hop_runaway'),
    )
  })

  test('a three-way cycle is refused hop_loop before it can run twice', async () => {
    const h = harness({
      rows: [row(ALEX, 'Alex'), row(BEAR, 'Bear'), row(CORAL, 'Coral')],
      live: new Set([ALEX, BEAR, CORAL]),
    })
    h.advance(3_000)
    await h.plane.handleRequest(ALEX, request('peer.deliver', { to: 'Bear', text: 'a' }, 'r1'))
    h.advance(3_000)
    await h.plane.handleRequest(BEAR, request('peer.deliver', { to: 'Coral', text: 'b' }, 'r2'))
    h.advance(3_000)
    await h.plane.handleRequest(CORAL, request('peer.deliver', { to: 'Alex', text: 'c' }, 'r3'))
    expect(h.lastResult()?.value).toMatchObject({ outcome: 'refused:hop_loop' })
  })

  test('a peer reports back to the one that messaged it, one rung down the ladder', async () => {
    // R2 makes report-back the delivery model's whole reason to exist ("when
    // done, message Alex"), and R8 explicitly allows the ladder that produces
    // this shape (Bear creates Coral). Coral answering Bear is not a cycle: Bear
    // is the chain's LAST entry, the peer Coral is replying to. A rule that
    // refuses it breaks the primary workflow one level below the root, with a
    // loop refusal the model did nothing to cause.
    const h = harness({
      rows: [row(ALEX, 'Alex'), row(BEAR, 'Bear'), row(CORAL, 'Coral')],
      live: new Set([ALEX, BEAR, CORAL]),
    })
    h.advance(3_000)
    await h.plane.handleRequest(ALEX, request('peer.deliver', { to: 'Bear', text: 'a' }, 'r1'))
    h.advance(3_000)
    await h.plane.handleRequest(BEAR, request('peer.deliver', { to: 'Coral', text: 'b' }, 'r2'))
    h.advance(3_000)
    await h.plane.handleRequest(CORAL, request('peer.deliver', { to: 'Bear', text: 'done' }, 'r3'))

    expect(h.lastResult()?.value).toMatchObject({ outcome: 'queued_live' })
    expect(h.deliveries().at(-1)?.message).toMatchObject({
      from: 'Coral',
      text: 'done',
    })
  })

  test('a two-party sub-exchange further down the chain is bounded by hops, not refused as a loop', async () => {
    // The same shape continued: Bear and Coral now go back and forth. Each hop
    // answers the last sender, so none of them is a cycle, and the chain keeps
    // growing until MAX_PEER_HOPS ends it — the same mechanical stop a top-level
    // exchange gets, rather than an early refusal that reads as a bug.
    const h = harness({
      rows: [row(ALEX, 'Alex'), row(BEAR, 'Bear'), row(CORAL, 'Coral')],
      live: new Set([ALEX, BEAR, CORAL]),
    })
    h.advance(3_000)
    await h.plane.handleRequest(ALEX, request('peer.deliver', { to: 'Bear', text: 'kick off' }, 'r0'))

    const outcomes: string[] = []
    let sender = BEAR
    let recipient = CORAL
    for (let i = 0; i < MAX_PEER_HOPS + 2; i++) {
      h.advance(3_000)
      await h.plane.handleRequest(
        sender,
        request(
          'peer.deliver',
          { to: recipient === CORAL ? 'Coral' : 'Bear', text: `turn ${i}` },
          `r${i}`,
        ),
      )
      const value = h.lastResult()?.value as { outcome: string } | undefined
      outcomes.push(value?.outcome ?? 'error')
      const next = recipient
      recipient = sender
      sender = next
    }
    // Nothing is refused as a loop; the only refusal is the hop budget running out.
    expect(outcomes.filter(outcome => outcome === 'refused:hop_loop')).toEqual([])
    expect(outcomes).toContain('refused:hop_runaway')
    expect(outcomes.at(-1)).toBe('refused:hop_runaway')
  })

  test('a session cannot message itself', async () => {
    const h = harness({
      rows: [row(ALEX, 'Alex'), row(BEAR, 'Bear')],
    })
    // Self-addressing is already invisible in `peersOf`, so it answers
    // session_not_found; the chain guard is the second line for the case where
    // a future resolver ever admits it.
    await h.plane.handleRequest(ALEX, request('peer.deliver', { to: 'Alex', text: 'hi' }))
    expect(h.lastResult()?.error?.code).toBe('session_not_found')
  })

  test('the chain expires, so a conversation resumed later gets its budget back', async () => {
    // `hops` no longer crosses the boundary (F10: it had no consumer), so the
    // chain is observable only through outcomes. Drive the pair to the cap,
    // wait out the window, and the exchange must run again — which is a real
    // assertion, unlike reading a single allowed send.
    const h = harness()
    const pingPong = async (tag: string) => {
      const outcomes: string[] = []
      let sender = ALEX
      let recipient = BEAR
      for (let i = 0; i < MAX_PEER_HOPS + 1; i++) {
        h.advance(3_000)
        await h.plane.handleRequest(
          sender,
          request(
            'peer.deliver',
            { to: recipient === BEAR ? 'Bear' : 'Alex', text: `${tag} ${i}` },
            `${tag}-${i}`,
          ),
        )
        const value = h.lastResult()?.value as { outcome: string } | undefined
        outcomes.push(value?.outcome ?? 'error')
        const next = recipient
        recipient = sender
        sender = next
      }
      return outcomes
    }

    const first = await pingPong('a')
    expect(first.at(-1)).toBe('refused:hop_runaway')

    h.advance(11 * 60_000)

    const second = await pingPong('b')
    // The whole budget is back: the first send is allowed again and the cap is
    // reached again, rather than the pair staying dead from the earlier chain.
    expect(second[0]).toBe('queued_live')
    expect(second.at(-1)).toBe('refused:hop_runaway')
  })

  test('the per-pair bucket refuses a burst and refills over time', async () => {
    const h = harness()
    for (let i = 0; i < PEER_SEND_BURST; i++) {
      await h.plane.handleRequest(
        ALEX,
        request('peer.deliver', { to: 'Bear', text: `body ${i}` }, `r${i}`),
      )
    }
    await h.plane.handleRequest(ALEX, request('peer.deliver', { to: 'Bear', text: 'over' }, 'ro'))
    expect(h.lastResult()?.value).toMatchObject({ outcome: 'refused:rate' })

    h.advance(2_000)
    await h.plane.handleRequest(ALEX, request('peer.deliver', { to: 'Bear', text: 'after' }, 'ra'))
    expect(h.lastResult()?.value).toMatchObject({ outcome: 'queued_live' })
  })

  test('an identical body to the same recipient inside the window is duplicate', async () => {
    const h = harness()
    await h.plane.handleRequest(ALEX, request('peer.deliver', { to: 'Bear', text: 'same' }, 'r1'))
    await h.plane.handleRequest(ALEX, request('peer.deliver', { to: 'Bear', text: 'same' }, 'r2'))
    expect(h.lastResult()?.value).toMatchObject({ outcome: 'refused:duplicate' })

    h.advance(30_001)
    await h.plane.handleRequest(ALEX, request('peer.deliver', { to: 'Bear', text: 'same' }, 'r3'))
    expect(h.lastResult()?.value).toMatchObject({ outcome: 'queued_live' })
  })

  test('the same body from two different senders is not a duplicate', async () => {
    // Two peers reporting to one parent inside the window. Keyed on recipient
    // and body alone, the second is refused and told to wait for a reply to a
    // message the parent never received.
    const h = harness({
      rows: [row(ALEX, 'Alex'), row(BEAR, 'Bear'), row(CORAL, 'Coral')],
      live: new Set([ALEX, BEAR, CORAL]),
    })
    await h.plane.handleRequest(ALEX, request('peer.deliver', { to: 'Bear', text: 'Done.' }, 'r1'))
    expect(h.lastResult()?.value).toMatchObject({ outcome: 'queued_live' })
    await h.plane.handleRequest(CORAL, request('peer.deliver', { to: 'Bear', text: 'Done.' }, 'r2'))
    expect(h.lastResult()?.value).toMatchObject({ outcome: 'queued_live' })

    // Both actually reached the recipient, each stamped with its own sender.
    expect(h.deliveries()).toHaveLength(2)
    expect(h.deliveries().map(entry => [entry.sessionId, entry.message.from])).toEqual([
      [BEAR, 'Alex'],
      [BEAR, 'Coral'],
    ])

    // The same sender repeating itself is still a duplicate.
    await h.plane.handleRequest(CORAL, request('peer.deliver', { to: 'Bear', text: 'Done.' }, 'r3'))
    expect(h.lastResult()?.value).toMatchObject({ outcome: 'refused:duplicate' })
  })

  test('a recipient at MAX_PENDING_PEER_MESSAGES is refused queue_full', async () => {
    const h = harness()
    for (let i = 0; i < MAX_PENDING_PEER_MESSAGES; i++) {
      h.advance(2_000)
      await h.plane.handleRequest(
        ALEX,
        request('peer.deliver', { to: 'Bear', text: `body ${i}` }, `r${i}`),
      )
    }
    expect(h.plane.pendingFor(BEAR)).toHaveLength(MAX_PENDING_PEER_MESSAGES)
    h.advance(2_000)
    await h.plane.handleRequest(ALEX, request('peer.deliver', { to: 'Bear', text: 'one more' }, 'x'))
    expect(h.lastResult()?.value).toMatchObject({ outcome: 'refused:queue_full' })
  })

  test('every refusal is logged; nothing is dropped silently', async () => {
    const h = harness({
      rows: [
        row(ALEX, 'Alex'),
        row(BEAR, 'Bear', { shutdown: 'parked', peerWakeBlocked: true }),
      ],
      live: new Set([ALEX]),
    })
    await h.plane.handleRequest(ALEX, request('peer.deliver', { to: 'Bear', text: 'hi' }))
    expect(h.logged).toEqual([
      {
        appSessionId: ALEX,
        from: 'Alex',
        to: 'Bear',
        kind: 'request',
        messageId: 'msg-1',
        outcome: 'refused:user_stopped',
      },
    ])
  })
})

/* ------------------------------------------------------------------------- *
 * §4 step 6 — ack, durability, and the log line
 * ------------------------------------------------------------------------- */

describe('ack and durability', () => {
  test('main holds a message until the recipient acks it, then writes ONE log line', async () => {
    const h = harness()
    await h.plane.handleRequest(ALEX, request('peer.deliver', { to: 'Bear', text: 'hi' }))
    // Routed, not yet acked: no audit line, because the message has not reached
    // a queue anywhere and saying it did would be the lie the line exists
    // against.
    expect(h.logged).toHaveLength(0)
    expect(h.plane.pendingFor(BEAR)).toEqual(['msg-1'])

    await h.plane.handleRequest(
      BEAR,
      request('peer.ack', { messageId: 'msg-1' }, 'ack-1'),
    )
    expect(h.plane.pendingFor(BEAR)).toEqual([])
    // Attributed to the SENDER, exactly like the refusal lines above it. The ack
    // arrives from Bear, and billing the line to whoever happened to close the
    // message made "which session caused this" depend on how it ended.
    expect(h.logged).toEqual([
      {
        appSessionId: ALEX,
        from: 'Alex',
        to: 'Bear',
        kind: 'request',
        messageId: 'msg-1',
        outcome: 'queued_live',
      },
    ])
    // The message TEXT is structurally absent from the audit record.
    expect(JSON.stringify(h.logged)).not.toContain('hi')
  })

  test('a recipient that exits unacked is re-sent the message after its next ready', async () => {
    const h = harness()
    await h.plane.handleRequest(ALEX, request('peer.deliver', { to: 'Bear', text: 'survive' }))
    expect(h.deliveries()).toHaveLength(1)

    // The process dies before acking, then comes back.
    h.plane.onSessionDown(BEAR)
    h.plane.onReady(BEAR)

    expect(h.deliveries()).toHaveLength(2)
    expect(h.deliveries()[1]?.message).toEqual(h.deliveries()[0]!.message)
    // Still held: redelivery does not consume the pending entry, only an ack does.
    expect(h.plane.pendingFor(BEAR)).toEqual(['msg-1'])
  })

  test('a duplicate ack is harmless and writes no second line', async () => {
    const h = harness()
    await h.plane.handleRequest(ALEX, request('peer.deliver', { to: 'Bear', text: 'hi' }))
    await h.plane.handleRequest(BEAR, request('peer.ack', { messageId: 'msg-1' }, 'a1'))
    await h.plane.handleRequest(BEAR, request('peer.ack', { messageId: 'msg-1' }, 'a2'))
    expect(h.logged).toHaveLength(1)
    expect(h.lastResult()?.ok).toBe(true)
  })
})

/* ------------------------------------------------------------------------- *
 * HR4 — create
 * ------------------------------------------------------------------------- */

describe('peer.create', () => {
  test('the registry churn rule is opted into and its refusal is passed through', async () => {
    let seen: unknown
    const h = harness({
      createResult: async (_from, peer) => {
        seen = peer
        return { ok: false, error: { code: 'session_limit', message: 'at most 256 sessions' } }
      },
    })
    await h.plane.handleRequest(ALEX, request('peer.create', { prompt: 'go' }))
    expect(seen).toEqual({ createdBy: ALEX, enforceRegistryChurnLimit: true })
    expect(h.lastResult()?.error?.code).toBe('session_limit')
  })

  test('model and effort travel to the host, and nothing else does', async () => {
    let seen: Record<string, unknown> | undefined
    const h = harness({
      createResult: async (_from, peer) => {
        seen = peer as unknown as Record<string, unknown>
        return { ok: false, error: { code: 'session_limit', message: 'x' } }
      },
    })
    await h.plane.handleRequest(
      ALEX,
      request('peer.create', { prompt: 'go', model: 'gpt-5.6-luna', effort: 'low' }),
    )
    expect(seen).toEqual({
      createdBy: ALEX,
      model: 'gpt-5.6-luna',
      effort: 'low',
      enforceRegistryChurnLimit: true,
    })
    // No cwd, no account, no permission mode: HC1/HR6/R10 and the §0a cut.
    expect(Object.keys(seen ?? {})).not.toContain('cwd')
    expect(Object.keys(seen ?? {})).not.toContain('permissionMode')
  })

  test('the creation prompt is delivered UNTAGGED after the new row readies', async () => {
    const h = harness({
      createResult: async () => ({ ok: true, value: { appSessionId: CORAL, name: 'Coral' } }),
    })
    const pending = h.plane.handleRequest(ALEX, request('peer.create', { prompt: 'do the thing' }))
    await Promise.resolve()
    await Promise.resolve()
    expect(h.deliveries()).toHaveLength(0)

    h.plane.onReady(CORAL)
    await pending

    expect(h.lastResult()?.value).toEqual({ name: 'Coral', appSessionId: CORAL })
    expect(h.deliveries()[0]?.message).toEqual({
      type: 'peer.deliver',
      messageId: 'msg-1',
      from: 'Alex',
      fromSessionId: ALEX,
      text: 'do the thing',
      untagged: true,
    })
  })

  test('a row that never readies keeps the row and names the failed step', async () => {
    const h = harness({
      createResult: async () => ({ ok: true, value: { appSessionId: CORAL, name: 'Coral' } }),
    })
    const pending = h.plane.handleRequest(ALEX, request('peer.create', { prompt: 'go' }))
    await Promise.resolve()
    await Promise.resolve()
    h.expireWakes()
    await pending
    expect(h.lastResult()?.value).toEqual({
      name: 'Coral',
      appSessionId: CORAL,
      failedStep: 'ready',
    })
  })

  test('a prompt refused after ready keeps the row and names the failed step', async () => {
    const h = harness({
      createResult: async () => ({ ok: true, value: { appSessionId: CORAL, name: 'Coral' } }),
      forwardFails: new Set([CORAL]),
    })
    const pending = h.plane.handleRequest(ALEX, request('peer.create', { prompt: 'go' }))
    await Promise.resolve()
    await Promise.resolve()
    h.plane.onReady(CORAL)
    await pending
    expect(h.lastResult()?.value).toEqual({
      name: 'Coral',
      appSessionId: CORAL,
      failedStep: 'prompt',
    })
  })
})

/* ------------------------------------------------------------------------- *
 * Reap
 * ------------------------------------------------------------------------- */

test('a reaped row takes every per-row and per-pair store with it', async () => {
  const h = harness()
  await h.plane.handleRequest(ALEX, request('peer.deliver', { to: 'Bear', text: 'same' }, 'r1'))
  h.plane.recordActivity(BEAR, 'running')
  h.plane.recordRunControls(BEAR, { model: 'gpt-5.6-sol', effort: 'high' })
  expect(h.plane.pendingFor(BEAR)).toEqual(['msg-1'])
  expect(h.plane.presenceOf(BEAR)).toBe('running')

  h.plane.onSessionRemoved(BEAR)

  expect(h.plane.pendingFor(BEAR)).toEqual([])
  expect(h.plane.presenceOf(BEAR)).toBeUndefined()
  // The model store is the one that survives a row going DOWN, so the reap is
  // the only thing that clears it: a name handed out again must not inherit the
  // previous row's model.
  await h.plane.handleRequest(ALEX, request('peers.list', {}, 'r-list'))
  const listed = (h.lastResult()?.value as { peers: Array<Record<string, unknown>> }).peers
  expect(listed.find(peer => peer.name === 'Bear')).not.toHaveProperty('model')
  // The dedup window went with it, so a name handed out again does not inherit
  // the previous row's refusals.
  await h.plane.handleRequest(ALEX, request('peer.deliver', { to: 'Bear', text: 'same' }, 'r2'))
  expect(h.lastResult()?.value).toMatchObject({ outcome: 'queued_live' })
})

/* ------------------------------------------------------------------------- *
 * The validator on its own
 * ------------------------------------------------------------------------- */

test('validateHostRequest never throws, whatever it is handed', () => {
  const hostile: unknown[] = [
    null,
    'string',
    42,
    [],
    { requestId: 'r' },
    { requestId: 'r', verb: 'peers.list', args: [] },
    { requestId: 'r', verb: 'peer.deliver', args: { to: 'Bear' } },
    { requestId: 'r', verb: '__proto__' },
    { requestId: 'r'.repeat(1000), verb: 'peers.list' },
  ]
  for (const frame of hostile) {
    expect(() => validateHostRequest(frame)).not.toThrow()
    expect(validateHostRequest(frame).ok).toBe(false)
  }
})

/* ------------------------------------------------------------------------- *
 * Cold-review fixes
 * ------------------------------------------------------------------------- */

describe('F2 — chains are per pair, so one conversation cannot move another', () => {
  test('a third peer messaging a party does not shorten that pair own chain', async () => {
    // The escape: drive A and Bear to a long chain, have Coral send one message
    // to Alex, and under a recipient-keyed store the pair next hop carried a
    // chain of two — resetting `hop_runaway` on demand, once per refill
    // interval, forever.
    const h = harness({
      rows: [row(ALEX, 'Alex'), row(BEAR, 'Bear'), row(CORAL, 'Coral')],
      live: new Set([ALEX, BEAR, CORAL]),
    })
    let sender = ALEX
    let recipient = BEAR
    const outcomes: string[] = []
    for (let i = 0; i < MAX_PEER_HOPS + 1; i++) {
      h.advance(3_000)
      // Coral interferes on every single hop; it must change nothing.
      await h.plane.handleRequest(
        CORAL,
        request('peer.deliver', { to: 'Alex', text: `noise ${i}` }, `n${i}`),
      )
      h.advance(3_000)
      await h.plane.handleRequest(
        sender,
        request(
          'peer.deliver',
          { to: recipient === BEAR ? 'Bear' : 'Alex', text: `turn ${i}` },
          `r${i}`,
        ),
      )
      const value = h.lastResult()?.value as { outcome: string } | undefined
      outcomes.push(value?.outcome ?? 'error')
      const next = recipient
      recipient = sender
      sender = next
    }
    // The cap still lands. Under the old store this list was all `queued`.
    expect(outcomes.at(-1)).toBe('refused:hop_runaway')
  })

  test('a refusal between two peers does not refuse an uninvolved pair', async () => {
    // The DoS: `A→B, B→C, C→A` refuses correctly, and under a recipient-keyed
    // store the refusal wrote onto Alex key, so Alex next send to Bear was
    // refused `hop_loop` for the whole ten-minute window. One message a
    // prompt-injected peer never needed delivered silenced someone else.
    const h = harness({
      rows: [row(ALEX, 'Alex'), row(BEAR, 'Bear'), row(CORAL, 'Coral')],
      live: new Set([ALEX, BEAR, CORAL]),
    })
    h.advance(3_000)
    await h.plane.handleRequest(ALEX, request('peer.deliver', { to: 'Bear', text: 'a' }, 'r1'))
    h.advance(3_000)
    await h.plane.handleRequest(BEAR, request('peer.deliver', { to: 'Coral', text: 'b' }, 'r2'))
    h.advance(3_000)
    await h.plane.handleRequest(CORAL, request('peer.deliver', { to: 'Alex', text: 'c' }, 'r3'))
    expect(h.lastResult()?.value).toMatchObject({ outcome: 'refused:hop_loop' })

    h.advance(3_000)
    await h.plane.handleRequest(ALEX, request('peer.deliver', { to: 'Bear', text: 'd' }, 'r4'))
    expect(h.lastResult()?.value).toMatchObject({ outcome: 'queued_live' })
  })
})

describe('F3/F4 — rate accounting', () => {
  test('invalid requests are counted, so the cheapest flood to send is bounded', async () => {
    // Only valid requests used to be counted, so an unknown-verb flood produced
    // one answer each and zero refusals, each costing a `JSON.stringify` on a
    // payload the channel bounds only at 32 MiB.
    const h = harness()
    for (let i = 0; i < MAX_HOST_REQUEST_FRAMES_PER_WINDOW; i++) {
      await h.plane.handleRequest(ALEX, request('nope' as never, {}, `f${i}`))
    }
    expect(h.results().every(result => result.error?.code === 'unknown_verb')).toBe(true)

    await h.plane.handleRequest(ALEX, request('nope' as never, {}, 'over'))
    expect(h.lastResult()?.error?.code).toBe('rate_limited')
  })

  test('an ack does not spend the model own allowance', async () => {
    // An ack is main-induced: main routes a message and the recipient must ack
    // it. Charging it to the recipient meant senders could spend a session
    // budget for it and starve it off the plane entirely.
    const h = harness()
    for (let i = 0; i < MAX_HOST_REQUESTS_PER_WINDOW; i++) {
      await h.plane.handleRequest(
        BEAR,
        request('peer.ack', { messageId: `m-${i}` }, `a${i}`),
      )
    }
    expect(h.results().every(result => result.ok)).toBe(true)

    // Bear can still do its own work.
    await h.plane.handleRequest(BEAR, request('peers.list', {}, 'mine'))
    expect(h.lastResult()?.ok).toBe(true)
    expect(h.lastResult()?.error).toBeUndefined()
  })

  test('acks are still bounded as frames', async () => {
    const h = harness()
    for (let i = 0; i < MAX_HOST_REQUEST_FRAMES_PER_WINDOW; i++) {
      await h.plane.handleRequest(BEAR, request('peer.ack', { messageId: `m-${i}` }, `a${i}`))
    }
    await h.plane.handleRequest(BEAR, request('peer.ack', { messageId: 'over' }, 'over'))
    expect(h.lastResult()?.error?.code).toBe('rate_limited')
  })
})

describe('F5/F7/F9/F11 — smaller fixes', () => {
  test('a live recipient that cannot be handed the message is not reported as unwakeable', async () => {
    const h = harness({ forwardFails: new Set([BEAR]) })
    await h.plane.handleRequest(ALEX, request('peer.deliver', { to: 'Bear', text: 'hi' }))
    // No wake was attempted: Bear is awake. Saying `wake_failed` would tell the
    // model its peer is unreachable while the peer is sitting there running.
    expect(h.lastResult()?.value).toMatchObject({ outcome: 'refused:delivery_failed' })
  })

  test('an unnamed sender is a typed answer, not a frame that loops forever', async () => {
    // PEER-SESSIONS §2 says every live session is named, so this is a broken
    // invariant — which is exactly why it must not default to '' and mint a
    // frame the recipient rejects at every ready for the life of the window.
    const h = harness({
      rows: [row(ALEX, 'Alex', { name: undefined }), row(BEAR, 'Bear')],
    })
    await h.plane.handleRequest(ALEX, request('peer.deliver', { to: 'Bear', text: 'hi' }))
    expect(h.lastResult()?.ok).toBe(false)
    expect(h.lastResult()?.error?.code).toBe('internal_error')
    expect(h.deliveries()).toHaveLength(0)
    expect(h.plane.pendingFor(BEAR)).toEqual([])
  })

  test('redelivery is bounded and the give-up is logged', async () => {
    const h = harness()
    await h.plane.handleRequest(ALEX, request('peer.deliver', { to: 'Bear', text: 'hi' }))
    expect(h.deliveries()).toHaveLength(1)

    for (let i = 0; i < MAX_PEER_DELIVERY_ATTEMPTS + 3; i++) {
      h.plane.onSessionDown(BEAR)
      h.plane.onReady(BEAR)
    }
    // It stops re-sending, releases the pending slot, and says so.
    expect(h.deliveries().length).toBe(MAX_PEER_DELIVERY_ATTEMPTS)
    expect(h.plane.pendingFor(BEAR)).toEqual([])
    expect(h.logged.at(-1)).toMatchObject({ outcome: 'refused:delivery_failed' })
  })

  test('a frame from another protocol version is refused', async () => {
    const h = harness()
    await h.plane.handleRequest(ALEX, {
      ...request('peers.list'),
      protocolVersion: 2,
    })
    expect(h.lastResult()?.error?.code).toBe('bad_request')
  })

  test('a ready that lands before the waiter registers is not missed', async () => {
    // `awaitReady` can only register after the host call it waits behind
    // resolves, and `onReady` is fire-once. A ready in that gap used to be lost,
    // and the caller sat out the whole wake timeout for a session that was fine.
    const h = harness({
      rows: [row(ALEX, 'Alex'), row(BEAR, 'Bear', { shutdown: 'parked' })],
      live: new Set([ALEX]),
      restoreResult: async () => {
        // Ready arrives DURING the restore, before anyone is waiting on it.
        h.plane.onReady(BEAR)
        return { ok: true }
      },
    })
    await h.plane.handleRequest(ALEX, request('peer.deliver', { to: 'Bear', text: 'wake' }))
    expect(h.lastResult()?.value).toMatchObject({ outcome: 'queued_wake' })
    expect(h.deliveries()).toHaveLength(1)
  })
})

/* ------------------------------------------------------------------------- *
 * Second-review fixes
 * ------------------------------------------------------------------------- */

describe('H1 — the hop budget belongs to the pair, the chain belongs to the ring', () => {
  test('a first message to a NEW peer is allowed however long another exchange ran', async () => {
    // The defect this pins: the inherited chain was both the ring evidence and
    // the budget, so eight legitimate Alex/Bear round trips left a chain of
    // sixteen, and Alex's FIRST EVER message to Coral inherited it and came back
    // `hop_runaway`. The sender was told its back-and-forth with Coral had run
    // too long before the two had exchanged anything, and it stayed refused for
    // as long as Alex and Bear kept the record fresh.
    const h = harness({
      rows: [row(ALEX, 'Alex'), row(BEAR, 'Bear'), row(CORAL, 'Coral')],
      live: new Set([ALEX, BEAR, CORAL]),
    })
    let sender = ALEX
    let recipient = BEAR
    const pair: string[] = []
    for (let i = 0; i < MAX_PEER_HOPS + 1; i++) {
      h.advance(3_000)
      await h.plane.handleRequest(
        sender,
        request(
          'peer.deliver',
          { to: recipient === BEAR ? 'Bear' : 'Alex', text: `turn ${i}` },
          `r${i}`,
        ),
      )
      pair.push((h.lastResult()?.value as { outcome: string } | undefined)?.outcome ?? 'error')
      const next = recipient
      recipient = sender
      sender = next
    }
    // The pair is genuinely saturated: this is the state that used to poison
    // every other conversation the sender had.
    expect(pair.at(-1)).toBe('refused:hop_runaway')

    h.advance(3_000)
    await h.plane.handleRequest(ALEX, request('peer.deliver', { to: 'Coral', text: 'new' }, 'c1'))
    expect(h.lastResult()?.value).toMatchObject({ outcome: 'queued_live' })

    // And the new pair has its OWN budget, not a leftover slice of the old one.
    h.advance(3_000)
    await h.plane.handleRequest(CORAL, request('peer.deliver', { to: 'Alex', text: 'back' }, 'c2'))
    expect(h.lastResult()?.value).toMatchObject({ outcome: 'queued_live' })
  })

  test('a one-way stream is not a runaway conversation', async () => {
    // The budget counts an exchange, so it advances off the record the RECIPIENT
    // wrote. Counting the sender's own direction too would have made fifty sends
    // with no reply a `hop_runaway`, taking the pending cap out of reach.
    const h = harness()
    for (let i = 0; i < MAX_PEER_HOPS + 4; i++) {
      h.advance(2_000)
      await h.plane.handleRequest(
        ALEX,
        request('peer.deliver', { to: 'Bear', text: `body ${i}` }, `r${i}`),
      )
      expect(h.lastResult()?.value).toMatchObject({ outcome: 'queued_live' })
    }
  })

  test('T1 — a ring is caught by the LONGEST chain, not the last one written', async () => {
    // The chain store is a map, and the fixture's insertion order happened to
    // leave the long chain last, so a re-implementation that took any matching
    // record passed every test. Here the SHORT record is written after the long
    // one: Dune messages Coral between Bear's hop and Coral's reply, so
    // last-iterated-wins inherits `[Dune]`, sees no Alex in it, and lets the ring
    // close.
    const h = harness({
      rows: [row(ALEX, 'Alex'), row(BEAR, 'Bear'), row(CORAL, 'Coral'), row(DUNE, 'Dune')],
      live: new Set([ALEX, BEAR, CORAL, DUNE]),
    })
    h.advance(3_000)
    await h.plane.handleRequest(ALEX, request('peer.deliver', { to: 'Bear', text: 'a' }, 'r1'))
    h.advance(3_000)
    await h.plane.handleRequest(BEAR, request('peer.deliver', { to: 'Coral', text: 'b' }, 'r2'))
    h.advance(3_000)
    await h.plane.handleRequest(DUNE, request('peer.deliver', { to: 'Coral', text: 'noise' }, 'r3'))
    expect(h.lastResult()?.value).toMatchObject({ outcome: 'queued_live' })

    h.advance(3_000)
    await h.plane.handleRequest(CORAL, request('peer.deliver', { to: 'Alex', text: 'c' }, 'r4'))
    expect(h.lastResult()?.value).toMatchObject({ outcome: 'refused:hop_loop' })
  })
})

describe('H2 — a message that went nowhere is not reported as already delivered', () => {
  test('a retry after a failed wake is attempted again, not refused as a duplicate', async () => {
    const h = harness({
      rows: [row(ALEX, 'Alex'), row(BEAR, 'Bear', { shutdown: 'parked' })],
      live: new Set([ALEX]),
      restoreResult: async () => ({ ok: false, error: { code: 'spawn_failed', message: 'no' } }),
    })
    await h.plane.handleRequest(ALEX, request('peer.deliver', { to: 'Bear', text: 'same' }, 'r1'))
    expect(h.lastResult()?.value).toMatchObject({ outcome: 'refused:wake_failed' })

    // The body was recorded before the wake was attempted, so the retry used to
    // come back `refused:duplicate`: the peer already has it, wait for a reply.
    // It never had it.
    await h.plane.handleRequest(ALEX, request('peer.deliver', { to: 'Bear', text: 'same' }, 'r2'))
    expect(h.lastResult()?.value).toMatchObject({ outcome: 'refused:wake_failed' })
    expect(h.restored).toEqual([BEAR, BEAR])
  })

  test('two identical sends in flight are still caught', async () => {
    const h = harness()
    await h.plane.handleRequest(ALEX, request('peer.deliver', { to: 'Bear', text: 'same' }, 'r1'))
    expect(h.lastResult()?.value).toMatchObject({ outcome: 'queued_live' })
    await h.plane.handleRequest(ALEX, request('peer.deliver', { to: 'Bear', text: 'same' }, 'r2'))
    expect(h.lastResult()?.value).toMatchObject({ outcome: 'refused:duplicate' })
  })
})

describe('M2 — the pending cap bounds the wake path too', () => {
  test('deliveries waking the same recipient concurrently cannot pass the cap', async () => {
    const h = harness({
      rows: [row(ALEX, 'Alex'), row(BEAR, 'Bear', { shutdown: 'parked' })],
      live: new Set([ALEX]),
    })
    const overshoot = 30
    const inflight: Promise<void>[] = []
    for (let i = 0; i < MAX_PENDING_PEER_MESSAGES + overshoot; i++) {
      h.advance(2_000)
      inflight.push(
        h.plane.handleRequest(
          ALEX,
          request('peer.deliver', { to: 'Bear', text: `body ${i}` }, `r${i}`),
        ),
      )
    }
    // Every one of them is now parked on the same wake, past the check that used
    // to read the pending count: each read zero and all of them were held.
    await settle()
    h.plane.onReady(BEAR)
    await Promise.all(inflight)

    expect(h.plane.pendingFor(BEAR)).toHaveLength(MAX_PENDING_PEER_MESSAGES)
    const refused = h
      .results()
      .filter(
        result =>
          result.ok === true &&
          (result.value as { outcome?: string }).outcome === 'refused:queue_full',
      )
    expect(refused).toHaveLength(overshoot)
  })

  test('a refused wake gives its slot back', async () => {
    const h = harness({
      rows: [row(ALEX, 'Alex'), row(BEAR, 'Bear', { shutdown: 'parked' })],
      live: new Set([ALEX]),
      restoreResult: async () => ({ ok: false, error: { code: 'spawn_failed', message: 'no' } }),
    })
    for (let i = 0; i < MAX_PENDING_PEER_MESSAGES + 5; i++) {
      h.advance(2_000)
      await h.plane.handleRequest(
        ALEX,
        request('peer.deliver', { to: 'Bear', text: `body ${i}` }, `r${i}`),
      )
      // A held reservation that is never released would start answering
      // queue_full for a recipient holding nothing at all.
      expect(h.lastResult()?.value).toMatchObject({ outcome: 'refused:wake_failed' })
    }
    expect(h.plane.pendingFor(BEAR)).toEqual([])
  })
})

describe('M4 — a host call cannot outrun the caller waiting on it', () => {
  test('a restore that never answers is bounded and refused', async () => {
    const h = harness({
      rows: [row(ALEX, 'Alex'), row(BEAR, 'Bear', { shutdown: 'parked' })],
      live: new Set([ALEX]),
      restoreResult: () => new Promise(() => {}),
    })
    const inflight = h.plane.handleRequest(
      ALEX,
      request('peer.deliver', { to: 'Bear', text: 'hi' }),
    )
    await settle()
    // Unbounded, this await never returns and the sidecar settles the caller
    // with a timeout while main is still working.
    h.expireWakes()
    await inflight
    expect(h.lastResult()?.value).toMatchObject({ outcome: 'refused:wake_failed' })
  })

  test('a spawn that never answers is bounded and refused', async () => {
    const h = harness({ createResult: () => new Promise(() => {}) })
    const inflight = h.plane.handleRequest(ALEX, request('peer.create', { prompt: 'go' }))
    await settle()
    // The one that costs a real session: the sidecar forgets the request id and
    // the model's retry spawns a SECOND session for the same ask.
    h.expireWakes()
    await inflight
    expect(h.lastResult()?.ok).toBe(false)
    expect(h.lastResult()?.error?.code).toBe('spawn_failed')
  })
})

describe('M1 — existence and readiness are different questions', () => {
  test('a row that exists but cannot take a frame is WOKEN, not written to', async () => {
    // `spawning`, `connecting` and `disconnected` all read as existing. Treating
    // that as live skipped the wake entirely, the send was refused, and for a
    // disconnected row nothing on this path ever tried again.
    const h = harness({
      rows: [row(ALEX, 'Alex'), row(BEAR, 'Bear')],
      live: new Set([ALEX, BEAR]),
      ready: new Set([ALEX]),
    })
    const inflight = h.plane.handleRequest(
      ALEX,
      request('peer.deliver', { to: 'Bear', text: 'hi' }),
    )
    await settle()
    h.plane.onReady(BEAR)
    await inflight

    expect(h.restored).toEqual([BEAR])
    expect(h.lastResult()?.value).toMatchObject({ outcome: 'queued_wake' })
    expect(h.deliveries()).toHaveLength(1)
  })
})

describe('redelivery, naming and reap', () => {
  test('only a hand-off that succeeded is charged to the delivery budget', async () => {
    const forwardFails = new Set<string>()
    const h = harness({ forwardFails })
    await h.plane.handleRequest(ALEX, request('peer.deliver', { to: 'Bear', text: 'survive' }))
    expect(h.plane.pendingFor(BEAR)).toEqual(['msg-1'])

    // Two transient send failures. Counting these spent the allowance on
    // failures the recipient never saw, so one real rejection afterwards dropped
    // the message.
    forwardFails.add(BEAR)
    h.plane.onReady(BEAR)
    h.plane.onReady(BEAR)
    forwardFails.delete(BEAR)
    h.plane.onReady(BEAR)

    expect(h.plane.pendingFor(BEAR)).toEqual(['msg-1'])
    expect(h.logged).toEqual([])
  })

  test('the give-up line is attributed to the sender, like every other line', async () => {
    const h = harness()
    await h.plane.handleRequest(ALEX, request('peer.deliver', { to: 'Bear', text: 'survive' }))
    for (let i = 0; i < MAX_PEER_DELIVERY_ATTEMPTS; i++) h.plane.onReady(BEAR)
    expect(h.plane.pendingFor(BEAR)).toEqual([])
    expect(h.logged).toEqual([
      {
        appSessionId: ALEX,
        from: 'Alex',
        to: 'Bear',
        kind: 'request',
        messageId: 'msg-1',
        outcome: 'refused:delivery_failed',
      },
    ])
  })

  test('a created session with no name is a typed failure, not a frame nobody accepts', async () => {
    // `''` is a value the recipient's own schema rejects, so it turned a session
    // that WAS created into an internal error at the boundary instead.
    const h = harness({
      createResult: async () => ({ ok: true, value: { appSessionId: CORAL, name: '' } }),
    })
    const inflight = h.plane.handleRequest(ALEX, request('peer.create', { prompt: 'go' }))
    await settle()
    // Minting `''` did not answer at all until the wake timed out, and then
    // answered `ok` with an unusable name; both halves are wrong.
    h.expireWakes()
    await inflight
    expect(h.lastResult()?.ok).toBe(false)
    expect(h.lastResult()?.error?.code).toBe('internal_error')
    expect(h.deliveries()).toHaveLength(0)
  })

  test('a reaped row leaves no ready timestamp behind', async () => {
    const h = harness({
      rows: [row(ALEX, 'Alex'), row(BEAR, 'Bear', { shutdown: 'parked' })],
      live: new Set([ALEX]),
    })
    h.plane.onReady(BEAR)
    h.plane.onSessionRemoved(BEAR)

    // The stale timestamp used to satisfy the next wake instantly, so a row that
    // had announced nothing since it was reaped read as already up.
    const inflight = h.plane.handleRequest(
      ALEX,
      request('peer.deliver', { to: 'Bear', text: 'hi' }),
    )
    await settle()
    h.expireWakes()
    await inflight
    expect(h.lastResult()?.value).toMatchObject({ outcome: 'refused:wake_failed' })
  })
})
