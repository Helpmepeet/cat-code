import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'

import * as claudePoolModule from '../../services/api/claudeAccountPool.js'
import * as codexPoolModule from '../../services/api/codexAccountPool.js'
import { call } from './rename-account.js'

function createCodexAccount(accountId: string, alias: string, vaultFilePath = '/tmp/v.json') {
  return {
    accountId,
    accessToken: `${accountId}-access`,
    refreshToken: `${accountId}-refresh`,
    expiresAt: Date.now() + 60_000,
    source: 'vault' as const,
    status: 'healthy' as const,
    lastUsedAt: 0,
    credentialGeneration: 0,
    credentialGenerationState: 'legacy_unbound' as const,
    alias,
    vaultFilePath,
  }
}

function createClaudeAccount(accountUuid: string, alias: string, vaultFilePath = '/tmp/c.json') {
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

describe('/rename-account', () => {
  afterEach(() => {
    mock.restore()
    codexPoolModule.resetCodexAccountPoolForTest()
    claudePoolModule.resetClaudeAccountPoolForTest()
  })

  test('returns Multiple Codex accounts match for ambiguous Codex prefix and does not rename', async () => {
    const setSpy = spyOn(codexPoolModule, 'setAccountAlias').mockImplementation(() => true)

    codexPoolModule.seedCodexAccountPoolForTest({
      accounts: [
        createCodexAccount('codex-1', 'backup1'),
        createCodexAccount('codex-2', 'backup2'),
      ],
      activeAccountId: 'codex-1',
    })

    const result = await call(
      'backup newalias',
      {} as Parameters<typeof call>[1],
    )

    expect(result.type).toBe('text')
    expect(result.value).toContain('Multiple Codex accounts match "backup"')
    expect(result.value).toContain('backup1')
    expect(result.value).toContain('backup2')
    expect(setSpy).not.toHaveBeenCalled()
  })

  test('returns Multiple Claude accounts match for ambiguous Claude prefix and does not rename', async () => {
    const setSpy = spyOn(claudePoolModule, 'setClaudeAccountAlias').mockImplementation(() => true)

    claudePoolModule.seedClaudeAccountPoolForTest({
      accounts: [
        createClaudeAccount('claude-1', 'work1'),
        createClaudeAccount('claude-2', 'work2'),
      ],
      activeAccountUuid: 'claude-1',
    })

    const result = await call(
      'work newalias',
      {} as Parameters<typeof call>[1],
    )

    expect(result.type).toBe('text')
    expect(result.value).toContain('Multiple Claude accounts match "work"')
    expect(setSpy).not.toHaveBeenCalled()
  })

  test('unique prefix renames successfully', async () => {
    const setSpy = spyOn(codexPoolModule, 'setAccountAlias').mockImplementation(() => true)

    codexPoolModule.seedCodexAccountPoolForTest({
      accounts: [createCodexAccount('codex-1', 'backup1')],
      activeAccountId: 'codex-1',
    })

    const result = await call(
      'backup1 freshname',
      {} as Parameters<typeof call>[1],
    )
    expect(result.type).toBe('text')
    expect(result.value).toContain('Renamed backup1')
    expect(result.value).toContain('freshname')
    expect(setSpy).toHaveBeenCalledWith('codex-1', 'freshname', 'rename-account')
  })

  test('exact Claude match wins over Codex prefix match', async () => {
    const codexSetSpy = spyOn(codexPoolModule, 'setAccountAlias').mockImplementation(() => true)
    const claudeSetSpy = spyOn(claudePoolModule, 'setClaudeAccountAlias').mockImplementation(() => true)

    codexPoolModule.seedCodexAccountPoolForTest({
      accounts: [createCodexAccount('codex-workbench', 'workbench')],
      activeAccountId: 'codex-workbench',
    })
    claudePoolModule.seedClaudeAccountPoolForTest({
      accounts: [createClaudeAccount('claude-work', 'work')],
      activeAccountUuid: 'claude-work',
    })

    const result = await call(
      'work renamed',
      {} as Parameters<typeof call>[1],
    )

    expect(result.type).toBe('text')
    expect(result.value).toContain('Renamed work')
    expect(claudeSetSpy).toHaveBeenCalledWith('claude-work', 'renamed')
    expect(codexSetSpy).not.toHaveBeenCalled()
  })

  test('exact Claude match wins over ambiguous Codex prefix matches', async () => {
    const codexSetSpy = spyOn(codexPoolModule, 'setAccountAlias').mockImplementation(() => true)
    const claudeSetSpy = spyOn(claudePoolModule, 'setClaudeAccountAlias').mockImplementation(() => true)

    codexPoolModule.seedCodexAccountPoolForTest({
      accounts: [
        createCodexAccount('codex-workbench-a', 'workbench-a'),
        createCodexAccount('codex-workbench-b', 'workbench-b'),
      ],
      activeAccountId: 'codex-workbench-a',
    })
    claudePoolModule.seedClaudeAccountPoolForTest({
      accounts: [createClaudeAccount('claude-work', 'work')],
      activeAccountUuid: 'claude-work',
    })

    const result = await call(
      'work renamed',
      {} as Parameters<typeof call>[1],
    )

    expect(result.type).toBe('text')
    expect(result.value).toContain('Renamed work')
    expect(claudeSetSpy).toHaveBeenCalledWith('claude-work', 'renamed')
    expect(codexSetSpy).not.toHaveBeenCalled()
  })
})
