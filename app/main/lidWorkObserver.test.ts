import { expect, test } from 'bun:test'
import { PROTOCOL_VERSION } from '../shared/protocol.js'
import type { WorkStatusFrame, WorkStatusRequest } from '../shared/workStatus.js'
import { LidWorkObserver, WORK_FRESHNESS_MS, WORK_REQUEST_TIMEOUT_MS, type LidWorkSession } from './lidWorkObserver.js'
import { requiresWorkAdmission } from './mainDecisions.js'

const generation = '6a4b8c9d-1e2f-4a51-8b3c-4d5e6f708192'
const sessionId = 'session-a'

function clock() {
  let now = 0
  let nextId = 0
  const timers = new Map<number, { at: number; callback: () => void; interval?: number }>()
  const api = {
    setTimeout(callback: () => void, ms: number) {
      const id = ++nextId
      timers.set(id, { at: now + ms, callback })
      return id
    },
    clearTimeout(id: unknown) { timers.delete(id as number) },
    setInterval(callback: () => void, ms: number) {
      const id = ++nextId
      timers.set(id, { at: now + ms, callback, interval: ms })
      return id
    },
    clearInterval(id: unknown) { timers.delete(id as number) },
  }
  return {
    timers: api,
    now: () => now,
    pending: () => timers.size,
    jump(ms: number) { now += ms },
    advance(ms: number) {
      const end = now + ms
      while (true) {
        const next = [...timers.entries()].filter(([, timer]) => timer.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0]
        if (!next) break
        const [id, timer] = next
        now = timer.at
        if (timer.interval) timers.set(id, { ...timer, at: now + timer.interval })
        else timers.delete(id)
        timer.callback()
      }
      now = end
    },
  }
}

function frame(
  request: WorkStatusRequest,
  sequence: number,
  work = emptyWork(),
  session = sessionId,
  generationId = generation,
): WorkStatusFrame {
  return {
    kind: 'work.status', protocolVersion: PROTOCOL_VERSION, sessionId: session,
    requestId: request.requestId, generation: generationId, sequence, work,
  }
}

function emptyWork() {
  return {
    version: 1 as const, available: true, hasUnfinishedWork: false,
    activeTurn: false, pendingContinuation: false, activeSubagents: 0,
    activeBackgroundTasks: 0, queuedWork: 0, waitingForApproval: false,
  }
}

test('presence probe returns fresh evidence and removes all timers without polling', async () => {
  const c = clock()
  const requests: WorkStatusRequest[] = []
  const observer = new LidWorkObserver({
    listSessions: () => [{ sessionId, generation, status: 'ready' }],
    send: (_session, request) => requests.push(request), now: c.now, timers: c.timers,
  })
  const result = observer.probe()
  observer.handleFrame(frame(requests[0]!, 1), sessionId)
  expect((await result).availability).toBe('fresh')
  expect(c.pending()).toBe(0)
  c.advance(10000)
  expect(requests).toHaveLength(1)
})

test('probe timeout cleans requests and concurrent work start retains supervision', async () => {
  const c = clock()
  const requests: WorkStatusRequest[] = []
  const observer = new LidWorkObserver({
    listSessions: () => [{ sessionId, generation, status: 'ready' }],
    send: (_session, request) => requests.push(request), now: c.now, timers: c.timers,
  })
  const timeout = observer.probe()
  c.advance(WORK_REQUEST_TIMEOUT_MS * 2)
  expect((await timeout).availability).toBe('unknown')
  expect(c.pending()).toBe(0)
  const probe = observer.probe()
  const start = observer.start()
  observer.handleFrame(frame(requests.at(-1)!, 1), sessionId)
  await Promise.all([probe, start])
  c.advance(1000)
  expect(requests.length).toBeGreaterThan(2)
  observer.stop()
  expect(c.pending()).toBe(0)
})

test('start requires fresh response; unchanged sequence updates do not advance revision', async () => {
  const c = clock()
  const requests: WorkStatusRequest[] = []
  const observer = new LidWorkObserver({
    listSessions: () => [{ sessionId, generation, status: 'ready' }],
    send: (_session, request) => requests.push(request),
    now: c.now, timers: c.timers, uuid: () => `00000000-0000-4000-8000-00000000000${requests.length + 1}`,
  })
  const started = observer.start()
  expect(requests).toHaveLength(1)
  observer.handleFrame(frame(requests[0]!, 1), sessionId)
  const initial = await started
  expect(initial).toMatchObject({ availability: 'fresh', hasUnfinishedWork: false })
  const revision = initial.revision

  const refreshed = observer.refresh()
  expect(requests).toHaveLength(2)
  observer.handleFrame(frame(requests[1]!, 2), sessionId)
  expect((await refreshed).revision).toBe(revision)
  observer.stop()
})

test('unknown, mismatched, late, and expired evidence cannot establish completion', async () => {
  const c = clock()
  const requests: WorkStatusRequest[] = []
  const observer = new LidWorkObserver({
    listSessions: () => [{ sessionId, generation, status: 'ready' }],
    send: (_session, request) => requests.push(request),
    now: c.now, timers: c.timers,
  })
  const started = observer.start()
  const wrong: WorkStatusFrame = { ...frame(requests[0]!, 1), generation: '7a4b8c9d-1e2f-4a51-8b3c-4d5e6f708192' }
  observer.handleFrame(wrong, sessionId)
  expect(observer.read().availability).toBe('unknown')
  observer.handleFrame(frame(requests[0]!, 1), sessionId)
  await started
  c.advance(WORK_FRESHNESS_MS)
  expect(observer.read()).toMatchObject({ availability: 'unknown', supervisionLost: true })
  const late = requests.at(-1)
  if (late) observer.handleFrame(frame(late, 100), sessionId)
  expect(observer.read()).toMatchObject({ availability: 'unknown', supervisionLost: true })
  observer.stop()
})

test('verify ignores an ordinary query that was already pending at the barrier', async () => {
  const c = clock()
  const requests: WorkStatusRequest[] = []
  const observer = new LidWorkObserver({
    listSessions: () => [{ sessionId, generation, status: 'ready' }],
    send: (_session, request) => requests.push(request),
    now: c.now, timers: c.timers,
  })
  const started = observer.start()
  const first = requests[0]!
  observer.handleFrame(frame(first, 1), sessionId)
  await started
  observer.refresh()
  const pending = requests.at(-1)!
  const verified = observer.verify()
  observer.handleFrame(frame(pending, 2), sessionId)
  expect(requests).toHaveLength(3)
  observer.handleFrame(frame(requests[2]!, 3), sessionId)
  expect((await verified)).toMatchObject({ availability: 'fresh', hasUnfinishedWork: false })
  observer.stop()
})

test('session overflow stays unknown and stop cancels observer timers', async () => {
  const c = clock()
  const requests: WorkStatusRequest[] = []
  const observer = new LidWorkObserver({
    listSessions: () => Array.from({ length: 257 }, (_, index) => ({
      sessionId: `session-${index}`, generation, status: 'connecting' as const,
    })),
    send: (_session, request) => requests.push(request),
    now: c.now, timers: c.timers,
  })
  void observer.start()
  expect(observer.read()).toMatchObject({ availability: 'unknown', hasUnfinishedWork: false })
  expect(requests).toHaveLength(0)
  observer.stop()
  await Promise.resolve()
  c.advance(WORK_REQUEST_TIMEOUT_MS * 2)
  expect(observer.read()).toMatchObject({ availability: 'unknown', supervisionLost: false })
})

test('workspace replacement keeps an otherwise empty batch unknown until refreshed', async () => {
  const c = clock()
  const requests: WorkStatusRequest[] = []
  const observer = new LidWorkObserver({
    listSessions: () => [{ sessionId, generation, status: 'ready' }],
    send: (_session, request) => requests.push(request),
    now: c.now, timers: c.timers,
  })
  const started = observer.start()
  observer.handleFrame(frame(requests[0]!, 1), sessionId)
  await started
  expect(observer.read().availability).toBe('fresh')
  observer.beginWorkspaceTransition(sessionId, 'branch')
  observer.beginWorkspaceTransition(sessionId, 'peer:operation-1')
  expect(observer.read()).toMatchObject({ availability: 'unknown', hasUnfinishedWork: false })
  observer.endPeerWorkspaceTransitions(sessionId)
  expect(observer.read().availability).toBe('unknown')
  observer.endWorkspaceTransition(sessionId, 'branch')
  expect(requests).toHaveLength(2)
  expect(observer.read().availability).toBe('unknown')
  observer.handleFrame(frame(requests[1]!, 2), sessionId)
  expect(observer.read()).toMatchObject({ availability: 'fresh', hasUnfinishedWork: false })
  observer.stop()
})

test('generation replacement and reconnect discard the prior empty proof', async () => {
  const c = clock()
  let currentGeneration = generation
  let status: 'ready' | 'disconnected' = 'ready'
  const requests: WorkStatusRequest[] = []
  const observer = new LidWorkObserver({
    listSessions: () => [{ sessionId, generation: currentGeneration, status }],
    send: (_session, request) => requests.push(request),
    now: c.now, timers: c.timers,
  })
  const started = observer.start()
  observer.handleFrame(frame(requests[0]!, 1), sessionId)
  await started
  expect(observer.read().availability).toBe('fresh')

  status = 'disconnected'
  observer.onLifecycle({ sessionId, generation: currentGeneration, status })
  expect(observer.read().availability).toBe('unknown')
  await observer.refresh()
  status = 'ready'
  observer.onLifecycle({ sessionId, generation: currentGeneration, status })
  await observer.refresh()
  const reconnected = requests.at(-1)!
  observer.handleFrame(frame(reconnected, 2), sessionId)
  expect(observer.read().availability).toBe('fresh')

  const nextGeneration = '7a4b8c9d-1e2f-4a51-8b3c-4d5e6f708192'
  currentGeneration = nextGeneration
  observer.onLifecycle({ sessionId, generation: nextGeneration, status: 'ready' })
  expect(observer.read()).toMatchObject({ availability: 'unknown', hasUnfinishedWork: false })
  observer.refresh()
  const replacement = requests.at(-1)!
  observer.handleFrame(frame(replacement, 1, emptyWork(), sessionId, generation), sessionId)
  expect(observer.read().availability).toBe('unknown')
  observer.handleFrame(frame(replacement, 1, emptyWork(), sessionId, nextGeneration), sessionId)
  expect(observer.read()).toMatchObject({ availability: 'fresh', hasUnfinishedWork: false })
  observer.stop()
})

test('a ready session without its generation remains unknown without sending an invalid request', async () => {
  const c = clock()
  let currentGeneration = ''
  const requests: WorkStatusRequest[] = []
  const observer = new LidWorkObserver({
    listSessions: () => [{ sessionId, generation: currentGeneration, status: 'ready' }],
    send: (_session, request) => requests.push(request),
    now: c.now, timers: c.timers,
  })
  const started = observer.start()
  expect(observer.read()).toMatchObject({ availability: 'unknown', hasUnfinishedWork: false })
  expect(requests).toHaveLength(0)
  currentGeneration = generation
  observer.onSessionsChanged()
  await observer.refresh()
  const current = requests.at(-1)!
  expect(current.forGeneration).toBe(generation)
  observer.handleFrame(frame(current, 1), sessionId)
  await started
  expect(observer.read()).toMatchObject({ availability: 'fresh', hasUnfinishedWork: false })
  observer.stop()
})

test('confirmed exit stays removed when the supervisor retains its exited row', async () => {
  const c = clock()
  let status: LidWorkSession['status'] = 'ready'
  const requests: WorkStatusRequest[] = []
  const observer = new LidWorkObserver({
    listSessions: () => [{ sessionId, generation, status }],
    send: (_session, request) => requests.push(request),
    now: c.now, timers: c.timers,
  })
  const started = observer.start()
  observer.handleFrame(frame(requests[0]!, 1), sessionId)
  await started
  status = 'exited'
  observer.onSessionsChanged()
  observer.onSessionsChanged()
  expect(observer.read()).toMatchObject({ availability: 'fresh', hasUnfinishedWork: false, activeSessions: 0 })
  expect(requests).toHaveLength(1)
  observer.stop()
})

test('abnormal supervisor exit latches supervision loss instead of normal completion', async () => {
  const c = clock()
  let status: LidWorkSession['status'] = 'ready'
  const requests: WorkStatusRequest[] = []
  const observer = new LidWorkObserver({
    listSessions: () => [{ sessionId, generation, status }],
    send: (_session, request) => requests.push(request),
    now: c.now, timers: c.timers,
  })
  const started = observer.start()
  observer.handleFrame(frame(requests[0]!, 1, {
    ...emptyWork(), hasUnfinishedWork: true, activeTurn: true,
  }), sessionId)
  await started
  status = 'exited'
  observer.loseSupervision()
  observer.onSessionsChanged()
  expect(observer.read()).toMatchObject({
    availability: 'unknown', hasUnfinishedWork: false, supervisionLost: true,
  })
  observer.stop()
})

test('stop and restart cannot reuse a pending response from the old activation', async () => {
  const c = clock()
  const requests: WorkStatusRequest[] = []
  const observer = new LidWorkObserver({
    listSessions: () => [{ sessionId, generation, status: 'ready' }],
    send: (_session, request) => requests.push(request),
    now: c.now, timers: c.timers,
  })
  const firstStart = observer.start()
  const oldRequest = requests[0]!
  observer.stop()
  await firstStart
  const secondStart = observer.start()
  const currentRequest = requests.at(-1)!
  observer.handleFrame(frame(oldRequest, 1), sessionId)
  expect(observer.read().availability).toBe('unknown')
  observer.handleFrame(frame(currentRequest, 1), sessionId)
  expect((await secondStart)).toMatchObject({ availability: 'fresh', hasUnfinishedWork: false })
  observer.stop()
})

test('inline Start invalidates final-idle verification and requires post-send evidence', async () => {
  const c = clock()
  const requests: WorkStatusRequest[] = []
  const observer = new LidWorkObserver({
    listSessions: () => [{ sessionId, generation, status: 'ready' }],
    send: (_session, request) => requests.push(request),
    now: c.now, timers: c.timers,
  })
  const started = observer.start()
  observer.handleFrame(frame(requests[0]!, 1), sessionId)
  await started
  const idleRevision = observer.read().revision
  const verification = observer.verify()
  const preSend = requests.at(-1)!
  expect(requiresWorkAdmission({ type: 'inline-command.start' })).toBe(true)
  const token = requiresWorkAdmission({ type: 'inline-command.start' })
    ? observer.beginAdmission(sessionId) : ''
  observer.finishAdmission(token, true)
  observer.handleFrame(frame(preSend, 2), sessionId)
  expect(observer.read().availability).toBe('unknown')
  await observer.refresh()
  await observer.refresh()
  const postSend = requests.at(-1)!
  observer.handleFrame(frame(postSend, 3), sessionId)
  const verified = await verification
  expect(verified.revision).not.toBe(idleRevision)
  expect(observer.read()).toMatchObject({ availability: 'fresh', hasUnfinishedWork: false })
  observer.stop()
})

test('a correlated internal query error invalidates proof without becoming completion', async () => {
  const c = clock()
  const requests: WorkStatusRequest[] = []
  const observer = new LidWorkObserver({
    listSessions: () => [{ sessionId, generation, status: 'ready' }],
    send: (_session, request) => requests.push(request),
    now: c.now, timers: c.timers,
  })
  const started = observer.start()
  observer.handleFrame(frame(requests[0]!, 1), sessionId)
  await started
  observer.refresh()
  const pending = requests.at(-1)!
  expect(observer.handleError({ kind: 'error', sessionId, requestId: pending.requestId }, sessionId)).toBe(true)
  expect(observer.read()).toMatchObject({ availability: 'unknown', hasUnfinishedWork: false })
  c.jump(WORK_FRESHNESS_MS)
  expect(observer.read()).toMatchObject({ availability: 'unknown', supervisionLost: true })
  expect(observer.handleError({ kind: 'error', sessionId, requestId: 'unmatched' }, sessionId)).toBe(false)
  observer.stop()
})

test('two live sessions finish separately; the last fresh reply proves empty', async () => {
  const c = clock()
  const secondSession = 'session-b'
  const requests: Array<{ session: string; request: WorkStatusRequest }> = []
  const unfinished = { ...emptyWork(), hasUnfinishedWork: true, activeTurn: true }
  const observer = new LidWorkObserver({
    listSessions: () => [
      { sessionId, generation, status: 'ready' },
      { sessionId: secondSession, generation, status: 'ready' },
    ],
    send: (session, request) => requests.push({ session, request }),
    now: c.now, timers: c.timers,
  })
  const started = observer.start()
  observer.handleFrame(frame(requests[0]!.request, 1, unfinished), sessionId)
  observer.handleFrame(frame(requests[1]!.request, 1, unfinished, secondSession), secondSession)
  expect((await started)).toMatchObject({ availability: 'fresh', activeSessions: 2 })

  observer.refresh()
  observer.handleFrame(frame(requests[2]!.request, 2), sessionId)
  expect(observer.read()).toMatchObject({ availability: 'fresh', hasUnfinishedWork: true, activeSessions: 1 })
  observer.handleFrame(frame(requests[3]!.request, 2, emptyWork(), secondSession), secondSession)
  expect(observer.read()).toMatchObject({ availability: 'fresh', hasUnfinishedWork: false, activeSessions: 0 })
  observer.stop()
})
