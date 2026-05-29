import { beforeEach, describe, expect, test } from 'bun:test'

import {
  resetClaudeAccountPoolForTest,
  resolveClaudeAccountByPrefix,
  seedClaudeAccountPoolForTest,
  type ClaudePoolAccount,
} from './claudeAccountPool.js'

function buildClaudeAccount(
  overrides: Partial<ClaudePoolAccount> & Pick<ClaudePoolAccount, 'accountUuid'>,
): ClaudePoolAccount {
  return {
    accountUuid: overrides.accountUuid,
    emailAddress: overrides.emailAddress ?? `${overrides.accountUuid}@example.com`,
    accessToken: overrides.accessToken ?? `access-${overrides.accountUuid}`,
    refreshToken: overrides.refreshToken ?? `refresh-${overrides.accountUuid}`,
    expiresAt: overrides.expiresAt ?? Date.now() + 60_000,
    status: overrides.status ?? 'healthy',
    alias: overrides.alias,
    scopes: overrides.scopes,
    subscriptionType: overrides.subscriptionType ?? null,
    rateLimitTier: overrides.rateLimitTier ?? null,
    displayName: overrides.displayName,
    organizationUuid: overrides.organizationUuid,
    organizationName: overrides.organizationName,
    organizationRole: overrides.organizationRole,
    workspaceRole: overrides.workspaceRole,
    billingType: overrides.billingType,
    hasExtraUsageEnabled: overrides.hasExtraUsageEnabled,
    accountCreatedAt: overrides.accountCreatedAt,
    subscriptionCreatedAt: overrides.subscriptionCreatedAt,
    vaultFilePath: overrides.vaultFilePath,
  }
}

describe('resolveClaudeAccountByPrefix', () => {
  beforeEach(() => {
    resetClaudeAccountPoolForTest()
  })

  test('returns unique on exact alias match even when another alias has it as a prefix', () => {
    seedClaudeAccountPoolForTest({
      activeAccountUuid: 'uuid-1',
      accounts: [
        buildClaudeAccount({ accountUuid: 'uuid-1', alias: 'work' }),
        buildClaudeAccount({ accountUuid: 'uuid-2', alias: 'work2' }),
      ],
    })

    const result = resolveClaudeAccountByPrefix('work')
    expect(result.kind).toBe('unique')
    if (result.kind === 'unique') {
      expect(result.account.accountUuid).toBe('uuid-1')
    }
  })

  test('returns unique on exact email match', () => {
    seedClaudeAccountPoolForTest({
      activeAccountUuid: 'uuid-1',
      accounts: [
        buildClaudeAccount({ accountUuid: 'uuid-1', emailAddress: 'alice@example.com' }),
        buildClaudeAccount({ accountUuid: 'uuid-2', emailAddress: 'alice2@example.com' }),
      ],
    })

    const result = resolveClaudeAccountByPrefix('alice@example.com')
    expect(result.kind).toBe('unique')
    if (result.kind === 'unique') {
      expect(result.account.accountUuid).toBe('uuid-1')
    }
  })

  test('returns unique on exact uuid match', () => {
    seedClaudeAccountPoolForTest({
      activeAccountUuid: 'uuid-1111',
      accounts: [
        buildClaudeAccount({ accountUuid: 'uuid-1111' }),
        buildClaudeAccount({ accountUuid: 'uuid-1111-extra' }),
      ],
    })

    const result = resolveClaudeAccountByPrefix('uuid-1111')
    expect(result.kind).toBe('unique')
    if (result.kind === 'unique') {
      expect(result.account.accountUuid).toBe('uuid-1111')
    }
  })

  test('returns ambiguous when two aliases share a prefix', () => {
    seedClaudeAccountPoolForTest({
      activeAccountUuid: 'uuid-1',
      accounts: [
        buildClaudeAccount({ accountUuid: 'uuid-1', alias: 'home1' }),
        buildClaudeAccount({ accountUuid: 'uuid-2', alias: 'home2' }),
      ],
    })

    const result = resolveClaudeAccountByPrefix('home')
    expect(result.kind).toBe('ambiguous')
    if (result.kind === 'ambiguous') {
      expect(result.matches.map((a) => a.accountUuid).sort()).toEqual(['uuid-1', 'uuid-2'])
    }
  })

  test('returns ambiguous when two emails share a prefix', () => {
    seedClaudeAccountPoolForTest({
      activeAccountUuid: 'uuid-1',
      accounts: [
        buildClaudeAccount({ accountUuid: 'uuid-1', emailAddress: 'bob@example.com' }),
        buildClaudeAccount({ accountUuid: 'uuid-2', emailAddress: 'bobby@example.com' }),
      ],
    })

    const result = resolveClaudeAccountByPrefix('bob')
    expect(result.kind).toBe('ambiguous')
  })

  test('returns ambiguous when two uuids share a prefix', () => {
    seedClaudeAccountPoolForTest({
      activeAccountUuid: 'aaaa-1',
      accounts: [
        buildClaudeAccount({ accountUuid: 'aaaa-1' }),
        buildClaudeAccount({ accountUuid: 'aaaa-2' }),
      ],
    })

    const result = resolveClaudeAccountByPrefix('aaaa')
    expect(result.kind).toBe('ambiguous')
  })

  test('returns ambiguous on cross-field prefix (alias vs email)', () => {
    seedClaudeAccountPoolForTest({
      activeAccountUuid: 'uuid-1',
      accounts: [
        buildClaudeAccount({ accountUuid: 'uuid-1', alias: 'demo-alias', emailAddress: 'a@x.com' }),
        buildClaudeAccount({ accountUuid: 'uuid-2', alias: 'other', emailAddress: 'demo@x.com' }),
      ],
    })

    const result = resolveClaudeAccountByPrefix('demo')
    expect(result.kind).toBe('ambiguous')
    if (result.kind === 'ambiguous') {
      expect(result.matches.length).toBe(2)
    }
  })

  test('returns none when nothing matches', () => {
    seedClaudeAccountPoolForTest({
      activeAccountUuid: 'uuid-1',
      accounts: [buildClaudeAccount({ accountUuid: 'uuid-1', alias: 'work' })],
    })

    expect(resolveClaudeAccountByPrefix('zzz').kind).toBe('none')
  })

  test('onlyHealthy:true filters out non-healthy accounts', () => {
    seedClaudeAccountPoolForTest({
      activeAccountUuid: 'uuid-1',
      accounts: [
        buildClaudeAccount({ accountUuid: 'uuid-1', alias: 'workA' }),
        buildClaudeAccount({ accountUuid: 'uuid-2', alias: 'workB', status: 'dead' }),
      ],
    })

    // Without filter, 'workA' and 'workB' both prefix 'work' -> ambiguous
    expect(resolveClaudeAccountByPrefix('work').kind).toBe('ambiguous')
    const filtered = resolveClaudeAccountByPrefix('work', { onlyHealthy: true })
    expect(filtered.kind).toBe('unique')
    if (filtered.kind === 'unique') {
      expect(filtered.account.accountUuid).toBe('uuid-1')
    }
  })
})
