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
import { randomUUID } from 'crypto'
import {
  readClaudeAccountAuthority, migrateClaudeAccountAuthority, commitClaudeLogin,
  captureClaudeCredentialHandle, withClaudeCredentialSend, deleteClaudeAccountAuthority,
  setClaudeAuthorityVaultPathForTest, claimClaudeRefresh, markClaudeRefreshDispatched,
  completeClaudeRefresh,
  retryClaudeAuthorityPersistence,
  updateClaudeAuthorityProfile,
  acquireClaudeAccountMutationLock,
  ClaudeLoginInstallationError,
  type ClaudeAuthorityResult,
} from './claudeAccountAuthority.js'

import { logForDebugging } from '../../utils/debug.js'
import { getSecureStorage, removeMatchingClaudeOAuthCredentials } from '../../utils/secureStorage/index.js'
import { saveGlobalConfig, getGlobalConfig } from '../../utils/config.js'
import { writeFileAtomicDurableSync } from '../../utils/atomicFile.js'
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
  credentialRevision?: number
  loginOperationId?: string
}

interface ClaudePoolState {
  accounts: ClaudePoolAccount[]
  activeIndex: number
  initialized: boolean
  selectedIdentity: { accountId: string; generation: number } | null
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
  const authority = readClaudeAccountAuthority(account.accountUuid)
  if (authority.status !== 'missing') return authority.status === 'ready' &&
    authority.handle.generation === (account.lifecycleGeneration ?? 0)
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
  const authority = readClaudeAccountAuthority(accountUuid)
  if (authority.status !== 'missing') return authority.status !== 'ready'
  try {
    return readLifecycle(join(getVaultAccountsDir(), `${accountUuid}.json`)).deleted
  } catch {
    return true
  }
}

export function getClaudeCredentialGeneration(accountUuid: string): number | null {
  const authority = readClaudeAccountAuthority(accountUuid)
  if (authority.status !== 'missing') return authority.status === 'ready' ? authority.handle.generation : null
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
  const authority = readClaudeAccountAuthority(accountUuid)
  if (authority.status !== 'missing') return captureClaudeCredentialHandle(accountUuid, accessToken)?.generation ?? null
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
  const authority = readClaudeAccountAuthority(accountUuid)
  if (authority.status !== 'missing') return authority.status === 'ready' && authority.handle.generation === generation
    ? withClaudeCredentialSend(authority.handle, publish) : null
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
  return acquireClaudeAccountMutationLock(filePath.split('/').pop()!.replace(/\.json$/, ''), VAULT_LOCK_WAIT_MS)
}

// ── Singleton state ────────────────────────────────────────────────────────

const pool: ClaudePoolState = {
  accounts: [],
  activeIndex: -1,
  initialized: false,
  selectedIdentity: null,
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
  const selectedUuid = pool.selectedIdentity?.accountId ?? getActiveClaudeAccount()?.accountUuid
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
    if (disk && (disk.credentialRevision ?? 0) > (account.credentialRevision ?? 0)) {
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
    const selected = pool.accounts[pool.activeIndex]
    pool.selectedIdentity = selected ? { accountId: selected.accountUuid, generation: selected.lifecycleGeneration ?? 0 } : null
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
      (a) => a.accountUuid === savedActiveUuid,
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
    if (existsSync(getVaultAccountsDir())) {
      chmodSync(getVaultAccountsDir(), 0o700)
      for (const file of readdirSync(getVaultAccountsDir()).filter(file => file.endsWith('.json'))) {
        const accountId = file.slice(0, -5)
        const authority = migrateClaudeAccountAuthority(accountId)
        if ('record' in authority && authority.record.pendingLogin) {
          const pending = authority.record.pendingLogin
          // Recovery may finish credentials, not replay account selection over
          // a deliberate default. Only fill an absent default while pending.
          if (saveGlobalConfig(current => ({
            ...current, activeClaudeAccountUuid: current.activeClaudeAccountUuid ?? accountId,
          }))) retryClaudeAuthorityPersistence(accountId, pending.operationId)
        }
      }
    }
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
  if ((fresh.credentialRevision ?? 0) < (account.credentialRevision ?? 0)) return
  if (fresh.accessToken !== account.accessToken) pendingTokenWrites.delete(accountUuid)
  account.accessToken = fresh.accessToken
  account.refreshToken = fresh.refreshToken
  account.expiresAt = fresh.expiresAt
  account.scopes = fresh.scopes
  account.subscriptionType = fresh.subscriptionType
  account.rateLimitTier = fresh.rateLimitTier
  account.credentialRevision = fresh.credentialRevision
  clearOAuthTokenCache()
}

/** Reload credentials for the selected identity without adopting disk selection. */
export function reloadActiveClaudeAccountCredentials(): void {
  const account = getActiveClaudeAccount()
  if (account) reloadClaudeAccountCredentials(account.accountUuid)
}

/** Returns the currently active Claude account, or null if pool empty. */
export function getSelectedClaudeAccountIdentity(): { accountId: string; generation: number } | null {
  return pool.selectedIdentity ? { ...pool.selectedIdentity } : null
}

export function getActiveClaudeAccount(): ClaudePoolAccount | null {
  if (!pool.initialized || pool.activeIndex < 0) return null
  const acct = pool.accounts[pool.activeIndex]
  if (acct && pool.selectedIdentity && (acct.accountUuid !== pool.selectedIdentity.accountId ||
      (acct.lifecycleGeneration ?? 0) !== pool.selectedIdentity.generation)) return null
  if (acct && !isCredentialCurrent(acct)) {
    return null
  }
  if (!acct || acct.status !== 'healthy') {
    const idx = pool.accounts.findIndex((a) => a.status === 'healthy')
    if (idx < 0) return null
    pool.activeIndex = idx
    pool.selectedIdentity = { accountId: pool.accounts[idx]!.accountUuid, generation: pool.accounts[idx]!.lifecycleGeneration ?? 0 }
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
export function prepareClaudeAccountForSelection(accountUuid: string, expectedLoginGeneration?: number): ClaudePoolAccount | null {
  const account = pool.accounts.find(candidate => candidate.accountUuid === accountUuid)
  if (!account) return null
  if (expectedLoginGeneration === undefined && !account.vaultFilePath && isCredentialCurrent(account)) {
    return account.status === 'healthy' ? account : null
  }
  const filePath = account.vaultFilePath ?? join(getVaultAccountsDir(), `${accountUuid}.json`)
  let release: (() => void) | undefined
  try {
    release = acquireVaultMutationLockSync(filePath)
    const generation = getClaudeCredentialGeneration(accountUuid)
    if (expectedLoginGeneration !== undefined && generation !== expectedLoginGeneration) return null
    if (isCredentialCurrent(account)) return account.status === 'healthy' ? account : null
    if (generation === null || generation <= (account.lifecycleGeneration ?? 0)) return null
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
  { persistDefault = true, expectedLoginGeneration }: { persistDefault?: boolean; expectedLoginGeneration?: number } = {},
): ClaudePoolAccount | null {
  if (!pool.initialized || pool.accounts.length === 0) return null

  let targetIdx: number
  if (idPrefix) {
    const resolution = resolveClaudeAccountByPrefix(idPrefix)
    if (resolution.kind !== 'unique') return null
    if (!prepareClaudeAccountForSelection(resolution.account.accountUuid, expectedLoginGeneration)) return null
    targetIdx = pool.accounts.indexOf(resolution.account)
    if (targetIdx < 0) return null
  } else {
    if (pool.accounts.length <= 1) return null
    // Rotate to next healthy account (simple round-robin)
    targetIdx = -1
    for (let i = 1; i < pool.accounts.length; i++) {
      const idx = (pool.activeIndex + i) % pool.accounts.length
      if (prepareClaudeAccountForSelection(pool.accounts[idx]!.accountUuid, expectedLoginGeneration)) {
        targetIdx = idx
        break
      }
    }
    if (targetIdx < 0) return null
  }

  pool.selectedIdentity = { accountId: pool.accounts[targetIdx]!.accountUuid, generation: pool.accounts[targetIdx]!.lifecycleGeneration ?? 0 }
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
    const selected = pool.accounts[pool.activeIndex]
    pool.selectedIdentity = selected ? { accountId: selected.accountUuid, generation: selected.lifecycleGeneration ?? 0 } : null
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
}, options: { operationId?: string } = {}): ClaudeAuthorityResult {
  const previous = pool.accounts.find(candidate => candidate.accountUuid === account.accountUuid)
  const next: ClaudePoolAccount = { ...previous, ...account, status: 'healthy' }
  let installation: ClaudeAuthorityResult | undefined
  const vaultFilePath = saveClaudeTokenToVault(next, true, options.operationId, result => { installation = result })
  if (!vaultFilePath) {
    if (installation) throw new ClaudeLoginInstallationError(installation)
    throw new Error('Failed to save Claude sign-in. Restore vault access and retry saving.')
  }
  next.vaultFilePath = vaultFilePath
  const existing = pool.accounts.findIndex(candidate => candidate.accountUuid === account.accountUuid)
  if (existing >= 0) {
    pool.accounts[existing] = next
    pool.activeIndex = existing
  } else {
    pool.accounts.push(next)
    pool.activeIndex = pool.accounts.length - 1
  }
  pool.initialized = true
  pool.selectedIdentity = { accountId: next.accountUuid, generation: next.lifecycleGeneration ?? 0 }
  clearOAuthTokenCache()
  // Mirrors are repairable projections, never the authority commit boundary.
  let selectionCommitted = true
  let mirrorRepairPending = false
  try {
    syncClaudeAccountToStorage()
    selectionCommitted = getGlobalConfig().activeClaudeAccountUuid === next.accountUuid
  } catch {
    mirrorRepairPending = true
    logForDebugging('[claude-pool] Login committed; mirror repair pending.', { level: 'warn' })
    try {
      selectionCommitted = saveGlobalConfig(current => ({
        ...current, activeClaudeAccountUuid: next.accountUuid,
        oauthAccount: {
          accountUuid: next.accountUuid, emailAddress: next.emailAddress,
          organizationUuid: next.organizationUuid, displayName: next.displayName,
          organizationName: next.organizationName, organizationRole: next.organizationRole,
          workspaceRole: next.workspaceRole, hasExtraUsageEnabled: next.hasExtraUsageEnabled,
          billingType: next.billingType as any, accountCreatedAt: next.accountCreatedAt,
          subscriptionCreatedAt: next.subscriptionCreatedAt,
        },
      })) && getGlobalConfig().activeClaudeAccountUuid === next.accountUuid
    } catch { selectionCommitted = false }
  }
  return {
    outcome: selectionCommitted ? 'committed' : 'persistence_pending', operationId: next.loginOperationId!,
    restartRecoverable: true,
    credentialCommitted: true, selectionCommitted, mirrorRepairPending,
    handle: Object.freeze({ accountId: next.accountUuid, generation: next.lifecycleGeneration!, revision: next.credentialRevision! }),
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
  const authority = readClaudeAccountAuthority(accountUuid)
  if (authority.status === 'ready' && authority.handle.revision !== (acct.credentialRevision ?? 0)) {
    reloadClaudeAccountCredentials(accountUuid)
    return 'superseded'
  }
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
  const authority = readClaudeAccountAuthority(accountUuid)
  if (authority.status !== 'missing') {
    if (authority.status === 'ready' && authority.handle.generation === (account.lifecycleGeneration ?? 0)) {
      updateClaudeAuthorityProfile(authority.handle, {
        organization_role: roles.organizationRole, workspace_role: roles.workspaceRole, organization_name: roles.organizationName,
      })
    }
    return
  }

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
  const authority = readClaudeAccountAuthority(filePath.split('/').pop()!.replace(/\.json$/, ''))
  if (authority.status !== 'missing') {
    if (authority.status === 'deleted') return true
    return 'handle' in authority && deleteClaudeAccountAuthority(authority.handle).outcome === 'committed'
  }
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
    const accountId = filePath.split('/').pop()!.replace(/\.json$/, '')
    const authority = readClaudeAccountAuthority(accountId)
    if (authority.status !== 'missing') {
      if (authority.status === 'deleted') return true
      if (!('handle' in authority)) return false
      return deleteClaudeAccountAuthority(authority.handle).outcome === 'committed'
    }
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
  const authority = readClaudeAccountAuthority(accountUuid)
  if (authority.status !== 'missing') {
    if (!('handle' in authority)) return false
    if (authority.status !== 'deleted') {
      if (authority.handle.generation !== (account.lifecycleGeneration ?? 0) ||
          deleteClaudeAccountAuthority(authority.handle).outcome !== 'committed') return false
    } else if (authority.handle.generation !== (account.lifecycleGeneration ?? 0) + 1) return false
    return removeClaudeAccountLocked(accountUuid)
  }
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
  if (pool.selectedIdentity?.accountId === accountUuid) {
    const selected = pool.accounts[nextActiveIndex]
    pool.selectedIdentity = selected ? { accountId: selected.accountUuid, generation: selected.lifecycleGeneration ?? 0 } : null
  }

  logForDebugging(`[claude-pool] Removed account ${acct.emailAddress}`)
  return true
}

/**
 * Update the alias for a Claude vault account.
 */
export function setClaudeAccountAlias(accountUuid: string, alias: string): boolean {
  const acct = pool.accounts.find((a) => a.accountUuid === accountUuid)
  if (!acct?.vaultFilePath) return false
  const authority = readClaudeAccountAuthority(accountUuid)
  if (authority.status !== 'missing') {
    if (authority.status !== 'ready' || authority.handle.generation !== (acct.lifecycleGeneration ?? 0)) return false
    if (updateClaudeAuthorityProfile(authority.handle, { alias }).outcome !== 'committed') return false
    acct.alias = alias
    return true
  }

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

function saveClaudeTokenToVault(account: ClaudePoolAccount, explicitLogin = false, loginOperationId?: string,
  onLoginResult?: (result: ClaudeAuthorityResult) => void): string | null {
  const pendingRefresh = pendingRefreshOperations.get(account.accountUuid)
  if (!explicitLogin && pendingRefresh) {
    const out = retryClaudeAuthorityPersistence(account.accountUuid, pendingRefresh)
    if (out.outcome !== 'committed' || !out.handle) return null
    account.credentialRevision = out.handle.revision
    pendingRefreshOperations.delete(account.accountUuid)
    pendingTokenWrites.delete(account.accountUuid)
    return join(getVaultAccountsDir(), `${account.accountUuid}.json`)
  }
  const profile = {
    account_uuid: account.accountUuid, email_address: account.emailAddress,
    display_name: account.displayName, organization_uuid: account.organizationUuid,
    alias: account.alias,
    organization_name: account.organizationName, organization_role: account.organizationRole,
    workspace_role: account.workspaceRole, billing_type: account.billingType,
    has_extra_usage_enabled: account.hasExtraUsageEnabled, account_created_at: account.accountCreatedAt,
    subscription_created_at: account.subscriptionCreatedAt,
  }
  const credentials = { accessToken: account.accessToken, refreshToken: account.refreshToken,
    expiresAt: account.expiresAt, scopes: account.scopes,
    subscriptionType: account.subscriptionType, rateLimitTier: account.rateLimitTier }
  if (explicitLogin) {
    const operationId = loginOperationId ?? randomUUID()
    const out = commitClaudeLogin(account.accountUuid, operationId, credentials, profile)
    onLoginResult?.(out)
    if (out.outcome !== 'committed' || !out.handle) return null
    account.lifecycleGeneration = out.handle.generation
    account.credentialRevision = out.handle.revision
    account.loginOperationId = out.operationId
  } else {
    let read = readClaudeAccountAuthority(account.accountUuid)
    if (read.status === 'missing') {
      read = migrateClaudeAccountAuthority(account.accountUuid, { credentials, profile })
    }
    if (read.status !== 'ready' || read.handle.generation !== (account.lifecycleGeneration ?? 0) ||
        read.handle.revision !== (account.credentialRevision ?? 0)) return null
    if (read.record.credentials?.accessToken !== account.accessToken) {
      const op = randomUUID()
      const claimed = claimClaudeRefresh(read.handle, op, op)
      if (!claimed.claim || markClaudeRefreshDispatched(claimed.claim).outcome !== 'committed') return null
      const out = completeClaudeRefresh(claimed.claim, credentials)
      if (out.outcome !== 'committed' || !out.handle) {
        if (out.outcome === 'persistence_pending') pendingRefreshOperations.set(account.accountUuid, op)
        return null
      }
      account.credentialRevision = out.handle.revision
    }
  }
  pendingTokenWrites.delete(account.accountUuid)
  return join(getVaultAccountsDir(), `${account.accountUuid}.json`)
}
const pendingRefreshOperations = new Map<string, string>()

function loadVaultAccounts(accountUuid?: string): ClaudePoolAccount[] {
  const accountsDir = getVaultAccountsDir()

  if (!existsSync(accountsDir)) {
    return []
  }

  const results: ClaudePoolAccount[] = []
  let files: string[]
  try {
    const authorityDir = join(vaultPathOverrideForTest ?? DEFAULT_VAULT_PATH, 'authority-v1')
    files = [...new Set([...readdirSync(accountsDir),
      ...(existsSync(authorityDir) ? readdirSync(authorityDir) : [])])].filter((f) =>
      f.endsWith('.json') && (accountUuid === undefined || f === `${accountUuid}.json`),
    )
  } catch {
    return []
  }

  for (const file of files) {
    try {
      const filePath = join(accountsDir, file)
      const authority = readClaudeAccountAuthority(file.slice(0, -5))
      if (authority.status !== 'missing') {
        if ('record' in authority && (authority.record.profile || authority.record.pendingLogin?.profile)) {
          const r = authority.record
          const p = r.profile ?? r.pendingLogin?.profile ?? {}
          const ready = authority.status === 'ready'
          results.push({
            accountUuid: r.accountId, emailAddress: String(p.email_address ?? ''),
            ...(ready ? r.credentials! : { accessToken: '', refreshToken: '', expiresAt: 0 }),
            status: ready ? 'healthy' : 'dead', vaultFilePath: filePath,
            lifecycleGeneration: r.loginGeneration, credentialRevision: r.credentialRevision,
            alias: typeof p.alias === 'string' ? p.alias : undefined,
            displayName: typeof p.display_name === 'string' ? p.display_name : undefined,
            organizationUuid: typeof p.organization_uuid === 'string' ? p.organization_uuid : undefined,
            organizationName: p.organization_name as string | null | undefined,
            organizationRole: p.organization_role as string | null | undefined,
            workspaceRole: p.workspace_role as string | null | undefined,
            billingType: p.billing_type as string | undefined,
            hasExtraUsageEnabled: p.has_extra_usage_enabled as boolean | undefined,
            accountCreatedAt: p.account_created_at as string | undefined,
            subscriptionCreatedAt: p.subscription_created_at as string | undefined,
          })
        }
        continue
      }
      const raw = readFileSync(filePath, 'utf-8')
      const data = JSON.parse(raw) as Record<string, unknown>
      const lifecycle = readLifecycle(filePath)
      if (lifecycle.deleted || (data.lifecycle_generation ?? 0) !== lifecycle.generation) continue
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
  const selected = pool.accounts[pool.activeIndex]
  pool.selectedIdentity = selected ? { accountId: selected.accountUuid, generation: selected.lifecycleGeneration ?? 0 } : null
}

/**
 * Test-only: redirect the vault directory (`<path>/accounts/*.json`) so
 * loadClaudePoolForObservation()/initClaudeAccountPool() tests never touch
 * the operator's real ~/claude-vault. Pass undefined to restore the default.
 */
export function setClaudeVaultPathForTest(path: string | undefined): void {
  vaultPathOverrideForTest = path
  setClaudeAuthorityVaultPathForTest(path)
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
  setClaudeAuthorityVaultPathForTest(undefined)
  pendingRefreshOperations.clear()
  pendingTokenWrites.clear()
  pool.accounts = []
  pool.activeIndex = -1
  pool.initialized = false
  pool.selectedIdentity = null
  vaultPathOverrideForTest = undefined
  configAccountOverrideForTest = { active: false, value: null }
}
