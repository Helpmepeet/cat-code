import { createHash, randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { dirname } from 'node:path'
import { lock } from '../../utils/lockfile.js'
import { logForDebugging } from '../../utils/debug.js'
import {
  claimClaudeRefresh, completeClaudeRefresh, finishClaudeRefreshNotSent,
  markClaudeRefreshUncertain, readClaudeAccountAuthority, reconcileClaudeRefresh,
  rejectClaudeCredential, startClaudeRefreshDispatch,
  type ClaudeAuthorityCredentials, type ClaudeCredentialHandle, type ClaudeRefreshClaim,
} from './claudeAccountAuthority.js'

export type ClaudeOAuthPreparationResult =
  | { status: 'ready'; handle: ClaudeCredentialHandle; credentials: ClaudeAuthorityCredentials; refreshed?: boolean }
  | { status: 'waiting' | 'temporarily_unavailable' | 'persistence_pending' | 'refresh_uncertain' | 'sign_in_required' | 'older_login'; handle?: ClaudeCredentialHandle }

const sharedRefreshes = new Map<string, Promise<ClaudeOAuthPreparationResult>>()
const pendingSuccessors = new Map<string, { claim: ClaudeRefreshClaim; credentials: ClaudeAuthorityCredentials; compromised: boolean }>()
const pendingRejections = new Map<string, ClaudeRefreshClaim>()

function refreshDiagnostic(handle: ClaudeCredentialHandle, phase: string, outcome: string, operationId?: string): void {
  const ref = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 16)
  logForDebugging(`[claude-refresh] provider=anthropic kind=refresh accountRef=${ref(handle.accountId)} generation=${handle.generation} revision=${handle.revision} phase=${phase} outcome=${outcome} operationRef=${operationId ? ref(operationId) : 'none'}`)
}

function observeAccount(expected: ClaudeCredentialHandle): ClaudeOAuthPreparationResult {
  const read = readClaudeAccountAuthority(expected.accountId)
  if (!('record' in read)) return { status: read.status === 'missing' ? 'sign_in_required' : 'temporarily_unavailable', handle: expected }
  if (read.handle.generation !== expected.generation) return { status: 'older_login', handle: read.handle }
  if (read.handle.revision < expected.revision) return { status: 'temporarily_unavailable', handle: read.handle }
  if (read.status === 'persistence_pending') return { status: 'persistence_pending', handle: read.handle }
  if (read.status === 'uncertain') return { status: 'refresh_uncertain', handle: read.handle }
  if (read.status === 'rejected' && read.record.rejection === 'access_rejected') return { status: 'temporarily_unavailable', handle: read.handle }
  if (read.status !== 'ready' || !read.record.credentials) return { status: 'sign_in_required', handle: read.handle }
  return { status: 'ready', handle: read.handle, credentials: read.record.credentials }
}

/** Account identity and lock path must come from the same shared-vault authority. */
export function prepareClaudeAccountCredentials(
  expected: ClaudeCredentialHandle,
  options: ClaudeRefreshWaitOptions & { refreshLockPath: string; force?: boolean; failedAccessToken?: string },
): Promise<ClaudeOAuthPreparationResult> {
  if (options.signal?.aborted) return Promise.resolve({ status: 'waiting', handle: expected })
  const key = JSON.stringify([options.refreshLockPath, expected.accountId, expected.generation, expected.revision, options.force === true])
  let shared = sharedRefreshes.get(key)
  if (!shared) {
    refreshDiagnostic(expected, 'init', 'started')
    shared = refreshAccount(expected, options).then(result => {
      refreshDiagnostic(result.handle ?? expected, 'operation', result.status)
      return result
    }).finally(() => {
      if (sharedRefreshes.get(key) === shared) sharedRefreshes.delete(key)
    })
    sharedRefreshes.set(key, shared)
  }
  return waitForClaudeRefreshPreparation(shared, options).then(result =>
    result.status === 'waiting' ? { ...result, handle: expected } : result)
}

async function refreshAccount(
  expected: ClaudeCredentialHandle,
  options: { refreshLockPath: string; force?: boolean; failedAccessToken?: string },
): Promise<ClaudeOAuthPreparationResult> {
  let release: (() => Promise<void>) | undefined
  let compromised = false
  let lockIdentity: string | undefined
  const ownsLock = () => {
    if (compromised || !lockIdentity) return false
    try {
      const stat = statSync(`${options.refreshLockPath}.lock`)
      if (`${stat.dev}:${stat.ino}:${stat.birthtimeMs}` === lockIdentity) return true
    } catch { /* A removed lock is lost ownership, not an unlocked permit. */ }
    compromised = true
    refreshDiagnostic(expected, 'lock', 'ownership_lost', claim?.operationId)
    return false
  }
  let claim: ClaudeRefreshClaim | undefined
  let dispatched = false
  let dispatchPersistencePending = false
  try {
    await mkdir(dirname(options.refreshLockPath), { recursive: true, mode: 0o700 })
    const lockDeadline = Date.now() + 10_000
    let reportedContention = false
    while (!release) {
      try {
        release = await lock(options.refreshLockPath, {
          realpath: false, stale: 120_000, update: 30_000,
          onCompromised: () => {
            compromised = true
            refreshDiagnostic(expected, 'lock', 'compromised', claim?.operationId)
          },
        })
        const stat = statSync(`${options.refreshLockPath}.lock`)
        lockIdentity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`
        refreshDiagnostic(expected, 'lock', 'acquired')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ELOCKED') return { status: 'temporarily_unavailable', handle: expected }
        if (!reportedContention) {
          refreshDiagnostic(expected, 'lock', 'contended')
          reportedContention = true
        }
        if (Date.now() >= lockDeadline) return { status: 'waiting', handle: expected }
        await Bun.sleep(25)
      }
    }
    const initial = observeAccount(expected)
    const pendingRejection = pendingRejections.get(options.refreshLockPath)
    if (pendingRejection) {
      const rejected = rejectClaudeCredential(pendingRejection.handle, pendingRejection.operationId, 'invalid_grant')
      if (rejected.outcome === 'persistence_pending') return { status: 'persistence_pending', handle: expected }
      pendingRejections.delete(options.refreshLockPath)
      return observeAccount(expected)
    }
    const pending = pendingSuccessors.get(options.refreshLockPath)
    if (pending && pending.claim.handle.generation === expected.generation) {
      if (pending.compromised) {
        const reconciliation = reconcileClaudeRefresh(expected.accountId, pending.claim.operationId, pending)
        refreshDiagnostic(expected, 'reconciliation', reconciliation.outcome, pending.claim.operationId)
        if (reconciliation.outcome === 'persistence_pending') return { status: 'persistence_pending', handle: expected }
        if (reconciliation.outcome === 'uncertain') return { status: 'refresh_uncertain', handle: expected }
        if (reconciliation.outcome === 'rejected' && !('record' in readClaudeAccountAuthority(expected.accountId))) {
          return { status: 'temporarily_unavailable', handle: expected }
        }
      } else {
        const saved = completeClaudeRefresh(pending.claim, pending.credentials)
        if (saved.outcome === 'persistence_pending') return { status: 'persistence_pending', handle: expected }
        if (saved.outcome === 'rejected' && !('record' in readClaudeAccountAuthority(expected.accountId))) {
          return { status: 'temporarily_unavailable', handle: expected }
        }
        if (saved.reason === 'reconciliation_required') {
          pending.compromised = true
          const reconciled = reconcileClaudeRefresh(expected.accountId, pending.claim.operationId, pending)
          refreshDiagnostic(expected, 'reconciliation', reconciled.outcome, pending.claim.operationId)
          if (reconciled.outcome === 'persistence_pending') return { status: 'persistence_pending', handle: expected }
          if (reconciled.outcome === 'uncertain') return { status: 'refresh_uncertain', handle: expected }
        }
      }
      pendingSuccessors.delete(options.refreshLockPath)
      return observeAccount(expected)
    }
    const read = readClaudeAccountAuthority(expected.accountId)
    if (!('record' in read)) return { status: 'temporarily_unavailable', handle: expected }
    const repairAccessRejection = read.status === 'rejected' && read.record.rejection === 'access_rejected' &&
      read.handle.generation === expected.generation && read.handle.revision >= expected.revision && !!read.record.credentials
    // A rejected access revision may refresh, but is never returned as sendable.
    const observed = repairAccessRejection
      ? { status: 'ready' as const, handle: read.handle, credentials: read.record.credentials! }
      : initial
    if (observed.status !== 'ready') return observed
    const intent = read.record.refreshIntent
    if (intent) {
      const orphan = { handle: read.handle, operationId: intent.operationId, ownerNonce: intent.ownerNonce }
      if (intent.phase !== 'prepared') {
        markClaudeRefreshUncertain(orphan, 'interrupted_refresh')
        return { status: 'refresh_uncertain', handle: read.handle }
      }
      if (finishClaudeRefreshNotSent(orphan).outcome !== 'committed') return { status: 'persistence_pending', handle: read.handle }
    }
    if (options.force && observed.handle.revision !== expected.revision) return repairAccessRejection ? initial : observed
    if (options.failedAccessToken && observed.credentials.accessToken !== options.failedAccessToken) return { status: 'older_login', handle: observed.handle }
    const { refreshOAuthToken, isOAuthTokenExpired } = await import('../oauth/client.js')
    if (!options.force && !repairAccessRejection && !isOAuthTokenExpired(observed.credentials.expiresAt)) return observed
    if (!observed.credentials.refreshToken) return { status: 'sign_in_required', handle: observed.handle }
    // Only a positively identified pre-connection failure is replayable.
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!ownsLock()) {
        refreshDiagnostic(observed.handle, 'dispatch', 'definitely_not_sent')
        return { status: 'temporarily_unavailable', handle: observed.handle }
      }
      const claimed = claimClaudeRefresh(observed.handle, randomUUID(), randomUUID())
      if (!claimed.claim) return { status: claimed.outcome === 'persistence_pending' ? 'persistence_pending' : 'waiting', handle: observed.handle }
      claim = claimed.claim
      dispatched = false
      dispatchPersistencePending = false
      try {
        const tokens = await refreshOAuthToken(observed.credentials.refreshToken, {
          skipProfile: true, persistProfile: false, scopes: observed.credentials.scopes,
          initiateRequest: start => {
            if (!ownsLock()) throw new Error('Claude refresh lock ownership lost before dispatch')
            const dispatch = startClaudeRefreshDispatch(claim!, () => {
              dispatched = true
              refreshDiagnostic(observed.handle, 'dispatch', 'initiated', claim!.operationId)
              return start()
            })
            if (!dispatch.started) {
              dispatchPersistencePending = dispatch.result.outcome === 'persistence_pending'
              throw new Error(`Claude refresh dispatch denied: ${dispatch.result.outcome}`)
            }
            return dispatch.started
          },
        })
        const credentials: ClaudeAuthorityCredentials = {
          accessToken: tokens.accessToken, refreshToken: tokens.refreshToken ?? observed.credentials.refreshToken,
          expiresAt: tokens.expiresAt ?? 0, scopes: tokens.scopes ?? observed.credentials.scopes,
          subscriptionType: tokens.subscriptionType ?? observed.credentials.subscriptionType,
          rateLimitTier: tokens.rateLimitTier ?? observed.credentials.rateLimitTier,
        }
        ownsLock()
        pendingSuccessors.set(options.refreshLockPath, { claim, credentials, compromised })
        if (compromised) {
          const reconciled = reconcileClaudeRefresh(expected.accountId, claim.operationId, { claim, credentials })
          refreshDiagnostic(expected, 'reconciliation', reconciled.outcome, claim.operationId)
          if (reconciled.outcome === 'persistence_pending') return { status: 'persistence_pending', handle: observed.handle }
          if (reconciled.outcome === 'uncertain') {
            markClaudeRefreshUncertain(claim, 'lock_ownership_lost')
            return { status: 'refresh_uncertain', handle: observed.handle }
          }
          if (reconciled.outcome === 'rejected') {
            if (!('record' in readClaudeAccountAuthority(expected.accountId))) return { status: 'temporarily_unavailable', handle: expected }
            pendingSuccessors.delete(options.refreshLockPath)
            return observeAccount(expected)
          }
        } else {
          const saved = completeClaudeRefresh(claim, credentials)
          if (saved.outcome === 'persistence_pending') return { status: 'persistence_pending', handle: observed.handle }
          if (saved.reason === 'reconciliation_required') {
            pendingSuccessors.get(options.refreshLockPath)!.compromised = true
            const reconciled = reconcileClaudeRefresh(expected.accountId, claim.operationId, { claim, credentials })
            refreshDiagnostic(expected, 'reconciliation', reconciled.outcome, claim.operationId)
            if (reconciled.outcome === 'persistence_pending') return { status: 'persistence_pending', handle: observed.handle }
            if (reconciled.outcome === 'uncertain') return { status: 'refresh_uncertain', handle: observed.handle }
          }
          if (saved.outcome !== 'committed') {
            if (!('record' in readClaudeAccountAuthority(expected.accountId))) return { status: 'temporarily_unavailable', handle: expected }
            pendingSuccessors.delete(options.refreshLockPath)
            return observeAccount(expected)
          }
        }
        pendingSuccessors.delete(options.refreshLockPath)
        const completed = observeAccount(expected)
        return completed.status === 'ready' ? { ...completed, refreshed: true } : completed
      } catch (error) {
        if (!dispatched) {
          refreshDiagnostic(observed.handle, 'dispatch', 'definitely_not_sent', claim.operationId)
          finishClaudeRefreshNotSent(claim)
          const latest = observeAccount(expected)
          return latest.status !== 'ready' ? latest
            : { status: dispatchPersistencePending ? 'persistence_pending' : 'temporarily_unavailable', handle: latest.handle }
        }
        const failure = error as { code?: string; response?: { status?: number; data?: { error?: string } } }
        const httpStatus = failure.response?.status
        refreshDiagnostic(observed.handle, 'transport',
          Number.isInteger(httpStatus) && httpStatus! >= 100 && httpStatus! <= 599 ? `http_${httpStatus}` : 'response_unavailable',
          claim.operationId)
        ownsLock()
        if (!compromised && ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH'].includes(failure.code ?? '')) {
          refreshDiagnostic(observed.handle, 'transport', 'definitely_not_sent', claim.operationId)
          if (finishClaudeRefreshNotSent(claim).outcome !== 'committed') return { status: 'persistence_pending', handle: observed.handle }
          if (attempt === 0) continue
          return { status: 'temporarily_unavailable', handle: observed.handle }
        }
        if (!compromised && failure.response?.data?.error === 'invalid_grant') {
          const rejected = rejectClaudeCredential(observed.handle, claim.operationId, 'invalid_grant')
          if (rejected.outcome === 'persistence_pending') pendingRejections.set(options.refreshLockPath, claim)
          return rejected.outcome === 'persistence_pending'
            ? { status: 'persistence_pending', handle: observed.handle } : observeAccount(expected)
        }
        const uncertain = markClaudeRefreshUncertain(claim, compromised ? 'lock_ownership_lost' : 'response_unavailable')
        return uncertain.outcome === 'rejected' ? observeAccount(expected)
          : { status: 'refresh_uncertain', handle: observed.handle }
      }
    }
    return { status: 'temporarily_unavailable', handle: expected }
  } catch {
    refreshDiagnostic(expected, 'operation', dispatched ? 'interrupted_after_dispatch' : 'interrupted_before_dispatch', claim?.operationId)
    if (claim && dispatched) markClaudeRefreshUncertain(claim, 'refresh_interrupted')
    return { status: dispatched ? 'refresh_uncertain' : 'temporarily_unavailable', handle: expected }
  } finally {
    try { await release?.() } catch {
      refreshDiagnostic(expected, 'lock', 'cleanup_failed', claim?.operationId)
    }
  }
}

export type ClaudeRefreshWaitOptions = {
  signal?: AbortSignal
  waitTimeoutMs?: number
}

export type ClaudeRefreshWaiting = {
  status: 'waiting'
  reason: 'cancelled' | 'timeout'
}

/** Bound one caller's wait without aborting the shared credential operation. */
export function waitForClaudeRefreshPreparation<T>(
  shared: Promise<T>,
  { signal, waitTimeoutMs = 10_000 }: ClaudeRefreshWaitOptions = {},
): Promise<T | ClaudeRefreshWaiting> {
  if (!Number.isFinite(waitTimeoutMs) || waitTimeoutMs < 0 || waitTimeoutMs > 2_147_483_647) {
    throw new RangeError('Claude refresh wait timeout must be a finite non-negative timer duration')
  }
  return new Promise((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer)
      signal?.removeEventListener('abort', cancelled)
    }
    const finish = (value: T | ClaudeRefreshWaiting) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(value)
    }
    const cancelled = () => finish({ status: 'waiting', reason: 'cancelled' })
    // Always observe shared rejection, including for already-cancelled callers.
    shared.then(finish, error => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    })
    if (signal?.aborted) {
      cancelled()
      return
    }
    signal?.addEventListener('abort', cancelled, { once: true })
    timer = setTimeout(() => finish({ status: 'waiting', reason: 'timeout' }), waitTimeoutMs)
  })
}
