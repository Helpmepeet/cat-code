import * as React from 'react'
import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { Dialog } from '../../components/design-system/Dialog.js'
import { Select } from '../../components/CustomSelect/select.js'
import type {
  LocalJSXCommandCall,
  LocalJSXCommandContext,
  LocalJSXCommandOnDone,
} from '../../types/command.js'
import type { Message } from '../../types/message.js'
import {
  getMainLoopModelOverride,
  getOriginalCwd,
  getSessionId,
  getSessionProjectDir,
} from '../../bootstrap/state.js'
import { getCwd } from '../../utils/cwd.js'
import { getProjectDir } from '../../utils/sessionStorage.js'
import { getCurrentWorktreeSession } from '../../utils/worktree.js'
import {
  acquireDeferredContinuationLocks,
  createPendingDeferredContinuation,
  evaluateDeferredContinuationEligibility,
  getLatestDeferredContinuationHistory,
  moveDeferredContinuationToHistory,
  readPendingDeferredContinuation,
  recordDeferredContinuationNotice,
  takeDeferredContinuationNotice,
  type DeferredContinuationHistoryV1,
  type DeferredContinuationJobV1,
} from '../../services/deferredContinuation.js'
import {
  getDeferredContinuationBackgroundStatus,
  installDeferredContinuationLaunchAgent,
  uninstallDeferredContinuationLaunchAgent,
  type DeferredContinuationBackgroundStatus,
} from '../../services/deferredContinuationLaunchAgent.js'
import {
  formatDeferredContinuationStopped,
  formatDeferredContinuationTime,
} from '../../services/deferredContinuationPresentation.js'

export const REFUSALS = {
  not_codex:
    'This command only works in a Codex/OpenAI conversation. This conversation is not using a Codex model, so nothing was scheduled.',
  not_terminal_quota:
    'Cat Code did not confirm that the last failure was a Codex usage limit, so nothing was scheduled. Review the latest error and continue manually when it is safe.',
  observation_uncertain:
    'Cat Code cannot confirm a Codex usage limit right now, so nothing was scheduled. Review the latest transcript and try again manually when it is safe.',
  quota_reset_unknown:
    'The Codex usage limit is confirmed, but Cat Code cannot find a trustworthy reset time, so nothing was scheduled. Run /accounts to check Codex status, then try /continue-after-limit again when a reset time is available.',
  account_recovery:
    'Cat Code cannot schedule continuation because Codex account access needs attention. Run /login or /accounts, then continue this conversation manually.',
} as const

export function formatDeferredTime(when: number, now = Date.now()): string {
  return formatDeferredContinuationTime(when, now)
}

export function backgroundScheduleCopy(enabled: boolean): string {
  return enabled
    ? `Background continuation: ON
Cat Code will continue on its own after the scheduled time, even after this
terminal closes, as long as the Mac is on. Background checks run once a minute,
so it normally starts within about one minute after the displayed time, though
system scheduling can delay it longer. If the Mac is asleep, logged out, shut
down, or powered off, it continues after wake or login.`
    : `Background continuation: OFF
This conversation must be open to continue. If it is closed at the scheduled
time, continuation waits until you reopen and resume this conversation.
Opening Cat Code in a different conversation will not start it.

Enable continuation after closing the terminal:
/continue-after-limit enable-background`
}

export function scheduledCopy(job: DeferredContinuationJobV1, background: boolean): string {
  return `Continuation scheduled for ${formatDeferredTime(job.notBefore)}.

What will happen:
- Cat Code will add a new “continue and reconcile” message to this conversation.
- It will not resend your failed request.
- Sending another message before then will cancel this schedule.
- Viewing or resuming this conversation without sending a message is safe.

${backgroundScheduleCopy(background)}

Cancel:
/continue-after-limit cancel`
}

async function statusText(sessionId: string): Promise<string> {
  let job: DeferredContinuationJobV1 | null
  let history: DeferredContinuationHistoryV1 | null
  let background: DeferredContinuationBackgroundStatus
  try {
    ;[job, history, background] = await Promise.all([
      readPendingDeferredContinuation(sessionId),
      getLatestDeferredContinuationHistory(sessionId),
      getDeferredContinuationBackgroundStatus(),
    ])
  } catch {
    return formatDeferredContinuationStopped('unknown')
  }
  if (job) {
    if (job.state === 'ambiguous') {
      return `Status: Stopped — needs you
Reason: Cat Code may have started the continuation before it closed.
Next: Review the latest transcript and continue manually.
Automatic retry: Off`
    }
    if (job.state === 'submitted') {
      return 'Status: Running\nContinuing now with a new reconciliation message; the failed request is not being replayed.'
    }
    const backgroundLine =
      background.state === 'enabled'
        ? `Background continuation: Enabled
Timing: Normally within about one minute after the scheduled time; system
        scheduling can delay it longer`
        : background.state === 'needs_repair'
          ? `Background continuation: Needs repair
${background.executablePath ? `Configured executable: ${background.executablePath}\n` : ''}Requirement: Repair with /continue-after-limit enable-background or disable it`
          : `Background continuation: Disabled
Requirement: Resume this conversation; opening another conversation will not
             start it`
    return `Status: Scheduled
When: ${formatDeferredTime(job.notBefore)}
${backgroundLine}
Action: Add a new reconciliation message; do not replay the failed request
Cancel: /continue-after-limit cancel`
  }
  return historyText(history)
}

export function historyText(history: DeferredContinuationHistoryV1 | null): string {
  if (!history) {
    return `Status: No continuation scheduled
You can schedule one after a confirmed Codex usage-limit failure.`
  }
  if (history.terminalState === 'completed') {
    return `Status: Done
Scheduled continuation completed at ${new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(history.terminalAt))}.`
  }
  if (history.terminalState === 'canceled') {
    return 'Status: Canceled\nThe scheduled continuation was canceled.'
  }
  return formatDeferredContinuationStopped(history.terminalReason)
}

async function cancel(sessionId: string): Promise<string> {
  let existing: DeferredContinuationJobV1 | null
  try {
    existing = await readPendingDeferredContinuation(sessionId)
  } catch {
    return formatDeferredContinuationStopped('unknown')
  }
  if (!existing) {
    return 'Nothing to cancel — no continuation is scheduled for this conversation.'
  }
  let guard
  try {
    guard = await acquireDeferredContinuationLocks(existing)
  } catch {
    return `Continuation is already running and cannot be canceled safely. Wait for it to
finish, then check /continue-after-limit status.`
  }
  try {
    const current = await readPendingDeferredContinuation(sessionId)
    if (!current) {
      return 'Nothing to cancel — no continuation is scheduled for this conversation.'
    }
    if (current.state === 'submitted') {
      return `Continuation is already running and cannot be canceled safely. Wait for it to
finish, then check /continue-after-limit status.`
    }
    if (current.state === 'ambiguous') {
      return `Automatic continuation stopped — needs you.

Cat Code may have started the continuation before it closed. It will not
retry automatically because that could repeat tool actions.

Review the latest transcript and continue manually.`
    }
    const now = Date.now()
    await recordDeferredContinuationNotice({
      version: 1,
      sessionId,
      kind: 'canceled_command',
      observedAt: now,
    })
    await moveDeferredContinuationToHistory(current, 'canceled', 'command', now)
    return 'Scheduled continuation canceled.'
  } finally {
    await guard.release()
  }
}

type EnableProps = {
  onDone: LocalJSXCommandOnDone
}

function EnableBackgroundConfirmation({ onDone }: EnableProps): React.ReactNode {
  const choose = async (choice: 'enable' | 'cancel') => {
    if (choice === 'cancel') {
      onDone(undefined, { display: 'skip' })
      return
    }
    try {
      const path = await installDeferredContinuationLaunchAgent(process.execPath)
      onDone(
        `Background continuation enabled. Scheduled continuations can run after their
terminals close while the Mac is on, or after the next wake or login.

Executable: ${path}
Moving or deleting this executable disables background continuation.
Remove it with /continue-after-limit disable-background.`,
        { display: 'system' },
      )
    } catch {
      onDone(
        'Background continuation requires a stable installed Cat Code executable. Install Cat Code normally, then run /continue-after-limit enable-background again.',
        { display: 'system' },
      )
    }
  }
  return (
    <Dialog
      title="Allow Cat Code to run scheduled continuations after this terminal closes?"
      subtitle="This installs a user-level macOS background job. It runs only Cat Code's fixed continuation worker and does not store prompts or credentials."
      onCancel={() => onDone(undefined, { display: 'skip' })}
    >
      <Select
        defaultFocusValue="enable"
        options={[
          { value: 'enable' as const, label: 'Enable background continuation' },
          { value: 'cancel' as const, label: 'Cancel' },
        ]}
        onChange={choose}
        onCancel={() => onDone(undefined, { display: 'skip' })}
      />
    </Dialog>
  )
}

export const call: LocalJSXCommandCall = async (onDone, context, rawArgs) => {
  const args = rawArgs.trim()
  const sessionId = getSessionId()
  if (args === 'status') {
    onDone(await statusText(sessionId), { display: 'system' })
    return null
  }
  if (args === 'cancel') {
    const result = await cancel(sessionId)
    onDone(result, { display: 'system' })
    if (result === 'Scheduled continuation canceled.') {
      await takeDeferredContinuationNotice(sessionId).catch(() => null)
    }
    return null
  }
  if (args === 'disable-background') {
    let removed: boolean
    try {
      removed = await uninstallDeferredContinuationLaunchAgent()
    } catch (error) {
      // Uninstall throws when it cannot verify the job unloaded; it deliberately
      // keeps the plist rather than report a disable it did not achieve. Its
      // message names the plist and the manual bootout command, so surface that
      // text instead of a generic failure string.
      onDone(error instanceof Error ? error.message : String(error), {
        display: 'system',
      })
      return null
    }
    onDone(
      removed
        ? `Background continuation disabled. Scheduled continuations now wait until their
original conversations are open.`
        : 'Background continuation is already disabled.',
      { display: 'system' },
    )
    return null
  }
  if (args === 'enable-background') {
    const background = await getDeferredContinuationBackgroundStatus()
    if (background.state === 'enabled') {
      onDone('Background continuation is already enabled.', { display: 'system' })
      return null
    }
    return <EnableBackgroundConfirmation onDone={onDone} />
  }
  if (args !== '') {
    onDone(
      'Usage: /continue-after-limit [status|cancel|enable-background|disable-background]',
      { display: 'system' },
    )
    return null
  }
  if (context.isQueryActive) {
    onDone('Wait for the current turn to finish before scheduling continuation.', {
      display: 'system',
    })
    return null
  }
  let existing: DeferredContinuationJobV1 | null
  try {
    existing = await readPendingDeferredContinuation(sessionId)
  } catch {
    onDone(formatDeferredContinuationStopped('unknown'), { display: 'system' })
    return null
  }
  if (existing) {
    onDone(await statusText(sessionId), { display: 'system' })
    return null
  }
  const messages =
    (context as LocalJSXCommandContext & { messages?: Message[] }).messages ?? []
  const model = String(
    context.options.mainLoopModel ?? getMainLoopModelOverride() ?? '',
  )
  const eligibility = await evaluateDeferredContinuationEligibility({
    messages,
    model,
    baseProvider: context.options.mainLoopProvider,
  })
  if (eligibility.action === 'refuse') {
    onDone(REFUSALS[eligibility.reason], { display: 'system' })
    return null
  }
  const now = Date.now()
  const projectDir = getSessionProjectDir() ?? getProjectDir(getOriginalCwd())
  const worktree = getCurrentWorktreeSession()
  const job: DeferredContinuationJobV1 = {
    version: 1,
    jobId: randomUUID(),
    sessionId,
    projectStorageKey: basename(projectDir),
    context: {
      cwd: getCwd(),
      ...(worktree ? { worktreeRoot: worktree.worktreePath } : {}),
      model,
      effort: context.getAppState().effortValue,
      permissionMode: context.getAppState().toolPermissionContext.mode,
    },
    createdAt: now,
    statusObservedAt: eligibility.observedAt,
    scheduleReason:
      eligibility.action === 'run_now' ? 'account_available' : 'hard_quota_reset',
    ...(eligibility.action === 'schedule' ? { resetAt: eligibility.resetAt } : {}),
    notBefore: eligibility.action === 'run_now' ? now : eligibility.notBefore,
    state: 'pending',
    attempt: { number: 1, messageUuid: randomUUID() },
    transientRetries: 0,
  }
  await createPendingDeferredContinuation(job)
  if (eligibility.action === 'run_now') {
    onDone(
      `A usable Codex account is available, so continuation will start now.

Cat Code will add a new reconciliation message. It will not resend the
failed request.`,
      { display: 'system' },
    )
    return null
  }
  const background = await getDeferredContinuationBackgroundStatus()
  onDone(scheduledCopy(job, background.state === 'enabled'), {
    display: 'system',
  })
  return null
}
