/**
 * Accounts domain capability — the CANONICAL W4 domain read-seam recipe (P4-5).
 * Later domains copy this shape; read it before adding a new domain.
 *
 * THE RECIPE (four rules every domain seam follows):
 *
 *  1. **Read-only OUTBOUND projection (C3 precedent).** `getSnapshot()` builds a
 *     REDACTED view from the engine's OWN live source — here the real Codex
 *     account pool (`getPoolStatus()`, the same singleton the engine request
 *     path reads, `src/services/api/client.ts`). It NEVER re-implements engine
 *     logic and NEVER hands the renderer a raw engine record.
 *  2. **Secret owner is non-negotiable (SECURITY-MINIMUM §4).** The projection
 *     omits every credential field by construction — `PoolAccount.accessToken`
 *     / `refreshToken` (the only two true secrets), plus `vaultFilePath` /
 *     `idToken` — surfacing vault-presence as a BOOLEAN, never the path. The
 *     outbound `secretGuard` also blocks those key names, so redaction is proven
 *     twice (projection omits + guard would block). `accountsDomain.test.ts`
 *     drives token-bearing fixtures through the projection and asserts the
 *     output is `secretGuard`-clean.
 *  3. **Throw-free read-at-spawn discipline.** `getSnapshot()` is a pure read
 *     wrapped so it can never throw and strand an attaching connection (returns
 *     null on any failure; the sidecar degrades gracefully).
 *  4. **Reactivity = emit-on-attach + action-driven re-emit (NOT a poll).** The
 *     Codex pool is a bare module singleton with NO reactive store/emitter
 *     (`codexAccountPool.ts` exposes no `subscribe`), so — source-wins drift from
 *     the P4-5 brief's "reactive off the same store" — a live async-refresh push
 *     is not possible without the account-diagnostic sink
 *     (`accountDiagnostics.ts`, already secret-scrubbed). That sink is the named
 *     reactive hook for P4-15 (reauth banner) + P4-17 (welcome table); wiring it
 *     is deferred to P4-15. v1 re-broadcasts after any pool-mutating verb this
 *     session drives, matching the settings seam's spawn-time posture.
 *
 * MUTATION verbs (`runVerb`) dispatch to the engine's OWN account machinery
 * through an injected `AccountsCommandExecutor` (real ops in production, fakes in
 * tests so headless round-trips never touch real credentials — §10). The sidecar
 * does structural (Zod) validation; this domain does the pool-RESOLVED business
 * validation (re-resolve every `accountId` against the live pool, re-validate
 * aliases via the engine's own `validateCodexAccountAlias`) — the T6 guarantee
 * that no renderer byte becomes account state.
 *
 * ZERO transport knowledge: frames, wire validation, and limits stay in
 * `sidecarServer.ts`.
 */

import { existsSync } from 'node:fs'

import {
  appendAccount,
  describeCodexAccountAvailability,
  getCodexAccountAvailability,
  getPoolStatus,
  isCodexAccountSwitchable,
  removeCodexAccount,
  loadPoolForObservation,
  saveCodexTokenToVault,
  setAccountAlias,
  switchToAccount,
  validateCodexAccountAlias,
  type PoolAccount,
} from '../../src/services/api/codexAccountPool.js'
import {
  getClaudePoolStatus,
  switchToClaudeAccount,
  syncClaudeAccountToStorage,
  type ClaudePoolAccount,
} from '../../src/services/api/claudeAccountPool.js'
import { touchAll } from '../../src/services/api/codexTokenRefresh.js'
import { fetchPoolUsage } from '../../src/services/api/codexUsage.js'
import {
  reassignCodexLeaseToActiveAccount,
  releaseCodexLease,
  repairLeasesForDeletedAccount,
} from '../../src/services/api/codexAccountLeaseManager.js'
import { resetCodexCacheContext } from '../../src/services/api/codex-fetch-adapter.js'
import {
  installOAuthTokens,
  parseManualOAuthCallbackInput,
} from '../../src/cli/handlers/auth.js'
import { OAuthService } from '../../src/services/oauth/index.js'
import { runCodexOAuthFlow, type CodexTokens } from '../../src/services/oauth/codex-client.js'
import {
  clearCodexOAuthTokens,
  clearOAuthTokenCache,
  hasAnthropicCredentials,
  isClaudeAISubscriber,
  saveCodexOAuthTokens,
  validateForceLoginOrgForToken,
} from '../../src/utils/auth.js'
import { clearAuthRelatedCaches } from '../../src/commands/logout/logout.js'
import { getInitialSettings } from '../../src/utils/settings/settings.js'
import type {
  AccountResultFrame,
  AccountLoginProvider,
  AccountsSnapshot,
  AnthropicAccountStatus,
  AccountStatus,
  AccountVerbMessage,
  AccountVerbType,
  OAuthLoginProgress,
} from '../shared/protocol.js'

/** Pure — the redacted outcome payload a verb produces (no transport, no secret). */
export type AccountVerbResult = {
  ok: boolean
  message: string
  touchAllResults?: AccountResultFrame['touchAllResults']
}

/**
 * The engine account ops, behind a seam. The real implementation
 * (`createRealAccountsExecutor`) wires the actual pool/refresh functions; tests
 * inject a fake so a headless round-trip proves the wiring without a live pool or
 * real credentials (§10 — live execution is the operator GUI step).
 */
export type AccountsCommandExecutor = {
  /** Switch the persisted active account. `accountId` already re-resolved. */
  switch(accountId: string): AccountVerbResult
  /** Switch the active Anthropic subscription account and refresh auth caches. */
  switchAnthropic(accountId: string): Promise<AccountVerbResult>
  /** Rename a vault account. `alias` already re-validated against the live pool. */
  rename(accountId: string, alias: string): AccountVerbResult
  /** Delete a vault account profile. `accountId` already re-resolved + vault-checked. */
  delete(accountId: string): AccountVerbResult | Promise<AccountVerbResult>
  /** Sign out the active account (clears its token; profile stays). */
  logout(): AccountVerbResult
  /** Refresh OAuth tokens for every unlocked vault account. */
  touchAll(): Promise<AccountVerbResult>
  /**
   * Fetch soft usage hints (5h/weekly used-percent + reset) for every pool
   * account from the ChatGPT wham/usage endpoint and apply them to the live
   * pool — the same call the engine makes at startup (`initAccountPool` →
   * `fetchPoolUsage`). Read-only (GET, often live in this long-lived process:
   * the post-turn poll invalidates the 1-min cache), uses existing tokens, no
   * token refresh or completion burn. Resolves true when at least one account's
   * usage landed, so the sidecar re-broadcasts. That is the read succeeding, not
   * a guarantee the pool moved: a read overtaken by an account change applies no
   * hints, and the 60s pool worker is what corrects the panel in that case.
   */
  refreshUsage(): Promise<boolean>
}

export type SidecarAccountsDomain = {
  /**
   * The redacted pool snapshot — a pure, throw-free read of the live pool. null
   * only if the read itself failed (the sidecar then skips the frame).
   */
  getSnapshot(): AccountsSnapshot | null
  /**
   * Run one already-STRUCTURALLY-validated account verb: pool-resolved business
   * validation → dispatch to the executor → redacted result + whether the pool
   * changed (so the sidecar knows to re-broadcast the snapshot).
   */
  runVerb(
    verb: AccountVerbMessage,
  ): Promise<{ verb: AccountVerbType; result: AccountVerbResult; poolChanged: boolean }>
  /**
   * Populate the pool's usage hints (see `AccountsCommandExecutor.refreshUsage`).
   * The snapshot's usage fields are 0/null until this runs — the desktop loads
   * the pool observation-only, so nothing else fetches wham/usage. Resolves true
   * when usage changed and the sidecar should re-broadcast the snapshot.
   */
  refreshUsage(): Promise<boolean>
  /**
   * Apply a deletion already persisted by another process to this sidecar's
   * process-local account pool without producing a transport result.
   */
  applyDeletedProfile(accountId: string): Promise<boolean>
  /**
   * P4-15 — register the sink the OAuth login controller pushes progress through.
   * The server sets it once and broadcasts each `OAuthLoginProgress` as an
   * `oauth.login.progress` frame (the domain keeps ZERO transport knowledge). An
   * unset sink silently drops progress (e.g. a test that only asserts the ack).
   */
  setOAuthProgressSink(sink: (progress: OAuthLoginProgress) => void): void
  /**
   * IDLE-PARK — true while a sign-in is under way. `account.login` acks
   * immediately and the real flow (browser, callback listener, credential
   * write) keeps running in the background, so the server cannot infer this
   * from the verb promise; killing the process here abandons a half-finished
   * login. Covers the synchronous dispatch window too, not just the phases
   * after the authorize url arrives.
   */
  isOAuthLoginInFlight(): boolean
}

function isSidecarFirstRunEligible(): boolean {
  const codexPool = getPoolStatus()
  const anthropicPool = getClaudePoolStatus()
  if (
    !codexPool.initialized ||
    !anthropicPool.initialized ||
    codexPool.accounts.length > 0 ||
    anthropicPool.accounts.length > 0
  ) {
    return false
  }
  try {
    return !hasAnthropicCredentials()
  } catch {
    // Credential discovery failed: do not authorize an automatic route change.
    return false
  }
}

/* ------------------------------------------------------------------------- *
 * OAuth login controller seam (P4-15) — the live sign-in back-channel
 * ------------------------------------------------------------------------- *
 *
 * The engine's real Codex OAuth flow (`runCodexOAuthFlow`, `codex-client.ts:603`)
 * already exposes its progress as callbacks — `onUrlReady(url)` (the
 * `waiting_for_login` signal, url is non-secret) and `onManualInput()` (the
 * paste-code race) — and RETURNS the `CodexTokens` (secret) or throws. This seam
 * wraps that so the sidecar consumes the REAL flow, and so a headless test can
 * inject a FAKE runner that never opens a browser, binds port 1455, or writes the
 * vault (§10 — the real run is the operator's live step). The captured tokens
 * live ONLY inside the returned handle — the domain (and the wire) never sees a
 * token; `persist` performs the engine's own credential write.
 */

/** The captured-but-not-yet-persisted login. Holds the secret tokens internally. */
export type OAuthPendingLogin = {
  /**
   * TRUE when the authenticated `accountId` is already in the pool (a re-link /
   * reauth). The controller then AUTO-persists (keeping the existing alias) and
   * skips the naming step — mirrors the engine's own existing-vs-new alias
   * branch (`getCodexAliasPrompt`, `ConsoleOAuthFlow.tsx:96`).
   */
  readonly isExistingAccount: boolean
  /** Validate a proposed alias with the engine's OWN rule; empty = skip (ok). */
  validateAlias(alias: string): { ok: true } | { ok: false; message: string }
  /** Persist the captured tokens (engine credential write). Empty alias = keep/anon. */
  persist(alias: string | undefined): void | Promise<void>
}

/** Begins the real OAuth flow; the captured tokens stay inside the returned handle. */
export type OAuthLoginRunner = {
  begin(callbacks: {
    /** The engine-minted authorize url arrived (drives `waiting_for_login`). */
    onWaitingForLogin: (url: string) => void
    /** Resolves when the user pastes a code (fed by the paste-code verb). */
    waitForManualCode: () => Promise<string>
  }): Promise<OAuthPendingLogin>
  /** Validate renderer-provided manual input without consuming the retry slot. */
  validateManualCode?(
    code: string,
  ): { ok: true } | { ok: false; message: string }
  /** Best-effort teardown for an abandoned browser/manual-code flow. */
  cancel?(): void
}

type AnthropicOAuthService = Pick<
  OAuthService,
  'startOAuthFlow' | 'handleManualAuthCodeInput' | 'cleanup'
>

export type AnthropicOAuthRunnerDependencies = {
  createService?: () => AnthropicOAuthService
  installTokens?: typeof installOAuthTokens
  validateOrg?: typeof validateForceLoginOrgForToken
  readSettings?: typeof getInitialSettings
}

/**
 * The REAL runner — consumes the engine's `runCodexOAuthFlow` and performs the
 * engine's own token persistence (`saveCodexOAuthTokens` + vault + `appendAccount`,
 * the identical writes `ConsoleOAuthFlow.persistCodexLogin` performs,
 * `ConsoleOAuthFlow.tsx:213`). Only exercised by a LIVE login (the operator step);
 * headless tests inject a fake so no browser/port/vault is ever touched.
 */
export function createRealOAuthLoginRunner(): OAuthLoginRunner {
  return {
    async begin({ onWaitingForLogin, waitForManualCode }) {
      const tokens: CodexTokens = await runCodexOAuthFlow(
        async url => {
          onWaitingForLogin(url)
        },
        () => waitForManualCode(),
      )
      const existing = getPoolStatus().accounts.find(
        a => a.accountId === tokens.accountId,
      )
      return {
        isExistingAccount: existing !== undefined,
        validateAlias(alias) {
          const trimmed = alias.trim()
          if (!trimmed) return { ok: true }
          return validateCodexAccountAlias(trimmed, tokens.accountId)
        },
        persist(alias) {
          const trimmed = alias?.trim() || undefined
          // The engine's OWN credential writes — NOT a re-implementation.
          saveCodexOAuthTokens(tokens)
          const saved = saveCodexTokenToVault(
            { ...tokens, alias: trimmed },
            { writer: 'accountsDomain.oauthPersist' },
          )
          appendAccount(
            { ...tokens, alias: trimmed },
            {
              writer: 'accountsDomain.oauthPersist',
              source: saved ? 'vault' : 'config',
              vaultFilePath: saved?.filePath,
              activate: true,
            },
          )
        },
      }
    },
  }
}

/**
 * Anthropic subscription OAuth runner. It reuses the engine's canonical
 * `OAuthService` + `installOAuthTokens` path, so profile lookup, vault writes,
 * account-pool upsert, keychain sync, and cache invalidation stay engine-owned.
 */
export function createRealAnthropicOAuthLoginRunner(
  dependencies: AnthropicOAuthRunnerDependencies = {},
): OAuthLoginRunner {
  const createService =
    dependencies.createService ?? (() => new OAuthService())
  const installTokens = dependencies.installTokens ?? installOAuthTokens
  const validateOrg =
    dependencies.validateOrg ?? validateForceLoginOrgForToken
  const readSettings = dependencies.readSettings ?? getInitialSettings
  let activeService: AnthropicOAuthService | null = null
  return {
    validateManualCode(rawInput) {
      const parsed = parseManualOAuthCallbackInput(rawInput)
      if (!parsed.authorizationCode || !parsed.state) {
        return {
          ok: false,
          message:
            'Could not parse input. Paste the full callback URL or exact "<code>#<state>" value.',
        }
      }
      return { ok: true }
    },
    async begin({ onWaitingForLogin, waitForManualCode }) {
      const service = createService()
      activeService = service
      try {
        const settings = readSettings()
        const tokens = await service.startOAuthFlow(
          async url => {
            onWaitingForLogin(url)
            void waitForManualCode().then(rawInput => {
              const parsed = parseManualOAuthCallbackInput(rawInput)
              if (!parsed.authorizationCode || !parsed.state) return
              service.handleManualAuthCodeInput({
                authorizationCode: parsed.authorizationCode,
                state: parsed.state,
              })
            })
          },
          {
            loginWithClaudeAi:
              settings.forceLoginMethod !== 'console',
            orgUUID: settings.forceLoginOrgUUID,
          },
        )
        // Keep tokens captured inside the pending handle. The domain performs
        // the generation/cancellation check before invoking this commit.
        return {
          isExistingAccount: true,
          validateAlias: () => ({ ok: true }),
          async persist() {
            // Managed-org validation is a PRE-COMMIT gate. Installing first
            // leaves a rejected token active in the pool/keychain/vault even
            // though the UI reports failure.
            const orgResult = await validateOrg(tokens.accessToken)
            if (orgResult.valid === false) {
              throw new Error(orgResult.message)
            }
            await installTokens(tokens)
          },
        }
      } finally {
        if (activeService === service) activeService = null
        service.cleanup()
      }
    },
    cancel() {
      activeService?.cleanup()
      activeService = null
    },
  }
}

/* ------------------------------------------------------------------------- *
 * Pure projection (redaction) — the security-critical core, unit-tested
 * ------------------------------------------------------------------------- */

/**
 * Project ONE `PoolAccount` to its redacted status. The whitelist here is the
 * contract: every field is copied explicitly, so a future `PoolAccount` field
 * (a new token, say) can never leak by accident — it is simply not projected.
 */
export function buildAccountStatus(
  account: PoolAccount,
  isDefault: boolean,
  now = Date.now(),
): AccountStatus {
  const availability = getCodexAccountAvailability(account, now).kind
  return {
    id: account.accountId,
    alias: account.alias ?? null,
    status: account.status,
    statusReason: account.statusReason ?? null,
    availability,
    availabilityLabel: describeCodexAccountAvailability(account, { now }),
    isDefault,
    // Presence flag ONLY — never the path (`vaultFilePath` is secretGuard-blocked).
    hasVaultProfile: Boolean(account.vaultFilePath),
    source: account.source,
    usagePrimary: account.usagePrimary ?? null,
    usageWeekly: account.usageWeekly ?? null,
    usageLimitReached: account.usageLimitReached === true,
    usageResetAt: account.usageResetAt ?? null,
    lastRefreshIso: account.lastRefreshIso ?? null,
    lastError: account.lastError ?? null,
    planType: account.planType ?? null,
    // Authoritative rule + not-already-default (the renderer never re-derives it).
    switchable: !isDefault && isCodexAccountSwitchable(account, now),
  }
}

/** Project one Claude pool entry through an explicit redaction whitelist. */
export function buildAnthropicAccountStatus(
  account: ClaudePoolAccount,
  isDefault: boolean,
): AnthropicAccountStatus {
  return {
    id: account.accountUuid,
    alias: account.alias ?? null,
    email: account.emailAddress,
    status: account.status,
    isDefault,
    hasVaultProfile: Boolean(account.vaultFilePath),
    subscriptionType: account.subscriptionType ?? null,
  }
}

/** Match account attribution to the same effective auth decision as requests. */
export function resolveAnthropicSubscriptionActive(
  subscriberCheck: () => boolean = isClaudeAISubscriber,
): boolean {
  try {
    return subscriberCheck()
  } catch {
    return false
  }
}

export function resolveAnthropicRouteAvailable(
  credentialsCheck: () => boolean = hasAnthropicCredentials,
): boolean {
  try {
    return credentialsCheck()
  } catch {
    return false
  }
}

/** Project the whole pool status to the redacted snapshot. Pure. */
export function buildAccountsSnapshot(
  poolStatus: {
    accounts: readonly PoolAccount[]
    activeIndex: number
    initialized: boolean
  },
  now = Date.now(),
  anthropicPoolStatus = getClaudePoolStatus(),
  anthropicRouteAvailable = resolveAnthropicRouteAvailable(),
  anthropicSubscriptionActive = resolveAnthropicSubscriptionActive(),
): AccountsSnapshot {
  const activeAccount = poolStatus.accounts[poolStatus.activeIndex]
  const activeAccountId = activeAccount?.accountId ?? null
  const accounts = poolStatus.accounts.map((account, index) =>
    buildAccountStatus(account, index === poolStatus.activeIndex, now),
  )
  const readyCount = poolStatus.accounts.filter(
    a => a.status === 'healthy' && a.usageLimitReached !== true,
  ).length
  const anthropicActive =
    anthropicPoolStatus.accounts[anthropicPoolStatus.activeIndex]
  const anthropicAccounts = anthropicPoolStatus.accounts.map((account, index) =>
    buildAnthropicAccountStatus(
      account,
      index === anthropicPoolStatus.activeIndex,
    ),
  )
  return {
    accounts,
    activeAccountId,
    readyCount,
    poolCount: poolStatus.accounts.length,
    initialized: poolStatus.initialized,
    anthropicAccounts,
    anthropicActiveAccountId: anthropicActive?.accountUuid ?? null,
    anthropicReadyCount: anthropicPoolStatus.accounts.filter(
      account => account.status === 'healthy',
    ).length,
    anthropicPoolCount: anthropicPoolStatus.accounts.length,
    anthropicInitialized: anthropicPoolStatus.initialized,
    anthropicRouteAvailable,
    anthropicSubscriptionActive,
  }
}

/* ------------------------------------------------------------------------- *
 * Real executor — wires the engine's own account machinery
 * ------------------------------------------------------------------------- */

export function createRealAccountsExecutor(): AccountsCommandExecutor {
  return {
    switch(accountId) {
      const account = switchToAccount(accountId)
      return account
        ? { ok: true, message: `Switched to ${account.alias ?? 'account'}` }
        : { ok: false, message: 'Could not switch to that account.' }
    },
    async switchAnthropic(accountId) {
      const account = switchToClaudeAccount(accountId)
      if (!account) {
        return {
          ok: false,
          message: 'Could not switch to that Anthropic account.',
        }
      }
      syncClaudeAccountToStorage()
      clearOAuthTokenCache()
      await clearAuthRelatedCaches()
      return {
        ok: true,
        message: `Switched to ${account.alias ?? account.emailAddress}`,
      }
    },
    rename(accountId, alias) {
      const ok = setAccountAlias(accountId, alias)
      return ok
        ? { ok: true, message: `Renamed to ${alias}` }
        : { ok: false, message: 'Could not rename that account.' }
    },
    async delete(accountId) {
      const account = getPoolStatus().accounts.find(
        candidate => candidate.accountId === accountId,
      )
      if (!account?.vaultFilePath) {
        return { ok: false, message: 'Could not delete that account.' }
      }

      if (!removeCodexAccount(accountId)) {
        return { ok: false, message: 'Could not delete that account.' }
      }

      repairLeasesForDeletedAccount(accountId)
      if (getPoolStatus().activeIndex >= 0) {
        reassignCodexLeaseToActiveAccount('main-thread')
      } else {
        releaseCodexLease('main-thread')
      }
      resetCodexCacheContext()
      await clearAuthRelatedCaches()
      return { ok: true, message: 'Account deleted.' }
    },
    logout() {
      clearCodexOAuthTokens()
      return { ok: true, message: 'Signed out.' }
    },
    async touchAll() {
      const results = await touchAll()
      // Resolve accountId → alias from the live pool for the results list (the
      // RefreshResult carries only accountId). Falls back to the id when the
      // account has no alias or is no longer in the pool.
      const byId = new Map(
        getPoolStatus().accounts.map(a => [a.accountId, a.alias ?? null]),
      )
      const touchAllResults = results.map(r => ({
        alias: byId.get(r.accountId) ?? r.accountId,
        result:
          r.status === 'refreshed'
            ? ('OK' as const)
            : r.status === 'locked'
              ? ('LOCKED' as const)
              : ('FAILED' as const),
      }))
      return { ok: true, message: 'Refresh complete.', touchAllResults }
    },
    async refreshUsage() {
      // updateRoutingHints applies the fetched 5h/weekly percents onto the live
      // pool accounts, which `buildAccountStatus` then reads. A total failure
      // (offline / stale tokens) returns 0 results and leaves the fields as-is.
      const snapshot = await fetchPoolUsage({ updateRoutingHints: true })
      return snapshot.accounts.length > 0
    },
  }
}

/* ------------------------------------------------------------------------- *
 * Domain
 * ------------------------------------------------------------------------- */

export function createSidecarAccountsDomain(
  options: {
    executor?: AccountsCommandExecutor
    /** Injected in tests so a headless round-trip never opens a browser / writes the vault. */
    oauthRunner?: OAuthLoginRunner
    /** Injected Anthropic runner; headless tests never open a browser or write credentials. */
    anthropicOAuthRunner?: OAuthLoginRunner
    /** First-run provider choice takes effect only after credential persistence succeeds. */
    onProviderActivated?: (provider: AccountLoginProvider) => void
    /** Sidecar-owned first-run eligibility; injectable for deterministic boundary tests. */
    isFirstRunEligible?: () => boolean
    /**
     * Re-read the pool from disk before an account-targeting WRITE. Defaults to
     * the engine's own observation-only load; injectable so a test can stand in
     * for another process changing the vault.
     */
    reloadPool?: () => Promise<void>
  } = {},
): SidecarAccountsDomain {
  const executor = options.executor ?? createRealAccountsExecutor()
  const oauthRunner = options.oauthRunner ?? createRealOAuthLoginRunner()
  const anthropicOAuthRunner =
    options.anthropicOAuthRunner ?? createRealAnthropicOAuthLoginRunner()
  const isFirstRunEligible =
    options.isFirstRunEligible ?? isSidecarFirstRunEligible
  const reloadPool = options.reloadPool ?? loadPoolForObservation

  function resolveAccount(accountId: string): PoolAccount | undefined {
    return getPoolStatus().accounts.find(a => a.accountId === accountId)
  }

  /**
   * Resolve a WRITE target, re-reading the vault once if the first look misses.
   *
   * `getPoolStatus()` is the process-local singleton, populated once at spawn
   * and never refreshed here, while the accounts page the operator is looking
   * at comes from the accounts worker's 60 s re-read. So an account signed in
   * from another window or from the CLI shows up in the list within a minute,
   * and every write aimed at it from an older session is refused with "that
   * account is no longer in the pool" for as long as that session lives. The
   * second look closes that: the re-read is disk-only (no token refresh, no
   * network) and is paid ONLY on a miss, so the ordinary hit costs nothing and
   * the in-memory usage hints the pool accumulated are not thrown away on every
   * verb. A failed re-read is non-fatal; the miss is then reported as before.
   */
  async function resolveAccountForWrite(
    accountId: string,
  ): Promise<PoolAccount | undefined> {
    const known = resolveAccount(accountId)
    if (known) return known
    try {
      await reloadPool()
    } catch {
      // Keep the last known pool; the caller reports the miss.
    }
    return resolveAccount(accountId)
  }

  /* ── OAuth login controller (P4-15) ──────────────────────────────────────
   * One in-flight attempt per session. `generation` guards every async update
   * so a cancelled/superseded attempt can never emit a stale progress frame or
   * persist late. The captured tokens live inside `pending` (never on the wire).
   */
  let progressSink: ((progress: OAuthLoginProgress) => void) | null = null
  let generation = 0
  let phase:
    | 'idle'
    | 'waiting_for_login'
    | 'waiting_for_alias'
    | 'persisting' = 'idle'
  let pending: OAuthPendingLogin | null = null
  let resolveManualCode: ((code: string) => void) | null = null
  let activeOAuthRunner: OAuthLoginRunner | null = null
  let pendingProviderActivation: AccountLoginProvider | null = null

  function emit(gen: number, progress: OAuthLoginProgress): void {
    if (gen !== generation) return
    progressSink?.(progress)
  }

  function beginLogin(provider: AccountLoginProvider): AccountVerbResult {
    if (phase === 'persisting') {
      return {
        ok: false,
        message: 'Sign-in is already completing. Wait for it to finish.',
      }
    }
    activeOAuthRunner?.cancel?.()
    const gen = ++generation
    pending = null
    pendingProviderActivation = isFirstRunEligible() ? provider : null
    resolveManualCode = null
    phase = 'idle'
    const selectedRunner =
      provider === 'anthropic' ? anthropicOAuthRunner : oauthRunner
    activeOAuthRunner = selectedRunner
    emit(gen, { state: 'starting' })
    void (async () => {
      try {
        const login = await selectedRunner.begin({
          onWaitingForLogin: url => {
            phase = 'waiting_for_login'
            emit(gen, { state: 'waiting_for_login', url })
          },
          waitForManualCode: () =>
            new Promise<string>(resolve => {
              resolveManualCode = resolve
            }),
        })
        if (gen !== generation) return // cancelled/superseded mid-flow
        resolveManualCode = null
        if (login.isExistingAccount) {
          // Reauth / re-link: keep the existing name, no naming step. `success`
          // drives the accounts re-broadcast (server), which clears the banner.
          phase = 'persisting'
          await login.persist(undefined)
          if (gen !== generation) return
          if (pendingProviderActivation) {
            options.onProviderActivated?.(pendingProviderActivation)
          }
          pendingProviderActivation = null
          pending = null
          phase = 'idle'
          emit(gen, { state: 'success' })
        } else {
          pending = login
          phase = 'waiting_for_alias'
          emit(gen, { state: 'waiting_for_alias' })
        }
      } catch (error) {
        if (gen !== generation) return
        pending = null
        pendingProviderActivation = null
        resolveManualCode = null
        phase = 'idle'
        emit(gen, {
          state: 'error',
          message: error instanceof Error ? error.message : String(error),
        })
      } finally {
        if (gen === generation && activeOAuthRunner === selectedRunner) {
          activeOAuthRunner = null
        }
      }
    })()
    return { ok: true, message: 'Sign-in started.' }
  }

  function submitPasteCode(code: string): AccountVerbResult {
    if (!resolveManualCode) {
      return { ok: false, message: 'No sign-in is waiting for a code.' }
    }
    const validation = activeOAuthRunner?.validateManualCode?.(code)
    if (validation?.ok === false) {
      return validation
    }
    const resolve = resolveManualCode
    resolveManualCode = null
    resolve(code)
    return { ok: true, message: 'Code submitted.' }
  }

  async function submitAlias(alias: string): Promise<AccountVerbResult> {
    if (phase !== 'waiting_for_alias' || !pending) {
      return { ok: false, message: 'No sign-in is waiting for a name.' }
    }
    const check = pending.validateAlias(alias)
    if (!check.ok) {
      // Stay in the alias step so the user can correct it (the engine's own rule).
      return { ok: false, message: check.message }
    }
    const gen = generation
    const login = pending
    phase = 'persisting'
    try {
      await login.persist(alias.trim() || undefined)
    } catch (error) {
      if (gen === generation) {
        pending = login
        phase = 'waiting_for_alias'
      }
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      }
    }
    if (gen !== generation) {
      return { ok: false, message: 'Sign-in was superseded.' }
    }
    if (pendingProviderActivation) {
      options.onProviderActivated?.(pendingProviderActivation)
    }
    pendingProviderActivation = null
    pending = null
    phase = 'idle'
    emit(gen, { state: 'success' })
    return { ok: true, message: 'Signed in.' }
  }

  function cancelLogin(): AccountVerbResult {
    if (phase === 'persisting') {
      return {
        ok: false,
        message: 'Sign-in is already completing and can no longer be cancelled.',
      }
    }
    generation++ // drop any late progress from the abandoned attempt
    activeOAuthRunner?.cancel?.()
    activeOAuthRunner = null
    if (resolveManualCode) {
      // Unblock the real flow's manual-code wait so its callback server tears
      // down (the empty code makes the flow throw, which we then drop by gen).
      const resolve = resolveManualCode
      resolveManualCode = null
      resolve('')
    }
    pending = null
    pendingProviderActivation = null
    phase = 'idle'
    return { ok: true, message: 'Sign-in cancelled.' }
  }

  return {
    getSnapshot() {
      try {
        return buildAccountsSnapshot(
          getPoolStatus(),
          Date.now(),
          getClaudePoolStatus(),
        )
      } catch {
        return null
      }
    },

    refreshUsage() {
      return executor.refreshUsage()
    },

    async applyDeletedProfile(accountId) {
      const account = resolveAccount(accountId)
      if (!account) return false
      if (account.vaultFilePath && existsSync(account.vaultFilePath)) return false
      const result = await executor.delete(account.accountId)
      return result.ok
    },

    setOAuthProgressSink(sink) {
      progressSink = sink
    },

    isOAuthLoginInFlight() {
      // `activeOAuthRunner` is set synchronously inside `beginLogin`, before
      // the flow's first await, and cleared when it settles or is cancelled;
      // `phase` covers the steps after `begin()` resolves (alias, persist).
      return activeOAuthRunner !== null || phase !== 'idle'
    },

    async runVerb(verb) {
      switch (verb.type) {
        case 'account.switch': {
          if (verb.provider === 'anthropic') {
            const account = getClaudePoolStatus().accounts.find(
              candidate => candidate.accountUuid === verb.accountId,
            )
            if (!account) {
              return notFound('account.switch')
            }
            if (account.status !== 'healthy') {
              return {
                verb: 'account.switch',
                result: {
                  ok: false,
                  message: 'That Anthropic account needs to be signed in again.',
                },
                poolChanged: false,
              }
            }
            const result = await executor.switchAnthropic(account.accountUuid)
            return {
              verb: 'account.switch',
              result,
              poolChanged: result.ok,
            }
          }
          const account = await resolveAccountForWrite(verb.accountId)
          if (!account) {
            return notFound('account.switch')
          }
          // `switchToAccount` returns null when the target is not uniquely
          // resolvable or not switchable, so the switch can fail here. Report
          // what actually happened, as the Anthropic arm above already does:
          // an unconditional `true` re-broadcasts a pool change to every
          // connection for a switch that never took place.
          const result = executor.switch(account.accountId)
          return {
            verb: 'account.switch',
            result,
            poolChanged: result.ok,
          }
        }
        case 'account.rename': {
          const account = await resolveAccountForWrite(verb.accountId)
          if (!account) {
            return notFound('account.rename')
          }
          if (!account.vaultFilePath) {
            return {
              verb: 'account.rename',
              result: { ok: false, message: 'Only vault-backed accounts can be renamed.' },
              poolChanged: false,
            }
          }
          // T6 — re-validate against the LIVE pool (uniqueness), not a renderer claim.
          const valid = validateCodexAccountAlias(verb.alias, account.accountId)
          if (!valid.ok) {
            return {
              verb: 'account.rename',
              result: { ok: false, message: valid.message },
              poolChanged: false,
            }
          }
          const result = executor.rename(account.accountId, verb.alias)
          return { verb: 'account.rename', result, poolChanged: result.ok }
        }
        case 'account.delete': {
          const account = await resolveAccountForWrite(verb.accountId)
          if (!account) {
            return notFound('account.delete')
          }
          if (!account.vaultFilePath) {
            return {
              verb: 'account.delete',
              result: { ok: false, message: 'Only vault-backed accounts can be deleted.' },
              poolChanged: false,
            }
          }
          const result = await executor.delete(account.accountId)
          return { verb: 'account.delete', result, poolChanged: result.ok }
        }
        case 'account.logout': {
          const result = executor.logout()
          return { verb: 'account.logout', result, poolChanged: result.ok }
        }
        case 'account.touchAll': {
          const result = await executor.touchAll()
          return { verb: 'account.touchAll', result, poolChanged: true }
        }
        case 'account.login': {
          // Begin the REAL OAuth flow; progress flows on the `oauth.login.progress`
          // frame, the account appears on the `accounts.snapshot` re-broadcast the
          // server fires on the `success` progress — never via this verb result.
          return {
            verb: 'account.login',
            result: beginLogin(verb.provider ?? 'openai'),
            poolChanged: false,
          }
        }
        case 'account.oauthPasteCode': {
          return {
            verb: 'account.oauthPasteCode',
            result: submitPasteCode(verb.code),
            poolChanged: false,
          }
        }
        case 'account.oauthAlias': {
          return {
            verb: 'account.oauthAlias',
            result: await submitAlias(verb.alias),
            poolChanged: false,
          }
        }
        case 'account.oauthCancel': {
          return { verb: 'account.oauthCancel', result: cancelLogin(), poolChanged: false }
        }
        default: {
          // Exhaustiveness tripwire — a new verb must extend this switch.
          const never: never = verb
          throw new Error(`unhandled account verb: ${JSON.stringify(never)}`)
        }
      }
    },
  }
}

function notFound(verb: AccountVerbType): {
  verb: AccountVerbType
  result: AccountVerbResult
  poolChanged: boolean
} {
  return {
    verb,
    result: { ok: false, message: 'That account is no longer in the pool.' },
    poolChanged: false,
  }
}
