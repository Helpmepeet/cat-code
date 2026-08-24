/**
 * IDLE-PARK policy-driver unit tests (decisions/IDLE-PARK.md §4). Pure victim
 * selection + lifecycle, no Electron / host / supervisor — the host is the
 * injected `listSessions`, parking is the injected `park` spy.
 */

import { expect, test } from 'bun:test'
import type { SessionDescriptor } from '../shared/hostApi.js'
import {
  createIdleParkDriver as createIdleParkDriverWithDeps,
  MAX_LIVE_ENGINES,
  type IdleParkDriverDeps,
} from './idleParkDriver.js'

function createIdleParkDriver(
  deps: Omit<IdleParkDriverDeps, 'canResume'>,
) {
  return createIdleParkDriverWithDeps({
    ...deps,
    canResume: () => true,
  })
}

function desc(
  over: Partial<SessionDescriptor> & { appSessionId: string },
): SessionDescriptor {
  return {
    engineSessionId: `engine-${over.appSessionId}`,
    cwd: '/tmp',
    title: null,
    forked: false,
    titleUpdatedAt: null,
    status: 'ready',
    restorable: false,
    parked: false,
    createdAt: 0,
    lastAttachedAt: 0,
    lastMessageSentAt: null,
    ...over,
  }
}

test('cap — parks the least-recently-active live sessions beyond MAX_LIVE_ENGINES, keeps the top-K recent', () => {
  // MAX_LIVE_ENGINES + 2 live sessions, distinct recency (s1 oldest … s6 newest).
  const sessions: SessionDescriptor[] = []
  for (let i = 1; i <= MAX_LIVE_ENGINES + 2; i++) {
    sessions.push(desc({ appSessionId: `s${i}`, lastMessageSentAt: i * 100 }))
  }
  const parked: string[] = []
  const driver = createIdleParkDriver({
    listSessions: () => sessions,
    park: id => parked.push(id),
    // A huge TTL so ONLY the cap fires here.
    idleTtlMs: 1e12,
    now: () => 1_000,
  })

  driver.evaluate()

  // Exactly the 2 least-recent (s1, s2) parked; the top-K recent are kept.
  expect(parked.sort()).toEqual(['s1', 's2'])
})

test('cap — no parks when the live count is at or under the cap', () => {
  const sessions = Array.from({ length: MAX_LIVE_ENGINES }, (_v, i) =>
    desc({ appSessionId: `s${i}`, lastMessageSentAt: i * 100 }),
  )
  const parked: string[] = []
  const driver = createIdleParkDriver({
    listSessions: () => sessions,
    park: id => parked.push(id),
    idleTtlMs: 1e12,
    now: () => 1_000,
  })

  driver.evaluate()

  expect(parked).toEqual([])
})

test('idle-TTL — parks a session idle beyond the TTL even while under the cap; a fresh one is kept', () => {
  const idle = desc({ appSessionId: 'idle', lastMessageSentAt: 5_000 })
  const fresh = desc({ appSessionId: 'fresh', lastMessageSentAt: 9_500 })
  const parked: string[] = []
  const driver = createIdleParkDriver({
    listSessions: () => [idle, fresh],
    park: id => parked.push(id),
    // Cap far above 2 so ONLY the TTL fires. cutoff = 10000 - 1000 = 9000.
    maxLiveEngines: 100,
    idleTtlMs: 1_000,
    now: () => 10_000,
  })

  driver.evaluate()

  expect(parked).toEqual(['idle'])
})

/* ------------------------------------------------------------------------- *
 * Visible-pane protection (§4 open decision 4, resolved 2026-08-05 to option b)
 * ------------------------------------------------------------------------- */

test('idle-TTL — a session the user is looking at is never parked under them', () => {
  // Both are idle past the TTL; only the background one may be reclaimed.
  const onScreen = desc({ appSessionId: 'on-screen', lastMessageSentAt: 5_000 })
  const background = desc({ appSessionId: 'background', lastMessageSentAt: 5_000 })
  const parked: string[] = []
  const driver = createIdleParkDriver({
    listSessions: () => [onScreen, background],
    park: id => parked.push(id),
    protectedSessions: () => new Set(['on-screen']),
    maxLiveEngines: 100,
    idleTtlMs: 1_000,
    now: () => 10_000,
  })

  driver.evaluate()

  expect(parked).toEqual(['background'])
})

test('cap — protection redirects the victim, it does not raise the engine ceiling', () => {
  // 3 live against a cap of 2: one must go. The least-recent (s1) is on screen,
  // so the cap takes the next least-recent instead of skipping the sweep or
  // letting 3 engines stand.
  const sessions = [
    desc({ appSessionId: 's1', lastMessageSentAt: 100 }),
    desc({ appSessionId: 's2', lastMessageSentAt: 200 }),
    desc({ appSessionId: 's3', lastMessageSentAt: 300 }),
  ]
  const parked: string[] = []
  const driver = createIdleParkDriver({
    listSessions: () => sessions,
    park: id => parked.push(id),
    protectedSessions: () => new Set(['s1']),
    maxLiveEngines: 2,
    idleTtlMs: 1e12,
    now: () => 1_000,
  })

  driver.evaluate()

  expect(parked).toEqual(['s2'])
})

test('cap — a fully protected live set parks nothing rather than picking a victim anyway', () => {
  // Everything over the cap is on screen (a wide split). Reclaiming memory never
  // outranks not killing a session under the user; the next sweep re-evaluates.
  const sessions = [
    desc({ appSessionId: 's1', lastMessageSentAt: 100 }),
    desc({ appSessionId: 's2', lastMessageSentAt: 200 }),
    desc({ appSessionId: 's3', lastMessageSentAt: 300 }),
  ]
  const parked: string[] = []
  const driver = createIdleParkDriver({
    listSessions: () => sessions,
    park: id => parked.push(id),
    protectedSessions: () => new Set(['s1', 's2', 's3']),
    maxLiveEngines: 1,
    idleTtlMs: 1_000,
    now: () => 1e9,
  })

  driver.evaluate()

  expect(parked).toEqual([])
})

test('protection is re-read every sweep, so closing a pane un-protects it at once', () => {
  const session = desc({ appSessionId: 'pane', lastMessageSentAt: 5_000 })
  let visible = new Set(['pane'])
  const parked: string[] = []
  const driver = createIdleParkDriver({
    listSessions: () => [session],
    park: id => parked.push(id),
    protectedSessions: () => visible,
    maxLiveEngines: 100,
    idleTtlMs: 1_000,
    now: () => 10_000,
  })

  driver.evaluate()
  expect(parked).toEqual([])

  visible = new Set()
  driver.evaluate()
  expect(parked).toEqual(['pane'])
})

test('no protection reported ⇒ the pre-2026-08-05 selection, unchanged', () => {
  const session = desc({ appSessionId: 'idle', lastMessageSentAt: 5_000 })
  const parked: string[] = []
  const driver = createIdleParkDriver({
    listSessions: () => [session],
    park: id => parked.push(id),
    maxLiveEngines: 100,
    idleTtlMs: 1_000,
    now: () => 10_000,
  })

  driver.evaluate()

  expect(parked).toEqual(['idle'])
})

test('recency is the newest of lastMessageSentAt / lastAttachedAt / createdAt', () => {
  // A session with no message sent uses lastAttachedAt for recency.
  const byAttach = desc({
    appSessionId: 'attach',
    lastMessageSentAt: null,
    lastAttachedAt: 5_000,
  })
  const fresh = desc({ appSessionId: 'fresh', lastMessageSentAt: 9_500 })
  const parked: string[] = []
  const driver = createIdleParkDriver({
    listSessions: () => [byAttach, fresh],
    park: id => parked.push(id),
    maxLiveEngines: 100,
    idleTtlMs: 1_000,
    now: () => 10_000, // cutoff 9000: attach(5000) idle, fresh(9500) not
  })

  driver.evaluate()

  expect(parked).toEqual(['attach'])
})

test('a just-restored session is NOT parked, however old its last turn', () => {
  // The real registry row behind the 2026-08-03 report, verbatim: restored one
  // minute ago (lastAttachedAt), last turn 18.6 hours earlier
  // (lastMessageSentAt), created the day before. Under the old `??` chain the
  // stale turn stamp won and this session was parked seconds after going ready.
  const restored = desc({
    appSessionId: '9d74a6cc',
    createdAt: 1785667012145,
    lastMessageSentAt: 1785667397906,
    lastAttachedAt: 1785734279860,
  })
  const parked: string[] = []
  const driver = createIdleParkDriver({
    listSessions: () => [restored],
    park: id => parked.push(id),
    // Cap far above 1 so ONLY the TTL can fire, at its shipped 20 minutes.
    maxLiveEngines: 100,
    now: () => 1785734279860 + 60_000,
  })

  driver.evaluate()

  expect(parked).toEqual([])
})

test('a restored session still parks once genuinely idle past the TTL', () => {
  // The same row, swept 21 minutes after the restore rather than 1: the attach
  // stamp is now itself beyond the TTL, so the fix must not make a restored
  // session permanently unparkable.
  const restored = desc({
    appSessionId: '9d74a6cc',
    createdAt: 1785667012145,
    lastMessageSentAt: 1785667397906,
    lastAttachedAt: 1785734279860,
  })
  const parked: string[] = []
  const driver = createIdleParkDriver({
    listSessions: () => [restored],
    park: id => parked.push(id),
    maxLiveEngines: 100,
    now: () => 1785734279860 + 21 * 60_000,
  })

  driver.evaluate()

  expect(parked).toEqual(['9d74a6cc'])
})

test('never parks a non-live (disconnected / exited) session, however old', () => {
  const parked: string[] = []
  const driver = createIdleParkDriver({
    listSessions: () => [
      desc({ appSessionId: 'disc', status: 'disconnected', lastMessageSentAt: 1 }),
      desc({ appSessionId: 'exit', status: 'exited', lastMessageSentAt: 1 }),
    ],
    park: id => parked.push(id),
    maxLiveEngines: 0,
    idleTtlMs: 1,
    now: () => 1_000_000,
  })

  driver.evaluate()

  expect(parked).toEqual([])
})

test('never parks a live session the host cannot resume', () => {
  // An engine session id exists at ready, but the engine creates its transcript
  // only once a turn runs. The target is oldest and over the cap; without the
  // host predicate it would be parked and stranded.
  const sessions = [
    desc({ appSessionId: 'never-typed', lastMessageSentAt: 0 }),
    desc({ appSessionId: 'resumable-old', lastMessageSentAt: 100 }),
    desc({ appSessionId: 'resumable-2', lastMessageSentAt: 200 }),
    desc({ appSessionId: 'resumable-3', lastMessageSentAt: 300 }),
    desc({ appSessionId: 'resumable-4', lastMessageSentAt: 400 }),
  ]
  const parked: string[] = []
  const driver = createIdleParkDriverWithDeps({
    listSessions: () => sessions,
    canResume: id => id !== 'never-typed',
    park: id => parked.push(id),
    idleTtlMs: 1e12,
    now: () => 1_000,
  })

  driver.evaluate()

  expect(parked).toEqual(['resumable-old'])
})

test('a park that throws (victim raced to exit) does not abort the sweep', () => {
  const sessions: SessionDescriptor[] = []
  for (let i = 1; i <= MAX_LIVE_ENGINES + 2; i++) {
    sessions.push(desc({ appSessionId: `s${i}`, lastMessageSentAt: i * 100 }))
  }
  const attempted: string[] = []
  const driver = createIdleParkDriver({
    listSessions: () => sessions,
    park: id => {
      attempted.push(id)
      if (id === 's1') throw new Error('session not ready')
    },
    idleTtlMs: 1e12,
    now: () => 1_000,
    log: () => {},
  })

  driver.evaluate()

  // Both least-recent victims were ATTEMPTED — s1's throw did not stop s2.
  expect(attempted.sort()).toEqual(['s1', 's2'])
})

test('start subscribes to host events + arms the sweep timer; stop unsubscribes + clears it', () => {
  const sessions: SessionDescriptor[] = []
  for (let i = 1; i <= MAX_LIVE_ENGINES + 1; i++) {
    sessions.push(desc({ appSessionId: `s${i}`, lastMessageSentAt: i * 100 }))
  }
  const parked: string[] = []
  let hostListener: (() => void) | null = null
  let unsubscribed = false
  let timerCleared = false
  const driver = createIdleParkDriver({
    listSessions: () => sessions,
    park: id => parked.push(id),
    subscribeHostEvents: listener => {
      hostListener = listener
      return () => {
        unsubscribed = true
      }
    },
    idleTtlMs: 1e12,
    now: () => 1_000,
    setTimer: () => 42 as unknown as ReturnType<typeof setTimeout>,
    clearTimer: () => {
      timerCleared = true
    },
  })

  driver.start()
  expect(hostListener).not.toBeNull()

  // A host event (session added / status) re-evaluates the cap.
  hostListener!()
  expect(parked).toEqual(['s1'])

  driver.stop()
  expect(unsubscribed).toBe(true)
  expect(timerCleared).toBe(true)

  // After stop, further host events are ignored.
  parked.length = 0
  hostListener!()
  expect(parked).toEqual([])
})
