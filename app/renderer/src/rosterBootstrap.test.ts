import { expect, test } from 'bun:test'
import type { SessionDescriptor } from '../../shared/hostApi.js'
import {
  attemptRosterBootstrap,
  createRosterBootstrapState,
  mergeRosterSnapshot,
  reduceRosterBootstrapState,
  type RosterBootstrapState,
} from './rosterBootstrap.js'
import { createShellState, reduceShellState } from './shellState.js'

function descriptor(
  appSessionId: string,
  over: Partial<SessionDescriptor> = {},
): SessionDescriptor {
  return {
    appSessionId,
    engineSessionId: null,
    cwd: `/work/${appSessionId}`,
    title: null,
    titleUpdatedAt: null,
    status: 'ready',
    restorable: false,
    parked: false,
    createdAt: 1,
    lastAttachedAt: 1,
    lastMessageSentAt: null,
    ...over,
  }
}

function createHarness(
  listSessions: () => Promise<readonly SessionDescriptor[]>,
) {
  let bootstrap = createRosterBootstrapState()
  let shell = createShellState()
  const removed = new Set<string>()
  const attempt = () =>
    attemptRosterBootstrap({
      listSessions,
      onStarted: () => {
        bootstrap = reduceRosterBootstrapState(bootstrap, {
          type: 'read-started',
        })
      },
      onSnapshot: sessions => {
        shell = mergeRosterSnapshot(shell, sessions, removed)
        bootstrap = reduceRosterBootstrapState(bootstrap, {
          type: 'read-succeeded',
        })
      },
      onFailure: () => {
        bootstrap = reduceRosterBootstrapState(bootstrap, {
          type: 'read-failed',
        })
      },
    })
  return {
    attempt,
    get bootstrap(): RosterBootstrapState {
      return bootstrap
    },
    get shell() {
      return shell
    },
    foldLive(event: Parameters<typeof reduceShellState>[1]) {
      shell = reduceShellState(shell, event)
      if (event.type === 'session-removed') removed.add(event.appSessionId)
    },
  }
}

test('an initial rejected roster read becomes failure, not ready', async () => {
  const harness = createHarness(() => Promise.reject(new Error('ipc failed')))

  await harness.attempt()

  expect(harness.bootstrap).toEqual({ status: 'failure', retrying: false })
  expect(harness.shell).toEqual(createShellState())
})

test('a rejected retry re-enters the read path and remains failure', async () => {
  let calls = 0
  const harness = createHarness(() => {
    calls += 1
    return Promise.reject(new Error('still unavailable'))
  })

  await harness.attempt()
  const retry = harness.attempt()
  expect(harness.bootstrap).toEqual({ status: 'failure', retrying: true })
  await retry

  expect(calls).toBe(2)
  expect(harness.bootstrap).toEqual({ status: 'failure', retrying: false })
})

test('a successful retry clears failure and marks the snapshot ready', async () => {
  let calls = 0
  const harness = createHarness(() => {
    calls += 1
    return calls === 1
      ? Promise.reject(new Error('first read failed'))
      : Promise.resolve([descriptor('restored', { restorable: true })])
  })

  await harness.attempt()
  await harness.attempt()

  expect(calls).toBe(2)
  expect(harness.bootstrap).toEqual({ status: 'ready', retrying: false })
  expect(harness.shell.order).toEqual(['restored'])
})

test('live host events and removals survive a retry snapshot', async () => {
  let resolveRetry:
    | ((sessions: readonly SessionDescriptor[]) => void)
    | undefined
  let calls = 0
  const harness = createHarness(() => {
    calls += 1
    if (calls === 1) return Promise.reject(new Error('first read failed'))
    return new Promise(resolve => {
      resolveRetry = resolve
    })
  })

  await harness.attempt()
  const retry = harness.attempt()
  harness.foldLive({
    type: 'session-status',
    session: descriptor('live', { title: 'fresh', lastAttachedAt: 20 }),
  })
  harness.foldLive({
    type: 'session-added',
    session: descriptor('removed', { lastAttachedAt: 20 }),
  })
  harness.foldLive({ type: 'session-removed', appSessionId: 'removed' })

  resolveRetry?.([
    descriptor('live', { title: 'stale', lastAttachedAt: 10 }),
    descriptor('removed', { lastAttachedAt: 10 }),
    descriptor('snapshot-only', { restorable: true }),
  ])
  await retry

  expect(harness.bootstrap).toEqual({ status: 'ready', retrying: false })
  expect(harness.shell.byId.live?.title).toBe('fresh')
  expect(harness.shell.byId.removed).toBeUndefined()
  expect(harness.shell.byId['snapshot-only']).toBeDefined()
})
