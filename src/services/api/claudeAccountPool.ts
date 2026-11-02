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

import { chmodSync, readFileSync, readdirSync, existsSync, mkdirSync, unlinkSync } from 'fs'
import { dirname, join } from 'path'
import { homedir } from 'os'

import { logForDebugging } from '../../utils/debug.js'
import { getSecureStorage, removeMatchingClaudeOAuthCredentials } from '../../utils/secureStorage/index.js'
import { saveGlobalConfig, getGlobalConfig } from '../../utils/config.js'
import { writeFileAtomicDurableSync } from '../../utils/atomicFile.js'
import { acquireMutationLockSync } from '../../utils/lockfile.js'
import { clearOAuthTokenCache } from '../../utils/auth.js'
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
  lifecycleGeneration?: number
}

interface ClaudePoolState {
  accounts: ClaudePoolAccount[]
  activeIndex: number
  initialized: boolean
}

export type ClaudeAccountResolutionMatchType = 'exact' | 'prefix'

// ── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_VAULT_PATH = join(homedir(), 'claude-vault')
const VAULT_LOCK_WAIT_MS = 10_000

// Keep this authority after unlinking credentials. The vault mutation lock
// serializes its generation with deletion, refresh publication and explicit login.
function readLifecycle(filePath: string): { generation: number; deleted: boolean } {
  try {
    const value = JSON.parse(readFileSync(`${filePath}.lifecycle`, 'utf8'))
    if (!Number.isSafeInteger(value.generation) || value.generation < 0 ||
        typeof value.deleted !== 'boolean') throw new Error('Invalid Claude credential lifecycle')
    return value
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return { generation: 0, deleted: false }
    throw error
  }
}

function isCredentialCurrent(account: Pick<ClaudePoolAccount, 'accountUuid' | 'lifecycleGeneration' | 'vaultFilePath'>): boolean {
  const filePath = account.vaultFilePath ?? join(getVaultAccountsDir(), `${account.accountUuid}.json`)
  try {
    const lifecycle = readLifecycle(filePath)
    if (lifecycle.deleted || lifecycle.generation !== (account.lifecycleGeneration ?? 0)) return false
    if (!existsSync(filePath)) return !account.vaultFilePath && lifecycle.generation === 0
    // Explicit login publishes the vault and lifecycle separately. A visible
    // vault from the next generation is not a successfully committed login.
    const vault = JSON.parse(readFileSync(filePath, 'utf8'))
    return (vault.lifecycle_generation ?? 0) === lifecycle.generation
  } catch {
    return false
  }
}

/** Shared fallback must not bypass a durable deletion fence. */
export function isClaudeAccountDeleted(accountUuid: string): boolean {
  try {
    return readLifecycle(join(getVaultAccountsDir(), `${accountUuid}.json`)).deleted
  } catch {
    return true
  }
}

export function getClaudeCredentialGeneration(accountUuid: string): number | null {
  try {
    const lifecycle = readLifecycle(join(getVaultAccountsDir(), `${accountUuid}.json`))
    return lifecycle.deleted || !isCredentialCurrent({ accountUuid, lifecycleGeneration: lifecycle.generation })
      ? null : lifecycle.generation
  } catch {
    return null
  }
}

/** Bind a captured token to its supplying generation, not a later login. */
export function captureClaudeCredentialGeneration(accountUuid: string, accessToken: string): number | null {
  const account = pool.accounts.find(candidate => candidate.accountUuid === accountUuid)
  if (pool.initialized) {
    return account && account.accessToken === accessToken && isCredentialCurrent(account)
      ? account.lifecycleGeneration ?? 0
      : null
  }
  const generation = getClaudeCredentialGeneration(accountUuid)
  if (generation === null || !isCredentialCurrent({ accountUuid, lifecycleGeneration: generation })) return null
  const filePath = join(getVaultAccountsDir(), `${accountUuid}.json`)
  if (!existsSync(filePath)) return generation === 0 ? generation : null
  try {
    const vault = JSON.parse(readFileSync(filePath, 'utf8'))
    return vault.tokens?.access_token === accessToken ? generation : null
  } catch {
    return null
  }
}

/** Serialize credential publication or send initiation with deletion and login. */
export function withClaudeCredentialGeneration<T>(
  accountUuid: string,
  generation: number,
  publish: () => T,
): T | null {
  const filePath = join(getVaultAccountsDir(), `${accountUuid}.json`)
  mkdirSync(getVaultAccountsDir(), { recursive: true, mode: 0o700 })
  const release = acquireVaultMutationLockSync(filePath)
  try {
    if (!isCredentialCurrent({ accountUuid, lifecycleGeneration: generation })) return null
    return publish()
  } finally {
    release()
  }
}

function acquireVaultMutationLockSync(filePath: string): () => void {
  return acquireMutationLockSync(filePath, {
    label: '[claude-pool] Vault',
    waitMs: VAULT_LOCK_WAIT_MS,
  })
}

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
 * Each vault account owns its credentials. Keychain tokens
 * and config identity are written separately and can describe different
 * accounts, so their combination must never overwrite a vault credential.
 * A config-only account may supplement the vault only with a bound identity.
 * An unbound legacy account is accepted only before the first vault migration;
 * `initClaudeAccountPool` performs that write separately.
 */
export function loadClaudePoolForObservation(): void {
  const selectedUuid = getActiveClaudeAccount()?.accountUuid
  const vaultAccounts = loadVaultAccounts()
  for (const account of pool.accounts) {
    const superseded = pendingTokenWrites.get(account.accountUuid)
    if (!superseded) continue
    if (!isCredentialCurrent(account)) {
      pendingTokenWrites.delete(account.accountUuid)
      continue
    }
    const index = vaultAccounts.findIndex(candidate => candidate.accountUuid === account.accountUuid)
    const disk = vaultAccounts[index]
    if (disk && disk.accessToken !== account.accessToken && !superseded.has(disk.accessToken) &&
        disk.expiresAt > account.expiresAt) {
      pendingTokenWrites.delete(account.accountUuid)
    } else if (index >= 0) vaultAccounts[index] = account
    else vaultAccounts.push(account)
  }
  const configAccount = loadConfigAccount(vaultAccounts.length > 0)
  pool.accounts = vaultAccounts
  if (configAccount && !vaultAccounts.some(account => account.accountUuid === configAccount.accountUuid)) {
    pool.accounts.push(configAccount)
  }
  if (pool.initialized) {
    pool.activeIndex = pool.accounts.findIndex(
      account => account.accountUuid === selectedUuid && account.status === 'healthy',
    )
  } else {
    restoreActiveClaudeAccountPointer()
  }
  pool.initialized = true
  clearOAuthTokenCache()

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
      const vaultFilePath = saveClaudeTokenToVault(migratable)
      if (vaultFilePath) migratable.vaultFilePath = vaultFilePath
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
 * An initialized inventory owns credentials even when none are usable.
 * Exhaustion must not fall back to another session's shared credentials.
 */
export function shouldUseClaudePoolTokenSource(): boolean {
  return pool.initialized
}

export type ClaudeTokenPersistenceResult = 'durable' | 'pending'
// Retain issued credentials until a local write succeeds. Known superseded tokens
// must never win a later disk reread, even when expiry timestamps are identical.
const pendingTokenWrites = new Map<string, Set<string>>()

export function retryClaudeAccountTokenPersistence(accountUuid: string): ClaudeTokenPersistenceResult {
  const account = pool.accounts.find(candidate => candidate.accountUuid === accountUuid)
  if (!account) return 'pending'
  if (!isCredentialCurrent(account)) return 'pending'
  if (!pendingTokenWrites.has(accountUuid)) return 'durable'
  const result = saveClaudeTokenToVault(account) ? 'durable' : 'pending'
  clearOAuthTokenCache()
  return result
}

export function reloadClaudeAccountCredentials(accountUuid: string): void {
  const account = pool.accounts.find(candidate => candidate.accountUuid === accountUuid)
  if (account && !isCredentialCurrent(account)) {
    account.status = 'dead'
    pendingTokenWrites.delete(accountUuid)
    clearOAuthTokenCache()
    return
  }
  if (!account?.vaultFilePath) return
  const fresh = loadVaultAccounts().find(candidate => candidate.accountUuid === accountUuid)
  if (!fresh) return
  const superseded = pendingTokenWrites.get(accountUuid)
  if (superseded && (superseded.has(fresh.accessToken) ||
      (fresh.accessToken !== account.accessToken && fresh.expiresAt <= account.expiresAt))) return
  if (fresh.accessToken !== account.accessToken) pendingTokenWrites.delete(accountUuid)
  account.accessToken = fresh.accessToken
  account.refreshToken = fresh.refreshToken
  account.expiresAt = fresh.expiresAt
  account.scopes = fresh.scopes
  account.subscriptionType = fresh.subscriptionType
  account.rateLimitTier = fresh.rateLimitTier
  clearOAuthTokenCache()
}

/** Reload credentials for the selected identity without adopting disk selection. */
export function reloadActiveClaudeAccountCredentials(): void {
  const account = getActiveClaudeAccount()
  if (account) reloadClaudeAccountCredentials(account.accountUuid)
}

/** Returns the currently active Claude account, or null if pool empty. */
export function getActiveClaudeAccount(): ClaudePoolAccount | null {
  if (!pool.initialized || pool.activeIndex < 0) return null
  const acct = pool.accounts[pool.activeIndex]
  if (acct && !isCredentialCurrent(acct)) {
    return null
  }
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
 * Validate a known target for an intentional account selection. Only explicit
 * selection may adopt a newer login generation; ordinary credential reads deny it.
 * A same-generation local health failure is not reset by selecting it again.
 */
export function prepareClaudeAccountForSelection(accountUuid: string): ClaudePoolAccount | null {
  const account = pool.accounts.find(candidate => candidate.accountUuid === accountUuid)
  if (!account) return null
  if (isCredentialCurrent(account)) return account.status === 'healthy' ? account : null
  const generation = getClaudeCredentialGeneration(accountUuid)
  if (generation === null || generation <= (account.lifecycleGeneration ?? 0)) return null
  const filePath = account.vaultFilePath ?? join(getVaultAccountsDir(), `${accountUuid}.json`)
  let release: (() => void) | undefined
  try {
    release = acquireVaultMutationLockSync(filePath)
    const fresh = loadVaultAccounts(accountUuid).find(candidate => candidate.accountUuid === accountUuid)
    if (!fresh || (fresh.lifecycleGeneration ?? 0) <= (account.lifecycleGeneration ?? 0) ||
        !isCredentialCurrent(fresh)) return null
    pendingTokenWrites.delete(accountUuid)
    Object.assign(account, fresh)
    clearOAuthTokenCache()
    return account
  } catch {
    return null
  } finally {
    release?.()
  }
}

/**
 * Manually switch to a specific Claude account by alias, email, or UUID prefix.
 * Pass null to rotate to the next account.
 * Returns the new active account, or null if no match, ambiguous match, or no
 * alternative. Callers that want to surface a candidate list on ambiguity
 * should call `resolveClaudeAccountByPrefix` first.
 *
 * This low-level operation persists the new-process default unless opted out.
 * Session switches should use commitClaudeAccountSwitch for local selection
 * and the associated cache and engine-state refresh.
 */
export function switchToClaudeAccount(
  idPrefix: string | null,
  { persistDefault = true }: { persistDefault?: boolean } = {},
): ClaudePoolAccount | null {
  if (!pool.initialized || pool.accounts.length === 0) return null

  let targetIdx: number
  if (idPrefix) {
    const resolution = resolveClaudeAccountByPrefix(idPrefix)
    if (resolution.kind !== 'unique') return null
    if (!prepareClaudeAccountForSelection(resolution.account.accountUuid)) return null
    targetIdx = pool.accounts.indexOf(resolution.account)
    if (targetIdx < 0) return null
  } else {
    if (pool.accounts.length <= 1) return null
    // Rotate to next healthy account (simple round-robin)
    targetIdx = -1
    for (let i = 1; i < pool.accounts.length; i++) {
      const idx = (pool.activeIndex + i) % pool.accounts.length
      if (prepareClaudeAccountForSelection(pool.accounts[idx]!.accountUuid)) {
        targetIdx = idx
        break
      }
    }
    if (targetIdx < 0) return null
  }

  if (targetIdx === pool.activeIndex) {
    // Self-heal: persist pointer even on no-op in case config is out of sync
    if (persistDefault) saveGlobalConfig(current => ({
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
  clearOAuthTokenCache()

  // Persist active account pointer
  if (persistDefault) saveGlobalConfig(current => ({
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
  const superseded = pendingTokenWrites.get(account.accountUuid) ?? new Set<string>()
  const previous = pool.accounts.find(candidate => candidate.accountUuid === account.accountUuid)
  if (previous && previous.accessToken !== account.accessToken) superseded.add(previous.accessToken)
  pendingTokenWrites.set(account.accountUuid, superseded)
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
  const vaultFilePath = saveClaudeTokenToVault(acct, true)
  if (vaultFilePath) acct.vaultFilePath = vaultFilePath

  // Sync to keychain + config (also persists activeClaudeAccountUuid)
  if (vaultFilePath) syncClaudeAccountToStorage()
  // Explicit login can retain the existing bound secure-storage recovery path
  // when the vault is unavailable. It does not remove a durable deletion fence.
  else {
    if (!isCredentialCurrent(acct)) {
      throw new Error('Failed to save Claude sign-in. Restore vault access and sign in again.')
    }
    syncClaudeAccountToStorageLocked(acct)
  }
}

/**
 * Persist shared login/default state to keychain and config. Session switches
 * must not call this: their tokens and effective profile stay process-local.
 */
export function syncClaudeAccountToStorage(): void {
  const acct = getActiveClaudeAccount()
  if (!acct) return
  const filePath = acct.vaultFilePath ?? join(getVaultAccountsDir(), `${acct.accountUuid}.json`)
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 })
  const release = acquireVaultMutationLockSync(filePath)
  try {
    if (!isCredentialCurrent(acct)) throw new Error('Claude account credentials are no longer available.')
    syncClaudeAccountToStorageLocked(acct)
  } finally {
    release()
  }
}

function syncClaudeAccountToStorageLocked(acct: ClaudePoolAccount): void {
  // Update keychain
  try {
    const secureStorage = getSecureStorage()
    const storageData = secureStorage.read() || {}
    storageData.claudeAiOauth = {
      accountUuid: acct.accountUuid,
      accessToken: acct.accessToken,
      refreshToken: acct.refreshToken,
      expiresAt: acct.expiresAt,
      scopes: acct.scopes,
      subscriptionType: acct.subscriptionType ?? null,
      rateLimitTier: acct.rateLimitTier ?? null,
    }
    const result = secureStorage.update(storageData)
    if (!result.success) throw new Error('Credential write failed')
    clearOAuthTokenCache()
    const saved = secureStorage.read()?.claudeAiOauth
    if (saved?.accountUuid !== acct.accountUuid ||
        saved.accessToken !== acct.accessToken || saved.refreshToken !== acct.refreshToken) {
      throw new Error('Credential read-back did not match')
    }
  } catch (err) {
    logForDebugging(
      `[claude-pool] Failed to sync tokens to keychain: ${err instanceof Error ? err.message : String(err)}`,
      { level: 'warn' },
    )
    throw new Error('Failed to save Claude account credentials. Try switching accounts again.')
  }

  // Update config: oauthAccount profile metadata + active account pointer.
  // We write directly to GlobalConfig instead of using storeOAuthAccountInfo
  // because storeOAuthAccountInfo drops organizationName/organizationRole/workspaceRole.
  if (!saveGlobalConfig(current => ({
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
  }))) throw new Error('Failed to save Claude account selection. Try again.')
}

/**
 * Update one pool account's tokens after a refresh.
 * Keeps the in-memory pool and account vault in sync without changing the
 * shared login/default credentials.
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
  expected?: { accessToken: string; refreshToken: string | null },
): ClaudeTokenPersistenceResult | 'superseded' | 'unavailable' {
  if (!pool.initialized) return 'unavailable'
  const acct = pool.accounts.find(account => account.accountUuid === accountUuid)
  if (!acct || acct.status !== 'healthy') return 'unavailable'
  if (!isCredentialCurrent(acct)) return 'unavailable'
  if (expected && (acct.accessToken !== expected.accessToken ||
      acct.refreshToken !== expected.refreshToken)) return 'superseded'

  const superseded = pendingTokenWrites.get(accountUuid) ?? new Set<string>()
  if (acct.accessToken !== tokens.accessToken) superseded.add(acct.accessToken)
  pendingTokenWrites.set(accountUuid, superseded)
  acct.accessToken = tokens.accessToken
  if (tokens.refreshToken) acct.refreshToken = tokens.refreshToken
  if (tokens.expiresAt) acct.expiresAt = tokens.expiresAt
  if (tokens.subscriptionType !== undefined) acct.subscriptionType = tokens.subscriptionType
  if (tokens.rateLimitTier !== undefined) acct.rateLimitTier = tokens.rateLimitTier

  // Write updated tokens to vault
  const saved = saveClaudeTokenToVault(acct)
  clearOAuthTokenCache()
  if (!isCredentialCurrent(acct)) return 'unavailable'
  return saved ? 'durable' : 'pending'
}

/** Store roles for the request's account without republishing its credentials. */
export function updateClaudeAccountRoles(
  accountUuid: string,
  roles: Required<Pick<ClaudePoolAccount, 'organizationRole' | 'workspaceRole' | 'organizationName'>>,
  organizationUuid?: string,
): void {
  if (!pool.initialized) return
  const account = pool.accounts.find(account => account.accountUuid === accountUuid)
  if (!account || account.organizationUuid !== organizationUuid) return
  Object.assign(account, roles)
  if (!account.vaultFilePath) return

  let releaseLock: (() => void) | undefined
  try {
    releaseLock = acquireVaultMutationLockSync(account.vaultFilePath)
    const existing = JSON.parse(readFileSync(account.vaultFilePath, 'utf8'))
    if (!isCredentialCurrent(account)) return
    if (existing.profile?.account_uuid !== accountUuid ||
        existing.profile?.organization_uuid !== organizationUuid) return
    existing.profile = {
      ...existing.profile,
      organization_role: roles.organizationRole,
      workspace_role: roles.workspaceRole,
      organization_name: roles.organizationName,
    }
    writeFileAtomicDurableSync(account.vaultFilePath, JSON.stringify(existing, null, 2) + '\n', {
      encoding: 'utf-8',
      mode: 0o600,
    })
  } finally {
    releaseLock?.()
  }
}

export function deleteClaudeVaultFile(filePath: string): boolean {
  let releaseLock: (() => void) | undefined
  try {
    releaseLock = acquireVaultMutationLockSync(filePath)
    return deleteClaudeVaultFileLocked(filePath)
  } catch (error) {
    logForDebugging(`[claude-pool] Vault deletion failed: ${error}`, { level: 'warn' })
    return false
  } finally {
    releaseLock?.()
  }
}

function deleteClaudeVaultFileLocked(filePath: string): boolean {
  try {
    const lifecycle = readLifecycle(filePath)
    if (!lifecycle.deleted) writeFileAtomicDurableSync(`${filePath}.lifecycle`, JSON.stringify({
      generation: lifecycle.generation + 1,
      deleted: true,
    }), { encoding: 'utf-8', mode: 0o600 })
    try { unlinkSync(filePath) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    for (const account of pool.accounts) {
      if (account.vaultFilePath === filePath) pendingTokenWrites.delete(account.accountUuid)
    }
    return true
  } catch (err) {
    logForDebugging(
      `[claude-pool] Failed to delete vault file: ${err instanceof Error ? err.message : String(err)}`,
      { level: 'warn' },
    )
    return false
  }
}

/**
 * Remove a Claude account from the pool and vault.
 * If the removed account was active, switches to the next healthy one.
 */
export function removeClaudeAccount(accountUuid: string): boolean {
  const account = pool.accounts.find(candidate => candidate.accountUuid === accountUuid)
  if (!account) return false
  const filePath = account.vaultFilePath ?? join(getVaultAccountsDir(), `${accountUuid}.json`)
  let release: (() => void) | undefined
  try {
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 })
    release = acquireVaultMutationLockSync(filePath)
    const lifecycle = readLifecycle(filePath)
    const generation = account.lifecycleGeneration ?? 0
    const retryDeletion = lifecycle.deleted && lifecycle.generation === generation + 1
    if (!retryDeletion && !isCredentialCurrent(account)) return false
    if (existsSync(filePath)) {
      const existing = JSON.parse(readFileSync(filePath, 'utf8'))
      if (existing.profile?.account_uuid !== accountUuid) return false
    }
    return removeClaudeAccountLocked(accountUuid)
  } catch (error) {
    logForDebugging(`[claude-pool] Account deletion failed: ${error}`, { level: 'warn' })
    return false
  } finally {
    release?.()
  }
}

function removeClaudeAccountLocked(accountUuid: string): boolean {
  const idx = pool.accounts.findIndex((a) => a.accountUuid === accountUuid)
  if (idx < 0) return false

  const acct = pool.accounts[idx]!

  // Match tokens independently of profile metadata: the shared fallback may
  // already belong to a replacement account. UUID alone cannot identify tokens.
  try {
    if (!removeMatchingClaudeOAuthCredentials(acct)) {
      logForDebugging('[claude-pool] Failed to persist deleted account credential cleanup', { level: 'warn' })
      return false
    }
    clearOAuthTokenCache()
  } catch (error) {
    logForDebugging(`[claude-pool] Failed to clear deleted account credentials: ${error}`, { level: 'warn' })
    return false
  }

  const remaining = pool.accounts.filter((_, index) => index !== idx)
  let nextActiveIndex = pool.activeIndex
  if (remaining.length === 0) {
    nextActiveIndex = -1
  } else if (idx === pool.activeIndex) {
    nextActiveIndex = remaining.findIndex(a => a.status === 'healthy')
  } else if (idx < pool.activeIndex) {
    nextActiveIndex--
    if (remaining[nextActiveIndex]?.status !== 'healthy') {
      nextActiveIndex = remaining.findIndex(a => a.status === 'healthy')
    }
  }

  // Do this before deleting the vault so failed durable cleanup remains retryable.
  if (!saveGlobalConfig(current => ({
    ...current,
    oauthAccount: current.oauthAccount?.accountUuid === accountUuid
      ? undefined
      : current.oauthAccount,
    activeClaudeAccountUuid: current.activeClaudeAccountUuid === accountUuid
      ? undefined
      : current.activeClaudeAccountUuid,
  }))) {
    logForDebugging('[claude-pool] Failed to persist deleted account profile cleanup', { level: 'warn' })
    return false
  }

  // Delete vault file
  const filePath = acct.vaultFilePath ?? join(getVaultAccountsDir(), `${accountUuid}.json`)
  if (!deleteClaudeVaultFileLocked(filePath)) return false

  // Remove from pool
  pendingTokenWrites.delete(accountUuid)
  pool.accounts.splice(idx, 1)

  pool.activeIndex = nextActiveIndex

  logForDebugging(`[claude-pool] Removed account ${acct.emailAddress}`)
  return true
}

/**
 * Update the alias for a Claude vault account.
 */
export function setClaudeAccountAlias(accountUuid: string, alias: string): boolean {
  const acct = pool.accounts.find((a) => a.accountUuid === accountUuid)
  if (!acct?.vaultFilePath) return false

  let releaseLock: (() => void) | undefined
  try {
    releaseLock = acquireVaultMutationLockSync(acct.vaultFilePath)
    const existing = JSON.parse(readFileSync(acct.vaultFilePath, 'utf-8')) as Record<string, unknown>
    if (!isCredentialCurrent(acct)) return false
    existing.alias = alias
    writeFileAtomicDurableSync(
      acct.vaultFilePath,
      JSON.stringify(existing, null, 2) + '\n',
      {
      encoding: 'utf-8',
      mode: 0o600,
      },
    )
    chmodSync(acct.vaultFilePath, 0o600)
    acct.alias = alias
    logForDebugging(`[claude-pool] Set alias "${alias}" for ${acct.emailAddress}`)
    return true
  } catch (err) {
    logForDebugging(
      `[claude-pool] Failed to set alias: ${err instanceof Error ? err.message : String(err)}`,
      { level: 'warn' },
    )
    return false
  } finally {
    releaseLock?.()
  }
}

// ── Vault helpers ─────────────────────────────────────────────────────────

// Test-only redirect so tests never read or write the operator's real
// ~/claude-vault. undefined means "use DEFAULT_VAULT_PATH" (production).
let vaultPathOverrideForTest: string | undefined

function getVaultAccountsDir(): string {
  return join(vaultPathOverrideForTest ?? DEFAULT_VAULT_PATH, 'accounts')
}

function saveClaudeTokenToVault(account: ClaudePoolAccount, explicitLogin = false): string | null {
  let releaseLock: (() => void) | undefined
  try {
    const accountsDir = getVaultAccountsDir()
    mkdirSync(accountsDir, { recursive: true, mode: 0o700 })
    chmodSync(accountsDir, 0o700)

    const filePath = join(accountsDir, `${account.accountUuid}.json`)
    releaseLock = acquireVaultMutationLockSync(filePath)
    const lifecycle = readLifecycle(filePath)
    const generation = explicitLogin ? lifecycle.generation + 1 : lifecycle.generation
    if (!explicitLogin && (lifecycle.deleted || lifecycle.generation !== (account.lifecycleGeneration ?? 0) ||
        (account.vaultFilePath && !existsSync(filePath)))) {
      pendingTokenWrites.delete(account.accountUuid)
      return null
    }
    const existing = existsSync(filePath)
      ? (JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>)
      : {}
    const diskProfile = existing.profile as Record<string, unknown> | undefined
    if (diskProfile?.account_uuid && diskProfile.account_uuid !== account.accountUuid) return null
    const diskTokens = existing.tokens as Record<string, unknown> | undefined
    const superseded = pendingTokenWrites.get(account.accountUuid)
    if (explicitLogin && superseded && typeof diskTokens?.access_token === 'string' &&
        diskTokens.access_token !== account.accessToken) superseded.add(diskTokens.access_token)
    if (superseded && typeof diskTokens?.access_token === 'string' &&
        diskTokens.access_token !== account.accessToken &&
        !superseded.has(diskTokens.access_token)) {
      // Different alone does not establish ordering. Do not overwrite either
      // credential when the external expiry supplies no evidence of advancement.
      if (diskProfile?.account_uuid !== account.accountUuid ||
          typeof diskTokens.refresh_token !== 'string' || !diskTokens.refresh_token ||
          typeof diskTokens.expires_at !== 'number' || !Number.isFinite(diskTokens.expires_at) ||
          diskTokens.expires_at <= account.expiresAt) return null
      account.accessToken = diskTokens.access_token
      account.refreshToken = diskTokens.refresh_token
      account.expiresAt = diskTokens.expires_at
      pendingTokenWrites.delete(account.accountUuid)
      return filePath
    }
    const data: Record<string, unknown> = {
      ...existing,
      lifecycle_generation: generation,
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
    try {
      writeFileAtomicDurableSync(filePath, JSON.stringify(data, null, 2) + '\n', {
        encoding: 'utf-8', mode: 0o600,
      })
    } catch {
      // Atomic publication may have completed before a cleanup error. Reconcile
      // while holding the same mutation lock, not by replaying token redemption.
      const actual = JSON.parse(readFileSync(filePath, 'utf8'))
      if (actual.profile?.account_uuid === account.accountUuid &&
          actual.tokens?.access_token === account.accessToken &&
          actual.tokens?.refresh_token === account.refreshToken) {
        account.vaultFilePath = filePath
      }
      // Visibility is not proof of directory durability. Keep the issued
      // credentials pending until a later local durable write completes.
      return null
    }
    if (explicitLogin) {
      writeFileAtomicDurableSync(`${filePath}.lifecycle`, JSON.stringify({
        generation,
        deleted: false,
      }), { encoding: 'utf-8', mode: 0o600 })
      account.lifecycleGeneration = generation
    }
    pendingTokenWrites.delete(account.accountUuid)
    logForDebugging(`[claude-pool] Saved account ${account.emailAddress} to vault`)
    return filePath
  } catch (err) {
    logForDebugging(
      '[claude-pool] Credential persistence pending; free disk space or restore vault access and retry.',
      { level: 'warn' },
    )
    return null
  } finally {
    releaseLock?.()
  }
}

function loadVaultAccounts(accountUuid?: string): ClaudePoolAccount[] {
  const accountsDir = getVaultAccountsDir()

  if (!existsSync(accountsDir)) {
    return []
  }

  try {
    chmodSync(accountsDir, 0o700)
  } catch (err) {
    logForDebugging(
      `[claude-pool] Failed to restrict vault directory: ${err instanceof Error ? err.message : String(err)}`,
      { level: 'warn' },
    )
  }

  const results: ClaudePoolAccount[] = []
  let files: string[]
  try {
    files = readdirSync(accountsDir).filter((f) =>
      f.endsWith('.json') && (accountUuid === undefined || f === `${accountUuid}.json`),
    )
  } catch {
    return []
  }

  for (const file of files) {
    try {
      const filePath = join(accountsDir, file)
      const raw = readFileSync(filePath, 'utf-8')
      const data = JSON.parse(raw) as Record<string, unknown>
      const lifecycle = readLifecycle(filePath)
      if (lifecycle.deleted || (data.lifecycle_generation ?? 0) !== lifecycle.generation) continue
      try {
        chmodSync(filePath, 0o600)
      } catch (err) {
        logForDebugging(
          `[claude-pool] Failed to restrict vault file ${file}: ${err instanceof Error ? err.message : String(err)}`,
          { level: 'warn' },
        )
      }
      const tokens = data.tokens as Record<string, unknown> | undefined
      const profile = data.profile as Record<string, unknown> | undefined

      if (!tokens?.access_token || !tokens.refresh_token || !profile?.account_uuid || !profile?.email_address) {
        logForDebugging(`[claude-pool] Skipping ${file}: missing required fields`)
        continue
      }

      results.push({
        accountUuid: String(profile.account_uuid),
        emailAddress: String(profile.email_address),
        accessToken: String(tokens.access_token),
        refreshToken: String(tokens.refresh_token),
        expiresAt: typeof tokens.expires_at === 'number' ? tokens.expires_at : 0,
        scopes: Array.isArray(tokens.scopes) ? tokens.scopes as string[] : undefined,
        subscriptionType: tokens.subscription_type as string | null ?? null,
        rateLimitTier: tokens.rate_limit_tier as string | null ?? null,
        status: 'healthy',
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
        lifecycleGeneration: lifecycle.generation,
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

function loadConfigAccount(requireBoundIdentity = false): ClaudePoolAccount | null {
  if (configAccountOverrideForTest.active) return configAccountOverrideForTest.value
  try {
    const secureStorage = getSecureStorage()
    const storageData = secureStorage.read()
    const oauthData = storageData?.claudeAiOauth
    if (!oauthData?.accessToken || !oauthData?.refreshToken) return null

    const config = getGlobalConfig()
    const profile = config.oauthAccount
    if (!profile?.accountUuid || !profile?.emailAddress) return null
    const lifecycleGeneration = getClaudeCredentialGeneration(profile.accountUuid)
    if (lifecycleGeneration === null) return null
    if (requireBoundIdentity && !oauthData.accountUuid) return null
    if (oauthData.accountUuid !== undefined && oauthData.accountUuid !== profile.accountUuid) return null

    return {
      accountUuid: profile.accountUuid,
      lifecycleGeneration,
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
  pendingTokenWrites.clear()
  pool.accounts = []
  pool.activeIndex = -1
  pool.initialized = false
  vaultPathOverrideForTest = undefined
  configAccountOverrideForTest = { active: false, value: null }
}
