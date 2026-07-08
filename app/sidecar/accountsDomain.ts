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

import {
  describeCodexAccountAvailability,
  getCodexAccountAvailability,
  getPoolStatus,
  isCodexAccountSwitchable,
  removeCodexAccount,
  setAccountAlias,
  switchToAccount,
  validateCodexAccountAlias,
  type PoolAccount,
} from '../../src/services/api/codexAccountPool.js'
import { touchAll } from '../../src/services/api/codexTokenRefresh.js'
import { clearCodexOAuthTokens } from '../../src/utils/auth.js'
import type {
  AccountResultFrame,
  AccountsSnapshot,
  AccountStatus,
  AccountVerbMessage,
  AccountVerbType,
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
  /** Rename a vault account. `alias` already re-validated against the live pool. */
  rename(accountId: string, alias: string): AccountVerbResult
  /** Delete a vault account profile. `accountId` already re-resolved + vault-checked. */
  delete(accountId: string): AccountVerbResult
  /** Sign out the active account (clears its token; profile stays). */
  logout(): AccountVerbResult
  /** Refresh OAuth tokens for every unlocked vault account. */
  touchAll(): Promise<AccountVerbResult>
  /** Begin the engine's real OAuth login flow. */
  login(): AccountVerbResult
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

/** Project the whole pool status to the redacted snapshot. Pure. */
export function buildAccountsSnapshot(
  poolStatus: {
    accounts: readonly PoolAccount[]
    activeIndex: number
    initialized: boolean
  },
  now = Date.now(),
): AccountsSnapshot {
  const activeAccount = poolStatus.accounts[poolStatus.activeIndex]
  const activeAccountId = activeAccount?.accountId ?? null
  const accounts = poolStatus.accounts.map((account, index) =>
    buildAccountStatus(account, index === poolStatus.activeIndex, now),
  )
  const readyCount = poolStatus.accounts.filter(
    a => a.status === 'healthy' && a.usageLimitReached !== true,
  ).length
  return {
    accounts,
    activeAccountId,
    readyCount,
    poolCount: poolStatus.accounts.length,
    initialized: poolStatus.initialized,
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
    rename(accountId, alias) {
      const ok = setAccountAlias(accountId, alias)
      return ok
        ? { ok: true, message: `Renamed to ${alias}` }
        : { ok: false, message: 'Could not rename that account.' }
    },
    delete(accountId) {
      const ok = removeCodexAccount(accountId)
      return ok
        ? { ok: true, message: 'Account deleted.' }
        : { ok: false, message: 'Could not delete that account.' }
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
    login() {
      // The live OAuth flow (browser + localhost:1455 callback + token install)
      // is coordinated with P4-15's first-run auth, which owns the shared OAuth
      // surface + the progress back-channel. Deferred here — see the P4-5 report.
      return {
        ok: false,
        message:
          'Sign-in runs through the engine OAuth flow (coordinated with first-run auth, P4-15).',
      }
    },
  }
}

/* ------------------------------------------------------------------------- *
 * Domain
 * ------------------------------------------------------------------------- */

export function createSidecarAccountsDomain(
  options: { executor?: AccountsCommandExecutor } = {},
): SidecarAccountsDomain {
  const executor = options.executor ?? createRealAccountsExecutor()

  function resolveAccount(accountId: string): PoolAccount | undefined {
    return getPoolStatus().accounts.find(a => a.accountId === accountId)
  }

  return {
    getSnapshot() {
      try {
        return buildAccountsSnapshot(getPoolStatus())
      } catch {
        return null
      }
    },

    async runVerb(verb) {
      switch (verb.type) {
        case 'account.switch': {
          const account = resolveAccount(verb.accountId)
          if (!account) {
            return notFound('account.switch')
          }
          return {
            verb: 'account.switch',
            result: executor.switch(account.accountId),
            poolChanged: true,
          }
        }
        case 'account.rename': {
          const account = resolveAccount(verb.accountId)
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
          const account = resolveAccount(verb.accountId)
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
          const result = executor.delete(account.accountId)
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
          const result = executor.login()
          return { verb: 'account.login', result, poolChanged: result.ok }
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
