import { afterAll, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const ACCOUNT_ID = 'codex-core-static-account'
const configDirectory = mkdtempSync(join(tmpdir(), 'codex-core-client-'))
const previousConfigDirectory = process.env.CLAUDE_CONFIG_DIR
process.env.CLAUDE_CONFIG_DIR = configDirectory
const realAccounts = await import('./accounts.js')

const account = {
  accountId: ACCOUNT_ID,
  accessToken: 'static-access-token',
  refreshToken: 'static-refresh-token',
  expiresAt: Date.now() + 60 * 60_000,
  credentialGeneration: 1,
  profile: 'static-profile',
  source: 'config' as const,
}

mock.module('./accounts.js', () => ({
  ...realAccounts,
  resolveCodexCoreAccount: async () => account,
}))

async function commitLogin(
  lifecycle: import('../services/api/codexCredentialLifecycle.js').CodexCredentialLifecycle,
  expectedGeneration: number,
): Promise<void> {
  await lifecycle.withTransaction(
    ACCOUNT_ID,
    {
      operationKind: 'login',
      operationId: `client-login-${expectedGeneration}`,
    },
    permit => {
      const prepared = lifecycle.prepareLogin(permit)
      if (
        prepared.status !== 'applied' ||
        prepared.record.credentialGeneration !== expectedGeneration
      ) {
        throw new Error('failed to prepare client test login')
      }
      const committed = lifecycle.commitLogin(permit, {
        expectedGeneration,
      })
      if (committed.status !== 'applied') {
        throw new Error('failed to commit client test login')
      }
    },
  )
}

afterAll(() => {
  if (previousConfigDirectory === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = previousConfigDirectory
  }
  rmSync(configDirectory, { recursive: true, force: true })
  mock.restore()
})

test('static codex-core requests use the credential generation send gate', async () => {
  const { createCodexCredentialLifecycle } = await import(
    '../services/api/codexCredentialLifecycle.js'
  )
  const lifecycle = createCodexCredentialLifecycle({
    directory: join(configDirectory, 'codex-credential-lifecycle'),
  })
  await commitLogin(lifecycle, 1)

  const originalFetch = globalThis.fetch
  let fetches = 0
  globalThis.fetch = (async () => {
    fetches++
    return new Response(
      [
        'event: response.output_text.delta',
        `data: ${JSON.stringify({
          type: 'response.output_text.delta',
          delta: 'static path sent',
        })}`,
        '',
        'event: response.completed',
        `data: ${JSON.stringify({
          type: 'response.completed',
          response: {
            id: 'resp_static_gate',
            usage: {
              input_tokens: 1,
              output_tokens: 1,
              input_tokens_details: { cached_tokens: 0 },
            },
          },
        })}`,
        '',
      ].join('\n'),
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    )
  }) as unknown as typeof globalThis.fetch

  try {
    const { runCodexLLM } = await import('./client.js')
    const result = await runCodexLLM({
      accountProfile: 'static-profile',
      model: 'gpt-5.6-luna',
      input: 'test',
      stream: false,
    })
    expect(result.text).toBe('static path sent')
    expect(fetches).toBe(1)

    await commitLogin(lifecycle, 2)
    await commitLogin(lifecycle, 3)

    await expect(
      runCodexLLM({
        accountProfile: 'static-profile',
        model: 'gpt-5.6-luna',
        input: 'must not send',
        stream: false,
      }),
    ).rejects.toThrow('authentication failed')
    expect(fetches).toBe(1)
  } finally {
    globalThis.fetch = originalFetch
  }
})
