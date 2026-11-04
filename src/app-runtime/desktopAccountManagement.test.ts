import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as config from '../utils/config.js'
import * as storage from '../utils/secureStorage/index.js'
import { removeMatchingClaudeOAuthFromStores } from '../utils/secureStorage/crossProcessStorage.js'
import {
  appendClaudeAccount, getClaudePoolStatus, getClaudeProfileInventory,
  loadClaudePoolForObservation, resetClaudeAccountPoolForTest,
  setClaudeConfigAccountForTest, setClaudeVaultPathForTest,
} from '../services/api/claudeAccountPool.js'
import { resetCodexAccountPoolForTest, seedCodexAccountPoolForTest } from '../services/api/codexAccountPool.js'
import { createRealAnthropicOAuthLoginRunner, createRealAccountsExecutor,
  createSidecarAccountsDomain, buildAccountsSnapshot } from '../../app/sidecar/accountsDomain.js'
import { parseAccountsSnapshot } from '../../app/shared/accountsPoolWorker.js'
import type { OAuthTokens } from '../services/oauth/types.js'
import type { OAuthLoginProgress } from '../../app/shared/protocol.js'

let directory: string
let previousConfigDir: string | undefined
let settings: ReturnType<typeof config.getGlobalConfig>
let secureData: any
let loginOperations = 0
const fakeStorage = () => ({
  name: 'isolated-test',
  read: () => structuredClone(secureData),
  readAsync: async () => structuredClone(secureData),
  readFresh: () => ({ status: 'present' as const, data: structuredClone(secureData) }),
  update: (next: any) => { secureData = structuredClone(next); return { success: true } },
  delete: () => { throw new Error('Must not delete an entire credential store') },
})

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'desktop-account-runtime-'))
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = directory
  resetClaudeAccountPoolForTest()
  resetCodexAccountPoolForTest()
  setClaudeVaultPathForTest(directory)
  setClaudeConfigAccountForTest({ active: true, value: null })
  secureData = {}
  loginOperations = 0
  settings = {} as typeof settings
  spyOn(config, 'getGlobalConfig').mockImplementation(() => settings)
  spyOn(config, 'saveGlobalConfig').mockImplementation(updater => { settings = updater(settings); return true })
  spyOn(storage, 'getSecureStorage').mockImplementation(fakeStorage)
  spyOn(storage, 'removeMatchingClaudeOAuthCredentials').mockImplementation(tokens =>
    removeMatchingClaudeOAuthFromStores([fakeStorage()], tokens))
})

afterEach(() => {
  mock.restore()
  resetClaudeAccountPoolForTest()
  resetCodexAccountPoolForTest()
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
  rmSync(directory, { recursive: true, force: true })
})

function tokens(id = 'fixture-claude'): OAuthTokens {
  return {
    accessToken: `synthetic-access-${id}`, refreshToken: `synthetic-refresh-${id}`,
    expiresAt: Date.now() + 3600_000, scopes: ['user:inference'],
    subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x',
    tokenAccount: { uuid: id, emailAddress: `${id}@example.test`, organizationUuid: 'fixture-org' },
  }
}

function installCaptured(t: OAuthTokens, options: { operationId?: string; alias?: string; makeDefault?: boolean } = {}) {
  return appendClaudeAccount({
    accountUuid: t.tokenAccount!.uuid, emailAddress: t.tokenAccount!.emailAddress,
    accessToken: t.accessToken, refreshToken: t.refreshToken!, expiresAt: t.expiresAt!,
    scopes: t.scopes, subscriptionType: t.subscriptionType, rateLimitTier: t.rateLimitTier,
  }, options)
}

function runner(t: OAuthTokens, install = installCaptured) {
  return createRealAnthropicOAuthLoginRunner({
    createService: () => ({ startOAuthFlow: async () => t, handleManualAuthCodeInput() {}, cleanup() {} }),
    readSettings: () => ({}), validateOrg: async () => ({ valid: true }),
    lookupProfile: async () => { throw new Error('Fixture identity must not request a profile') },
    installTokens: async (captured, options) => install(captured, options),
    createOperationId: () => `fixture-login-operation-${++loginOperations}`,
  })
}

const callbacks = { onWaitingForLogin() {}, waitForManualCode: async () => '' }

test('new Claude naming validates both pools and retries a failed save with the same operation', async () => {
  seedCodexAccountPoolForTest({ accounts: [{
    accountId: 'codex-fixture', alias: 'WORK', accessToken: 'synthetic', refreshToken: 'synthetic',
    expiresAt: Date.now() + 3600_000, source: 'vault', status: 'healthy', lastUsedAt: 0,
    credentialGeneration: 0, credentialGenerationState: 'legacy_unbound',
  }] })
  const operations: string[] = []
  let fail = true
  const pending = await runner(tokens(), (captured, options) => {
    operations.push(options.operationId!)
    if (fail) { fail = false; throw new Error('Synthetic disk failure') }
    return installCaptured(captured, options)
  }).begin(callbacks)
  expect(pending.isExistingAccount).toBe(false)
  expect(pending.validateAlias('work').ok).toBe(false)
  expect(pending.validateAlias('two words').ok).toBe(false)
  expect(pending.validateAlias('personal').ok).toBe(true)
  await expect(pending.persist('personal', { makeDefault: false })).rejects.toThrow('Synthetic disk failure')
  expect(await pending.persist('personal', { makeDefault: false })).toMatchObject({ outcome: 'committed' })
  expect(operations).toEqual(['fixture-login-operation-1', 'fixture-login-operation-1'])
  expect(getClaudePoolStatus().accounts[0]?.alias).toBe('personal')
  const existing = await runner(tokens()).begin(callbacks)
  expect(existing.isExistingAccount).toBe(true)
  await existing.persist(undefined, { makeDefault: false })
  expect(getClaudePoolStatus().accounts[0]?.alias).toBe('personal')
})

test('Claude lifecycle verbs use real authority, preserve a profile, and reject stale deletion', async () => {
  const installation = installCaptured(tokens(), { alias: 'personal' })
  const domain = createSidecarAccountsDomain({
    executor: createRealAccountsExecutor({ switchScope: 'default' }),
    reloadAnthropicPool: async () => loadClaudePoolForObservation(),
  })
  const out = await domain.runVerb({ type: 'account.logout', requestId: 'signout', provider: 'anthropic',
    accountId: 'fixture-claude', expectedCredentialGeneration: installation.handle!.generation })
  expect(out.result.ok).toBe(true)
  expect(getClaudePoolStatus().accounts).toHaveLength(0)
  const profile = getClaudeProfileInventory().signedOutProfiles[0]!
  expect(profile.alias).toBe('personal')
  const pending = await runner(tokens()).begin(callbacks)
  expect(pending.isExistingAccount).toBe(true)
  await pending.persist(undefined, { makeDefault: false })
  expect(getClaudePoolStatus().accounts[0]?.alias).toBe('personal')
  expect((await domain.runVerb({ type: 'account.delete', requestId: 'stale-delete', provider: 'anthropic',
    accountId: profile.accountUuid, expectedCredentialGeneration: profile.loginGeneration, confirm: true })).result.ok).toBe(false)
  const generation = getClaudePoolStatus().accounts[0]!.lifecycleGeneration!
  expect((await domain.runVerb({ type: 'account.rename', requestId: 'rename', provider: 'anthropic',
    accountId: profile.accountUuid, alias: 'renamed' })).result.ok).toBe(true)
  expect((await domain.runVerb({ type: 'account.delete', requestId: 'delete', provider: 'anthropic',
    accountId: profile.accountUuid, expectedCredentialGeneration: generation, confirm: true })).result.ok).toBe(true)
})

test('Claude naming controller keeps a failed save on the naming step and forwards default opt-in', async () => {
  const progress: OAuthLoginProgress[] = []
  let saves = 0
  const domain = createSidecarAccountsDomain({
    anthropicOAuthRunner: runner(tokens(), (captured, options) => {
      if (++saves === 1) throw new Error('Synthetic disk failure')
      expect(options.makeDefault).toBe(true)
      return installCaptured(captured, options)
    }), isFirstRunEligible: () => false,
  })
  domain.setOAuthProgressSink(update => progress.push(update))
  await domain.runVerb({ type: 'account.login', requestId: 'login', provider: 'anthropic', makeDefault: true })
  await new Promise(resolve => setImmediate(resolve))
  expect(progress.at(-1)?.state).toBe('waiting_for_alias')
  const first = await domain.runVerb({ type: 'account.oauthAlias', requestId: 'name-1', alias: 'personal' })
  expect(first.result.ok).toBe(false)
  expect(progress.at(-1)?.state).toBe('waiting_for_alias')
  const second = await domain.runVerb({ type: 'account.oauthAlias', requestId: 'name-2', alias: 'personal' })
  expect(second.result.ok).toBe(true)
  expect(progress.at(-1)).toMatchObject({ state: 'success', loginRequestId: 'login' })
})

test('real projected rich account data passes the strict renderer snapshot parser', () => {
  installCaptured(tokens(), { alias: 'personal' })
  const snapshot = buildAccountsSnapshot({ accounts: [], activeIndex: -1, initialized: true }, Date.now(),
    getClaudePoolStatus(), true, true, undefined, new Map([['fixture-claude', {
      fiveHour: { percent: 10, resetAt: 99_999_999_999 }, weekly: { percent: 20, resetAt: 99_999_999_999 },
      weeklyOpus: { percent: 30, resetAt: 99_999_999_999 }, weeklySonnet: { percent: 40, resetAt: 99_999_999_999 },
      extraUsage: { usedCredits: 5, monthlyLimit: 100, isEnabled: true }, checkedAt: Date.now(), stale: true,
    }]]))
  expect(parseAccountsSnapshot(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot)
  const serialized = JSON.stringify(snapshot)
  expect(serialized).not.toContain('synthetic-access')
  expect(serialized).not.toContain('synthetic-refresh')
  expect(serialized).not.toContain(directory)
  expect(snapshot.anthropicAccounts[0]).toMatchObject({ usageWeeklyOpus: 30, usageWeeklySonnet: 40, usageStale: true })
})
