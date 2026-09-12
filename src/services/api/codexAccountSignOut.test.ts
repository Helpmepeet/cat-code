import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import {
  clearCodexOAuthTokens,
  getCodexOAuthTokens,
  saveCodexOAuthTokens,
} from '../../utils/auth.js'
import { saveGlobalConfig } from '../../utils/config.js'
import {
  getPoolStatus,
  getSignedOutCodexProfiles,
  resetCodexAccountPoolForTest,
  seedCodexAccountPoolForTest,
  type PoolAccount,
} from './codexAccountPool.js'
import {
  createCodexCredentialLifecycle,
  type CodexCredentialLifecycle,
  type CodexCredentialLifecycleRecord,
} from './codexCredentialLifecycle.js'
import {
  getCodexLeaseSnapshotForTest,
  resetCodexLeaseManagerForTest,
  seedCodexLeaseForTest,
} from './codexAccountLeaseManager.js'
import {
  createCodexCredentialHandle,
  startCodexCredentialSend,
} from './codexCredentialUse.js'
import {
  deleteCodexAccount,
  recoverCodexAccountDeletion,
  recoverCodexAccountSignOut,
  signOutCodexAccount,
  type CodexAccountSignOutDependencies,
  type CodexAccountSignOutInput,
} from './codexAccountSignOut.js'

const scratchDirectories: string[] = []
const ACCOUNT_A = 'signout-account-a'
const ACCOUNT_B = 'signout-account-b'
const ACCOUNT_C = 'signout-account-c'

function buildPoolAccount(
  accountId: string,
  overrides: Partial<PoolAccount> = {},
): PoolAccount {
  return {
    accountId,
    accessToken: overrides.accessToken ?? `access-${accountId}`,
    refreshToken: overrides.refreshToken ?? `refresh-${accountId}`,
    expiresAt: overrides.expiresAt ?? Date.now() + 60_000,
    source: overrides.source ?? 'vault',
    status: overrides.status ?? 'healthy',
    lastUsedAt: overrides.lastUsedAt ?? 0,
    credentialGeneration: overrides.credentialGeneration ?? 1,
    credentialGenerationState:
      overrides.credentialGenerationState ?? 'lifecycle_bound',
    alias: overrides.alias,
    lastError: overrides.lastError,
    lastErrorAt: overrides.lastErrorAt,
    statusReason: overrides.statusReason,
    usagePrimary: overrides.usagePrimary,
    usageWeekly: overrides.usageWeekly,
    usageFetchedAt: overrides.usageFetchedAt,
    usageAllowed: overrides.usageAllowed,
    usageLimitReached: overrides.usageLimitReached,
    usageResetAt: overrides.usageResetAt,
    usageWeeklyResetAt: overrides.usageWeeklyResetAt,
    cappedAt: overrides.cappedAt,
    redeemedAt: overrides.redeemedAt,
    planType: overrides.planType,
    planExpiresAt: overrides.planExpiresAt,
    lastRefreshIso: overrides.lastRefreshIso,
    vaultFilePath: overrides.vaultFilePath,
  }
}

function writeVaultProfile(
  vaultPath: string,
  fileName: string,
  accountId: string,
  credentialGeneration = 1,
  alias = 'former-main',
): string {
  const accountsDir = join(vaultPath, 'accounts')
  mkdirSync(accountsDir, { recursive: true })
  const filePath = join(accountsDir, fileName)
  writeFileSync(
    filePath,
    JSON.stringify(
      {
        account_id: accountId,
        alias,
        profile_state: 'credentialed',
        created_at: '2026-09-01T00:00:00.000Z',
        last_refresh: '2026-09-12T00:00:00.000Z',
        refresh: {
          state: 'idle',
          refresh_token_hash: 'not-a-live-secret',
        },
        usage: { primary: 12, weekly: 20 },
        tokens: {
          access_token: `old-access-${accountId}`,
          refresh_token: `old-refresh-${accountId}`,
          id_token: `old-id-${accountId}`,
          account_id: accountId,
          credential_generation: credentialGeneration,
          expires_at: Date.now() + 60_000,
        },
      },
      null,
      2,
    ),
    'utf8',
  )
  return filePath
}

async function establishCredentialed(
  directory: string,
  accountId: string,
): Promise<CodexCredentialLifecycle> {
  const lifecycle = createCodexCredentialLifecycle({ directory })
  await lifecycle.withTransaction(
    accountId,
    { operationKind: 'login', operationId: `login-${accountId}` },
    permit => {
      const prepared = lifecycle.prepareLogin(permit)
      expect(prepared.status).toBe('applied')
      if (prepared.status !== 'applied') {
        throw new Error('test login preparation failed')
      }
      const committed = lifecycle.commitLogin(permit, {
        expectedGeneration: prepared.record.credentialGeneration,
      })
      expect(committed.status).toBe('applied')
    },
  )
  return lifecycle
}

function lifecycleRecord(
  lifecycle: CodexCredentialLifecycle,
  accountId: string,
): CodexCredentialLifecycleRecord {
  const result = lifecycle.read(accountId)
  expect(result.status).toBe('valid')
  if (result.status !== 'valid') {
    throw new Error('test lifecycle record missing')
  }
  return result.record
}

function setConfigState(
  activeCodexAccountId: string | undefined,
): void {
  saveGlobalConfig(current => ({
    ...current,
    activeCodexAccountId,
    codexOAuth: undefined,
  }))
}

function dependencies(
  lifecycle: CodexCredentialLifecycle,
  vaultPath: string,
  overrides: Partial<CodexAccountSignOutDependencies> = {},
): CodexAccountSignOutDependencies {
  return {
    lifecycle,
    getVaultPath: () => vaultPath,
    retireWebSockets: () => {},
    resetCodexCacheContext: () => {},
    invalidateUsageCache: () => {},
    clearAuthCaches: async () => {},
    ...overrides,
  }
}

function input(
  accountId = ACCOUNT_A,
  operationId = `signout-${accountId}`,
): CodexAccountSignOutInput {
  return {
    accountId,
    expectedCredentialGeneration: 1,
    operationId,
  }
}

beforeEach(() => {
  process.env.NODE_ENV = 'test'
  resetCodexAccountPoolForTest()
  resetCodexLeaseManagerForTest()
  setConfigState(undefined)
})

afterEach(() => {
  resetCodexAccountPoolForTest()
  resetCodexLeaseManagerForTest()
  clearCodexOAuthTokens()
  for (const directory of scratchDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('targeted Codex account sign-out', () => {
  test('commits denial before cleanup and retains only safe vault metadata', async () => {
    const vaultPath = mkdtempSync(join(tmpdir(), 'codex-signout-vault-'))
    const lifecyclePath = mkdtempSync(join(tmpdir(), 'codex-signout-lifecycle-'))
    scratchDirectories.push(vaultPath, lifecyclePath)
    const vaultFilePath = writeVaultProfile(
      vaultPath,
      `${ACCOUNT_A}.json`,
      ACCOUNT_A,
    )
    const lifecycle = await establishCredentialed(lifecyclePath, ACCOUNT_A)
    seedCodexAccountPoolForTest({
      activeAccountId: ACCOUNT_A,
      accounts: [
        buildPoolAccount(ACCOUNT_A, {
          alias: 'former-main',
          vaultFilePath,
        }),
      ],
    })
    saveCodexOAuthTokens({
      accessToken: 'config-access-a',
      refreshToken: 'config-refresh-a',
      expiresAt: Date.now() + 60_000,
      accountId: ACCOUNT_A,
      credentialGeneration: 1,
    })
    saveGlobalConfig(current => ({
      ...current,
      activeCodexAccountId: ACCOUNT_A,
    }))

    const result = await signOutCodexAccount(
      input(),
      dependencies(lifecycle, vaultPath, {
        beforeCleanup: record => {
          expect(record.state).toBe('signed_out')
          expect(record.credentialGeneration).toBe(2)
          expect(lifecycleRecord(lifecycle, ACCOUNT_A).cleanup).toBe('pending')
        },
      }),
    )

    expect(result).toMatchObject({
      status: 'committed',
      accountId: ACCOUNT_A,
      lifecycleGeneration: 2,
      lifecycleState: 'signed_out',
      targetWasActive: true,
      replacementActiveAccountId: null,
    })
    const written = JSON.parse(readFileSync(vaultFilePath, 'utf8')) as Record<
      string,
      unknown
    >
    expect(written).toEqual({
      account_id: ACCOUNT_A,
      alias: 'former-main',
      profile_state: 'signed_out',
      credential_generation: 2,
      lifecycle_generation: 2,
      lifecycle_state: 'signed_out',
    })
    expect(getCodexOAuthTokens()).toBeNull()
    expect(getPoolStatus().accounts).toHaveLength(0)
    expect(getSignedOutCodexProfiles()).toEqual([
      expect.objectContaining({
        accountId: ACCOUNT_A,
        alias: 'former-main',
        profileState: 'signed_out',
        vaultFilePaths: [vaultFilePath],
      }),
    ])
  })

  test('inactive sign-out preserves the active pointer, mirror, and unrelated pool state', async () => {
    const vaultPath = mkdtempSync(join(tmpdir(), 'codex-signout-vault-'))
    const lifecyclePath = mkdtempSync(join(tmpdir(), 'codex-signout-lifecycle-'))
    scratchDirectories.push(vaultPath, lifecyclePath)
    const targetPath = writeVaultProfile(
      vaultPath,
      `${ACCOUNT_A}.json`,
      ACCOUNT_A,
    )
    const lifecycle = await establishCredentialed(lifecyclePath, ACCOUNT_A)
    const unrelated = buildPoolAccount(ACCOUNT_B, {
      accessToken: 'unrelated-access',
      refreshToken: 'unrelated-refresh',
      alias: 'active',
      lastUsedAt: 42,
      usagePrimary: 18,
      usageWeekly: 27,
      usageFetchedAt: 41,
      status: 'capped',
      statusReason: 'usage_cap',
      lastError: 'keep this error',
      vaultFilePath: writeVaultProfile(vaultPath, `${ACCOUNT_B}.json`, ACCOUNT_B),
    })
    seedCodexAccountPoolForTest({
      activeAccountId: ACCOUNT_B,
      accounts: [
        buildPoolAccount(ACCOUNT_A, {
          alias: 'inactive',
          vaultFilePath: targetPath,
        }),
        unrelated,
      ],
    })
    setConfigState(ACCOUNT_B)
    saveCodexOAuthTokens({
      accessToken: 'unrelated-access',
      refreshToken: 'unrelated-refresh',
      expiresAt: Date.now() + 60_000,
      accountId: ACCOUNT_B,
      credentialGeneration: 1,
    })
    const before = { ...unrelated }

    const result = await signOutCodexAccount(
      input(),
      dependencies(lifecycle, vaultPath),
    )

    expect(result).toMatchObject({
      status: 'committed',
      targetWasActive: false,
      replacementActiveAccountId: null,
    })
    expect(getGlobalConfigForTest().activeCodexAccountId).toBe(ACCOUNT_B)
    expect(getCodexOAuthTokens()).toMatchObject({
      accountId: ACCOUNT_B,
      accessToken: 'unrelated-access',
      refreshToken: 'unrelated-refresh',
      credentialGeneration: 1,
    })
    expect(getPoolStatus().accounts).toEqual([before])
    expect(existsSync(targetPath)).toBe(true)
  })

  test('active sign-out validates and selects an eligible replacement', async () => {
    const vaultPath = mkdtempSync(join(tmpdir(), 'codex-signout-vault-'))
    const lifecyclePath = mkdtempSync(join(tmpdir(), 'codex-signout-lifecycle-'))
    scratchDirectories.push(vaultPath, lifecyclePath)
    const targetPath = writeVaultProfile(
      vaultPath,
      `${ACCOUNT_A}.json`,
      ACCOUNT_A,
    )
    const replacementPath = writeVaultProfile(
      vaultPath,
      `${ACCOUNT_B}.json`,
      ACCOUNT_B,
      1,
      'backup',
    )
    const lifecycle = await establishCredentialed(lifecyclePath, ACCOUNT_A)
    await establishCredentialed(lifecyclePath, ACCOUNT_B)
    seedCodexAccountPoolForTest({
      activeAccountId: ACCOUNT_A,
      accounts: [
        buildPoolAccount(ACCOUNT_A, { vaultFilePath: targetPath }),
        buildPoolAccount(ACCOUNT_B, {
          alias: 'backup',
          vaultFilePath: replacementPath,
          accessToken: 'replacement-access',
          refreshToken: 'replacement-refresh',
        }),
      ],
    })
    seedCodexLeaseForTest({
      ownerId: 'main-thread',
      ownerType: 'main',
      ownerLabel: 'Main thread',
      accountId: ACCOUNT_A,
    })
    setConfigState(ACCOUNT_A)
    saveCodexOAuthTokens({
      accessToken: 'target-access',
      refreshToken: 'target-refresh',
      expiresAt: Date.now() + 60_000,
      accountId: ACCOUNT_A,
      credentialGeneration: 1,
    })

    const result = await signOutCodexAccount(
      input(),
      dependencies(lifecycle, vaultPath),
    )

    expect(result).toMatchObject({
      status: 'committed',
      targetWasActive: true,
      replacementActiveAccountId: ACCOUNT_B,
    })
    expect(getGlobalConfigForTest().activeCodexAccountId).toBe(ACCOUNT_B)
    expect(getCodexOAuthTokens()).toMatchObject({
      accountId: ACCOUNT_B,
      accessToken: 'replacement-access',
      refreshToken: 'replacement-refresh',
      credentialGeneration: 1,
    })
    expect(getCodexLeaseSnapshotForTest().leases).toEqual([
      expect.objectContaining({
        ownerId: 'main-thread',
        accountId: ACCOUNT_B,
        state: 'active',
      }),
    ])
    expect(getPoolStatus().accounts[getPoolStatus().activeIndex]?.accountId).toBe(
      ACCOUNT_B,
    )
  })

  test('skips a concurrent replacement sign-out and uses the next eligible account', async () => {
    const vaultPath = mkdtempSync(join(tmpdir(), 'codex-signout-vault-'))
    const lifecyclePath = mkdtempSync(join(tmpdir(), 'codex-signout-lifecycle-'))
    scratchDirectories.push(vaultPath, lifecyclePath)
    const targetPath = writeVaultProfile(vaultPath, `${ACCOUNT_A}.json`, ACCOUNT_A)
    const lifecycle = await establishCredentialed(lifecyclePath, ACCOUNT_A)
    await establishCredentialed(lifecyclePath, ACCOUNT_B)
    await establishCredentialed(lifecyclePath, ACCOUNT_C)
    seedCodexAccountPoolForTest({
      activeAccountId: ACCOUNT_A,
      accounts: [
        buildPoolAccount(ACCOUNT_A, { vaultFilePath: targetPath }),
        buildPoolAccount(ACCOUNT_B, {
          vaultFilePath: writeVaultProfile(vaultPath, `${ACCOUNT_B}.json`, ACCOUNT_B),
        }),
        buildPoolAccount(ACCOUNT_C, {
          vaultFilePath: writeVaultProfile(vaultPath, `${ACCOUNT_C}.json`, ACCOUNT_C),
        }),
      ],
    })
    setConfigState(ACCOUNT_A)
    saveCodexOAuthTokens({
      accessToken: 'target-access',
      refreshToken: 'target-refresh',
      expiresAt: Date.now() + 60_000,
      accountId: ACCOUNT_A,
      credentialGeneration: 1,
    })

    let raced = false
    const lifecycleWithRace = {
      ...lifecycle,
      withTransaction: async <T>(
        accountId: string,
        options: Parameters<CodexCredentialLifecycle['withTransaction']>[1],
        callback: Parameters<CodexCredentialLifecycle['withTransaction']>[2],
      ): Promise<T> => {
        if (
          !raced &&
          accountId === ACCOUNT_B &&
          options.operationKind === 'refresh'
        ) {
          raced = true
          await lifecycle.withTransaction(
            ACCOUNT_B,
            { operationKind: 'sign_out', operationId: 'concurrent-b-signout' },
            permit => {
              const transition = lifecycle.signOut(permit, {
                expectedGeneration: 1,
              })
              expect(transition.status).toBe('applied')
            },
          )
        }
        return (await lifecycle.withTransaction(
          accountId,
          options,
          callback,
        )) as T
      },
    } as CodexCredentialLifecycle

    const result = await signOutCodexAccount(
      input(),
      dependencies(lifecycleWithRace, vaultPath),
    )

    expect(result.replacementActiveAccountId).toBe(ACCOUNT_C)
    expect(getGlobalConfigForTest().activeCodexAccountId).toBe(ACCOUNT_C)
  })

  test('persists no active account when no candidate is switchable', async () => {
    const vaultPath = mkdtempSync(join(tmpdir(), 'codex-signout-vault-'))
    const lifecyclePath = mkdtempSync(join(tmpdir(), 'codex-signout-lifecycle-'))
    scratchDirectories.push(vaultPath, lifecyclePath)
    const targetPath = writeVaultProfile(vaultPath, `${ACCOUNT_A}.json`, ACCOUNT_A)
    const lifecycle = await establishCredentialed(lifecyclePath, ACCOUNT_A)
    await establishCredentialed(lifecyclePath, ACCOUNT_B)
    seedCodexAccountPoolForTest({
      activeAccountId: ACCOUNT_A,
      accounts: [
        buildPoolAccount(ACCOUNT_A, { vaultFilePath: targetPath }),
        buildPoolAccount(ACCOUNT_B, {
          status: 'dead',
          statusReason: 'auth_dead',
          vaultFilePath: writeVaultProfile(vaultPath, `${ACCOUNT_B}.json`, ACCOUNT_B),
        }),
      ],
    })
    setConfigState(ACCOUNT_A)
    saveCodexOAuthTokens({
      accessToken: 'target-access',
      refreshToken: 'target-refresh',
      expiresAt: Date.now() + 60_000,
      accountId: ACCOUNT_A,
      credentialGeneration: 1,
    })

    const result = await signOutCodexAccount(
      input(),
      dependencies(lifecycle, vaultPath),
    )

    expect(result.replacementActiveAccountId).toBeNull()
    expect(getGlobalConfigForTest().activeCodexAccountId).toBeUndefined()
    expect(getCodexOAuthTokens()).toBeNull()
  })

  test('does not select an unusable first pool entry', async () => {
    const vaultPath = mkdtempSync(join(tmpdir(), 'codex-signout-vault-'))
    const lifecyclePath = mkdtempSync(join(tmpdir(), 'codex-signout-lifecycle-'))
    scratchDirectories.push(vaultPath, lifecyclePath)
    const targetPath = writeVaultProfile(vaultPath, `${ACCOUNT_A}.json`, ACCOUNT_A)
    const lifecycle = await establishCredentialed(lifecyclePath, ACCOUNT_A)
    await establishCredentialed(lifecyclePath, ACCOUNT_B)
    seedCodexAccountPoolForTest({
      activeAccountId: ACCOUNT_A,
      accounts: [
        buildPoolAccount(ACCOUNT_B, {
          status: 'dead',
          statusReason: 'auth_dead',
          vaultFilePath: writeVaultProfile(vaultPath, `${ACCOUNT_B}.json`, ACCOUNT_B),
        }),
        buildPoolAccount(ACCOUNT_A, { vaultFilePath: targetPath }),
      ],
    })
    setConfigState(ACCOUNT_A)
    saveCodexOAuthTokens({
      accessToken: 'target-access',
      refreshToken: 'target-refresh',
      expiresAt: Date.now() + 60_000,
      accountId: ACCOUNT_A,
      credentialGeneration: 1,
    })

    const result = await signOutCodexAccount(
      input(),
      dependencies(lifecycle, vaultPath),
    )

    expect(result.replacementActiveAccountId).toBeNull()
    expect(getPoolStatus().accounts).toHaveLength(1)
    expect(getPoolStatus().accounts[0]?.accountId).toBe(ACCOUNT_B)
  })

  test('cleanup failure leaves the tombstone pending and denies old credentials', async () => {
    const vaultPath = mkdtempSync(join(tmpdir(), 'codex-signout-vault-'))
    const lifecyclePath = mkdtempSync(join(tmpdir(), 'codex-signout-lifecycle-'))
    scratchDirectories.push(vaultPath, lifecyclePath)
    const vaultFilePath = writeVaultProfile(
      vaultPath,
      `${ACCOUNT_A}.json`,
      ACCOUNT_A,
    )
    const lifecycle = await establishCredentialed(lifecyclePath, ACCOUNT_A)
    seedCodexAccountPoolForTest({
      activeAccountId: ACCOUNT_A,
      accounts: [buildPoolAccount(ACCOUNT_A, { vaultFilePath })],
    })
    setConfigState(ACCOUNT_A)
    saveCodexOAuthTokens({
      accessToken: 'target-access',
      refreshToken: 'target-refresh',
      expiresAt: Date.now() + 60_000,
      accountId: ACCOUNT_A,
      credentialGeneration: 1,
    })

    const result = await signOutCodexAccount(
      input(),
      dependencies(lifecycle, vaultPath, {
        beforeCleanup: () => {
          throw new Error('injected cleanup failure')
        },
      }),
    )

    expect(result.status).toBe('cleanup_pending')
    expect(lifecycleRecord(lifecycle, ACCOUNT_A)).toMatchObject({
      credentialGeneration: 2,
      state: 'signed_out',
      cleanup: 'pending',
    })
    expect(JSON.parse(readFileSync(vaultFilePath, 'utf8')).tokens).toBeDefined()
    expect(getPoolStatus().accounts).toHaveLength(0)
  })

  test('config-only sign-out clears the mirror without creating a vault profile row', async () => {
    const vaultPath = mkdtempSync(join(tmpdir(), 'codex-signout-vault-'))
    const lifecyclePath = mkdtempSync(join(tmpdir(), 'codex-signout-lifecycle-'))
    scratchDirectories.push(vaultPath, lifecyclePath)
    const lifecycle = await establishCredentialed(lifecyclePath, ACCOUNT_A)
    seedCodexAccountPoolForTest({
      activeAccountId: ACCOUNT_A,
      accounts: [
        buildPoolAccount(ACCOUNT_A, {
          source: 'config',
          vaultFilePath: undefined,
        }),
      ],
    })
    setConfigState(ACCOUNT_A)
    saveCodexOAuthTokens({
      accessToken: 'config-access',
      refreshToken: 'config-refresh',
      expiresAt: Date.now() + 60_000,
      accountId: ACCOUNT_A,
      credentialGeneration: 1,
    })

    const result = await signOutCodexAccount(
      input(),
      dependencies(lifecycle, vaultPath),
    )

    expect(result.status).toBe('committed')
    expect(getCodexOAuthTokens()).toBeNull()
    expect(getSignedOutCodexProfiles()).toEqual([])
  })

  test('cleans every duplicate identity path and retains one profile', async () => {
    const vaultPath = mkdtempSync(join(tmpdir(), 'codex-signout-vault-'))
    const lifecyclePath = mkdtempSync(join(tmpdir(), 'codex-signout-lifecycle-'))
    scratchDirectories.push(vaultPath, lifecyclePath)
    const first = writeVaultProfile(vaultPath, 'first.json', ACCOUNT_A)
    const second = writeVaultProfile(vaultPath, 'second.json', ACCOUNT_A)
    const lifecycle = await establishCredentialed(lifecyclePath, ACCOUNT_A)
    seedCodexAccountPoolForTest({
      activeAccountId: ACCOUNT_A,
      accounts: [buildPoolAccount(ACCOUNT_A, { vaultFilePath: first })],
    })
    setConfigState(ACCOUNT_A)

    const result = await signOutCodexAccount(
      input(),
      dependencies(lifecycle, vaultPath),
    )

    expect(result.status).toBe('committed')
    expect(existsSync(first)).toBe(true)
    expect(existsSync(second)).toBe(true)
    expect(JSON.parse(readFileSync(first, 'utf8'))).toEqual(
      expect.objectContaining({
        account_id: ACCOUNT_A,
        profile_state: 'signed_out',
      }),
    )
    expect(JSON.parse(readFileSync(first, 'utf8')).tokens).toBeUndefined()
    expect(JSON.parse(readFileSync(second, 'utf8')).tokens).toBeUndefined()
  })

  test('recovery completes a lost receipt and repeats active replacement', async () => {
    const vaultPath = mkdtempSync(join(tmpdir(), 'codex-signout-vault-'))
    const lifecyclePath = mkdtempSync(join(tmpdir(), 'codex-signout-lifecycle-'))
    scratchDirectories.push(vaultPath, lifecyclePath)
    const targetPath = writeVaultProfile(vaultPath, `${ACCOUNT_A}.json`, ACCOUNT_A)
    const replacementPath = writeVaultProfile(
      vaultPath,
      `${ACCOUNT_B}.json`,
      ACCOUNT_B,
      1,
      'backup',
    )
    const lifecycle = await establishCredentialed(lifecyclePath, ACCOUNT_A)
    await establishCredentialed(lifecyclePath, ACCOUNT_B)
    seedCodexAccountPoolForTest({
      activeAccountId: ACCOUNT_A,
      accounts: [
        buildPoolAccount(ACCOUNT_A, { vaultFilePath: targetPath }),
        buildPoolAccount(ACCOUNT_B, {
          alias: 'backup',
          vaultFilePath: replacementPath,
        }),
      ],
    })
    setConfigState(ACCOUNT_A)
    saveCodexOAuthTokens({
      accessToken: 'target-access',
      refreshToken: 'target-refresh',
      expiresAt: Date.now() + 60_000,
      accountId: ACCOUNT_A,
      credentialGeneration: 1,
    })
    const signOutInput = input(ACCOUNT_A, 'lost-receipt')
    const pending = await signOutCodexAccount(
      signOutInput,
      dependencies(lifecycle, vaultPath, {
        beforeCleanup: () => {
          throw new Error('crash after commit')
        },
        replaceActiveAccount: () => {
          throw new Error('crash before active replacement')
        },
      }),
    )
    expect(pending.status).toBe('retryable_unknown')

    const failedRecovery = await recoverCodexAccountSignOut(
      signOutInput,
      dependencies(lifecycle, vaultPath, {
        beforeCleanup: () => {
          throw new Error('bounded recovery failure')
        },
        replaceActiveAccount: () => {
          throw new Error('bounded active-replacement failure')
        },
      }),
    )
    expect(failedRecovery.status).toBe('retryable_unknown')
    expect(lifecycleRecord(lifecycle, ACCOUNT_A).cleanup).toBe('pending')

    const recovered = await recoverCodexAccountSignOut(
      signOutInput,
      dependencies(lifecycle, vaultPath),
    )

    expect(recovered).toMatchObject({
      status: 'already_committed',
      lifecycleGeneration: 2,
      lifecycleState: 'signed_out',
      replacementActiveAccountId: ACCOUNT_B,
    })
    expect(lifecycleRecord(lifecycle, ACCOUNT_A).cleanup).toBe('complete')
    expect(getGlobalConfigForTest().activeCodexAccountId).toBe(ACCOUNT_B)
  })

  test('recovery never touches a newer login generation', async () => {
    const vaultPath = mkdtempSync(join(tmpdir(), 'codex-signout-vault-'))
    const lifecyclePath = mkdtempSync(join(tmpdir(), 'codex-signout-lifecycle-'))
    scratchDirectories.push(vaultPath, lifecyclePath)
    const vaultFilePath = writeVaultProfile(
      vaultPath,
      `${ACCOUNT_A}.json`,
      ACCOUNT_A,
      3,
    )
    const lifecycle = await establishCredentialed(lifecyclePath, ACCOUNT_A)
    await lifecycle.withTransaction(
      ACCOUNT_A,
      { operationKind: 'sign_out', operationId: 'lost-receipt' },
      permit => {
        const result = lifecycle.signOut(permit, {
          expectedGeneration: 1,
        })
        expect(result.status).toBe('applied')
      },
    )
    await lifecycle.withTransaction(
      ACCOUNT_A,
      { operationKind: 'login', operationId: 'new-login' },
      permit => {
        const prepared = lifecycle.prepareLogin(permit)
        expect(prepared.status).toBe('applied')
        if (prepared.status === 'applied') {
          expect(lifecycle.commitLogin(permit, {
            expectedGeneration: prepared.record.credentialGeneration,
          }).status).toBe('applied')
        }
      },
    )
    const before = readFileSync(vaultFilePath, 'utf8')

    const recovered = await recoverCodexAccountSignOut(
      input(ACCOUNT_A, 'lost-receipt'),
      dependencies(lifecycle, vaultPath),
    )

    expect(recovered.status).toBe('superseded')
    expect(lifecycleRecord(lifecycle, ACCOUNT_A)).toMatchObject({
      credentialGeneration: 3,
      state: 'credentialed',
    })
    expect(readFileSync(vaultFilePath, 'utf8')).toBe(before)
  })

  test('resolves a config-only account when the in-memory pool is not loaded', async () => {
    const vaultPath = mkdtempSync(join(tmpdir(), 'codex-signout-vault-'))
    const lifecyclePath = mkdtempSync(join(tmpdir(), 'codex-signout-lifecycle-'))
    scratchDirectories.push(vaultPath, lifecyclePath)
    const lifecycle = await establishCredentialed(lifecyclePath, ACCOUNT_A)
    saveCodexOAuthTokens({
      accessToken: 'config-access',
      refreshToken: 'config-refresh',
      expiresAt: Date.now() + 60_000,
      accountId: ACCOUNT_A,
      credentialGeneration: 1,
    })
    saveGlobalConfig(current => ({
      ...current,
      activeCodexAccountId: ACCOUNT_A,
    }))

    const result = await signOutCodexAccount(
      input(),
      dependencies(lifecycle, vaultPath),
    )

    expect(result.status).toBe('committed')
    expect(getCodexOAuthTokens()).toBeNull()
    expect(getSignedOutCodexProfiles()).toEqual([])
  })

})

describe('targeted Codex account deletion', () => {
  test('invalidates before unlinking every credential path and denies an old handle', async () => {
    const vaultPath = mkdtempSync(join(tmpdir(), 'codex-delete-vault-'))
    const lifecyclePath = mkdtempSync(join(tmpdir(), 'codex-delete-lifecycle-'))
    scratchDirectories.push(vaultPath, lifecyclePath)
    const firstPath = writeVaultProfile(
      vaultPath,
      `${ACCOUNT_A}.json`,
      ACCOUNT_A,
    )
    const secondPath = writeVaultProfile(vaultPath, 'copy.json', ACCOUNT_A)
    const lifecycle = await establishCredentialed(lifecyclePath, ACCOUNT_A)
    seedCodexAccountPoolForTest({
      activeAccountId: ACCOUNT_A,
      accounts: [
        buildPoolAccount(ACCOUNT_A, {
          vaultFilePath: firstPath,
        }),
      ],
    })
    setConfigState(ACCOUNT_A)
    saveCodexOAuthTokens({
      accessToken: 'target-access',
      refreshToken: 'target-refresh',
      expiresAt: Date.now() + 60_000,
      accountId: ACCOUNT_A,
      credentialGeneration: 1,
    })
    const oldHandle = createCodexCredentialHandle({
      accountId: ACCOUNT_A,
      accessToken: 'old-access',
      refreshToken: 'old-refresh',
      expiresAt: Date.now() + 60_000,
      credentialGeneration: 1,
      credentialSource: 'vault',
      credentialPath: firstPath,
    })
    let observedBeforeCleanup = false

    const result = await deleteCodexAccount(
      {
        accountId: ACCOUNT_A,
        expectedCredentialGeneration: 1,
        operationId: 'delete-before-unlink',
      },
      dependencies(lifecycle, vaultPath, {
        beforeCleanup: record => {
          observedBeforeCleanup = true
          expect(record).toMatchObject({
            credentialGeneration: 2,
            state: 'signed_out',
            operationKind: 'delete',
            cleanup: 'pending',
          })
          expect(lifecycleRecord(lifecycle, ACCOUNT_A)).toEqual(record)
          expect(existsSync(firstPath)).toBe(true)
          expect(existsSync(secondPath)).toBe(true)
        },
      }),
    )

    expect(observedBeforeCleanup).toBe(true)
    expect(result.status).toBe('committed')
    expect(existsSync(firstPath)).toBe(false)
    expect(existsSync(secondPath)).toBe(false)
    expect(getPoolStatus().accounts).toEqual([])
    expect(getSignedOutCodexProfiles()).toEqual([])
    expect(lifecycleRecord(lifecycle, ACCOUNT_A)).toMatchObject({
      credentialGeneration: 2,
      state: 'signed_out',
      operationKind: 'delete',
      cleanup: 'complete',
    })

    let sends = 0
    await expect(
      startCodexCredentialSend(
        oldHandle,
        () => {
          sends += 1
          return Promise.resolve('sent')
        },
        { lifecycle },
      ),
    ).rejects.toMatchObject({ code: 'state_mismatch' })
    expect(sends).toBe(0)
  })

  test('deletes signed-out metadata without rewriting the denial tombstone', async () => {
    const vaultPath = mkdtempSync(join(tmpdir(), 'codex-delete-vault-'))
    const lifecyclePath = mkdtempSync(join(tmpdir(), 'codex-delete-lifecycle-'))
    scratchDirectories.push(vaultPath, lifecyclePath)
    const vaultFilePath = writeVaultProfile(
      vaultPath,
      `${ACCOUNT_A}.json`,
      ACCOUNT_A,
    )
    const lifecycle = await establishCredentialed(lifecyclePath, ACCOUNT_A)
    seedCodexAccountPoolForTest({
      activeAccountId: ACCOUNT_A,
      accounts: [buildPoolAccount(ACCOUNT_A, { vaultFilePath })],
    })
    const signOutResult = await signOutCodexAccount(
      input(),
      dependencies(lifecycle, vaultPath),
    )
    expect(signOutResult.status).toBe('committed')
    const tombstone = lifecycleRecord(lifecycle, ACCOUNT_A)
    const tombstoneRaw = readFileSync(
      lifecycle.getPaths(ACCOUNT_A).recordPath,
      'utf8',
    )
    expect(tombstone.state).toBe('signed_out')
    expect(existsSync(vaultFilePath)).toBe(true)

    const result = await deleteCodexAccount(
      {
        accountId: ACCOUNT_A,
        expectedCredentialGeneration: tombstone.credentialGeneration,
        operationId: 'delete-metadata',
      },
      dependencies(lifecycle, vaultPath),
    )

    expect(result.status).toBe('committed')
    expect(existsSync(vaultFilePath)).toBe(false)
    expect(getSignedOutCodexProfiles()).toEqual([])
    expect(readFileSync(lifecycle.getPaths(ACCOUNT_A).recordPath, 'utf8')).toBe(
      tombstoneRaw,
    )
    expect(lifecycleRecord(lifecycle, ACCOUNT_A)).toEqual(tombstone)
  })

  test('deletes reauthentication metadata while preserving its denial generation', async () => {
    const vaultPath = mkdtempSync(join(tmpdir(), 'codex-delete-vault-'))
    const lifecyclePath = mkdtempSync(join(tmpdir(), 'codex-delete-lifecycle-'))
    scratchDirectories.push(vaultPath, lifecyclePath)
    const vaultFilePath = writeVaultProfile(
      vaultPath,
      `${ACCOUNT_A}.json`,
      ACCOUNT_A,
    )
    const lifecycle = await establishCredentialed(lifecyclePath, ACCOUNT_A)
    await lifecycle.withTransaction(
      ACCOUNT_A,
      { operationKind: 'refresh', operationId: 'reauth-required' },
      permit => {
        expect(
          lifecycle.markReauthRequired(permit, { expectedGeneration: 1 }),
        ).toMatchObject({
          status: 'applied',
          record: {
            credentialGeneration: 2,
            state: 'reauth_required',
          },
        })
      },
    )
    seedCodexAccountPoolForTest({
      activeAccountId: ACCOUNT_A,
      accounts: [buildPoolAccount(ACCOUNT_A, { vaultFilePath })],
    })
    setConfigState(ACCOUNT_A)
    saveCodexOAuthTokens({
      accessToken: 'stale-access',
      refreshToken: 'stale-refresh',
      expiresAt: Date.now() + 60_000,
      accountId: ACCOUNT_A,
      credentialGeneration: 1,
    })
    const denial = lifecycleRecord(lifecycle, ACCOUNT_A)
    const denialRaw = readFileSync(
      lifecycle.getPaths(ACCOUNT_A).recordPath,
      'utf8',
    )

    const result = await deleteCodexAccount(
      {
        accountId: ACCOUNT_A,
        expectedCredentialGeneration: denial.credentialGeneration,
        operationId: 'delete-reauth-metadata',
      },
      dependencies(lifecycle, vaultPath),
    )

    expect(result.status).toBe('committed')
    expect(existsSync(vaultFilePath)).toBe(false)
    expect(getCodexOAuthTokens()).toBeNull()
    expect(readFileSync(lifecycle.getPaths(ACCOUNT_A).recordPath, 'utf8')).toBe(
      denialRaw,
    )
    expect(lifecycleRecord(lifecycle, ACCOUNT_A)).toEqual(denial)
  })

  test('config-only deletion invalidates its generation and leaves no saved profile', async () => {
    const vaultPath = mkdtempSync(join(tmpdir(), 'codex-delete-vault-'))
    const lifecyclePath = mkdtempSync(join(tmpdir(), 'codex-delete-lifecycle-'))
    scratchDirectories.push(vaultPath, lifecyclePath)
    const lifecycle = await establishCredentialed(lifecyclePath, ACCOUNT_A)
    setConfigState(ACCOUNT_A)
    saveCodexOAuthTokens({
      accessToken: 'config-access',
      refreshToken: 'config-refresh',
      expiresAt: Date.now() + 60_000,
      accountId: ACCOUNT_A,
      credentialGeneration: 1,
    })

    const result = await deleteCodexAccount(
      {
        accountId: ACCOUNT_A,
        expectedCredentialGeneration: 1,
        operationId: 'delete-config',
      },
      dependencies(lifecycle, vaultPath),
    )

    expect(result.status).toBe('committed')
    expect(getCodexOAuthTokens()).toBeNull()
    expect(getPoolStatus().accounts).toEqual([])
    expect(getSignedOutCodexProfiles()).toEqual([])
    expect(lifecycleRecord(lifecycle, ACCOUNT_A)).toMatchObject({
      credentialGeneration: 2,
      state: 'signed_out',
      operationKind: 'delete',
      cleanup: 'complete',
    })
  })

  test('legacy config-only deletion creates the first denial generation', async () => {
    const vaultPath = mkdtempSync(join(tmpdir(), 'codex-delete-vault-'))
    const lifecyclePath = mkdtempSync(join(tmpdir(), 'codex-delete-lifecycle-'))
    scratchDirectories.push(vaultPath, lifecyclePath)
    const lifecycle = createCodexCredentialLifecycle({ directory: lifecyclePath })
    setConfigState(ACCOUNT_A)
    saveCodexOAuthTokens({
      accessToken: 'legacy-config-access',
      refreshToken: 'legacy-config-refresh',
      expiresAt: Date.now() + 60_000,
      accountId: ACCOUNT_A,
    })

    const result = await deleteCodexAccount(
      {
        accountId: ACCOUNT_A,
        expectedCredentialGeneration: 0,
        operationId: 'delete-legacy-config',
      },
      dependencies(lifecycle, vaultPath),
    )

    expect(result.status).toBe('committed')
    expect(getCodexOAuthTokens()).toBeNull()
    expect(getSignedOutCodexProfiles()).toEqual([])
    expect(lifecycleRecord(lifecycle, ACCOUNT_A)).toMatchObject({
      credentialGeneration: 1,
      state: 'signed_out',
      operationKind: 'delete',
      cleanup: 'complete',
    })
  })

  test('lost deletion results recover, while a newer prepared login wins', async () => {
    const vaultPath = mkdtempSync(join(tmpdir(), 'codex-delete-vault-'))
    const lifecyclePath = mkdtempSync(join(tmpdir(), 'codex-delete-lifecycle-'))
    scratchDirectories.push(vaultPath, lifecyclePath)
    const vaultFilePath = writeVaultProfile(
      vaultPath,
      `${ACCOUNT_A}.json`,
      ACCOUNT_A,
    )
    const replacementPath = writeVaultProfile(
      vaultPath,
      `${ACCOUNT_B}.json`,
      ACCOUNT_B,
      1,
      'backup',
    )
    const lifecycle = await establishCredentialed(lifecyclePath, ACCOUNT_A)
    await establishCredentialed(lifecyclePath, ACCOUNT_B)
    seedCodexAccountPoolForTest({
      activeAccountId: ACCOUNT_A,
      accounts: [
        buildPoolAccount(ACCOUNT_A, { vaultFilePath }),
        buildPoolAccount(ACCOUNT_B, {
          alias: 'backup',
          vaultFilePath: replacementPath,
        }),
      ],
    })
    setConfigState(ACCOUNT_A)
    saveCodexOAuthTokens({
      accessToken: 'target-access',
      refreshToken: 'target-refresh',
      expiresAt: Date.now() + 60_000,
      accountId: ACCOUNT_A,
      credentialGeneration: 1,
    })
    const deletionInput = {
      accountId: ACCOUNT_A,
      expectedCredentialGeneration: 1,
      operationId: 'lost-delete',
    }
    const pending = await deleteCodexAccount(
      deletionInput,
      dependencies(lifecycle, vaultPath, {
        beforeCleanup: () => {
          throw new Error('lost deletion result')
        },
        replaceActiveAccount: () => {
          throw new Error('lost active replacement result')
        },
      }),
    )
    expect(pending.status).toBe('retryable_unknown')
    expect(lifecycleRecord(lifecycle, ACCOUNT_A).cleanup).toBe('pending')
    expect(getPoolStatus().accounts).toEqual([
      expect.objectContaining({ accountId: ACCOUNT_B }),
    ])

    const recovered = await recoverCodexAccountDeletion(
      deletionInput,
      dependencies(lifecycle, vaultPath),
    )
    expect(recovered.status).toBe('already_committed')
    expect(existsSync(vaultFilePath)).toBe(false)
    expect(lifecycleRecord(lifecycle, ACCOUNT_A).cleanup).toBe('complete')
    expect(recovered.replacementActiveAccountId).toBe(ACCOUNT_B)

    const newerPath = writeVaultProfile(
      vaultPath,
      `${ACCOUNT_C}.json`,
      ACCOUNT_C,
    )
    await establishCredentialed(lifecyclePath, ACCOUNT_C)
    const staleLifecycle = createCodexCredentialLifecycle({
      directory: lifecyclePath,
    })
    await staleLifecycle.withTransaction(
      ACCOUNT_C,
      { operationKind: 'delete', operationId: 'stale-prepared-delete' },
      permit => {
        expect(
          staleLifecycle.deleteAccount(permit, { expectedGeneration: 1 }),
        ).toMatchObject({ status: 'applied' })
      },
    )
    await staleLifecycle.withTransaction(
      ACCOUNT_C,
      { operationKind: 'login', operationId: 'newer-prepared-login' },
      permit => {
        expect(staleLifecycle.prepareLogin(permit)).toMatchObject({
          status: 'applied',
          record: {
            credentialGeneration: 3,
            state: 'login_prepared',
          },
        })
      },
    )
    const newerBefore = readFileSync(newerPath, 'utf8')
    const stale = await recoverCodexAccountDeletion(
      {
        accountId: ACCOUNT_C,
        expectedCredentialGeneration: 1,
        operationId: 'stale-prepared-delete',
      },
      dependencies(staleLifecycle, vaultPath),
    )
    expect(stale.status).toBe('superseded')
    expect(readFileSync(newerPath, 'utf8')).toBe(newerBefore)
    expect(lifecycleRecord(staleLifecycle, ACCOUNT_C)).toMatchObject({
      credentialGeneration: 3,
      state: 'login_prepared',
    })
  })

  test('stale deletion recovery never touches a newer committed login', async () => {
    const vaultPath = mkdtempSync(join(tmpdir(), 'codex-delete-vault-'))
    const lifecyclePath = mkdtempSync(join(tmpdir(), 'codex-delete-lifecycle-'))
    scratchDirectories.push(vaultPath, lifecyclePath)
    const vaultFilePath = writeVaultProfile(
      vaultPath,
      `${ACCOUNT_A}.json`,
      ACCOUNT_A,
    )
    const lifecycle = await establishCredentialed(lifecyclePath, ACCOUNT_A)
    seedCodexAccountPoolForTest({
      activeAccountId: ACCOUNT_A,
      accounts: [buildPoolAccount(ACCOUNT_A, { vaultFilePath })],
    })
    const deletionInput = {
      accountId: ACCOUNT_A,
      expectedCredentialGeneration: 1,
      operationId: 'stale-committed-delete',
    }
    await lifecycle.withTransaction(
      ACCOUNT_A,
      { operationKind: 'delete', operationId: deletionInput.operationId },
      permit => {
        expect(
          lifecycle.deleteAccount(permit, { expectedGeneration: 1 }),
        ).toMatchObject({
          status: 'applied',
          record: {
            credentialGeneration: 2,
            state: 'signed_out',
          },
        })
      },
    )
    await lifecycle.withTransaction(
      ACCOUNT_A,
      { operationKind: 'login', operationId: 'newer-committed-login' },
      permit => {
        const prepared = lifecycle.prepareLogin(permit)
        expect(prepared).toMatchObject({
          status: 'applied',
          record: {
            credentialGeneration: 3,
            state: 'login_prepared',
          },
        })
        if (prepared.status === 'applied') {
          expect(
            lifecycle.commitLogin(permit, {
              expectedGeneration: prepared.record.credentialGeneration,
            }),
          ).toMatchObject({
            status: 'applied',
            record: {
              credentialGeneration: 3,
              state: 'credentialed',
            },
          })
        }
      },
    )
    const before = readFileSync(vaultFilePath, 'utf8')

    const result = await recoverCodexAccountDeletion(
      deletionInput,
      dependencies(lifecycle, vaultPath),
    )

    expect(result.status).toBe('superseded')
    expect(readFileSync(vaultFilePath, 'utf8')).toBe(before)
    expect(lifecycleRecord(lifecycle, ACCOUNT_A)).toMatchObject({
      credentialGeneration: 3,
      state: 'credentialed',
    })
  })

  test('repairs only target leases and preserves unrelated runtime state', async () => {
    const vaultPath = mkdtempSync(join(tmpdir(), 'codex-delete-vault-'))
    const lifecyclePath = mkdtempSync(join(tmpdir(), 'codex-delete-lifecycle-'))
    scratchDirectories.push(vaultPath, lifecyclePath)
    const targetPath = writeVaultProfile(vaultPath, `${ACCOUNT_A}.json`, ACCOUNT_A)
    const replacementPath = writeVaultProfile(
      vaultPath,
      `${ACCOUNT_B}.json`,
      ACCOUNT_B,
      1,
      'replacement',
    )
    const unrelatedPath = writeVaultProfile(
      vaultPath,
      `${ACCOUNT_C}.json`,
      ACCOUNT_C,
      1,
      'unrelated',
    )
    const lifecycle = await establishCredentialed(lifecyclePath, ACCOUNT_A)
    await establishCredentialed(lifecyclePath, ACCOUNT_B)
    await establishCredentialed(lifecyclePath, ACCOUNT_C)
    const unrelated = buildPoolAccount(ACCOUNT_C, {
      alias: 'unrelated',
      vaultFilePath: unrelatedPath,
      status: 'capped',
      statusReason: 'usage_cap',
      lastError: 'preserve',
      lastUsedAt: 42,
      usagePrimary: 31,
      usageWeekly: 22,
    })
    seedCodexAccountPoolForTest({
      activeAccountId: ACCOUNT_A,
      accounts: [
        buildPoolAccount(ACCOUNT_A, { vaultFilePath: targetPath }),
        buildPoolAccount(ACCOUNT_B, {
          alias: 'replacement',
          vaultFilePath: replacementPath,
        }),
        unrelated,
      ],
    })
    seedCodexLeaseForTest({
      ownerId: 'main-thread',
      ownerType: 'main',
      ownerLabel: 'Main thread',
      accountId: ACCOUNT_A,
    })
    seedCodexLeaseForTest({
      ownerId: 'follow-worker',
      ownerType: 'subagent',
      ownerLabel: 'Follow worker',
      accountId: ACCOUNT_A,
      strategy: 'follow-main',
    })
    seedCodexLeaseForTest({
      ownerId: 'unrelated-worker',
      ownerType: 'subagent',
      ownerLabel: 'Unrelated worker',
      accountId: ACCOUNT_C,
      strategy: 'spread',
    })
    setConfigState(ACCOUNT_A)
    saveCodexOAuthTokens({
      accessToken: 'target-access',
      refreshToken: 'target-refresh',
      expiresAt: Date.now() + 60_000,
      accountId: ACCOUNT_A,
      credentialGeneration: 1,
    })

    const result = await deleteCodexAccount(
      {
        accountId: ACCOUNT_A,
        expectedCredentialGeneration: 1,
        operationId: 'delete-leases',
      },
      dependencies(lifecycle, vaultPath),
    )

    expect(result.replacementActiveAccountId).toBe(ACCOUNT_B)
    expect(getPoolStatus().activeIndex).toBe(0)
    expect(getPoolStatus().accounts[0]?.accountId).toBe(ACCOUNT_B)
    expect(getPoolStatus().accounts[1]).toEqual(
      expect.objectContaining({
        accountId: ACCOUNT_C,
        status: 'capped',
        statusReason: 'usage_cap',
        lastError: 'preserve',
        lastUsedAt: 42,
        usagePrimary: 31,
        usageWeekly: 22,
      }),
    )
    expect(getCodexLeaseSnapshotForTest().leases).toEqual([
      expect.objectContaining({ ownerId: 'main-thread', accountId: ACCOUNT_B }),
      expect.objectContaining({ ownerId: 'follow-worker', accountId: ACCOUNT_B }),
      expect.objectContaining({ ownerId: 'unrelated-worker', accountId: ACCOUNT_C }),
    ])
  })
})

function getGlobalConfigForTest(): {
  activeCodexAccountId?: string
} {
  const { getGlobalConfig } = require('../../utils/config.js') as typeof import('../../utils/config.js')
  return getGlobalConfig()
}
