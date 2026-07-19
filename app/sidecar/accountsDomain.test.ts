import { afterEach, describe, expect, test } from 'bun:test'
import {
  resetCodexAccountPoolForTest,
  seedCodexAccountPoolForTest,
  type PoolAccount,
} from '../../src/services/api/codexAccountPool.js'
import { scanForSecrets } from '../shared/secretGuard.js'
import type {
  AccountsSnapshotFrame,
  OAuthLoginProgress,
  OAuthLoginProgressFrame,
} from '../shared/protocol.js'
import {
  buildAccountsSnapshot,
  buildAccountStatus,
  createSidecarAccountsDomain,
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
    vaultFilePath: '/Users/secret/.cat-code/vault/accounts/acct.json',
    alias: 'work-laptop',
    usagePrimary: 40,
    usageWeekly: 55,
    usageLimitReached: false,
    usageResetAt: 1_700_000_000,
    lastRefreshIso: '2026-07-07T10:00:00Z',
    planType: 'plus',
    ...overrides,
  }
}

afterEach(() => {
  resetCodexAccountPoolForTest()
})

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

  test('getSnapshot is throw-free on an empty pool', () => {
    const domain = createSidecarAccountsDomain({ executor: fakeExecutor() })
    const snapshot = domain.getSnapshot()
    expect(snapshot).not.toBeNull()
    expect(snapshot?.poolCount).toBe(0)
    expect(snapshot?.activeAccountId).toBeNull()
  })
})

function fakeExecutor(over: Partial<AccountsCommandExecutor> = {}): AccountsCommandExecutor {
  const ok = (message: string): AccountVerbResult => ({ ok: true, message })
  return {
    switch: () => ok('switched'),
    rename: () => ok('renamed'),
    delete: () => ok('deleted'),
    logout: () => ok('signed out'),
    touchAll: async () => ({ ok: true, message: 'done', touchAllResults: [] }),
    refreshUsage: async () => false,
    ...over,
  }
}

/** Flush the async OAuth-controller microtask chain (begin → pending → emit). */
const flush = () => new Promise(resolve => setTimeout(resolve, 0))

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
  } = {},
): OAuthLoginRunner {
  return {
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
    const domain = createSidecarAccountsDomain({
      executor: fakeExecutor({ switch: id => { switched.push(id); return { ok: true, message: 'ok' } } }),
    })
    const out = await domain.runVerb({ type: 'account.switch', requestId: 'r1', accountId: 'b' })
    expect(out.result.ok).toBe(true)
    expect(out.poolChanged).toBe(true)
    expect(switched).toEqual(['b'])
  })

  test('a verb targeting an account no longer in the pool fails closed (no dispatch)', async () => {
    seedCodexAccountPoolForTest({ accounts: [poolAccount({ accountId: 'a' })], activeAccountId: 'a' })
    let called = false
    const domain = createSidecarAccountsDomain({
      executor: fakeExecutor({ switch: () => { called = true; return { ok: true, message: 'ok' } } }),
    })
    const out = await domain.runVerb({ type: 'account.switch', requestId: 'r', accountId: 'ghost' })
    expect(out.result.ok).toBe(false)
    expect(out.poolChanged).toBe(false)
    expect(called).toBe(false)
  })

  test('refreshUsage delegates to the executor and returns whether usage landed', async () => {
    // The desktop pool loads observation-only, so the snapshot's usage fields are
    // 0/null until refreshUsage runs the engine's wham/usage fetch. Prove the
    // domain forwards to the executor and propagates its "did usage change" bit
    // (the sidecar re-broadcasts only on true).
    let calls = 0
    const domain = createSidecarAccountsDomain({
      executor: fakeExecutor({
        refreshUsage: async () => {
          calls += 1
          return true
        },
      }),
    })
    expect(await domain.refreshUsage()).toBe(true)
    expect(calls).toBe(1)

    const empty = createSidecarAccountsDomain({
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
    const domain = createSidecarAccountsDomain({
      executor: fakeExecutor({ rename: () => { renamed = true; return { ok: true, message: 'ok' } } }),
    })
    const out = await domain.runVerb({ type: 'account.rename', requestId: 'r', accountId: 'a', alias: 'taken' })
    expect(out.result.ok).toBe(false)
    expect(renamed).toBe(false)
  })

  test('rename rejects an invalid alias (regex) before dispatch', async () => {
    seedCodexAccountPoolForTest({ accounts: [poolAccount({ accountId: 'a', alias: 'keep' })], activeAccountId: 'a' })
    const domain = createSidecarAccountsDomain({ executor: fakeExecutor() })
    const out = await domain.runVerb({ type: 'account.rename', requestId: 'r', accountId: 'a', alias: 'bad alias!' })
    expect(out.result.ok).toBe(false)
  })

  test('rename/delete reject config-only accounts (no vault profile)', async () => {
    seedCodexAccountPoolForTest({
      accounts: [poolAccount({ accountId: 'a', source: 'config', vaultFilePath: undefined })],
      activeAccountId: 'a',
    })
    const domain = createSidecarAccountsDomain({ executor: fakeExecutor() })
    const rename = await domain.runVerb({ type: 'account.rename', requestId: 'r', accountId: 'a', alias: 'new' })
    const del = await domain.runVerb({ type: 'account.delete', requestId: 'r', accountId: 'a', confirm: true })
    expect(rename.result.ok).toBe(false)
    expect(del.result.ok).toBe(false)
  })

  test('touchAll surfaces per-account results and marks the pool changed', async () => {
    const domain = createSidecarAccountsDomain({
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
    const domain = createSidecarAccountsDomain({ executor: fakeExecutor(), oauthRunner: runner })
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
