/**
 * Proactive Codex usage checking via the ChatGPT wham/usage endpoint.
 *
 * Best-effort and unofficial — the hard source of truth remains 429 failover.
 * Used for display in /accounts and /usage, and as soft hints for pool scoring.
 */

import { logForDebugging } from '../../utils/debug.js'
import {
  getPoolStatus,
  updateAccountUsageHints,
  type PoolAccount,
} from './codexAccountPool.js'

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
  credits: {
    hasCredits: boolean
    unlimited: boolean
    balance: string
  }
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
  usage: AccountUsage | null
  error: string | null
}

export type FetchPoolUsageOptions = {
  forceRefresh?: boolean
  updateRoutingHints?: boolean
}

// ── Constants ──────────────────────────────────────────────────────────────

const WHAM_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'
const FETCH_TIMEOUT_MS = 10_000

// ── Cache ──────────────────────────────────────────────────────────────────

let cachedSnapshot: PoolUsageSnapshot | null = null
const CACHE_TTL_MS = 60_000 // 1 minute

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Fetch usage for a single account by its access token.
 * Returns null on any failure (network, auth, parse).
 */
export async function fetchAccountUsage(
  account: PoolAccount,
): Promise<AccountUsage | null> {
  const { usage } = await fetchAccountUsageResult(account)
  return usage
}

async function fetchAccountUsageResult(
  account: PoolAccount,
): Promise<{ error: string | null; usage: AccountUsage | null }> {
  const first = await fetchAccountUsageOnce(account.accessToken, account.accountId)
  return first.result
}

async function fetchAccountUsageOnce(
  accessToken: string,
  accountId: string,
): Promise<{
  status: number | null
  result: { error: string | null; usage: AccountUsage | null }
}> {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

    const response = await globalThis.fetch(WHAM_USAGE_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      signal: controller.signal,
    })
    clearTimeout(timeout)

    if (!response.ok) {
      const error = `HTTP ${response.status}`
      logForDebugging(
        `[codex-usage] HTTP ${response.status} for account ${accountId.slice(0, 12)}`,
      )
      return { status: response.status, result: { error, usage: null } }
    }

    const data = (await response.json()) as Record<string, unknown>
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
 * Caches for 1 minute to avoid hammering the endpoint.
 */
export async function fetchPoolUsage(
  forceRefreshOrOptions: boolean | FetchPoolUsageOptions = false,
): Promise<PoolUsageSnapshot> {
  const options =
    typeof forceRefreshOrOptions === 'boolean'
      ? { forceRefresh: forceRefreshOrOptions }
      : forceRefreshOrOptions
  const forceRefresh = options.forceRefresh === true
  if (!forceRefresh && cachedSnapshot && Date.now() - cachedSnapshot.fetchedAt < CACHE_TTL_MS) {
    return cachedSnapshot
  }

  const { accounts } = getPoolStatus()
  const results: AccountUsage[] = []
  const errors: Array<{ accountId: string; error: string }> = []

  const promises = accounts.map(async (acct) => {
    try {
      const { usage, error } = await fetchAccountUsageResult(acct)
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

  // Display calls are observational by default (DP2/DP4). Only explicit
  // background prefetch paths may update soft routing hints for scoring.
  if (options.updateRoutingHints === true && results.length > 0) {
    updateAccountUsageHints(
      results.map((r) => ({
        accountId: r.accountId,
        primaryPercent: r.primaryWindow.usedPercent,
        weeklyPercent: r.secondaryWindow.usedPercent,
      })),
    )
  }

  const snapshot: PoolUsageSnapshot = {
    accounts: results,
    fetchedAt: Date.now(),
    errors,
  }
  cachedSnapshot = snapshot
  return snapshot
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
  poolAccounts: readonly Pick<PoolAccount, 'accountId' | 'alias' | 'status'>[],
  snapshot: PoolUsageSnapshot | null,
  activeIndex = -1,
): PoolUsageDisplayAccount[] {
  const usageById = new Map(
    (snapshot?.accounts ?? []).map((usage) => [usage.accountId, usage] as const),
  )
  const errorById = new Map(
    (snapshot?.errors ?? []).map((entry) => [entry.accountId, entry.error] as const),
  )

  return poolAccounts.map((account, index) => ({
    accountId: account.accountId,
    alias: account.alias,
    isActive: index === activeIndex,
    status: account.status,
    usage: usageById.get(account.accountId) ?? null,
    error: errorById.get(account.accountId) ?? null,
  }))
}

export function sortPoolUsageDisplayAccounts(
  displayAccounts: readonly PoolUsageDisplayAccount[],
): PoolUsageDisplayAccount[] {
  const statusOrder: Record<PoolAccount['status'], number> = {
    healthy: 0,
    capped: 1,
    dead: 2,
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
  const displayAccounts = sortPoolUsageDisplayAccounts(
    buildPoolUsageDisplayAccounts(poolAccounts, snapshot, activeIndex),
  )

  if (displayAccounts.length === 0) {
    return 'No usage data available.'
  }

  const header = `            used                           resets`
  const lines: string[] = [header, '']

  for (const account of displayAccounts) {
    const label = account.alias ?? account.accountId.slice(0, 12)
    const activeDot = account.isActive ? '● ' : '  '
    const statusTag = account.usage
      ? account.usage.allowed && !account.usage.limitReached
        ? ''
        : '  [capped]'
      : account.status === 'dead'
        ? '  [dead]'
        : account.error
          ? '  [usage unavailable]'
          : ''

    lines.push(`${activeDot}${label}${statusTag}`)
    if (account.usage) {
      lines.push(usageRow('5h', account.usage.primaryWindow))
      lines.push(usageRow('7d', account.usage.secondaryWindow))
    } else {
      lines.push(usageUnavailableRow(account.error))
    }
    lines.push('')
  }

  // Pool summary
  const totalAllowed = displayAccounts.filter(
    (account) => account.usage?.allowed && !account.usage.limitReached,
  ).length
  const totalCapped = displayAccounts.filter(
    (account) => account.usage && (!account.usage.allowed || account.usage.limitReached),
  ).length
  const totalUnavailable = displayAccounts.filter((account) => !account.usage).length
  const noun = displayAccounts.length === 1 ? 'account' : 'accounts'
  let summary = `${displayAccounts.length} ${noun}, ${totalAllowed} available`
  if (totalCapped > 0) summary += `, ${totalCapped} capped`
  if (totalUnavailable > 0) summary += `, ${totalUnavailable} unavailable`
  lines.push(summary)

  return lines.join('\n')
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

/** Invalidate the usage cache (e.g., after account rotation). */
export function invalidateUsageCache(): void {
  cachedSnapshot = null
}

// ── Internals ──────────────────────────────────────────────────────────────

function parseUsageResponse(
  accountId: string,
  data: Record<string, unknown>,
): AccountUsage | null {
  const rateLimit = data.rate_limit as Record<string, unknown> | undefined
  if (!rateLimit) return null

  const primary = rateLimit.primary_window as Record<string, unknown> | undefined
  const secondary = rateLimit.secondary_window as Record<string, unknown> | undefined
  if (!primary || !secondary) return null

  const credits = data.credits as Record<string, unknown> | undefined

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
      usedPercent: Number(secondary.used_percent ?? 0),
      limitWindowSeconds: Number(secondary.limit_window_seconds ?? 0),
      resetAfterSeconds: Number(secondary.reset_after_seconds ?? 0),
      resetAt: Number(secondary.reset_at ?? 0),
    },
    credits: {
      hasCredits: Boolean(credits?.has_credits),
      unlimited: Boolean(credits?.unlimited),
      balance: String(credits?.balance ?? '0'),
    },
    fetchedAt: Date.now(),
  }
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
