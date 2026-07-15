import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import type { QueuedCommand } from '../types/textInputTypes.js'
import type { Message } from '../types/message.js'
import type { PersistedWorktreeSession } from '../types/logs.js'
import { resolveRequestProvider } from '../utils/model/providers.js'
import { restoreTrustedDeferredContinuationContext } from '../utils/sessionRestore.js'
import {
  flushCurrentTranscriptDurably,
  getProjectDir,
  recordDeferredContinuationResult,
} from '../utils/sessionStorage.js'
import { buildCodexStatus } from './api/codexStatus.js'
import {
  acquireDeferredContinuationLocks,
  getDeferredContinuationLockTargets,
  listDeferredContinuations,
  listDueDeferredContinuations,
  moveDeferredContinuationToHistory,
  pruneDeferredContinuationHistory,
  recordDeferredContinuationNotice,
  readPendingDeferredContinuation,
  readTrustedDeferredTranscript,
  reconcileSubmittedDeferredContinuation,
  writePendingDeferredContinuation,
  shouldScannerAttemptLock,
  type DeferredContinuationJobV1,
  type DeferredContinuationLockGuard,
  findLatestMainTerminalFailure,
} from './deferredContinuation.js'

export const RESET_ELAPSED_CONTINUATION = `Automated continuation requested through /continue-after-limit.

The Codex usage limit should now have reset. Continue the previous task, but
first reconcile the current transcript and filesystem state. Do not repeat
work or side effects that already completed.`

export const ACCOUNT_AVAILABLE_CONTINUATION = `Automated continuation requested through /continue-after-limit.

A usable Codex account is now available. Continue the previous task, but first
reconcile the current transcript and filesystem state. Do not repeat work or
side effects that already completed.`

export type DeferredAttemptOutcome =
  | 'completed'
  | 'quota_exhausted'
  | 'account_recovery'
  | 'transient_network'
  | 'ambiguous_rate_limit'
  | 'permission_required'
  | 'context_window'
  | 'max_turns'
  | 'max_budget'
  | 'session_restore'
  | 'transcript_persistence'
  | 'aborted'
  | 'unknown'

export type DeferredAttemptResult = {
  outcome: DeferredAttemptOutcome
  observedAt: number
}

type ForegroundRegistration = {
  jobId: string
  attemptUuid: string
  resolve: (result: DeferredAttemptResult) => void
  settled: boolean
  abortSignal?: AbortSignal
}

const foregroundRegistrations = new Map<string, ForegroundRegistration>()

type DeferredHeadlessResult = {
  type?: string
  subtype?: string
  is_error?: boolean
  permission_denials?: readonly unknown[]
}

type PreparedBackgroundAttempt = {
  job: DeferredContinuationJobV1
  guard: DeferredContinuationLockGuard
  completed: boolean
}

let preparedBackgroundAttempt: PreparedBackgroundAttempt | null = null

const RESTORABLE_BACKGROUND_PERMISSION_MODES = new Set([
  'default',
  'acceptEdits',
  'dontAsk',
  'plan',
])

export function getContinuationPrompt(job: DeferredContinuationJobV1): string {
  return job.scheduleReason === 'account_available'
    ? ACCOUNT_AVAILABLE_CONTINUATION
    : RESET_ELAPSED_CONTINUATION
}

function transcriptRestoreMetadata(
  job: DeferredContinuationJobV1,
  entries: readonly unknown[],
): { projectPath: string; worktreeSession?: PersistedWorktreeSession | null } {
  const firstMessage = entries.find(entry => {
    if (!entry || typeof entry !== 'object') return false
    const value = entry as Record<string, unknown>
    return (
      (value.type === 'user' || value.type === 'assistant') &&
      value.sessionId === job.sessionId &&
      typeof value.cwd === 'string'
    )
  }) as Record<string, unknown> | undefined
  if (!firstMessage || typeof firstMessage.cwd !== 'string') {
    throw new Error('Deferred continuation transcript lacks project metadata')
  }
  if (basename(getProjectDir(firstMessage.cwd)) !== job.projectStorageKey) {
    throw new Error('Deferred continuation project storage identity mismatch')
  }

  let worktreeSession: PersistedWorktreeSession | null | undefined
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue
    const value = entry as Record<string, unknown>
    if (value.type !== 'worktree-state' || value.sessionId !== job.sessionId) {
      continue
    }
    if (value.worktreeSession === null) {
      worktreeSession = null
    } else if (
      value.worktreeSession &&
      typeof value.worktreeSession === 'object' &&
      typeof (value.worktreeSession as Record<string, unknown>).worktreePath ===
        'string'
    ) {
      worktreeSession = value.worktreeSession as PersistedWorktreeSession
    } else {
      throw new Error('Malformed deferred continuation worktree metadata')
    }
  }
  return { projectPath: firstMessage.cwd, worktreeSession }
}

export function classifyDeferredHeadlessResult(
  messages: readonly Message[],
  result: DeferredHeadlessResult | undefined,
  observedAt = Date.now(),
  attemptUuid?: string,
): DeferredAttemptResult {
  const attemptIndex = attemptUuid
    ? messages.findLastIndex(
        message => message.type === 'user' && message.uuid === attemptUuid,
      )
    : -1
  if (attemptUuid && attemptIndex < 0) return { outcome: 'unknown', observedAt }
  const attemptMessages = attemptIndex >= 0 ? messages.slice(attemptIndex + 1) : messages
  const terminal = findLatestMainTerminalFailure(attemptMessages)
  if (terminal) {
    return { outcome: terminal.code, observedAt: terminal.observedAt }
  }
  if ((result?.permission_denials?.length ?? 0) > 0) {
    return { outcome: 'permission_required', observedAt }
  }
  if (result?.subtype === 'error_max_turns') {
    return { outcome: 'max_turns', observedAt }
  }
  if (result?.subtype === 'error_max_budget_usd') {
    return { outcome: 'max_budget', observedAt }
  }
  const latestAssistant = attemptMessages.findLast(
    message => message.type === 'assistant',
  )
  if (latestAssistant?.message.stop_reason === 'model_context_window_exceeded') {
    return { outcome: 'context_window', observedAt }
  }
  if (latestAssistant?.error === 'authentication_failed') {
    return { outcome: 'account_recovery', observedAt }
  }
  if (
    latestAssistant?.error === 'connection_error' ||
    latestAssistant?.error === 'server_error' ||
    latestAssistant?.error === 'api_timeout'
  ) {
    return { outcome: 'transient_network', observedAt }
  }
  if (result?.type === 'result' && result.subtype === 'success' && !result.is_error) {
    return { outcome: 'completed', observedAt }
  }
  return { outcome: 'unknown', observedAt }
}

export async function prepareBackgroundDeferredContinuation(
  now = Date.now(),
): Promise<DeferredContinuationJobV1 | null> {
  if (preparedBackgroundAttempt) {
    throw new Error('A deferred continuation worker is already prepared')
  }
  // Bounded history cleanup during normal queue startup. It only removes
  // records no surviving pending job still relies on, so it cannot resurrect
  // terminal work, and a failure here must never block due jobs.
  await pruneDeferredContinuationHistory(now).catch(() => 0)
  const submittedJobs = (await listDeferredContinuations()).filter(
    job => job.state === 'submitted',
  )
  for (const submitted of submittedJobs) {
    const target = getDeferredContinuationLockTargets(submitted).job
    if (await shouldScannerAttemptLock(target, now)) {
      try {
        await reconcileDeferredContinuationJob(submitted)
      } catch {
        // Another owner may have refreshed or acquired the lock after the
        // observation. That submitted job must not block unrelated sessions.
      }
    }
  }
  for (const candidate of await listDueDeferredContinuations(now)) {
    const target = getDeferredContinuationLockTargets(candidate).job
    if (!(await shouldScannerAttemptLock(target, now))) continue
    let guard: DeferredContinuationLockGuard
    try {
      guard = await acquireDeferredContinuationLocks(candidate)
    } catch {
      continue
    }
    try {
      guard.assertHealthy()
      const current = await readPendingDeferredContinuation(candidate.sessionId)
      if (
        !current ||
        current.jobId !== candidate.jobId ||
        current.state !== 'pending' ||
        current.notBefore > now
      ) {
        await guard.release()
        continue
      }
      if (
        resolveRequestProvider(current.context.model) !== 'openai' ||
        !RESTORABLE_BACKGROUND_PERMISSION_MODES.has(current.context.permissionMode)
      ) {
        const reason =
          resolveRequestProvider(current.context.model) !== 'openai'
            ? 'session_restore'
            : 'permission_restore'
        await recordDeferredContinuationNotice({
          version: 1,
          sessionId: current.sessionId,
          kind: 'needs_attention',
          reason,
          observedAt: now,
        })
        await moveDeferredContinuationToHistory(
          current,
          'needs_attention',
          reason,
          now,
        )
        await guard.release()
        return null
      }
      try {
        const entries = await readTrustedDeferredTranscript(current)
        await restoreTrustedDeferredContinuationContext(
          current.context,
          transcriptRestoreMetadata(current, entries),
        )
      } catch {
        await recordDeferredContinuationNotice({
          version: 1,
          sessionId: current.sessionId,
          kind: 'needs_attention',
          reason: 'session_restore',
          observedAt: now,
        })
        await moveDeferredContinuationToHistory(
          current,
          'needs_attention',
          'session_restore',
          now,
        )
        await guard.release()
        return null
      }
      const submitted: DeferredContinuationJobV1 = {
        ...current,
        state: 'submitted',
        attempt: { ...current.attempt, submittedAt: now },
      }
      await writePendingDeferredContinuation(submitted)
      preparedBackgroundAttempt = { job: submitted, guard, completed: false }
      delete process.env.CLAUDE_CODE_RESUME_INTERRUPTED_TURN
      return submitted
    } catch (error) {
      await guard.release()
      throw error
    }
  }
  return null
}

export function getPreparedBackgroundDeferredContinuation(): DeferredContinuationJobV1 | null {
  return preparedBackgroundAttempt?.job ?? null
}

export function getPreparedBackgroundDeferredAbortSignal(): AbortSignal | undefined {
  return preparedBackgroundAttempt?.guard.signal
}

export async function completePreparedBackgroundDeferredContinuation(
  messages: readonly Message[],
  result: DeferredHeadlessResult | undefined,
): Promise<void> {
  const prepared = preparedBackgroundAttempt
  if (!prepared || prepared.completed) return
  prepared.completed = true
  try {
    prepared.guard.assertHealthy()
    const classified = classifyDeferredHeadlessResult(
      messages,
      result,
      Date.now(),
      prepared.job.attempt.messageUuid,
    )
    await finalizeDeferredAttempt(prepared.job, classified, prepared.guard)
  } finally {
    preparedBackgroundAttempt = null
    await prepared.guard.release()
  }
}

export async function failPreparedBackgroundDeferredContinuation(
  outcome: Extract<DeferredAttemptOutcome, 'session_restore' | 'unknown'>,
): Promise<void> {
  const prepared = preparedBackgroundAttempt
  if (!prepared || prepared.completed) return
  prepared.completed = true
  try {
    const observedAt = Date.now()
    await recordDeferredContinuationNotice({
      version: 1,
      sessionId: prepared.job.sessionId,
      kind: 'needs_attention',
      reason: outcome,
      observedAt,
    })
    await moveDeferredContinuationToHistory(
      prepared.job,
      'needs_attention',
      outcome,
      observedAt,
    )
  } finally {
    preparedBackgroundAttempt = null
    await prepared.guard.release()
  }
}

export function registerForegroundDeferredAttempt(
  job: DeferredContinuationJobV1,
  abortSignal?: AbortSignal,
): { command: QueuedCommand; result: Promise<DeferredAttemptResult> } {
  if (job.state !== 'submitted') {
    throw new Error('Foreground deferred attempt must already be submitted')
  }
  const attemptUuid = job.attempt.messageUuid
  if (foregroundRegistrations.has(attemptUuid)) {
    throw new Error('Deferred continuation attempt is already registered')
  }
  let resolve!: (result: DeferredAttemptResult) => void
  const result = new Promise<DeferredAttemptResult>(value => {
    resolve = value
  })
  foregroundRegistrations.set(attemptUuid, {
    jobId: job.jobId,
    attemptUuid,
    resolve,
    settled: false,
    abortSignal,
  })
  return {
    command: {
      value: getContinuationPrompt(job),
      mode: 'prompt',
      skipSlashCommands: true,
      isMeta: false,
      priority: 'later',
      uuid: attemptUuid,
      origin: {
        kind: 'deferred-continuation',
        jobId: job.jobId,
        attemptUuid,
      },
    },
    result,
  }
}

export function getForegroundDeferredAbortSignal(
  origin: unknown,
): AbortSignal | undefined {
  if (!validateForegroundDeferredOrigin(origin)) return undefined
  const attemptUuid = (origin as { attemptUuid: string }).attemptUuid
  return foregroundRegistrations.get(attemptUuid)?.abortSignal
}

export function validateForegroundDeferredOrigin(origin: unknown): boolean {
  if (!origin || typeof origin !== 'object') return false
  const candidate = origin as Record<string, unknown>
  if (
    candidate.kind !== 'deferred-continuation' ||
    typeof candidate.jobId !== 'string' ||
    typeof candidate.attemptUuid !== 'string'
  ) {
    return false
  }
  const registration = foregroundRegistrations.get(candidate.attemptUuid)
  return (
    registration !== undefined &&
    registration.jobId === candidate.jobId &&
    !registration.settled
  )
}

export function settleForegroundDeferredAttempt(
  origin: unknown,
  result: DeferredAttemptResult,
): boolean {
  if (!validateForegroundDeferredOrigin(origin)) return false
  const attemptUuid = (origin as { attemptUuid: string }).attemptUuid
  const registration = foregroundRegistrations.get(attemptUuid)!
  registration.settled = true
  foregroundRegistrations.delete(attemptUuid)
  registration.resolve(result)
  return true
}

export function classifyForegroundDeferredAttempt(options: {
  origin: unknown
  messages: readonly Message[]
  aborted: boolean
  threw: boolean
  permissionDenied: boolean
  providerEntered: boolean
  observedAt?: number
}): DeferredAttemptResult | null {
  if (!validateForegroundDeferredOrigin(options.origin)) return null
  const observedAt = options.observedAt ?? Date.now()
  if (options.permissionDenied) {
    return { outcome: 'permission_required', observedAt }
  }
  if (options.aborted) return { outcome: 'aborted', observedAt }
  if (options.threw) return { outcome: 'unknown', observedAt }
  if (!options.providerEntered) return { outcome: 'unknown', observedAt }
  return classifyDeferredHeadlessResult(
    options.messages,
    { type: 'result', subtype: 'success', is_error: false },
    observedAt,
    (options.origin as { attemptUuid: string }).attemptUuid,
  )
}

export function abandonForegroundDeferredAttempt(origin: unknown): void {
  if (!origin || typeof origin !== 'object') return
  const attemptUuid = (origin as Record<string, unknown>).attemptUuid
  if (typeof attemptUuid !== 'string') return
  foregroundRegistrations.delete(attemptUuid)
}

const NETWORK_RETRY_DELAYS = [60_000, 5 * 60_000, 15 * 60_000] as const

async function persistAttemptResult(
  job: DeferredContinuationJobV1,
  result: DeferredAttemptResult,
): Promise<void> {
  await recordDeferredContinuationResult({
    type: 'deferred-continuation-result',
    version: 1,
    sessionId: job.sessionId,
    attemptUuid: job.attempt.messageUuid,
    outcome: result.outcome,
    observedAt: result.observedAt,
  })
  await flushCurrentTranscriptDurably()
}

async function finalizeDeferredAttempt(
  job: DeferredContinuationJobV1,
  result: DeferredAttemptResult,
  guard: Pick<DeferredContinuationLockGuard, 'assertHealthy'>,
): Promise<void> {
  if (result.outcome !== 'transcript_persistence') {
    try {
      await persistAttemptResult(job, result)
    } catch {
      guard.assertHealthy()
      await stopDeferredContinuationForAttention(
        job,
        'transcript_persistence',
        Date.now(),
      )
      return
    }
  }
  guard.assertHealthy()
  await applyAttemptResult(job, result)
}

async function stopDeferredContinuationForAttention(
  job: DeferredContinuationJobV1,
  reason: Exclude<
    Parameters<typeof moveDeferredContinuationToHistory>[2],
    'completed' | 'command' | 'human_message'
  >,
  observedAt: number,
): Promise<void> {
  await recordDeferredContinuationNotice({
    version: 1,
    sessionId: job.sessionId,
    kind: 'needs_attention',
    reason,
    observedAt,
  })
  await moveDeferredContinuationToHistory(
    job,
    'needs_attention',
    reason,
    observedAt,
  )
}

async function applyAttemptResult(
  job: DeferredContinuationJobV1,
  result: DeferredAttemptResult,
): Promise<void> {
  switch (result.outcome) {
    case 'completed':
      await recordDeferredContinuationNotice({
        version: 1,
        sessionId: job.sessionId,
        kind: 'completed',
        observedAt: result.observedAt,
      })
      await moveDeferredContinuationToHistory(job, 'completed', 'completed', result.observedAt)
      return
    case 'quota_exhausted': {
      let status
      try {
        status = await buildCodexStatus({ refresh: 'auto' })
      } catch {
        await stopDeferredContinuationForAttention(
          job,
          'quota_reset_unknown',
          result.observedAt,
        )
        return
      }
      const resetAt = Date.parse(status.decision.not_before ?? '')
      if (
        status.decision.action === 'wait' &&
        Number.isFinite(resetAt) &&
        resetAt > (job.resetAt ?? 0)
      ) {
        const notBefore = resetAt + 60_000
        await recordDeferredContinuationNotice({
          version: 1,
          sessionId: job.sessionId,
          kind: 'quota_rescheduled',
          notBefore,
          observedAt: result.observedAt,
        })
        await writePendingDeferredContinuation({
          ...job,
          scheduleReason: 'hard_quota_reset',
          resetAt,
          notBefore,
          state: 'pending',
          attempt: {
            number: job.attempt.number + 1,
            messageUuid: randomUUID(),
          },
        })
      } else {
        await stopDeferredContinuationForAttention(
          job,
          'quota_reset_unknown',
          result.observedAt,
        )
      }
      return
    }
    case 'transient_network': {
      const delay = NETWORK_RETRY_DELAYS[job.transientRetries]
      if (delay !== undefined) {
        const notBefore = result.observedAt + delay
        await recordDeferredContinuationNotice({
          version: 1,
          sessionId: job.sessionId,
          kind: 'network_retry',
          notBefore,
          retry: job.transientRetries + 1,
          observedAt: result.observedAt,
        })
        await writePendingDeferredContinuation({
          ...job,
          notBefore,
          state: 'pending',
          attempt: {
            number: job.attempt.number + 1,
            messageUuid: randomUUID(),
          },
          transientRetries: job.transientRetries + 1,
        })
      } else {
        await stopDeferredContinuationForAttention(
          job,
          'network',
          result.observedAt,
        )
      }
      return
    }
    case 'account_recovery':
    case 'ambiguous_rate_limit':
    case 'permission_required':
    case 'context_window':
    case 'max_turns':
    case 'max_budget':
    case 'session_restore':
    case 'transcript_persistence':
    case 'aborted':
    case 'unknown':
      await stopDeferredContinuationForAttention(
        job,
        result.outcome,
        result.observedAt,
      )
      return
    default: {
      const exhaustive: never = result.outcome
      return exhaustive
    }
  }
}

export async function runDeferredContinuationAttempt(options: {
  job: DeferredContinuationJobV1
  execute: (
    job: DeferredContinuationJobV1,
    prompt: string,
  ) => Promise<DeferredAttemptResult>
  now?: number
}): Promise<'skipped' | 'completed'> {
  const guard = await acquireDeferredContinuationLocks(options.job)
  try {
    guard.assertHealthy()
    const current = await readPendingDeferredContinuation(options.job.sessionId)
    const now = options.now ?? Date.now()
    if (!current || current.jobId !== options.job.jobId || current.state !== 'pending' || current.notBefore > now) {
      return 'skipped'
    }
    const submitted: DeferredContinuationJobV1 = {
      ...current,
      state: 'submitted',
      attempt: { ...current.attempt, submittedAt: now },
    }
    await writePendingDeferredContinuation(submitted)
    guard.assertHealthy()
    const result = await options.execute(submitted, getContinuationPrompt(submitted))
    await finalizeDeferredAttempt(submitted, result, guard)
    return 'completed'
  } finally {
    await guard.release()
  }
}

export async function beginForegroundDeferredContinuation(
  job: DeferredContinuationJobV1,
  now = Date.now(),
): Promise<{
  command: QueuedCommand
  finished: Promise<void>
} | null> {
  const guard = await acquireDeferredContinuationLocks(job)
  try {
    guard.assertHealthy()
    const current = await readPendingDeferredContinuation(job.sessionId)
    if (
      !current ||
      current.jobId !== job.jobId ||
      current.state !== 'pending' ||
      current.notBefore > now
    ) {
      await guard.release()
      return null
    }
    const submitted: DeferredContinuationJobV1 = {
      ...current,
      state: 'submitted',
      attempt: { ...current.attempt, submittedAt: now },
    }
    await writePendingDeferredContinuation(submitted)
    const registration = registerForegroundDeferredAttempt(submitted, guard.signal)
    const finished = (async () => {
      try {
        const result = await registration.result
        await finalizeDeferredAttempt(submitted, result, guard)
      } finally {
        await guard.release()
      }
    })()
    return { command: registration.command, finished }
  } catch (error) {
    await guard.release()
    throw error
  }
}

export async function reconcileDeferredContinuationJob(
  job: DeferredContinuationJobV1,
): Promise<void> {
  if (job.state !== 'submitted') return
  const guard = await acquireDeferredContinuationLocks(job)
  try {
    const current = await readPendingDeferredContinuation(job.sessionId)
    if (!current || current.jobId !== job.jobId || current.state !== 'submitted') return
    const entries = await readTrustedDeferredTranscript(current)
    const reconciliation = reconcileSubmittedDeferredContinuation(current, entries)
    if (reconciliation.action === 'return_pending') {
      await writePendingDeferredContinuation({
        ...current,
        state: 'pending',
        attempt: { number: current.attempt.number, messageUuid: current.attempt.messageUuid },
      })
    } else if (reconciliation.action === 'apply_result') {
      await applyAttemptResult(current, {
        outcome: reconciliation.result.outcome,
        observedAt: reconciliation.result.observedAt,
      })
    } else {
      await recordDeferredContinuationNotice({
        version: 1,
        sessionId: current.sessionId,
        kind: 'ambiguous',
        reason: 'ambiguous',
        observedAt: Date.now(),
      })
      await writePendingDeferredContinuation({ ...current, state: 'ambiguous' })
    }
  } finally {
    await guard.release()
  }
}

export async function runOneDeferredContinuationWorker(
  execute: (
    job: DeferredContinuationJobV1,
    prompt: string,
  ) => Promise<DeferredAttemptResult>,
  now = Date.now(),
): Promise<'empty' | 'skipped' | 'completed'> {
  const due = await listDueDeferredContinuations(now)
  if (!due[0]) return 'empty'
  const target = getDeferredContinuationLockTargets(due[0]).job
  if (!(await shouldScannerAttemptLock(target, now))) return 'skipped'
  return runDeferredContinuationAttempt({ job: due[0], execute, now })
}

export const _forTest = {
  clearForegroundRegistrations(): void {
    foregroundRegistrations.clear()
  },
  registrationCount(): number {
    return foregroundRegistrations.size
  },
}
