import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'
import * as fsModule from 'node:fs'
import * as codexPoolModule from '../../src/services/api/codexAccountPool.js'
import * as leaseManagerModule from '../../src/services/api/codexAccountLeaseManager.js'
import * as codexFetchAdapterModule from '../../src/services/api/codex-fetch-adapter.js'
import * as logoutModule from '../../src/commands/logout/logout.js'
import {
  resetCodexAccountPoolForTest,
  seedCodexAccountPoolForTest,
  type PoolAccount,
} from '../../src/services/api/codexAccountPool.js'
import {
  resetClaudeAccountPoolForTest,
  seedClaudeAccountPoolForTest,
  type ClaudePoolAccount,
} from '../../src/services/api/claudeAccountPool.js'
import type { OAuthTokens } from '../../src/services/oauth/types.js'
import type { SettingsJson } from '../../src/utils/settings/types.js'
import { scanForSecrets } from '../shared/secretGuard.js'
import type {
  AccountsSnapshotFrame,
  OAuthLoginProgress,
  OAuthLoginProgressFrame,
} from '../shared/protocol.js'
import {
  buildAccountsSnapshot,
  buildAccountStatus,
  createRealAnthropicOAuthLoginRunner,
  createRealAccountsExecutor,
  createSidecarAccountsDomain,
  resolveAnthropicSubscriptionActive,
  type AccountsCommandExecutor,
  type AccountVerbResult,
  type OAuthLoginRunner,
  type OAuthPendingLogin,
} from './accountsDomain.js'

/**
 * A token-BEARING fixture. The projection must strip every secret field; the
 * redaction test asserts none survive AND that `secretGuard` clears the frame.
 */
function poolAccount(overrides: Partial<PoolAccount> = {}): PoolAccount {
  return {
    accountId: 'acct-0000-1111-2222',
    accessToken: 'SECRET-access-token-should-never-leak',
    refreshToken: 'SECRET-refresh-token-should-never-leak',
    expiresAt: 9_999_999_999,
    source: 'vault',
    status: 'healthy',
    lastUsedAt: 1_000,
    credentialGeneration: 0,
    credentialGenerationState: 'legacy_unbound',
    vaultFilePath: '/Users/secret/.cat-code/vault/accounts/acct.json',
    alias: 'work-laptop',
    usagePrimary: 40,
    usageWeekly: 55,
    usageLimitReached: false,
    usageResetAt: 1_700_000_000,
    usageWeeklyResetAt: 1_700_200_000,
    lastRefreshIso: '2026-07-07T10:00:00Z',
    planType: 'plus',
    ...overrides,
  }
}

afterEach(() => {
  mock.restore()
  resetCodexAccountPoolForTest()
  resetClaudeAccountPoolForTest()
})

/**
 * The domain re-reads the vault from disk when a write target misses the
 * in-process pool. Stub that by default so no test in this file can reach the
 * real vault (and so a seeded fixture pool is never overwritten by it); the
 * tests that exercise the re-read pass their own.
 */
function makeAccountsDomain(
  options: NonNullable<Parameters<typeof createSidecarAccountsDomain>[0]> = {},
) {
  return createSidecarAccountsDomain({
    reloadPool: async () => {},
    reloadAnthropicPool: async () => {},
    ...options,
  })
}

describe('P4-5 read-seam — redaction (the security-critical core)', () => {
  test('projection strips every credential field — no token, no vault path', () => {
    const status = buildAccountStatus(poolAccount(), true)
    const serialized = JSON.stringify(status)
    expect(serialized).not.toContain('SECRET-access-token')
    expect(serialized).not.toContain('SECRET-refresh-token')
    expect(serialized).not.toContain('/Users/secret')
    // The redacted shape carries presence flags + identifiers only.
    expect(status.hasVaultProfile).toBe(true)
    expect(status.id).toBe('acct-0000-1111-2222')
    expect(status.alias).toBe('work-laptop')
    expect('accessToken' in status).toBe(false)
    expect('refreshToken' in status).toBe(false)
    expect('vaultFilePath' in status).toBe(false)
  })

  test('secretGuard clears the whole snapshot frame built from token-bearing accounts', () => {
    const snapshot = buildAccountsSnapshot({
      accounts: [
        poolAccount(),
        poolAccount({ accountId: 'acct-b', alias: 'backup', accessToken: 'ANOTHER-SECRET' }),
      ],
      activeIndex: 0,
      initialized: true,
    })
    const frame: AccountsSnapshotFrame = {
      kind: 'accounts.snapshot',
      protocolVersion: 1,
      sessionId: 's1',
      accounts: snapshot,
    }
    const scan = scanForSecrets(frame)
    expect(scan.ok).toBe(true)
  })

  test('config-only accounts report hasVaultProfile:false', () => {
    const status = buildAccountStatus(
      poolAccount({ source: 'config', vaultFilePath: undefined }),
      false,
    )
    expect(status.hasVaultProfile).toBe(false)
    expect(status.source).toBe('config')
  })
})

describe('P4-5 read-seam — projection semantics', () => {
  test('projection carries the weekly reset independently of the 5h reset', () => {
    const status = buildAccountStatus(poolAccount({
      usageResetAt: 1_700_000_000,
      usageWeeklyResetAt: 1_700_200_000,
    }), true)

    expect(status.usageResetAt).toBe(1_700_000_000)
    expect(status.usageWeeklyResetAt).toBe(1_700_200_000)
  })

  test('snapshot includes a redacted Anthropic account pool', () => {
    const claudeAccount: ClaudePoolAccount = {
      accountUuid: 'claude-account-1',
      emailAddress: 'claude@example.com',
      accessToken: 'SECRET-claude-access',
      refreshToken: 'SECRET-claude-refresh',
      expiresAt: 9_999_999_999,
      status: 'healthy',
      alias: 'personal-claude',
      subscriptionType: 'pro',
      vaultFilePath: '/Users/secret/claude-vault/account.json',
    }
    seedClaudeAccountPoolForTest({
      accounts: [claudeAccount],
      activeAccountUuid: claudeAccount.accountUuid,
    })

    const snapshot = makeAccountsDomain({
      executor: fakeExecutor(),
    }).getSnapshot()

    expect(snapshot?.anthropicPoolCount).toBe(1)
    expect(snapshot?.anthropicReadyCount).toBe(1)
    expect(snapshot?.anthropicActiveAccountId).toBe('claude-account-1')
    expect(snapshot?.anthropicAccounts).toEqual([
      {
        id: 'claude-account-1',
        alias: 'personal-claude',
        email: 'claude@example.com',
        status: 'healthy',
        isDefault: true,
        hasVaultProfile: true,
        subscriptionType: 'pro',
      },
    ])
    const serialized = JSON.stringify(snapshot)
    expect(serialized).not.toContain('SECRET-claude')
    expect(serialized).not.toContain('/Users/secret')
  })

  test('snapshot derives readyCount / activeAccountId / switchable', () => {
    const snapshot = buildAccountsSnapshot({
      accounts: [
        poolAccount({ accountId: 'a', alias: 'a' }), // active, healthy
        poolAccount({ accountId: 'b', alias: 'b', status: 'dead' }),
        poolAccount({ accountId: 'c', alias: 'c', status: 'healthy', usageLimitReached: true }),
        poolAccount({ accountId: 'd', alias: 'd', status: 'capped' }),
      ],
      activeIndex: 0,
      initialized: true,
    })
    expect(snapshot.poolCount).toBe(4)
    expect(snapshot.activeAccountId).toBe('a')
    // readyCount is the prototype "N of M ready" stat: healthy AND not usage-capped
    // → only 'a' (dead 'b', soft-capped 'c', hard-capped 'd' all excluded).
    expect(snapshot.readyCount).toBe(1)
    // switchable follows the AUTHORITATIVE engine rule (isCodexAccountSwitchable =
    // availability !== 'blocked'), which can legitimately differ from readyCount's
    // display heuristic: 'a' is default (not switchable), 'b'/'d' are blocked, but
    // 'c' (soft usageLimitReached with no FRESH usage hint) is NOT engine-blocked.
    expect(snapshot.accounts.find(a => a.id === 'a')?.isDefault).toBe(true)
    expect(snapshot.accounts.find(a => a.id === 'a')?.switchable).toBe(false)
    expect(snapshot.accounts.find(a => a.id === 'b')?.switchable).toBe(false)
    expect(snapshot.accounts.find(a => a.id === 'd')?.switchable).toBe(false)
    expect(snapshot.accounts.find(a => a.id === 'c')?.switchable).toBe(true)
  })

  test('snapshot exposes only a boolean for non-pool Anthropic route availability', () => {
    const snapshot = buildAccountsSnapshot(
      { accounts: [], activeIndex: 0, initialized: true },
      Date.now(),
      { accounts: [], activeIndex: 0, initialized: true },
      true,
    )
    expect(snapshot.anthropicRouteAvailable).toBe(true)
    expect(scanForSecrets(snapshot).ok).toBe(true)
  })

  test('subscription attribution follows effective request auth, not a retained OAuth token', () => {
    expect(resolveAnthropicSubscriptionActive(() => false)).toBe(false)
    const snapshot = buildAccountsSnapshot(
      { accounts: [], activeIndex: 0, initialized: true },
      Date.now(),
      { accounts: [], activeIndex: 0, initialized: true },
      true,
      false,
    )
    expect(snapshot.anthropicRouteAvailable).toBe(true)
    expect(snapshot.anthropicSubscriptionActive).toBe(false)
  })

  test('getSnapshot is throw-free on an empty pool', () => {
    const domain = makeAccountsDomain({ executor: fakeExecutor() })
    const snapshot = domain.getSnapshot()
    expect(snapshot).not.toBeNull()
    expect(snapshot?.poolCount).toBe(0)
    expect(snapshot?.activeAccountId).toBeNull()
  })
})

function fakeExecutor(over: Partial<AccountsCommandExecutor> = {}): AccountsCommandExecutor {
  const ok = (message: string): AccountVerbResult => ({ ok: true, message })
  return {
    switch: async () => ok('switched'),
    switchAnthropic: async () => ok('switched anthropic'),
    rename: () => ok('renamed'),
    delete: async () => ok('deleted'),
    logout: () => ok('signed out'),
    touchAll: async () => ({ ok: true, message: 'done', touchAllResults: [] }),
    refreshUsage: async () => false,
    ...over,
  }
}

/** Flush the async OAuth-controller microtask chain (begin → pending → emit). */
const flush = () => new Promise(resolve => setTimeout(resolve, 0))

describe('real Codex delete executor cleanup', () => {
  test('serializes profile removal and repairs leases and auth caches', async () => {
    const deleted = poolAccount({
      accountId: 'delete-me',
      vaultFilePath: '/test-vault/accounts/delete-me.json',
    })
    const remaining = poolAccount({
      accountId: 'keep-me',
      vaultFilePath: '/test-vault/accounts/keep-me.json',
    })
    seedCodexAccountPoolForTest({
      accounts: [deleted, remaining],
      activeAccountId: deleted.accountId,
    })

    const order: string[] = []
    spyOn(codexPoolModule, 'removeCodexAccount').mockImplementation(accountId => {
      order.push(`remove:${accountId}`)
      seedCodexAccountPoolForTest({
        accounts: [remaining],
        activeAccountId: remaining.accountId,
      })
      return true
    })
    const repair = spyOn(
      leaseManagerModule,
      'repairLeasesForDeletedAccount',
    ).mockImplementation(accountId => {
      order.push(`repair:${accountId}`)
    })
    const reassign = spyOn(
      leaseManagerModule,
      'reassignCodexLeaseToActiveAccount',
    ).mockImplementation(ownerId => {
      order.push(`reassign:${ownerId}`)
    })
    const releaseLease = spyOn(
      leaseManagerModule,
      'releaseCodexLease',
    ).mockImplementation(() => {})
    const resetCache = spyOn(
      codexFetchAdapterModule,
      'resetCodexCacheContext',
    ).mockImplementation(() => {
      order.push('reset-cache')
    })
    const clearCaches = spyOn(
      logoutModule,
      'clearAuthRelatedCaches',
    ).mockImplementation(async () => {
      order.push('clear-auth-caches')
    })

    const result = await createRealAccountsExecutor().delete(deleted.accountId)

    expect(result).toEqual({ ok: true, message: 'Account deleted.' })
    expect(repair).toHaveBeenCalledWith(deleted.accountId)
    expect(reassign).toHaveBeenCalledWith('main-thread')
    expect(releaseLease).not.toHaveBeenCalled()
    expect(resetCache).toHaveBeenCalledTimes(1)
    expect(clearCaches).toHaveBeenCalledTimes(1)
    expect(order).toEqual([
      `remove:${deleted.accountId}`,
      `repair:${deleted.accountId}`,
      'reassign:main-thread',
      'reset-cache',
      'clear-auth-caches',
    ])
  })

  test('releases the main-thread lease after deleting the final account', async () => {
    const deleted = poolAccount({
      accountId: 'delete-final',
      vaultFilePath: '/test-vault/accounts/delete-final.json',
    })
    seedCodexAccountPoolForTest({
      accounts: [deleted],
      activeAccountId: deleted.accountId,
    })

    spyOn(codexPoolModule, 'removeCodexAccount').mockImplementation(() => {
      seedCodexAccountPoolForTest({ accounts: [] })
      return true
    })
    spyOn(
      leaseManagerModule,
      'repairLeasesForDeletedAccount',
    ).mockImplementation(() => {})
    const reassign = spyOn(
      leaseManagerModule,
      'reassignCodexLeaseToActiveAccount',
    ).mockImplementation(() => {})
    const releaseLease = spyOn(
      leaseManagerModule,
      'releaseCodexLease',
    ).mockImplementation(() => {})
    spyOn(
      codexFetchAdapterModule,
      'resetCodexCacheContext',
    ).mockImplementation(() => {})
    spyOn(logoutModule, 'clearAuthRelatedCaches').mockImplementation(
      async () => {},
    )

    const result = await createRealAccountsExecutor().delete(deleted.accountId)

    expect(result.ok).toBe(true)
    expect(reassign).not.toHaveBeenCalled()
    expect(releaseLease).toHaveBeenCalledWith('main-thread')
  })
})

/*
 * The desktop switch used to call `switchToAccount` and stop there, while the
 * terminal `/switch-account` ran the whole transaction. The pool write alone
 * leaves live `follow-main` subagent leases on the previous account and never
 * clears the sticky-HTTP-fallback / auth-sensitive caches. The transaction
 * itself is the engine's (`commitCodexAccountSwitch`); what this side owes is
 * calling it, and reporting its refusal honestly.
 */
describe('real Codex switch executor', () => {
  test('runs the engine switch transaction, not just the pool write', async () => {
    const switched: string[] = []
    const executor = createRealAccountsExecutor({
      commitSwitch: async accountId => {
        switched.push(accountId)
        return poolAccount({ accountId, alias: 'work' })
      },
    })

    const result = await executor.switch('b')

    expect(switched).toEqual(['b'])
    expect(result).toEqual({ ok: true, message: 'Switched to work' })
  })

  test('a refused transaction reports ok:false and the pool as unchanged', async () => {
    seedCodexAccountPoolForTest({
      accounts: [poolAccount({ accountId: 'a' }), poolAccount({ accountId: 'b' })],
      activeAccountId: 'a',
    })
    let calls = 0
    const domain = makeAccountsDomain({
      executor: createRealAccountsExecutor({
        commitSwitch: async () => {
          calls += 1
          return null
        },
      }),
    })

    const out = await domain.runVerb({
      type: 'account.switch',
      requestId: 'r1',
      accountId: 'b',
    })

    expect(calls).toBe(1)
    expect(out.result).toEqual({
      ok: false,
      message: 'Could not switch to that account.',
    })
    expect(out.poolChanged).toBe(false)
  })

  test('the verb awaits the transaction before reporting a pool change', async () => {
    seedCodexAccountPoolForTest({
      accounts: [poolAccount({ accountId: 'a' }), poolAccount({ accountId: 'b', alias: 'b' })],
      activeAccountId: 'a',
    })
    // Resolving on a later tick is what a sync `executor.switch(...)` call
    // could not have waited for: without the await the verb answered while the
    // lease reassignment and the cache clear were still outstanding.
    let settled = false
    const domain = makeAccountsDomain({
      executor: createRealAccountsExecutor({
        commitSwitch: async accountId => {
          await new Promise(resolve => setTimeout(resolve, 0))
          settled = true
          return poolAccount({ accountId, alias: 'b' })
        },
      }),
    })

    const out = await domain.runVerb({
      type: 'account.switch',
      requestId: 'r1',
      accountId: 'b',
    })

    expect(settled).toBe(true)
    expect(out.result.ok).toBe(true)
    expect(out.poolChanged).toBe(true)
  })
})

/**
 * A FAKE OAuth runner — never opens a browser, binds port 1455, or writes the
 * vault (the real run is the operator's live step). Drives the controller's state
 * machine deterministically for headless assertions.
 */
function fakeOAuthRunner(
  opts: {
    url?: string
    isExistingAccount?: boolean
    failWith?: string
    requireManualCode?: boolean
    validateAlias?: OAuthPendingLogin['validateAlias']
    onPersist?: (alias: string | undefined) => void
    onPasteReceived?: (code: string) => void
    validateManualCode?: OAuthLoginRunner['validateManualCode']
  } = {},
): OAuthLoginRunner {
  return {
    validateManualCode: opts.validateManualCode,
    async begin({ onWaitingForLogin, waitForManualCode }) {
      onWaitingForLogin(opts.url ?? 'https://auth.example/authorize?code_challenge=abc&state=xyz')
      if (opts.requireManualCode) {
        const code = await waitForManualCode()
        opts.onPasteReceived?.(code)
      }
      if (opts.failWith) throw new Error(opts.failWith)
      return {
        isExistingAccount: opts.isExistingAccount ?? false,
        validateAlias: opts.validateAlias ?? (() => ({ ok: true })),
        persist: alias => opts.onPersist?.(alias),
      }
    },
  }
}

describe('P4-5 verbs — pool-resolved business validation + round-trips', () => {
  test('switch re-resolves the accountId against the live pool and dispatches', async () => {
    seedCodexAccountPoolForTest({
      accounts: [poolAccount({ accountId: 'a', alias: 'a' }), poolAccount({ accountId: 'b', alias: 'b' })],
      activeAccountId: 'a',
    })
    const switched: string[] = []
    const domain = makeAccountsDomain({
      executor: fakeExecutor({ switch: async id => { switched.push(id); return { ok: true, message: 'ok' } } }),
    })
    const out = await domain.runVerb({ type: 'account.switch', requestId: 'r1', accountId: 'b' })
    expect(out.result.ok).toBe(true)
    expect(out.poolChanged).toBe(true)
    expect(switched).toEqual(['b'])
  })

  test('a verb targeting an account no longer in the pool fails closed (no dispatch)', async () => {
    seedCodexAccountPoolForTest({ accounts: [poolAccount({ accountId: 'a' })], activeAccountId: 'a' })
    let called = false
    const domain = makeAccountsDomain({
      executor: fakeExecutor({ switch: async () => { called = true; return { ok: true, message: 'ok' } } }),
    })
    const out = await domain.runVerb({ type: 'account.switch', requestId: 'r', accountId: 'ghost' })
    expect(out.result.ok).toBe(false)
    expect(out.poolChanged).toBe(false)
    expect(called).toBe(false)
  })

  /*
   * `getPoolStatus()` is the process-local pool, populated once at spawn, while
   * the accounts page the operator is looking at comes from the accounts
   * worker's 60 s re-read. So an account signed in from another window shows up
   * in the list within a minute and every write aimed at it from an older
   * session was refused for that session's whole life.
   */
  test('a write against an account this process has not seen re-reads the vault once and then dispatches', async () => {
    seedCodexAccountPoolForTest({
      accounts: [poolAccount({ accountId: 'a', alias: 'a' })],
      activeAccountId: 'a',
    })
    let reloads = 0
    const switched: string[] = []
    const domain = makeAccountsDomain({
      executor: fakeExecutor({
        switch: async id => {
          switched.push(id)
          return { ok: true, message: 'ok' }
        },
      }),
      // Stands in for another process having signed in account `b`.
      reloadPool: async () => {
        reloads += 1
        seedCodexAccountPoolForTest({
          accounts: [
            poolAccount({ accountId: 'a', alias: 'a' }),
            poolAccount({ accountId: 'b', alias: 'b' }),
          ],
          activeAccountId: 'a',
        })
      },
    })

    const out = await domain.runVerb({
      type: 'account.switch',
      requestId: 'r1',
      accountId: 'b',
    })

    expect(out.result.ok).toBe(true)
    expect(switched).toEqual(['b'])
    expect(reloads).toBe(1)
  })

  test('a write against an account already in this process does NOT pay a vault re-read', async () => {
    seedCodexAccountPoolForTest({
      accounts: [poolAccount({ accountId: 'a', alias: 'a' }), poolAccount({ accountId: 'b', alias: 'b' })],
      activeAccountId: 'a',
    })
    let reloads = 0
    const domain = makeAccountsDomain({
      executor: fakeExecutor(),
      reloadPool: async () => {
        reloads += 1
      },
    })

    await domain.runVerb({ type: 'account.switch', requestId: 'r1', accountId: 'b' })

    // The ordinary path stays a pure in-memory resolve, so the pool's live
    // usage hints are not thrown away on every verb.
    expect(reloads).toBe(0)
  })

  test('a still-missing account after the re-read fails closed, and the re-read runs only once', async () => {
    seedCodexAccountPoolForTest({ accounts: [poolAccount({ accountId: 'a' })], activeAccountId: 'a' })
    let reloads = 0
    let called = false
    const domain = makeAccountsDomain({
      executor: fakeExecutor({
        switch: async () => {
          called = true
          return { ok: true, message: 'ok' }
        },
      }),
      reloadPool: async () => {
        reloads += 1
      },
    })

    const out = await domain.runVerb({
      type: 'account.switch',
      requestId: 'r',
      accountId: 'ghost',
    })

    expect(out.result.ok).toBe(false)
    expect(called).toBe(false)
    expect(reloads).toBe(1)
  })

  test('a failed Codex switch does NOT report the pool as changed', async () => {
    // `switchToAccount` returns null when the target is not uniquely resolvable
    // or not switchable, so an unconditional `poolChanged: true` re-broadcast a
    // pool change to every connection for a switch that never happened. The
    // Anthropic arm already keyed this on the result.
    seedCodexAccountPoolForTest({
      accounts: [poolAccount({ accountId: 'a' }), poolAccount({ accountId: 'b' })],
      activeAccountId: 'a',
    })
    const domain = makeAccountsDomain({
      executor: fakeExecutor({
        switch: async () => ({ ok: false, message: 'Could not switch to that account.' }),
      }),
    })

    const out = await domain.runVerb({
      type: 'account.switch',
      requestId: 'r1',
      accountId: 'b',
    })

    expect(out.result.ok).toBe(false)
    expect(out.poolChanged).toBe(false)
  })

  test('Anthropic account switch resolves against the Claude pool and dispatches the provider-specific path', async () => {
    const claudeAccount: ClaudePoolAccount = {
      accountUuid: 'claude-b',
      emailAddress: 'b@example.com',
      accessToken: 'secret',
      refreshToken: 'secret',
      expiresAt: 9_999_999_999,
      status: 'healthy',
    }
    seedClaudeAccountPoolForTest({
      accounts: [claudeAccount],
      activeAccountUuid: claudeAccount.accountUuid,
    })
    const switched: string[] = []
    const domain = makeAccountsDomain({
      executor: fakeExecutor({
        switchAnthropic: async id => {
          switched.push(id)
          return { ok: true, message: 'ok' }
        },
      }),
    })

    const out = await domain.runVerb({
      type: 'account.switch',
      requestId: 'claude-switch',
      accountId: 'claude-b',
      provider: 'anthropic',
    })

    expect(out.result.ok).toBe(true)
    expect(out.poolChanged).toBe(true)
    expect(switched).toEqual(['claude-b'])
  })

  /*
   * The Anthropic twin of the Codex re-read above. `getClaudePoolStatus()` is
   * the same spawn-time process-local singleton, and the accounts page lists an
   * account signed in from another window within the worker's 60 s re-read, so
   * a switch aimed at that visible, clickable account was refused for this
   * session's whole life.
   */
  test('an Anthropic switch against an account this process has not seen re-reads the vault once and then dispatches', async () => {
    const known: ClaudePoolAccount = {
      accountUuid: 'claude-a',
      emailAddress: 'a@example.com',
      accessToken: 'secret',
      refreshToken: 'secret',
      expiresAt: 9_999_999_999,
      status: 'healthy',
    }
    const signedInElsewhere: ClaudePoolAccount = {
      accountUuid: 'claude-b',
      emailAddress: 'b@example.com',
      accessToken: 'secret',
      refreshToken: 'secret',
      expiresAt: 9_999_999_999,
      status: 'healthy',
    }
    seedClaudeAccountPoolForTest({
      accounts: [known],
      activeAccountUuid: known.accountUuid,
    })
    let reloads = 0
    const switched: string[] = []
    const domain = makeAccountsDomain({
      executor: fakeExecutor({
        switchAnthropic: async id => {
          switched.push(id)
          return { ok: true, message: 'ok' }
        },
      }),
      // Stands in for another process having signed in `claude-b`.
      reloadAnthropicPool: async () => {
        reloads += 1
        seedClaudeAccountPoolForTest({
          accounts: [known, signedInElsewhere],
          activeAccountUuid: known.accountUuid,
        })
      },
    })

    const out = await domain.runVerb({
      type: 'account.switch',
      requestId: 'claude-cross-process',
      accountId: 'claude-b',
      provider: 'anthropic',
    })

    expect(out.result.ok).toBe(true)
    expect(out.poolChanged).toBe(true)
    expect(switched).toEqual(['claude-b'])
    expect(reloads).toBe(1)
  })

  test('refreshUsage delegates to the executor and returns whether usage landed', async () => {
    // The desktop pool loads observation-only, so the snapshot's usage fields are
    // 0/null until refreshUsage runs the engine's wham/usage fetch. Prove the
    // domain forwards to the executor and propagates its "did usage change" bit
    // (the sidecar re-broadcasts only on true).
    let calls = 0
    const domain = makeAccountsDomain({
      executor: fakeExecutor({
        refreshUsage: async () => {
          calls += 1
          return true
        },
      }),
    })
    expect(await domain.refreshUsage()).toBe(true)
    expect(calls).toBe(1)

    const empty = makeAccountsDomain({
      executor: fakeExecutor({ refreshUsage: async () => false }),
    })
    expect(await empty.refreshUsage()).toBe(false)
  })

  test('rename rejects a duplicate alias via the engine validator, not a renderer claim', async () => {
    seedCodexAccountPoolForTest({
      accounts: [
        poolAccount({ accountId: 'a', alias: 'keep' }),
        poolAccount({ accountId: 'b', alias: 'taken' }),
      ],
      activeAccountId: 'a',
    })
    let renamed = false
    const domain = makeAccountsDomain({
      executor: fakeExecutor({ rename: () => { renamed = true; return { ok: true, message: 'ok' } } }),
    })
    const out = await domain.runVerb({ type: 'account.rename', requestId: 'r', accountId: 'a', alias: 'taken' })
    expect(out.result.ok).toBe(false)
    expect(renamed).toBe(false)
  })

  test('rename rejects an invalid alias (regex) before dispatch', async () => {
    seedCodexAccountPoolForTest({ accounts: [poolAccount({ accountId: 'a', alias: 'keep' })], activeAccountId: 'a' })
    const domain = makeAccountsDomain({ executor: fakeExecutor() })
    const out = await domain.runVerb({ type: 'account.rename', requestId: 'r', accountId: 'a', alias: 'bad alias!' })
    expect(out.result.ok).toBe(false)
  })

  test('applyDeletedProfile removes a known local account through the executor', async () => {
    seedCodexAccountPoolForTest({
      accounts: [poolAccount({ accountId: 'known' })],
      activeAccountId: 'known',
    })
    const deleted: string[] = []
    const domain = makeAccountsDomain({
      executor: fakeExecutor({
        delete: async accountId => {
          deleted.push(accountId)
          seedCodexAccountPoolForTest({ accounts: [] })
          return { ok: true, message: 'deleted locally' }
        },
      }),
    })

    expect(await domain.applyDeletedProfile('known')).toBe(true)
    expect(deleted).toEqual(['known'])
    expect(domain.getSnapshot()?.accounts).toEqual([])
  })

  test('applyDeletedProfile does nothing for an unknown local account', async () => {
    seedCodexAccountPoolForTest({
      accounts: [poolAccount({ accountId: 'known' })],
      activeAccountId: 'known',
    })
    let deletes = 0
    let reloads = 0
    const domain = makeAccountsDomain({
      executor: fakeExecutor({
        delete: async () => {
          deletes += 1
          return { ok: true, message: 'deleted' }
        },
      }),
      reloadPool: async () => {
        reloads += 1
      },
    })

    expect(await domain.applyDeletedProfile('unknown')).toBe(false)
    expect(deletes).toBe(0)
    expect(reloads).toBe(0)
  })

  test('applyDeletedProfile preserves a profile that was re-added before notice delivery', async () => {
    seedCodexAccountPoolForTest({
      accounts: [
        poolAccount({
          accountId: 're-added',
          vaultFilePath: '/test-vault/accounts/re-added.json',
        }),
      ],
      activeAccountId: 're-added',
    })
    spyOn(fsModule, 'existsSync').mockReturnValue(true)
    let deletes = 0
    const domain = makeAccountsDomain({
      executor: fakeExecutor({
        delete: async () => {
          deletes += 1
          return { ok: true, message: 'deleted' }
        },
      }),
    })

    expect(await domain.applyDeletedProfile('re-added')).toBe(false)
    expect(deletes).toBe(0)
  })

  test('concurrent async delete verbs keep their results correlated to their caller', async () => {
    seedCodexAccountPoolForTest({
      accounts: [
        poolAccount({ accountId: 'a' }),
        poolAccount({ accountId: 'b' }),
      ],
      activeAccountId: 'a',
    })
    const resolvers = new Map<
      string,
      (result: AccountVerbResult) => void
    >()
    const domain = makeAccountsDomain({
      executor: fakeExecutor({
        delete: accountId =>
          new Promise(resolve => {
            resolvers.set(accountId, resolve)
          }),
      }),
    })

    const first = domain.runVerb({
      type: 'account.delete',
      requestId: 'delete-a',
      accountId: 'a',
      confirm: true,
    })
    const second = domain.runVerb({
      type: 'account.delete',
      requestId: 'delete-b',
      accountId: 'b',
      confirm: true,
    })
    await flush()

    resolvers.get('b')?.({ ok: true, message: 'deleted b' })
    resolvers.get('a')?.({ ok: true, message: 'deleted a' })

    expect(await first).toEqual({
      verb: 'account.delete',
      result: { ok: true, message: 'deleted a' },
      poolChanged: true,
    })
    expect(await second).toEqual({
      verb: 'account.delete',
      result: { ok: true, message: 'deleted b' },
      poolChanged: true,
    })
  })

  test('rename/delete reject config-only accounts (no vault profile)', async () => {
    seedCodexAccountPoolForTest({
      accounts: [poolAccount({ accountId: 'a', source: 'config', vaultFilePath: undefined })],
      activeAccountId: 'a',
    })
    const domain = makeAccountsDomain({ executor: fakeExecutor() })
    const rename = await domain.runVerb({ type: 'account.rename', requestId: 'r', accountId: 'a', alias: 'new' })
    const del = await domain.runVerb({ type: 'account.delete', requestId: 'r', accountId: 'a', confirm: true })
    expect(rename.result.ok).toBe(false)
    expect(del.result.ok).toBe(false)
  })

  test('touchAll surfaces per-account results and marks the pool changed', async () => {
    const domain = makeAccountsDomain({
      executor: fakeExecutor({
        touchAll: async () => ({
          ok: true,
          message: 'done',
          touchAllResults: [{ alias: 'a', result: 'OK' }, { alias: 'b', result: 'FAILED' }],
        }),
      }),
    })
    const out = await domain.runVerb({ type: 'account.touchAll', requestId: 'r' })
    expect(out.result.touchAllResults?.length).toBe(2)
    expect(out.poolChanged).toBe(true)
  })

})

describe('P4-15 OAuth login controller — the live sign-in back-channel', () => {
  function makeDomain(runner: OAuthLoginRunner, captured: OAuthLoginProgress[]) {
    const domain = makeAccountsDomain({ executor: fakeExecutor(), oauthRunner: runner })
    domain.setOAuthProgressSink(p => captured.push(p))
    return domain
  }

  test('new account: waiting_for_login {url} → waiting_for_alias → success + persists the alias', async () => {
    const captured: OAuthLoginProgress[] = []
    const persisted: (string | undefined)[] = []
    const domain = makeDomain(
      fakeOAuthRunner({ url: 'https://auth.example/authz?state=xyz', onPersist: a => persisted.push(a) }),
      captured,
    )

    const begin = await domain.runVerb({ type: 'account.login', requestId: 'r1' })
    expect(begin.result.ok).toBe(true)
    expect(begin.poolChanged).toBe(false) // the account lands on the success re-broadcast
    await flush()

    expect(captured.map(p => p.state)).toEqual(['starting', 'waiting_for_login', 'waiting_for_alias'])
    const wl = captured.find(p => p.state === 'waiting_for_login')
    expect(wl?.state === 'waiting_for_login' && wl.url).toBe('https://auth.example/authz?state=xyz')

    const alias = await domain.runVerb({ type: 'account.oauthAlias', requestId: 'r2', alias: 'work' })
    expect(alias.result.ok).toBe(true)
    expect(persisted).toEqual(['work'])
    expect(captured.at(-1)?.state).toBe('success')
  })

  test('Anthropic login uses the Anthropic runner and auto-persists without a Codex alias step', async () => {
    const captured: OAuthLoginProgress[] = []
    const providers: string[] = []
    const domain = makeAccountsDomain({
      executor: fakeExecutor(),
      oauthRunner: fakeOAuthRunner({
        failWith: 'Codex runner must not be used',
      }),
      anthropicOAuthRunner: {
        async begin({ onWaitingForLogin }) {
          providers.push('anthropic')
          onWaitingForLogin('https://claude.ai/oauth/authorize')
          return {
            isExistingAccount: true,
            validateAlias: () => ({ ok: true }),
            persist: () => {},
          }
        },
      },
    })
    domain.setOAuthProgressSink(p => captured.push(p))

    const begin = await domain.runVerb({
      type: 'account.login',
      requestId: 'anthropic-login',
      provider: 'anthropic',
    })
    expect(begin.result.ok).toBe(true)
    await flush()

    expect(providers).toEqual(['anthropic'])
    expect(captured.map(p => p.state)).toEqual([
      'starting',
      'waiting_for_login',
      'success',
    ])
  })

  test('first-run login activates the chosen provider only after credential persistence', async () => {
    const order: string[] = []
    const domain = makeAccountsDomain({
      executor: fakeExecutor(),
      anthropicOAuthRunner: {
        async begin() {
          return {
            isExistingAccount: true,
            validateAlias: () => ({ ok: true }),
            persist() {
              order.push('persist')
            },
          }
        },
      },
      onProviderActivated(provider) {
        order.push(`activate:${provider}`)
      },
      isFirstRunEligible: () => true,
    })

    await domain.runVerb({
      type: 'account.login',
      requestId: 'first-run-anthropic',
      provider: 'anthropic',
    })
    await flush()

    expect(order).toEqual(['persist', 'activate:anthropic'])
  })

  test('ordinary add-account login does not change the active provider', async () => {
    const activated: string[] = []
    const domain = makeAccountsDomain({
      executor: fakeExecutor(),
      anthropicOAuthRunner: {
        async begin() {
          return {
            isExistingAccount: true,
            validateAlias: () => ({ ok: true }),
            persist() {},
          }
        },
      },
      onProviderActivated(provider) {
        activated.push(provider)
      },
      isFirstRunEligible: () => false,
    })

    await domain.runVerb({
      type: 'account.login',
      requestId: 'add-anthropic',
      provider: 'anthropic',
    })
    await flush()

    expect(activated).toEqual([])
  })

  test('sidecar-owned account state denies activation for an ordinary add-account login', async () => {
    seedCodexAccountPoolForTest({
      accounts: [poolAccount({ accountId: 'existing-codex' })],
      activeAccountId: 'existing-codex',
    })
    seedClaudeAccountPoolForTest({
      accounts: [],
    })
    const activated: string[] = []
    const domain = makeAccountsDomain({
      executor: fakeExecutor(),
      anthropicOAuthRunner: {
        async begin() {
          return {
            isExistingAccount: true,
            validateAlias: () => ({ ok: true }),
            persist() {},
          }
        },
      },
      onProviderActivated(provider) {
        activated.push(provider)
      },
    })

    await domain.runVerb({
      type: 'account.login',
      requestId: 'server-owned-add-account',
      provider: 'anthropic',
    })
    await flush()

    expect(activated).toEqual([])
  })

  test('real Anthropic runner honors managed method/org and commits only after begin returns', async () => {
    const tokens: OAuthTokens = {
      accessToken: 'SECRET-access',
      refreshToken: 'SECRET-refresh',
      expiresAt: Date.now() + 60_000,
      scopes: ['user:inference'],
      subscriptionType: 'pro',
      rateLimitTier: null,
    }
    let oauthOptions:
      | { loginWithClaudeAi?: boolean; orgUUID?: string }
      | undefined
    let installs = 0
    let validations = 0
    const order: string[] = []
    const runner = createRealAnthropicOAuthLoginRunner({
      createService: () => ({
        async startOAuthFlow(handler, options) {
          oauthOptions = options
          await handler('https://auth.example/managed')
          return tokens
        },
        handleManualAuthCodeInput() {},
        cleanup() {},
      }),
      readSettings: () =>
        ({
          forceLoginMethod: 'console',
          forceLoginOrgUUID: 'org-managed',
        }) as SettingsJson,
      installTokens: async installed => {
        expect(installed).toBe(tokens)
        order.push('install')
        installs++
      },
      validateOrg: async accessToken => {
        expect(accessToken).toBe(tokens.accessToken)
        order.push('validate')
        validations++
        return { valid: true }
      },
    })
    expect(runner.validateManualCode?.('incomplete')).toEqual({
      ok: false,
      message:
        'Could not parse input. Paste the full callback URL or exact "<code>#<state>" value.',
    })
    expect(
      runner.validateManualCode?.(
        'https://localhost/callback?code=AUTH-CODE&state=STATE',
      ),
    ).toEqual({ ok: true })

    const pending = await runner.begin({
      onWaitingForLogin: () => {},
      waitForManualCode: async () => '',
    })
    expect(oauthOptions).toMatchObject({
      loginWithClaudeAi: false,
      orgUUID: 'org-managed',
    })
    expect(installs).toBe(0)
    await pending.persist(undefined)
    expect(installs).toBe(1)
    expect(validations).toBe(1)
    expect(order).toEqual(['validate', 'install'])
  })

  test('real Anthropic runner rejects a wrong managed org before any credential commit', async () => {
    const tokens: OAuthTokens = {
      accessToken: 'SECRET-wrong-org',
      refreshToken: 'SECRET-refresh',
      expiresAt: Date.now() + 60_000,
      scopes: ['user:inference'],
      subscriptionType: 'pro',
      rateLimitTier: null,
    }
    let installs = 0
    const runner = createRealAnthropicOAuthLoginRunner({
      createService: () => ({
        async startOAuthFlow() {
          return tokens
        },
        handleManualAuthCodeInput() {},
        cleanup() {},
      }),
      readSettings: () =>
        ({ forceLoginOrgUUID: 'org-required' }) as SettingsJson,
      installTokens: async () => {
        installs++
      },
      validateOrg: async accessToken => {
        expect(accessToken).toBe(tokens.accessToken)
        return { valid: false, message: 'Wrong managed organization.' }
      },
    })

    const pending = await runner.begin({
      onWaitingForLogin: () => {},
      waitForManualCode: async () => '',
    })
    await expect(pending.persist(undefined)).rejects.toThrow(
      'Wrong managed organization.',
    )
    expect(installs).toBe(0)
  })

  test('cancel before Anthropic callback settles the runner and never persists', async () => {
    let rejectFlow: ((error: Error) => void) | null = null
    let installs = 0
    const runner = createRealAnthropicOAuthLoginRunner({
      createService: () => ({
        startOAuthFlow: () =>
          new Promise<OAuthTokens>((_resolve, reject) => {
            rejectFlow = reject
          }),
        handleManualAuthCodeInput() {},
        cleanup() {
          rejectFlow?.(new Error('OAuth login cancelled'))
        },
      }),
      readSettings: () => ({}) as SettingsJson,
      installTokens: async () => {
        installs++
      },
    })
    const started = runner.begin({
      onWaitingForLogin: () => {},
      waitForManualCode: async () => '',
    })
    runner.cancel?.()
    await expect(started).rejects.toThrow('OAuth login cancelled')
    expect(installs).toBe(0)
  })

  test('empty alias = skip: persists undefined (anonymous / account email)', async () => {
    const captured: OAuthLoginProgress[] = []
    const persisted: (string | undefined)[] = []
    const domain = makeDomain(fakeOAuthRunner({ onPersist: a => persisted.push(a) }), captured)
    await domain.runVerb({ type: 'account.login', requestId: 'r1' })
    await flush()
    await domain.runVerb({ type: 'account.oauthAlias', requestId: 'r2', alias: '   ' })
    expect(persisted).toEqual([undefined])
    expect(captured.at(-1)?.state).toBe('success')
  })

  test('existing account (reauth): auto-persists keeping the name, skips the alias step', async () => {
    const captured: OAuthLoginProgress[] = []
    const persisted: (string | undefined)[] = []
    const domain = makeDomain(
      fakeOAuthRunner({ isExistingAccount: true, onPersist: a => persisted.push(a) }),
      captured,
    )
    await domain.runVerb({ type: 'account.login', requestId: 'r1' })
    await flush()
    expect(captured.map(p => p.state)).toEqual(['starting', 'waiting_for_login', 'success'])
    expect(persisted).toEqual([undefined]) // undefined = appendAccount preserves the existing alias
  })

  test('error path surfaces the real engine message (retryable), does not persist', async () => {
    const captured: OAuthLoginProgress[] = []
    const persisted: (string | undefined)[] = []
    const domain = makeDomain(
      fakeOAuthRunner({ failWith: 'authorization_request_timed_out', onPersist: a => persisted.push(a) }),
      captured,
    )
    await domain.runVerb({ type: 'account.login', requestId: 'r1' })
    await flush()
    expect(captured.at(-1)).toEqual({ state: 'error', message: 'authorization_request_timed_out' })
    expect(persisted).toEqual([])
  })

  test('paste-code feeds the manual input and advances to the alias step', async () => {
    const captured: OAuthLoginProgress[] = []
    const received: string[] = []
    const domain = makeDomain(
      fakeOAuthRunner({ requireManualCode: true, onPasteReceived: c => received.push(c) }),
      captured,
    )
    const begin = await domain.runVerb({ type: 'account.login', requestId: 'r1' })
    expect(begin.result.ok).toBe(true)
    // The flow is now blocked on the manual-code wait (waiting_for_login emitted).
    const paste = await domain.runVerb({
      type: 'account.oauthPasteCode',
      requestId: 'r2',
      code: 'AUTH-CODE-123',
    })
    expect(paste.result.ok).toBe(true)
    await flush()
    expect(received).toEqual(['AUTH-CODE-123'])
    expect(captured.some(p => p.state === 'waiting_for_alias')).toBe(true)
  })

  test('paste-code with no login in flight fails closed', async () => {
    const captured: OAuthLoginProgress[] = []
    const domain = makeDomain(fakeOAuthRunner(), captured)
    const paste = await domain.runVerb({ type: 'account.oauthPasteCode', requestId: 'r', code: 'x' })
    expect(paste.result.ok).toBe(false)
  })

  test('invalid Anthropic manual input can be corrected without restarting login', async () => {
    const captured: OAuthLoginProgress[] = []
    const received: string[] = []
    const domain = makeDomain(
      fakeOAuthRunner({
        requireManualCode: true,
        onPasteReceived: code => received.push(code),
        validateManualCode(code) {
          return code.includes('#')
            ? { ok: true }
            : {
                ok: false,
                message:
                  'Could not parse input. Paste the full callback URL or exact "<code>#<state>" value.',
              }
        },
      }),
      captured,
    )

    await domain.runVerb({ type: 'account.login', requestId: 'manual-start' })
    const invalid = await domain.runVerb({
      type: 'account.oauthPasteCode',
      requestId: 'manual-invalid',
      code: 'incomplete',
    })
    expect(invalid.result).toEqual({
      ok: false,
      message:
        'Could not parse input. Paste the full callback URL or exact "<code>#<state>" value.',
    })

    const corrected = await domain.runVerb({
      type: 'account.oauthPasteCode',
      requestId: 'manual-valid',
      code: 'AUTH-CODE#STATE',
    })
    expect(corrected.result.ok).toBe(true)
    await flush()
    expect(received).toEqual(['AUTH-CODE#STATE'])
    expect(captured.at(-1)?.state).toBe('waiting_for_alias')
  })

  test('a new login cannot supersede a credential write already in progress', async () => {
    let begins = 0
    const persistence = { finish: null as (() => void) | null }
    const captured: OAuthLoginProgress[] = []
    const domain = makeDomain(
      {
        async begin() {
          begins++
          return {
            isExistingAccount: true,
            validateAlias: () => ({ ok: true }),
            persist: () =>
              new Promise<void>(resolve => {
                persistence.finish = resolve
              }),
          }
        },
      },
      captured,
    )

    const first = await domain.runVerb({
      type: 'account.login',
      requestId: 'persisting-first',
    })
    expect(first.result.ok).toBe(true)
    await flush()

    const second = await domain.runVerb({
      type: 'account.login',
      requestId: 'persisting-second',
    })
    expect(second.result).toEqual({
      ok: false,
      message: 'Sign-in is already completing. Wait for it to finish.',
    })
    expect(begins).toBe(1)

    persistence.finish?.()
    await flush()
    expect(captured.filter(progress => progress.state === 'success')).toHaveLength(1)
  })

  test('alias validation failure keeps the alias step (no persist, no success)', async () => {
    const captured: OAuthLoginProgress[] = []
    const persisted: (string | undefined)[] = []
    const domain = makeDomain(
      fakeOAuthRunner({
        validateAlias: () => ({ ok: false, message: 'Invalid alias "bad name!".' }),
        onPersist: a => persisted.push(a),
      }),
      captured,
    )
    await domain.runVerb({ type: 'account.login', requestId: 'r1' })
    await flush()
    const bad = await domain.runVerb({ type: 'account.oauthAlias', requestId: 'r2', alias: 'bad name!' })
    expect(bad.result.ok).toBe(false)
    expect(bad.result.message).toContain('Invalid alias')
    expect(persisted).toEqual([])
    expect(captured.at(-1)?.state).toBe('waiting_for_alias') // still naming, never succeeded
  })

  test('cancel drops later progress and rejects a subsequent paste', async () => {
    const captured: OAuthLoginProgress[] = []
    const persisted: (string | undefined)[] = []
    const domain = makeDomain(
      fakeOAuthRunner({ requireManualCode: true, onPersist: a => persisted.push(a) }),
      captured,
    )
    await domain.runVerb({ type: 'account.login', requestId: 'r1' })
    const cancel = await domain.runVerb({ type: 'account.oauthCancel', requestId: 'rc' })
    expect(cancel.result.ok).toBe(true)
    await flush()
    // The abandoned attempt must not emit a late alias/success or persist.
    expect(captured.some(p => p.state === 'waiting_for_alias' || p.state === 'success')).toBe(false)
    expect(persisted).toEqual([])
    const paste = await domain.runVerb({ type: 'account.oauthPasteCode', requestId: 'rp', code: 'x' })
    expect(paste.result.ok).toBe(false)
  })

  test('every emitted progress frame is secretGuard-clean (no token rides the back-channel)', async () => {
    const captured: OAuthLoginProgress[] = []
    const domain = makeDomain(fakeOAuthRunner({ url: 'https://auth.example/authz?state=xyz' }), captured)
    await domain.runVerb({ type: 'account.login', requestId: 'r1' })
    await flush()
    await domain.runVerb({ type: 'account.oauthAlias', requestId: 'r2', alias: 'work' })
    expect(captured.length).toBeGreaterThan(0)
    for (const progress of captured) {
      const frame: OAuthLoginProgressFrame = {
        kind: 'oauth.login.progress',
        protocolVersion: 1,
        sessionId: 's1',
        progress,
      }
      expect(scanForSecrets(frame).ok).toBe(true)
    }
  })
})
