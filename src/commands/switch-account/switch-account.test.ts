import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'
import * as claudePoolModule from '../../services/api/claudeAccountPool.js'
import * as codexPoolModule from '../../services/api/codexAccountPool.js'
import * as leaseManagerModule from '../../services/api/codexAccountLeaseManager.js'
import * as codexFetchAdapterModule from '../../services/api/codex-fetch-adapter.js'
import { setSessionProvider } from '../../bootstrap/state.js'
import {
  _resetAccountDiagnosticStreamJsonHookForTesting,
  installStreamJsonAccountDiagnosticHook,
} from '../../services/api/accountDiagnostics.js'
import { call } from './switch-account.js'

function createCodexAccount(
  accountId: string,
  alias: string,
  lastUsedAt = 0,
  overrides: Partial<codexPoolModule.PoolAccount> = {},
) {
  return {
    accountId,
    accessToken: `${accountId}-access`,
    refreshToken: `${accountId}-refresh`,
    expiresAt: Date.now() + 60_000,
    source: 'vault' as const,
    status: 'healthy' as const,
    lastUsedAt,
    alias,
    ...overrides,
  }
}

describe('/switch-account', () => {
  afterEach(() => {
    mock.restore()
    _resetAccountDiagnosticStreamJsonHookForTesting()
    codexPoolModule.resetCodexAccountPoolForTest()
    claudePoolModule.resetClaudeAccountPoolForTest()
    setSessionProvider(null)
  })

  test('returns Already on <label> and skips Codex side effects for explicit no-op switches', async () => {
    setSessionProvider('openai')
    const emittedMessages: unknown[] = []
    installStreamJsonAccountDiagnosticHook({
      emit: message => {
        emittedMessages.push(message)
      },
      getSessionId: () => 'switch-noop-session',
    })

    const currentAccount = createCodexAccount('codex-account-one', 'main', 1)
    const otherAccount = createCodexAccount('codex-account-two', 'backup', 2)

    codexPoolModule.seedCodexAccountPoolForTest({
      accounts: [currentAccount, otherAccount],
      activeAccountId: currentAccount.accountId,
    })

    const reassignSpy = spyOn(
      leaseManagerModule,
      'reassignCodexLeaseToActiveAccount',
    ).mockImplementation(() => {})
    const resetContextSpy = spyOn(
      codexFetchAdapterModule,
      'resetCodexCacheContext',
    ).mockImplementation(() => {})
    const clearCachesSpy = mock(async () => {})
    const applyRefreshSpy = spyOn(
      codexPoolModule,
      'applyPostCodexAccountSwitchRefresh',
    ).mockImplementation(() => {})

    const logoutModule = await import('../logout/logout.js')
    spyOn(logoutModule, 'clearAuthRelatedCaches').mockImplementation(clearCachesSpy)

    const onChangeAPIKey = mock(() => {})
    const setMessages = mock(() => {})
    let appState = {
      authVersion: 0,
      statusLineRefreshKey: 0,
    }
    const setAppState = mock((updater: (prev: typeof appState) => typeof appState) => {
      appState = updater(appState)
    })

    const result = await call(
      'main',
      {
        onChangeAPIKey,
        setMessages,
        setAppState,
      } as Parameters<typeof call>[1],
    )

    expect(result).toEqual({ type: 'text', value: 'Already on main' })
    expect(emittedMessages.map(message => (message as { reason?: string }).reason)).toEqual([
      'manual switch started',
      'manual switch no-op',
    ])
    expect(reassignSpy).not.toHaveBeenCalled()
    expect(resetContextSpy).not.toHaveBeenCalled()
    expect(clearCachesSpy).not.toHaveBeenCalled()
    expect(applyRefreshSpy).not.toHaveBeenCalled()
    expect(onChangeAPIKey).not.toHaveBeenCalled()
    expect(setMessages).not.toHaveBeenCalled()
    expect(setAppState).not.toHaveBeenCalled()
    expect(appState).toEqual({
      authVersion: 0,
      statusLineRefreshKey: 0,
    })
  })

  test('emits account.manual_switch for actual Codex switches', async () => {
    setSessionProvider('openai')
    const emittedMessages: unknown[] = []
    installStreamJsonAccountDiagnosticHook({
      emit: message => {
        emittedMessages.push(message)
      },
      getSessionId: () => 'switch-codex-session',
      createUuid: () => `switch-codex-${emittedMessages.length + 1}`,
    })

    const currentAccount = createCodexAccount('codex-account-one', 'main', 1)
    const otherAccount = createCodexAccount('codex-account-two', 'backup', 2)

    codexPoolModule.seedCodexAccountPoolForTest({
      accounts: [currentAccount, otherAccount],
      activeAccountId: currentAccount.accountId,
    })

    spyOn(leaseManagerModule, 'reassignCodexLeaseToActiveAccount').mockImplementation(() => {})
    spyOn(codexFetchAdapterModule, 'resetCodexCacheContext').mockImplementation(() => {})
    spyOn(codexPoolModule, 'applyPostCodexAccountSwitchRefresh').mockImplementation(() => {})
    const logoutModule = await import('../logout/logout.js')
    spyOn(logoutModule, 'clearAuthRelatedCaches').mockImplementation(async () => {})

    const result = await call(
      'backup',
      {
        onChangeAPIKey: mock(() => {}),
        setMessages: mock(() => {}),
        setAppState: mock(() => {}),
      } as Parameters<typeof call>[1],
    )

    expect(result).toEqual({ type: 'text', value: 'Switched to backup' })
    expect(emittedMessages.map(message => (message as { reason?: string }).reason)).toEqual([
      'manual switch started',
      'manual switch succeeded',
    ])
    expect(emittedMessages[1]).toMatchObject({
      type: 'system',
      subtype: 'cat_code_account_diagnostic',
      code: 'account.manual_switch',
      severity: 'info',
      provider: 'openai',
      recoverable: true,
      reason: 'manual switch succeeded',
    })
    expect((emittedMessages[1] as { account_ref?: string }).account_ref).toBeDefined()
  })

  test('explicit Codex switch to an account with stale plan metadata succeeds with a warning', async () => {
    setSessionProvider('openai')
    codexPoolModule.seedCodexAccountPoolForTest({
      accounts: [
        createCodexAccount('codex-current', 'current'),
        createCodexAccount('codex-plan', 'plan', 0, {
          planType: 'plus',
          planExpiresAt: '2026-04-12T03:30:01+00:00',
        }),
      ],
      activeAccountId: 'codex-current',
    })

    const result = await call(
      'plan',
      {
        onChangeAPIKey: mock(() => {}),
        setMessages: mock(() => {}),
        setAppState: mock(() => {}),
      } as Parameters<typeof call>[1],
    )

    expect(result?.value).toContain('Switched to plan')
    expect(result?.value).toContain(
      'Warning: saved plan metadata says expired (2026-04-12T03:30:01+00:00); live usage decides availability',
    )
  })

  test('emits account.manual_switch for actual Claude switches', async () => {
    const emittedMessages: unknown[] = []
    installStreamJsonAccountDiagnosticHook({
      emit: message => {
        emittedMessages.push(message)
      },
      getSessionId: () => 'switch-claude-session',
      createUuid: () => `switch-claude-${emittedMessages.length + 1}`,
    })

    const claudeAcct1 = {
      accountUuid: 'claude-uuid-1',
      emailAddress: 'one@example.com',
      accessToken: 'a1',
      refreshToken: 'r1',
      expiresAt: Date.now() + 60_000,
      status: 'healthy' as const,
      alias: 'work1',
    }
    const claudeAcct2 = {
      accountUuid: 'claude-uuid-2',
      emailAddress: 'two@example.com',
      accessToken: 'a2',
      refreshToken: 'r2',
      expiresAt: Date.now() + 60_000,
      status: 'healthy' as const,
      alias: 'work2',
    }

    claudePoolModule.seedClaudeAccountPoolForTest({
      accounts: [claudeAcct1, claudeAcct2],
      activeAccountUuid: claudeAcct1.accountUuid,
    })

    spyOn(claudePoolModule, 'syncClaudeAccountToStorage').mockImplementation(() => {})
    const logoutModule = await import('../logout/logout.js')
    spyOn(logoutModule, 'clearAuthRelatedCaches').mockImplementation(async () => {})

    const result = await call(
      'work2',
      {
        onChangeAPIKey: mock(() => {}),
        setMessages: mock(() => {}),
        setAppState: mock(() => {}),
      } as Parameters<typeof call>[1],
    )

    expect(result).toEqual({ type: 'text', value: 'Switched to Claude account work2' })
    expect(emittedMessages.map(message => (message as { reason?: string }).reason)).toEqual([
      'manual switch started',
      'manual switch succeeded',
    ])
    expect(emittedMessages[1]).toMatchObject({
      type: 'system',
      subtype: 'cat_code_account_diagnostic',
      code: 'account.manual_switch',
      severity: 'info',
      provider: 'anthropic',
      recoverable: true,
      reason: 'manual switch succeeded',
    })
    expect((emittedMessages[1] as { account_ref?: string }).account_ref).toBeDefined()
  })

  test('returns Multiple Codex accounts match for ambiguous Codex prefix and does not switch', async () => {
    const currentAccount = createCodexAccount('codex-current', 'main', 1)
    const backup1 = createCodexAccount('codex-backup1', 'backup1', 2)
    const backup2 = createCodexAccount('codex-backup2', 'backup2', 3)

    codexPoolModule.seedCodexAccountPoolForTest({
      accounts: [currentAccount, backup1, backup2],
      activeAccountId: currentAccount.accountId,
    })

    const reassignSpy = spyOn(
      leaseManagerModule,
      'reassignCodexLeaseToActiveAccount',
    ).mockImplementation(() => {})
    spyOn(codexFetchAdapterModule, 'resetCodexCacheContext').mockImplementation(() => {})
    spyOn(codexPoolModule, 'applyPostCodexAccountSwitchRefresh').mockImplementation(() => {})

    const logoutModule = await import('../logout/logout.js')
    spyOn(logoutModule, 'clearAuthRelatedCaches').mockImplementation(async () => {})

    const onChangeAPIKey = mock(() => {})
    const setMessages = mock(() => {})
    const setAppState = mock(() => {})

    const result = await call(
      'backup',
      {
        onChangeAPIKey,
        setMessages,
        setAppState,
      } as Parameters<typeof call>[1],
    )

    expect(result?.type).toBe('text')
    expect(result?.value).toContain('Multiple Codex accounts match "backup"')
    expect(result?.value).toContain('backup1')
    expect(result?.value).toContain('backup2')
    expect(reassignSpy).not.toHaveBeenCalled()
    // Active account unchanged
    const status = codexPoolModule.getPoolStatus()
    expect(status.accounts[status.activeIndex]?.accountId).toBe('codex-current')
  })

  test('explicit prefix switches to the single healthy Codex account from Claude provider', async () => {
    setSessionProvider('firstParty')
    codexPoolModule.seedCodexAccountPoolForTest({
      accounts: [createCodexAccount('codex-only', 'codexone')],
      activeAccountId: 'codex-only',
    })
    claudePoolModule.seedClaudeAccountPoolForTest({
      accounts: [
        {
          accountUuid: 'claude-only',
          emailAddress: 'one@example.com',
          accessToken: 'a1',
          refreshToken: 'r1',
          expiresAt: Date.now() + 60_000,
          status: 'healthy' as const,
          alias: 'claudeone',
        },
      ],
      activeAccountUuid: 'claude-only',
    })

    spyOn(leaseManagerModule, 'reassignCodexLeaseToActiveAccount').mockImplementation(() => {})
    spyOn(codexFetchAdapterModule, 'resetCodexCacheContext').mockImplementation(() => {})
    spyOn(codexPoolModule, 'applyPostCodexAccountSwitchRefresh').mockImplementation(() => {})
    const logoutModule = await import('../logout/logout.js')
    spyOn(logoutModule, 'clearAuthRelatedCaches').mockImplementation(async () => {})

    const result = await call(
      'codexone',
      {
        onChangeAPIKey: mock(() => {}),
        setMessages: mock(() => {}),
        setAppState: mock(() => {}),
      } as Parameters<typeof call>[1],
    )

    expect(result).toEqual({ type: 'text', value: 'Switched to codexone' })
  })

  test('explicit exact Codex match wins over Claude prefix match', async () => {
    setSessionProvider('openai')
    codexPoolModule.seedCodexAccountPoolForTest({
      accounts: [
        createCodexAccount('codex-current', 'current'),
        createCodexAccount('codex-target', 'work'),
      ],
      activeAccountId: 'codex-current',
    })
    claudePoolModule.seedClaudeAccountPoolForTest({
      accounts: [
        {
          accountUuid: 'claude-work-prefix',
          emailAddress: 'workbench@example.com',
          accessToken: 'a1',
          refreshToken: 'r1',
          expiresAt: Date.now() + 60_000,
          status: 'healthy' as const,
          alias: 'workbench',
        },
      ],
      activeAccountUuid: 'claude-work-prefix',
    })

    spyOn(leaseManagerModule, 'reassignCodexLeasesToActiveAccount').mockImplementation(() => {})
    spyOn(codexFetchAdapterModule, 'resetCodexCacheContext').mockImplementation(() => {})
    spyOn(codexPoolModule, 'applyPostCodexAccountSwitchRefresh').mockImplementation(() => {})
    const logoutModule = await import('../logout/logout.js')
    spyOn(logoutModule, 'clearAuthRelatedCaches').mockImplementation(async () => {})

    const result = await call(
      'work',
      {
        onChangeAPIKey: mock(() => {}),
        setMessages: mock(() => {}),
        setAppState: mock(() => {}),
      } as Parameters<typeof call>[1],
    )

    expect(result).toEqual({ type: 'text', value: 'Switched to work' })
  })

  test('explicit exact Claude match wins over ambiguous Codex prefix matches', async () => {
    setSessionProvider('firstParty')
    codexPoolModule.seedCodexAccountPoolForTest({
      accounts: [
        createCodexAccount('codex-workbench-a', 'workbench-a'),
        createCodexAccount('codex-workbench-b', 'workbench-b'),
      ],
      activeAccountId: 'codex-workbench-a',
    })
    claudePoolModule.seedClaudeAccountPoolForTest({
      accounts: [
        {
          accountUuid: 'claude-work',
          emailAddress: 'work@example.com',
          accessToken: 'a1',
          refreshToken: 'r1',
          expiresAt: Date.now() + 60_000,
          status: 'healthy' as const,
          alias: 'work',
        },
        {
          accountUuid: 'claude-current',
          emailAddress: 'current@example.com',
          accessToken: 'a2',
          refreshToken: 'r2',
          expiresAt: Date.now() + 60_000,
          status: 'healthy' as const,
          alias: 'current',
        },
      ],
      activeAccountUuid: 'claude-current',
    })

    spyOn(claudePoolModule, 'syncClaudeAccountToStorage').mockImplementation(() => {})
    const logoutModule = await import('../logout/logout.js')
    spyOn(logoutModule, 'clearAuthRelatedCaches').mockImplementation(async () => {})

    const result = await call(
      'work',
      {
        onChangeAPIKey: mock(() => {}),
        setMessages: mock(() => {}),
        setAppState: mock(() => {}),
      } as Parameters<typeof call>[1],
    )

    expect(result).toEqual({ type: 'text', value: 'Switched to Claude account work' })
  })

  test('manual switch failure emits account.manual_switch failure diagnostic', async () => {
    const emittedMessages: unknown[] = []
    installStreamJsonAccountDiagnosticHook({
      emit: message => {
        emittedMessages.push(message)
      },
      getSessionId: () => 'switch-failure-session',
      createUuid: () => `switch-failure-${emittedMessages.length + 1}`,
    })

    const result = await call(
      'missing',
      {
        onChangeAPIKey: mock(() => {}),
        setMessages: mock(() => {}),
        setAppState: mock(() => {}),
      } as Parameters<typeof call>[1],
    )

    expect(result?.value).toContain('No healthy account matching "missing"')
    expect(emittedMessages.map(message => (message as { reason?: string }).reason)).toEqual([
      'manual switch started',
      'manual switch failed: no matching healthy account',
    ])
  })

  test('explicit Codex switch reports existing account that is not switchable', async () => {
    codexPoolModule.seedCodexAccountPoolForTest({
      accounts: [
        createCodexAccount('codex-current', 'current'),
        createCodexAccount('codex-blocked', 'blocked', 0, {
          status: 'capped',
          statusReason: 'usage_cap',
          lastError: 'Usage cap hit (429)',
        }),
      ],
      activeAccountId: 'codex-current',
    })

    const result = await call(
      'blocked',
      {
        onChangeAPIKey: mock(() => {}),
        setMessages: mock(() => {}),
        setAppState: mock(() => {}),
      } as Parameters<typeof call>[1],
    )

    expect(result?.value).toContain('Found Codex account "blocked", but it is not switchable.')
    expect(result?.value).toContain('Reason: Usage cap hit (429)')
  })

  test('returns Multiple Claude accounts match for ambiguous Claude alias prefix and does not switch', async () => {
    const claudeAcct1 = {
      accountUuid: 'claude-uuid-1',
      emailAddress: 'one@example.com',
      accessToken: 'a1',
      refreshToken: 'r1',
      expiresAt: Date.now() + 60_000,
      status: 'healthy' as const,
      alias: 'work1',
    }
    const claudeAcct2 = {
      accountUuid: 'claude-uuid-2',
      emailAddress: 'two@example.com',
      accessToken: 'a2',
      refreshToken: 'r2',
      expiresAt: Date.now() + 60_000,
      status: 'healthy' as const,
      alias: 'work2',
    }

    claudePoolModule.seedClaudeAccountPoolForTest({
      accounts: [claudeAcct1, claudeAcct2],
      activeAccountUuid: claudeAcct1.accountUuid,
    })

    const onChangeAPIKey = mock(() => {})
    const setMessages = mock(() => {})
    const setAppState = mock(() => {})

    const result = await call(
      'work',
      {
        onChangeAPIKey,
        setMessages,
        setAppState,
      } as Parameters<typeof call>[1],
    )

    expect(result?.type).toBe('text')
    expect(result?.value).toContain('Multiple Claude accounts match "work"')
    expect(result?.value).toContain('work1')
    expect(result?.value).toContain('work2')
    // Active account unchanged
    const status = claudePoolModule.getClaudePoolStatus()
    expect(status.accounts[status.activeIndex]?.accountUuid).toBe('claude-uuid-1')
  })
})
