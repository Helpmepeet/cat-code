import {
  appendAccount,
  initAccountPool,
  getPoolStatus,
  loadConfigAccount,
  describeCodexAccountAvailability,
  getVaultPath,
  markAccountDead,
  saveCodexTokenToVault,
  type PoolAccount,
} from '../services/api/codexAccountPool.js'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { createHash, randomUUID } from 'crypto'
import * as lockfile from '../utils/lockfile.js'
import { getClaudeConfigHomeDir } from '../utils/envUtils.js'
import { getGlobalClaudeFile } from '../utils/env.js'
import {
  CodexTokenRefreshError,
  refreshCodexToken,
} from '../services/oauth/codex-client.js'
import {
  classifyRefreshTransportError,
  CodexRefreshLifecycleError,
  ReauthenticationRequiredError,
  refreshAccountTokens,
} from '../services/api/codexTokenRefresh.js'
import { getCodexOAuthTokens, saveCodexOAuthTokens } from '../utils/auth.js'
import { logForDebugging } from '../utils/debug.js'
import { CodexCoreError } from './errors.js'
import { isWithinCodexRefreshSkew } from '../constants/codex-oauth.js'
import { emitAccountDiagnostic } from '../services/api/accountDiagnostics.js'
import {
  CODEX_CREDENTIAL_LIFECYCLE_DIRECTORY,
  createCodexCredentialLifecycle,
  type CodexCredentialLifecycle,
  type CodexCredentialLifecyclePermit,
  type CodexCredentialLifecycleReadResult,
} from '../services/api/codexCredentialLifecycle.js'

export type CodexCoreAccount = {
  accountId: string
  accessToken: string
  refreshToken: string
  expiresAt: number
  credentialGeneration: number
  profile: string
  source: PoolAccount['source'] | 'config'
  alias?: string
  vaultFilePath?: string
}


export async function resolveCodexCoreAccount(
  accountProfile: string,
): Promise<CodexCoreAccount> {
  const profile = accountProfile.trim()
  if (!profile) {
    throw new CodexCoreError('invalid_request', 'accountProfile is required')
  }

  await initAccountPool()

  const poolStatus = getPoolStatus()
  const match = findAccount(poolStatus.accounts, profile)
  if (match) {
    const availability = describeCodexAccountAvailability(match)
    if (match.status === 'quarantined') {
      throw new CodexCoreError(
        'backend',
        `Codex account "${profile}": ${availability}`,
        { status: 503 },
      )
    }
    if (match.status === 'capped') {
      throw new CodexCoreError(
        'quota',
        `Codex account "${profile}": ${availability}`,
        { status: 429 },
      )
    }
    if (match.status === 'dead') {
      throw new CodexCoreError(
        'auth',
        `Codex account "${profile}": ${availability}`,
        { status: 401 },
      )
    }
    return maybeRefreshAccount({
      accountId: match.accountId,
      accessToken: match.accessToken,
      refreshToken: match.refreshToken,
      expiresAt: match.expiresAt,
      credentialGeneration: match.credentialGeneration,
      profile,
      source: match.source,
      alias: match.alias,
      vaultFilePath: match.vaultFilePath,
    })
  }

  if (poolStatus.accounts.length === 0) {
    const configAccount = loadConfigAccount()
    if (configAccount && matchesProfile(profile, configAccount.accountId, undefined)) {
      return maybeRefreshAccount({
        accountId: configAccount.accountId,
        accessToken: configAccount.accessToken,
        refreshToken: configAccount.refreshToken,
        expiresAt: configAccount.expiresAt,
        credentialGeneration: configAccount.credentialGeneration,
        profile,
        source: 'config',
      })
    }
  }

  throw new CodexCoreError(
    'account_not_found',
    `No Codex account/profile matched "${profile}". Use an account alias or account ID prefix.`,
  )
}

/**
 * Outcome of a redemption pre-flight token refresh (§7.1).
 * `ok` carries the possibly-rotated token; `reauth` degrades the account to
 * "re-login required" (disabled); `transient` degrades it to "reset
 * availability unknown" but keeps the flow going for other accounts.
 */
export type PreflightRefreshOutcome =
  | { kind: 'ok'; accountId: string; accessToken: string; expiresAt: number }
  | { kind: 'reauth'; message: string }
  | { kind: 'transient'; message: string }

/**
 * Token pre-flight for the usage-reset redeem dialog (Slice 3, §7.1).
 *
 * Reuses codex-core's dual-path refresh (`maybeRefreshAccount` → stateful vault
 * refresh when a vault file exists, else raw-under-lock) rather than forking its
 * rotation/ledger machinery, and inherits the repo's TOKEN_REFRESH_SKEW_MS
 * near-expiry threshold. `profile` is only used for logging/error strings, so it
 * is synthesized from the pool account's alias/id.
 *
 * Never throws: refresh failures are returned as `reauth`/`transient` so the
 * dialog can degrade one account without aborting the whole flow.
 */
export async function refreshPoolAccountForRedeem(
  account: Pick<
    PoolAccount,
    | 'accountId'
    | 'accessToken'
    | 'refreshToken'
    | 'expiresAt'
    | 'credentialGeneration'
    | 'source'
    | 'alias'
    | 'vaultFilePath'
  >,
): Promise<PreflightRefreshOutcome> {
  const coreAccount: CodexCoreAccount = {
    accountId: account.accountId,
    accessToken: account.accessToken,
    refreshToken: account.refreshToken,
    expiresAt: account.expiresAt,
    credentialGeneration: account.credentialGeneration,
    profile: account.alias ?? account.accountId,
    source: account.source,
    alias: account.alias,
    vaultFilePath: account.vaultFilePath,
  }
  try {
    const refreshed = await maybeRefreshAccount(coreAccount)
    return {
      kind: 'ok',
      accountId: refreshed.accountId,
      accessToken: refreshed.accessToken,
      expiresAt: refreshed.expiresAt,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (error instanceof CodexCoreError && error.code === 'auth') {
      return { kind: 'reauth', message }
    }
    return { kind: 'transient', message }
  }
}

function findAccount(
  accounts: readonly PoolAccount[],
  profile: string,
): PoolAccount | undefined {
  const exact = accounts.find(account => matchesProfile(profile, account.accountId, account.alias, true))
  if (exact) return exact
  return accounts.find(account => matchesProfile(profile, account.accountId, account.alias))
}

function matchesProfile(
  profile: string,
  accountId: string,
  alias?: string,
  exact = false,
): boolean {
  const lower = profile.toLowerCase()
  const lowerId = accountId.toLowerCase()
  const lowerAlias = alias?.toLowerCase()
  if (exact) {
    return lower === lowerId || lower === lowerAlias
  }
  return lowerId.startsWith(lower) || lowerAlias?.startsWith(lower) === true
}

/**
 * In-process single-flight per account credential generation. A refresh from an
 * old credential generation must not join work for a newly logged-in account.
 */
const pendingAccountRefreshes = new Map<string, Promise<CodexCoreAccount>>()

/** True when the token needs a refresh (same condition the guard below used). */
function isWithinRefreshSkew(expiresAt: number): boolean {
  return isWithinCodexRefreshSkew(expiresAt)
}

function refreshPendingKey(accountId: string, credentialGeneration: number): string {
  return `${accountId}\u0000${credentialGeneration}`
}

export async function maybeRefreshAccount(
  account: CodexCoreAccount,
  options: {
    force?: boolean
    lifecycle?: CodexCredentialLifecycle
  } = {},
): Promise<CodexCoreAccount> {
  if (!account.refreshToken) {
    return account
  }
  // The expiry-skew gate is the NORMAL (refresh-on-use) optimization. A forced
  // refresh — withRetry's post-401 recovery — must bypass it: a 401 can be a
  // server-side revoke/rotate on a token that is still locally fresh, so the
  // skew check would otherwise no-op and strand the dead token. Forcing still
  // flows through refreshAccountNow, inheriting the vault-vs-raw dispatch,
  // in-process single-flight dedup, and DR-2 cross-process safety unchanged.
  if (!options.force && !isWithinRefreshSkew(account.expiresAt)) {
    return account
  }

  const pendingKey = refreshPendingKey(
    account.accountId,
    account.credentialGeneration,
  )
  const pending = pendingAccountRefreshes.get(pendingKey)
  if (pending) {
    return { ...(await pending), profile: account.profile }
  }
  const refresh = refreshAccountNow(account, options.lifecycle).finally(() => {
    if (pendingAccountRefreshes.get(pendingKey) === refresh) {
      pendingAccountRefreshes.delete(pendingKey)
    }
  })
  pendingAccountRefreshes.set(pendingKey, refresh)
  return refresh
}

async function refreshAccountNow(
  account: CodexCoreAccount,
  lifecycle?: CodexCredentialLifecycle,
): Promise<CodexCoreAccount> {
  try {
    logForDebugging(
      `[codex-profile] core-refresh-start writer=codex-core.maybeRefreshAccount profile=${account.profile} account=${account.accountId} source=${account.source} expires_at=${String(account.expiresAt)}`,
    )
    const usedStatefulRefresh = Boolean(
      account.vaultFilePath && existsSync(account.vaultFilePath),
    )
    let refreshed: {
      accountId: string
      accessToken: string
      refreshToken: string
      expiresAt: number
      idToken?: string
    }
    let savedVaultPath = account.vaultFilePath
    let refreshedCredentialGeneration = account.credentialGeneration
    if (usedStatefulRefresh) {
      // Cross-process safety is owned by refreshAccountTokens itself
      // (proper-lockfile on the vault file + rotated-token recovery).
      const statefulRefresh = await refreshAccountTokens(
        account.accountId,
        account.refreshToken,
        account.vaultFilePath!,
        account.credentialGeneration,
      )
      if (statefulRefresh.status === 'identity_mismatch') {
        throw new CodexCoreError(
          'auth',
          `Failed to refresh Codex account "${account.profile}". Please re-login.`,
        )
      }
      refreshed = statefulRefresh
      refreshedCredentialGeneration = statefulRefresh.credentialGeneration
    } else {
      // Raw refresh rotates the refresh token with no protection of its own;
      // serialize refresh-and-persist across processes (DR-2).
      const outcome = await refreshRawUnderCrossProcessLock(account, lifecycle)
      if (outcome.kind === 'adopted') {
        logForDebugging(
          `[codex-profile] core-refresh-adopted writer=codex-core.maybeRefreshAccount profile=${account.profile} account=${account.accountId} source=${account.source} reason=another-process-rotated`,
        )
        return outcome.account
      }
      if (outcome.kind === 'identity_mismatch') {
        throw new CodexCoreError(
          'auth',
          `Failed to refresh Codex account "${account.profile}". Please re-login.`,
          { status: 401 },
        )
      }
      refreshed = outcome.refreshed
      savedVaultPath = outcome.savedVaultPath ?? savedVaultPath
      refreshedCredentialGeneration = outcome.credentialGeneration
    }
    const sameAccount = refreshed.accountId === account.accountId
    const next = {
      accountId: refreshed.accountId,
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      expiresAt: refreshed.expiresAt,
      credentialGeneration: sameAccount
        ? refreshedCredentialGeneration
        : 0,
      profile: account.profile,
      source: account.source,
      alias: sameAccount ? account.alias : undefined,
      vaultFilePath: sameAccount ? savedVaultPath : undefined,
    }
    logForDebugging(
      `[codex-profile] core-refresh-done writer=codex-core.maybeRefreshAccount profile=${account.profile} before_account=${account.accountId} after_account=${refreshed.accountId} result=${sameAccount ? 'same-account' : 'changed-account'}`,
    )
    return next
  } catch (error) {
    if (error instanceof CodexCoreError) {
      throw error
    }
    if (error instanceof ReauthenticationRequiredError) {
      throw new CodexCoreError(
        'auth',
        `Failed to refresh Codex account "${account.profile}". Please re-login.`,
        { status: 401, cause: error },
      )
    }
    if (error instanceof CodexRefreshLifecycleError) {
      throw new CodexCoreError(
        'auth',
        `Failed to refresh Codex account "${account.profile}". Please re-login.`,
        { status: 401, cause: error },
      )
    }
    throw new CodexCoreError(
      'backend',
      `Failed to refresh Codex account "${account.profile}" because the server could not be reached. Retrying may recover automatically.`,
      { status: 503, cause: error },
    )
  }
}

/* ── DR-2: cross-process serialization for the raw refresh branch ─────────────
 *
 * Codex refresh ROTATES the refresh token; the pre-rotation token dies
 * server-side (and its reuse can trip OAuth reuse detection). The stateful
 * vault path (refreshAccountTokens) already serializes refresh-and-persist
 * across processes AND records durable attempt state so a crash mid-rotation
 * is recoverable. This section gives the raw branch — config-source accounts
 * and pool accounts without a vault file — the same two guarantees:
 *
 *  1. an advisory lockfile around [re-read stores → adopt or refresh →
 *     persist], so N live processes spend each rotation exactly once;
 *  2. a durable per-account attempt LEDGER written BEFORE any network I/O
 *     (in_flight → idle | unknown | reauth_required), so a process that dies
 *     or fails to persist AFTER the server rotated leaves a record. The next
 *     process then probes the possibly-burned token ONCE (mirroring the
 *     stateful path's unknown/quarantine semantics) and converts a definitive
 *     invalid_grant into a terminal re-login verdict instead of a misleading
 *     retry loop. An identity-mismatch rotation writes a tombstone mapping
 *     old identity → new, so a contending loser fails fast without burning
 *     the dead token (mirrors codexTokenRefresh.ts "Fix 7").
 */

type StoredCodexTokens = {
  accessToken: string
  refreshToken: string
  expiresAt: number
  accountId: string
  credentialGeneration: number
  vaultFilePath?: string
}

type RawRefreshOutcome =
  | { kind: 'adopted'; account: CodexCoreAccount }
  | {
      kind: 'refreshed'
      refreshed: {
        accountId: string
        accessToken: string
        refreshToken: string
        expiresAt: number
        idToken?: string
      }
      credentialGeneration: number
      savedVaultPath?: string
    }
  | {
      kind: 'identity_mismatch'
      accountId: string
      refreshedAccountId: string
    }

function rawRefreshLifecycle(
  lifecycle?: CodexCredentialLifecycle,
): CodexCredentialLifecycle {
  return (
    lifecycle ??
    createCodexCredentialLifecycle({
      directory: join(
        getClaudeConfigHomeDir(),
        CODEX_CREDENTIAL_LIFECYCLE_DIRECTORY,
      ),
    })
  )
}

function lifecycleReadFailureCode(
  result: CodexCredentialLifecycleReadResult,
): 'missing' | 'malformed' | 'unreadable' {
  if (result.status === 'absent') return 'missing'
  if (result.status === 'malformed') return 'malformed'
  return 'unreadable'
}

function requireRawCredentialedLifecycle(
  lifecycle: Pick<CodexCredentialLifecycle, 'read'>,
  accountId: string,
  credentialGeneration: number,
): void {
  let result: CodexCredentialLifecycleReadResult
  try {
    result = lifecycle.read(accountId)
  } catch {
    throw new CodexRefreshLifecycleError(
      'unreadable',
      accountId,
      credentialGeneration,
    )
  }
  if (result.status !== 'valid') {
    throw new CodexRefreshLifecycleError(
      lifecycleReadFailureCode(result),
      accountId,
      credentialGeneration,
    )
  }
  if (result.record.state !== 'credentialed') {
    throw new CodexRefreshLifecycleError(
      'state_mismatch',
      accountId,
      credentialGeneration,
    )
  }
  if (result.record.credentialGeneration !== credentialGeneration) {
    throw new CodexRefreshLifecycleError(
      'generation_mismatch',
      accountId,
      credentialGeneration,
    )
  }
}

function requireRawLegacyLifecycleBootstrap(
  lifecycle: Pick<CodexCredentialLifecycle, 'read'>,
  accountId: string,
): void {
  let result: CodexCredentialLifecycleReadResult
  try {
    result = lifecycle.read(accountId)
  } catch {
    throw new CodexRefreshLifecycleError('unreadable', accountId, 0)
  }
  if (result.status === 'absent') return
  if (result.status !== 'valid') {
    throw new CodexRefreshLifecycleError(
      lifecycleReadFailureCode(result),
      accountId,
      0,
    )
  }
  throw new CodexRefreshLifecycleError(
    result.record.state === 'credentialed'
      ? 'generation_mismatch'
      : 'state_mismatch',
    accountId,
    0,
  )
}

function storedTokensMatch(
  stored: StoredCodexTokens | null,
  expected: {
    accessToken: string
    refreshToken: string
    expiresAt: number
    accountId: string
    credentialGeneration: number
  },
): boolean {
  return (
    stored?.accessToken === expected.accessToken &&
    stored.refreshToken === expected.refreshToken &&
    stored.expiresAt === expected.expiresAt &&
    stored.accountId === expected.accountId &&
    stored.credentialGeneration === expected.credentialGeneration
  )
}

function readConfigTokensForRawRefresh(): StoredCodexTokens | null {
  if (process.env.NODE_ENV === 'test') {
    const tokens = getCodexOAuthTokens()
    if (!tokens) return null
    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      accountId: tokens.accountId,
      credentialGeneration: tokens.credentialGeneration ?? 0,
    }
  }
  return readPersistedConfigTokens()
}

function readActiveRawTokens(account: CodexCoreAccount): StoredCodexTokens | null {
  return account.source === 'config'
    ? readConfigTokensForRawRefresh()
    : readPersistedVaultTokens(candidateVaultFilePath(account))
}

function bootstrapLegacyRawCredentialStore(
  account: CodexCoreAccount,
): { account: CodexCoreAccount; savedVaultPath?: string } {
  const stored = readActiveRawTokens(account)
  if (
    !stored ||
    stored.accountId !== account.accountId ||
    stored.credentialGeneration !== 0
  ) {
    throw new CodexRefreshLifecycleError(
      'profile_mismatch',
      account.accountId,
      account.credentialGeneration,
    )
  }

  const tagged = {
    accessToken: stored.accessToken,
    refreshToken: stored.refreshToken,
    expiresAt: stored.expiresAt,
    accountId: stored.accountId,
    credentialGeneration: 1,
  }
  if (account.source === 'config') {
    let saved = false
    try {
      saved = saveCodexOAuthTokens(tagged)
    } catch {
      saved = false
    }
    if (!saved || !storedTokensMatch(readConfigTokensForRawRefresh(), tagged)) {
      throw new CodexCoreError(
        'backend',
        `Could not safely bind the legacy Codex credentials for account "${account.profile}". Retrying may recover automatically.`,
        { status: 503 },
      )
    }
    return {
      account: {
        ...account,
        accessToken: tagged.accessToken,
        refreshToken: tagged.refreshToken,
        expiresAt: tagged.expiresAt,
        credentialGeneration: 1,
      },
    }
  }

  const filePath = candidateVaultFilePath(account)
  if (!filePath) {
    throw new CodexCoreError(
      'backend',
      `Could not safely bind the legacy Codex credentials for account "${account.profile}". Retrying may recover automatically.`,
      { status: 503 },
    )
  }
  const saved = saveCodexTokenToVault(tagged, {
    writer: 'codex-core.maybeRefreshAccount.legacy-bootstrap',
    expectedPreviousAccountId: account.accountId,
    filePath,
  })
  if (!saved || !storedTokensMatch(readPersistedVaultTokens(saved.filePath), tagged)) {
    throw new CodexCoreError(
      'backend',
      `Could not safely bind the legacy Codex credentials for account "${account.profile}". Retrying may recover automatically.`,
      { status: 503 },
    )
  }
  return {
    account: {
      ...account,
      accessToken: tagged.accessToken,
      refreshToken: tagged.refreshToken,
      expiresAt: tagged.expiresAt,
      credentialGeneration: 1,
      vaultFilePath: saved.filePath,
    },
    savedVaultPath: saved.filePath,
  }
}

function installRawPoolAccount(
  account: CodexCoreAccount,
  tokens: {
    accountId: string
    accessToken: string
    refreshToken: string
    expiresAt: number
    credentialGeneration: number
    idToken?: string
  },
  vaultFilePath?: string,
): void {
  appendAccount(
    {
      accountId: tokens.accountId,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      credentialGeneration: tokens.credentialGeneration,
      idToken: tokens.idToken,
    },
    {
      preserveCapped: true,
      writer: 'codex-core.maybeRefreshAccount.raw',
      source: account.source,
      vaultFilePath: vaultFilePath ?? account.vaultFilePath,
    },
  )
}

function emitRawIdentityMismatchDiagnostic(
  oldAccountId: string,
  newAccountId: string,
): void {
  const accounts = getPoolStatus().accounts
  const counts: Record<string, number> = { total: accounts.length }
  for (const account of accounts) {
    counts[account.status] = (counts[account.status] ?? 0) + 1
  }
  emitAccountDiagnostic({
    code: 'account.identity_mismatch',
    severity: 'warning',
    provider: 'openai',
    pool: 'codex',
    recoverable: true,
    from_account_ref: oldAccountId,
    account_ref: newAccountId,
    reason: `refresh returned different account ${newAccountId}`,
    counts,
  })
}

async function refreshRawUnderCrossProcessLock(
  account: CodexCoreAccount,
  lifecycleOverride?: CodexCredentialLifecycle,
): Promise<RawRefreshOutcome> {
  const lifecycle = rawRefreshLifecycle(lifecycleOverride)
  return lifecycle.withTransaction(
    account.accountId,
    { operationKind: 'refresh', operationId: randomUUID() },
    permit =>
      refreshRawWithCrossProcessLock(account, lifecycle, permit),
  )
}

async function refreshRawWithCrossProcessLock(
  account: CodexCoreAccount,
  lifecycle: CodexCredentialLifecycle,
  permit: CodexCredentialLifecyclePermit,
): Promise<RawRefreshOutcome> {
  if (account.credentialGeneration === 0) {
    requireRawLegacyLifecycleBootstrap(lifecycle, account.accountId)
  } else {
    requireRawCredentialedLifecycle(
      lifecycle,
      account.accountId,
      account.credentialGeneration,
    )
  }

  const configHome = getClaudeConfigHomeDir()
  mkdirSync(configHome, { recursive: true })
  const lockTarget = join(configHome, 'codex-raw-refresh')

  let lockCompromised = false
  // Refuse to touch any token store once lock exclusivity is in doubt — the
  // same discipline as the stateful path (codexTokenRefresh.ts:300-304).
  const assertLockIntact = () => {
    if (lockCompromised) {
      throw new Error('Refresh lock compromised; refusing to touch token stores')
    }
  }

  let release: (() => Promise<void>) | undefined
  try {
    release = await lockfile.lock(lockTarget, {
      realpath: false,
      stale: 60_000,
      // Budget must outlast the worst-case legitimate holder: a 15s-bounded
      // token fetch (codex-client.ts refresh timeout) + persist + ledger
      // writes. Sum of delays ≈ 23s (randomized ±) > ~16s worst holder.
      retries: {
        retries: 12,
        factor: 1.5,
        minTimeout: 250,
        maxTimeout: 3000,
        randomize: true,
      },
      onCompromised: error => {
        lockCompromised = true
        logForDebugging(
          `[codex-profile] raw-refresh-lock-compromised writer=codex-core.maybeRefreshAccount account=${account.accountId} error=${error instanceof Error ? error.message : String(error)}`,
          { level: 'error' },
        )
      },
    })
  } catch (error) {
    // Lock not acquired (a live holder outlasted the retries). Adopt a rotation
    // another process already persisted if one is visible; otherwise surface a
    // retryable error rather than racing the rotation unserialized.
    if (account.credentialGeneration === 0) {
      throw new CodexCoreError(
        'backend',
        `Codex account "${account.profile}" is being refreshed by another process. Retrying may recover automatically.`,
        { status: 503, cause: error },
      )
    }
    requireRawCredentialedLifecycle(
      lifecycle,
      account.accountId,
      account.credentialGeneration,
    )
    const adopted = readAdoptableTokens(account)
    if (adopted && !isWithinRefreshSkew(adopted.expiresAt)) {
      installRawPoolAccount(account, adopted, adopted.vaultFilePath)
      return { kind: 'adopted', account: adopted }
    }
    throw new CodexCoreError(
      'backend',
      `Codex account "${account.profile}" is being refreshed by another process. Retrying may recover automatically.`,
      { status: 503, cause: error },
    )
  }

  try {
    let effectiveAccount = account
    let effectiveGeneration = account.credentialGeneration
    let savedVaultPath = account.vaultFilePath
    if (account.credentialGeneration === 0) {
      assertLockIntact()
      const bootstrap = bootstrapLegacyRawCredentialStore(account)
      assertLockIntact()
      effectiveAccount = bootstrap.account
      effectiveGeneration = bootstrap.account.credentialGeneration
      savedVaultPath = bootstrap.savedVaultPath ?? savedVaultPath
      const bootstrapped = lifecycle.legacyBootstrap(permit, {
        validatedUntaggedLegacyCredentials: true,
      })
      if (
        bootstrapped.status !== 'applied' ||
        bootstrapped.record.credentialGeneration !== effectiveGeneration
      ) {
        throw new CodexRefreshLifecycleError(
          'state_mismatch',
          account.accountId,
          account.credentialGeneration,
        )
      }
    }
    requireRawCredentialedLifecycle(
      lifecycle,
      account.accountId,
      effectiveGeneration,
    )

    // Another process may have refreshed while we waited on the lock: re-read
    // the persisted store and adopt instead of spending a second rotation.
    const adopted = readAdoptableTokens(effectiveAccount)
    if (adopted && !isWithinRefreshSkew(adopted.expiresAt)) {
      installRawPoolAccount(effectiveAccount, adopted, adopted.vaultFilePath)
      return { kind: 'adopted', account: adopted }
    }
    // Adopted-but-already-expiring: refresh with the LIVE rotated token, not
    // the caller's stale snapshot.
    const refreshSource = adopted ?? effectiveAccount
    const tokenHash = hashRefreshToken(refreshSource.refreshToken)

    // Consult the durable ledger for this exact token. A terminal verdict for
    // it means the chain is finished — fail fast, spend nothing.
    const priorAttempt = readRawRefreshLedger()[account.accountId]
    if (
      priorAttempt &&
      (priorAttempt.credentialGeneration ?? 0) === effectiveGeneration &&
      priorAttempt.refreshTokenHash === tokenHash
    ) {
      if (priorAttempt.state === 'reauth_required') {
        const identityNote = priorAttempt.rotatedToAccountId
          ? ` (a previous refresh rotated it to account ${priorAttempt.rotatedToAccountId})`
          : ''
        throw new CodexCoreError(
          'auth',
          `Codex account "${account.profile}" holds a refresh token that is no longer usable${identityNote}. Please re-login.`,
          { status: 401 },
        )
      }
      // in_flight (we hold the exclusive lock, so a live attempt cannot exist
      // — the writer crashed) or unknown: the token MAY already be burned.
      // Fall through and probe it once; the response classifies the outcome.
      logForDebugging(
        `[codex-profile] raw-refresh-probe writer=codex-core.maybeRefreshAccount account=${account.accountId} prior_state=${priorAttempt.state} reason=${priorAttempt.reason ?? 'crashed_attempt'}`,
        { level: 'warn' },
      )
    }

    // Persist intent BEFORE the request leaves the machine (the crash-safety
    // core). If we cannot record the attempt durably, do NOT spend the
    // rotation — an unrecorded crash would strand the account.
    assertLockIntact()
    try {
      writeRawRefreshLedgerEntry(account.accountId, {
        state: 'in_flight',
        credentialGeneration: effectiveGeneration,
        refreshTokenHash: tokenHash,
        attemptId: randomUUID(),
        updatedAt: new Date().toISOString(),
        pid: process.pid,
      })
    } catch (error) {
      throw new CodexCoreError(
        'backend',
        `Could not record the token-refresh attempt for Codex account "${account.profile}"; refusing to spend the rotation. Retrying may recover automatically.`,
        { status: 503, cause: error },
      )
    }

    let refreshed: Awaited<ReturnType<typeof refreshCodexToken>>
    try {
      refreshed = await refreshCodexToken(refreshSource.refreshToken)
    } catch (error) {
      assertLockIntact()
      if (error instanceof CodexTokenRefreshError && error.credentialFailure) {
        // Definitive server verdict: this token is burned/revoked. Terminal.
        writeRawRefreshLedgerEntry(account.accountId, {
          state: 'reauth_required',
          credentialGeneration: effectiveGeneration,
          refreshTokenHash: tokenHash,
          attemptId: randomUUID(),
          updatedAt: new Date().toISOString(),
          reason: `http_${error.status ?? 'grant_failure'}`,
        })
        throw new CodexCoreError(
          'auth',
          `Failed to refresh Codex account "${account.profile}". Please re-login.`,
          { status: 401, cause: error },
        )
      }
      const networkError =
        error instanceof CodexTokenRefreshError ? error.networkError : undefined
      if (
        networkError &&
        classifyRefreshTransportError(networkError) === 'definitely_not_sent'
      ) {
        // Request never left the machine — the token is provably unspent.
        clearRawRefreshLedgerEntry(account.accountId)
      } else {
        // Ambiguous transport / server error: the server may have rotated.
        writeRawRefreshLedgerEntry(account.accountId, {
          state: 'unknown',
          credentialGeneration: effectiveGeneration,
          refreshTokenHash: tokenHash,
          attemptId: randomUUID(),
          updatedAt: new Date().toISOString(),
          reason: error instanceof Error ? error.message : String(error),
        })
      }
      throw error
    }

    const sameAccount = refreshed.accountId === account.accountId

    if (!sameAccount) {
      assertLockIntact()
      requireRawCredentialedLifecycle(
        lifecycle,
        account.accountId,
        effectiveGeneration,
      )
      const marked = lifecycle.markReauthRequired(permit, {
        expectedGeneration: effectiveGeneration,
      })
      if (marked.status !== 'applied') {
        throw new CodexRefreshLifecycleError(
          marked.status === 'superseded' && marked.reason === 'generation_mismatch'
            ? 'generation_mismatch'
            : marked.status === 'superseded' && marked.reason === 'missing'
              ? 'missing'
              : 'state_mismatch',
          account.accountId,
          effectiveGeneration,
        )
      }
      writeRawRefreshLedgerEntry(account.accountId, {
        state: 'reauth_required',
        credentialGeneration: effectiveGeneration,
        refreshTokenHash: tokenHash,
        attemptId: randomUUID(),
        updatedAt: new Date().toISOString(),
        reason: 'identity_mismatch',
        rotatedToAccountId: refreshed.accountId,
      })
      markAccountDead(
        account.accountId,
        `Refresh returned different account ${refreshed.accountId}`,
        { rerollActive: false },
      )
      emitRawIdentityMismatchDiagnostic(
        account.accountId,
        refreshed.accountId,
      )
      logForDebugging(
        `[codex-profile] identity-mismatch writer=codex-core.maybeRefreshAccount account=${account.accountId} after_account=${refreshed.accountId} action=reauth-required`,
        { level: 'warn' },
      )
      return {
        kind: 'identity_mismatch',
        accountId: account.accountId,
        refreshedAccountId: refreshed.accountId,
      }
    }

    // Persist the rotated tokens. A persistence failure after a successful
    // rotation means disk still holds the burned token — record 'unknown' so
    // the next process probes instead of trusting the stale store.
    assertLockIntact()
    requireRawCredentialedLifecycle(
      lifecycle,
      account.accountId,
      effectiveGeneration,
    )
    let persistFailed = false
    if (account.source === 'config') {
      try {
        const configSaved = saveCodexOAuthTokens({
          ...refreshed,
          credentialGeneration: effectiveGeneration,
        })
        if (!configSaved) {
          persistFailed = true
        }
        // saveGlobalConfig can swallow write failures (auth-loss guard /
        // fallback paths) — verify the rotation actually reached disk. Skipped
        // under NODE_ENV=test, where config writes are in-memory by design.
        if (!persistFailed) {
          const persisted = readConfigTokensForRawRefresh()
          persistFailed =
            persisted?.accountId !== refreshed.accountId ||
            persisted.refreshToken !== refreshed.refreshToken ||
            persisted.credentialGeneration !== effectiveGeneration
        }
      } catch {
        persistFailed = true
      }
    } else {
      const saved = saveCodexTokenToVault({
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        accountId: refreshed.accountId,
        alias: sameAccount ? account.alias : undefined,
        credentialGeneration: effectiveGeneration,
        expiresAt: refreshed.expiresAt,
      }, {
        writer: 'codex-core.maybeRefreshAccount',
        expectedPreviousAccountId: account.accountId,
        filePath: candidateVaultFilePath(effectiveAccount) ?? undefined,
      })
      // saveCodexTokenToVault returns null ONLY on write failure
      // (codexAccountPool.ts catch) — the vault path itself always resolves.
      persistFailed = saved == null
      savedVaultPath = saved?.filePath
    }

    assertLockIntact()
    if (persistFailed) {
      writeRawRefreshLedgerEntry(account.accountId, {
        state: 'unknown',
        credentialGeneration: effectiveGeneration,
        refreshTokenHash: tokenHash,
        attemptId: randomUUID(),
        updatedAt: new Date().toISOString(),
        reason: 'persist_failed',
      })
      logForDebugging(
        `[codex-profile] raw-refresh-persist-failed writer=codex-core.maybeRefreshAccount account=${account.accountId} — returning in-memory tokens; disk still holds the previous rotation, next process will probe`,
        { level: 'error' },
      )
    } else {
      clearRawRefreshLedgerEntry(account.accountId)
      requireRawCredentialedLifecycle(
        lifecycle,
        account.accountId,
        effectiveGeneration,
      )
      installRawPoolAccount(
        effectiveAccount,
        {
          ...refreshed,
          credentialGeneration: effectiveGeneration,
        },
        savedVaultPath,
      )
    }
    return {
      kind: 'refreshed',
      refreshed,
      credentialGeneration: effectiveGeneration,
      savedVaultPath,
    }
  } finally {
    await release().catch(() => {})
  }
}

/**
 * Read the store the OTHER process would have persisted to, straight off disk
 * (getGlobalConfig's in-memory cache would mask a foreign write), and return an
 * adoptable account iff it holds a NEWER rotation of the SAME account.
 */
function readAdoptableTokens(account: CodexCoreAccount): CodexCoreAccount | null {
  const stored =
    account.source === 'config'
      ? readConfigTokensForRawRefresh()
      : readPersistedVaultTokens(candidateVaultFilePath(account))
  if (!stored) return null
  if (stored.accountId !== account.accountId) return null
  if (stored.credentialGeneration !== account.credentialGeneration) return null
  if (stored.refreshToken === account.refreshToken) return null
  return {
    ...account,
    accessToken: stored.accessToken,
    refreshToken: stored.refreshToken,
    expiresAt: stored.expiresAt,
    ...(stored.vaultFilePath ? { vaultFilePath: stored.vaultFilePath } : {}),
  }
}

function readPersistedConfigTokens(): StoredCodexTokens | null {
  try {
    const raw = readFileSync(getGlobalClaudeFile(), 'utf-8')
    const parsed = JSON.parse(raw) as {
      codexOAuth?: {
        accessToken?: string
        refreshToken?: string
        expiresAt?: number
        accountId?: string
        credentialGeneration?: unknown
      }
    }
    const stored = parsed.codexOAuth
    if (
      !stored?.accessToken ||
      !stored.refreshToken ||
      !stored.expiresAt ||
      !stored.accountId
    ) {
      return null
    }
    const credentialGeneration = parseStoredCredentialGeneration(
      stored.credentialGeneration,
    )
    if (credentialGeneration === null) {
      return null
    }
    return {
      accessToken: stored.accessToken,
      refreshToken: stored.refreshToken,
      expiresAt: stored.expiresAt,
      accountId: stored.accountId,
      credentialGeneration,
    }
  } catch {
    return null
  }
}

function readPersistedVaultTokens(
  vaultFilePath: string | null,
): StoredCodexTokens | null {
  if (!vaultFilePath || !existsSync(vaultFilePath)) return null
  try {
    const raw = readFileSync(vaultFilePath, 'utf-8')
    const parsed = JSON.parse(raw) as {
      tokens?: {
        access_token?: string
        refresh_token?: string
        expires_at?: number
        account_id?: string
        credential_generation?: unknown
      }
    }
    const tokens = parsed.tokens
    if (
      !tokens?.access_token ||
      !tokens.refresh_token ||
      !tokens.expires_at ||
      !tokens.account_id
    ) {
      return null
    }
    const credentialGeneration = parseStoredCredentialGeneration(
      tokens.credential_generation,
    )
    if (credentialGeneration === null) {
      return null
    }
    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: tokens.expires_at,
      accountId: tokens.account_id,
      credentialGeneration,
      vaultFilePath,
    }
  } catch {
    return null
  }
}

function parseStoredCredentialGeneration(value: unknown): number | null {
  if (value === undefined) return 0
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    return null
  }
  return value
}

/** Where saveCodexTokenToVault would land this account's tokens. */
function candidateVaultFilePath(account: CodexCoreAccount): string | null {
  if (account.vaultFilePath) return account.vaultFilePath
  const vaultPath = getVaultPath()
  if (!vaultPath) return null
  return join(vaultPath, 'accounts', `${account.accountId}.json`)
}

/* ── Raw-refresh attempt ledger (durable crash/outcome state) ─────────────────
 * One small JSON file beside the lock. Only ever read/written while HOLDING
 * the raw-refresh lock, so plain atomic replace is sufficient. Idle accounts
 * have no entry.
 */

type RawRefreshLedgerEntry = {
  state: 'in_flight' | 'unknown' | 'reauth_required'
  credentialGeneration: number
  refreshTokenHash: string
  attemptId: string
  updatedAt: string
  pid?: number
  reason?: string
  rotatedToAccountId?: string
}

type RawRefreshLedger = Record<string, RawRefreshLedgerEntry>

function rawRefreshLedgerPath(): string {
  return join(getClaudeConfigHomeDir(), 'codex-raw-refresh.state.json')
}

function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function readRawRefreshLedger(): RawRefreshLedger {
  try {
    const parsed = JSON.parse(readFileSync(rawRefreshLedgerPath(), 'utf-8')) as {
      version?: number
      accounts?: RawRefreshLedger
    }
    return parsed.accounts ?? {}
  } catch {
    return {}
  }
}

function writeRawRefreshLedger(accounts: RawRefreshLedger): void {
  const path = rawRefreshLedgerPath()
  const tmpPath = `${path}.${process.pid}.tmp`
  writeFileSync(tmpPath, `${JSON.stringify({ version: 1, accounts }, null, 2)}\n`, {
    mode: 0o600,
  })
  renameSync(tmpPath, path)
}

function writeRawRefreshLedgerEntry(
  accountId: string,
  entry: RawRefreshLedgerEntry,
): void {
  const accounts = readRawRefreshLedger()
  accounts[accountId] = entry
  writeRawRefreshLedger(accounts)
}

function clearRawRefreshLedgerEntry(accountId: string): void {
  const accounts = readRawRefreshLedger()
  if (!(accountId in accounts)) return
  delete accounts[accountId]
  writeRawRefreshLedger(accounts)
}
