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
    titleUpdatedAt: null,
    status: 'ready',
    restorable: false,
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
