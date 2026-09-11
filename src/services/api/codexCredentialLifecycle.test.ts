import { afterEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { basename, join } from 'path'
import {
  CodexCredentialLifecycleError,
  createCodexCredentialLifecycle,
  type CodexCredentialBinding,
  type CodexCredentialLifecycle,
  type CodexCredentialLifecycleRecord,
  type CodexCredentialLifecycleTransitionResult,
} from './codexCredentialLifecycle.js'

const ACCOUNT_ID = 'ca11ab1e-0000-4000-8000-0000000000c1'
const OTHER_ACCOUNT_ID = 'ca11ab1e-0000-4000-8000-0000000000c3'
const scratchDirectories: string[] = []

function createStore(): CodexCredentialLifecycle {
  const directory = mkdtempSync(join(tmpdir(), 'codex-credential-lifecycle-'))
  scratchDirectories.push(directory)
  return createCodexCredentialLifecycle({ directory })
}

function appliedRecord(
  result: CodexCredentialLifecycleTransitionResult,
): CodexCredentialLifecycleRecord {
  expect(result.status).toBe('applied')
  if (result.status !== 'applied') {
    throw new Error('expected an applied lifecycle transition')
  }
  return result.record
}

async function establishCredentialed(
  store: CodexCredentialLifecycle,
  accountId = ACCOUNT_ID,
  operationId = `login-${accountId}`,
): Promise<CodexCredentialLifecycleRecord> {
  let committed: CodexCredentialLifecycleRecord | undefined
  await store.withTransaction(
    accountId,
    { operationKind: 'login', operationId },
    permit => {
      const prepared = appliedRecord(store.prepareLogin(permit))
      expect(prepared.credentialGeneration).toBe(1)
      committed = appliedRecord(
        store.commitLogin(permit, {
          expectedGeneration: prepared.credentialGeneration,
        }),
      )
    },
  )
  if (!committed) throw new Error('login did not commit')
  return committed
}

function validRecord(
  store: CodexCredentialLifecycle,
  accountId = ACCOUNT_ID,
): CodexCredentialLifecycleRecord {
  const result = store.read(accountId)
  expect(result.status).toBe('valid')
  if (result.status !== 'valid') {
    throw new Error('expected a valid lifecycle record')
  }
  return result.record
}

afterEach(() => {
  for (const directory of scratchDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('Codex credential lifecycle authority', () => {
  test('reports absence and keeps account paths inside the lifecycle directory', () => {
    const store = createStore()
    const accountId = '../../outside/credential'
    const paths = store.getPaths(accountId)

    expect(paths.directory).toBe(paths.recordPath.slice(0, -basename(paths.recordPath).length - 1))
    expect(paths.recordPath.startsWith(`${paths.directory}/`)).toBe(true)
    expect(basename(paths.recordPath)).not.toContain('..')
    expect(paths.lockPath).toBe(`${paths.recordPath}.lock`)
    expect(store.read(accountId)).toEqual({ status: 'absent' })
  })

  test('legacy bootstrap creates generation one only with an explicit assertion', async () => {
    const store = createStore()

    await expect(
      store.withTransaction(
        ACCOUNT_ID,
        { operationKind: 'legacy_bootstrap', operationId: 'legacy-rejected' },
        permit =>
          store.legacyBootstrap(permit, {
            validatedUntaggedLegacyCredentials: false as never,
          }),
      ),
    ).rejects.toMatchObject({
      name: 'CodexCredentialLifecycleError',
      code: 'invalid_transition',
    })
    expect(store.read(ACCOUNT_ID)).toEqual({ status: 'absent' })

    let bootstrapped: CodexCredentialLifecycleRecord | undefined
    await store.withTransaction(
      ACCOUNT_ID,
      { operationKind: 'legacy_bootstrap', operationId: 'legacy-accepted' },
      permit => {
        bootstrapped = appliedRecord(
          store.legacyBootstrap(permit, {
            validatedUntaggedLegacyCredentials: true,
          }),
        )
      },
    )

    expect(bootstrapped).toMatchObject({
      accountId: ACCOUNT_ID,
      credentialGeneration: 1,
      state: 'credentialed',
      operationId: 'legacy-accepted',
      operationKind: 'legacy_bootstrap',
    })
    expect(validRecord(store).cleanup).toBeUndefined()

    await store.withTransaction(
      ACCOUNT_ID,
      { operationKind: 'legacy_bootstrap', operationId: 'legacy-again' },
      permit => {
        const result = store.legacyBootstrap(permit, {
          validatedUntaggedLegacyCredentials: true,
        })
        expect(result.status).toBe('superseded')
      },
    )
    expect(validRecord(store).credentialGeneration).toBe(1)
  })

  test('first login prepares and commits credentialed generation one under one permit', async () => {
    const store = createStore()
    let prepared: CodexCredentialLifecycleRecord | undefined
    let committed: CodexCredentialLifecycleRecord | undefined

    await store.withTransaction(
      ACCOUNT_ID,
      { operationKind: 'login', operationId: 'login-first' },
      permit => {
        prepared = appliedRecord(store.prepareLogin(permit))
        expect(prepared.state).toBe('login_prepared')
        expect(prepared.credentialGeneration).toBe(1)
        committed = appliedRecord(
          store.commitLogin(permit, {
            expectedGeneration: prepared.credentialGeneration,
          }),
        )
      },
    )

    expect(committed).toMatchObject({
      accountId: ACCOUNT_ID,
      credentialGeneration: 1,
      state: 'credentialed',
      operationId: 'login-first',
      operationKind: 'login',
    })
    expect(validRecord(store).state).toBe('credentialed')
  })

  test('an interrupted login remains denied and cannot be committed by another permit', async () => {
    const store = createStore()
    let prepared: CodexCredentialLifecycleRecord | undefined

    await store.withTransaction(
      ACCOUNT_ID,
      { operationKind: 'login', operationId: 'login-interrupted' },
      permit => {
        prepared = appliedRecord(store.prepareLogin(permit))
      },
    )
    expect(prepared?.state).toBe('login_prepared')
    expect(validRecord(store).state).toBe('login_prepared')

    await store.withTransaction(
      ACCOUNT_ID,
      { operationKind: 'login', operationId: 'login-interrupted' },
      permit => {
        const result = store.commitLogin(permit, {
          expectedGeneration: prepared!.credentialGeneration,
        })
        expect(result).toMatchObject({
          status: 'superseded',
          reason: 'permit_mismatch',
        })
      },
    )
    expect(validRecord(store).state).toBe('login_prepared')

    await store.withTransaction(
      ACCOUNT_ID,
      { operationKind: 'refresh', operationId: 'recovery-no-promote' },
      permit => {
        expect(store.recover(permit)).toEqual({
          status: 'no_action',
          record: validRecord(store),
        })
      },
    )
    expect(validRecord(store).state).toBe('login_prepared')
  })

  test('malformed state is distinguishable, fails closed, and does not expose file contents', async () => {
    const store = createStore()
    const paths = store.getPaths(ACCOUNT_ID)
    mkdirSync(paths.directory, { recursive: true })
    const secretLookingValue = 'access-token-must-not-appear'
    writeFileSync(
      paths.recordPath,
      `{"version":1,"accountId":"${ACCOUNT_ID}","unexpected":"${secretLookingValue}"}`,
      'utf8',
    )

    expect(store.read(ACCOUNT_ID)).toEqual({ status: 'malformed' })
    await expect(
      store.withTransaction(
        ACCOUNT_ID,
        { operationKind: 'login', operationId: 'malformed-read' },
        permit => store.prepareLogin(permit),
      ),
    ).rejects.toMatchObject({
      name: 'CodexCredentialLifecycleError',
      code: 'malformed_state',
    })
    try {
      await store.withTransaction(
        ACCOUNT_ID,
        { operationKind: 'login', operationId: 'malformed-read-again' },
        permit => store.prepareLogin(permit),
      )
    } catch (error) {
      expect(error).toBeInstanceOf(CodexCredentialLifecycleError)
      expect((error as Error).message).not.toContain(secretLookingValue)
    }
  })

  test('unreadable state is not treated as absent', async () => {
    const store = createStore()
    const paths = store.getPaths(ACCOUNT_ID)
    mkdirSync(paths.recordPath, { recursive: true })

    expect(store.read(ACCOUNT_ID)).toEqual({ status: 'unreadable' })
    await expect(
      store.withTransaction(
        ACCOUNT_ID,
        { operationKind: 'login', operationId: 'unreadable-read' },
        permit => store.prepareLogin(permit),
      ),
    ).rejects.toMatchObject({
      name: 'CodexCredentialLifecycleError',
      code: 'unreadable_state',
    })
  })

  test('persists records atomically and leaves no staging files', async () => {
    const store = createStore()

    await establishCredentialed(store)
    const paths = store.getPaths(ACCOUNT_ID)
    const raw = readFileSync(paths.recordPath, 'utf8')
    const parsed = JSON.parse(raw) as Record<string, unknown>

    expect(raw.endsWith('\n')).toBe(true)
    expect(parsed).toMatchObject({
      version: 1,
      accountId: ACCOUNT_ID,
      credentialGeneration: 1,
      state: 'credentialed',
    })
    expect(Object.keys(parsed)).toEqual([
      'version',
      'accountId',
      'credentialGeneration',
      'state',
      'operationId',
      'operationKind',
      'changedAt',
    ])
    expect(readdirSync(paths.directory)).toEqual([basename(paths.recordPath)])
  })

  test('sign-out advances the generation and same-operation cleanup is compare-and-set', async () => {
    const store = createStore()
    await establishCredentialed(store)

    let signedOut: CodexCredentialLifecycleRecord | undefined
    let cleanup: CodexCredentialLifecycleRecord | undefined
    await store.withTransaction(
      ACCOUNT_ID,
      { operationKind: 'sign_out', operationId: 'signout-one' },
      permit => {
        signedOut = appliedRecord(
          store.signOut(permit, { expectedGeneration: 1 }),
        )
        expect(signedOut).toMatchObject({
          credentialGeneration: 2,
          state: 'signed_out',
          operationId: 'signout-one',
          operationKind: 'sign_out',
          cleanup: 'pending',
        })
        cleanup = appliedRecord(
          store.completeCleanup(permit, {
            accountId: ACCOUNT_ID,
            credentialGeneration: signedOut.credentialGeneration,
            operationId: signedOut.operationId,
          }),
        )
      },
    )

    expect(cleanup).toMatchObject({
      accountId: ACCOUNT_ID,
      credentialGeneration: 2,
      state: 'signed_out',
      operationId: 'signout-one',
      cleanup: 'complete',
    })
    expect(validRecord(store).state).toBe('signed_out')
    expect(
      await store.withTransaction(
        ACCOUNT_ID,
        { operationKind: 'sign_out', operationId: 'signout-one' },
        permit =>
          store.completeCleanup(permit, {
            accountId: ACCOUNT_ID,
            credentialGeneration: 2,
            operationId: 'signout-one',
          }),
      ),
    ).toMatchObject({ status: 'applied', changed: false })

    await store.withTransaction(
      ACCOUNT_ID,
      { operationKind: 'sign_out', operationId: 'signout-one' },
      permit => {
        expect(
          store.completeCleanup(permit, {
            accountId: OTHER_ACCOUNT_ID,
            credentialGeneration: 2,
            operationId: 'signout-one',
          }),
        ).toMatchObject({
          status: 'superseded',
          reason: 'permit_mismatch',
        })
      },
    )
    await store.withTransaction(
      ACCOUNT_ID,
      { operationKind: 'sign_out', operationId: 'different-operation' },
      permit => {
        expect(
          store.completeCleanup(permit, {
            accountId: ACCOUNT_ID,
            credentialGeneration: 2,
            operationId: 'signout-one',
          }),
        ).toMatchObject({
          status: 'superseded',
          reason: 'operation_mismatch',
        })
      },
    )
    expect(validRecord(store)).toEqual(cleanup)
  })

  test('stale cleanup after a newer login is superseded without changing the newer generation', async () => {
    const store = createStore()
    await establishCredentialed(store)

    let signedOut: CodexCredentialLifecycleRecord | undefined
    await store.withTransaction(
      ACCOUNT_ID,
      { operationKind: 'sign_out', operationId: 'old-signout' },
      permit => {
        signedOut = appliedRecord(
          store.signOut(permit, { expectedGeneration: 1 }),
        )
      },
    )
    expect(signedOut?.cleanup).toBe('pending')

    let replacement: CodexCredentialLifecycleRecord | undefined
    await store.withTransaction(
      ACCOUNT_ID,
      { operationKind: 'login', operationId: 'new-login' },
      permit => {
        const prepared = appliedRecord(store.prepareLogin(permit))
        expect(prepared.credentialGeneration).toBe(3)
        replacement = appliedRecord(
          store.commitLogin(permit, {
            expectedGeneration: prepared.credentialGeneration,
          }),
        )
      },
    )

    const staleCleanup = await store.withTransaction(
      ACCOUNT_ID,
      { operationKind: 'sign_out', operationId: 'old-signout' },
      permit =>
        store.completeCleanup(permit, {
          accountId: ACCOUNT_ID,
          credentialGeneration: signedOut!.credentialGeneration,
          operationId: signedOut!.operationId,
        }),
    )
    expect(staleCleanup).toMatchObject({
      status: 'superseded',
      reason: 'generation_mismatch',
    })
    expect(validRecord(store)).toEqual(replacement)
  })

  test('reauthentication invalidates credentialed generation and advances it', async () => {
    const store = createStore()
    await establishCredentialed(store)

    let reauth: CodexCredentialLifecycleRecord | undefined
    await store.withTransaction(
      ACCOUNT_ID,
      { operationKind: 'refresh', operationId: 'refresh-requires-reauth' },
      permit => {
        reauth = appliedRecord(
          store.markReauthRequired(permit, { expectedGeneration: 1 }),
        )
      },
    )
    expect(reauth).toMatchObject({
      credentialGeneration: 2,
      state: 'reauth_required',
      operationId: 'refresh-requires-reauth',
      operationKind: 'refresh',
    })

    await store.withTransaction(
      ACCOUNT_ID,
      { operationKind: 'sign_out', operationId: 'stale-signout' },
      permit => {
        expect(
          store.signOut(permit, { expectedGeneration: 1 }),
        ).toMatchObject({
          status: 'superseded',
          reason: 'generation_mismatch',
        })
      },
    )
    expect(validRecord(store)).toEqual(reauth)
  })

  test('deleting credentialed state invalidates it before cleanup and leaves a tombstone', async () => {
    const store = createStore()
    await establishCredentialed(store)

    let deleted: CodexCredentialLifecycleRecord | undefined
    await store.withTransaction(
      ACCOUNT_ID,
      { operationKind: 'delete', operationId: 'delete-credentialed' },
      permit => {
        deleted = appliedRecord(
          store.deleteAccount(permit, { expectedGeneration: 1 }),
        )
      },
    )

    expect(deleted).toMatchObject({
      accountId: ACCOUNT_ID,
      credentialGeneration: 2,
      state: 'signed_out',
      operationId: 'delete-credentialed',
      operationKind: 'delete',
      cleanup: 'pending',
    })
    const paths = store.getPaths(ACCOUNT_ID)
    expect(existsSync(paths.recordPath)).toBe(true)

    await store.withTransaction(
      ACCOUNT_ID,
      { operationKind: 'refresh', operationId: 'recovery-delete' },
      permit => {
        expect(store.recover(permit)).toMatchObject({
          status: 'applied',
          changed: true,
        })
      },
    )
    expect(validRecord(store)).toMatchObject({
      state: 'signed_out',
      credentialGeneration: 2,
      operationKind: 'delete',
      cleanup: 'complete',
    })
    expect(existsSync(paths.recordPath)).toBe(true)
  })

  test('deleting signed-out state preserves the existing denial tombstone', async () => {
    const store = createStore()
    await establishCredentialed(store)

    let signedOut: CodexCredentialLifecycleRecord | undefined
    await store.withTransaction(
      ACCOUNT_ID,
      { operationKind: 'sign_out', operationId: 'preserved-signout' },
      permit => {
        signedOut = appliedRecord(
          store.signOut(permit, { expectedGeneration: 1 }),
        )
      },
    )

    let deletionResult: CodexCredentialLifecycleTransitionResult | undefined
    await store.withTransaction(
      ACCOUNT_ID,
      { operationKind: 'delete', operationId: 'delete-already-denied' },
      permit => {
        deletionResult = store.deleteAccount(permit, {
          expectedGeneration: signedOut!.credentialGeneration,
        })
      },
    )

    expect(deletionResult).toEqual({
      status: 'no_action',
      record: signedOut,
    })
    expect(validRecord(store)).toEqual(signedOut)
  })

  test('recovery completes only pending denial cleanup and never promotes another state', async () => {
    const store = createStore()

    await establishCredentialed(store)
    await store.withTransaction(
      ACCOUNT_ID,
      { operationKind: 'sign_out', operationId: 'recover-signout' },
      permit => {
        store.signOut(permit, { expectedGeneration: 1 })
      },
    )
    await store.withTransaction(
      ACCOUNT_ID,
      { operationKind: 'refresh', operationId: 'recover-pending' },
      permit => {
        expect(store.recover(permit)).toMatchObject({
          status: 'applied',
          changed: true,
        })
      },
    )
    expect(validRecord(store).cleanup).toBe('complete')

    const secondStore = createStore()
    await secondStore.withTransaction(
      ACCOUNT_ID,
      { operationKind: 'login', operationId: 'recover-login' },
      permit => {
        secondStore.prepareLogin(permit)
      },
    )
    const before = validRecord(secondStore)
    await secondStore.withTransaction(
      ACCOUNT_ID,
      { operationKind: 'refresh', operationId: 'recover-must-not-promote' },
      permit => {
        expect(secondStore.recover(permit)).toEqual({
          status: 'no_action',
          record: before,
        })
      },
    )
    expect(validRecord(secondStore)).toEqual(before)
  })

  test('permits expire when their transaction ends', async () => {
    const store = createStore()
    let expiredPermit:
      | Parameters<CodexCredentialLifecycle['prepareLogin']>[0]
      | undefined
    await store.withTransaction(
      ACCOUNT_ID,
      { operationKind: 'login', operationId: 'expired-permit' },
      permit => {
        expiredPermit = permit
      },
    )

    expect(() => store.prepareLogin(expiredPermit!)).toThrow(
      'invalid or expired',
    )
    expect(store.read(ACCOUNT_ID)).toEqual({ status: 'absent' })
  })

  test('account generation advances independently of credential storage', async () => {
    const store = createStore()
    const record = await establishCredentialed(store)
    const binding: CodexCredentialBinding = {
      accountId: record.accountId,
      credentialGeneration: record.credentialGeneration,
    }

    expect(binding).toEqual({
      accountId: ACCOUNT_ID,
      credentialGeneration: 1,
    })
    expect(store.getPaths(ACCOUNT_ID).recordPath).not.toContain('vault')
  })
})
