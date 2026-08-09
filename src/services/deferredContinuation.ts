import { constants as fsConstants } from 'node:fs'
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink,
} from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import z from 'zod/v4'
import type { EffortValue } from '../utils/effort.js'
import { getClaudeConfigHomeDir } from '../utils/envUtils.js'
import { lock } from '../utils/lockfile.js'
import { PERMISSION_MODES, type PermissionMode } from '../types/permissions.js'
import type { DeferredContinuationResultEntryV1 } from '../types/logs.js'
import type {
  AssistantMessage,
  DeferredTerminalFailureV1,
  Message,
} from '../types/message.js'
import {
  resolveRequestProvider,
  type APIProvider,
} from '../utils/model/providers.js'
import { getProjectsDir } from '../utils/sessionStorage.js'
import {
  buildCodexStatus,
  type CodexStatus,
} from './api/codexStatus.js'

export type DeferredContinuationEligibility =
  | { action: 'run_now'; observedAt: number }
  | {
      action: 'schedule'
      observedAt: number
      resetAt: number
      notBefore: number
    }
  | {
      action: 'refuse'
      reason:
        | 'not_codex'
        | 'not_terminal_quota'
        | 'observation_uncertain'
        | 'quota_reset_unknown'
        | 'account_recovery'
    }

export type DeferredContinuationJobV1 = {
  version: 1
  jobId: string
  sessionId: string
  projectStorageKey: string
  context: {
    cwd: string
    worktreeRoot?: string
    model: string
    effort?: EffortValue
    permissionMode: PermissionMode
  }
  createdAt: number
  statusObservedAt: number
  scheduleReason: 'account_available' | 'hard_quota_reset'
  resetAt?: number
  notBefore: number
  state: 'pending' | 'submitted' | 'ambiguous'
  attempt: {
    number: number
    messageUuid: string
    submittedAt?: number
  }
  transientRetries: number
}

export type DeferredContinuationTerminalState =
  | 'completed'
  | 'canceled'
  | 'needs_attention'

export type DeferredContinuationTerminalReason =
  | 'completed'
  | 'command'
  | 'human_message'
  | 'quota_reset_unknown'
  | 'network'
  | 'account_recovery'
  | 'ambiguous_rate_limit'
  | 'permission_required'
  | 'permission_restore'
  | 'context_window'
  | 'max_turns'
  | 'max_budget'
  | 'session_restore'
  | 'transcript_persistence'
  | 'aborted'
  | 'unknown'

export type DeferredContinuationHistoryV1 = DeferredContinuationJobV1 & {
  terminalState: DeferredContinuationTerminalState
  terminalReason: DeferredContinuationTerminalReason
  terminalAt: number
}

const finiteTimestamp = z.number().finite().nonnegative()
const uuid = z.string().uuid()
const effort = z.union([
  z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']),
  z.number().finite().nonnegative(),
])
const terminalReasonSchema = z.enum([
  'completed',
  'command',
  'human_message',
  'quota_reset_unknown',
  'network',
  'account_recovery',
  'ambiguous_rate_limit',
  'permission_required',
  'permission_restore',
  'context_window',
  'max_turns',
  'max_budget',
  'session_restore',
  'transcript_persistence',
  'aborted',
  'unknown',
])

export const deferredContinuationJobSchema = z
  .object({
    version: z.literal(1),
    jobId: uuid,
    sessionId: uuid,
    projectStorageKey: z.string().min(1).max(512).refine(isProjectStorageKey),
    context: z
      .object({
        cwd: z.string().min(1),
        worktreeRoot: z.string().min(1).optional(),
        model: z.string().min(1),
        effort: effort.optional(),
        permissionMode: z.enum(PERMISSION_MODES),
      })
      .strict(),
    createdAt: finiteTimestamp,
    statusObservedAt: finiteTimestamp,
    scheduleReason: z.enum(['account_available', 'hard_quota_reset']),
    resetAt: finiteTimestamp.optional(),
    notBefore: finiteTimestamp,
    state: z.enum(['pending', 'submitted', 'ambiguous']),
    attempt: z
      .object({
        number: z.number().int().positive(),
        messageUuid: uuid,
        submittedAt: finiteTimestamp.optional(),
      })
      .strict(),
    transientRetries: z.number().int().min(0).max(3),
  })
  .strict()
  .superRefine((job, ctx) => {
    if (job.scheduleReason === 'hard_quota_reset' && job.resetAt === undefined) {
      ctx.addIssue({ code: 'custom', message: 'hard quota jobs require resetAt' })
    }
    if (job.scheduleReason === 'account_available' && job.resetAt !== undefined) {
      ctx.addIssue({ code: 'custom', message: 'immediate jobs omit resetAt' })
    }
    if (job.state === 'pending' && job.attempt.submittedAt !== undefined) {
      ctx.addIssue({ code: 'custom', message: 'pending attempts omit submittedAt' })
    }
    if (job.state !== 'pending' && job.attempt.submittedAt === undefined) {
      ctx.addIssue({ code: 'custom', message: 'submitted attempts require submittedAt' })
    }
  })

export const deferredContinuationHistorySchema = z.custom<DeferredContinuationHistoryV1>(
  value => {
    if (!value || typeof value !== 'object') return false
    const candidate = value as Record<string, unknown>
    const { terminalState, terminalReason, terminalAt, ...job } = candidate
    return (
      deferredContinuationJobSchema.safeParse(job).success &&
      (terminalState === 'completed' ||
        terminalState === 'canceled' ||
        terminalState === 'needs_attention') &&
      terminalReasonSchema.safeParse(terminalReason).success &&
      (terminalState !== 'completed' || terminalReason === 'completed') &&
      (terminalState !== 'canceled' ||
        terminalReason === 'command' ||
        terminalReason === 'human_message') &&
      (terminalState !== 'needs_attention' ||
        (terminalReason !== 'completed' &&
          terminalReason !== 'command' &&
          terminalReason !== 'human_message')) &&
      typeof terminalAt === 'number' &&
      Number.isFinite(terminalAt) &&
      terminalAt >= 0
    )
  },
)

export const deferredContinuationResultSchema = z
  .object({
    type: z.literal('deferred-continuation-result'),
    version: z.literal(1),
    sessionId: uuid,
    attemptUuid: uuid,
    outcome: z.enum([
      'completed',
      'quota_exhausted',
      'account_recovery',
      'transient_network',
      'ambiguous_rate_limit',
      'permission_required',
      'context_window',
      'max_turns',
      'max_budget',
      'session_restore',
      'aborted',
      'unknown',
    ]),
    observedAt: finiteTimestamp,
  })
  .strict()

export const DEFERRED_LOCK_STALE_MS = 120_000
export const DEFERRED_LOCK_UPDATE_MS = 20_000
export const DEFERRED_SCAN_INTERVAL_MS = 60_000

type StorePaths = ReturnType<typeof getDeferredContinuationPaths>

export function isProjectStorageKey(value: string): boolean {
  return (
    value !== '.' &&
    value !== '..' &&
    basename(value) === value &&
    !value.includes('/') &&
    !value.includes('\\')
  )
}

export function getDeferredContinuationPaths(
  root = join(getClaudeConfigHomeDir(), 'deferred-continuations'),
) {
  return {
    root,
    pending: join(root, 'pending'),
    history: join(root, 'history'),
    locks: join(root, 'locks'),
    tmp: join(root, 'tmp'),
  }
}

async function validatePrivateDirectory(path: string): Promise<void> {
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error('Deferred continuation storage is not a private directory')
  }
  if ((info.mode & 0o077) !== 0) {
    throw new Error('Deferred continuation storage permissions are too broad')
  }
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
    throw new Error('Deferred continuation storage has the wrong owner')
  }
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  await validatePrivateDirectory(path)
}

export async function ensureDeferredContinuationStore(paths = getDeferredContinuationPaths()): Promise<void> {
  await ensurePrivateDirectory(paths.root)
  await Promise.all([
    ensurePrivateDirectory(paths.pending),
    ensurePrivateDirectory(paths.history),
    ensurePrivateDirectory(paths.locks),
    ensurePrivateDirectory(paths.tmp),
  ])
}

/**
 * Read-side store check: validates the queue root but never creates it.
 *
 * Reads run on a timer in every mounted session whether or not the feature was
 * ever used, so making them go through `ensureDeferredContinuationStore` cost
 * five `mkdir`s plus five `lstat`s per call and materialized an empty queue on
 * every machine. A store that does not exist holds no records, which is the
 * same answer the read itself would produce.
 */
async function validateDeferredContinuationStoreForRead(paths: StorePaths): Promise<void> {
  try {
    await validatePrivateDirectory(paths.root)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
}

/**
 * The queue itself, or the identity used to address it, cannot be used at all.
 *
 * Distinct from a record that exists but cannot be parsed. An unreadable record
 * means a schedule may be running, so callers fail closed; an unusable store
 * provably holds no schedule for this session, because nothing this process can
 * write ever reached it. Collapsing the two made a single `sudo cat-code` run
 * refuse every prompt in every later session with no exit, since the advertised
 * recovery opens the same store.
 */
export class DeferredContinuationStoreUnusableError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = 'DeferredContinuationStoreUnusableError'
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, fsConstants.O_RDONLY)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function atomicWriteJson(path: string, value: unknown, paths: StorePaths): Promise<void> {
  await ensureDeferredContinuationStore(paths)
  const tempPath = join(paths.tmp, `${randomUUID()}.tmp`)
  const handle = await open(
    tempPath,
    fsConstants.O_WRONLY |
      fsConstants.O_CREAT |
      fsConstants.O_EXCL |
      (fsConstants.O_NOFOLLOW ?? 0),
    0o600,
  )
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(tempPath, path)
  await chmod(path, 0o600)
  await syncDirectory(dirname(path))
}

async function readPrivateJson(path: string): Promise<unknown> {
  const before = await lstat(path)
  if (!before.isFile() || before.isSymbolicLink() || (before.mode & 0o077) !== 0) {
    throw new Error('Deferred continuation record failed private-file validation')
  }
  if (typeof process.getuid === 'function' && before.uid !== process.getuid()) {
    throw new Error('Deferred continuation record has the wrong owner')
  }
  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
  try {
    const after = await handle.stat()
    if (before.dev !== after.dev || before.ino !== after.ino || !after.isFile()) {
      throw new Error('Deferred continuation record changed while opening')
    }
    return JSON.parse(await handle.readFile('utf8'))
  } finally {
    await handle.close()
  }
}

function pendingPath(paths: StorePaths, sessionId: string): string {
  if (!uuid.safeParse(sessionId).success) throw new Error('Invalid session ID')
  return join(paths.pending, `${sessionId}.json`)
}

async function terminalHistoryExists(
  job: Pick<DeferredContinuationJobV1, 'jobId' | 'sessionId'>,
  paths: StorePaths,
): Promise<boolean> {
  try {
    deferredContinuationHistorySchema.parse(
      await readPrivateJson(join(paths.history, `${job.jobId}.json`)),
    )
    // The job ID determines the terminal-authority filename. Any valid record
    // at that exact path suppresses surviving pending work, even when its
    // contents do not match, so corruption cannot make the job executable.
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    // Once a terminal-authority filename exists, malformed or mismatched
    // contents must fail closed instead of making surviving pending work
    // executable after an interrupted history transition.
    return true
  }
}

export async function readPendingDeferredContinuation(
  sessionId: string,
  paths = getDeferredContinuationPaths(),
): Promise<DeferredContinuationJobV1 | null> {
  let recordPath: string
  try {
    await validateDeferredContinuationStoreForRead(paths)
    recordPath = pendingPath(paths, sessionId)
  } catch (error) {
    throw new DeferredContinuationStoreUnusableError(error)
  }
  try {
    const job = deferredContinuationJobSchema.parse(await readPrivateJson(recordPath))
    return (await terminalHistoryExists(job, paths)) ? null : job
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export async function createPendingDeferredContinuation(
  job: DeferredContinuationJobV1,
  paths = getDeferredContinuationPaths(),
): Promise<DeferredContinuationJobV1> {
  const parsed = deferredContinuationJobSchema.parse(job)
  await ensureDeferredContinuationStore(paths)
  const guard = await acquireDeferredContinuationLocks(parsed, paths)
  try {
    if (await readPendingDeferredContinuation(parsed.sessionId, paths)) {
      throw new Error('A deferred continuation already exists for this session')
    }
    await atomicWriteJson(pendingPath(paths, parsed.sessionId), parsed, paths)
    return parsed
  } finally {
    await guard.release()
  }
}

export async function writePendingDeferredContinuation(
  job: DeferredContinuationJobV1,
  paths = getDeferredContinuationPaths(),
): Promise<void> {
  const parsed = deferredContinuationJobSchema.parse(job)
  await atomicWriteJson(pendingPath(paths, parsed.sessionId), parsed, paths)
}

export async function moveDeferredContinuationToHistory(
  job: DeferredContinuationJobV1,
  terminalState: DeferredContinuationTerminalState,
  terminalReason: DeferredContinuationTerminalReason,
  now = Date.now(),
  paths = getDeferredContinuationPaths(),
  authority?: Pick<DeferredContinuationLockGuard, 'assertHealthy'>,
): Promise<DeferredContinuationHistoryV1> {
  const history = deferredContinuationHistorySchema.parse({
    ...job,
    terminalState,
    terminalReason,
    terminalAt: now,
  }) as DeferredContinuationHistoryV1
  authority?.assertHealthy()
  await atomicWriteJson(join(paths.history, `${job.jobId}.json`), history, paths)
  authority?.assertHealthy()
  await unlink(pendingPath(paths, job.sessionId))
  authority?.assertHealthy()
  await syncDirectory(paths.pending)
  return history
}

/**
 * Discard a pending record that cannot be read back.
 *
 * An unreadable record has no exit through the normal paths: it cannot be moved
 * to history (that needs a parsed job), so cancellation cannot clear it, while
 * `prepareHumanPromptAgainstDeferredContinuation` refuses every prompt for as
 * long as it exists. Without this the session is bricked until someone deletes
 * the file by hand — the same no-exit trap `ambiguous` used to be.
 *
 * Guarded by the session lock rather than the job lock: the job ID lives inside
 * the record we cannot parse, and the session lock is the one that answers the
 * question that matters — is an owner running this session right now? A worker
 * that started before the record rotted holds it and still has its own parsed
 * copy, whose completion unlinks this same path.
 *
 * Re-checks readability under the lock and refuses to delete a record that
 * parses: between the caller's failed read and this call the file may have been
 * rewritten, and discarding a live schedule the user never cancelled would be
 * worse than the trap.
 *
 * Returns false when nothing was discarded (no record, or it parses now).
 */
export async function discardUnreadableDeferredContinuation(
  sessionId: string,
  paths = getDeferredContinuationPaths(),
): Promise<boolean> {
  if (!uuid.safeParse(sessionId).success) throw new Error('Invalid session ID')
  await ensureDeferredContinuationStore(paths)
  const guard = await acquireOneLock(join(paths.locks, `session-${sessionId}`))
  try {
    try {
      // Full read AND schema parse — a record can be perfectly readable JSON and
      // still fail the schema, which is the case that strands a session.
      // Returns null for ENOENT, so both "gone" and "parses" land here.
      await readPendingDeferredContinuation(sessionId, paths)
      return false
    } catch {
      // Still unreadable under the lock — discard it.
    }
    guard.assertHealthy()
    try {
      await unlink(pendingPath(paths, sessionId))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
    await syncDirectory(paths.pending)
    return true
  } finally {
    await guard.release()
  }
}

export async function listDueDeferredContinuations(
  now = Date.now(),
  paths = getDeferredContinuationPaths(),
): Promise<DeferredContinuationJobV1[]> {
  await ensureDeferredContinuationStore(paths)
  const names = (await readdir(paths.pending)).filter(name => name.endsWith('.json')).sort()
  const jobs: DeferredContinuationJobV1[] = []
  for (const name of names) {
    try {
      const job = deferredContinuationJobSchema.parse(
        await readPrivateJson(join(paths.pending, name)),
      )
      if (await terminalHistoryExists(job, paths)) continue
      if (job.state === 'pending' && job.notBefore <= now) jobs.push(job)
    } catch {
      // Malformed records fail closed and are not executed.
    }
  }
  return jobs.sort((a, b) => a.notBefore - b.notBefore || a.jobId.localeCompare(b.jobId))
}

export async function listDeferredContinuations(
  paths = getDeferredContinuationPaths(),
): Promise<DeferredContinuationJobV1[]> {
  await ensureDeferredContinuationStore(paths)
  const jobs: DeferredContinuationJobV1[] = []
  for (const name of (await readdir(paths.pending)).filter(name => name.endsWith('.json')).sort()) {
    try {
      const job = deferredContinuationJobSchema.parse(
        await readPrivateJson(join(paths.pending, name)),
      )
      if (!(await terminalHistoryExists(job, paths))) jobs.push(job)
    } catch {
      // Malformed records fail closed and are never returned as executable work.
    }
  }
  return jobs
}

/**
 * Terminal history is retained for this long, then cleaned during normal queue
 * startup. It is the durable evidence behind `/continue-after-limit status`
 * after a job ends, so the window is generous rather than minimal.
 */
export const DEFERRED_CONTINUATION_HISTORY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

/**
 * Bounded cleanup of `history/`.
 *
 * History records are not inert logs: `terminalHistoryExists()` treats any
 * record at `history/<jobId>.json` as the terminal authority that suppresses a
 * surviving `pending/<sessionId>.json`. `moveDeferredContinuationToHistory()`
 * writes history *before* unlinking pending, so a crash between those two steps
 * leaves both files, and the history record is the only thing preventing the
 * already-terminal job from being read back as executable work. Deleting such a
 * record would resurrect it — the exact failure age-based pruning invites.
 *
 * So a record is removed only when both hold:
 *  - no surviving pending record still references its job ID (nothing left to
 *    suppress, so the tombstone has no remaining duty), and
 *  - it aged past the retention window.
 *
 * Anything unreadable fails closed and is kept. If the pending scan cannot be
 * completed exactly, the whole pass is skipped: pruning is opportunistic
 * housekeeping, and skipping a pass costs only disk.
 */
export async function pruneDeferredContinuationHistory(
  now = Date.now(),
  paths = getDeferredContinuationPaths(),
): Promise<number> {
  await ensureDeferredContinuationStore(paths)
  const referencedJobIds = new Set<string>()
  for (const name of (await readdir(paths.pending)).filter(name =>
    name.endsWith('.json'),
  )) {
    try {
      referencedJobIds.add(
        deferredContinuationJobSchema.parse(
          await readPrivateJson(join(paths.pending, name)),
        ).jobId,
      )
    } catch (error) {
      // A record that vanished mid-scan references nothing. Any other failure
      // means this pass cannot prove which tombstones are still load-bearing.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      if (!(error instanceof z.ZodError)) return 0
      // A malformed pending record is never parsed back into executable work
      // by listDueDeferredContinuations, so it cannot be resurrected.
    }
  }
  let removed = 0
  for (const name of (await readdir(paths.history)).filter(name =>
    name.endsWith('.json'),
  )) {
    try {
      const parsed = deferredContinuationHistorySchema.parse(
        await readPrivateJson(join(paths.history, name)),
      ) as DeferredContinuationHistoryV1
      if (referencedJobIds.has(parsed.jobId)) continue
      if (now - parsed.terminalAt < DEFERRED_CONTINUATION_HISTORY_RETENTION_MS) {
        continue
      }
      await unlink(join(paths.history, name))
      removed++
    } catch {
      // Unreadable or malformed history stays: terminalHistoryExists() treats
      // any record at that filename as terminal authority, so removing it could
      // make a surviving pending record executable again.
    }
  }
  if (removed > 0) await syncDirectory(paths.history)
  return removed
}

export function getDeferredContinuationLockTargets(
  job: Pick<DeferredContinuationJobV1, 'jobId' | 'sessionId'>,
  paths = getDeferredContinuationPaths(),
): { job: string; session: string } {
  // Both halves are validated: a caller honouring a `sessionId`-only signature
  // would silently address `job-undefined`, collapsing per-job mutual exclusion
  // into one global lock shared by every session.
  if (!uuid.safeParse(job.jobId).success) throw new Error('Invalid job ID')
  if (!uuid.safeParse(job.sessionId).success) throw new Error('Invalid session ID')
  return {
    job: join(paths.locks, `job-${job.jobId}`),
    session: join(paths.locks, `session-${job.sessionId}`),
  }
}

export async function getLatestDeferredContinuationHistory(
  sessionId: string,
  paths = getDeferredContinuationPaths(),
): Promise<DeferredContinuationHistoryV1 | null> {
  if (!uuid.safeParse(sessionId).success) throw new Error('Invalid session ID')
  await ensureDeferredContinuationStore(paths)
  let latest: DeferredContinuationHistoryV1 | null = null
  for (const name of (await readdir(paths.history)).filter(name => name.endsWith('.json'))) {
    try {
      const parsed = deferredContinuationHistorySchema.parse(
        await readPrivateJson(join(paths.history, name)),
      ) as DeferredContinuationHistoryV1
      if (
        parsed.sessionId === sessionId &&
        (!latest || parsed.terminalAt > latest.terminalAt)
      ) {
        latest = parsed
      }
    } catch {
      // Malformed history is never rendered or treated as authority.
    }
  }
  return latest
}

export type DeferredContinuationNoticeV1 = {
  version: 1
  sessionId: string
  kind:
    | 'completed'
    | 'canceled_command'
    | 'canceled_human'
    | 'needs_attention'
    | 'ambiguous'
    | 'network_retry'
    | 'quota_rescheduled'
  reason?: DeferredContinuationTerminalReason | 'ambiguous'
  notBefore?: number
  retry?: number
  observedAt: number
}

const deferredContinuationNoticeSchema = z
  .object({
    version: z.literal(1),
    sessionId: uuid,
    kind: z.enum([
      'completed',
      'canceled_command',
      'canceled_human',
      'needs_attention',
      'ambiguous',
      'network_retry',
      'quota_rescheduled',
    ]),
    reason: z.union([terminalReasonSchema, z.literal('ambiguous')]).optional(),
    notBefore: finiteTimestamp.optional(),
    retry: z.number().int().positive().max(3).optional(),
    observedAt: finiteTimestamp,
  })
  .strict()
  .superRefine((notice, ctx) => {
    const rescheduled =
      notice.kind === 'network_retry' || notice.kind === 'quota_rescheduled'
    if (rescheduled && notice.notBefore === undefined) {
      ctx.addIssue({ code: 'custom', message: 'reschedule notices require notBefore' })
    }
    if (!rescheduled && notice.notBefore !== undefined) {
      ctx.addIssue({ code: 'custom', message: 'terminal notices omit notBefore' })
    }
    if (notice.kind === 'network_retry' && notice.retry === undefined) {
      ctx.addIssue({ code: 'custom', message: 'network retry notices require retry' })
    }
    if (notice.kind !== 'network_retry' && notice.retry !== undefined) {
      ctx.addIssue({ code: 'custom', message: 'only network retry notices include retry' })
    }
    const needsReason = notice.kind === 'needs_attention' || notice.kind === 'ambiguous'
    if (needsReason && notice.reason === undefined) {
      ctx.addIssue({ code: 'custom', message: 'safety-stop notices require a reason' })
    }
    if (!needsReason && notice.reason !== undefined) {
      ctx.addIssue({ code: 'custom', message: 'non-terminal notices omit reasons' })
    }
    if (notice.kind === 'ambiguous' && notice.reason !== 'ambiguous') {
      ctx.addIssue({ code: 'custom', message: 'ambiguous notices use the fixed reason' })
    }
    if (notice.kind === 'needs_attention' && notice.reason === 'ambiguous') {
      ctx.addIssue({ code: 'custom', message: 'attention notices use a terminal reason' })
    }
  })

function noticePath(paths: StorePaths, sessionId: string): string {
  if (!uuid.safeParse(sessionId).success) throw new Error('Invalid session ID')
  return join(paths.tmp, `notice-${sessionId}.json`)
}

export async function recordDeferredContinuationNotice(
  notice: DeferredContinuationNoticeV1,
  paths = getDeferredContinuationPaths(),
): Promise<void> {
  const parsed = deferredContinuationNoticeSchema.parse(notice)
  await atomicWriteJson(noticePath(paths, parsed.sessionId), parsed, paths)
}

export async function takeDeferredContinuationNotice(
  sessionId: string,
  paths = getDeferredContinuationPaths(),
): Promise<DeferredContinuationNoticeV1 | null> {
  await validateDeferredContinuationStoreForRead(paths)
  const path = noticePath(paths, sessionId)
  try {
    const notice = deferredContinuationNoticeSchema.parse(await readPrivateJson(path))
    await unlink(path)
    await syncDirectory(paths.tmp)
    return notice
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export type DeferredHumanPromptDecision =
  | { action: 'allow' }
  | { action: 'allow_after_cancel'; notice: string }
  | { action: 'block'; notice: string }

export async function prepareHumanPromptAgainstDeferredContinuation(
  sessionId: string,
): Promise<DeferredHumanPromptDecision> {
  let existing: DeferredContinuationJobV1 | null
  try {
    existing = await readPendingDeferredContinuation(sessionId)
  } catch (error) {
    // An unusable queue holds no schedule for this session, so there is nothing
    // to fail closed against. Refusing here blocked every prompt in every
    // session after one `sudo cat-code` run, and named an exit that opens the
    // same queue and throws the same error.
    if (error instanceof DeferredContinuationStoreUnusableError) {
      return { action: 'allow' }
    }
    // Fail closed: an unreadable record cannot prove nothing is running, so the
    // prompt is refused. But it must name a real exit — `cancel` can discard an
    // unreadable record under the session lock. The old copy said "continue
    // manually", which is precisely what this branch forbids.
    return {
      action: 'block',
      notice:
        'Automatic continuation stopped — needs you. Cat Code could not validate the scheduled continuation safely. Run /continue-after-limit cancel to discard it, then send your message again.',
    }
  }
  if (!existing) return { action: 'allow' }
  let guard: DeferredContinuationLockGuard
  try {
    guard = await acquireDeferredContinuationLocks(existing)
  } catch {
    return {
      action: 'block',
      notice:
        'A scheduled continuation is already in progress. Wait for it to finish, then send your message again.',
    }
  }
  try {
    const current = await readPendingDeferredContinuation(sessionId)
    if (!current) return { action: 'allow' }
    switch (current.state) {
      case 'submitted':
        return {
          action: 'block',
          notice:
            'A scheduled continuation is already in progress. Wait for it to finish, then send your message again.',
        }
      // `ambiguous` blocks automatic retry because replaying could repeat tool
      // actions. It does not block the human: taking the conversation back is
      // the resolution the state is waiting for, and refusing it here left the
      // job with no exit but deleting the record by hand.
      case 'pending':
      case 'ambiguous': {
        const observedAt = Date.now()
        // A REPL suspended past the stale window lets a worker steal the lock
        // and start, so every durable write below re-asserts ownership rather
        // than tombstone a job the new owner is actively running.
        guard.assertHealthy()
        await recordDeferredContinuationNotice({
          version: 1,
          sessionId,
          kind: 'canceled_human',
          observedAt,
        })
        await moveDeferredContinuationToHistory(
          current,
          'canceled',
          'human_message',
          observedAt,
          undefined,
          guard,
        )
        return {
          action: 'allow_after_cancel',
          notice:
            current.state === 'ambiguous'
              ? 'Scheduled continuation canceled because you sent a new message. Cat Code may have started the continuation before it closed, so review the latest transcript before relying on it.'
              : 'Scheduled continuation canceled because you sent a new message.',
        }
      }
      default: {
        const exhaustive: never = current.state
        return exhaustive
      }
    }
  } finally {
    await guard.release()
  }
}

async function ensureLockTarget(path: string): Promise<void> {
  try {
    const handle = await open(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600)
    await handle.close()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
    throw new Error('Deferred continuation lock target failed private-file validation')
  }
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
    throw new Error('Deferred continuation lock target has the wrong owner')
  }
}

export async function shouldScannerAttemptLock(
  target: string,
  now = Date.now(),
  paths = getDeferredContinuationPaths(),
): Promise<boolean> {
  const lockDirectory = `${target}.lock`
  let identity: { ino: number; mtimeMs: number }
  try {
    const info = await lstat(lockDirectory)
    if (!info.isDirectory() || info.isSymbolicLink()) return false
    if ((info.mode & 0o077) !== 0) return false
    if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
      return false
    }
    if (now - info.mtimeMs < DEFERRED_LOCK_STALE_MS) return false
    identity = { ino: info.ino, mtimeMs: info.mtimeMs }
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
  }
  const observationPath = join(paths.tmp, `stale-${basename(target)}.json`)
  try {
    const previous = JSON.parse(await readFile(observationPath, 'utf8')) as Record<string, unknown>
    if (
      previous.ino === identity.ino &&
      previous.mtimeMs === identity.mtimeMs &&
      typeof previous.observedAt === 'number' &&
      now - previous.observedAt >= DEFERRED_SCAN_INTERVAL_MS
    ) {
      return true
    }
  } catch {
    // First observation is recorded below.
  }
  await atomicWriteJson(observationPath, { ...identity, observedAt: now }, paths)
  return false
}

export type DeferredContinuationLockGuard = {
  signal: AbortSignal
  assertHealthy(): void
  release(): Promise<void>
}

async function acquireOneLock(target: string): Promise<DeferredContinuationLockGuard> {
  await ensureLockTarget(target)
  let compromised: Error | null = null
  const abortController = new AbortController()
  const release = await lock(target, {
    realpath: false,
    stale: DEFERRED_LOCK_STALE_MS,
    update: DEFERRED_LOCK_UPDATE_MS,
    retries: 0,
    onCompromised: error => {
      compromised = error
      abortController.abort(error)
    },
  })
  return {
    signal: abortController.signal,
    assertHealthy() {
      if (compromised) throw compromised
    },
    release,
  }
}

export async function acquireDeferredContinuationLocks(
  job: Pick<DeferredContinuationJobV1, 'jobId' | 'sessionId'>,
  paths = getDeferredContinuationPaths(),
): Promise<DeferredContinuationLockGuard> {
  await ensureDeferredContinuationStore(paths)
  const targets = getDeferredContinuationLockTargets(job, paths)
  const jobGuard = await acquireOneLock(targets.job)
  try {
    const sessionGuard = await acquireOneLock(targets.session)
    const abortController = new AbortController()
    const abort = (signal: AbortSignal) => {
      if (!abortController.signal.aborted) abortController.abort(signal.reason)
    }
    jobGuard.signal.addEventListener('abort', () => abort(jobGuard.signal), {
      once: true,
    })
    sessionGuard.signal.addEventListener(
      'abort',
      () => abort(sessionGuard.signal),
      { once: true },
    )
    return {
      signal: abortController.signal,
      assertHealthy() {
        jobGuard.assertHealthy()
        sessionGuard.assertHealthy()
      },
      async release() {
        await sessionGuard.release()
        await jobGuard.release()
      },
    }
  } catch (error) {
    await jobGuard.release()
    throw error
  }
}

async function validatePrivateComponent(path: string, kind: 'directory' | 'file') {
  const info = await lstat(path)
  if (info.isSymbolicLink() || (kind === 'directory' ? !info.isDirectory() : !info.isFile())) {
    throw new Error('Untrusted deferred continuation path component')
  }
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
    throw new Error('Deferred continuation path has the wrong owner')
  }
  if ((info.mode & 0o077) !== 0) {
    throw new Error('Deferred continuation path permissions are too broad')
  }
  return info
}

/** Chunk size for the forward transcript reader, matching the session-storage
 * reader it borrows its approach from (`sessionStoragePortable.ts`). */
const DEFERRED_TRANSCRIPT_CHUNK_BYTES = 1024 * 1024

/**
 * Ceiling on a transcript the deferred preflight will read.
 *
 * The preflight runs before durable state moves, so it fails closed rather than
 * risking an OOM exit: a killed process leaves the job `pending` and the minute
 * worker simply retries it forever. Callers turn the throw into a stated
 * terminal outcome instead (`deferredContinuationRunner.ts` reports
 * `session_restore` for a transcript it cannot read).
 *
 * The bound is deliberately far above real transcripts. Reconciliation and
 * restore both need arbitrary entries from anywhere in the file, so the parsed
 * entries — not the file bytes — are the residual peak, and only a caller-side
 * projection could bound that further.
 */
export const DEFERRED_TRANSCRIPT_MAX_BYTES = 64 * 1024 * 1024

/**
 * Chunked forward line reader. Peak allocation is one chunk plus the longest
 * line, instead of the whole file as a string plus an array of every line.
 * `StringDecoder` holds back partial multi-byte characters so a character split
 * across a chunk boundary is not corrupted into replacement characters.
 */
async function* readTranscriptLines(
  handle: Awaited<ReturnType<typeof open>>,
  maxBytes: number,
): AsyncGenerator<string> {
  const chunk = Buffer.allocUnsafe(DEFERRED_TRANSCRIPT_CHUNK_BYTES)
  const decoder = new StringDecoder('utf8')
  let carry = ''
  let total = 0
  for (;;) {
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, null)
    if (bytesRead === 0) break
    total += bytesRead
    if (total > maxBytes) {
      throw new Error('Deferred continuation transcript is too large to read safely')
    }
    carry += decoder.write(chunk.subarray(0, bytesRead))
    let newline = carry.indexOf('\n')
    while (newline !== -1) {
      const line = carry.slice(0, newline)
      carry = carry.slice(newline + 1)
      if (line) yield line
      newline = carry.indexOf('\n')
    }
  }
  carry += decoder.end()
  if (carry) yield carry
}

export async function readTrustedDeferredTranscript(
  job: Pick<DeferredContinuationJobV1, 'projectStorageKey' | 'sessionId'>,
  projectsRoot = getProjectsDir(),
  maxBytes = DEFERRED_TRANSCRIPT_MAX_BYTES,
): Promise<unknown[]> {
  if (!isProjectStorageKey(job.projectStorageKey) || !uuid.safeParse(job.sessionId).success) {
    throw new Error('Invalid deferred continuation transcript identity')
  }
  await validatePrivateComponent(projectsRoot, 'directory')
  const projectDir = join(projectsRoot, job.projectStorageKey)
  await validatePrivateComponent(projectDir, 'directory')
  const transcriptPath = join(projectDir, `${job.sessionId}.jsonl`)
  const before = await validatePrivateComponent(transcriptPath, 'file')
  if (before.size > maxBytes) {
    throw new Error('Deferred continuation transcript is too large to read safely')
  }
  const handle = await open(transcriptPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
  try {
    const after = await handle.stat()
    if (before.dev !== after.dev || before.ino !== after.ino || !after.isFile()) {
      throw new Error('Transcript changed while opening')
    }
    const entries: unknown[] = []
    // The size gate above is the fast path; the running total re-checks because
    // the file can still grow while it is being read.
    for await (const line of readTranscriptLines(handle, maxBytes)) {
      entries.push(JSON.parse(line))
    }
    return entries
  } finally {
    await handle.close()
  }
}

export function reconcileSubmittedDeferredContinuation(
  job: DeferredContinuationJobV1,
  transcriptEntries: readonly unknown[],
):
  | { action: 'return_pending' }
  | { action: 'apply_result'; result: DeferredContinuationResultEntryV1 }
  | { action: 'mark_ambiguous' } {
  if (job.state !== 'submitted') throw new Error('Only submitted jobs can be reconciled')
  const hasUserMessage = transcriptEntries.some(entry => {
    if (!entry || typeof entry !== 'object') return false
    const value = entry as Record<string, unknown>
    return value.type === 'user' && value.uuid === job.attempt.messageUuid
  })
  if (!hasUserMessage) return { action: 'return_pending' }
  for (const entry of transcriptEntries) {
    const result = deferredContinuationResultSchema.safeParse(entry)
    if (
      result.success &&
      result.data.sessionId === job.sessionId &&
      result.data.attemptUuid === job.attempt.messageUuid
    ) {
      return { action: 'apply_result', result: result.data }
    }
  }
  return { action: 'mark_ambiguous' }
}
const TERMINAL_FAILURE_CODES = new Set<DeferredTerminalFailureV1['code']>([
  'quota_exhausted',
  'account_recovery',
  'transient_network',
  'ambiguous_rate_limit',
])

export function parseDeferredTerminalFailure(
  value: unknown,
): DeferredTerminalFailureV1 | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Record<string, unknown>
  if (
    candidate.version !== 1 ||
    candidate.provider !== 'openai' ||
    typeof candidate.code !== 'string' ||
    !TERMINAL_FAILURE_CODES.has(candidate.code as DeferredTerminalFailureV1['code']) ||
    typeof candidate.observedAt !== 'number' ||
    !Number.isFinite(candidate.observedAt) ||
    candidate.observedAt <= 0
  ) {
    return null
  }
  return {
    version: 1,
    provider: 'openai',
    code: candidate.code as DeferredTerminalFailureV1['code'],
    observedAt: candidate.observedAt,
  }
}

export function findLatestMainTerminalFailure(
  messages: readonly Message[],
): DeferredTerminalFailureV1 | null {
  const latestAssistant = messages.findLast(
    (message): message is AssistantMessage => message.type === 'assistant',
  )
  if (latestAssistant?.isApiErrorMessage !== true) return null
  return parseDeferredTerminalFailure(latestAssistant?.deferredTerminalFailure)
}

export function computeContinuationNotBefore(
  observedAt: number,
  resetAt: number,
): number {
  return Math.max(observedAt, resetAt + 60_000)
}

export async function evaluateDeferredContinuationEligibility(options: {
  messages: readonly Message[]
  model: string
  baseProvider?: APIProvider
  now?: number
  buildStatus?: () => Promise<CodexStatus>
}): Promise<DeferredContinuationEligibility> {
  const now = options.now ?? Date.now()
  if (resolveRequestProvider(options.model, options.baseProvider) !== 'openai') {
    return { action: 'refuse', reason: 'not_codex' }
  }

  const failure = findLatestMainTerminalFailure(options.messages)
  if (!failure || failure.code !== 'quota_exhausted') {
    return { action: 'refuse', reason: 'not_terminal_quota' }
  }

  const status = await (
    options.buildStatus ?? (() => buildCodexStatus({ refresh: 'auto', loadPool: false }))
  )()
  const observedAt = Date.parse(status.observed_at)
  if (!Number.isFinite(observedAt) || observedAt < failure.observedAt) {
    return { action: 'refuse', reason: 'observation_uncertain' }
  }

  switch (status.decision.action) {
    case 'delegate':
      return { action: 'run_now', observedAt }
    case 'attempt':
      return { action: 'refuse', reason: 'observation_uncertain' }
    case 'recheck':
      return { action: 'refuse', reason: 'quota_reset_unknown' }
    case 'human_recovery':
      return { action: 'refuse', reason: 'account_recovery' }
    case 'wait': {
      const resetAt = Date.parse(status.decision.not_before ?? '')
      if (!Number.isFinite(resetAt) || resetAt <= 0) {
        return { action: 'refuse', reason: 'quota_reset_unknown' }
      }
      return {
        action: 'schedule',
        observedAt,
        resetAt,
        notBefore: computeContinuationNotBefore(now, resetAt),
      }
    }
    default: {
      const exhaustive: never = status.decision.action
      return exhaustive
    }
  }
}
