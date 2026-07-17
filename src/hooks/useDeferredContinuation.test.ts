import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { Message } from '../types/message.js'
import type { QueuedCommand } from '../types/textInputTypes.js'
import type {
  DeferredContinuationJobV1,
  DeferredContinuationNoticeV1,
} from '../services/deferredContinuation.js'

// This repo ships no React test renderer and adding one is out of scope, so the
// effect body is driven directly through a stubbed useEffect. Everything the
// hook reaches for is mocked at the module boundary; the hook's own job is
// scheduling and delegation, which is what these tests pin.
let runEffect: (() => void) | undefined
let cleanupEffect: (() => void) | undefined

// Every mock spreads the real module: these specifiers are shared by unrelated
// importers in this process, and replacing a whole module drops exports they
// need.
const actualReact = await import('react')
mock.module('react', () => ({
  ...actualReact,
  default: actualReact.default,
  useEffect: (effect: () => void | (() => void)) => {
    runEffect = () => {
      cleanupEffect = (effect() as (() => void) | undefined) ?? undefined
    }
  },
}))

// The hook schedules against the real clock (it recomputes from epoch time so
// it survives sleep and clock changes), so fixtures are anchored to it rather
// than to a frozen constant.
const NOW = Date.now()
const SESSION_ID = '22222222-2222-4222-8222-222222222222'

function job(
  overrides: Partial<DeferredContinuationJobV1> = {},
): DeferredContinuationJobV1 {
  return {
    version: 1,
    jobId: '11111111-1111-4111-8111-111111111111',
    sessionId: SESSION_ID,
    projectStorageKey: '-private-project',
    context: {
      cwd: '/private/project',
      model: 'gpt-5.6-terra',
      permissionMode: 'default',
    },
    createdAt: NOW,
    statusObservedAt: NOW,
    scheduleReason: 'hard_quota_reset',
    resetAt: NOW - 60_000,
    notBefore: NOW - 1_000,
    state: 'pending',
    attempt: { number: 1, messageUuid: '33333333-3333-4333-8333-333333333333' },
    transientRetries: 0,
    ...overrides,
  } as DeferredContinuationJobV1
}

const continuationCommand: QueuedCommand = {
  value: 'Automated continuation requested through /continue-after-limit.',
  mode: 'prompt',
  skipSlashCommands: true,
  isMeta: false,
  priority: 'later',
  uuid: '33333333-3333-4333-8333-333333333333',
  origin: {
    kind: 'deferred-continuation',
    jobId: '11111111-1111-4111-8111-111111111111',
    attemptUuid: '33333333-3333-4333-8333-333333333333',
  },
} as QueuedCommand

let pendingJob: DeferredContinuationJobV1 | null = null
let enqueued: QueuedCommand[] = []
let beginCalls = 0
let finishAttempt: (() => void) | null = null
// Consumed in order, one per takeDeferredContinuationNotice() call, so a test
// can place a notice on the poll that follows the mount rather than the mount
// itself — which is exactly when a background worker publishes one.
let notices: (DeferredContinuationNoticeV1 | null)[] = []
// Thrown by the next takeDeferredContinuationNotice() call, then cleared — the
// real store throws on any non-ENOENT read error, e.g. a corrupt notice file.
let noticeError: Error | null = null

const actualState = await import('../bootstrap/state.js')
mock.module('../bootstrap/state.js', () => ({
  ...actualState,
  getSessionId: () => SESSION_ID,
}))

const actualQueue = await import('../utils/messageQueueManager.js')
mock.module('../utils/messageQueueManager.js', () => ({
  ...actualQueue,
  enqueue: (command: QueuedCommand) => {
    enqueued.push(command)
  },
}))

const actualStore = await import('../services/deferredContinuation.js')
mock.module('../services/deferredContinuation.js', () => ({
  ...actualStore,
  readPendingDeferredContinuation: async () => pendingJob,
  takeDeferredContinuationNotice: async () => {
    if (noticeError) {
      const error = noticeError
      noticeError = null
      throw error
    }
    return notices.shift() ?? null
  },
}))

const actualRunner = await import('../services/deferredContinuationRunner.js')
mock.module('../services/deferredContinuationRunner.js', () => ({
  ...actualRunner,
  beginForegroundDeferredContinuation: async () => {
    beginCalls++
    const finished = new Promise<void>(resolve => {
      finishAttempt = resolve
    })
    return { command: continuationCommand, finished }
  },
  reconcileDeferredContinuationJob: async () => {},
}))

const actualLaunchAgent = await import('../services/deferredContinuationLaunchAgent.js')
mock.module('../services/deferredContinuationLaunchAgent.js', () => ({
  ...actualLaunchAgent,
  getDeferredContinuationBackgroundStatus: async () => ({ state: 'disabled' }),
}))

const { useDeferredContinuation } = await import('./useDeferredContinuation.js')

let messages: Message[] = []
const setMessages = ((updater: (prev: Message[]) => Message[]) => {
  messages = updater(messages)
}) as unknown as React.Dispatch<React.SetStateAction<Message[]>>

async function mountAndSettle(): Promise<void> {
  useDeferredContinuation({ setMessages })
  runEffect?.()
  // Let the hook's `consumeNotice().then(check)` chain settle.
  for (let i = 0; i < 12; i++) await Promise.resolve()
  await new Promise(resolve => setTimeout(resolve, 5))
}

beforeEach(() => {
  messages = []
  enqueued = []
  beginCalls = 0
  pendingJob = null
  notices = []
  noticeError = null
  finishAttempt = null
  runEffect = undefined
  cleanupEffect = undefined
})

afterEach(() => {
  cleanupEffect?.()
})

describe('useDeferredContinuation', () => {
  test('submits a due job once and announces it before enqueueing', async () => {
    pendingJob = job()

    await mountAndSettle()

    expect(beginCalls).toBe(1)
    expect(enqueued).toHaveLength(1)
    // The queued turn must carry the runner's origin and stay visible — that is
    // what routes it through the REPL's durable pre-provider barrier.
    expect(enqueued[0]?.origin?.kind).toBe('deferred-continuation')
    expect(enqueued[0]?.isMeta).toBe(false)
    expect(enqueued[0]?.uuid).toBe(job().attempt.messageUuid)
    const rendered = messages.map(m => JSON.stringify(m)).join('\n')
    expect(rendered).toContain('Status: Running')
    expect(rendered).toContain('will not be replayed')
  })

  test('restarts polling after a successful attempt is rescheduled', async () => {
    pendingJob = job()
    await mountAndSettle()
    expect(beginCalls).toBe(1)

    pendingJob = job({
      attempt: {
        number: 2,
        messageUuid: '44444444-4444-4444-8444-444444444444',
      },
    })
    notices.push({
      version: 1,
      sessionId: SESSION_ID,
      kind: 'quota_rescheduled',
      notBefore: NOW - 1,
      observedAt: NOW,
    })
    finishAttempt?.()
    await new Promise(resolve => setTimeout(resolve, 1_100))
    for (let i = 0; i < 12; i++) await Promise.resolve()

    expect(beginCalls).toBe(2)
    expect(enqueued).toHaveLength(2)
  })

  test('does not submit a job whose scheduled time has not arrived', async () => {
    pendingJob = job({ notBefore: NOW + 3_600_000 })

    await mountAndSettle()

    expect(beginCalls).toBe(0)
    expect(enqueued).toEqual([])
  })

  test('does not submit when no job is scheduled', async () => {
    pendingJob = null

    await mountAndSettle()

    expect(beginCalls).toBe(0)
    expect(enqueued).toEqual([])
  })

  // F12: a background worker can finish the job and publish the outcome while
  // this session is mounted. The hook consumed notices at mount and after its
  // own attempt only, so the no-job poll — the exact state a worker leaves
  // behind — reported nothing and the outcome was never shown.
  test('shows an outcome a background worker published after mount', async () => {
    pendingJob = null
    notices = [
      // Nothing at mount; the worker publishes before the next poll.
      null,
      { version: 1, sessionId: SESSION_ID, kind: 'completed', observedAt: NOW },
    ]

    await mountAndSettle()

    expect(messages.map(m => JSON.stringify(m)).join('\n')).toContain('Status: Done')
  })

  // F5: reading a notice throws on any non-ENOENT error, and the hook's entire
  // liveness hangs off `void consumeNotice().then(check)` at mount — an escaping
  // throw skips `.then(check)`, so the loop never starts and the session never
  // learns anything for its lifetime. Notices ARE how background workers report
  // outcomes, so the failure silently strands every future one.
  test('a corrupt notice does not strand the hook at mount', async () => {
    pendingJob = job()
    noticeError = new Error('corrupt notice file')

    await mountAndSettle()

    expect(beginCalls).toBe(1)
    expect(enqueued).toHaveLength(1)
  })

  test('does not start a second turn for a job another owner already submitted', async () => {
    // The background worker can win the lock race. The REPL must reconcile
    // rather than enqueue a duplicate continuation.
    pendingJob = job({ state: 'submitted' })

    await mountAndSettle()

    expect(beginCalls).toBe(0)
    expect(enqueued).toEqual([])
  })
})
