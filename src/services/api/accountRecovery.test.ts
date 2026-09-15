import { afterEach, expect, test } from 'bun:test'

import { CodexAccountCapError } from './codex-fetch-adapter.js'
import {
  failoverCodexLease,
  getCodexLeaseForOwner,
  reassignCodexLeasesToActiveAccount,
  registerCodexLease,
  resetCodexLeaseManagerForTest,
} from './codexAccountLeaseManager.js'
import {
  getPoolStatus,
  markPoolAccountQuarantined,
  resetCodexAccountPoolForTest,
  seedCodexAccountPoolForTest,
  setActiveAccount,
  type PoolAccount,
} from './codexAccountPool.js'
import { withRetry } from './withRetry.js'

const account = (accountId: string): PoolAccount => ({
  accountId,
  accessToken: `fixture-${accountId}`,
  refreshToken: '',
  expiresAt: Date.now() + 60 * 60_000,
  source: 'config',
  status: 'healthy',
  lastUsedAt: 0,
})

afterEach(() => {
  resetCodexLeaseManagerForTest()
  resetCodexAccountPoolForTest()
})

test('a delayed cap retries the account selected by a concurrent manual switch', async () => {
  seedCodexAccountPoolForTest({
    accounts: [account('account-a'), account('account-b')],
    activeAccountId: 'account-a',
  })
  registerCodexLease({
    ownerId: 'main-thread',
    ownerType: 'main',
    ownerLabel: 'Main thread',
  })
  let attempts = 0

  for await (const _ of withRetry(
    async () => ({}),
    async () => {
      attempts++
      if (attempts === 1) {
        setActiveAccount('account-b')
        reassignCodexLeasesToActiveAccount()
        throw new CodexAccountCapError('account-a')
      }
      return 'success'
    },
    {
      maxRetries: 2,
      model: 'gpt-5.6-luna',
      thinkingConfig: { type: 'disabled' },
      ownerId: 'main-thread',
      isCodexRequest: true,
    },
  )) {}

  expect(attempts).toBe(2)
  expect(getCodexLeaseForOwner('main-thread')?.accountId).toBe('account-b')
  expect(
    getPoolStatus().accounts.find(row => row.accountId === 'account-a')?.status,
  ).toBe('capped')
})

test('a late sibling cap can select the sole remaining healthy account', async () => {
  seedCodexAccountPoolForTest({
    accounts: [account('account-a'), account('account-b')],
    activeAccountId: 'account-a',
  })
  registerCodexLease({
    ownerId: 'main-thread', ownerType: 'main', ownerLabel: 'Main thread',
  })
  registerCodexLease({
    ownerId: 'follower', ownerType: 'subagent', ownerLabel: 'Follower',
    strategy: 'follow-main',
  })
  let attempts = 0

  for await (const _ of withRetry(
    async () => ({}),
    async () => {
      attempts++
      if (attempts === 1) {
        failoverCodexLease('main-thread', 'account-a', 'main capped')
        throw new CodexAccountCapError('account-a')
      }
      return 'success'
    },
    {
      maxRetries: 2,
      model: 'gpt-5.6-luna',
      thinkingConfig: { type: 'disabled' },
      ownerId: 'follower',
      isCodexRequest: true,
    },
  )) {}

  expect(attempts).toBe(2)
  expect(getCodexLeaseForOwner('main-thread')?.accountId).toBe('account-b')
  expect(getCodexLeaseForOwner('follower')?.accountId).toBe('account-b')
})

test('a delayed cap does not retry a current lease that also became unavailable', async () => {
  seedCodexAccountPoolForTest({
    accounts: [
      account('account-a'),
      account('account-b'),
      account('account-c'),
    ],
    activeAccountId: 'account-a',
  })
  registerCodexLease({
    ownerId: 'main-thread', ownerType: 'main', ownerLabel: 'Main thread',
  })
  setActiveAccount('account-b')
  reassignCodexLeasesToActiveAccount()
  markPoolAccountQuarantined('account-b', 'fixture transport failure')
  let attempts = 0

  for await (const _ of withRetry(
    async () => ({}),
    async () => {
      attempts++
      if (attempts === 1) throw new CodexAccountCapError('account-a')
      return 'success'
    },
    {
      maxRetries: 2,
      model: 'gpt-5.6-luna',
      thinkingConfig: { type: 'disabled' },
      ownerId: 'main-thread',
      isCodexRequest: true,
    },
  )) {}

  expect(attempts).toBe(2)
  expect(getCodexLeaseForOwner('main-thread')?.accountId).toBe('account-c')
  expect(
    getPoolStatus().accounts.find(row => row.accountId === 'account-a')?.status,
  ).toBe('capped')
  expect(
    getPoolStatus().accounts.find(row => row.accountId === 'account-b')?.status,
  ).toBe('quarantined')
})
