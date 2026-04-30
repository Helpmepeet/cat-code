/**
 * Multi-account Codex credential pool.
 *
 * Reads accounts from two sources:
 *   1. codex-nootp vault (~/codex-vault or configured path)
 *   2. Single codexOAuth entry in ~/.claude.json (backward compat)
 *
 * Provides LRU-based turn rotation and instant failover on 429/cap errors.
 * When the pool has ≤1 healthy account (or hasn't initialized), all code paths
 * fall through to the existing single-account behavior — zero behavioral change.
 */

import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync, renameSync, unlinkSync } from 'fs'
import { join, basename } from 'path'
import { homedir } from 'os'
import { hostname } from 'os'

import { regenerateSessionId, resetCostState } from '../../bootstrap/state.js'
import { logForDebugging } from '../../utils/debug.js'
import { clearCodexOAuthTokens, getCodexOAuthTokens, saveCodexOAuthTokens } from '../../utils/auth.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { getInitialSettings } from '../../utils/settings/settings.js'
import { resetUserCache } from '../../utils/user.js'

// ── Types ──────────────────────────────────────────────────────────────────

export interface PoolAccount {
  accountId: string
  accessToken: string
  refreshToken: string
  expiresAt: number
  source: 'vault' | 'config'
  status: 'healthy' | 'dead' | 'capped'
  lastUsedAt: number
  turnsUsed: number
  lastError?: string
  lastRefreshIso?: string       // ISO timestamp from vault's last_refresh field
  vaultFilePath?: string        // absolute path to the vault JSON file (vault accounts only)
  alias?: string                // human-readable name, e.g. "main", "backup1"
  // Soft usage hints from wham/usage (best-effort, may be stale)
  usagePrimary?: number         // 5h window used_percent (0-100)
  usageWeekly?: number          // weekly window used_percent (0-100)
  usageFetchedAt?: number       // when usage was last fetched
  lastErrorAt?: number          // epoch ms of most recent turn error (any kind)
}

interface PoolState {
  accounts: PoolAccount[]
  activeIndex: number
  turnThreshold: number
  initialized: boolean
}

type VaultPlanHealth = {
  status: 'healthy' | 'capped'
  lastError?: string
}

type CodexVaultSaveMetadataAction = 'new' | 'preserved' | 'replaced'
type CodexVaultSaveAliasAction = 'none' | 'set' | 'preserved' | 'cleared'
type CodexVaultSaveIdentityAction = 'same' | 'new' | 'mismatch'

// ── Constants ──────────────────────────────────────────────────────────────

// Infinity = rotate only on 429 failover, never proactively.
// Proactive rotation busts the OpenAI prompt cache (~20K+ tokens re-processed
// from scratch on every switch), costing 1-2s latency per rotation.
// Reactive failover (rotateOnFailure) already handles cap errors instantly.
const DEFAULT_TURN_THRESHOLD = Infinity
const LOCK_STALE_MS = 2 * 60 * 60 * 1000 // 2 hours, matching codex-nootp
const DEFAULT_VAULT_PATH = join(homedir(), 'codex-vault')
const CODEX_NOOTP_CONFIG = join(homedir(), '.codex-nootp', 'config.toml')

// ── Singleton state ────────────────────────────────────────────────────────

const pool: PoolState = {
  accounts: [],
  activeIndex: -1,
  turnThreshold: DEFAULT_TURN_THRESHOLD,
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
    const configAccount = loadConfigAccount()

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

    // Read turn threshold from settings (codexAccountRotationThreshold)
    const settings = getInitialSettings()
    if (settings.codexAccountRotationThreshold != null) {
      pool.turnThreshold = Math.max(1, Math.round(settings.codexAccountRotationThreshold))
    }

    pool.initialized = true

    const healthy = pool.accounts.filter((a) => a.status === 'healthy').length
    const dead = pool.accounts.filter((a) => a.status === 'dead').length
    logForDebugging(
      `[codex-pool] Loaded ${pool.accounts.length} accounts (${healthy} healthy, ${dead} dead)`,
    )

    // Start periodic token refresh if vault accounts exist
    if (pool.accounts.some((a) => a.source === 'vault')) {
      const { startPeriodicRefresh } = await import('./codexTokenRefresh.js')
      startPeriodicRefresh()
    }

    // Fire-and-forget: fetch initial usage data for scoring
    if (pool.accounts.length > 1) {
      import('./codexUsage.js').then(({ fetchPoolUsage }) => {
        void fetchPoolUsage()
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
 * True when the pool is initialized and has more than one account (any status).
 * This gates pool-based token resolution and failover logic. The pool stays
 * "active" even when some accounts are capped/dead so that:
 *  - remaining healthy accounts are still reachable via the pool path
 *  - the UI doesn't flip to "Not logged in" when one account hits a cap
 *  - /accounts still shows all accounts with their statuses
 */
export function isPoolActive(): boolean {
  return pool.initialized && pool.accounts.length > 1
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
  if (!acct || acct.status !== 'healthy') {
    // Active account went bad — find another healthy one
    const idx = findLRUHealthy(-1)
    if (idx < 0) return null
    pool.activeIndex = idx
    return pool.accounts[idx]!
  }
  return acct
}

export function setActiveAccount(accountId: string): PoolAccount | null {
  const nextIndex = pool.accounts.findIndex(
    (account) => account.accountId === accountId && account.status === 'healthy',
  )
  if (nextIndex < 0) {
    return null
  }

  pool.activeIndex = nextIndex
  logForDebugging(
    `[codex-profile] pool-active-change writer=codexAccountPool.setActiveAccount after=${accountId} reason=set-active`,
  )
  return pool.accounts[nextIndex]!
}

/**
 * Called once per user turn. Rotates to LRU account when the current one
 * has exceeded the turn threshold and another healthy account exists.
 * Returns rotation info when a switch occurred, or null if no rotation.
 */
export function selectAccountForTurn(): { from: string; to: string; turns: number } | null {
  if (!pool.initialized || pool.accounts.length <= 1) return null

  const current = pool.accounts[pool.activeIndex]
  if (current && current.status === 'healthy') {
    current.turnsUsed++
    current.lastUsedAt = Date.now()

    if (current.turnsUsed >= pool.turnThreshold) {
      const next = findLRUHealthy(pool.activeIndex)
      if (next >= 0) {
        const fromId = truncId(current.accountId)
        const toId = truncId(pool.accounts[next]!.accountId)
        const turns = current.turnsUsed
        logForDebugging(
          `[codex-pool] Turn rotation: ${fromId} → ${toId} after ${turns} turns`,
        )
        pool.activeIndex = next
        pool.accounts[next]!.turnsUsed = 0
        persistActiveCodexAccountId(pool.accounts[next]!.accountId)
        return { from: fromId, to: toId, turns }
      }
    }
  } else {
    // Current is not healthy, find a replacement
    const next = findLRUHealthy(-1)
    if (next >= 0) {
      pool.activeIndex = next
      pool.accounts[next]!.turnsUsed = 0
      persistActiveCodexAccountId(pool.accounts[next]!.accountId)
    }
  }
  return null
}

/**
 * Called on 429/cap from the current account.
 * Marks it capped and returns the next healthy LRU account, or null if all exhausted.
 */
export function rotateOnFailure(): PoolAccount | null {
  const current = pool.accounts[pool.activeIndex]
  if (current) {
    current.status = 'capped'
    current.usagePrimary = 100 // Mark as fully used
    current.lastError = 'Usage cap hit (429)'
    logForDebugging(
      `[codex-pool] Account ${truncId(current.accountId)} capped`,
    )
  }

  const next = findLRUHealthy(-1)
  if (next < 0) {
    logForDebugging('[codex-pool] All accounts exhausted')
    return null
  }

  pool.activeIndex = next
  const acct = pool.accounts[next]!
  acct.turnsUsed = 0
  persistActiveCodexAccountId(acct.accountId)
  acct.lastUsedAt = Date.now()
  logForDebugging(
    `[codex-pool] Failover to ${truncId(acct.accountId)}`,
  )

  // Refresh usage data after failover (fire-and-forget)
  import('./codexUsage.js').then(({ fetchPoolUsage }) => {
    void fetchPoolUsage(true)
  }).catch(() => {})

  return acct
}

/** Add or update an account in the live pool (called by login flow). */
export function appendAccount(tokens: {
  accessToken: string
  refreshToken: string
  expiresAt: number
  accountId: string
  alias?: string
  source?: 'vault' | 'config'
  vaultFilePath?: string
}, options?: {
  preserveCapped?: boolean
  writer?: string
}): void {
  const existing = pool.accounts.findIndex(
    (a) => a.accountId === tokens.accountId,
  )
  if (existing >= 0) {
    // Update tokens. Login should reset status, but background token refresh
    // must not wipe a known capped state.
    const acct = pool.accounts[existing]!
    const preserveCapped = options?.preserveCapped === true && acct.status === 'capped'
    acct.accessToken = tokens.accessToken
    acct.refreshToken = tokens.refreshToken
    acct.expiresAt = tokens.expiresAt
    acct.status = preserveCapped ? 'capped' : 'healthy'
    acct.lastError = preserveCapped ? acct.lastError : undefined
    if (tokens.alias) acct.alias = tokens.alias
    if ('source' in tokens) acct.source = tokens.source ?? acct.source
    if ('vaultFilePath' in tokens) acct.vaultFilePath = tokens.vaultFilePath
    logForDebugging(
      `[codex-profile] pool-account-update writer=${options?.writer ?? 'codexAccountPool.appendAccount'} account=${tokens.accountId} source_after=${acct.source} alias_after=${acct.alias ?? ''} vault_file_after=${acct.vaultFilePath ? basename(acct.vaultFilePath) : ''} status_after=${acct.status}`,
    )
    logForDebugging(
      `[codex-pool] Updated existing account ${truncId(tokens.accountId)}`,
    )
  } else {
    pool.accounts.push({
      accountId: tokens.accountId,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      source: tokens.source ?? 'config',
      status: 'healthy',
      lastUsedAt: 0,
      turnsUsed: 0,
      alias: tokens.alias,
      vaultFilePath: tokens.vaultFilePath,
    })
    logForDebugging(
      `[codex-profile] pool-account-add writer=${options?.writer ?? 'codexAccountPool.appendAccount'} account=${tokens.accountId} source=${tokens.source ?? 'config'} alias=${tokens.alias ?? ''} vault_file=${tokens.vaultFilePath ? basename(tokens.vaultFilePath) : ''}`,
    )
    logForDebugging(
      `[codex-pool] Appended new account ${truncId(tokens.accountId)}`,
    )
  }

  // If this is the first or only healthy account, activate it
  if (
    pool.activeIndex < 0 ||
    pool.accounts[pool.activeIndex]?.status !== 'healthy'
  ) {
    const idx = pool.accounts.findIndex((a) => a.status === 'healthy')
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
  turnThreshold: number
  initialized: boolean
} {
  return {
    accounts: pool.accounts,
    activeIndex: pool.activeIndex,
    turnThreshold: pool.turnThreshold,
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
  options?: { writer?: string },
): void {
  const acct = pool.accounts.find((account) => account.accountId === accountId)
  if (!acct) return

  const before = acct.status
  acct.status = status
  acct.lastError = reason
  logForDebugging(
    `[codex-profile] pool-status-change writer=${options?.writer ?? 'codexAccountPool.markPoolAccountStatus'} account=${accountId} before=${before} after=${status}${reason ? ` reason=${reason}` : ''}`,
  )

  if (pool.accounts[pool.activeIndex]?.accountId === accountId && status !== 'healthy') {
    pool.activeIndex = findLRUHealthy(-1)
  }
}

export function markPoolAccountCapped(accountId: string, reason: string, options?: { writer?: string }): void {
  markPoolAccountStatus(accountId, 'capped', reason, options)

  const acct = pool.accounts.find((account) => account.accountId === accountId)
  if (!acct) return

  acct.usagePrimary = 100
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
 * Allow external configuration of the turn threshold.
 * Called during init or when settings change.
 */
export function setTurnThreshold(n: number): void {
  pool.turnThreshold = Math.max(1, Math.round(n))
}

/**
 * Manually switch to a specific account (by ID prefix) or the next LRU healthy one.
 * Returns the new active account, or null if no match / no healthy alternative.
 */
export function switchToAccount(idPrefix: string | null): PoolAccount | null {
  if (!pool.initialized || pool.accounts.length <= 1) return null

  let targetIdx: number
  if (idPrefix) {
    const lower = idPrefix.toLowerCase()
    // Match by alias first (exact or prefix), then fall back to ID prefix
    targetIdx = pool.accounts.findIndex(
      (a) => a.alias?.toLowerCase() === lower && a.status === 'healthy',
    )
    if (targetIdx < 0) {
      targetIdx = pool.accounts.findIndex(
        (a) => a.alias?.toLowerCase().startsWith(lower) && a.status === 'healthy',
      )
    }
    if (targetIdx < 0) {
      targetIdx = pool.accounts.findIndex(
        (a) => a.accountId.toLowerCase().startsWith(lower) && a.status === 'healthy',
      )
    }
    if (targetIdx < 0) return null
  } else {
    targetIdx = findLRUHealthy(pool.activeIndex)
    if (targetIdx < 0) return null
  }

  if (targetIdx === pool.activeIndex) {
    logForDebugging(
      `[codex-profile] pool-active-unchanged writer=switch-account account=${pool.accounts[targetIdx]!.accountId} reason=already-active`,
    )
    return pool.accounts[targetIdx]!
  }

  const before = pool.accounts[pool.activeIndex]?.accountId
  logForDebugging(
    `[codex-pool] Manual switch: ${truncId(pool.accounts[pool.activeIndex]?.accountId ?? '?')} → ${truncId(pool.accounts[targetIdx]!.accountId)}`,
  )
  // Stamp the outgoing account so LRU doesn't immediately pick it again
  if (pool.accounts[pool.activeIndex]) {
    pool.accounts[pool.activeIndex]!.lastUsedAt = Date.now()
  }
  pool.activeIndex = targetIdx
  pool.accounts[targetIdx]!.turnsUsed = 0
  persistActiveCodexAccountId(pool.accounts[targetIdx]!.accountId)
  logForDebugging(
    `[codex-profile] pool-active-change writer=switch-account before=${before ?? ''} after=${pool.accounts[targetIdx]!.accountId} reason=manual-switch`,
  )
  return pool.accounts[targetIdx]!
}

/** Mark an account as dead with a reason. Used by token refresh on unrecoverable errors. */
export function markAccountDead(accountId: string, reason: string): void {
  const acct = pool.accounts.find((a) => a.accountId === accountId)
  if (!acct) return
  acct.status = 'dead'
  acct.lastError = reason
  // If this was the active account, find another
  if (pool.accounts[pool.activeIndex]?.accountId === accountId) {
    const next = findLRUHealthy(-1)
    pool.activeIndex = next
    persistActiveCodexAccountId(pool.accounts[next]?.accountId)
  }
  logForDebugging(
    `[codex-pool] Account ${truncId(accountId)} marked dead: ${reason}`,
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
}, options?: {
  writer?: string
  expectedPreviousAccountId?: string
}): { filePath: string; existed: boolean; metadataAction: CodexVaultSaveMetadataAction } | null {
  try {
    const vaultPath = readVaultPath() ?? DEFAULT_VAULT_PATH
    const accountsDir = join(vaultPath, 'accounts')
    mkdirSync(accountsDir, { recursive: true })

    const filePath = join(accountsDir, `${tokens.accountId}.json`)
    const existed = existsSync(filePath)
    let existing: Record<string, unknown> | undefined
    if (existed) {
      try {
        existing = JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>
      } catch (err) {
        logForDebugging(
          `[codex-profile] vault-save writer=${options?.writer ?? 'codexAccountPool.saveCodexTokenToVault'} file=${basename(filePath)} parse_existing_failed=true action=overwrite`,
          { level: 'warn' },
        )
      }
    }
    const nowIso = new Date().toISOString()
    const built = buildCodexVaultRecordForSave(existing, tokens, nowIso)
    atomicWriteJson(filePath, built.record)
    if (built.identityAction === 'mismatch') {
      const existingAccount = existing?.tokens && typeof existing.tokens === 'object'
        ? String((existing.tokens as Record<string, unknown>).account_id ?? '')
        : undefined
      logForDebugging(
        `[codex-profile] identity-mismatch writer=${options?.writer ?? 'codexAccountPool.saveCodexTokenToVault'} file=${basename(filePath)} expected_previous_account=${options?.expectedPreviousAccountId ?? ''} existing_account=${existingAccount ?? ''} incoming_account=${tokens.accountId} action=replace-file-identity`,
        { level: 'warn' },
      )
    }
    logForDebugging(
      `[codex-profile] vault-save writer=${options?.writer ?? 'codexAccountPool.saveCodexTokenToVault'} account=${tokens.accountId} file=${basename(filePath)} existed=${String(existed)} metadata=${built.metadataAction} alias_action=${built.aliasAction} identity=${built.identityAction} source=vault`,
    )
    logForDebugging(`[codex-pool] Saved account ${truncId(tokens.accountId)} to vault`)
    return { filePath, existed, metadataAction: built.metadataAction }
  } catch (err) {
    logForDebugging(
      `[codex-pool] Failed to save account to vault: ${err instanceof Error ? err.message : String(err)}`,
      { level: 'warn' },
    )
    return null
  }
}

/**
 * Update the alias for an existing vault account.
 * Reads the current vault JSON, sets/overwrites the alias field, writes back atomically.
 */
export function setAccountAlias(accountId: string, alias: string): boolean {
  const acct = pool.accounts.find((a) => a.accountId === accountId)
  if (!acct?.vaultFilePath) return false

  try {
    const oldAlias = acct.alias
    const existing = JSON.parse(readFileSync(acct.vaultFilePath, 'utf-8')) as Record<string, unknown>
    existing.alias = alias
    // atomic write via temp+rename
    const dir = acct.vaultFilePath.split('/').slice(0, -1).join('/')
    const tmp = `${dir}/.${Date.now()}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(existing, null, 2) + '\n', 'utf-8')
    renameSync(tmp, acct.vaultFilePath)
    acct.alias = alias
    logForDebugging(
      `[codex-profile] alias-rename writer=rename-account account=${accountId} file=${basename(acct.vaultFilePath)} old_alias=${oldAlias ?? ''} new_alias=${alias} metadata=preserved`,
    )
    logForDebugging(`[codex-pool] Set alias "${alias}" for ${truncId(accountId)}`)
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

  const active = pool.accounts[pool.activeIndex] ?? pool.accounts.find((account) => account.status === 'healthy') ?? pool.accounts[0]

  if (active) {
    saveCodexOAuthTokens({
      accessToken: active.accessToken,
      refreshToken: active.refreshToken,
      expiresAt: active.expiresAt,
      accountId: active.accountId,
    })
    persistActiveCodexAccountId(active.accountId)
  } else {
    clearCodexOAuthTokens()
    persistActiveCodexAccountId(undefined)
  }

  logForDebugging(`[codex-pool] Removed account ${truncId(accountId)}`)
  return true
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
        logForDebugging(`[codex-profile] vault-load-skip writer=codexAccountPool.loadVaultAccounts file=${file} reason=missing-required-token-fields`)
        logForDebugging(
          `[codex-pool] Skipping ${file}: missing required token fields`,
        )
        continue
      }

      const accountId = String(tokens.account_id)

      // Check lock
      if (isAccountLocked(locksDir, accountId)) {
        logForDebugging(`[codex-profile] vault-load-skip writer=codexAccountPool.loadVaultAccounts account=${accountId} file=${file} reason=locked`)
        logForDebugging(
          `[codex-pool] Skipping ${truncId(accountId)}: locked by another process`,
        )
        continue
      }

      // Check expiry from expiresAt or last_refresh
      const lastRefresh = data.last_refresh as string | undefined
      const refreshStatus = checkAccountHealth(lastRefresh)
      const planHealth = getVaultPlanHealthFromIdToken(
        typeof tokens.id_token === 'string' ? tokens.id_token : undefined,
      )
      const status = refreshStatus === 'dead' ? 'dead' : planHealth.status

      results.push({
        accountId,
        accessToken: String(tokens.access_token),
        refreshToken: String(tokens.refresh_token),
        expiresAt: lastRefresh ? new Date(lastRefresh).getTime() : 0,
        source: 'vault',
        status,
        lastUsedAt: 0,
        turnsUsed: 0,
        lastRefreshIso: lastRefresh,
        vaultFilePath: join(accountsDir, file),
        alias: typeof data.alias === 'string' && data.alias ? data.alias : undefined,
        ...(status === 'dead'
          ? { lastError: 'Token expired (>7 days since last refresh)' }
          : planHealth.lastError
            ? { lastError: planHealth.lastError }
            : {}),
      })
      logForDebugging(`[codex-profile] vault-load writer=codexAccountPool.loadVaultAccounts account=${accountId} file=${file} alias=${typeof data.alias === 'string' ? data.alias : ''} status=${status} last_refresh=${lastRefresh ?? ''}`)
    } catch (err) {
      logForDebugging(`[codex-profile] vault-load-skip writer=codexAccountPool.loadVaultAccounts file=${file} reason=parse-error`)
      logForDebugging(
        `[codex-pool] Failed to load vault account ${file}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
  return results
}

function loadConfigAccount(): PoolAccount | null {
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
    turnsUsed: 0,
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
    if (!byId.has(configAccount.accountId)) {
      byId.set(configAccount.accountId, configAccount)
      logForDebugging(
        `[codex-profile] pool-merge writer=codexAccountPool.mergePoolAccounts account=${configAccount.accountId} decision=config-added reason=no-vault-record`,
      )
    } else {
      logForDebugging(
        `[codex-profile] pool-merge writer=codexAccountPool.mergePoolAccounts account=${configAccount.accountId} decision=vault-kept config_duplicate=true`,
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

export function getVaultPlanHealthFromIdToken(
  idToken: string | undefined,
  now = Date.now(),
): VaultPlanHealth {
  if (!idToken) {
    return { status: 'healthy' }
  }

  try {
    const payload = JSON.parse(
      Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString('utf-8'),
    ) as Record<string, unknown>
    const auth = payload['https://api.openai.com/auth'] as Record<string, unknown> | undefined
    const planType = typeof auth?.chatgpt_plan_type === 'string'
      ? auth.chatgpt_plan_type.toLowerCase()
      : null
    const subscriptionActiveUntil = typeof auth?.chatgpt_subscription_active_until === 'string'
      ? auth.chatgpt_subscription_active_until
      : null
    const subscriptionActiveUntilMs = subscriptionActiveUntil
      ? Date.parse(subscriptionActiveUntil)
      : Number.NaN

    if (planType === 'free') {
      return {
        status: 'capped',
        lastError: 'Plan type free is not eligible for Codex usage',
      }
    }

    if (
      subscriptionActiveUntil &&
      Number.isFinite(subscriptionActiveUntilMs) &&
      subscriptionActiveUntilMs <= now
    ) {
      return {
        status: 'capped',
        lastError: `Plan expired (${subscriptionActiveUntil})`,
      }
    }
  } catch {
    return { status: 'healthy' }
  }

  return { status: 'healthy' }
}

/**
 * Update usage hints on pool accounts from wham/usage data.
 * Called by codexUsage after fetching. These are soft hints only.
 */
export function updateAccountUsageHints(
  hints: Array<{ accountId: string; primaryPercent: number; weeklyPercent: number }>,
): void {
  const now = Date.now()
  for (const hint of hints) {
    const acct = pool.accounts.find((a) => a.accountId === hint.accountId)
    if (acct) {
      acct.usagePrimary = hint.primaryPercent
      acct.usageWeekly = hint.weeklyPercent
      acct.usageFetchedAt = now
    }
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

const USAGE_HINT_STALE_MS = 5 * 60 * 1000 // 5 minutes
const DEFAULT_USAGE_PRIMARY = 50
const DEFAULT_USAGE_WEEKLY = 50
const PRIMARY_USAGE_WEIGHT = 3

export function hasFreshPoolAccountUsageHint(
  account: PoolAccount,
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
    if (acct.status === 'healthy') {
      candidates.push({ idx: i, acct })
    }
  }

  if (candidates.length === 0) return -1

  // Check if any candidate has fresh usage data
  const hasFreshUsage = candidates.some((c) =>
    hasFreshPoolAccountUsageHint(c.acct, now),
  )

  if (hasFreshUsage) {
    // Sort by usage score: 5h window * 3 + weekly (lower = better)
    // Accounts without fresh usage data get a neutral score of 150
    candidates.sort((a, b) => {
      const scoreA = getPoolAccountUsageScore(a.acct, now)
      const scoreB = getPoolAccountUsageScore(b.acct, now)
      return scoreA - scoreB
    })
    logForDebugging(
      `[codex-pool] Usage-aware selection: ${truncId(candidates[0]!.acct.accountId)} (5h: ${candidates[0]!.acct.usagePrimary}%, wk: ${candidates[0]!.acct.usageWeekly}%)`,
    )
    return candidates[0]!.idx
  }

  // Fallback: LRU
  let bestIdx = -1
  let bestTime = Infinity
  for (const { idx, acct } of candidates) {
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
  turnThreshold = DEFAULT_TURN_THRESHOLD,
}: {
  accounts: PoolAccount[]
  activeAccountId?: string
  turnThreshold?: number
}): void {
  pool.accounts = accounts.map((account) => ({ ...account }))
  pool.turnThreshold = turnThreshold
  pool.initialized = true

  if (activeAccountId) {
    pool.activeIndex = pool.accounts.findIndex(
      (account) => account.accountId === activeAccountId,
    )
  } else {
    pool.activeIndex = pool.accounts.findIndex(
      (account) => account.status === 'healthy',
    )
  }
}

export function resetCodexAccountPoolForTest(): void {
  pool.accounts = []
  pool.activeIndex = -1
  pool.turnThreshold = DEFAULT_TURN_THRESHOLD
  pool.initialized = false
}

export function buildCodexVaultRecordForSave(
  existing: Record<string, unknown> | undefined,
  tokens: {
    accessToken: string
    refreshToken: string
    accountId: string
    alias?: string
    idToken?: string
  },
  nowIso: string,
): {
  record: Record<string, unknown>
  metadataAction: CodexVaultSaveMetadataAction
  aliasAction: CodexVaultSaveAliasAction
  identityAction: CodexVaultSaveIdentityAction
} {
  const existingTokens = existing?.tokens && typeof existing.tokens === 'object'
    ? existing.tokens as Record<string, unknown>
    : undefined
  const existingAccountId = typeof existingTokens?.account_id === 'string'
    ? existingTokens.account_id
    : undefined

  const identityAction: CodexVaultSaveIdentityAction =
    !existing ? 'new' : existingAccountId === tokens.accountId ? 'same' : 'mismatch'
  const metadataAction: CodexVaultSaveMetadataAction =
    !existing ? 'new' : identityAction === 'same' ? 'preserved' : 'replaced'

  const record: Record<string, unknown> =
    metadataAction === 'preserved' && existing ? { ...existing } : {}
  const nextTokens: Record<string, unknown> =
    metadataAction === 'preserved' && existingTokens ? { ...existingTokens } : {}

  nextTokens.access_token = tokens.accessToken
  nextTokens.refresh_token = tokens.refreshToken
  nextTokens.account_id = tokens.accountId
  if (tokens.idToken !== undefined) {
    nextTokens.id_token = tokens.idToken
  }
  record.tokens = nextTokens
  record.last_refresh = nowIso

  let aliasAction: CodexVaultSaveAliasAction = 'none'
  if (tokens.alias !== undefined) {
    record.alias = tokens.alias
    aliasAction = 'set'
  } else if (metadataAction === 'preserved' && typeof existing?.alias === 'string') {
    record.alias = existing.alias
    aliasAction = 'preserved'
  } else if (metadataAction === 'replaced') {
    aliasAction = 'cleared'
  }

  return { record, metadataAction, aliasAction, identityAction }
}

function atomicWriteJson(filePath: string, data: unknown): void {
  const dir = filePath.split('/').slice(0, -1).join('/')
  const tmp = `${dir}/.${Date.now()}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf-8')
    renameSync(tmp, filePath)
  } catch (err) {
    try {
      unlinkSync(tmp)
    } catch {}
    throw err
  }
}

function truncId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 12)}...` : id
}
