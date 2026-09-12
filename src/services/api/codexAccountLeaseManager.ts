import { AsyncLocalStorage } from 'node:async_hooks'

import { logForDebugging } from '../../utils/debug.js'
import { getInitialSettings } from '../../utils/settings/settings.js'
import {
  getCodexAccountAvailability,
  getPoolAccountUsageScore,
  getPoolAccountsForLeaseSelection,
  getPoolStatus,
  hasFreshPoolAccountUsageHint,
  isCodexAccountSwitchable,
  markPoolAccountCapped,
  markPoolAccountLastError,
  setActiveAccountPersisted,
  touchPoolAccountUsage,
  type PoolAccount,
} from './codexAccountPool.js'
import { emitAccountDiagnostic } from './accountDiagnostics.js'

export type CodexLeaseStrategy = 'spread' | 'follow-main'
export type CodexLeaseOwnerType = 'main' | 'subagent'
export type CodexLeaseState = 'active' | 'released' | 'failed'

/**
 * WHY a lease sits on the account it does, as a value rather than as prose.
 * `selectionReason` stays the human/log string, but it is not parseable: it
 * interpolates account ids and is free to be reworded. Consumers that need to
 * BRANCH on the cause read this instead.
 */
export type CodexLeaseSelectionKind =
  | 'initial'
  | 'failover'
  | 'repaired'
  | 'manual'
  /**
   * Nothing leased this account. The row is `synthesizeMainLease` reporting the
   * pool's ACTIVE account when the main thread holds no Codex lease of its own,
   * which is every session whose main thread runs on Anthropic (`query.ts:324`
   * registers one only under `getAPIProvider() === 'openai'`). Its timestamps are
   * minted fresh on each snapshot, so they measure nothing.
   */
  | 'synthetic'

export type CodexLease = {
  leaseId: string
  ownerId: string
  ownerType: CodexLeaseOwnerType
  ownerLabel: string
  accountId: string
  strategy: CodexLeaseStrategy
  state: CodexLeaseState
  createdAt: number
  updatedAt: number
  failoverCount: number
  selectionKind: CodexLeaseSelectionKind
  /**
   * The account this lease sat on before it moved, when it moved. Kept as an id
   * because `selectionReason` only ever had it interpolated into a sentence, which
   * left every consumer either parsing prose or unable to name the account at all.
   */
  previousAccountId?: string
  selectionReason: string
  lastFailureReason?: string
}

export type CodexLeaseSnapshot = {
  mainLease: CodexLease | null
  strategy: CodexLeaseStrategy
  accounts: Array<{
    accountId: string
    leaseCount: number
    holders: string[]
  }>
}

type CodexLeaseFailoverOptions = {
  markAccountCapped?: boolean
}

const codexLeasesByOwnerId = new Map<string, CodexLease>()
const NO_HEALTHY_ACCOUNTS_ERROR = 'All Codex accounts are capped or unavailable'
const codexLeaseOwnerContext = new AsyncLocalStorage<string | undefined>()

type CodexLeaseChangeListener = () => void

const codexLeaseChangeListeners = new Set<CodexLeaseChangeListener>()

/**
 * Observe lease movement. The lease map is a module singleton that mutates on
 * the request path (failover, reassignment after a manual switch, repair after
 * an account deletion), and until this existed no consumer could learn that a
 * lease had moved without polling `getCodexLeaseSnapshot`.
 *
 * The listener receives no payload on purpose: it is a "something changed"
 * edge, and the current state is always `getCodexLeaseSnapshot()`. It runs
 * synchronously inside the mutation, so keep it cheap. A listener that throws
 * is logged and skipped: notification must never break the request path, and in
 * particular must never swallow a failover's original error.
 *
 * Returns an idempotent unsubscribe.
 */
export function subscribeToCodexLeaseChanges(listener: () => void): () => void {
  codexLeaseChangeListeners.add(listener)
  let unsubscribed = false
  return () => {
    if (unsubscribed) return
    unsubscribed = true
    codexLeaseChangeListeners.delete(listener)
  }
}

function notifyCodexLeaseChange(): void {
  for (const listener of codexLeaseChangeListeners) {
    try {
      listener()
    } catch (error) {
      logForDebugging(
        `[codex-pool] Codex lease change listener threw: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
}

export function getCodexLeaseExhaustedMessage(): string {
  return NO_HEALTHY_ACCOUNTS_ERROR
}

export function resetCodexLeaseManagerForTest(): void {
  codexLeasesByOwnerId.clear()
  codexLeaseChangeListeners.clear()
}

export function seedCodexLeaseForTest({
  ownerId,
  ownerType,
  ownerLabel,
  accountId,
  strategy = 'spread',
  state = 'active',
  selectionReason = 'seeded lease',
  selectionKind = 'initial',
  failoverCount = 0,
}: {
  ownerId: string
  ownerType: CodexLeaseOwnerType
  ownerLabel: string
  accountId: string
  strategy?: CodexLeaseStrategy
  state?: CodexLeaseState
  selectionReason?: string
  selectionKind?: CodexLeaseSelectionKind
  failoverCount?: number
}): CodexLease {
  const now = Date.now()
  const lease: CodexLease = {
    leaseId: ownerId,
    ownerId,
    ownerType,
    ownerLabel,
    accountId,
    strategy,
    state,
    createdAt: now,
    updatedAt: now,
    failoverCount,
    selectionKind,
    selectionReason,
  }

  codexLeasesByOwnerId.set(ownerId, lease)
  return lease
}

export function createCodexLeaseForTest({
  ownerId,
  ownerType,
  ownerLabel,
  strategy = 'spread',
}: {
  ownerId: string
  ownerType: CodexLeaseOwnerType
  ownerLabel: string
  strategy?: CodexLeaseStrategy
}): CodexLease {
  return registerCodexLease({
    ownerId,
    ownerType,
    ownerLabel,
    strategy,
  })
}

export function registerCodexLease({
  ownerId,
  ownerType,
  ownerLabel,
  strategy,
}: {
  ownerId: string
  ownerType: CodexLeaseOwnerType
  ownerLabel: string
  strategy?: CodexLeaseStrategy
}): CodexLease {
  const existingLease = codexLeasesByOwnerId.get(ownerId)
  if (existingLease) {
    return existingLease
  }

  const resolvedStrategy = strategy ?? resolveDefaultLeaseStrategy(ownerType)
  const selection =
    ownerType === 'main'
      ? selectMainAccountForLease()
      : selectAccountForLease(resolvedStrategy)
  const now = Date.now()
  const lease: CodexLease = {
    leaseId: ownerId,
    ownerId,
    ownerType,
    ownerLabel,
    accountId: selection.account.accountId,
    strategy: resolvedStrategy,
    state: 'active',
    createdAt: now,
    updatedAt: now,
    failoverCount: 0,
    selectionKind: 'initial',
    selectionReason: selection.reason,
  }

  codexLeasesByOwnerId.set(ownerId, lease)
  touchPoolAccountUsage(selection.account.accountId)
  notifyCodexLeaseChange()
  return lease
}

export function getCodexLeaseSnapshot(): CodexLeaseSnapshot {
  const pool = getPoolStatus()
  const activeLeases = Array.from(codexLeasesByOwnerId.values()).filter(
    (lease) => lease.state === 'active',
  )
  const mainLease =
    activeLeases.find((lease) => lease.ownerType === 'main') ??
    synthesizeMainLease(pool)

  return {
    mainLease,
    strategy: resolveDefaultLeaseStrategy('subagent'),
    accounts: pool.accounts.map((account) => {
      const holders = activeLeases
        .filter((lease) => lease.accountId === account.accountId)
        .map((lease) => lease.ownerLabel)
      return {
        accountId: account.accountId,
        leaseCount: holders.length,
        holders,
      }
    }),
  }
}

export function getCodexLeaseSnapshotForTest(): { leases: CodexLease[] } {
  return {
    leases: Array.from(codexLeasesByOwnerId.values()),
  }
}

export function getCodexLeaseForOwner(ownerId: string): CodexLease | undefined {
  return codexLeasesByOwnerId.get(ownerId)
}

export function getCurrentCodexLease(): CodexLease | undefined {
  const ownerId = codexLeaseOwnerContext.getStore()
  return ownerId ? codexLeasesByOwnerId.get(ownerId) : undefined
}

/**
 * The account an owner is leasing, as a value that outlives the lease.
 *
 * Exists because `releaseCodexLease` DELETES the map entry, so any consumer that
 * reads the lease plane after a worker's terminal gets nothing. Callers that
 * need to REPORT which account a run used must take this snapshot while the
 * lease is still alive and carry it themselves.
 *
 * `accountAlias` is the pool's redacted display alias, never an email and never
 * a token; it is null for an account the pool cannot name. The pair matches what
 * the desktop lease seam already projects (`app/sidecar/leaseDomain.ts`).
 */
export type CodexLeaseAccount = {
  accountId: string
  accountAlias: string | null
}

export function snapshotLeaseAccount(
  ownerId: string,
): CodexLeaseAccount | undefined {
  const lease = codexLeasesByOwnerId.get(ownerId)
  if (!lease) return undefined
  const account = getPoolStatus().accounts.find(
    poolAccount => poolAccount.accountId === lease.accountId,
  )
  return { accountId: lease.accountId, accountAlias: account?.alias ?? null }
}

export function repairCodexLeaseIfNonSelectable(
  ownerId: string,
): CodexLease | undefined {
  const existingLease = codexLeasesByOwnerId.get(ownerId)
  if (!existingLease) return undefined

  const pool = getPoolStatus()
  const account = pool.accounts.find(
    candidate => candidate.accountId === existingLease.accountId,
  )
  if (
    existingLease.state === 'active' &&
    account &&
    isCodexAccountSwitchable(account)
  ) {
    return existingLease
  }

  const selection =
    existingLease.ownerType === 'main'
      ? selectMainAccountForLease()
      : selectAccountForLease(existingLease.strategy, existingLease.accountId)
  const repairedLease: CodexLease = {
    ...existingLease,
    accountId: selection.account.accountId,
    state: 'active',
    selectionKind: 'repaired',
    previousAccountId: existingLease.accountId,
    selectionReason: `repaired from non-selectable account ${existingLease.accountId}: ${selection.reason}`,
    updatedAt: Date.now(),
  }

  codexLeasesByOwnerId.set(ownerId, repairedLease)
  touchPoolAccountUsage(selection.account.accountId)
  if (repairedLease.ownerType === 'main') {
    setActiveAccountPersisted(repairedLease.accountId)
  }
  notifyCodexLeaseChange()
  return repairedLease
}

export function runWithCodexLeaseOwner<T>(
  ownerId: string | undefined,
  callback: () => T,
): T {
  return codexLeaseOwnerContext.run(ownerId, callback)
}

/**
 * Reassign an existing lease to the pool's currently active account. Used by
 * manual `/switch-account`: the pool activeIndex has already been updated, and
 * any existing lease (notably the main-thread lease) must be pointed at the
 * new account or else status-line display and API routing stay on the old one.
 * No-op if the lease doesn't exist or the pool has no active account.
 */
export function reassignCodexLeaseToActiveAccount(ownerId: string): void {
  if (applyReassignToActiveAccount(ownerId)) {
    notifyCodexLeaseChange()
  }
}

/** Returns true when the lease map actually changed. */
function applyReassignToActiveAccount(ownerId: string): boolean {
  const existing = codexLeasesByOwnerId.get(ownerId)
  if (!existing) return false
  const pool = getPoolStatus()
  if (pool.activeIndex < 0) return false
  const account = pool.accounts[pool.activeIndex]
  if (!account) return false
  if (existing.accountId === account.accountId && existing.state === 'active') {
    return false
  }
  codexLeasesByOwnerId.set(ownerId, {
    ...existing,
    accountId: account.accountId,
    state: 'active',
    selectionKind: 'manual',
    previousAccountId: existing.accountId,
    selectionReason: 'manual /switch-account',
    updatedAt: Date.now(),
  })
  touchPoolAccountUsage(account.accountId)
  return true
}

export function reassignCodexLeasesToActiveAccount(): void {
  const pool = getPoolStatus()
  if (pool.activeIndex < 0) return
  const account = pool.accounts[pool.activeIndex]
  if (!account) return

  // One batch notification for the whole reassignment: per-owner notification
  // would fire once per follow-main subagent for a single user-visible switch.
  let changed = applyReassignToActiveAccount('main-thread')
  for (const lease of codexLeasesByOwnerId.values()) {
    if (
      lease.ownerType !== 'subagent' ||
      lease.strategy !== 'follow-main' ||
      lease.state !== 'active'
    ) {
      continue
    }
    changed = applyReassignToActiveAccount(lease.ownerId) || changed
  }
  if (changed) {
    notifyCodexLeaseChange()
  }
}

export function releaseCodexLease(ownerId: string): void {
  if (codexLeasesByOwnerId.delete(ownerId)) {
    notifyCodexLeaseChange()
  }
}

export function failoverCodexLease(
  ownerId: string,
  failedAccountId: string,
  reason: string,
  options: CodexLeaseFailoverOptions = {},
): CodexLease {
  const existingLease = codexLeasesByOwnerId.get(ownerId)
  if (!existingLease) {
    throw new Error(`No Codex lease found for owner ${ownerId}`)
  }

  if (existingLease.accountId !== failedAccountId) {
    throw new Error(
      `Codex lease for owner ${ownerId} is on account ${existingLease.accountId}, not ${failedAccountId}`,
    )
  }

  const markAccountCapped = options.markAccountCapped ?? true
  markPoolAccountLastError(existingLease.accountId)
  if (markAccountCapped) {
    markPoolAccountCapped(existingLease.accountId, reason, {
      rerollActive: false,
    })
  }

  try {
    const selection = selectAccountForLease(
      existingLease.strategy,
      markAccountCapped ? undefined : failedAccountId,
    )
    const replacementLease: CodexLease = {
      ...existingLease,
      accountId: selection.account.accountId,
      state: 'active',
      failoverCount: existingLease.failoverCount + 1,
      selectionKind: 'failover',
      previousAccountId: failedAccountId,
      selectionReason: `failover from ${failedAccountId}: ${reason}`,
      lastFailureReason: reason,
      updatedAt: Date.now(),
    }

    codexLeasesByOwnerId.set(ownerId, replacementLease)
    touchPoolAccountUsage(selection.account.accountId)
    notifyCodexLeaseChange()
    emitAccountDiagnostic({
      code: 'account.lease.failover',
      severity: 'info',
      provider: 'openai',
      recoverable: true,
      pool: 'codex',
      from_account_ref: failedAccountId,
      account_ref: selection.account.accountId,
      reason,
    })
    return replacementLease
  } catch (error) {
    if (!markAccountCapped) {
      throw error
    }

    const failedLease: CodexLease = {
      ...existingLease,
      state: 'failed',
      failoverCount: existingLease.failoverCount + 1,
      lastFailureReason: reason,
      updatedAt: Date.now(),
    }

    codexLeasesByOwnerId.set(ownerId, failedLease)
    // Guarded per listener, so a throwing subscriber cannot replace the
    // original failover error with its own.
    notifyCodexLeaseChange()
    throw error
  }
}

/**
 * Re-resolve or release every lease that was pointing at an unavailable
 * account. Each affected lease tries to acquire a fresh account using its
 * own strategy; leases that cannot find a healthy alternative are dropped.
 */
export function repairLeasesForUnavailableAccount(
  unavailableAccountId: string,
): void {
  const affected = Array.from(codexLeasesByOwnerId.values()).filter(
    (lease) => lease.accountId === unavailableAccountId,
  ).sort((left, right) => leaseRepairRank(left) - leaseRepairRank(right))

  let changed = false
  for (const lease of affected) {
    try {
      const selection =
        lease.ownerType === 'main'
          ? selectMainAccountForLease()
          : selectAccountForLease(lease.strategy)
      const now = Date.now()
      codexLeasesByOwnerId.set(lease.ownerId, {
        ...lease,
        accountId: selection.account.accountId,
        state: 'active',
        selectionKind: 'repaired',
        previousAccountId: unavailableAccountId,
        selectionReason: `repaired from unavailable account ${unavailableAccountId}`,
        updatedAt: now,
      })
      touchPoolAccountUsage(selection.account.accountId)
      changed = true
    } catch (error) {
      changed = codexLeasesByOwnerId.delete(lease.ownerId) || changed
      logForDebugging(
        `[codex-pool] Dropping lease ${lease.ownerId} after account ${unavailableAccountId} became unavailable: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  // One notification for the whole repair sweep.
  if (changed) {
    notifyCodexLeaseChange()
  }
}

export function repairLeasesForDeletedAccount(deletedAccountId: string): void {
  repairLeasesForUnavailableAccount(deletedAccountId)
}

function leaseRepairRank(lease: CodexLease): number {
  if (lease.ownerType === 'main') {
    return 0
  }
  if (lease.strategy === 'follow-main') {
    return 1
  }
  return 2
}

function synthesizeMainLease(
  pool: ReturnType<typeof getPoolStatus>,
): CodexLease | null {
  if (!pool.initialized || pool.activeIndex < 0) {
    return null
  }

  const account = pool.accounts[pool.activeIndex]
  if (!account) {
    return null
  }

  const now = Date.now()
  return {
    leaseId: `lease:main:${account.accountId}`,
    ownerId: 'main-thread',
    ownerType: 'main',
    ownerLabel: 'main thread',
    accountId: account.accountId,
    strategy: 'follow-main',
    state: 'active',
    createdAt: now,
    updatedAt: now,
    failoverCount: 0,
    selectionKind: 'synthetic',
    selectionReason: 'synthetic main lease from active pool account',
  }
}

function selectMainAccountForLease(): { account: PoolAccount; reason: string } {
  const pool = getPoolStatus()
  if (!pool.initialized || pool.accounts.length === 0) {
    throw new Error(NO_HEALTHY_ACCOUNTS_ERROR)
  }

  const active = pool.activeIndex >= 0 ? pool.accounts[pool.activeIndex] : undefined
  if (active && isCodexAccountSwitchable(active)) {
    // The user chose this account; a plan-metadata warning does not override that.
    return { account: active, reason: 'main lease pinned to pool activeIndex' }
  }

  const selectable = pool.accounts.filter((account) => isCodexAccountSwitchable(account))
  const replacement =
    selectable.find((account) => getCodexAccountAvailability(account).kind === 'available') ??
    selectable[0]
  if (!replacement) {
    throw new Error(NO_HEALTHY_ACCOUNTS_ERROR)
  }
  return { account: replacement, reason: 'main lease repaired from non-selectable active account' }
}

function selectAccountForLease(
  strategy: CodexLeaseStrategy,
  excludedAccountId?: string,
): { account: PoolAccount; reason: string } {
  const poolAccounts = getPoolAccountsForLeaseSelection()
  const healthyCandidates = poolAccounts.filter(
    (account) =>
      isCodexAccountSwitchable(account) && account.accountId !== excludedAccountId,
  )

  if (healthyCandidates.length === 0) {
    throw new Error(NO_HEALTHY_ACCOUNTS_ERROR)
  }

  const mainAccountId = resolveMainAccountId(poolAccounts)
  if (strategy === 'follow-main' && mainAccountId) {
    const mainAccount = healthyCandidates.find(
      (account) => account.accountId === mainAccountId,
    )
    if (mainAccount) {
      return {
        account: mainAccount,
        reason: 'follow-main selected main account',
      }
    }
  }

  const cleanCandidates = healthyCandidates.filter(
    (account) => getCodexAccountAvailability(account).kind === 'available',
  )
  const rankableCandidates = cleanCandidates.length > 0 ? cleanCandidates : healthyCandidates

  const liveLeaseCounts = getLiveLeaseCountsByAccountId()
  const now = Date.now()
  const errorCooldownMs =
    Number(process.env['CODEX_POOL_ERROR_COOLDOWN_MS'] ?? 60_000) || 60_000
  const hasFreshUsage = rankableCandidates.some((account) =>
    hasFreshPoolAccountUsageHint(account, now),
  )
  const rankedCandidates = [...rankableCandidates].sort((left, right) => {
    const liveLeaseDelta =
      (liveLeaseCounts.get(left.accountId) ?? 0) -
      (liveLeaseCounts.get(right.accountId) ?? 0)
    if (liveLeaseDelta !== 0) {
      return liveLeaseDelta
    }

    // Deprioritise accounts that errored recently (but don't exclude — last resort).
    const leftRecentError = left.lastErrorAt !== undefined && now - left.lastErrorAt < errorCooldownMs
    const rightRecentError = right.lastErrorAt !== undefined && now - right.lastErrorAt < errorCooldownMs
    const cooldownDelta = Number(leftRecentError) - Number(rightRecentError)
    if (cooldownDelta !== 0) {
      return cooldownDelta
    }

    if (strategy === 'spread') {
      const mainPenaltyDelta =
        Number(left.accountId === mainAccountId) -
        Number(right.accountId === mainAccountId)
      if (mainPenaltyDelta !== 0) {
        return mainPenaltyDelta
      }
    }

    if (hasFreshUsage) {
      const usageDelta =
        getPoolAccountUsageScore(left, now) -
        getPoolAccountUsageScore(right, now)
      if (usageDelta !== 0) {
        return usageDelta
      }
    }

    const lastUsedDelta = left.lastUsedAt - right.lastUsedAt
    if (lastUsedDelta !== 0) {
      return lastUsedDelta
    }

    return left.accountId.localeCompare(right.accountId)
  })

  return {
    account: rankedCandidates[0]!,
    reason:
      strategy === 'follow-main'
        ? 'follow-main selected best healthy account'
        : 'spread selected least crowded healthy account',
  }
}

function resolveMainAccountId(
  poolAccounts: readonly PoolAccount[],
): string | undefined {
  const mainLease = Array.from(codexLeasesByOwnerId.values()).find(
    (lease) => lease.ownerType === 'main' && lease.state === 'active',
  )
  if (mainLease) {
    return mainLease.accountId
  }

  const namedMainAccount = poolAccounts.find(
    (account) => account.alias?.toLowerCase() === 'main',
  )
  if (namedMainAccount) {
    return namedMainAccount.accountId
  }

  const { activeIndex } = getPoolStatus()
  return activeIndex >= 0 ? poolAccounts[activeIndex]?.accountId : undefined
}

function getLiveLeaseCountsByAccountId(): Map<string, number> {
  const liveLeaseCounts = new Map<string, number>()

  for (const lease of codexLeasesByOwnerId.values()) {
    if (lease.state !== 'active') {
      continue
    }

    liveLeaseCounts.set(
      lease.accountId,
      (liveLeaseCounts.get(lease.accountId) ?? 0) + 1,
    )
  }

  return liveLeaseCounts
}

function resolveDefaultLeaseStrategy(ownerType: CodexLeaseOwnerType): CodexLeaseStrategy {
  if (ownerType === 'main') {
    return 'follow-main'
  }

  return getInitialSettings().codexSubagentAccountStrategy ?? 'spread'
}
