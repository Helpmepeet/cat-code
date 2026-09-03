import { expect, test } from 'bun:test'
import type { SessionDescriptor } from '../../shared/hostApi.js'
import type { ConnectionSnapshot } from './connectionState.js'
import { deriveTabVisualState } from './tabStatus.js'

function descriptor(
  overrides: Partial<SessionDescriptor> = {},
): SessionDescriptor {
  return {
    appSessionId: 'a',
    engineSessionId: 'engine-a',
    cwd: '/tmp/a',
    title: null,
    forked: false,
    name: null,
    createdBy: null,
    peerWakeBlocked: false,
    titleUpdatedAt: null,
    status: 'ready',
    restorable: false,
    parked: false,
    createdAt: 0,
    lastAttachedAt: 0,
    lastMessageSentAt: null,
    ...overrides,
  }
}

const ready: ConnectionSnapshot = { status: 'ready', inputEnabled: true }

test('a ready session is live, not restartable, no chip escalation', () => {
  const visual = deriveTabVisualState({
    descriptor: descriptor({ status: 'ready' }),
    connection: ready,
    pendingPermissionCount: 0,
    isActive: true,
  })
  expect(visual.tone).toBe('live')
  // Unified status vocabulary (audit §I.2): `ready` reads as `live`, matching
  // the Sidebar/palette. TabBar suppresses the chip for a `tone:'live'` tab.
  expect(visual.label).toBe('live')
  expect(visual.restartable).toBe(false)
  expect(visual.needsAttention).toBe(false)
})

test('a spawning session reads starting (warn)', () => {
  const visual = deriveTabVisualState({
    descriptor: descriptor({ status: 'spawning' }),
    connection: { status: 'starting', inputEnabled: false },
    pendingPermissionCount: 0,
    isActive: false,
  })
  // Unified vocabulary (audit §I.2): `warn`, matching the Sidebar's spawning row
  // (the old tab-only `busy` tone is gone).
  expect(visual.tone).toBe('warn')
  expect(visual.label).toBe('starting')
  expect(visual.restartable).toBe(false)
})

test('an exited session is dead + restartable (the dead-tab affordance)', () => {
  const visual = deriveTabVisualState({
    descriptor: descriptor({ status: 'exited', restorable: true }),
    connection: { status: 'exited', inputEnabled: false },
    pendingPermissionCount: 0,
    isActive: false,
  })
  expect(visual.tone).toBe('dead')
  // Unified vocabulary (audit §I.2): `closed`, matching the Sidebar's exited row.
  expect(visual.label).toBe('closed')
  expect(visual.restartable).toBe(true)
})

test('a disconnected descriptor is dead + restartable', () => {
  const visual = deriveTabVisualState({
    descriptor: descriptor({ status: 'disconnected' }),
    connection: { status: 'disconnected', inputEnabled: false },
    pendingPermissionCount: 0,
    isActive: false,
  })
  expect(visual.tone).toBe('dead')
  expect(visual.restartable).toBe(true)
})

test('an idle-PARKED tab is neither a failure nor a restart prompt', () => {
  // IDLE-PARK — the host descriptor here is the crash descriptor verbatim
  // (disconnected + restorable), because the descriptor deliberately cannot carry
  // the distinction (§11). Left to that alone the tab painted the danger dot and
  // offered a Restart button for an engine the app itself reclaimed on purpose.
  const visual = deriveTabVisualState({
    descriptor: descriptor({ status: 'disconnected', restorable: true }),
    connection: { status: 'parked', inputEnabled: false },
    pendingPermissionCount: 0,
    isActive: false,
  })
  expect(visual.tone).not.toBe('dead')
  expect(visual.tone).toBe('busy')
  expect(visual.restartable).toBe(false)
  // The word only reaches assistive tech (the TabBar renders a dot, not a chip),
  // and it must not be a failure word.
  expect(visual.label).toBe('idle')
})

test('a crash is still a crash — the same descriptor without the parked connection', () => {
  // The control for the case above: identical host descriptor, ordinary terminal
  // connection. A real crash must keep its danger dot and its restart affordance.
  const visual = deriveTabVisualState({
    descriptor: descriptor({ status: 'disconnected', restorable: true }),
    connection: { status: 'exited', inputEnabled: false },
    pendingPermissionCount: 0,
    isActive: false,
  })
  expect(visual.tone).toBe('dead')
  expect(visual.restartable).toBe(true)
})

test('a parked session that can never come back is not dressed up as resting', () => {
  // A session parked before it ever ran a turn has no transcript on disk, so
  // `canResume` refuses it and BOTH restore and restart fail. `restorable:false`
  // is how that reaches the tab. Painting it `idle` with no affordance would
  // convert a visible failure into a silent one: the user could type into it
  // forever, losing their paste pills to `retireDraft` on every attempt.
  const visual = deriveTabVisualState({
    descriptor: descriptor({ status: 'disconnected', restorable: false }),
    connection: { status: 'parked', inputEnabled: false },
    pendingPermissionCount: 0,
    isActive: false,
  })
  expect(visual.label).not.toBe('idle')
  expect(visual.tone).toBe('dead')
})

test('unparking shows starting, not idle, while the engine actually boots', () => {
  // The connection snapshot stays `parked` until the resumed sidecar's `ready`
  // frame, but the host reports `spawning` the moment the restore starts. The
  // descriptor is the authority on liveness, so the real boot must be visible
  // rather than hidden behind the parked reading for several seconds.
  const visual = deriveTabVisualState({
    descriptor: descriptor({ status: 'spawning', restorable: false }),
    connection: { status: 'parked', inputEnabled: false },
    pendingPermissionCount: 0,
    isActive: true,
  })
  expect(visual.label).toBe('starting')
  expect(visual.tone).toBe('warn')
})

test('a parked background tab suppresses a stale permission badge its pane cannot render', () => {
  const visual = deriveTabVisualState({
    descriptor: descriptor({ status: 'disconnected', restorable: true }),
    connection: { status: 'parked', inputEnabled: false },
    pendingPermissionCount: 1,
    isActive: false,
  })
  expect(visual.needsAttention).toBe(false)
})

test('a background tab whose transport already died escalates to dead before the host status catches up', () => {
  // Host still says ready, but the P3-4 connection view saw a send fail (dead).
  const visual = deriveTabVisualState({
    descriptor: descriptor({ status: 'ready' }),
    connection: { status: 'dead', inputEnabled: false },
    pendingPermissionCount: 0,
    isActive: false,
  })
  expect(visual.tone).toBe('dead')
  expect(visual.restartable).toBe(true)
})

test('a disconnected background tab suppresses a stale permission badge', () => {
  const visual = deriveTabVisualState({
    descriptor: descriptor({ status: 'ready' }),
    connection: { status: 'disconnected', inputEnabled: false },
    pendingPermissionCount: 1,
    isActive: false,
  })
  expect(visual.needsAttention).toBe(false)
})

test('a pending permission on a BACKGROUND tab raises the attention badge', () => {
  const visual = deriveTabVisualState({
    descriptor: descriptor({ status: 'ready' }),
    connection: ready,
    pendingPermissionCount: 1,
    isActive: false,
  })
  expect(visual.needsAttention).toBe(true)
})

test('the attention badge is suppressed on the ACTIVE tab (its pane already shows the request)', () => {
  const visual = deriveTabVisualState({
    descriptor: descriptor({ status: 'ready' }),
    connection: ready,
    pendingPermissionCount: 1,
    isActive: true,
  })
  expect(visual.needsAttention).toBe(false)
})
