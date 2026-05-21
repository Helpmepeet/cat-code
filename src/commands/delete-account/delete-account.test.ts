import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import * as codexFetchAdapterModule from '../../services/api/codex-fetch-adapter.js'
import * as claudePoolModule from '../../services/api/claudeAccountPool.js'
import * as codexPoolModule from '../../services/api/codexAccountPool.js'
import {
  getCodexLeaseForOwner,
  resetCodexLeaseManagerForTest,
  seedCodexLeaseForTest,
} from '../../services/api/codexAccountLeaseManager.js'
import type { PoolAccount } from '../../services/api/codexAccountPool.js'
import { call } from './delete-account.js'

function createCodexAccount(
  accountId: string,
  alias: string,
  vaultFilePath: string,
  lastUsedAt = 0,
): PoolAccount {
  return {
    accountId,
    accessToken: `${accountId}-access`,
    refreshToken: `${accountId}-refresh`,
    expiresAt: Date.now() + 60_000,
    source: 'vault',
    status: 'healthy',
    lastUsedAt,
    alias,
    vaultFilePath,
  }
}

function createClaudeAccount(
  accountUuid: string,
  alias: string,
  vaultFilePath: string,
) {
  return {
    accountUuid,
    emailAddress: `${accountUuid}@example.com`,
    accessToken: `${accountUuid}-access`,
    refreshToken: `${accountUuid}-refresh`,
    expiresAt: Date.now() + 60_000,
    status: 'healthy' as const,
    alias,
    vaultFilePath,
    subscriptionType: null,
    rateLimitTier: null,
  }
}

describe('/delete-account', () => {
  const tempDirs: string[] = []

  afterEach(() => {
    mock.restore()
    codexPoolModule.resetCodexAccountPoolForTest()
    claudePoolModule.resetClaudeAccountPoolForTest()
    resetCodexLeaseManagerForTest()
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('confirmed Codex delete repairs leases, clears caches, and bumps account UI state', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'delete-account-test-'))
    tempDirs.push(dir)
    const deletedPath = join(dir, 'old-main.json')
    const backupPath = join(dir, 'backup.json')
    writeFileSync(deletedPath, '{}\n', 'utf-8')
    writeFileSync(backupPath, '{}\n', 'utf-8')

    codexPoolModule.seedCodexAccountPoolForTest({
      activeAccountId: 'old-main',
      accounts: [
        createCodexAccount('old-main', 'old', deletedPath, 0),
        createCodexAccount('new-main', 'backup', backupPath, 10),
      ],
    })
    seedCodexLeaseForTest({
      ownerId: 'main-thread',
      ownerType: 'main',
      ownerLabel: 'Main thread',
      accountId: 'old-main',
      strategy: 'follow-main',
    })
    seedCodexLeaseForTest({
      ownerId: 'follow-worker',
      ownerType: 'subagent',
      ownerLabel: 'Follow Worker',
      accountId: 'old-main',
      strategy: 'follow-main',
    })

    const resetContextSpy = spyOn(
      codexFetchAdapterModule,
      'resetCodexCacheContext',
    ).mockImplementation(() => {})
    spyOn(
      codexPoolModule,
      'applyPostCodexAccountSwitchRefresh',
    ).mockImplementation(() => {})
    const logoutModule = await import('../logout/logout.js')
    const clearCachesSpy = spyOn(
      logoutModule,
      'clearAuthRelatedCaches',
    ).mockImplementation(async () => {})

    const onChangeAPIKey = mock(() => {})
    const setMessages = mock(() => {})
    let appState = {
      authVersion: 2,
      statusLineRefreshKey: 3,
    }
    const setAppState = mock(
      (updater: (prev: typeof appState) => typeof appState) => {
        appState = updater(appState)
      },
    )

    const result = await call(
      'old --confirm',
      {
        onChangeAPIKey,
        setMessages,
        setAppState,
      } as Parameters<typeof call>[1],
    )

    expect(result).toEqual({
      type: 'text',
      value: 'Deleted old. Active Codex account is now backup.',
    })
    const pool = codexPoolModule.getPoolStatus()
    expect(pool.accounts.map(account => account.accountId)).toEqual(['new-main'])
    expect(pool.accounts[pool.activeIndex]?.accountId).toBe('new-main')
    expect(getCodexLeaseForOwner('main-thread')?.accountId).toBe('new-main')
    expect(getCodexLeaseForOwner('follow-worker')?.accountId).toBe('new-main')
    expect(resetContextSpy).toHaveBeenCalledTimes(1)
    expect(clearCachesSpy).toHaveBeenCalledTimes(1)
    expect(onChangeAPIKey).toHaveBeenCalledTimes(1)
    expect(setMessages).toHaveBeenCalledTimes(1)
    expect(appState).toEqual({
      authVersion: 3,
      statusLineRefreshKey: 4,
    })
  })

  test('exact Claude match wins over Codex prefix matches before deleting', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'delete-account-precedence-test-'))
    tempDirs.push(dir)
    const codexPath = join(dir, 'workbench.json')
    const claudePath = join(dir, 'work.json')
    writeFileSync(codexPath, '{}\n', 'utf-8')
    writeFileSync(claudePath, '{}\n', 'utf-8')

    codexPoolModule.seedCodexAccountPoolForTest({
      activeAccountId: 'codex-workbench',
      accounts: [
        createCodexAccount('codex-workbench', 'workbench', codexPath),
      ],
    })
    claudePoolModule.seedClaudeAccountPoolForTest({
      activeAccountUuid: 'claude-work',
      accounts: [
        createClaudeAccount('claude-work', 'work', claudePath),
        createClaudeAccount('claude-current', 'current', join(dir, 'current.json')),
      ],
    })

    spyOn(claudePoolModule, 'syncClaudeAccountToStorage').mockImplementation(() => {})
    spyOn(
      codexPoolModule,
      'applyPostCodexAccountSwitchRefresh',
    ).mockImplementation(() => {})
    const logoutModule = await import('../logout/logout.js')
    spyOn(logoutModule, 'clearAuthRelatedCaches').mockImplementation(async () => {})

    const result = await call(
      'work --confirm',
      {
        onChangeAPIKey: mock(() => {}),
        setMessages: mock(() => {}),
        setAppState: mock((updater: (prev: { authVersion: number; statusLineRefreshKey: number }) => { authVersion: number; statusLineRefreshKey: number }) =>
          updater({ authVersion: 0, statusLineRefreshKey: 0 }),
        ),
      } as Parameters<typeof call>[1],
    )

    expect(result.type).toBe('text')
    expect(result.value).toContain('Deleted work.')
    expect(codexPoolModule.getPoolStatus().accounts.map(account => account.accountId)).toEqual([
      'codex-workbench',
    ])
    expect(claudePoolModule.getClaudePoolStatus().accounts.map(account => account.accountUuid)).toEqual([
      'claude-current',
    ])
  })
})
