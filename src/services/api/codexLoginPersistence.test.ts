import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import type { CodexTokens } from '../oauth/codex-client.js'
import {
  createCodexCredentialLifecycle,
  type CodexCredentialLifecycle,
  type CodexCredentialLifecycleRecord,
} from './codexCredentialLifecycle.js'
import {
  loadCodexProfileInventoryForTest,
  type CodexProfileInventory,
  type SignedOutCodexProfile,
} from './codexAccountPool.js'
import {
  persistCodexOAuthLogin,
  type CodexOAuthLoginPersistenceDependencies,
} from './codexLoginPersistence.js'

const ACCOUNT_ID = 'ca11ab1e-0000-4000-8000-0000000000c1'
const OTHER_ACCOUNT_ID = 'ca11ab1e-0000-4000-8000-0000000000c3'
const directories: string[] = []

function createLifecycle(): CodexCredentialLifecycle {
  const directory = mkdtempSync(join(tmpdir(), 'codex-login-lifecycle-'))
  directories.push(directory)
  return createCodexCredentialLifecycle({ directory })
}

function createVaultDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'codex-login-vault-'))
  directories.push(directory)
  return directory
}

function tokens(accountId = ACCOUNT_ID): CodexTokens {
  return {
    accessToken: `access-${accountId}`,
    refreshToken: `refresh-${accountId}`,
    expiresAt: 1_900_000_000_000,
    accountId,
  }
}

function emptyInventory(): CodexProfileInventory {
  return {
    accounts: [],
    signedOutProfiles: [],
    duplicateVaultIdentities: [],
  }
}

function signedOutProfile(
  accountId: string,
  alias: string,
  lifecycle: CodexCredentialLifecycleRecord,
): SignedOutCodexProfile {
  return {
    accountId,
    alias,
    source: 'vault',
    vaultFilePath: `/tmp/${accountId}.json`,
    vaultFilePaths: [`/tmp/${accountId}.json`],
    profileState: 'signed_out',
    credentialGeneration: lifecycle.credentialGeneration,
    credentialGenerationState: 'lifecycle_bound',
    lifecycleState: lifecycle.state,
    lifecycleReadStatus: 'valid',
  }
}

async function establishSignedOut(
  lifecycle: CodexCredentialLifecycle,
): Promise<CodexCredentialLifecycleRecord> {
  await lifecycle.withTransaction(
    ACCOUNT_ID,
    { operationKind: 'login', operationId: 'initial-login' },
    permit => {
      const prepared = lifecycle.prepareLogin(permit)
      if (prepared.status !== 'applied') throw new Error('prepare failed')
      const committed = lifecycle.commitLogin(permit, {
        expectedGeneration: prepared.record.credentialGeneration,
      })
      if (committed.status !== 'applied') throw new Error('commit failed')
    },
  )
  let signedOut: CodexCredentialLifecycleRecord | undefined
  await lifecycle.withTransaction(
    ACCOUNT_ID,
    { operationKind: 'sign_out', operationId: 'initial-signout' },
    permit => {
      const result = lifecycle.signOut(permit, { expectedGeneration: 1 })
      if (result.status !== 'applied') throw new Error('sign-out failed')
      signedOut = result.record
    },
  )
  if (!signedOut) throw new Error('sign-out did not produce a record')
  return signedOut
}

function vaultWriter(
  vaultDirectory: string,
  order: string[] = [],
  result: 'saved' | 'failed' = 'saved',
): CodexOAuthLoginPersistenceDependencies['saveVault'] {
  return credentialTokens => {
    order.push('vault')
    const filePath = join(
      vaultDirectory,
      'accounts',
      `${credentialTokens.accountId}.json`,
    )
    mkdirSync(join(vaultDirectory, 'accounts'), { recursive: true })
    writeFileSync(
      filePath,
      `${JSON.stringify({
        account_id: credentialTokens.accountId,
        profile_state: 'credentialed',
        ...(credentialTokens.alias ? { alias: credentialTokens.alias } : {}),
        tokens: {
          access_token: credentialTokens.accessToken,
          refresh_token: credentialTokens.refreshToken,
          account_id: credentialTokens.accountId,
          credential_generation: credentialTokens.credentialGeneration,
          expires_at: credentialTokens.expiresAt,
        },
      })}\n`,
      'utf8',
    )
    if (result === 'failed') return null
    return {
      filePath,
      existed: false,
      metadataAction: 'created',
      accountChanged: false,
    }
  }
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('persistCodexOAuthLogin', () => {
  test('matches the positive lifecycle generation in vault, config, and pool', async () => {
    const lifecycle = createLifecycle()
    const vaultDirectory = createVaultDirectory()
    const order: string[] = []
    let configTokens: CodexTokens | undefined
    let poolTokens: CodexTokens | undefined
    const result = await persistCodexOAuthLogin(
      tokens(),
      {
        operationId: 'login-central-success',
      },
      {
        lifecycle,
        readProfileInventory: emptyInventory,
        saveVault: vaultWriter(vaultDirectory, order),
        saveConfig(received) {
          order.push('config')
          configTokens = received
          return true
        },
        installPoolAccount(received) {
          order.push('pool')
          poolTokens = received
        },
      },
    )

    const vault = JSON.parse(
      readFileSync(join(vaultDirectory, 'accounts', `${ACCOUNT_ID}.json`), 'utf8'),
    ) as { tokens: { credential_generation: number } }
    expect(result.credentialGeneration).toBe(1)
    expect(vault.tokens.credential_generation).toBe(1)
    expect(configTokens?.credentialGeneration).toBe(1)
    expect(poolTokens?.credentialGeneration).toBe(1)
    expect(lifecycle.read(ACCOUNT_ID)).toMatchObject({
      status: 'valid',
      record: { state: 'credentialed', credentialGeneration: 1 },
    })
    expect(order).toEqual(['vault', 'config', 'pool'])
  })

  test('prepares before writes and commits before pool installation', async () => {
    const lifecycle = createLifecycle()
    const vaultDirectory = createVaultDirectory()
    const order: string[] = []
    const observedLifecycle: CodexCredentialLifecycle = {
      ...lifecycle,
      prepareLogin(permit) {
        order.push('prepare')
        return lifecycle.prepareLogin(permit)
      },
      commitLogin(permit, options) {
        order.push('commit')
        return lifecycle.commitLogin(permit, options)
      },
    }

    await persistCodexOAuthLogin(
      tokens(),
      { operationId: 'login-central-order' },
      {
        lifecycle: observedLifecycle,
        readProfileInventory: emptyInventory,
        saveVault: vaultWriter(vaultDirectory, order),
        saveConfig() {
          order.push('config')
          return true
        },
        installPoolAccount() {
          order.push('pool')
        },
      },
    )

    expect(order).toEqual(['prepare', 'vault', 'config', 'commit', 'pool'])
  })

  test('leaves written credentials denied when persistence fails before commit', async () => {
    const lifecycle = createLifecycle()
    const vaultDirectory = createVaultDirectory()

    await expect(
      persistCodexOAuthLogin(
        tokens(),
        { operationId: 'login-central-failed' },
        {
          lifecycle,
          readProfileInventory: emptyInventory,
          saveVault: vaultWriter(vaultDirectory, [], 'failed'),
          saveConfig: () => false,
          installPoolAccount() {
            throw new Error('pool must not be installed')
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'credentials_not_persisted' })

    expect(lifecycle.read(ACCOUNT_ID)).toMatchObject({
      status: 'valid',
      record: { state: 'login_prepared', credentialGeneration: 1 },
    })
    const reloaded = loadCodexProfileInventoryForTest(vaultDirectory, {
      lifecycle,
    })
    expect(reloaded.accounts).toHaveLength(0)
    expect(reloaded.signedOutProfiles).toMatchObject([
      {
        accountId: ACCOUNT_ID,
        profileState: 'recovery_required',
        credentialGeneration: 1,
      },
    ])
  })

  test('uses a valid config mirror when vault persistence fails', async () => {
    const lifecycle = createLifecycle()
    let configGeneration: number | undefined
    let installedSource: string | undefined

    const result = await persistCodexOAuthLogin(
      tokens(),
      { operationId: 'login-config-fallback' },
      {
        lifecycle,
        readProfileInventory: emptyInventory,
        saveVault: () => null,
        saveConfig(received) {
          configGeneration = received.credentialGeneration
          return true
        },
        installPoolAccount(_received, options) {
          installedSource = options?.source
        },
      },
    )

    expect(result).toMatchObject({
      credentialGeneration: 1,
      source: 'config',
    })
    expect(configGeneration).toBe(1)
    expect(installedSource).toBe('config')
    expect(lifecycle.read(ACCOUNT_ID)).toMatchObject({
      status: 'valid',
      record: { state: 'credentialed', credentialGeneration: 1 },
    })
  })

  test('does not commit when both durable stores fail', async () => {
    const lifecycle = createLifecycle()
    const poolInstalls: string[] = []

    await expect(
      persistCodexOAuthLogin(
        tokens(),
        { operationId: 'login-total-failure' },
        {
          lifecycle,
          readProfileInventory: emptyInventory,
          saveVault: () => null,
          saveConfig: () => false,
          installPoolAccount(received) {
            poolInstalls.push(received.accountId)
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'credentials_not_persisted' })

    expect(poolInstalls).toEqual([])
    expect(lifecycle.read(ACCOUNT_ID)).toMatchObject({
      status: 'valid',
      record: { state: 'login_prepared' },
    })
  })

  test('relogin of a signed-out identity preserves its alias and advances generation', async () => {
    const lifecycle = createLifecycle()
    const signedOut = await establishSignedOut(lifecycle)
    const vaultDirectory = createVaultDirectory()
    let installedAlias: string | undefined
    let vaultFilePath: string | undefined
    const inventory: CodexProfileInventory = {
      accounts: [],
      signedOutProfiles: [
        signedOutProfile(ACCOUNT_ID, 'former-main', signedOut),
      ],
      duplicateVaultIdentities: [],
    }

    const result = await persistCodexOAuthLogin(
      tokens(),
      {
        operationId: 'login-signed-out-relink',
        expectedAccountId: ACCOUNT_ID,
      },
      {
        lifecycle,
        readProfileInventory: () => inventory,
        saveVault: (received, options) => {
          vaultFilePath = options?.filePath
          return vaultWriter(vaultDirectory)(received, options)
        },
        saveConfig: () => true,
        installPoolAccount(received) {
          installedAlias = received.alias
        },
      },
    )

    expect(result).toMatchObject({
      credentialGeneration: 3,
      alias: 'former-main',
    })
    expect(installedAlias).toBe('former-main')
    expect(vaultFilePath).toBe(`/tmp/${ACCOUNT_ID}.json`)
    expect(lifecycle.read(ACCOUNT_ID)).toMatchObject({
      status: 'valid',
      record: { state: 'credentialed', credentialGeneration: 3 },
    })
  })

  test('a valid replacement alias overrides the signed-out profile alias', async () => {
    const lifecycle = createLifecycle()
    const signedOut = await establishSignedOut(lifecycle)
    const vaultDirectory = createVaultDirectory()
    const inventory: CodexProfileInventory = {
      accounts: [],
      signedOutProfiles: [
        signedOutProfile(ACCOUNT_ID, 'former-main', signedOut),
      ],
      duplicateVaultIdentities: [],
    }
    let installedAlias: string | undefined

    const result = await persistCodexOAuthLogin(
      tokens(),
      {
        operationId: 'login-signed-out-replacement',
        alias: 'new-main',
        expectedAccountId: ACCOUNT_ID,
      },
      {
        lifecycle,
        readProfileInventory: () => inventory,
        saveVault: vaultWriter(vaultDirectory),
        saveConfig: () => true,
        installPoolAccount(received) {
          installedAlias = received.alias
        },
      },
    )

    expect(result.alias).toBe('new-main')
    expect(installedAlias).toBe('new-main')
  })

  test('rejects a targeted relink identity mismatch without changing the original tombstone', async () => {
    const lifecycle = createLifecycle()
    const signedOut = await establishSignedOut(lifecycle)
    const writes: string[] = []
    const inventory: CodexProfileInventory = {
      accounts: [],
      signedOutProfiles: [
        signedOutProfile(ACCOUNT_ID, 'do-not-transfer', signedOut),
      ],
      duplicateVaultIdentities: [],
    }

    await expect(
      persistCodexOAuthLogin(
        tokens(OTHER_ACCOUNT_ID),
        {
          operationId: 'login-targeted-mismatch',
          expectedAccountId: ACCOUNT_ID,
        },
        {
          lifecycle,
          readProfileInventory: () => inventory,
          saveVault: () => {
            writes.push('vault')
            return null
          },
          saveConfig: () => {
            writes.push('config')
            return false
          },
          installPoolAccount: () => {
            writes.push('pool')
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'identity_mismatch' })

    expect(writes).toEqual([])
    expect(lifecycle.read(ACCOUNT_ID)).toMatchObject({
      status: 'valid',
      record: {
        state: 'signed_out',
        credentialGeneration: signedOut.credentialGeneration,
      },
    })
  })

  test('a new login supersedes an interrupted prepared operation', async () => {
    const lifecycle = createLifecycle()
    const vaultDirectory = createVaultDirectory()
    const firstVaultWriter = vaultWriter(vaultDirectory, [], 'failed')

    await expect(
      persistCodexOAuthLogin(
        tokens(),
        { operationId: 'login-interrupted' },
        {
          lifecycle,
          readProfileInventory: emptyInventory,
          saveVault: firstVaultWriter,
          saveConfig: () => false,
        },
      ),
    ).rejects.toMatchObject({ code: 'credentials_not_persisted' })
    expect(lifecycle.read(ACCOUNT_ID)).toMatchObject({
      status: 'valid',
      record: { state: 'login_prepared', credentialGeneration: 1 },
    })

    const replacement = await persistCodexOAuthLogin(
      tokens(),
      { operationId: 'login-replacement' },
      {
        lifecycle,
        readProfileInventory: emptyInventory,
        saveVault: vaultWriter(vaultDirectory),
        saveConfig: () => true,
        installPoolAccount() {},
      },
    )

    expect(replacement.credentialGeneration).toBe(2)
    expect(lifecycle.read(ACCOUNT_ID)).toMatchObject({
      status: 'valid',
      record: {
        state: 'credentialed',
        credentialGeneration: 2,
        operationId: 'login-replacement',
      },
    })
    const reloaded = loadCodexProfileInventoryForTest(vaultDirectory, {
      lifecycle,
    })
    expect(reloaded.accounts[0]?.credentialGeneration).toBe(2)
  })
})
