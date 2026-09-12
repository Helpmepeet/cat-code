/**
 * Proactive Codex usage checking via the ChatGPT wham/usage endpoint.
 *
 * Best-effort and unofficial — the hard source of truth remains 429 failover.
 * Used for display in /accounts and /usage, and as soft hints for pool scoring.
 */

import { logForDebugging } from '../../utils/debug.js'
import {
  describeCodexAccountAvailability,
  getCodexAccountAvailability,
  getPoolStatus,
  updateAccountUsageHints,
  type PoolAccount,
} from './codexAccountPool.js'
import { getCodexLeaseSnapshot } from './codexAccountLeaseManager.js'
import {
  emitAccountDiagnostic,
  hasAccountDiagnosticSink,
} from './accountDiagnostics.js'
import {
  createCodexCredentialHandle,
  startCodexCredentialSend,
  type CodexCredentialHandle,
  type CodexCredentialUseOptions,
} from './codexCredentialUse.js'
import {
  getSharedUsageContext,
  getUsageInventoryKey,
  invalidateSharedUsageCache,
  readOrFetchSharedUsage,
  sameSharedUsageContext,
  SHARED_USAGE_TTL_MS,
  type SharedUsageContext,
} from './codexUsageSharedCache.js'

// ── Types ──────────────────────────────────────────────────────────────────

export interface UsageWindow {
  usedPercent: number
  limitWindowSeconds: number
  resetAfterSeconds: number
  resetAt: number
}

export interface AccountUsage {
  accountId: string       // vault/pool account ID
  userId: string          // OpenAI user ID
  email: string
  planType: string
  allowed: boolean
  limitReached: boolean
  primaryWindow: UsageWindow    // 5-hour window
  secondaryWindow: UsageWindow  // weekly window
  hasSecondaryWindow?: boolean  // false when the upstream omitted it (e.g. free plan); undefined treated as present
  credits: {
    hasCredits: boolean
    unlimited: boolean
    balance: string
  }
  resetCreditsAvailable?: number
  fetchedAt: number
}

export interface PoolUsageSnapshot {
  accounts: AccountUsage[]
  fetchedAt: number
  errors: Array<{ accountId: string; error: string }>
}

export interface PoolUsageDisplayAccount {
  accountId: string
  alias?: string
  isActive: boolean
  status: PoolAccount['status']
  statusReason?: PoolAccount['statusReason']
  lastError?: string
  switchable?: boolean
  availabilityReason?: string
  availabilityWarnings: string[]
  usage: AccountUsage | null
  error: string | null
}

export type FetchPoolUsageOptions = {
  forceRefresh?: boolean
  updateRoutingHints?: boolean
  credentialUse?: CodexCredentialUseOptions
}

export type ConsumeResetOutcome =
  | { kind: 'reset' | 'already_redeemed'; windowsReset: number }
  | { kind: 'nothing_to_reset' | 'no_credit' }
  | { kind: 'http_error'; status: number; bodySnippet: string }
  | { kind: 'invalid_response'; bodySnippet: string }
  | { kind: 'network_error'; error: string }

// ── Constants ──────────────────────────────────────────────────────────────

const WHAM_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'
const WHAM_RESET_CONSUME_URL =
  'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume'
const FETCH_TIMEOUT_MS = 10_000
// Fixed product threshold for the Open Design capacity-warning diagnostic.
const ACCOUNT_USAGE_WARNING_THRESHOLD_PERCENT = 80

// ── Cache ──────────────────────────────────────────────────────────────────

let cachedSnapshot: PoolUsageSnapshot | null = null
let inFlightPoolUsage: Promise<PoolUsageSnapshot> | null = null
let cachedContext: SharedUsageContext | null = null
let inFlightContext: SharedUsageContext | null = null
let cachedInventoryKey = ''
let inFlightInventoryKey = ''
let cachedObservationStartedAt = 0
// Bumped by every invalidation. A read carries the generation it was issued
// under, which is what makes "is this observation still about the current
// accounts?" answerable after the fact: clearing a cache cannot reach back into
// a request already on the wire, so the request has to check on the way out.
let usageCacheGeneration = 0
let scheduledPoolUsageRefresh: ReturnType<typeof setTimeout> | null = null
let lastScheduledRefreshAt = 0
const CACHE_TTL_MS = SHARED_USAGE_TTL_MS
const POST_TURN_USAGE_REFRESH_DELAY_MS = 1_000
// Floor on the post-turn poll. queryModel completes once per API request, not
// once per user-visible turn, so tool loops and subagents reach it repeatedly;
// without a floor the cost is (requests x pool accounts) GETs. Usage is coarse
// (percent buckets on a 5h window) and cannot meaningfully move inside this.
const POST_TURN_USAGE_REFRESH_MIN_INTERVAL_MS = 30_000
const warnedNearCapAccountIds = new Set<string>()

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Fetch usage for a single account credential snapshot.
 * Returns null on any failure (network, auth, parse).
 */
export async function fetchAccountUsage(
  account: PoolAccount,
  credentialUse: CodexCredentialUseOptions = {},
): Promise<AccountUsage | null> {
  const { usage } = await fetchAccountUsageResult(account, credentialUse)
  return usage
}

export async function consumeUsageLimitReset(
  account: CodexCredentialHandle,
  redeemRequestId: string,
  credentialUse: CodexCredentialUseOptions = {},
): Promise<ConsumeResetOutcome> {
  const accountPrefix =
    typeof account?.accountId === 'string'
      ? account.accountId.slice(0, 12)
      : 'unknown'
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

    // The deadline has to outlive the fetch: it resolves on headers, so a
    // response whose body never completes hangs forever if the timer is
    // cleared before the body is read.
    let response: Response
    let bodyText: string
    try {
      response = await startCodexCredentialSend(
        account,
        authorizedAccount =>
          globalThis.fetch(WHAM_RESET_CONSUME_URL, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${authorizedAccount.accessToken}`,
              Accept: 'application/json',
              'chatgpt-account-id': authorizedAccount.accountId,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ redeem_request_id: redeemRequestId }),
            signal: controller.signal,
          }),
        credentialUse,
      )
      bodyText = await response.text()
    } finally {
      clearTimeout(timeout)
    }

    const bodySnippet = snippetForDebugging(bodyText)
    if (!response.ok) {
      logForDebugging(
        `[codex-usage] Reset consume HTTP ${response.status} for account ${accountPrefix}: ${bodySnippet}`,
      )
      return { kind: 'http_error', status: response.status, bodySnippet }
    }

    let data: Record<string, unknown>
    try {
      data = JSON.parse(bodyText) as Record<string, unknown>
    } catch {
      logForDebugging(
        `[codex-usage] Reset consume invalid JSON for account ${accountPrefix}: ${bodySnippet}`,
      )
      return { kind: 'invalid_response', bodySnippet }
    }
    if (!isRecord(data)) {
      logForDebugging(
        `[codex-usage] Reset consume invalid response for account ${accountPrefix}: ${bodySnippet}`,
      )
      return { kind: 'invalid_response', bodySnippet }
    }

    const code = data.code
    if (
      code !== 'reset' &&
      code !== 'already_redeemed' &&
      code !== 'nothing_to_reset' &&
      code !== 'no_credit'
    ) {
      logForDebugging(
        `[codex-usage] Reset consume unknown code for account ${accountPrefix}: ${bodySnippet}`,
      )
      return { kind: 'invalid_response', bodySnippet }
    }

    const windowsReset = parseWindowsReset(data)
    if (windowsReset === null) {
      logForDebugging(
        `[codex-usage] Reset consume invalid windows_reset for account ${accountPrefix}: ${bodySnippet}`,
      )
      return { kind: 'invalid_response', bodySnippet }
    }

    if (code === 'reset' || code === 'already_redeemed') {
      return { kind: code, windowsReset }
    }

    logForDebugging(
      `[codex-usage] Reset consume returned ${code} for account ${accountPrefix}: ${bodySnippet}`,
    )
    return { kind: code }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    logForDebugging(
      `[codex-usage] Reset consume failed for ${accountPrefix}: ${error}`,
    )
    return { kind: 'network_error', error }
  }
}

async function fetchAccountUsageResult(
  account: PoolAccount,
  credentialUse: CodexCredentialUseOptions = {},
): Promise<{ error: string | null; usage: AccountUsage | null }> {
  try {
    const credential = createPoolAccountCredentialHandle(account)
    const first = await fetchAccountUsageOnce(credential, credentialUse)
    return first.result
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      usage: null,
    }
  }
}

async function fetchAccountUsageOnce(
  credential: CodexCredentialHandle,
  credentialUse: CodexCredentialUseOptions = {},
): Promise<{
  status: number | null
  result: { error: string | null; usage: AccountUsage | null }
}> {
  const accountId = credential.accountId
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

    // The deadline has to outlive the fetch: it resolves on headers, so a
    // response whose body never completes hangs forever if the timer is
    // cleared before the body is read.
    let response: Response
    let data: Record<string, unknown>
    try {
      response = await startCodexCredentialSend(
        credential,
        authorizedCredential =>
          globalThis.fetch(WHAM_USAGE_URL, {
            method: 'GET',
            headers: {
              Authorization: `Bearer ${authorizedCredential.accessToken}`,
              Accept: 'application/json',
              'chatgpt-account-id': authorizedCredential.accountId,
              originator: 'codex_cli_rs',
            },
            signal: controller.signal,
          }),
        credentialUse,
      )

      if (!response.ok) {
        const error = `HTTP ${response.status}`
        logForDebugging(
          `[codex-usage] HTTP ${response.status} for account ${accountId.slice(0, 12)}`,
        )
        return { status: response.status, result: { error, usage: null } }
      }

      data = (await response.json()) as Record<string, unknown>
    } finally {
      clearTimeout(timeout)
    }

    const usage = parseUsageResponse(accountId, data)
    if (!usage) {
      return { status: response.status, result: { error: 'Unexpected usage response', usage: null } }
    }
    return { status: response.status, result: { error: null, usage } }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    logForDebugging(
      `[codex-usage] Fetch failed for ${accountId.slice(0, 12)}: ${error}`,
    )
    return { status: null, result: { error, usage: null } }
  }
}

/**
 * Fetch usage for all pool accounts in parallel.
 * Returns a snapshot with results and any errors.
 *
 * Unforced reads share a private 1-minute observation across engine processes,
 * as well as the local cache/in-flight read. `forceRefresh` opts out of these, so
 * a caller that needs to observe state it just changed is never handed an
 * observation issued before that change. Explicit refreshes, redeemed resets,
 * and request-triggered polls therefore retain their own fresh network read.
 */
export async function fetchPoolUsage(
  forceRefreshOrOptions: boolean | FetchPoolUsageOptions = false,
): Promise<PoolUsageSnapshot> {
  const options =
    typeof forceRefreshOrOptions === 'boolean'
      ? { forceRefresh: forceRefreshOrOptions }
      : forceRefreshOrOptions
  const forceRefresh = options.forceRefresh === true
  const generation = usageCacheGeneration
  const inventoryKey = getUsageInventoryKey(getPoolStatus().accounts)
  const context = getSharedUsageContext(getPoolStatus().accounts, WHAM_USAGE_URL)
  const isCurrent = (): boolean =>
    generation === usageCacheGeneration &&
    inventoryKey === getUsageInventoryKey(getPoolStatus().accounts) &&
    sameSharedUsageContext(context, getSharedUsageContext(getPoolStatus().accounts, WHAM_USAGE_URL))

  if (!forceRefresh && cachedSnapshot && cachedInventoryKey === inventoryKey && sameSharedUsageContext(cachedContext, context) &&
    cachedSnapshot.fetchedAt <= Date.now() && Date.now() - cachedSnapshot.fetchedAt < CACHE_TTL_MS) {
    if (options.updateRoutingHints === true) {
      updateRoutingHintsFromUsage(cachedSnapshot.accounts)
    }
    emitCachedUsageWarningsForActiveSink()
    return cachedSnapshot
  }

  // Share an in-flight read only with a caller that did not demand a new one.
  // A read already on the wire was issued before this call, so it cannot answer
  // "what is true now?" for a caller that asked precisely because it just
  // changed something. Sharing it there is how forceRefresh silently returns
  // the observation it was passed to avoid.
  if (!forceRefresh && inFlightPoolUsage && inFlightInventoryKey === inventoryKey && sameSharedUsageContext(inFlightContext, context)) {
    const snapshot = await inFlightPoolUsage
    if (!isCurrent() || cachedSnapshot !== snapshot) {
      return snapshot
    }
    if (options.updateRoutingHints === true) {
      updateRoutingHintsFromUsage(snapshot.accounts)
    }
    emitUsageWarnings(snapshot.accounts)
    return snapshot
  }

  const fetchPromise = readOrFetchSharedUsage(
    context, forceRefresh, () => fetchUncachedPoolUsage(options), isCurrent,
  ).then(({ snapshot, startedAt }) => {
    // Disk invalidation and inventory/credential changes fence local hints too.
    // An older slow read may return to its original caller, but must not replace
    // a newer completed forced observation in this process.
    if (!isCurrent() || (cachedInventoryKey === inventoryKey && sameSharedUsageContext(cachedContext, context) && startedAt < cachedObservationStartedAt)) return snapshot
    emitUsageWarnings(snapshot.accounts)
    if (options.updateRoutingHints === true) updateRoutingHintsFromUsage(snapshot.accounts)
    cachedSnapshot = snapshot
    cachedContext = context
    cachedInventoryKey = inventoryKey
    cachedObservationStartedAt = startedAt
    return snapshot
  })
  inFlightPoolUsage = fetchPromise
  inFlightContext = context
  inFlightInventoryKey = inventoryKey
  try {
    return await fetchPromise
  } finally {
    if (inFlightPoolUsage === fetchPromise) {
      inFlightPoolUsage = null
      inFlightContext = null
      inFlightInventoryKey = ''
    }
  }
}

/**
 * Refresh usage after a completed Codex API request, without delaying its
 * response. The usage service can lag the completed response briefly, so
 * debounce the poll and give it a second to observe the new usage.
 *
 * Fires per request rather than per user-visible turn (every tool-loop
 * iteration and subagent request reaches it), so the poll is floored to one
 * refresh per POST_TURN_USAGE_REFRESH_MIN_INTERVAL_MS and the first request to
 * arm a poll wins: later ones inside the window ride it instead of pushing it
 * back. Re-arming instead would starve the poll entirely during a long tool
 * loop, which is the case this exists to cover.
 *
 * The trade is up to one interval of lag: a request completing just after a
 * poll fires is not observed until the next one. Acceptable because the hints
 * are advisory scoring inputs on a 5-hour window, and because one poll costs a
 * GET per pool account.
 */
export function schedulePoolUsageRefresh(
  credentialUse?: CodexCredentialUseOptions,
): void {
  if (scheduledPoolUsageRefresh !== null) {
    // A poll is already armed; the trailing one already covers this request.
    return
  }
  const sinceLast = Date.now() - lastScheduledRefreshAt
  const delay = Math.max(
    POST_TURN_USAGE_REFRESH_DELAY_MS,
    POST_TURN_USAGE_REFRESH_MIN_INTERVAL_MS - sinceLast,
  )
  scheduledPoolUsageRefresh = setTimeout(() => {
    scheduledPoolUsageRefresh = null
    lastScheduledRefreshAt = Date.now()
    // Invalidate here rather than at schedule time: doing it per request would
    // drop the cache on every tool-loop iteration and send unforced readers to
    // the network in between, which is the cost the floor above exists to stop.
    invalidateUsageCache()
    void fetchPoolUsage({
      forceRefresh: true,
      updateRoutingHints: true,
      credentialUse,
    }).catch(() => {})
  }, delay)
  // Never hold a process open for a best-effort background poll; the sibling
  // Codex timers (codexTokenRefresh.ts) do the same.
  if (
    scheduledPoolUsageRefresh &&
    typeof scheduledPoolUsageRefresh === 'object' &&
    'unref' in scheduledPoolUsageRefresh
  ) {
    scheduledPoolUsageRefresh.unref()
  }
}

async function fetchUncachedPoolUsage(
  options: FetchPoolUsageOptions,
): Promise<PoolUsageSnapshot> {
  const { accounts } = getPoolStatus()
  // Each request carries the account entry observed for this snapshot. Pool
  // updates replace entries when credentials change; copying the fields here
  // keeps an in-flight read from being relabelled by a later login.
  const accountSnapshot = accounts.map(account => ({ ...account }))
  const results: AccountUsage[] = []
  const errors: Array<{ accountId: string; error: string }> = []

  const promises = accountSnapshot.map(async (acct) => {
    try {
      const { usage, error } = await fetchAccountUsageResult(
        acct,
        options.credentialUse,
      )
      if (usage) {
        results.push(usage)
      } else {
        errors.push({ accountId: acct.accountId, error: error ?? 'Fetch returned null' })
      }
    } catch (err) {
      errors.push({
        accountId: acct.accountId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  })

  await Promise.all(promises)

  const snapshot: PoolUsageSnapshot = {
    accounts: results,
    fetchedAt: Date.now(),
    errors,
  }

  return snapshot
}

function createPoolAccountCredentialHandle(
  account: PoolAccount,
): CodexCredentialHandle {
  return createCodexCredentialHandle({
    accountId: account.accountId,
    accessToken: account.accessToken,
    refreshToken: account.refreshToken,
    expiresAt: account.expiresAt,
    credentialGeneration: account.credentialGeneration,
    credentialSource: account.source,
    credentialPath: account.vaultFilePath,
  })
}

export function emitCachedUsageWarningsForActiveSink(): void {
  if (!cachedSnapshot || cachedSnapshot.fetchedAt > Date.now() || Date.now() - cachedSnapshot.fetchedAt >= CACHE_TTL_MS ||
    cachedInventoryKey !== getUsageInventoryKey(getPoolStatus().accounts) ||
    !sameSharedUsageContext(cachedContext, getSharedUsageContext(getPoolStatus().accounts, WHAM_USAGE_URL))) {
    return
  }
  emitUsageWarnings(cachedSnapshot.accounts)
}

function updateRoutingHintsFromUsage(usages: readonly AccountUsage[]): void {
  if (usages.length === 0) {
    return
  }
  updateAccountUsageHints(
    usages.map((r) => ({
      accountId: r.accountId,
      primaryPercent: r.primaryWindow.usedPercent,
      weeklyPercent: r.secondaryWindow.usedPercent,
      allowed: r.allowed,
      limitReached: r.limitReached,
      // The 5h (primary) window is what trips the block, so gate the
      // already-reset escape on its reset, not max() across windows (the weekly
      // reset is days out and would keep a reset 5h account blocked).
      resetAt: r.primaryWindow.resetAt,
      weeklyResetAt: r.secondaryWindow.resetAt,
      fetchedAt: r.fetchedAt,
    })),
  )
}

/**
 * Score an account for pool selection — lower score = better candidate.
 * Weights the 5h window heavily (it's the one that causes 429s).
 */
export function scoreAccountUsage(usage: AccountUsage): number {
  if (!usage.allowed || usage.limitReached) return Infinity
  // Primary (5h) window is 3x more important than weekly
  return usage.primaryWindow.usedPercent * 3 + usage.secondaryWindow.usedPercent
}

export function buildPoolUsageDisplayAccounts(
  poolAccounts: readonly PoolAccount[],
  snapshot: PoolUsageSnapshot | null,
  activeAccount: number | string = -1,
): PoolUsageDisplayAccount[] {
  const usageById = new Map(
    (snapshot?.accounts ?? []).map((usage) => [usage.accountId, usage] as const),
  )
  const errorById = new Map(
    (snapshot?.errors ?? []).map((entry) => [entry.accountId, entry.error] as const),
  )

  const activeAccountId = typeof activeAccount === 'string'
    ? activeAccount
    : poolAccounts[activeAccount]?.accountId

  return poolAccounts.map((account) => {
    const availability = getCodexAccountAvailability(account)
    return {
      accountId: account.accountId,
      alias: account.alias,
      isActive: account.accountId === activeAccountId,
      status: account.status,
      statusReason: account.statusReason,
      lastError: account.lastError,
      switchable: availability.kind !== 'blocked',
      availabilityReason: availability.kind === 'blocked' ? availability.reason : undefined,
      availabilityWarnings:
        availability.kind === 'warned'
          ? availability.warnings.map((warning) => warning.message)
          : [],
      usage: usageById.get(account.accountId) ?? null,
      error: errorById.get(account.accountId) ?? null,
    }
  })
}

export function sortPoolUsageDisplayAccounts(
  displayAccounts: readonly PoolUsageDisplayAccount[],
): PoolUsageDisplayAccount[] {
  const statusOrder: Record<PoolAccount['status'], number> = {
    healthy: 0,
    capped: 1,
    quarantined: 2,
    dead: 3,
  }

  return [...displayAccounts].sort((a, b) => {
    const scoreA = a.usage ? scoreAccountUsage(a.usage) : Number.POSITIVE_INFINITY
    const scoreB = b.usage ? scoreAccountUsage(b.usage) : Number.POSITIVE_INFINITY
    if (scoreA !== scoreB) return scoreA - scoreB

    if (!!a.usage !== !!b.usage) {
      return a.usage ? -1 : 1
    }

    const statusDiff = statusOrder[a.status] - statusOrder[b.status]
    if (statusDiff !== 0) return statusDiff

    return (a.alias ?? a.accountId).localeCompare(b.alias ?? b.accountId)
  })
}

/**
 * Format a usage snapshot as a human-readable string for /accounts.
 *
 * Layout:
 *
 *             used                           resets
 * ● main
 *   5h          12%   ████░░░░░░░░░░░░░░░░    38m
 *   7d           5%   ░░░░░░░░░░░░░░░░░░░░    4d 3h
 */
export function formatPoolUsage(snapshot: PoolUsageSnapshot): string {
  const { accounts: poolAccounts, activeIndex } = getPoolStatus()
  const mainLeaseAccountId = getCodexLeaseSnapshot().mainLease?.accountId
  const displayAccounts = sortPoolUsageDisplayAccounts(
    buildPoolUsageDisplayAccounts(poolAccounts, snapshot, mainLeaseAccountId ?? activeIndex),
  )

  if (displayAccounts.length === 0) {
    return 'No usage data available.'
  }

  const header = `            used                           resets`
  const lines: string[] = [header, '']

  for (const account of displayAccounts) {
    const label = account.alias ?? account.accountId.slice(0, 12)
    const activeDot = account.isActive ? '● ' : '  '
    const statusTag = formatDisplayStatusTag(account)

    lines.push(`${activeDot}${label}${statusTag}`)
    if (account.availabilityReason) {
      lines.push(`  reason: ${account.availabilityReason}`)
    }
    for (const warning of account.availabilityWarnings) {
      lines.push(`  warning: ${warning}`)
    }
    if (account.usage && isFreePlan(account.usage.planType)) {
      // Free plans have no Codex quota at all; the backend returns a synthetic
      // "100% used, resets in ~28d" primary window. Rendering usage bars implies
      // a quota that is merely exhausted and will reset — both untrue. The
      // [free — no Codex access] tag already states the situation, so add only
      // the action.
      lines.push('  upgrade to a paid plan to use Codex')
    } else if (account.usage) {
      lines.push(usageRow('5h', account.usage.primaryWindow))
      // Free/odd-shaped plans omit the weekly window; don't render a fake
      // "7d 0% resets now" placeholder for it.
      if (account.usage.hasSecondaryWindow !== false) {
        lines.push(usageRow('7d', account.usage.secondaryWindow))
      }
    } else {
      lines.push(usageUnavailableRow(account.error))
    }
    lines.push('')
  }

  // Pool summary
  const totalRoutable = displayAccounts.filter((account) => account.switchable !== false).length
  const totalWithUsageData = displayAccounts.filter((account) => !!account.usage).length
  const totalLimitReached = displayAccounts.filter(
    (account) => describeCodexAccountAvailability(account).startsWith('Limit reached'),
  ).length
  const totalUnavailable = displayAccounts.filter((account) => !account.usage).length
  const noun = displayAccounts.length === 1 ? 'account' : 'accounts'
  let summary = `${displayAccounts.length} ${noun}, ${totalRoutable} routable`
  if (totalWithUsageData > 0) summary += `, ${totalWithUsageData} with usage data`
  if (totalLimitReached > 0) summary += `, ${totalLimitReached} Limit reached`
  if (totalUnavailable > 0) summary += `, ${totalUnavailable} usage unavailable`
  lines.push(summary)

  return lines.join('\n')
}

function formatDisplayStatusTag(account: PoolUsageDisplayAccount): string {
  if (account.usage && isFreePlan(account.usage.planType)) {
    // A free plan can't run Codex at all — "Limit reached" would imply an
    // exhausted quota that resets, which is wrong.
    return '  [free — no Codex access]'
  }

  return `  ${describeCodexAccountAvailability(account, { format: 'bracket' })}`
}

export function isFreePlan(planType: string): boolean {
  return planType.toLowerCase() === 'free'
}

function usageRow(label: string, window: UsageWindow): string {
  const pct = window.usedPercent
  const pctStr = String(pct).padStart(3)
  const bar = usageBar(pct)
  const reset = formatSeconds(window.resetAfterSeconds)
  return `  ${label}         ${pctStr}%   ${bar}    ${reset}`
}

function usageUnavailableRow(error: string | null): string {
  if (!error || error === 'Fetch returned null') {
    return '  usage      unavailable'
  }
  return `  usage      unavailable (${error})`
}

/**
 * Invalidate the usage cache (e.g., after account rotation).
 *
 * Also fences work already in progress: the generation bump makes any read
 * currently on the wire unusable for later callers and stops it writing its
 * result back on completion. Cancelling the pending timer alone is not enough,
 * because the timer clears its own handle before it starts fetching.
 */
export function invalidateUsageCache(): void {
  cachedSnapshot = null
  cachedContext = null
  cachedInventoryKey = ''
  cachedObservationStartedAt = 0
  usageCacheGeneration += 1
  inFlightPoolUsage = null
  inFlightContext = null
  inFlightInventoryKey = ''
  invalidateSharedUsageCache()
  if (scheduledPoolUsageRefresh !== null) {
    clearTimeout(scheduledPoolUsageRefresh)
    scheduledPoolUsageRefresh = null
  }
}

/**
 * Clear the post-turn poll's rate floor. Production code must not call this:
 * the floor deliberately survives invalidation, or the timer's own invalidate
 * would reset it every time and there would be no floor at all.
 */
export function resetPoolUsageSchedulerForTest(): void {
  invalidateUsageCache()
  lastScheduledRefreshAt = 0
}

// ── Internals ──────────────────────────────────────────────────────────────

function countPoolStatuses(
  accounts: readonly Pick<PoolAccount, 'status'>[],
): Record<string, number> {
  const counts: Record<string, number> = {
    total: accounts.length,
    healthy: 0,
    capped: 0,
    quarantined: 0,
    dead: 0,
    locked: 0,
  }
  for (const account of accounts) {
    counts[account.status] = (counts[account.status] ?? 0) + 1
  }
  return counts
}

function maxUsagePercent(usage: AccountUsage): number {
  return Math.max(
    usage.primaryWindow.usedPercent,
    usage.secondaryWindow.usedPercent,
  )
}

function emitUsageWarnings(usages: readonly AccountUsage[]): void {
  if (usages.length === 0 || !hasAccountDiagnosticSink()) {
    return
  }

  const poolStatus = getPoolStatus()
  const poolAccountsById = new Map(
    poolStatus.accounts.map((account, index) => [
      account.accountId,
      { account, index },
    ] as const),
  )
  const counts = countPoolStatuses(poolStatus.accounts)

  for (const usage of usages) {
    const poolEntry = poolAccountsById.get(usage.accountId)
    if (!poolEntry || poolEntry.account.status === 'capped') {
      continue
    }
    if (!usage.allowed || usage.limitReached) {
      continue
    }

    const usedPercent = maxUsagePercent(usage)
    if (
      usedPercent < ACCOUNT_USAGE_WARNING_THRESHOLD_PERCENT ||
      usedPercent >= 100 ||
      warnedNearCapAccountIds.has(usage.accountId)
    ) {
      continue
    }

    warnedNearCapAccountIds.add(usage.accountId)
    emitAccountDiagnostic({
      code: 'account.usage.warning',
      severity: 'warning',
      provider: 'openai',
      recoverable: true,
      account_ref: `codex#${poolEntry.index + 1}`,
      counts,
    })
  }
}

function parseUsageResponse(
  accountId: string,
  data: Record<string, unknown>,
): AccountUsage | null {
  const rateLimit = data.rate_limit as Record<string, unknown> | undefined
  if (!rateLimit) return null

  const primary = rateLimit.primary_window as Record<string, unknown> | undefined
  // Free/capped plans return a populated primary window but a null secondary
  // window. Require only the primary window so the allowed/limit_reached
  // signals on those accounts survive instead of collapsing to null.
  if (!primary) return null
  const secondary = rateLimit.secondary_window as Record<string, unknown> | undefined

  const credits = data.credits as Record<string, unknown> | undefined
  const resetCredits = data.rate_limit_reset_credits as Record<string, unknown> | undefined
  const resetCreditsAvailable =
    typeof resetCredits?.available_count === 'number' &&
    Number.isFinite(resetCredits.available_count)
      ? resetCredits.available_count
      : undefined

  return {
    accountId,
    userId: String(data.user_id ?? ''),
    email: String(data.email ?? ''),
    planType: String(data.plan_type ?? ''),
    allowed: Boolean(rateLimit.allowed),
    limitReached: Boolean(rateLimit.limit_reached),
    primaryWindow: {
      usedPercent: Number(primary.used_percent ?? 0),
      limitWindowSeconds: Number(primary.limit_window_seconds ?? 0),
      resetAfterSeconds: Number(primary.reset_after_seconds ?? 0),
      resetAt: Number(primary.reset_at ?? 0),
    },
    secondaryWindow: {
      usedPercent: Number(secondary?.used_percent ?? 0),
      limitWindowSeconds: Number(secondary?.limit_window_seconds ?? 0),
      resetAfterSeconds: Number(secondary?.reset_after_seconds ?? 0),
      resetAt: Number(secondary?.reset_at ?? 0),
    },
    hasSecondaryWindow: Boolean(secondary),
    credits: {
      hasCredits: Boolean(credits?.has_credits),
      unlimited: Boolean(credits?.unlimited),
      balance: String(credits?.balance ?? '0'),
    },
    resetCreditsAvailable,
    fetchedAt: Date.now(),
  }
}

function parseWindowsReset(data: Record<string, unknown>): number | null {
  if (!Object.prototype.hasOwnProperty.call(data, 'windows_reset')) {
    return 0
  }
  const windowsReset = data.windows_reset
  if (typeof windowsReset === 'number' && Number.isInteger(windowsReset)) {
    return windowsReset
  }
  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function snippetForDebugging(body: string): string {
  return body.slice(0, 500)
}

function usageBar(percent: number): string {
  const width = 20
  const filled = Math.round((percent / 100) * width)
  const empty = width - filled
  return `[${'█'.repeat(filled)}${'░'.repeat(empty)}]`
}

function formatSeconds(seconds: number): string {
  if (seconds <= 0) return 'now'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (h > 24) {
    const d = Math.floor(h / 24)
    const remainH = h % 24
    return `${d}d ${remainH}h`
  }
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}
