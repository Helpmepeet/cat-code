/**
 * Multi-account Claude (Anthropic) credential pool.
 *
 * Reads accounts from two sources:
 *   1. claude-vault (~/claude-vault/accounts/<accountUuid>.json)
 *   2. Current keychain + config fallback (backward compat for single-account)
 *
 * Unlike the Codex pool, this has no automatic rotation or turn counting.
 * Switching is manual only via /switch-account.
 */

import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync, renameSync, unlinkSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

import { logForDebugging } from '../../utils/debug.js'
import { getSecureStorage } from '../../utils/secureStorage/index.js'
import { saveGlobalConfig, getGlobalConfig } from '../../utils/config.js'
// storeOAuthAccountInfo is intentionally NOT used here because it drops
// organizationName/organizationRole/workspaceRole. syncClaudeAccountToStorage
// writes oauthAccount directly to GlobalConfig instead.

// ── Types ──────────────────────────────────────────────────────────────────

export interface ClaudePoolAccount {
  accountUuid: string
  emailAddress: string
  accessToken: string
  refreshToken: string
  expiresAt: number
  scopes?: string[]
  subscriptionType?: string | null
  rateLimitTier?: string | null
  status: 'healthy' | 'dead'
  alias?: string
  displayName?: string
  organizationUuid?: string
  organizationName?: string | null
  organizationRole?: string | null
  workspaceRole?: string | null
  billingType?: string
  hasExtraUsageEnabled?: boolean
  accountCreatedAt?: string
  subscriptionCreatedAt?: string
  vaultFilePath?: string
}

interface ClaudePoolState {
  accounts: ClaudePoolAccount[]
  activeIndex: number
  initialized: boolean
}

export type ClaudeAccountResolutionMatchType = 'exact' | 'prefix'

// ── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_VAULT_PATH = join(homedir(), 'claude-vault')

// ── Singleton state ────────────────────────────────────────────────────────

const pool: ClaudePoolState = {
  accounts: [],
  activeIndex: -1,
  initialized: false,
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Read-only bootstrap: populate the pool inventory (accounts + activeIndex +
 * initialized) from the vault + keychain/config sources, WITHOUT the
 * vault-migration write `initClaudeAccountPool` performs for a config-only
 * account. This is the read-half of initClaudeAccountPool, extracted so
 * observation-only callers (e.g. the accounts-pool worker) can load the pool
 * without ever writing a credential file. Mirrors the Codex precedent,
 * `loadPoolForObservation` (`codexAccountPool.ts:171-181`).
 *
 * A config-only account (keychain/config uuid absent from the vault) is
 * still merged into the in-memory pool here — same accounts, same
 * `activeIndex`, as `initClaudeAccountPool` would produce — just without the
 * `saveClaudeTokenToVault` write and without stamping `vaultFilePath`. A
 * merged account that lacks `vaultFilePath` is exactly the signal
 * `initClaudeAccountPool` uses below to know it still owes that account a
 * vault file.
 *
 * A config-only account is indistinguishable, from data alone, between the
 * legacy pre-vault single-account case this exists to migrate, and a
 * lingering keychain/`config.oauthAccount` remnant of an account whose vault
 * file `/delete-account` just removed (`removeClaudeAccount`, below, only
 * deletes the vault file — it does not clear config or keychain). Both
 * initClaudeAccountPool and this observation path show it either way; the
 * guarantee this extraction adds is narrower and disk-only: the observation
 * path never re-creates the vault file, so a deletion is never undone on
 * disk by an unattended background read.
 *
 * Disk reads only — never writes a file. `initClaudeAccountPool` calls this
 * first and then performs its own migration write, so this refactor changes
 * no `initClaudeAccountPool` behavior.
 */
export function loadClaudePoolForObservation(): void {
  const vaultAccounts = loadVaultAccounts()
  const configAccount = loadConfigAccount()

  const byUuid = new Map<string, ClaudePoolAccount>()
  for (const acct of vaultAccounts) {
    byUuid.set(acct.accountUuid, acct)
  }

  if (configAccount && !byUuid.has(configAccount.accountUuid)) {
    // Merge in memory only — no vault write, no vaultFilePath. See doc
    // comment above.
    byUuid.set(configAccount.accountUuid, configAccount)
  } else if (configAccount && byUuid.has(configAccount.accountUuid)) {
    // Config has fresher tokens — update the vault entry in memory only.
    const existing = byUuid.get(configAccount.accountUuid)!
    existing.accessToken = configAccount.accessToken
    existing.refreshToken = configAccount.refreshToken
    existing.expiresAt = configAccount.expiresAt
    existing.scopes = configAccount.scopes
    existing.subscriptionType = configAccount.subscriptionType
    existing.rateLimitTier = configAccount.rateLimitTier
  }

  pool.accounts = Array.from(byUuid.values())
  restoreActiveClaudeAccountPointer()
  pool.initialized = true

  const healthy = pool.accounts.filter((a) => a.status === 'healthy').length
  logForDebugging(
    `[claude-pool] Loaded ${pool.accounts.length} accounts (${healthy} healthy) [observation]`,
  )
}

function restoreActiveClaudeAccountPointer(): void {
  const config = getGlobalConfig()
  const savedActiveUuid = config.activeClaudeAccountUuid
  if (savedActiveUuid) {
    const idx = pool.accounts.findIndex(
      (a) => a.accountUuid === savedActiveUuid && a.status === 'healthy',
    )
    pool.activeIndex = idx >= 0 ? idx : pool.accounts.findIndex((a) => a.status === 'healthy')
  } else {
    pool.activeIndex = pool.accounts.findIndex((a) => a.status === 'healthy')
  }
}

/**
 * Initialize the Claude account pool from vault + keychain/config fallback.
 * Migrates existing single account into vault on first run.
 */
export function initClaudeAccountPool(): void {
  try {
    loadClaudePoolForObservation()

    // The observation step above already merged a config-only account into
    // pool.accounts (in memory, no vaultFilePath). Perform the one write it
    // deliberately skips: a merged account without vaultFilePath came from
    // config, not the vault, and is the only one that can lack it (config
    // yields at most one account) — write it and stamp vaultFilePath so it
    // has a persisted vault file, same end state as before this extraction.
    const migratable = pool.accounts.find((a) => !a.vaultFilePath)
    if (migratable) {
      saveClaudeTokenToVault(migratable)
      migratable.vaultFilePath = join(getVaultAccountsDir(), `${migratable.accountUuid}.json`)
    }

    pool.initialized = true

    const healthy = pool.accounts.filter((a) => a.status === 'healthy').length
    logForDebugging(
      `[claude-pool] Loaded ${pool.accounts.length} accounts (${healthy} healthy)`,
    )
  } catch (err) {
    logForDebugging(
      `[claude-pool] Init failed: ${err instanceof Error ? err.message : String(err)}`,
      { level: 'warn' },
    )
    pool.initialized = false
  }
}

/**
 * True when the pool is initialized and has more than one account.
 * When false, the system uses the existing single-account path unchanged.
 */
export function isClaudePoolActive(): boolean {
  return (
    pool.initialized &&
    pool.accounts.filter((a) => a.status === 'healthy').length > 1
  )
}

/**
 * True when token getters should prefer the in-memory Claude pool over
 * keychain/config fallback. A multi-account pool remains the request-local token
 * source after internal failover even if only one healthy replacement remains.
 */
export function shouldUseClaudePoolTokenSource(): boolean {
  return (
    pool.initialized &&
    pool.accounts.length > 1 &&
    pool.accounts.some((a) => a.status === 'healthy')
  )
}

/** Returns the currently active Claude account, or null if pool empty. */
export function getActiveClaudeAccount(): ClaudePoolAccount | null {
  if (!pool.initialized || pool.activeIndex < 0) return null
  const acct = pool.accounts[pool.activeIndex]
  if (!acct || acct.status !== 'healthy') {
    const idx = pool.accounts.findIndex((a) => a.status === 'healthy')
    if (idx < 0) return null
    pool.activeIndex = idx
    return pool.accounts[idx]!
  }
  return acct
}

/** Returns a snapshot of the Claude pool for display. */
export function getClaudePoolStatus(): {
  accounts: readonly ClaudePoolAccount[]
  activeIndex: number
  initialized: boolean
} {
  return {
    accounts: pool.accounts,
    activeIndex: pool.activeIndex,
    initialized: pool.initialized,
  }
}

/**
 * Resolve a Claude account by prefix. Exact alias/email/UUID match wins.
 * Otherwise, gather alias/email/UUID-prefix matches and return a
 * unique/ambiguous/none verdict.
 */
export type ClaudeAccountResolution =
  | { kind: 'none' }
  | { kind: 'unique'; account: ClaudePoolAccount; matchType: ClaudeAccountResolutionMatchType }
  | { kind: 'ambiguous'; matches: ClaudePoolAccount[]; matchType: ClaudeAccountResolutionMatchType }

export function resolveClaudeAccountByPrefix(
  prefix: string,
  options?: { onlyHealthy?: boolean },
): ClaudeAccountResolution {
  const lower = prefix.toLowerCase()
  const onlyHealthy = options?.onlyHealthy === true
  const candidates = pool.accounts.filter(
    (a) => !onlyHealthy || a.status === 'healthy',
  )

  // Exact match wins (alias, email, or full uuid)
  const exact = candidates.filter(
    (a) =>
      a.alias?.toLowerCase() === lower ||
      a.emailAddress.toLowerCase() === lower ||
      a.accountUuid.toLowerCase() === lower,
  )
  if (exact.length === 1) {
    return { kind: 'unique', account: exact[0]!, matchType: 'exact' }
  }
  if (exact.length > 1) return { kind: 'ambiguous', matches: exact, matchType: 'exact' }

  // Gather prefix matches across alias/email/uuid (deduped, alias-first order)
  const seen = new Set<string>()
  const matches: ClaudePoolAccount[] = []
  for (const a of candidates) {
    if (a.alias && a.alias.toLowerCase().startsWith(lower)) {
      if (!seen.has(a.accountUuid)) {
        seen.add(a.accountUuid)
        matches.push(a)
      }
    }
  }
  for (const a of candidates) {
    if (a.emailAddress.toLowerCase().startsWith(lower)) {
      if (!seen.has(a.accountUuid)) {
        seen.add(a.accountUuid)
        matches.push(a)
      }
    }
  }
  for (const a of candidates) {
    if (a.accountUuid.toLowerCase().startsWith(lower)) {
      if (!seen.has(a.accountUuid)) {
        seen.add(a.accountUuid)
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
 * Manually switch to a specific Claude account by alias, email, or UUID prefix.
 * Pass null to rotate to the next account.
 * Returns the new active account, or null if no match, ambiguous match, or no
 * alternative. Callers that want to surface a candidate list on ambiguity
 * should call `resolveClaudeAccountByPrefix` first.
 *
 * IMPORTANT: This only updates the in-memory pool and persisted pointers.
 * The caller must also:
 *   - Call syncClaudeAccountToStorage() to update keychain + config
 *   - Call clearAuthRelatedCaches()
 *   - Call applyPostSwitchAccountStateRefresh()
 */
export function switchToClaudeAccount(idPrefix: string | null): ClaudePoolAccount | null {
  if (!pool.initialized || pool.accounts.length === 0) return null

  let targetIdx: number
  if (idPrefix) {
    const resolution = resolveClaudeAccountByPrefix(idPrefix, { onlyHealthy: true })
    if (resolution.kind !== 'unique') return null
    targetIdx = pool.accounts.indexOf(resolution.account)
    if (targetIdx < 0) return null
  } else {
    if (pool.accounts.length <= 1) return null
    // Rotate to next healthy account (simple round-robin)
    targetIdx = -1
    for (let i = 1; i < pool.accounts.length; i++) {
      const idx = (pool.activeIndex + i) % pool.accounts.length
      if (pool.accounts[idx]!.status === 'healthy') {
        targetIdx = idx
        break
      }
    }
    if (targetIdx < 0) return null
  }

  if (targetIdx === pool.activeIndex) {
    // Self-heal: persist pointer even on no-op in case config is out of sync
    saveGlobalConfig(current => ({
      ...current,
      activeClaudeAccountUuid: pool.accounts[targetIdx]!.accountUuid,
    }))
    return pool.accounts[targetIdx]!
  }

  const prev = pool.accounts[pool.activeIndex]
  logForDebugging(
    `[claude-pool] Switch: ${prev?.emailAddress ?? '?'} → ${pool.accounts[targetIdx]!.emailAddress}`,
  )
  pool.activeIndex = targetIdx

  // Persist active account pointer
  saveGlobalConfig(current => ({
    ...current,
    activeClaudeAccountUuid: pool.accounts[targetIdx]!.accountUuid,
  }))

  return pool.accounts[targetIdx]!
}

/**
 * Mark a Claude account dead and fail over in-memory without rewriting the
 * persisted active-account pointer. Internal request recovery uses this so the
 * current process can keep moving without mutating global account selection.
 */
export function failoverClaudeAccount(
  accountUuid: string,
  reason: string,
): ClaudePoolAccount | null {
  if (!pool.initialized) return null

  const failedIndex = pool.accounts.findIndex((a) => a.accountUuid === accountUuid)
  if (failedIndex < 0) return null

  const failedAccount = pool.accounts[failedIndex]!
  failedAccount.status = 'dead'

  logForDebugging(
    `[claude-pool] Internal failover marked ${failedAccount.accountUuid} dead: ${reason}` ,
    { level: 'warn' },
  )

  if (pool.activeIndex === failedIndex || pool.accounts[pool.activeIndex]?.status !== 'healthy') {
    pool.activeIndex = pool.accounts.findIndex((account, index) => index !== failedIndex && account.status === 'healthy')
  }

  return pool.activeIndex >= 0 ? pool.accounts[pool.activeIndex]! : null
}

/**
 * Add or update a Claude account in the pool + vault.
 * Called by installOAuthTokens after a successful login.
 */
export function appendClaudeAccount(account: {
  accountUuid: string
  emailAddress: string
  accessToken: string
  refreshToken: string
  expiresAt: number
  scopes?: string[]
  subscriptionType?: string | null
  rateLimitTier?: string | null
  displayName?: string
  organizationUuid?: string
  billingType?: string
  hasExtraUsageEnabled?: boolean
  accountCreatedAt?: string
  subscriptionCreatedAt?: string
  alias?: string
}): void {
  const existing = pool.accounts.findIndex(
    (a) => a.accountUuid === account.accountUuid,
  )
  if (existing >= 0) {
    // Upsert: update tokens and profile, reset status
    const acct = pool.accounts[existing]!
    acct.accessToken = account.accessToken
    acct.refreshToken = account.refreshToken
    acct.expiresAt = account.expiresAt
    acct.scopes = account.scopes
    acct.subscriptionType = account.subscriptionType
    acct.rateLimitTier = account.rateLimitTier
    acct.emailAddress = account.emailAddress
    acct.displayName = account.displayName
    acct.organizationUuid = account.organizationUuid
    acct.billingType = account.billingType
    acct.hasExtraUsageEnabled = account.hasExtraUsageEnabled
    acct.accountCreatedAt = account.accountCreatedAt
    acct.subscriptionCreatedAt = account.subscriptionCreatedAt
    acct.status = 'healthy'
    if (account.alias) acct.alias = account.alias
    logForDebugging(
      `[claude-pool] Updated existing account ${account.emailAddress}`,
    )
    // Set as active
    pool.activeIndex = existing
  } else {
    const newAcct: ClaudePoolAccount = {
      ...account,
      status: 'healthy',
    }
    pool.accounts.push(newAcct)
    const idx = pool.accounts.length - 1
    pool.activeIndex = idx
    logForDebugging(
      `[claude-pool] Appended new account ${account.emailAddress}`,
    )
  }

  pool.initialized = true

  // Save to vault
  const acct = pool.accounts[pool.activeIndex]!
  saveClaudeTokenToVault(acct)
  acct.vaultFilePath = join(getVaultAccountsDir(), `${acct.accountUuid}.json`)

  // Sync to keychain + config (also persists activeClaudeAccountUuid)
  syncClaudeAccountToStorage()
}

/**
 * Sync the active Claude pool account's tokens to keychain and profile to config.
 * Must be called after switchToClaudeAccount() so existing consumers
 * (39 files reading getClaudeAIOAuthTokens, 10 files reading config.oauthAccount)
 * see the correct data.
 */
export function syncClaudeAccountToStorage(): void {
  const acct = getActiveClaudeAccount()
  if (!acct) return

  // Update keychain
  try {
    const secureStorage = getSecureStorage()
    const storageData = secureStorage.read() || {}
    storageData.claudeAiOauth = {
      accessToken: acct.accessToken,
      refreshToken: acct.refreshToken,
      expiresAt: acct.expiresAt,
      scopes: acct.scopes,
      subscriptionType: acct.subscriptionType ?? null,
      rateLimitTier: acct.rateLimitTier ?? null,
    }
    secureStorage.update(storageData)
  } catch (err) {
    logForDebugging(
      `[claude-pool] Failed to sync tokens to keychain: ${err instanceof Error ? err.message : String(err)}`,
      { level: 'warn' },
    )
  }

  // Update config: oauthAccount profile metadata + active account pointer.
  // We write directly to GlobalConfig instead of using storeOAuthAccountInfo
  // because storeOAuthAccountInfo drops organizationName/organizationRole/workspaceRole.
  saveGlobalConfig(current => ({
    ...current,
    activeClaudeAccountUuid: acct.accountUuid,
    oauthAccount: {
      accountUuid: acct.accountUuid,
      emailAddress: acct.emailAddress,
      organizationUuid: acct.organizationUuid,
      organizationName: acct.organizationName,
      organizationRole: acct.organizationRole,
      workspaceRole: acct.workspaceRole,
      displayName: acct.displayName,
      hasExtraUsageEnabled: acct.hasExtraUsageEnabled,
      billingType: acct.billingType as any,
      accountCreatedAt: acct.accountCreatedAt,
      subscriptionCreatedAt: acct.subscriptionCreatedAt,
    },
  }))
}

/**
 * Update one pool account's tokens after a refresh.
 * Keeps the in-memory pool and vault in sync with the keychain.
 * The caller must identify the account before awaiting the refresh, because the
 * active account may change while the refresh request is in flight.
 */
export function updateClaudeAccountTokens(
  accountUuid: string,
  tokens: {
    accessToken: string
    refreshToken?: string | null
    expiresAt?: number | null
    subscriptionType?: string | null
    rateLimitTier?: string | null
  },
): void {
  if (!pool.initialized) return
  const acct = pool.accounts.find(account => account.accountUuid === accountUuid)
  if (!acct) return

  acct.accessToken = tokens.accessToken
  if (tokens.refreshToken) acct.refreshToken = tokens.refreshToken
  if (tokens.expiresAt) acct.expiresAt = tokens.expiresAt
  if (tokens.subscriptionType !== undefined) acct.subscriptionType = tokens.subscriptionType
  if (tokens.rateLimitTier !== undefined) acct.rateLimitTier = tokens.rateLimitTier

  // Write updated tokens to vault
  saveClaudeTokenToVault(acct)
  logForDebugging(`[claude-pool] Updated account tokens after refresh`)
}

/**
 * Remove a Claude account from the pool and vault.
 * If the removed account was active, switches to the next healthy one.
 */
export function removeClaudeAccount(accountUuid: string): boolean {
  const idx = pool.accounts.findIndex((a) => a.accountUuid === accountUuid)
  if (idx < 0) return false

  const acct = pool.accounts[idx]!

  // Delete vault file
  if (acct.vaultFilePath && existsSync(acct.vaultFilePath)) {
    try {
      unlinkSync(acct.vaultFilePath)
    } catch (err) {
      logForDebugging(
        `[claude-pool] Failed to delete vault file: ${err instanceof Error ? err.message : String(err)}`,
        { level: 'warn' },
      )
    }
  }

  // Remove from pool
  pool.accounts.splice(idx, 1)

  // Fix active index — always verify the pointed-to account is healthy
  if (pool.accounts.length === 0) {
    pool.activeIndex = -1
  } else if (idx === pool.activeIndex) {
    pool.activeIndex = pool.accounts.findIndex((a) => a.status === 'healthy')
  } else if (idx < pool.activeIndex) {
    pool.activeIndex--
    // After shift, verify the account is still healthy
    if (pool.accounts[pool.activeIndex]?.status !== 'healthy') {
      pool.activeIndex = pool.accounts.findIndex((a) => a.status === 'healthy')
    }
  }

  // Persist new active pointer
  const active = pool.accounts[pool.activeIndex]
  saveGlobalConfig(current => ({
    ...current,
    activeClaudeAccountUuid: active?.accountUuid,
  }))

  logForDebugging(`[claude-pool] Removed account ${acct.emailAddress}`)
  return true
}

/**
 * Update the alias for a Claude vault account.
 */
export function setClaudeAccountAlias(accountUuid: string, alias: string): boolean {
  const acct = pool.accounts.find((a) => a.accountUuid === accountUuid)
  if (!acct?.vaultFilePath) return false

  try {
    const existing = JSON.parse(readFileSync(acct.vaultFilePath, 'utf-8')) as Record<string, unknown>
    existing.alias = alias
    const dir = acct.vaultFilePath.split('/').slice(0, -1).join('/')
    const tmp = `${dir}/.${Date.now()}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(existing, null, 2) + '\n', 'utf-8')
    renameSync(tmp, acct.vaultFilePath)
    acct.alias = alias
    logForDebugging(`[claude-pool] Set alias "${alias}" for ${acct.emailAddress}`)
    return true
  } catch (err) {
    logForDebugging(
      `[claude-pool] Failed to set alias: ${err instanceof Error ? err.message : String(err)}`,
      { level: 'warn' },
    )
    return false
  }
}

// ── Vault helpers ─────────────────────────────────────────────────────────

// Test-only redirect so tests never read or write the operator's real
// ~/claude-vault. undefined means "use DEFAULT_VAULT_PATH" (production).
let vaultPathOverrideForTest: string | undefined

function getVaultAccountsDir(): string {
  return join(vaultPathOverrideForTest ?? DEFAULT_VAULT_PATH, 'accounts')
}

function saveClaudeTokenToVault(account: ClaudePoolAccount): void {
  try {
    const accountsDir = getVaultAccountsDir()
    mkdirSync(accountsDir, { recursive: true })

    const filePath = join(accountsDir, `${account.accountUuid}.json`)
    const data: Record<string, unknown> = {
      tokens: {
        access_token: account.accessToken,
        refresh_token: account.refreshToken,
        expires_at: account.expiresAt,
        scopes: account.scopes,
        subscription_type: account.subscriptionType,
        rate_limit_tier: account.rateLimitTier,
      },
      profile: {
        account_uuid: account.accountUuid,
        email_address: account.emailAddress,
        display_name: account.displayName,
        organization_uuid: account.organizationUuid,
        billing_type: account.billingType,
        has_extra_usage_enabled: account.hasExtraUsageEnabled,
        account_created_at: account.accountCreatedAt,
        subscription_created_at: account.subscriptionCreatedAt,
        organization_name: account.organizationName,
        organization_role: account.organizationRole,
        workspace_role: account.workspaceRole,
      },
      last_refresh: new Date().toISOString(),
    }
    if (account.alias) data.alias = account.alias
    writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8')
    logForDebugging(`[claude-pool] Saved account ${account.emailAddress} to vault`)
  } catch (err) {
    logForDebugging(
      `[claude-pool] Failed to save account to vault: ${err instanceof Error ? err.message : String(err)}`,
      { level: 'warn' },
    )
  }
}

function loadVaultAccounts(): ClaudePoolAccount[] {
  const accountsDir = getVaultAccountsDir()

  if (!existsSync(accountsDir)) {
    return []
  }

  const results: ClaudePoolAccount[] = []
  let files: string[]
  try {
    files = readdirSync(accountsDir).filter((f) => f.endsWith('.json'))
  } catch {
    return []
  }

  for (const file of files) {
    try {
      const filePath = join(accountsDir, file)
      const raw = readFileSync(filePath, 'utf-8')
      const data = JSON.parse(raw) as Record<string, unknown>
      const tokens = data.tokens as Record<string, unknown> | undefined
      const profile = data.profile as Record<string, unknown> | undefined

      if (!tokens?.access_token || !tokens.refresh_token || !profile?.account_uuid || !profile?.email_address) {
        logForDebugging(`[claude-pool] Skipping ${file}: missing required fields`)
        continue
      }

      // Check health by last_refresh
      const lastRefresh = data.last_refresh as string | undefined
      const status = checkAccountHealth(lastRefresh)

      results.push({
        accountUuid: String(profile.account_uuid),
        emailAddress: String(profile.email_address),
        accessToken: String(tokens.access_token),
        refreshToken: String(tokens.refresh_token),
        expiresAt: typeof tokens.expires_at === 'number' ? tokens.expires_at : 0,
        scopes: Array.isArray(tokens.scopes) ? tokens.scopes as string[] : undefined,
        subscriptionType: tokens.subscription_type as string | null ?? null,
        rateLimitTier: tokens.rate_limit_tier as string | null ?? null,
        status,
        alias: typeof data.alias === 'string' && data.alias ? data.alias : undefined,
        displayName: typeof profile.display_name === 'string' ? profile.display_name : undefined,
        organizationUuid: typeof profile.organization_uuid === 'string' ? profile.organization_uuid : undefined,
        organizationName: typeof profile.organization_name === 'string' ? profile.organization_name : undefined,
        organizationRole: typeof profile.organization_role === 'string' ? profile.organization_role : undefined,
        workspaceRole: typeof profile.workspace_role === 'string' ? profile.workspace_role : undefined,
        billingType: typeof profile.billing_type === 'string' ? profile.billing_type : undefined,
        hasExtraUsageEnabled: typeof profile.has_extra_usage_enabled === 'boolean' ? profile.has_extra_usage_enabled : undefined,
        accountCreatedAt: typeof profile.account_created_at === 'string' ? profile.account_created_at : undefined,
        subscriptionCreatedAt: typeof profile.subscription_created_at === 'string' ? profile.subscription_created_at : undefined,
        vaultFilePath: filePath,
      })
    } catch (err) {
      logForDebugging(
        `[claude-pool] Failed to load vault account ${file}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
  return results
}

// Test-only override so tests never read the operator's real macOS keychain
// (loadConfigAccount's primary source, via getSecureStorage()). `active:
// false` means "use the real read" (production); when active, `value` is
// returned as-is, bypassing keychain/config entirely.
let configAccountOverrideForTest: { active: boolean; value: ClaudePoolAccount | null } = {
  active: false,
  value: null,
}

function loadConfigAccount(): ClaudePoolAccount | null {
  if (configAccountOverrideForTest.active) return configAccountOverrideForTest.value
  try {
    const secureStorage = getSecureStorage()
    const storageData = secureStorage.read()
    const oauthData = storageData?.claudeAiOauth
    if (!oauthData?.accessToken || !oauthData?.refreshToken) return null

    const config = getGlobalConfig()
    const profile = config.oauthAccount
    if (!profile?.accountUuid || !profile?.emailAddress) return null

    return {
      accountUuid: profile.accountUuid,
      emailAddress: profile.emailAddress,
      accessToken: oauthData.accessToken,
      refreshToken: oauthData.refreshToken,
      expiresAt: oauthData.expiresAt ?? 0,
      scopes: oauthData.scopes,
      subscriptionType: oauthData.subscriptionType ?? null,
      rateLimitTier: oauthData.rateLimitTier ?? null,
      // Check if access token is expired — refresh will fix it on first use,
      // but mark as dead if there's no refresh token to recover with
      status: oauthData.expiresAt && oauthData.expiresAt < Date.now() && !oauthData.refreshToken ? 'dead' : 'healthy',
      displayName: profile.displayName,
      organizationUuid: profile.organizationUuid,
      organizationName: profile.organizationName,
      organizationRole: profile.organizationRole,
      workspaceRole: profile.workspaceRole,
      billingType: profile.billingType,
      hasExtraUsageEnabled: profile.hasExtraUsageEnabled,
      accountCreatedAt: profile.accountCreatedAt,
      subscriptionCreatedAt: profile.subscriptionCreatedAt,
    }
  } catch {
    return null
  }
}

function checkAccountHealth(lastRefresh: string | undefined): 'healthy' | 'dead' {
  if (!lastRefresh) return 'healthy'
  const refreshMs = new Date(lastRefresh).getTime()
  const daysSinceRefresh = (Date.now() - refreshMs) / (1000 * 60 * 60 * 24)
  return daysSinceRefresh > 7 ? 'dead' : 'healthy'
}

export function seedClaudeAccountPoolForTest({
  accounts,
  activeAccountUuid,
}: {
  accounts: ClaudePoolAccount[]
  activeAccountUuid?: string
}): void {
  pool.accounts = accounts.map((account) => ({ ...account }))
  pool.initialized = true

  if (activeAccountUuid) {
    pool.activeIndex = pool.accounts.findIndex(
      (account) => account.accountUuid === activeAccountUuid,
    )
  } else {
    pool.activeIndex = pool.accounts.findIndex(
      (account) => account.status === 'healthy',
    )
  }
}

/**
 * Test-only: redirect the vault directory (`<path>/accounts/*.json`) so
 * loadClaudePoolForObservation()/initClaudeAccountPool() tests never touch
 * the operator's real ~/claude-vault. Pass undefined to restore the default.
 */
export function setClaudeVaultPathForTest(path: string | undefined): void {
  vaultPathOverrideForTest = path
}

/**
 * Test-only: force loadConfigAccount()'s result so tests never read the
 * operator's real macOS keychain. Call with `active: false` to restore the
 * real read.
 */
export function setClaudeConfigAccountForTest(
  override: { active: true; value: ClaudePoolAccount | null } | { active: false },
): void {
  configAccountOverrideForTest = override.active
    ? { active: true, value: override.value }
    : { active: false, value: null }
}

export function resetClaudeAccountPoolForTest(): void {
  pool.accounts = []
  pool.activeIndex = -1
  pool.initialized = false
  vaultPathOverrideForTest = undefined
  configAccountOverrideForTest = { active: false, value: null }
}
