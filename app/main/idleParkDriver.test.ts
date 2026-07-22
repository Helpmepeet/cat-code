/**
 * IDLE-PARK policy-driver unit tests (decisions/IDLE-PARK.md §4). Pure victim
 * selection + lifecycle, no Electron / host / supervisor — the host is the
 * injected `listSessions`, parking is the injected `park` spy.
 */

import { expect, test } from 'bun:test'
import type { SessionDescriptor } from '../shared/hostApi.js'
import { createIdleParkDriver, MAX_LIVE_ENGINES } from './idleParkDriver.js'

function desc(
  over: Partial<SessionDescriptor> & { appSessionId: string },
): SessionDescriptor {
  return {
    engineSessionId: `engine-${over.appSessionId}`,
    cwd: '/tmp',
    title: null,
    status: 'ready',
    restorable: false,
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

test('recency falls back lastMessageSentAt → lastAttachedAt → createdAt', () => {
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
