import { useEffect } from 'react'
import type { Message } from '../types/message.js'
import { createSystemMessage } from '../utils/messages.js'
import { enqueue } from '../utils/messageQueueManager.js'
import { getSessionId } from '../bootstrap/state.js'
import {
  readPendingDeferredContinuation,
  takeDeferredContinuationNotice,
  type DeferredContinuationJobV1,
} from '../services/deferredContinuation.js'
import {
  beginForegroundDeferredContinuation,
  reconcileDeferredContinuationJob,
} from '../services/deferredContinuationRunner.js'
import { formatDeferredContinuationBackground, formatDeferredContinuationNotice } from '../services/deferredContinuationPresentation.js'
import { getDeferredContinuationBackgroundStatus } from '../services/deferredContinuationLaunchAgent.js'

type Props = {
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>
}

// Idle backoff. The hook is mounted for every session whether or not the
// feature is ever used, and the no-job branch is the steady state, so a flat
// one-second poll meant a wakeup and a filesystem round trip every second for
// the process lifetime. Anything that proves work exists resets it, so a real
// job is still noticed within a second.
const IDLE_POLL_MIN_MS = 1_000
const IDLE_POLL_MAX_MS = 60_000

export { formatDeferredContinuationNotice }

export function useDeferredContinuation({ setMessages }: Props): void {
  const activeSessionId = getSessionId()
  useEffect(() => {
    let canceled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let hasPolled = false
    let idleDelay = IDLE_POLL_MIN_MS
    const mountedAt = Date.now()
    const sessionId = activeSessionId

    const show = (text: string) => {
      if (!canceled) {
        setMessages(previous => [...previous, createSystemMessage(text, 'info')])
      }
    }

    // Never throws. `takeDeferredContinuationNotice` throws on any non-ENOENT
    // error (a corrupt notice file is a zod throw), and every caller's only
    // liveness is the `setTimeout` that follows it — so a throw escaping here
    // would kill the poll loop for the session's lifetime and raise an
    // unhandled rejection from `void check()`. Since notices ARE how background
    // workers report outcomes, that would silently strand every future one.
    // Display degrades gracefully; the durable history remains the authority
    // that `/continue-after-limit status` reads.
    const consumeNotice = async () => {
      try {
        const notice = await takeDeferredContinuationNotice(sessionId)
        if (notice) {
          idleDelay = IDLE_POLL_MIN_MS
          let text = formatDeferredContinuationNotice(notice)
          if (
            notice.kind === 'network_retry' ||
            notice.kind === 'quota_rescheduled'
          ) {
            text += `\n${formatDeferredContinuationBackground(
              await getDeferredContinuationBackgroundStatus(),
            )}`
          }
          show(text)
        }
      } catch {
        // Intentionally swallowed — see above.
      }
    }

    const check = async (): Promise<void> => {
      if (canceled) return
      let job: DeferredContinuationJobV1 | null
      try {
        job = await readPendingDeferredContinuation(sessionId)
      } catch {
        // A background worker's write-then-rename makes this read throw while
        // the job is perfectly healthy, so a stop is the wrong conclusion and
        // returning without a timer kills the loop for the session's lifetime.
        // Nothing durable changed; retry. The human-prompt guard is what states
        // a genuinely unreadable record, and history stays the authority
        // `/continue-after-limit status` reads.
        timer = setTimeout(() => void check(), IDLE_POLL_MIN_MS)
        timer.unref?.()
        return
      }
      const firstPoll = !hasPolled
      hasPolled = true
      if (job) idleDelay = IDLE_POLL_MIN_MS
      if (job?.state === 'submitted') {
        try {
          await reconcileDeferredContinuationJob(job)
          await consumeNotice()
        } catch {
          // A live foreground/background owner still holding the locks is
          // expected. Retry until it settles or becomes reclaimable.
        }
        timer = setTimeout(() => void check(), 1_000)
        timer.unref?.()
        return
      }
      if (!job || job.state !== 'pending') {
        // A background worker removing the job is how it reports an outcome:
        // the pending record disappears and a notice takes its place. Polling
        // without consuming here would drop that outcome on the floor for a
        // session that is mounted and watching.
        await consumeNotice()
        timer = setTimeout(() => void check(), 1_000)
        timer.unref?.()
        return
      }
      const delay = job.notBefore - Date.now()
      if (delay > 0) {
        timer = setTimeout(() => void check(), Math.min(delay, 60_000))
        timer.unref?.()
        return
      }
      const wasWaitingWithBackgroundOff =
        firstPoll &&
        job.scheduleReason === 'hard_quota_reset' &&
        job.notBefore <= mountedAt &&
        (await getDeferredContinuationBackgroundStatus()).state !== 'enabled'
      let attempt
      try {
        attempt = await beginForegroundDeferredContinuation(job)
      } catch {
        // A background scanner may have won the zero-retry lock race.
        timer = setTimeout(() => void check(), 1_000)
        timer.unref?.()
        return
      }
      if (!attempt) {
        timer = setTimeout(() => void check(), 1_000)
        timer.unref?.()
        return
      }
      show(
        wasWaitingWithBackgroundOff
          ? 'Status: Running\nContinuation was waiting because this conversation was closed. Continuing now with a new reconciliation message. The failed request will not be replayed.'
          : job.scheduleReason === 'account_available'
          ? 'Status: Running\nContinuing now with a new reconciliation message. The failed request will not be replayed.'
          : 'Status: Running\nThe scheduled time has arrived. Continuing now with a new reconciliation message; the failed request will not be replayed.',
      )
      enqueue(attempt.command)
      void attempt.finished.then(
        async () => {
          await consumeNotice()
          timer = setTimeout(() => void check(), 1_000)
          timer.unref?.()
        },
        () => {
          show(
            'Status: Stopped — needs you\nAutomatic continuation could not finish safely. Review the latest transcript and continue manually.',
          )
          timer = setTimeout(() => void check(), 1_000)
          timer.unref?.()
        },
      )
    }

    void consumeNotice().then(check)
    return () => {
      canceled = true
      if (timer) clearTimeout(timer)
    }
  }, [activeSessionId, setMessages])
}
