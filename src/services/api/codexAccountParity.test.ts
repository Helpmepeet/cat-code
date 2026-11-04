import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { getCodexOAuthTokens, saveCodexOAuthTokens, replaceCodexOAuthActiveAccountIfCurrent } from '../../utils/auth.js'
import { extractCodexAccountEmail } from '../oauth/codex-client.js'
import {
  appendAccount, getActiveAccount, getCodexDefaultSelection,
  loadCodexProfileInventoryForTest, loadPoolForObservation,
  markAccountDead, markPoolAccountQuarantined, reconcileCodexAccountSignOut,
  resetCodexAccountPoolForTest, saveCodexTokenToVault,
  seedCodexAccountPoolForTest, setActiveAccountPersisted,
  type PoolAccount,
} from './codexAccountPool.js'
import { createCodexCredentialLifecycle } from './codexCredentialLifecycle.js'
import { persistCodexOAuthLogin } from './codexLoginPersistence.js'
import { signOutCodexAccount } from './codexAccountSignOut.js'

const directories: string[] = []
function scratch(): string {
  const path = mkdtempSync(join(tmpdir(), 'codex-account-parity-'))
  directories.push(path)
  return path
}
function account(accountId: string, status: PoolAccount['status'] = 'healthy'): PoolAccount {
  return {
    accountId, status, accessToken: 'access', refreshToken: 'refresh',
    expiresAt: Date.now() + 60_000, source: 'vault', lastUsedAt: 0,
    credentialGeneration: 0, credentialGenerationState: 'legacy_unbound',
  }
}
function jwt(payload: Record<string, unknown>): string {
  return `e30.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`
}
beforeEach(() => {
  process.env.NODE_ENV = 'test'
  resetCodexAccountPoolForTest()
  saveGlobalConfig(current => ({ ...current, activeCodexAccountId: 'preferred', codexOAuth: undefined }))
})
afterEach(() => {
  resetCodexAccountPoolForTest()
  saveGlobalConfig(current => ({ ...current, activeCodexAccountId: undefined, codexOAuth: undefined }))
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})

for (const transition of ['dead', 'quarantined', 'signed_out'] as const) {
  test(`${transition} retains the saved preference and routes new chats to a usable fallback`, () => {
    seedCodexAccountPoolForTest({ accounts: [account('preferred'), account('backup')], activeAccountId: 'preferred' })
    if (transition === 'dead') markAccountDead('preferred', 'test failure')
    else if (transition === 'quarantined') markPoolAccountQuarantined('preferred', 'test failure')
    else reconcileCodexAccountSignOut({ accountId: 'preferred', vaultFilePaths: [], credentialGeneration: 1 })
    expect(getCodexDefaultSelection()).toEqual({ savedAccountId: 'preferred', effectiveAccountId: 'backup' })
    expect(getActiveAccount()?.accountId).toBe('backup')
    // A background refresh of the fallback must not convert it into the saved choice.
    appendAccount({ ...account('backup') })
    expect(getGlobalConfig().activeCodexAccountId).toBe('preferred')
    setActiveAccountPersisted('backup')
    expect(getCodexDefaultSelection().savedAccountId).toBe('backup')
  })
}

test('fresh observation and reload never select a broken saved default', async () => {
  const vault = scratch()
  mkdirSync(join(vault, 'accounts'))
  const lifecycle = createCodexCredentialLifecycle({ directory: scratch() })
  for (const id of ['preferred', 'backup']) {
    writeFileSync(join(vault, 'accounts', `${id}.json`), JSON.stringify({
      account_id: id,
      tokens: { account_id: id, access_token: 'access', refresh_token: 'refresh' },
      ...(id === 'preferred' ? { refresh: { state: 'reauth_required', reason: 'invalid_grant' } } : {}),
    }))
  }
  await loadPoolForObservation({ vaultPath: vault, configAccount: null, lifecycle })
  expect(getActiveAccount()?.accountId).toBe('backup')
  expect(getCodexDefaultSelection()).toEqual({ savedAccountId: 'preferred', effectiveAccountId: 'backup' })
  resetCodexAccountPoolForTest()
  await loadPoolForObservation({ vaultPath: vault, configAccount: null, lifecycle })
  expect(getActiveAccount()?.accountId).toBe('backup')
  expect(getGlobalConfig().activeCodexAccountId).toBe('preferred')
})

test('no usable fallback retains the preference without selecting broken credentials', () => {
  seedCodexAccountPoolForTest({ accounts: [account('preferred')] })
  markAccountDead('preferred', 'test failure')
  expect(getActiveAccount()).toBeNull()
  expect(getCodexDefaultSelection()).toEqual({ savedAccountId: 'preferred', effectiveAccountId: null })
})

for (const scenario of ['preserve', 'explicit', 'no_usable_default'] as const) {
  test(`login default choice: ${scenario}`, async () => {
    const lifecycle = createCodexCredentialLifecycle({ directory: scratch() })
    seedCodexAccountPoolForTest({ accounts: [account('preferred', scenario === 'no_usable_default' ? 'dead' : 'healthy')] })
    let installed: Parameters<typeof appendAccount>[1]
    await persistCodexOAuthLogin({ ...account('new-login'), accountEmail: 'person@example.com' }, {
      operationId: `login-${scenario}`, makeDefault: scenario === 'explicit',
    }, {
      lifecycle,
      readProfileInventory: () => ({ accounts: [], signedOutProfiles: [], duplicateVaultIdentities: [] }),
      saveConfig: () => true,
      saveVault: () => null,
      installPoolAccount: (tokens, options) => { installed = options; appendAccount(tokens, options) },
    })
    const makeDefault = scenario !== 'preserve'
    expect(installed?.activate).toBe(makeDefault)
    expect(installed?.persistDefault).toBe(makeDefault)
    expect(getGlobalConfig().activeCodexAccountId).toBe(makeDefault ? 'new-login' : 'preferred')
    expect(getActiveAccount()?.accountId).toBe(makeDefault ? 'new-login' : 'preferred')
  })
}

test('config email round-trips and signout replacement preserves the saved pointer', () => {
  const tokens = { ...account('backup'), accountEmail: 'person@example.com' }
  saveCodexOAuthTokens(tokens)
  expect(getCodexOAuthTokens()?.accountEmail).toBe('person@example.com')
  expect(replaceCodexOAuthActiveAccountIfCurrent('preferred', tokens, { preserveDefault: true })).toEqual({
    status: 'replaced', activeAccountId: 'preferred',
  })
  expect(getGlobalConfig().activeCodexAccountId).toBe('preferred')
  expect(getCodexOAuthTokens()?.accountEmail).toBe('person@example.com')
  expect(replaceCodexOAuthActiveAccountIfCurrent('wrong-pointer', null, { preserveDefault: true })).toEqual({
    status: 'pointer_changed', activeAccountId: 'preferred',
  })
  expect(getCodexOAuthTokens()?.accountId).toBe('backup')
  expect(replaceCodexOAuthActiveAccountIfCurrent('preferred', null, { preserveDefault: true })).toEqual({
    status: 'replaced', activeAccountId: 'preferred',
  })
  expect(getCodexOAuthTokens()).toBeNull()
  // Explicit deletion keeps the original durable replacement behavior.
  expect(replaceCodexOAuthActiveAccountIfCurrent('preferred', tokens)).toEqual({
    status: 'replaced', activeAccountId: 'backup',
  })
  expect(replaceCodexOAuthActiveAccountIfCurrent('backup', null)).toEqual({
    status: 'replaced', activeAccountId: null,
  })
})

test('email claims match the upstream optional ID-token shapes', () => {
  expect(extractCodexAccountEmail(jwt({ email: 'direct@example.com' }))).toBe('direct@example.com')
  expect(extractCodexAccountEmail(jwt({ 'https://api.openai.com/profile': { email: 'profile@example.com' } }))).toBe('profile@example.com')
  expect(extractCodexAccountEmail(jwt({}), jwt({ email: 'access@example.com' }))).toBe('access@example.com')
  expect(extractCodexAccountEmail('malformed', jwt({}))).toBeNull()
})

test('email survives vault login, targeted signout scrubbing, and inventory reload', async () => {
  const vault = scratch()
  const lifecycle = createCodexCredentialLifecycle({ directory: scratch() })
  const filePath = join(vault, 'accounts', 'preferred.json')
  await persistCodexOAuthLogin({ ...account('preferred'), accountEmail: 'person@example.com' }, {
    operationId: 'email-login',
  }, {
    lifecycle,
    readProfileInventory: () => ({ accounts: [], signedOutProfiles: [], duplicateVaultIdentities: [] }),
    saveConfig: () => true,
    saveVault: (tokens, options) => saveCodexTokenToVault(tokens, { ...options, filePath }),
  })
  expect(loadCodexProfileInventoryForTest(vault, { lifecycle }).accounts[0]?.accountEmail).toBe('person@example.com')
  const result = await signOutCodexAccount({ accountId: 'preferred', expectedCredentialGeneration: 1, operationId: 'email-signout' }, {
    lifecycle, getVaultPath: () => vault,
    retireWebSockets: () => {}, resetCodexCacheContext: () => {},
    invalidateUsageCache: () => {}, clearAuthCaches: async () => {},
  })
  expect(result.status).toBe('committed')
  expect(getGlobalConfig().activeCodexAccountId).toBe('preferred')
  const data = JSON.parse(readFileSync(filePath, 'utf8'))
  expect(data.account_email).toBe('person@example.com')
  expect(data.tokens).toBeUndefined()
  const profile = loadCodexProfileInventoryForTest(vault, { lifecycle }).signedOutProfiles[0]
  expect(profile?.accountEmail).toBe('person@example.com')
  expect(profile?.profileState).toBe('signed_out')
  expect(profile?.recoveryReason).toBeUndefined()
})

test('recovery reasons distinguish invalid, unavailable, mismatched, and duplicate identities', async () => {
  const vault = scratch()
  mkdirSync(join(vault, 'accounts'))
  const lifecycle = createCodexCredentialLifecycle({ directory: scratch() })
  const write = (id: string, generation: unknown, extra: Record<string, unknown> = {}, filename = id) => {
    writeFileSync(join(vault, 'accounts', `${filename}.json`), JSON.stringify({
      account_id: id, ...extra,
      tokens: { account_id: id, access_token: 'access', refresh_token: 'refresh', credential_generation: generation },
    }))
  }
  write('invalid', 'bad')
  write('unavailable', 1)
  await lifecycle.withTransaction('mismatch', { operationKind: 'login', operationId: 'mismatch-login' }, permit => {
    const prepared = lifecycle.prepareLogin(permit)
    if (prepared.status !== 'applied') throw new Error('prepare failed')
    lifecycle.commitLogin(permit, { expectedGeneration: prepared.record.credentialGeneration })
  })
  write('mismatch', 2)
  write('explicit', 0, { profile_state: 'recovery_required' })
  await lifecycle.withTransaction('pending', { operationKind: 'login', operationId: 'pending-login' }, permit => {
    lifecycle.prepareLogin(permit)
  })
  write('pending', 1)
  write('duplicate', 0)
  write('duplicate', 0, {}, 'duplicate-copy')
  const profiles = loadCodexProfileInventoryForTest(vault, { lifecycle }).signedOutProfiles
  expect(Object.fromEntries(profiles.map(profile => [profile.accountId, profile.recoveryReason]))).toEqual({
    invalid: 'invalid_generation', unavailable: 'lifecycle_unavailable',
    mismatch: 'generation_mismatch', duplicate: 'duplicate_identity',
    explicit: 'profile_recovery_required', pending: 'lifecycle_not_credentialed',
  })
})
