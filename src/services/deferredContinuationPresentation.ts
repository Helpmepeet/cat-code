import type { DeferredContinuationNoticeV1 } from './deferredContinuation.js'
import type { DeferredContinuationBackgroundStatus } from './deferredContinuationLaunchAgent.js'

export function formatDeferredContinuationTime(
  when: number,
  now = Date.now(),
): string {
  const local = new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(when))
  const remaining = Math.max(0, when - now)
  const minutes = Math.ceil(remaining / 60_000)
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  const relative = hours > 0 ? `${hours}h ${rest}m` : `${rest}m`
  return `${local} (in ${relative})`
}

export function formatDeferredContinuationStopped(reason: string): string {
  const details: Record<string, { reason: string; next: string }> = {
    account_recovery: {
      reason: 'Your Codex account needs attention.',
      next: 'Run /login or /accounts, then continue this conversation manually.',
    },
    permission_required: {
      reason: 'This step needs your permission.',
      next: 'Reopen this conversation and continue manually so you can approve it.',
    },
    permission_restore: {
      reason: 'Cat Code could not safely restore the saved permission mode.',
      next: 'Reopen this conversation and continue manually so you can approve any required action.',
    },
    network: {
      reason: 'Automatic continuation stopped after repeated network failures.',
      next: 'Check your connection, then continue this conversation manually.',
    },
    quota_reset_unknown: {
      reason: 'A reliable Codex reset time is unavailable.',
      next: 'Run /accounts to check Codex status, or continue this conversation manually.',
    },
    context_window: {
      reason: 'The conversation reached its context limit.',
      next: 'Review the latest transcript, then continue this conversation manually.',
    },
    max_turns: {
      reason: 'Automatic continuation reached its turn limit.',
      next: 'Review the latest transcript, then continue this conversation manually.',
    },
    max_budget: {
      reason: 'Automatic continuation reached its budget limit.',
      next: 'Review the latest transcript, then continue this conversation manually.',
    },
    session_restore: {
      reason: 'Cat Code could not safely restore this conversation.',
      next: 'Reopen this conversation and continue manually.',
    },
    transcript_persistence: {
      reason: 'Cat Code could not durably save the continuation message.',
      next: 'Review the latest transcript and continue this conversation manually.',
    },
    aborted: {
      reason: 'Automatic continuation was interrupted.',
      next: 'Review the latest transcript and continue this conversation manually.',
    },
    ambiguous_rate_limit: {
      reason: 'Cat Code could not safely confirm the provider limit outcome.',
      next: 'Review the latest transcript and continue this conversation manually.',
    },
    unknown: {
      reason: 'Cat Code could not determine how the continuation ended safely.',
      next: 'Review the latest transcript and continue this conversation manually.',
    },
  }
  const detail = details[reason] ?? {
    reason: 'Automatic continuation could not finish safely.',
    next: 'Review the latest transcript and continue this conversation manually.',
  }
  return `Status: Stopped — needs you
Reason: ${detail.reason}
Next: ${detail.next}
Automatic retry: Off`
}

export function formatDeferredContinuationBackground(
  status: DeferredContinuationBackgroundStatus,
): string {
  if (status.state === 'enabled') {
    return 'Background continuation: Enabled — checks run about once a minute while the Mac is awake or after login.'
  }
  if (status.state === 'needs_repair') {
    return `Background continuation: Needs repair${
      status.executablePath ? ` (${status.executablePath})` : ''
    }. Repair with /continue-after-limit enable-background or disable it.`
  }
  return 'Background continuation: Disabled — resume this conversation to run the scheduled attempt; opening another conversation will not start it.'
}

export function formatDeferredContinuationNotice(
  notice: DeferredContinuationNoticeV1,
): string {
  switch (notice.kind) {
    case 'completed':
      return `Status: Done
Scheduled continuation completed at ${new Intl.DateTimeFormat(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(new Date(notice.observedAt))}.`
    case 'canceled_command':
      return 'Status: Canceled\nScheduled continuation canceled by command.'
    case 'canceled_human':
      return 'Status: Canceled\nScheduled continuation canceled because you sent a new message.'
    case 'ambiguous':
      return `Automatic continuation stopped — needs you.

Cat Code may have started the continuation before it closed. It will not
retry automatically because that could repeat tool actions.

Review the latest transcript and continue manually.`
    case 'network_retry':
      return `Status: Scheduled
Continuation could not connect. Retrying at ${formatDeferredContinuationTime(
        notice.notBefore!,
      )} (retry ${notice.retry} of 3).`
    case 'quota_rescheduled':
      return `Status: Scheduled
Codex is still usage-limited. Continuation rescheduled.
When: ${formatDeferredContinuationTime(notice.notBefore!)}
Action: Add a new reconciliation message; do not replay the failed request`
    case 'needs_attention':
      return formatDeferredContinuationStopped(notice.reason ?? 'unknown')
  }
}
