import { expect, test } from 'bun:test'
import type { SessionDescriptor } from '../../shared/hostApi.js'
import { createShellState, reduceShellState, selectPaneSessions, selectPeerOpenUnseen, type ShellState } from './shellState.js'
import { PEER_OPENS_SEEN_KEY, readPeerOpensSeen, writePeerOpensSeen } from './peerOpensSeen.js'
import { mergeRosterSnapshot } from './rosterBootstrap.js'
import { dismissSession, dismissSessionAndRequestStop, isSessionDismissed, loadSessionDismissalPreferences, readSessionDismissals, reopenSession, resolveDismissiblePendingSubmit, saveSessionDismissalPreferences, SESSION_DISMISSALS_KEY, writeSessionDismissals } from './sessionDismissal.js'
import { createPendingSubmitState, reducePendingSubmitHeld, reducePendingSubmitCleared, restoreDraftWithPending, reduceRetainedSubmitHeld, reduceRetainedSubmitCleared, reduceSubmitAnswers } from './composerState.js'
import { PROTOCOL_VERSION } from '../../shared/protocol.js'

const appSessionId = '00000000-0000-4000-8000-000000000001'
const engineSessionId = '00000000-0000-4000-8000-000000000002'
const session: SessionDescriptor = {
  appSessionId, engineSessionId, cwd: '/isolated', title: null, name: null,
  forked: false, createdBy: null, peerWakeBlocked: false, titleUpdatedAt: null,
  status: 'ready', restorable: false, parked: false, createdAt: 1,
  lastAttachedAt: 1, lastMessageSentAt: null,
}
function storage() {
  const data = new Map<string, string>()
  return { data, getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value) } }
}

test.each(['stalled', 'refused', 'throwing'] as const)('dismissal is independent of %s cleanup and retains discovery/history identity', async outcome => {
  let shell = reduceShellState(createShellState(), { type: 'session-added', session })
  const saved = storage()
  let stopRequests = 0
  const close = dismissSessionAndRequestStop([], session, entries => {
    writeSessionDismissals(saved, entries)
    shell = reduceShellState(shell, { type: 'session-dismissals', dismissals: entries })
  }, () => {
    stopRequests++
    expect(selectPaneSessions(shell)).toEqual([])
    return outcome === 'stalled' ? new Promise(() => {}) : outcome === 'refused'
      ? Promise.resolve({ ok: false }) : Promise.reject(new Error('close failed'))
  })
  void close.catch(() => {})
  expect(stopRequests).toBe(1)
  expect(selectPaneSessions(shell)).toEqual([])
  expect(shell.byId[appSessionId]).toEqual(session)
  for (const type of ['session-status', 'session-added'] as const) {
    shell = reduceShellState(shell, { type, session: { ...session, status: 'spawning' } })
    expect(selectPaneSessions(shell)).toEqual([])
  }
  const reloaded = mergeRosterSnapshot({ ...createShellState(), dismissals: readSessionDismissals(saved) }, [session], new Set())
  expect(selectPaneSessions(reloaded)).toEqual([])
  expect(reloaded.byId[appSessionId]?.engineSessionId).toBe(engineSessionId)
})

test('deliberate reopening reconciles both identities, not unrelated dismissals', () => {
  const other = { ...session, appSessionId: '00000000-0000-4000-8000-000000000003', engineSessionId: '00000000-0000-4000-8000-000000000004' }
  const entries = dismissSession(dismissSession([], session), other)
  const remapped = { ...session, appSessionId: '00000000-0000-4000-8000-000000000005' }
  expect(isSessionDismissed(entries, remapped)).toBe(true)
  const reopened = reopenSession(entries, remapped)
  expect(isSessionDismissed(reopened, session)).toBe(false)
  expect(isSessionDismissed(reopened, other)).toBe(true)
  let shell = reduceShellState({ ...createShellState(), dismissals: reopened }, { type: 'session-added', session: remapped })
  expect(selectPaneSessions(shell)).toEqual([remapped])
  shell = reduceShellState(shell, { type: 'session-dismissals', dismissals: dismissSession(reopened, remapped) })
  shell = reduceShellState(shell, { type: 'preview-open', sessionId: remapped.appSessionId })
  expect(selectPaneSessions(shell)).toEqual([])
})

test('dismissal storage rejects malformed, excess, and unexpected data', () => {
  for (const value of [{}, [{ ...session }], [{ appSessionId: '../escape', engineSessionId: null }], Array(4097).fill({ appSessionId, engineSessionId })]) {
    const saved = storage()
    saved.setItem(SESSION_DISMISSALS_KEY, JSON.stringify(value))
    expect(() => readSessionDismissals(saved)).toThrow()
  }
  expect(() => writeSessionDismissals(null, [])).toThrow()
  expect(loadSessionDismissalPreferences(null).error).not.toBeNull()
})

test('late ready and parked connections release queued input for review instead of sending or restoring', () => {
  let pending = reducePendingSubmitHeld(createPendingSubmitState(), appSessionId, { text: 'queued draft', showQueuedRow: true })
  const entries = dismissSession([], session)
  for (const status of ['ready', 'parked', 'starting'] as const) {
    expect(resolveDismissiblePendingSubmit({ status, inputEnabled: true }, appSessionId, session, entries)).toBe('release')
    expect(resolveDismissiblePendingSubmit({ status, inputEnabled: true }, appSessionId, undefined, entries)).toBe('release')
  }
  const draft = restoreDraftWithPending('new draft', pending[appSessionId]!.text)
  pending = reducePendingSubmitCleared(pending, appSessionId)
  expect(pending).toEqual({})
  expect(draft).toContain('queued draft')
  expect(draft).toContain('new draft')
  expect(resolveDismissiblePendingSubmit({ status: 'ready', inputEnabled: true }, appSessionId, session, reopenSession(entries, session))).toBe('send')
})

test('late ready identity is retained across reload and suppresses an engine alias', () => {
  let shell = { ...createShellState(), dismissals: dismissSession([], { ...session, engineSessionId: null }) }
  shell = reduceShellState(shell, { type: 'session-status', session }) as typeof shell
  const saved = storage()
  writeSessionDismissals(saved, shell.dismissals)
  const entries = readSessionDismissals(saved)
  expect(isSessionDismissed(entries, { ...session, appSessionId: '00000000-0000-4000-8000-000000000006' })).toBe(true)
})

test.each([true, false])('late submit acknowledgement after dismissal cannot restore or requeue sent input (accepted: %s)', accepted => {
  const retained = reduceRetainedSubmitHeld({}, appSessionId, {
    submitId: 'close-submit', text: 'already sent', images: [], file: null,
  })
  const cleared = reduceRetainedSubmitCleared(retained, appSessionId)
  const answer = reduceSubmitAnswers(cleared, [{
    kind: 'submit.result', protocolVersion: PROTOCOL_VERSION, sessionId: appSessionId,
    submitId: 'close-submit', accepted,
  }])
  expect(answer.restored).toEqual([])
  expect(answer.state).toEqual({})
})

test.each(['full', 'write failure', 'read failure'] as const)('preference %s cannot prevent in-memory dismissal and stop, or overwrite saved dismissals', async failure => {
  const saved = storage()
  const prior = failure === 'full'
    ? Array.from({ length: 4096 }, (_, index) => ({
        appSessionId: `10000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
        engineSessionId: null,
      }))
    : [{ appSessionId: '10000000-0000-4000-8000-000000000001', engineSessionId: null }]
  writeSessionDismissals(saved, prior)
  const bytesBefore = saved.getItem(SESSION_DISMISSALS_KEY)
  let writes = 0
  const unavailable = {
    getItem: (key: string) => {
      if (failure === 'read failure') throw new Error('storage unavailable')
      return saved.getItem(key)
    },
    setItem: (_key: string, _value: string) => { writes++; throw new Error('quota exceeded') },
  }
  const storageForCase = failure === 'full' ? saved : unavailable
  const initial = loadSessionDismissalPreferences(storageForCase)
  let shell = reduceShellState({ ...createShellState(), dismissals: initial.entries }, { type: 'session-added', session })
  let warning: string | null = null
  let stopped = false
  await dismissSessionAndRequestStop(initial.entries, session, entries => {
    warning = saveSessionDismissalPreferences(storageForCase, entries, initial.error)
    shell = reduceShellState(shell, { type: 'session-dismissals', dismissals: entries })
  }, async () => {
    expect(selectPaneSessions(shell)).toEqual([])
    expect(warning).not.toBeNull()
    stopped = true
  })
  expect(stopped).toBe(true)
  expect(selectPaneSessions(shell)).toEqual([])
  expect(isSessionDismissed(shell.dismissals!, session)).toBe(true)
  expect(warning).not.toBeNull()
  expect(saved.getItem(SESSION_DISMISSALS_KEY)).toBe(bytesBefore)
  if (failure === 'read failure') expect(writes).toBe(0)
  if (failure === 'full') expect(shell.dismissals).toHaveLength(4097)
})

test('a peer-opened tab stays marked until shown, and a later wake of a closed chat marks it again', () => {
  const live = { ...session, peerOpenedAt: 100 }
  const unmarked = (shell: ShellState) => !selectPeerOpenUnseen(shell, appSessionId)

  // Created by a peer: a tab, marked, whatever status it goes through.
  let shell = reduceShellState(createShellState(), { type: 'session-added', session: { ...live, status: 'spawning' } })
  shell = reduceShellState(shell, { type: 'session-status', session: live })
  expect(selectPaneSessions(shell)).toEqual([live])
  expect(selectPeerOpenUnseen(shell, appSessionId)).toBe(true)

  // Opened and read.
  shell = reduceShellState(shell, { type: 'peer-opens-seen', sessionIds: [appSessionId] })
  expect(unmarked(shell)).toBe(true)

  // Closed by the user: stays closed through its own shutdown.
  shell = reduceShellState(shell, { type: 'session-dismissals', dismissals: dismissSession(shell.dismissals ?? [], live) })
  shell = reduceShellState(shell, { type: 'session-status', session: { ...live, status: 'exited', restorable: true } })
  expect(selectPaneSessions(shell)).toEqual([])

  // Woken by a peer: back in the strip, marked again, and the close is forgotten.
  const woken = { ...live, peerOpenedAt: 200, status: 'spawning' as const }
  shell = reduceShellState(shell, { type: 'session-status', session: woken })
  expect(selectPaneSessions(shell)).toEqual([woken])
  expect(selectPeerOpenUnseen(shell, appSessionId)).toBe(true)
  expect(shell.dismissals).toEqual([])
})

test('a user close holds against everything but a new peer wake', () => {
  const live = { ...session, peerOpenedAt: 100 }
  let shell = reduceShellState(createShellState(), { type: 'session-added', session: live })
  shell = reduceShellState(shell, { type: 'session-dismissals', dismissals: dismissSession([], live) })
  // Same stamp: a slow stop or a hand restore in progress, not a wake.
  shell = reduceShellState(shell, { type: 'session-status', session: { ...live, status: 'spawning' } })
  expect(selectPaneSessions(shell)).toEqual([])
  // A wake whose spawn failed left no running session to show.
  shell = reduceShellState(shell, { type: 'session-status', session: { ...live, peerOpenedAt: 200, status: 'exited', restorable: true } })
  expect(selectPaneSessions(shell)).toEqual([])
  expect(shell.dismissals).toHaveLength(1)
})

test('a peer waking a tab already in the strip adds nothing to mark', () => {
  const parked = { ...session, status: 'disconnected' as const, restorable: true, parked: true }
  let shell = reduceShellState(createShellState(), { type: 'session-added', session })
  shell = reduceShellState(shell, { type: 'session-status', session: parked })
  shell = reduceShellState(shell, { type: 'session-status', session: { ...session, peerOpenedAt: 100 } })
  expect(selectPeerOpenUnseen(shell, appSessionId)).toBe(false)
})

test('a wake does not clear a mark the user has not acted on', () => {
  let shell = reduceShellState(createShellState(), { type: 'session-added', session: { ...session, peerOpenedAt: 100 } })
  shell = reduceShellState(shell, { type: 'session-status', session: { ...session, peerOpenedAt: 200 } })
  expect(selectPeerOpenUnseen(shell, appSessionId)).toBe(true)
})

test('a user-created session is never marked', () => {
  const shell = reduceShellState(createShellState(), { type: 'session-added', session })
  expect(selectPeerOpenUnseen(shell, appSessionId)).toBe(false)
})

test('seen stamps survive a reload, so an opened tab is not marked again', () => {
  const saved = storage()
  const live = { ...session, peerOpenedAt: 100 }
  let shell = reduceShellState(createShellState(), { type: 'session-added', session: live })
  shell = reduceShellState(shell, { type: 'peer-opens-seen', sessionIds: [appSessionId] })
  writePeerOpensSeen(saved, shell.peerOpensSeen ?? {})
  const reloaded = mergeRosterSnapshot({ ...createShellState(), peerOpensSeen: readPeerOpensSeen(saved) }, [live], new Set())
  expect(selectPeerOpenUnseen(reloaded, appSessionId)).toBe(false)
  saved.data.set(PEER_OPENS_SEEN_KEY, 'not json')
  expect(readPeerOpensSeen(saved)).toEqual({})
})
