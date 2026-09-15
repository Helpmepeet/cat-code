import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'

import * as codexFetchAdapterModule from './codex-fetch-adapter.js'
import * as codexPoolModule from './codexAccountPool.js'
import type { PoolAccount } from './codexAccountPool.js'
import {
  getCodexLeaseSnapshotForTest,
  resetCodexLeaseManagerForTest,
  seedCodexLeaseForTest,
} from './codexAccountLeaseManager.js'
import { commitCodexAccountSwitch } from './codexAccountSwitch.js'

function buildPoolAccount(accountId: string, alias: string): PoolAccount {
  return {
    accountId,
    accessToken: `${accountId}-access`,
    refreshToken: `${accountId}-refresh`,
    expiresAt: Date.now() + 60_000,
    source: 'vault',
    status: 'healthy',
    lastUsedAt: 0,
    alias,
  }
}

function leaseAccountFor(ownerId: string): string | undefined {
  return getCodexLeaseSnapshotForTest().leases.find(
    lease => lease.ownerId === ownerId,
  )?.accountId
}

/**
 * Silences the two engine-global side effects of a switch that a unit test has
 * no business running (`clearAuthRelatedCaches` writes the real global config,
 * `applyPostCodexAccountSwitchRefresh` regenerates process-wide session state).
 * Everything the transaction exists for - pool activeIndex, lease movement,
 * fetch cache context - runs for real.
 */
async function stubSwitchSideEffects(): Promise<{
  clearAuthRelatedCaches: ReturnType<typeof mock>
  applyPostCodexAccountSwitchRefresh: ReturnType<typeof mock>
  resetCodexCacheContext: ReturnType<typeof mock>
}> {
  const clearAuthRelatedCaches = mock(async () => {})
  const logoutModule = await import('../../commands/logout/logout.js')
  spyOn(logoutModule, 'clearAuthRelatedCaches').mockImplementation(
    clearAuthRelatedCaches,
  )
  const applyPostCodexAccountSwitchRefresh = spyOn(
    codexPoolModule,
    'applyPostCodexAccountSwitchRefresh',
  ).mockImplementation(() => {})
  const resetCodexCacheContext = spyOn(
    codexFetchAdapterModule,
    'resetCodexCacheContext',
  ).mockImplementation(() => {})

  return {
    clearAuthRelatedCaches,
    applyPostCodexAccountSwitchRefresh,
    resetCodexCacheContext,
  }
}

describe('commitCodexAccountSwitch', () => {
  afterEach(() => {
    mock.restore()
    codexPoolModule.resetCodexAccountPoolForTest()
    resetCodexLeaseManagerForTest()
  })

  test('moves live follow-main leases onto the newly selected account', async () => {
    const stubs = await stubSwitchSideEffects()
    codexPoolModule.seedCodexAccountPoolForTest({
      accounts: [
        buildPoolAccount('codex-one', 'main'),
        buildPoolAccount('codex-two', 'backup'),
      ],
      activeAccountId: 'codex-one',
    })
    seedCodexLeaseForTest({
      ownerId: 'main-thread',
      ownerType: 'main',
      ownerLabel: 'main thread',
      accountId: 'codex-one',
      strategy: 'follow-main',
    })
    seedCodexLeaseForTest({
      ownerId: 'subagent-follow',
      ownerType: 'subagent',
      ownerLabel: 'explorer',
      accountId: 'codex-one',
      strategy: 'follow-main',
    })
    seedCodexLeaseForTest({
      ownerId: 'subagent-spread',
      ownerType: 'subagent',
      ownerLabel: 'spreader',
      accountId: 'codex-one',
      strategy: 'spread',
    })

    const result = await commitCodexAccountSwitch('backup')

    expect(result?.accountId).toBe('codex-two')
    const { accounts, activeIndex } = codexPoolModule.getPoolStatus()
    expect(accounts[activeIndex]?.accountId).toBe('codex-two')
    // The bug this transaction closes: switchToAccount alone left these on the
    // previous account, so routing and the status line disagreed with the pool.
    expect(leaseAccountFor('main-thread')).toBe('codex-two')
    expect(leaseAccountFor('subagent-follow')).toBe('codex-two')
    // A 'spread' subagent deliberately keeps its own account.
    expect(leaseAccountFor('subagent-spread')).toBe('codex-one')
    expect(stubs.resetCodexCacheContext).toHaveBeenCalledTimes(1)
    expect(stubs.clearAuthRelatedCaches).toHaveBeenCalledTimes(1)
    expect(stubs.applyPostCodexAccountSwitchRefresh).toHaveBeenCalledTimes(1)
  })

  test('returns null and mutates nothing when switchToAccount refuses', async () => {
    const stubs = await stubSwitchSideEffects()
    codexPoolModule.seedCodexAccountPoolForTest({
      accounts: [buildPoolAccount('codex-one', 'main')],
      activeAccountId: 'codex-one',
    })
    seedCodexLeaseForTest({
      ownerId: 'main-thread',
      ownerType: 'main',
      ownerLabel: 'main thread',
      accountId: 'codex-one',
      strategy: 'follow-main',
    })

    // No rotation target: switchToAccount refuses a single-account pool.
    const result = await commitCodexAccountSwitch(null)

    expect(result).toBeNull()
    expect(leaseAccountFor('main-thread')).toBe('codex-one')
    expect(stubs.resetCodexCacheContext).not.toHaveBeenCalled()
    expect(stubs.clearAuthRelatedCaches).not.toHaveBeenCalled()
    expect(stubs.applyPostCodexAccountSwitchRefresh).not.toHaveBeenCalled()
  })

  test('returns null when the named account does not resolve', async () => {
    const stubs = await stubSwitchSideEffects()
    codexPoolModule.seedCodexAccountPoolForTest({
      accounts: [
        buildPoolAccount('codex-one', 'main'),
        buildPoolAccount('codex-two', 'backup'),
      ],
      activeAccountId: 'codex-one',
    })

    const result = await commitCodexAccountSwitch('nonexistent')

    expect(result).toBeNull()
    const { accounts, activeIndex } = codexPoolModule.getPoolStatus()
    expect(accounts[activeIndex]?.accountId).toBe('codex-one')
    expect(stubs.clearAuthRelatedCaches).not.toHaveBeenCalled()
  })
})
