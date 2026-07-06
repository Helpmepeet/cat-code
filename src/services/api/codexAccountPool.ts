/**
 * Multi-account Codex credential pool.
 *
 * Reads accounts from two sources:
 *   1. codex-nootp vault (~/codex-vault or configured path)
 *   2. Single codexOAuth entry in ~/.claude.json (backward compat)
 *
 * Provides LRU-based account selection and instant failover on 429/cap errors.
 * A single initialized pool account is still the credential authority; failover
 * only becomes possible when there is another selectable account to rotate to.
 */

import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync, renameSync, unlinkSync } from 'fs'
import { join, basename } from 'path'
import { homedir } from 'os'
import { hostname } from 'os'

import {
  getIsNonInteractiveSession,
  regenerateSessionId,
  resetCostState,
} from '../../bootstrap/state.js'
import { logForDebugging } from '../../utils/debug.js'
import { clearCodexOAuthTokens, getCodexOAuthTokens, saveCodexOAuthTokens } from '../../utils/auth.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { resetUserCache } from '../../utils/user.js'
import { emitAccountDiagnostic } from './accountDiagnostics.js'

// ── Types ──────────────────────────────────────────────────────────────────

export interface PoolAccount {
  accountId: string
  accessToken: string
  refreshToken: string
  expiresAt: number
  source: 'vault' | 'config'
  status: 'healthy' | 'dead' | 'capped' | 'quarantined'
  statusReason?: PoolAccountStatusReason
  lastUsedAt: number
  lastError?: string
  lastRefreshIso?: string       // ISO timestamp from vault's last_refresh field
  vaultFilePath?: string        // absolute path to the vault JSON file (vault accounts only)
  alias?: string                // human-readable name, e.g. "main", "backup1"
  // Soft usage hints from wham/usage (best-effort, may be stale)
  usagePrimary?: number         // 5h window used_percent (0-100)
  usageWeekly?: number          // weekly window used_percent (0-100)
  usageAllowed?: boolean
  usageLimitReached?: boolean
  usageFetchedAt?: number       // when usage was last fetched
  usageResetAt?: number
  cappedAt?: number             // when a hard 429 capped this account; uncap only from usage data fetched after this
  redeemedAt?: number           // when applyRedeemedUsageReset last healed this account; lag guard in updateAccountUsageHints
  // Saved id_token plan metadata. May be stale — warning only, never a blocker.
  planType?: string
  planExpiresAt?: string        // raw ISO string from chatgpt_subscription_active_until
  lastErrorAt?: number          // epoch ms of most recent turn error (any kind)
}

interface PoolState {
  accounts: PoolAccount[]
  activeIndex: number
  initialized: boolean
}

export type CodexPlanMetadata = {
  planType?: string
  planExpiresAt?: string
}

export type PoolAccountResolutionMatchType = 'exact' | 'prefix'
export type PoolAccountStatusReason =
  | 'usage_cap'
  | 'auth_dead'
  | 'runtime_cap'
  | 'probe_pending_transport'
  | 'unknown'

export type MarkPoolAccountStatusOptions = {
  rerollActive?: boolean
  statusReason?: PoolAccountStatusReason
}

export type MarkPoolAccountCappedOptions = MarkPoolAccountStatusOptions & {
  resetAt?: number
}

// ── Constants ──────────────────────────────────────────────────────────────

const LOCK_STALE_MS = 2 * 60 * 60 * 1000 // 2 hours, matching codex-nootp
const DEFAULT_VAULT_PATH = join(homedir(), 'codex-vault')
const CODEX_NOOTP_CONFIG = join(homedir(), '.codex-nootp', 'config.toml')

// ── Singleton state ────────────────────────────────────────────────────────

const pool: PoolState = {
  accounts: [],
  activeIndex: -1,
  initialized: false,
}

// ── Public API ─────────────────────────────────────────────────────────────

function persistActiveCodexAccountId(accountId: string | undefined): void {
  saveGlobalConfig(current => {
    if (current.activeCodexAccountId === accountId) {
      return current
    }
    return {
      ...current,
      activeCodexAccountId: accountId,
    }
  })
}

function countPoolStatuses(): Record<string, number> {
  const counts: Record<string, number> = { total: pool.accounts.length }
  for (const account of pool.accounts) {
    counts[account.status] = (counts[account.status] ?? 0) + 1
  }
  return counts
}

function emitActiveRerollDiagnostic(
  fromAccountId: string | undefined,
  toAccountId: string | undefined,
  reason: string,
): void {
  if (!fromAccountId || !toAccountId || fromAccountId === toAccountId) {
    return
  }
  emitAccountDiagnostic({
    code: 'account.active.reroll',
    severity: 'warning',
    provider: 'openai',
    recoverable: true,
    pool: 'codex',
    from_account_ref: fromAccountId,
    account_ref: toAccountId,
    counts: countPoolStatuses(),
    reason,
  })
}

function emitUsageStatusDiagnostic(
  code: 'account.usage.cap' | 'account.usage.uncap',
  accountId: string,
  reason: string | undefined,
): void {
  emitAccountDiagnostic({
    code,
    severity: code === 'account.usage.cap' ? 'warning' : 'info',
    provider: 'openai',
    recoverable: true,
    pool: 'codex',
    account_ref: accountId,
    counts: countPoolStatuses(),
    reason,
  })
}

export function shouldRunStartupCodexTouchAll(): boolean {
  return !getIsNonInteractiveSession()
}

export function applyPostCodexAccountSwitchRefresh(): void {
  regenerateSessionId()
  resetUserCache()
  resetCostState()
}

/**
 * Initialize the account pool from vault + config sources.
 * Fire-and-forget — safe to call with `void initAccountPool()`.
 */
export async function initAccountPool(): Promise<void> {
  try {
    const vaultPath = readVaultPath()
    const vaultAccounts = vaultPath ? loadVaultAccounts(vaultPath) : []
    const configAccount = vaultAccounts.length === 0 ? loadConfigAccount() : null

    pool.accounts = mergePoolAccounts(vaultAccounts, configAccount)

    const savedActiveAccountId = getGlobalConfig().activeCodexAccountId
    if (savedActiveAccountId) {
      const idx = pool.accounts.findIndex(
        (a) => a.accountId === savedActiveAccountId && a.status === 'healthy',
      )
      pool.activeIndex = idx >= 0 ? idx : pool.accounts.findIndex((a) => a.status === 'healthy')
    } else {
      pool.activeIndex = pool.accounts.findIndex((a) => a.status === 'healthy')
    }

    pool.initialized = true

    const healthy = pool.accounts.filter((a) => a.status === 'healthy').length
    const dead = pool.accounts.filter((a) => a.status === 'dead').length
    logForDebugging(
      `[codex-pool] Loaded ${pool.accounts.length} accounts (${healthy} healthy, ${dead} dead)`,
    )

    // Start periodic token refresh if vault accounts exist, and eagerly
    // refresh now so wham/usage and Codex API calls don't hit a stale
    // access_token on tab startup. Vault locks in touchAll() serialize
    // concurrent refreshes across tabs.
    if (pool.accounts.some((a) => a.source === 'vault')) {
      const { startPeriodicRefresh, startQuarantineProbe, touchAll } = await import('./codexTokenRefresh.js')
      startPeriodicRefresh()
      startQuarantineProbe()
      if (shouldRunStartupCodexTouchAll()) {
        void touchAll().catch(() => {})
      }
    }

    // Fire-and-forget: fetch initial usage data for scoring and diagnostics.
    if (pool.accounts.length > 0) {
      import('./codexUsage.js').then(({ fetchPoolUsage }) => {
        void fetchPoolUsage({ updateRoutingHints: true })
      }).catch(() => {})
    }
  } catch (err) {
    logForDebugging(
      `[codex-pool] Init failed: ${err instanceof Error ? err.message : String(err)}`,
      { level: 'warn' },
    )
    pool.initialized = false
  }
}

/**
 * True when initialized pool inventory should be the credential authority.
 * A single account still matters here: pool/vault tokens may be fresher than
 * the legacy config mirror, and account health must block doomed requests.
 */
export function poolManagesCredentials(): boolean {
  return pool.initialized && pool.accounts.length >= 1
}

/** True when there are at least two currently selectable accounts to rotate between. */
export function canFailover(): boolean {
  return pool.initialized && pool.accounts.filter((account) => isCodexAccountSwitchable(account)).length >= 2
}

/**
 * Legacy failover predicate. Prefer poolManagesCredentials() for credential
 * routing/classification and canFailover() for rotation decisions.
 */
export function isPoolActive(): boolean {
  return canFailover()
}

/**
 * True when the pool is initialized and at least one account has a token,
 * regardless of health status. Used by hasCodexTokens() to avoid showing
 * "Not logged in" when accounts exist but are temporarily capped.
 */
export function hasAnyPoolAccount(): boolean {
  return pool.initialized && pool.accounts.some((a) => !!a.accessToken)
}

/** Returns the currently active account, or null if pool empty / all exhausted. */
export function getActiveAccount(): PoolAccount | null {
  if (!pool.initialized || pool.activeIndex < 0) return null
  const acct = pool.accounts[pool.activeIndex]
  if (!acct || !isCodexAccountSwitchable(acct)) {
    // Active account went bad — find another healthy one
    const fromAccountId = acct?.accountId
    const idx = findLRUHealthy(-1)
    if (idx < 0) return null
    pool.activeIndex = idx
    emitActiveRerollDiagnostic(
      fromAccountId,
      pool.accounts[idx]?.accountId,
      'getActiveAccount: active account was not healthy',
    )
    return pool.accounts[idx]!
  }
  return acct
}

export function setActiveAccount(accountId: string): PoolAccount | null {
  const nextIndex = pool.accounts.findIndex(
    (account) => account.accountId === accountId && isCodexAccountSwitchable(account),
  )
  if (nextIndex < 0) {
    return null
  }

  pool.activeIndex = nextIndex
  return pool.accounts[nextIndex]!
}

/**
 * Like setActiveAccount, but persists the active account id so the next
 * startup resumes on the same account. Use for intentional, durable
 * main-thread failover decisions; in-memory-only rotations should keep
 * using setActiveAccount.
 */
export function setActiveAccountPersisted(
  accountId: string,
): PoolAccount | null {
  const result = setActiveAccount(accountId)
  if (result) {
    persistActiveCodexAccountId(accountId)
  }
  return result
}

/** Add or update an account in the live pool (called by login flow). */
export function appendAccount(tokens: {
  accessToken: string
  refreshToken: string
  expiresAt: number
  accountId: string
  alias?: string
  idToken?: string
}, options?: {
  preserveCapped?: boolean
  writer?: string
  source?: PoolAccount['source']
  vaultFilePath?: string
  activate?: boolean
}): void {
  const existing = pool.accounts.findIndex(
    (a) => a.accountId === tokens.accountId,
  )
  if (existing >= 0) {
    // Update tokens. Login should reset status, but background token refresh
    // must not wipe a known capped state.
    const acct = pool.accounts[existing]!
    const previousStatus = acct.status
    const previousLastError = acct.lastError
    const preserveCapped = options?.preserveCapped === true && acct.status === 'capped'
    acct.accessToken = tokens.accessToken
    acct.refreshToken = tokens.refreshToken
    acct.expiresAt = tokens.expiresAt
    acct.status = preserveCapped ? 'capped' : 'healthy'
    acct.lastError = preserveCapped ? acct.lastError : undefined
    acct.statusReason = preserveCapped ? acct.statusReason : undefined
    acct.cappedAt = preserveCapped ? acct.cappedAt : undefined
    if (previousStatus === 'capped' && acct.status === 'healthy') {
      emitUsageStatusDiagnostic(
        'account.usage.uncap',
        acct.accountId,
        previousLastError
          ? `usage cap cleared: ${previousLastError}`
          : 'usage cap cleared',
      )
    }
    if (tokens.alias) acct.alias = tokens.alias
    if (options?.source) acct.source = options.source
    if (options?.vaultFilePath) acct.vaultFilePath = options.vaultFilePath
    if (tokens.idToken) {
      const planMetadata = getCodexPlanMetadataFromIdToken(tokens.idToken)
      acct.planType = planMetadata.planType
      acct.planExpiresAt = planMetadata.planExpiresAt
    }
    logForDebugging(
      `[codex-profile] profile-save writer=${options?.writer ?? 'appendAccount'} account=${tokens.accountId} action=updated-memory`,
    )
  } else {
    pool.accounts.push({
      accountId: tokens.accountId,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      source: options?.source ?? 'config',
      status: 'healthy',
      lastUsedAt: 0,
      alias: tokens.alias,
      vaultFilePath: options?.vaultFilePath,
      ...(tokens.idToken ? getCodexPlanMetadataFromIdToken(tokens.idToken) : {}),
    })
    logForDebugging(
      `[codex-profile] profile-save writer=${options?.writer ?? 'appendAccount'} account=${tokens.accountId} action=added-memory`,
    )
  }

  if (options?.activate) {
    // Force this account to be active regardless of current pool state
    const idx = pool.accounts.findIndex((a) => a.accountId === tokens.accountId)
    if (idx >= 0) pool.activeIndex = idx
  } else if (
    pool.activeIndex < 0 ||
    !pool.accounts[pool.activeIndex] ||
    !isCodexAccountSwitchable(pool.accounts[pool.activeIndex]!)
  ) {
    // Fall back: activate only if no healthy account is currently active
    const idx = pool.accounts.findIndex((a) => isCodexAccountSwitchable(a))
    if (idx >= 0) pool.activeIndex = idx
  }
  if (pool.activeIndex >= 0) {
    persistActiveCodexAccountId(pool.accounts[pool.activeIndex]?.accountId)
  }
  pool.initialized = true
}

/** Returns a snapshot of all pool accounts for the /accounts command. */
export function getPoolStatus(): {
  accounts: readonly PoolAccount[]
  activeIndex: number
  initialized: boolean
} {
  return {
    accounts: pool.accounts,
    activeIndex: pool.activeIndex,
    initialized: pool.initialized,
  }
}

export function getPoolAccountsForLeaseSelection(): readonly PoolAccount[] {
  return pool.accounts
}

export function markPoolAccountStatus(
  accountId: string,
  status: PoolAccount['status'],
  reason?: string,
  options: MarkPoolAccountStatusOptions = {},
): void {
  const acct = pool.accounts.find((account) => account.accountId === accountId)
  if (!acct) return

  const previousStatus = acct.status
  acct.status = status
  acct.lastError = reason
  acct.statusReason =
    status === 'healthy'
      ? undefined
      : options.statusReason ?? (status === 'dead' ? 'auth_dead' : acct.statusReason)
  if (status === 'healthy') acct.cappedAt = undefined

  if (previousStatus !== 'capped' && status === 'capped') {
    emitUsageStatusDiagnostic('account.usage.cap', accountId, reason)
  } else if (previousStatus === 'capped' && status === 'healthy') {
    emitUsageStatusDiagnostic('account.usage.uncap', accountId, reason ?? 'usage cap cleared')
  }

  if (
    options.rerollActive !== false &&
    pool.accounts[pool.activeIndex]?.accountId === accountId &&
    status !== 'healthy'
  ) {
    const fromAccountId = pool.accounts[pool.activeIndex]?.accountId
    pool.activeIndex = findLRUHealthy(-1)
    emitActiveRerollDiagnostic(
      fromAccountId,
      pool.accounts[pool.activeIndex]?.accountId,
      `markPoolAccountStatus: ${reason ?? status}`,
    )
  }
}

export function markPoolAccountCapped(
  accountId: string,
  reason: string,
  options: MarkPoolAccountCappedOptions = {},
): void {
  markPoolAccountStatus(accountId, 'capped', reason, {
    ...options,
    statusReason: options.statusReason ?? 'usage_cap',
  })

  const acct = pool.accounts.find((account) => account.accountId === accountId)
  if (!acct) return

  acct.usagePrimary = 100
  acct.usageAllowed = false
  acct.usageLimitReached = true
  if (options.resetAt !== undefined) {
    acct.usageResetAt = options.resetAt
  }
  acct.cappedAt = Date.now()
}

export function markPoolAccountLastError(accountId: string): void {
  const acct = pool.accounts.find((account) => account.accountId === accountId)
  if (!acct) return
  acct.lastErrorAt = Date.now()
}

export function touchPoolAccountUsage(accountId: string): void {
  const acct = pool.accounts.find((account) => account.accountId === accountId)
  if (!acct) return

  acct.lastUsedAt = Date.now()
}

/**
 * Resolve a Codex account by prefix. Exact alias/id match wins. Otherwise,
 * gather alias-prefix and id-prefix matches and return a unique/ambiguous/none
 * verdict. Pass `onlyHealthy: true` to filter out non-healthy accounts or
 * `onlySwitchable: true` to also exclude accounts blocked by fresh usage.
 */
export type CodexAccountResolution =
  | { kind: 'none' }
  | { kind: 'unique'; account: PoolAccount; matchType: PoolAccountResolutionMatchType }
  | { kind: 'ambiguous'; matches: PoolAccount[]; matchType: PoolAccountResolutionMatchType }

export function resolveCodexAccountByPrefix(
  prefix: string,
  options?: { onlyHealthy?: boolean; onlySwitchable?: boolean },
): CodexAccountResolution {
  const lower = prefix.toLowerCase()
  const onlyHealthy = options?.onlyHealthy === true
  const onlySwitchable = options?.onlySwitchable === true
  const pool_ = pool.accounts.filter(
    (a) =>
      onlySwitchable
        ? isCodexAccountSwitchable(a)
        : !onlyHealthy || a.status === 'healthy',
  )

  // Exact alias or accountId match wins
  const exact = pool_.filter(
    (a) => a.alias?.toLowerCase() === lower || a.accountId.toLowerCase() === lower,
  )
  if (exact.length === 1) {
    return { kind: 'unique', account: exact[0]!, matchType: 'exact' }
  }
  if (exact.length > 1) return { kind: 'ambiguous', matches: exact, matchType: 'exact' }

  // Otherwise gather alias-prefix and id-prefix matches (deduped)
  const seen = new Set<string>()
  const matches: PoolAccount[] = []
  for (const a of pool_) {
    if (a.alias && a.alias.toLowerCase().startsWith(lower)) {
      if (!seen.has(a.accountId)) {
        seen.add(a.accountId)
        matches.push(a)
      }
    }
  }
  for (const a of pool_) {
    if (a.accountId.toLowerCase().startsWith(lower)) {
      if (!seen.has(a.accountId)) {
        seen.add(a.accountId)
        matches.push(a)
      }
    }
  }

  if (matches.length === 0) return { kind: 'none' }
  if (matches.length === 1) {
    return { kind: 'unique', account: matches[0]!, matchType: 'prefix' }
  }
  return { kind: 'ambiguous', matches, matchType: 'prefix' }
}

/**
 * Manually switch to a specific account (by alias/ID prefix) or the next LRU
 * healthy one. Returns the new active account, or null if no match, ambiguous
 * match, or no healthy alternative. Callers that want to surface the candidate
 * list on ambiguity should call `resolveCodexAccountByPrefix` first.
 */
export function switchToAccount(idPrefix: string | null): PoolAccount | null {
  if (!pool.initialized || pool.accounts.length === 0) return null

  let targetIdx: number
  if (idPrefix) {
    const resolution = resolveCodexAccountByPrefix(idPrefix, { onlySwitchable: true })
    if (resolution.kind !== 'unique') return null
    targetIdx = pool.accounts.indexOf(resolution.account)
    if (targetIdx < 0) return null
  } else {
    if (pool.accounts.length <= 1) return null
    targetIdx = findLRUHealthy(pool.activeIndex)
    if (targetIdx < 0) return null
  }

  if (targetIdx === pool.activeIndex) {
    const current = pool.accounts[targetIdx]!
    logForDebugging(
      `[codex-profile] active-profile-change writer=switch-account account=${current.accountId} action=no-op`,
    )
    return current
  }

  const from = pool.accounts[pool.activeIndex]
  const to = pool.accounts[targetIdx]!
  logForDebugging(
    `[codex-profile] active-profile-change writer=switch-account before_account=${from?.accountId ?? '?'} before_alias=${from?.alias ?? 'none'} after_account=${to.accountId} after_alias=${to.alias ?? 'none'}`,
  )
  // Stamp the outgoing account so LRU doesn't immediately pick it again
  if (pool.accounts[pool.activeIndex]) {
    pool.accounts[pool.activeIndex]!.lastUsedAt = Date.now()
  }
  pool.activeIndex = targetIdx
  persistActiveCodexAccountId(pool.accounts[targetIdx]!.accountId)
  return to
}

/** Mark an account as dead with a reason. Used by token refresh on unrecoverable errors. */
export function markAccountDead(
  accountId: string,
  reason: string,
  options: MarkPoolAccountStatusOptions = {},
): void {
  const acct = pool.accounts.find((a) => a.accountId === accountId)
  if (!acct) return
  acct.status = 'dead'
  acct.lastError = reason
  acct.statusReason = options.statusReason ?? 'auth_dead'
  // If this was the active account, find another
  if (
    options.rerollActive !== false &&
    pool.accounts[pool.activeIndex]?.accountId === accountId
  ) {
    const next = findLRUHealthy(-1)
    pool.activeIndex = next
    persistActiveCodexAccountId(pool.accounts[next]?.accountId)
    emitActiveRerollDiagnostic(
      accountId,
      pool.accounts[next]?.accountId,
      `markAccountDead: ${reason}`,
    )
  }
  logForDebugging(
    `[codex-pool] Account ${truncId(accountId)} marked dead: ${reason}`,
  )
}

export function markPoolAccountQuarantined(
  accountId: string,
  reason: string,
  options: MarkPoolAccountStatusOptions = {},
): void {
  const acct = pool.accounts.find((a) => a.accountId === accountId)
  if (!acct) return
  acct.status = 'quarantined'
  acct.lastError = reason
  acct.statusReason = 'probe_pending_transport'

  if (
    options.rerollActive !== false &&
    pool.accounts[pool.activeIndex]?.accountId === accountId
  ) {
    const next = findLRUHealthy(-1)
    pool.activeIndex = next
    persistActiveCodexAccountId(pool.accounts[next]?.accountId)
    emitActiveRerollDiagnostic(
      accountId,
      pool.accounts[next]?.accountId,
      `markPoolAccountQuarantined: ${reason}`,
    )
  }

  emitAccountDiagnostic({
    code: 'account.transient_failure',
    severity: 'warning',
    provider: 'openai',
    recoverable: true,
    pool: 'codex',
    account_ref: accountId,
    counts: countPoolStatuses(),
    reason,
  })
  logForDebugging(
    `[codex-pool] Account ${truncId(accountId)} quarantined: ${reason}`,
    { level: 'warn' },
  )
}

// ── Vault reader ───────────────────────────────────────────────────────────

/** Returns the resolved vault path, or null if vault directory doesn't exist. */
export function getVaultPath(): string | null {
  return readVaultPath()
}

/**
 * Writes a Codex account to the vault as <accountId>.json.
 * Creates the vault directory structure if it doesn't exist.
 * Called after a successful /login so accounts persist across restarts.
 */
export function saveCodexTokenToVault(tokens: {
  accessToken: string
  refreshToken: string
  accountId: string
  alias?: string
  idToken?: string
  expiresAt?: number
}, options: {
  writer?: string
  expectedPreviousAccountId?: string
  filePath?: string
  preserveExistingMetadata?: boolean
} = {}): {
  filePath: string
  existed: boolean
  previousAccountId?: string
  metadataAction: 'created' | 'preserved' | 'replaced'
  accountChanged: boolean
} | null {
  try {
    const vaultPath = readVaultPath() ?? DEFAULT_VAULT_PATH
    const accountsDir = join(vaultPath, 'accounts')
    mkdirSync(accountsDir, { recursive: true })

    const filePath = options.filePath ?? join(accountsDir, `${tokens.accountId}.json`)
    const existed = existsSync(filePath)
    const existing = existed
      ? (JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>)
      : null
    const existingTokens = (existing?.tokens ?? null) as Record<string, unknown> | null
    const previousAccountId = typeof existingTokens?.account_id === 'string'
      ? existingTokens.account_id
      : undefined
    const accountChanged = previousAccountId != null && previousAccountId !== tokens.accountId
    const shouldPreserve = Boolean(
      existing &&
        options.preserveExistingMetadata !== false &&
        !accountChanged,
    )
    const data: Record<string, unknown> = shouldPreserve ? { ...existing! } : {}
    data.tokens = {
      ...(shouldPreserve ? existingTokens ?? {} : {}),
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      account_id: tokens.accountId,
      ...(tokens.idToken ? { id_token: tokens.idToken } : {}),
      ...(typeof tokens.expiresAt === 'number' && Number.isFinite(tokens.expiresAt)
        ? { expires_at: tokens.expiresAt }
        : {}),
    }
    data.last_refresh = new Date().toISOString()
    if (tokens.alias?.trim()) {
      data.alias = tokens.alias.trim()
    } else if (!shouldPreserve) {
      delete data.alias
    }

    const tmpPath = join(accountsDir, `.${Date.now()}.${process.pid}.tmp`)
    writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n', 'utf-8')
    renameSync(tmpPath, filePath)

    const metadataAction: 'created' | 'preserved' | 'replaced' = !existed
      ? 'created'
      : shouldPreserve
        ? 'preserved'
        : 'replaced'

    logForDebugging(
      `[codex-profile] profile-save writer=${options.writer ?? 'saveCodexTokenToVault'} account=${tokens.accountId} file=${basename(filePath)} existed=${existed} metadata=${metadataAction}${previousAccountId ? ` previous_account=${previousAccountId}` : ''} alias=${typeof data.alias === 'string' ? data.alias : 'none'}`,
      { level: accountChanged ? 'warn' : 'debug' },
    )

    return {
      filePath,
      existed,
      previousAccountId,
      metadataAction,
      accountChanged,
    }
  } catch (err) {
    logForDebugging(
      `[codex-profile] profile-save-failed writer=${options.writer ?? 'saveCodexTokenToVault'} account=${tokens.accountId} error=${err instanceof Error ? err.message : String(err)}`,
      { level: 'warn' },
    )
    return null
  }
}

/**
 * Update the alias for an existing vault account.
 * Reads the current vault JSON, sets/overwrites the alias field, writes back atomically.
 */
export function setAccountAlias(accountId: string, alias: string, writer = 'rename-account'): boolean {
  const acct = pool.accounts.find((a) => a.accountId === accountId)
  if (!acct?.vaultFilePath) return false

  try {
    const existing = JSON.parse(readFileSync(acct.vaultFilePath, 'utf-8')) as Record<string, unknown>
    existing.alias = alias
    // atomic write via temp+rename
    const dir = acct.vaultFilePath.split('/').slice(0, -1).join('/')
    const tmp = `${dir}/.${Date.now()}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(existing, null, 2) + '\n', 'utf-8')
    renameSync(tmp, acct.vaultFilePath)
    const oldAlias = acct.alias
    acct.alias = alias
    logForDebugging(
      `[codex-profile] profile-rename writer=${writer} account=${accountId} old_alias=${oldAlias ?? 'none'} new_alias=${alias} file=${basename(acct.vaultFilePath)}`,
    )
    return true
  } catch (err) {
    logForDebugging(
      `[codex-pool] Failed to set alias: ${err instanceof Error ? err.message : String(err)}`,
      { level: 'warn' },
    )
    return false
  }
}

export function removeCodexAccount(accountId: string): boolean {
  const idx = pool.accounts.findIndex((account) => account.accountId === accountId)
  if (idx < 0) return false

  const acct = pool.accounts[idx]!
  const previousActiveAccountId = pool.accounts[pool.activeIndex]?.accountId

  if (acct.vaultFilePath && existsSync(acct.vaultFilePath)) {
    try {
      unlinkSync(acct.vaultFilePath)
    } catch (err) {
      logForDebugging(
        `[codex-pool] Failed to delete vault file: ${err instanceof Error ? err.message : String(err)}`,
        { level: 'warn' },
      )
      return false
    }
  }

  pool.accounts.splice(idx, 1)

  if (pool.accounts.length === 0) {
    pool.activeIndex = -1
    clearCodexOAuthTokens()
    persistActiveCodexAccountId(undefined)
    logForDebugging(`[codex-pool] Removed final account ${truncId(accountId)}`)
    return true
  }

  if (idx === pool.activeIndex) {
    pool.activeIndex = findLRUHealthy(-1)
  } else if (idx < pool.activeIndex) {
    pool.activeIndex--
  }

  if (pool.activeIndex < 0 || !pool.accounts[pool.activeIndex]) {
    pool.activeIndex = findLRUHealthy(-1)
  }

  const active = pool.accounts[pool.activeIndex] ?? pool.accounts.find((account) => isCodexAccountSwitchable(account)) ?? pool.accounts[0]

  if (active) {
    saveCodexOAuthTokens({
      accessToken: active.accessToken,
      refreshToken: active.refreshToken,
      expiresAt: active.expiresAt,
      accountId: active.accountId,
    })
    persistActiveCodexAccountId(active.accountId)
    emitActiveRerollDiagnostic(
      previousActiveAccountId,
      active.accountId,
      `removeCodexAccount: removed ${accountId}`,
    )
  } else {
    clearCodexOAuthTokens()
    persistActiveCodexAccountId(undefined)
  }

  logForDebugging(`[codex-pool] Removed account ${truncId(accountId)}`)
  return true
}

const ALIAS_PATTERN = /^[a-zA-Z0-9_-]{1,32}$/

/**
 * Validate a proposed Codex account alias.
 * Returns ok:true for valid aliases, ok:false with a user-facing message otherwise.
 * Pass currentAccountId to skip the duplicate check for an account's own alias.
 */
export function validateCodexAccountAlias(
  alias: string,
  currentAccountId?: string,
): { ok: true } | { ok: false; message: string } {
  if (!ALIAS_PATTERN.test(alias)) {
    return {
      ok: false,
      message: `Invalid alias "${alias}". Use 1–32 letters, numbers, underscores, or hyphens (no spaces).`,
    }
  }
  const lower = alias.toLowerCase()
  const duplicate = pool.accounts.find(
    (a) => a.accountId !== currentAccountId && a.alias?.toLowerCase() === lower,
  )
  if (duplicate) {
    return { ok: false, message: `Alias "${alias}" is already in use by another account.` }
  }
  return { ok: true }
}

function readVaultPath(): string | null {
  try {
    if (!existsSync(CODEX_NOOTP_CONFIG)) return DEFAULT_VAULT_PATH
    const text = readFileSync(CODEX_NOOTP_CONFIG, 'utf-8')
    const match = text.match(/^\s*vault_path\s*=\s*"([^"]*)"/m)
    if (match?.[1]) {
      const raw = match[1]
      return raw.startsWith('~') ? raw.replace('~', homedir()) : raw
    }
    return DEFAULT_VAULT_PATH
  } catch {
    return DEFAULT_VAULT_PATH
  }
}

export function loadVaultAccountsForTest(vaultPath: string): PoolAccount[] {
  return loadVaultAccounts(vaultPath)
}

function loadVaultAccounts(vaultPath: string): PoolAccount[] {
  const accountsDir = join(vaultPath, 'accounts')
  const locksDir = join(vaultPath, 'locks')

  if (!existsSync(accountsDir)) {
    logForDebugging(`[codex-pool] Vault accounts dir not found: ${accountsDir}`)
    return []
  }

  const results: PoolAccount[] = []
  let files: string[]
  try {
    files = readdirSync(accountsDir).filter((f) => f.endsWith('.json'))
  } catch {
    return []
  }

  for (const file of files) {
    try {
      const raw = readFileSync(join(accountsDir, file), 'utf-8')
      const data = JSON.parse(raw) as Record<string, unknown>
      const tokens = data.tokens as
        | Record<string, unknown>
        | undefined

      if (!tokens?.access_token || !tokens.refresh_token || !tokens.account_id) {
        logForDebugging(
          `[codex-pool] Skipping ${file}: missing required token fields`,
        )
        continue
      }

      const accountId = String(tokens.account_id)
      const fileAccountId = file.replace(/\.json$/, '')
      if (fileAccountId !== accountId) {
        logForDebugging(
          `[codex-profile] profile-file-mismatch file=${file} filename_account=${fileAccountId} stored_account=${accountId} action=loaded-stored-account`,
          { level: 'warn' },
        )
      }

      // Check lock
      if (isAccountLocked(locksDir, accountId)) {
        logForDebugging(
          `[codex-pool] Skipping ${truncId(accountId)}: locked by another process`,
        )
        continue
      }

      // last_refresh is when we refreshed, not when the token expires.
      // Prefer the real `expires_at` written by the refresh path; fall back to
      // 0 (forces an immediate refresh) when absent.
      const lastRefresh = data.last_refresh as string | undefined
      const expiresAtRaw = tokens.expires_at
      const expiresAt =
        typeof expiresAtRaw === 'number' && Number.isFinite(expiresAtRaw)
          ? expiresAtRaw
          : 0
      const health = checkAccountHealth(lastRefresh)
      const refresh = data.refresh as Record<string, unknown> | undefined
      const refreshStatus = getVaultRefreshPoolStatus(refresh, health)
      const status = refreshStatus.status
      const planMetadata = getCodexPlanMetadataFromIdToken(
        typeof tokens.id_token === 'string' ? tokens.id_token : undefined,
      )

      results.push({
        accountId,
        accessToken: String(tokens.access_token),
        refreshToken: String(tokens.refresh_token),
        expiresAt,
        source: 'vault',
        status,
        lastUsedAt: 0,
        lastRefreshIso: lastRefresh,
        vaultFilePath: join(accountsDir, file),
        alias: typeof data.alias === 'string' && data.alias ? data.alias : undefined,
        planType: planMetadata.planType,
        planExpiresAt: planMetadata.planExpiresAt,
        ...(refreshStatus.lastError ? { lastError: refreshStatus.lastError } : {}),
        ...(refreshStatus.statusReason ? { statusReason: refreshStatus.statusReason } : {}),
      })
      logForDebugging(
        `[codex-profile] profile-load source=vault account=${accountId} alias=${typeof data.alias === 'string' && data.alias ? data.alias : 'none'} file=${file} status=${status} last_refresh=${lastRefresh ?? 'none'}`,
      )
    } catch (err) {
      logForDebugging(
        `[codex-pool] Failed to load vault account ${file}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
  return results
}

export function loadConfigAccount(): PoolAccount | null {
  const tokens = getCodexOAuthTokens()
  if (!tokens?.accessToken || !tokens.accountId) return null
  return {
    accountId: tokens.accountId,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
    source: 'config',
    status: 'healthy',
    lastUsedAt: 0,
  }
}

function mergePoolAccounts(
  vaultAccounts: PoolAccount[],
  configAccount: PoolAccount | null,
): PoolAccount[] {
  const byId = new Map<string, PoolAccount>()
  for (const acct of vaultAccounts) {
    byId.set(acct.accountId, acct)
  }

  if (configAccount) {
    if (byId.size === 0) {
      byId.set(configAccount.accountId, configAccount)
      logForDebugging(
        `[codex-profile] profile-merge account=${configAccount.accountId} vault=false config=true action=added-config-profile`,
      )
    } else {
      logForDebugging(
        `[codex-profile] profile-merge account=${configAccount.accountId} vault=true config=true action=ignored-config-mirror`,
      )
    }
  }

  return Array.from(byId.values())
}

export function mergePoolAccountsForTest(
  vaultAccounts: PoolAccount[],
  configAccount: PoolAccount | null,
): PoolAccount[] {
  return mergePoolAccounts(vaultAccounts, configAccount)
}

// ── Lock checking ──────────────────────────────────────────────────────────

export function isAccountLocked(locksDir: string, accountId: string): boolean {
  const lockFile = join(locksDir, `${accountId}.lock`)
  if (!existsSync(lockFile)) return false

  try {
    const raw = readFileSync(lockFile, 'utf-8')
    const lock = JSON.parse(raw) as Record<string, unknown>

    const machine = lock.machine as string | undefined
    const checkedOutAt = lock.checked_out_at as string | undefined
    const pid = lock.pid as number | undefined
    const heartbeatAt = lock.heartbeat_at as string | undefined

    // If it's our own machine and process, not locked for us
    if (machine === hostname() && pid === process.pid) return false

    // Check staleness
    const refTime = heartbeatAt || checkedOutAt
    if (!refTime) return false // malformed, treat as unlocked

    const refMs = new Date(refTime).getTime()
    if (Date.now() - refMs > LOCK_STALE_MS) {
      return false // stale lock, ignore
    }

    return true // fresh lock held by another process
  } catch {
    return false // malformed lock, treat as unlocked
  }
}

// ── Health check ───────────────────────────────────────────────────────────

/** Check vault account health based on last_refresh timestamp. */
function checkAccountHealth(lastRefresh: string | undefined): 'healthy' | 'dead' {
  if (!lastRefresh) return 'healthy' // no timestamp, assume OK
  const refreshMs = new Date(lastRefresh).getTime()
  const daysSinceRefresh = (Date.now() - refreshMs) / (1000 * 60 * 60 * 24)
  // Match codex-nootp's CRITICAL threshold of 7 days
  return daysSinceRefresh > 7 ? 'dead' : 'healthy'
}

function isStaleInFlightRefresh(refresh: Record<string, unknown> | undefined): boolean {
  if (!refresh) return false
  if (refresh.state === 'stale_in_flight') return true
  if (refresh.state !== 'in_flight') return false
  const startedAt = typeof refresh.started_at === 'string' ? Date.parse(refresh.started_at) : Number.NaN
  return Number.isFinite(startedAt) && Date.now() - startedAt > 60_000
}

function isHistoricalTransportReauth(reason: string | undefined): boolean {
  return reason === 'network_or_timeout' || reason === 'stale_in_flight'
}

function getVaultRefreshPoolStatus(
  refresh: Record<string, unknown> | undefined,
  health: 'healthy' | 'dead',
): {
  status: PoolAccount['status']
  statusReason?: PoolAccountStatusReason
  lastError?: string
} {
  if (health === 'dead') {
    return {
      status: 'dead',
      statusReason: 'auth_dead',
      lastError: 'Token expired (>7 days since last refresh)',
    }
  }

  const reason = typeof refresh?.reason === 'string' ? refresh.reason : undefined
  if (
    refresh?.state === 'unknown' ||
    isStaleInFlightRefresh(refresh) ||
    (refresh?.state === 'reauth_required' && isHistoricalTransportReauth(reason))
  ) {
    return {
      status: 'quarantined',
      statusReason: 'probe_pending_transport',
      lastError: normalizeCodexAccountBlockReason(reason) ?? reason ?? 'connection problem; retrying',
    }
  }

  if (refresh?.state === 'reauth_required') {
    return {
      status: 'dead',
      statusReason: 'auth_dead',
      lastError: normalizeCodexAccountBlockReason(reason) ?? reason ?? 'Reauthentication required',
    }
  }

  return { status: 'healthy' }
}

export function getCodexPlanMetadataFromIdToken(
  idToken: string | undefined,
): CodexPlanMetadata {
  if (!idToken) return {}
  try {
    const payload = JSON.parse(
      Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString('utf-8'),
    ) as Record<string, unknown>
    const auth = payload['https://api.openai.com/auth'] as Record<string, unknown> | undefined
    const planType = typeof auth?.chatgpt_plan_type === 'string'
      ? auth.chatgpt_plan_type.toLowerCase()
      : undefined
    const planExpiresAt = typeof auth?.chatgpt_subscription_active_until === 'string'
      ? auth.chatgpt_subscription_active_until
      : undefined
    return {
      ...(planType ? { planType } : {}),
      ...(planExpiresAt ? { planExpiresAt } : {}),
    }
  } catch {
    return {}
  }
}

/**
 * Update usage hints on pool accounts from wham/usage data.
 * Called by codexUsage after fetching. These are soft hints only.
 */
export function updateAccountUsageHints(
  hints: Array<{
    accountId: string
    primaryPercent: number
    weeklyPercent: number
    allowed?: boolean
    limitReached?: boolean
    resetAt?: number
    fetchedAt?: number
  }>,
): void {
  const now = Date.now()
  for (const hint of hints) {
    const acct = pool.accounts.find((a) => a.accountId === hint.accountId)
    if (acct) {
      const hintReportsBlocked =
        hint.allowed === false || hint.limitReached === true

      if (hintReportsBlocked && !canUsagePollBlockOverrideRedeem(acct, hint, now)) {
        // Silently skip — stale poll within the post-redeem propagation window.
        // Still update the non-blocking fields so scoring stays current.
        acct.usagePrimary = hint.primaryPercent
        acct.usageWeekly = hint.weeklyPercent
        // Don't update usageFetchedAt/usageAllowed/usageLimitReached/usageResetAt:
        // applying them would re-block the account via getCodexAccountAvailability.
        continue
      }

      const hintReportsUncapped = hint.allowed === true && hint.limitReached === false
      const hintUncapsHard429 =
        hintReportsUncapped &&
        acct.status === 'capped' &&
        acct.statusReason === 'usage_cap' &&
        canUsagePollUncapHard429(acct, hint, now)

      acct.usagePrimary = hint.primaryPercent
      acct.usageWeekly = hint.weeklyPercent
      acct.usageFetchedAt = now
      acct.usageAllowed = hint.allowed
      acct.usageLimitReached = hint.limitReached
      if (!hintReportsUncapped || hintUncapsHard429 || acct.status !== 'capped' || acct.statusReason !== 'usage_cap') {
        acct.usageResetAt = hint.resetAt
      }

      if (hintUncapsHard429) {
        const previousLastError = acct.lastError
        acct.status = 'healthy'
        acct.statusReason = undefined
        acct.lastError = undefined
        acct.cappedAt = undefined
        emitUsageStatusDiagnostic(
          'account.usage.uncap',
          acct.accountId,
          previousLastError
            ? `usage cap cleared: ${previousLastError}`
            : 'usage cap cleared',
        )
      }
    }
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

const USAGE_HINT_STALE_MS = 5 * 60 * 1000 // 5 minutes
// wham/usage lags reality by minutes; don't let a poll uncap an account whose
// hard 429 is more recent than this, even if the poll resolved after the cap.
// ponytail: fixed grace; only the self-inflicted post-failover refresh races this tight.
const USAGE_UNCAP_GRACE_MS = 2 * 60 * 1000 // 2 minutes
// Post-redemption lag guard: after a confirmed usage-reset redemption, stale
// polls can report allowed:false / limitReached:true for up to ~2 min while
// the server state propagates. Skip applying those blocking hints during this
// window — mirrors USAGE_UNCAP_GRACE_MS's purpose for the opposite direction.
export const REDEEM_HINT_LAG_GRACE_MS = 2 * 60 * 1000 // 2 minutes
type QuotaObservationState = 'allowed' | 'blocked'
type QuotaObservationSource = 'usage_poll' | 'hard_429' | 'redeem'

type QuotaObservation = {
  state: QuotaObservationState
  source: QuotaObservationSource
  observedAt: number
  authority: number
  propagationLagMs: number
  resetAt?: number
}

const QUOTA_OBSERVATION_SOURCE_PROPERTIES: Record<QuotaObservationSource, {
  authority: number
  propagationLagMs: number
}> = {
  usage_poll: { authority: 1, propagationLagMs: 0 },
  hard_429: { authority: 2, propagationLagMs: USAGE_UNCAP_GRACE_MS },
  redeem: { authority: 2, propagationLagMs: REDEEM_HINT_LAG_GRACE_MS },
}

function createQuotaObservation(
  source: QuotaObservationSource,
  state: QuotaObservationState,
  observedAt: number,
  resetAt?: number,
): QuotaObservation {
  const sourceProperties = QUOTA_OBSERVATION_SOURCE_PROPERTIES[source]
  return {
    state,
    source,
    observedAt,
    authority: sourceProperties.authority,
    propagationLagMs: sourceProperties.propagationLagMs,
    ...(resetAt !== undefined ? { resetAt } : {}),
  }
}

function getFiniteTimestamp(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function canQuotaObservationOverride(
  currentBelief: QuotaObservation,
  nextObservation: QuotaObservation,
  now: number,
): boolean {
  if (nextObservation.observedAt <= currentBelief.observedAt) {
    return false
  }
  return (
    nextObservation.authority > currentBelief.authority ||
    now - currentBelief.observedAt >= currentBelief.propagationLagMs
  )
}

function getHard429QuotaBelief(account: CodexAccountAvailabilityAccount): QuotaObservation | null {
  const cappedAt = getFiniteTimestamp(account.cappedAt)
  if (
    account.status !== 'capped' ||
    account.statusReason !== 'usage_cap' ||
    cappedAt === undefined
  ) {
    return null
  }
  // Only carry a reset that post-dates the cap. The hard-429 path calls
  // markPoolAccountCapped without a resetAt, so any prior usageResetAt survives
  // the cap; a value already elapsed when the cap was placed belongs to an
  // earlier window (or a stale poll), not this cap, and must not silently uncap
  // a freshly capped account (which would flip it "available" → re-select →
  // 429 → hot loop, and inflate canFailover()'s selectable count).
  const resetAt =
    typeof account.usageResetAt === 'number' && account.usageResetAt * 1000 >= cappedAt
      ? account.usageResetAt
      : undefined
  return createQuotaObservation('hard_429', 'blocked', cappedAt, resetAt)
}

function getUsagePollQuotaBelief(account: CodexAccountAvailabilityAccount): QuotaObservation | null {
  const fetchedAt = getFiniteTimestamp(account.usageFetchedAt)
  if (fetchedAt === undefined) {
    return null
  }
  const state = account.usageAllowed === false || account.usageLimitReached === true
    ? 'blocked'
    : 'allowed'
  return createQuotaObservation('usage_poll', state, fetchedAt, account.usageResetAt)
}

function isQuotaObservationResetElapsed(
  observation: QuotaObservation | null,
  now: number,
): boolean {
  return (
    typeof observation?.resetAt === 'number' &&
    observation.resetAt > 0 &&
    now >= observation.resetAt * 1000
  )
}

function getUsageHintObservationTime(
  hint: { fetchedAt?: number },
  fallback: number,
): number {
  return getFiniteTimestamp(hint.fetchedAt) ?? fallback
}

function canUsagePollBlockOverrideRedeem(
  account: PoolAccount,
  hint: { fetchedAt?: number; resetAt?: number },
  now: number,
): boolean {
  const redeemedAt = getFiniteTimestamp(account.redeemedAt)
  if (redeemedAt === undefined) {
    return true
  }
  const redeemBelief = createQuotaObservation('redeem', 'allowed', redeemedAt)
  const pollObservation = createQuotaObservation(
    'usage_poll',
    'blocked',
    getUsageHintObservationTime(hint, now),
    hint.resetAt,
  )
  return canQuotaObservationOverride(redeemBelief, pollObservation, now)
}

function canUsagePollUncapHard429(
  account: PoolAccount,
  hint: { fetchedAt?: number; resetAt?: number },
  now: number,
): boolean {
  const hard429Belief = getHard429QuotaBelief(account)
  if (!hard429Belief) {
    return true
  }
  const fetchedAt = getFiniteTimestamp(hint.fetchedAt)
  if (fetchedAt === undefined) {
    return false
  }
  const pollObservation = createQuotaObservation('usage_poll', 'allowed', fetchedAt, hint.resetAt)
  return canQuotaObservationOverride(hard429Belief, pollObservation, now)
}

const DEFAULT_USAGE_PRIMARY = 50
const DEFAULT_USAGE_WEEKLY = 50
const PRIMARY_USAGE_WEIGHT = 3

export function hasFreshPoolAccountUsageHint(
  account: CodexAccountAvailabilityAccount,
  now = Date.now(),
): boolean {
  return (
    account.usageFetchedAt != null &&
    now - account.usageFetchedAt < USAGE_HINT_STALE_MS
  )
}

export function getPoolAccountUsageScore(
  account: PoolAccount,
  now = Date.now(),
): number {
  if (!hasFreshPoolAccountUsageHint(account, now)) {
    return DEFAULT_USAGE_PRIMARY * PRIMARY_USAGE_WEIGHT + DEFAULT_USAGE_WEEKLY
  }

  return (
    (account.usagePrimary ?? DEFAULT_USAGE_PRIMARY) * PRIMARY_USAGE_WEIGHT +
    (account.usageWeekly ?? DEFAULT_USAGE_WEEKLY)
  )
}

export type CodexAccountAvailabilityAccount = Pick<
  PoolAccount,
  | 'status'
  | 'statusReason'
  | 'lastError'
  | 'usageAllowed'
  | 'usageLimitReached'
  | 'usageFetchedAt'
  | 'usageResetAt'
  | 'cappedAt'
  | 'planType'
  | 'planExpiresAt'
>

export type CodexAccountAvailabilityWarningCode =
  | 'plan_metadata_expired'
  | 'plan_metadata_ineligible'

export type CodexAccountAvailabilityWarning = {
  code: CodexAccountAvailabilityWarningCode
  message: string
}

export type CodexAccountAvailability =
  | { kind: 'available' }
  | { kind: 'warned'; warnings: CodexAccountAvailabilityWarning[] }
  | { kind: 'blocked'; reason: string }

function getPlanMetadataWarnings(
  account: CodexAccountAvailabilityAccount,
  now: number,
): CodexAccountAvailabilityWarning[] {
  const warnings: CodexAccountAvailabilityWarning[] = []
  if (account.planType === 'free') {
    warnings.push({
      code: 'plan_metadata_ineligible',
      message: `saved plan metadata says plan type ${account.planType} is not eligible for Codex; live usage decides availability`,
    })
  }
  const expiresAtMs = account.planExpiresAt ? Date.parse(account.planExpiresAt) : Number.NaN
  if (Number.isFinite(expiresAtMs) && expiresAtMs <= now) {
    warnings.push({
      code: 'plan_metadata_expired',
      message: `saved plan metadata says expired (${account.planExpiresAt}); live usage decides availability`,
    })
  }
  return warnings
}

export function getCodexAccountAvailability(
  account: CodexAccountAvailabilityAccount,
  now = Date.now(),
): CodexAccountAvailability {
  if (account.status === 'dead') {
    return { kind: 'blocked', reason: normalizeCodexAccountBlockReason(account.lastError) ?? 'account auth is unavailable' }
  }
  if (account.status === 'capped') {
    const hard429Belief = getHard429QuotaBelief(account)
    if (!hard429Belief || !isQuotaObservationResetElapsed(hard429Belief, now)) {
      return { kind: 'blocked', reason: normalizeCodexAccountBlockReason(account.lastError) ?? 'account is capped' }
    }
  }
  if (account.status === 'quarantined') {
    return { kind: 'blocked', reason: normalizeCodexAccountBlockReason(account.lastError) ?? 'connection problem; retrying' }
  }
  if (
    hasFreshPoolAccountUsageHint(account, now) &&
    (account.usageAllowed === false || account.usageLimitReached === true) &&
    // ...unless the window the hint reported has already reset. usageResetAt is
    // wham/usage reset_at in Unix *seconds*; 0 is its "unknown" sentinel.
    !isQuotaObservationResetElapsed(getUsagePollQuotaBelief(account), now)
  ) {
    return { kind: 'blocked', reason: 'fresh usage data reports this account is capped' }
  }

  const warnings = getPlanMetadataWarnings(account, now)
  return warnings.length > 0 ? { kind: 'warned', warnings } : { kind: 'available' }
}

export type CodexAccountAvailabilityDescriptionOptions = {
  now?: number
  format?: 'plain' | 'bracket'
}

export function describeCodexAccountAvailability(
  account: CodexAccountAvailabilityAccount,
  options: CodexAccountAvailabilityDescriptionOptions = {},
): string {
  const now = options.now ?? Date.now()
  const availability = getCodexAccountAvailability(account, now)
  const label = describeCodexAccountAvailabilityLabel(account, availability, now)
  return options.format === 'bracket' ? `[${label}]` : label
}

function describeCodexAccountAvailabilityLabel(
  account: CodexAccountAvailabilityAccount,
  availability: CodexAccountAvailability,
  now: number,
): string {
  if (availability.kind !== 'blocked') {
    return 'Ready'
  }

  if (account.status === 'dead' || account.statusReason === 'auth_dead') {
    return 'Needs re-login'
  }

  if (account.status === 'quarantined' || account.statusReason === 'probe_pending_transport') {
    return 'Connection issue (retrying)'
  }

  return `Limit reached (resets in ${formatCodexAvailabilityReset(account.usageResetAt, now)})`
}

function formatCodexAvailabilityReset(
  resetAtSeconds: number | undefined,
  now: number,
): string {
  if (typeof resetAtSeconds !== 'number' || !Number.isFinite(resetAtSeconds) || resetAtSeconds <= 0) {
    return 'unknown'
  }

  const seconds = Math.max(0, Math.ceil(resetAtSeconds - now / 1000))
  if (seconds <= 0) return 'now'

  const totalMinutes = Math.ceil(seconds / 60)
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours >= 24) {
    const days = Math.floor(hours / 24)
    const remainingHours = hours % 24
    return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`
  }
  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
  }
  return `${minutes}m`
}

export function normalizeCodexAccountBlockReason(reason: string | undefined): string | undefined {
  if (!reason) return undefined
  const httpMatch = /^http_(\d{3})$/i.exec(reason)
  if (httpMatch) {
    return `Token refresh failed: HTTP ${httpMatch[1]}`
  }
  return reason
}

export function isCodexAccountSwitchable(
  account: PoolAccount,
  now = Date.now(),
): boolean {
  return getCodexAccountAvailability(account, now).kind !== 'blocked'
}

/**
 * Find the best healthy account, excluding `skipIndex`.
 * When fresh usage data is available, prefers the account with the lowest
 * 5h usage percent. Falls back to LRU when usage data is stale or absent.
 */
function findLRUHealthy(skipIndex: number): number {
  const now = Date.now()
  const candidates: Array<{ idx: number; acct: PoolAccount }> = []

  for (let i = 0; i < pool.accounts.length; i++) {
    if (i === skipIndex) continue
    const acct = pool.accounts[i]!
    if (isCodexAccountSwitchable(acct, now)) {
      candidates.push({ idx: i, acct })
    }
  }

  if (candidates.length === 0) return -1

  const cleanCandidates = candidates.filter(
    (candidate) => getCodexAccountAvailability(candidate.acct, now).kind === 'available',
  )
  const rankable = cleanCandidates.length > 0 ? cleanCandidates : candidates

  // Check if any candidate has fresh usage data
  const hasFreshUsage = rankable.some((c) =>
    hasFreshPoolAccountUsageHint(c.acct, now),
  )

  if (hasFreshUsage) {
    // Sort by usage score: 5h window * 3 + weekly (lower = better)
    // Accounts without fresh usage data get a neutral score of 150
    rankable.sort((a, b) => {
      const scoreA = getPoolAccountUsageScore(a.acct, now)
      const scoreB = getPoolAccountUsageScore(b.acct, now)
      return scoreA - scoreB
    })
    logForDebugging(
      `[codex-pool] Usage-aware selection: ${truncId(rankable[0]!.acct.accountId)} (5h: ${rankable[0]!.acct.usagePrimary}%, wk: ${rankable[0]!.acct.usageWeekly}%)`,
    )
    return rankable[0]!.idx
  }

  // Fallback: LRU
  let bestIdx = -1
  let bestTime = Infinity
  for (const { idx, acct } of rankable) {
    if (acct.lastUsedAt < bestTime) {
      bestTime = acct.lastUsedAt
      bestIdx = idx
    }
  }
  return bestIdx
}

export function seedCodexAccountPoolForTest({
  accounts,
  activeAccountId,
}: {
  accounts: PoolAccount[]
  activeAccountId?: string
}): void {
  pool.accounts = accounts.map((account) => ({ ...account }))
  pool.initialized = true

  if (activeAccountId) {
    pool.activeIndex = pool.accounts.findIndex(
      (account) => account.accountId === activeAccountId,
    )
  } else {
    pool.activeIndex = pool.accounts.findIndex(
      (account) => isCodexAccountSwitchable(account),
    )
  }
}

export function resetCodexAccountPoolForTest(): void {
  pool.accounts = []
  pool.activeIndex = -1
  pool.initialized = false
}

function truncId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 12)}...` : id
}

// ── Usage-reset redemption (Slice 2) ──────────────────────────────────────

/**
 * Heal a pool account after a confirmed server-side usage-reset redemption.
 *
 * A confirmed `reset` or `already_redeemed` from the server is authoritative
 * in a way polls are not — the USAGE_UNCAP_GRACE_MS exists to distrust polls,
 * not redemptions. This bypasses that grace intentionally.
 *
 * Only heals `capped` + `usage_cap`; dead/quarantined accounts have auth or
 * network problems orthogonal to usage caps.
 */
export function applyRedeemedUsageReset(accountId: string): void {
  const acct = pool.accounts.find((a) => a.accountId === accountId)
  if (!acct) return

  // Only heal capped/usage_cap — dead and quarantined are orthogonal.
  if (acct.status === 'capped' && acct.statusReason === 'usage_cap') {
    const previousLastError = acct.lastError
    acct.status = 'healthy'
    acct.statusReason = undefined
    acct.lastError = undefined
    acct.cappedAt = undefined
    emitUsageStatusDiagnostic(
      'account.usage.uncap',
      acct.accountId,
      previousLastError
        ? `usage reset redeemed: ${previousLastError}`
        : 'usage reset redeemed',
    )
  }

  // Clear the hint block so getCodexAccountAvailability passes immediately.
  // No fresh hint → scoring falls back to defaults until the next poll.
  acct.usageAllowed = true
  acct.usageLimitReached = false
  acct.usageFetchedAt = undefined
  acct.usageResetAt = undefined

  // Stamp for the REDEEM_HINT_LAG_GRACE_MS guard in updateAccountUsageHints.
  acct.redeemedAt = Date.now()
}

/**
 * Per-account redemption eligibility predicate.
 *
 * Eligible iff the account has a token AND status is 'healthy' or
 * 'capped' with statusReason 'usage_cap'. Credit-count-based disabling
 * is the dialog's job (Slice 3), not this predicate's.
 */
export type RedemptionEligibility =
  | { eligible: true }
  | { eligible: false; reason: string }

export function getRedemptionEligibility(account: PoolAccount): RedemptionEligibility {
  if (!account.accessToken) {
    return { eligible: false, reason: 're-login required' }
  }
  if (account.status === 'dead') {
    return { eligible: false, reason: 're-login required' }
  }
  if (account.status === 'quarantined') {
    return { eligible: false, reason: 'connection problems; retry later' }
  }
  if (account.status === 'capped' && account.statusReason === 'usage_cap') {
    return { eligible: true }
  }
  if (account.status === 'capped') {
    // capped for a non-usage reason (e.g. runtime_cap) — not eligible
    return { eligible: false, reason: account.lastError ?? 'account is capped for a non-usage reason' }
  }
  if (account.status === 'healthy') {
    return { eligible: true }
  }
  // Defensive: unknown status
  return { eligible: false, reason: 'account is in an unknown state' }
}
