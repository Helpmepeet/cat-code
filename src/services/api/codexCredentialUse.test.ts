import { afterEach, describe, expect, test } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  authorizeCodexCredentialUse,
  createCodexCredentialHandle,
  startCodexCredentialSend,
  type CodexCredentialHandle,
} from './codexCredentialUse.js'
import {
  getPoolStatus,
  resetCodexAccountPoolForTest,
} from './codexAccountPool.js'
import {
  createCodexCredentialLifecycle,
  type CodexCredentialLifecycle,
} from './codexCredentialLifecycle.js'

const ACCOUNT_ID = 'credential-use-account'
const ACCESS_TOKEN = 'access-token-must-not-appear-in-errors'
const REFRESH_TOKEN = 'refresh-token-must-not-appear-in-errors'
const scratchDirectories: string[] = []

function createScratch(): string {
  const directory = mkdtempSync(join(tmpdir(), 'codex-credential-use-'))
  scratchDirectories.push(directory)
  return directory
}

function createLifecycle(directory: string): CodexCredentialLifecycle {
  return createCodexCredentialLifecycle({
    directory: join(directory, 'lifecycle'),
  })
}

function createHandle(
  directory: string,
  credentialGeneration = 1,
): CodexCredentialHandle {
  return createCodexCredentialHandle({
    accountId: ACCOUNT_ID,
    accessToken: ACCESS_TOKEN,
    refreshToken: REFRESH_TOKEN,
    expiresAt: 1_900_000_000_000,
    credentialGeneration,
    credentialSource: 'vault',
    credentialPath: join(directory, 'account.json'),
  })
}

async function establishCredentialed(
  lifecycle: CodexCredentialLifecycle,
  generation = 1,
): Promise<void> {
  for (let nextGeneration = 1; nextGeneration <= generation; nextGeneration++) {
    await lifecycle.withTransaction(
      ACCOUNT_ID,
      {
        operationKind: 'login',
        operationId: `login-${nextGeneration}`,
      },
      permit => {
        const prepared = lifecycle.prepareLogin(permit)
        expect(prepared.status).toBe('applied')
        if (prepared.status !== 'applied') throw new Error('login prepare failed')
        expect(prepared.record.credentialGeneration).toBe(nextGeneration)
        const committed = lifecycle.commitLogin(permit, {
          expectedGeneration: prepared.record.credentialGeneration,
        })
        expect(committed.status).toBe('applied')
      },
    )
  }
}

function writeVault(
  path: string,
  generation?: number,
  accessToken = ACCESS_TOKEN,
): void {
  writeFileSync(
    path,
    `${JSON.stringify({
      version: 1,
      account_id: ACCOUNT_ID,
      profile_state: 'credentialed',
      metadata: { preserved: true },
      tokens: {
        access_token: accessToken,
        refresh_token: REFRESH_TOKEN,
        expires_at: 1_900_000_000_000,
        account_id: ACCOUNT_ID,
        ...(generation === undefined
          ? {}
          : { credential_generation: generation }),
      },
    }, null, 2)}\n`,
    'utf8',
  )
}

function readVault(path: string): {
  metadata?: { preserved?: boolean }
  tokens: { credential_generation?: number; access_token: string }
} {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}

afterEach(() => {
  resetCodexAccountPoolForTest()
  for (const directory of scratchDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('Codex credential use authorization', () => {
  test('an exact positive binding starts the send', async () => {
    const directory = createScratch()
    const lifecycle = createLifecycle(directory)
    await establishCredentialed(lifecycle)
    const handle = createHandle(directory)
    let sends = 0

    const result = await startCodexCredentialSend(
      handle,
      authorized => {
        sends++
        expect(authorized).toBe(handle)
        return Promise.resolve('sent')
      },
      { lifecycle },
    )

    expect(result).toBe('sent')
    expect(sends).toBe(1)
  })

  test('signed-out, malformed, missing, unreadable, and mismatched lifecycle state start no send', async () => {
    const cases: Array<{
      name: string
      setup: (lifecycle: CodexCredentialLifecycle) => Promise<void> | void
      expectedCode: string
    }> = [
      {
        name: 'signed-out',
        setup: async lifecycle => {
          await establishCredentialed(lifecycle)
          await lifecycle.withTransaction(
            ACCOUNT_ID,
            { operationKind: 'sign_out', operationId: 'sign-out' },
            permit => lifecycle.signOut(permit, { expectedGeneration: 1 }),
          )
        },
        expectedCode: 'state_mismatch',
      },
      {
        name: 'malformed',
        setup: lifecycle => {
          const paths = lifecycle.getPaths(ACCOUNT_ID)
          mkdirSync(paths.directory, { recursive: true })
          writeFileSync(paths.recordPath, '{not-json', 'utf8')
        },
        expectedCode: 'malformed',
      },
      {
        name: 'missing',
        setup: () => {},
        expectedCode: 'missing',
      },
      {
        name: 'unreadable',
        setup: lifecycle => {
          const paths = lifecycle.getPaths(ACCOUNT_ID)
          mkdirSync(paths.recordPath, { recursive: true })
        },
        expectedCode: 'unreadable',
      },
      {
        name: 'generation-mismatch',
        setup: lifecycle => establishCredentialed(lifecycle, 2),
        expectedCode: 'generation_mismatch',
      },
    ]

    for (const testCase of cases) {
      const directory = createScratch()
      const lifecycle = createLifecycle(directory)
      await testCase.setup(lifecycle)
      let sends = 0

      await expect(
        startCodexCredentialSend(
          createHandle(directory),
          () => {
            sends++
            return Promise.resolve('sent')
          },
          { lifecycle },
        ),
      ).rejects.toMatchObject({ code: testCase.expectedCode })
      expect(sends, testCase.name).toBe(0)
    }
  })

  test('send initiation releases the lifecycle lock before the response settles', async () => {
    const directory = createScratch()
    const lifecycle = createLifecycle(directory)
    await establishCredentialed(lifecycle)
    const response = deferred<string>()
    const started = deferred<void>()

    const send = startCodexCredentialSend(
      createHandle(directory),
      () => {
        started.resolve()
        return response.promise
      },
      { lifecycle },
    )
    await started.promise

    let signedOut = false
    await lifecycle.withTransaction(
      ACCOUNT_ID,
      { operationKind: 'sign_out', operationId: 'sign-out-after-send' },
      permit => {
        const result = lifecycle.signOut(permit, { expectedGeneration: 1 })
        expect(result.status).toBe('applied')
        signedOut = true
      },
    )
    expect(signedOut).toBe(true)

    response.resolve('finished')
    expect(await send).toBe('finished')
  })

  test('sign-out that holds the lock first prevents a queued send from starting', async () => {
    const directory = createScratch()
    const lifecycle = createLifecycle(directory)
    await establishCredentialed(lifecycle)
    const holding = deferred<void>()
    const releaseSignOut = deferred<void>()
    let sends = 0

    const signOut = lifecycle.withTransaction(
      ACCOUNT_ID,
      { operationKind: 'sign_out', operationId: 'sign-out-first' },
      async permit => {
        holding.resolve()
        await releaseSignOut.promise
        const result = lifecycle.signOut(permit, { expectedGeneration: 1 })
        expect(result.status).toBe('applied')
      },
    )
    await holding.promise

    const send = startCodexCredentialSend(
      createHandle(directory),
      () => {
        sends++
        return Promise.resolve('sent')
      },
      { lifecycle },
    )
    await Promise.resolve()
    expect(sends).toBe(0)

    releaseSignOut.resolve()
    await signOut
    await expect(send).rejects.toMatchObject({ code: 'state_mismatch' })
    expect(sends).toBe(0)
  })

  test('legacy use tags the same durable vault and returns a new generation-one handle', async () => {
    const directory = createScratch()
    const lifecycle = createLifecycle(directory)
    const legacy = createHandle(directory, 0)
    writeVault(legacy.credentialPath)

    const authorized = await authorizeCodexCredentialUse(legacy, { lifecycle })

    expect(authorized).not.toBe(legacy)
    expect(authorized).toEqual({
      ...legacy,
      credentialGeneration: 1,
    })
    expect(legacy.credentialGeneration).toBe(0)
    expect(Object.isFrozen(legacy)).toBe(true)
    expect(Object.isFrozen(authorized)).toBe(true)
    expect(readVault(legacy.credentialPath)).toMatchObject({
      metadata: { preserved: true },
      tokens: {
        access_token: ACCESS_TOKEN,
        credential_generation: 1,
      },
    })
    expect(lifecycle.read(ACCOUNT_ID)).toMatchObject({
      status: 'valid',
      record: {
        state: 'credentialed',
        credentialGeneration: 1,
        operationKind: 'legacy_bootstrap',
      },
    })
    expect(getPoolStatus().accounts).toContainEqual(
      expect.objectContaining({
        accountId: ACCOUNT_ID,
        accessToken: ACCESS_TOKEN,
        credentialGeneration: 1,
        credentialGenerationState: 'lifecycle_bound',
        source: 'vault',
        vaultFilePath: legacy.credentialPath,
      }),
    )
  })

  test('tagged credentials with absent lifecycle are denied instead of bootstrapped', async () => {
    const directory = createScratch()
    const lifecycle = createLifecycle(directory)
    const tagged = createHandle(directory, 1)
    writeVault(tagged.credentialPath, 1)

    await expect(
      authorizeCodexCredentialUse(tagged, { lifecycle }),
    ).rejects.toMatchObject({ code: 'missing' })
    expect(readVault(tagged.credentialPath).tokens.credential_generation).toBe(1)
  })

  test('a retained generation-one handle cannot send or be relabelled after generation three login', async () => {
    const directory = createScratch()
    const lifecycle = createLifecycle(directory)
    await establishCredentialed(lifecycle, 3)
    const retained = createHandle(directory, 1)
    writeVault(retained.credentialPath, 1)
    let sends = 0

    await expect(
      startCodexCredentialSend(
        retained,
        () => {
          sends++
          return Promise.resolve('sent')
        },
        { lifecycle },
      ),
    ).rejects.toMatchObject({ code: 'generation_mismatch' })

    expect(sends).toBe(0)
    expect(retained.credentialGeneration).toBe(1)
    expect(readVault(retained.credentialPath).tokens.credential_generation).toBe(1)
  })

  test('legacy bootstrap refuses a changed store and never leaks token text', async () => {
    const directory = createScratch()
    const lifecycle = createLifecycle(directory)
    const retained = createHandle(directory, 0)
    writeVault(retained.credentialPath, undefined, 'replacement-access')

    let thrown: unknown
    try {
      await authorizeCodexCredentialUse(retained, { lifecycle })
    } catch (error) {
      thrown = error
    }

    expect(thrown).toMatchObject({ code: 'profile_mismatch' })
    expect(String(thrown)).not.toContain(ACCESS_TOKEN)
    expect(String(thrown)).not.toContain(REFRESH_TOKEN)
    expect(readVault(retained.credentialPath).tokens.credential_generation).toBeUndefined()
    expect(lifecycle.read(ACCOUNT_ID)).toEqual({ status: 'absent' })
  })

  test('vault handles require their authoritative profile path', () => {
    expect(() =>
      createCodexCredentialHandle({
        accountId: ACCOUNT_ID,
        accessToken: ACCESS_TOKEN,
        refreshToken: REFRESH_TOKEN,
        expiresAt: 1_900_000_000_000,
        credentialGeneration: 0,
        credentialSource: 'vault',
      }),
    ).toThrow('binding is invalid')
  })
})
