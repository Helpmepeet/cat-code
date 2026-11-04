import { afterEach, expect, test } from 'bun:test'
import { validateAccountAlias } from './accountAlias.js'
import { resetClaudeAccountPoolForTest, seedClaudeAccountPoolForTest } from './claudeAccountPool.js'
import { resetCodexAccountPoolForTest, seedCodexAccountPoolForTest } from './codexAccountPool.js'

afterEach(() => {
  resetClaudeAccountPoolForTest()
  resetCodexAccountPoolForTest()
})

function seedNames() {
  seedClaudeAccountPoolForTest({ accounts: [{
    accountUuid: 'claude-fixture', emailAddress: 'claude@example.test',
    alias: 'Personal', accessToken: 'synthetic', refreshToken: 'synthetic-refresh',
    expiresAt: Date.now() + 60_000, status: 'healthy',
  }] })
  seedCodexAccountPoolForTest({ accounts: [{
    accountId: 'codex-fixture', alias: 'Work', accessToken: 'synthetic',
    refreshToken: 'synthetic-refresh', expiresAt: Date.now() + 60_000,
    status: 'healthy', source: 'vault', lastUsedAt: 0,
    credentialGeneration: 0, credentialGenerationState: 'legacy_unbound',
  }] })
}

test('new names are case-insensitively unique across both provider pools', () => {
  seedNames()
  expect(validateAccountAlias('WORK', 'anthropic', 'claude-fixture').ok).toBe(false)
  expect(validateAccountAlias('personal', 'openai', 'codex-fixture').ok).toBe(false)
  expect(validateAccountAlias('PERSONAL', 'anthropic', 'claude-fixture').ok).toBe(true)
  expect(validateAccountAlias('work', 'openai', 'codex-fixture').ok).toBe(true)
  expect(validateAccountAlias('new_account-2', 'anthropic').ok).toBe(true)
})

test('format validation applies to newly set names without trimming them implicitly', () => {
  seedNames()
  for (const alias of ['', 'two words', ' work', 'work ', 'a'.repeat(33), 'café']) {
    expect(validateAccountAlias(alias, 'anthropic').ok).toBe(false)
    expect(validateAccountAlias(alias, 'openai').ok).toBe(false)
  }
  expect(validateAccountAlias('a'.repeat(32), 'anthropic').ok).toBe(true)
})
