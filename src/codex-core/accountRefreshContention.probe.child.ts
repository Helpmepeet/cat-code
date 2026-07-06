/**
 * DR-2 contention probe — CHILD HARNESS (not a test; spawned as a real OS
 * process by accountRefreshContention.probe.test.ts).
 *
 * Each child is "one engine process" at the token-refresh boundary: it runs the
 * REAL refresh-and-persist code (`resolveCodexCoreAccount` → `maybeRefreshAccount`
 * for the config branch; `refreshAccountTokens` for the vault branch) against an
 * isolated HOME/CLAUDE_CONFIG_DIR and a parent-owned mock OAuth endpoint. Only
 * the network destination is substituted (globalThis.fetch redirect); every
 * read/refresh/persist instruction is engine code.
 *
 * Env contract (set by the parent test):
 *   PROBE_MODE          seed-config | read-config | contend-config | contend-vault
 *   PROBE_TOKEN_URL     mock OAuth token endpoint (replaces auth.openai.com)
 *   PROBE_GO_FILE       barrier file; contend-* modes block until it exists
 *   PROBE_ACCOUNT_ID    the account under contention
 *   PROBE_REFRESH_TOKEN seed refresh token (seed-config / contend-vault)
 *   PROBE_ACCESS_TOKEN  seed access token (seed-config)
 *   PROBE_EXPIRES_AT    seed expiry ms (seed-config)
 *   PROBE_VAULT_FILE    vault account file path (contend-vault)
 *
 * Prints exactly one `RESULT:{json}` line on stdout.
 *
 * MUST run with NODE_ENV != 'test': under 'test' the engine's GlobalConfig
 * reads/writes are in-memory (TEST_GLOBAL_CONFIG_FOR_TESTING) and no
 * cross-process persistence exists to contend over.
 */

/* eslint-disable no-console */

// Mirror app/sidecar/initializeRuntime.ts: dev-run engine modules read MACRO.
if (typeof MACRO === 'undefined') {
  ;(globalThis as Record<string, unknown>).MACRO = {
    VERSION: '0.0.0-refresh-probe',
    BUILD_TIME: new Date().toISOString(),
    PACKAGE_URL: 'claude-code-source-snapshot',
    FEEDBACK_CHANNEL: 'github',
  }
}

const TOKEN_HOST_MARKER = 'auth.openai.com/oauth/token'

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

/**
 * Redirect the OAuth token endpoint to the parent's mock server and FAIL
 * CLOSED on every other URL — probe children must never reach the real
 * network (engine bootstrap fires background requests, e.g. the pool's usage
 * fetch toward chatgpt.com; codexUsage.ts). Both real refresh clients hit the
 * token endpoint via global fetch at call time:
 *   - src/services/oauth/codex-client.ts postToTokenUrl (CODEX_TOKEN_URL)
 *   - src/services/api/codexTokenRefresh.ts refreshAccountTokens (CODEX_TOKEN_URL)
 */
function patchFetch(mockUrl: string): void {
  const realFetch = globalThis.fetch.bind(globalThis)
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url
    if (url.includes(TOKEN_HOST_MARKER)) {
      return realFetch(mockUrl, init)
    }
    if (url.startsWith(mockUrl)) {
      return realFetch(input as Parameters<typeof fetch>[0], init)
    }
    process.stderr.write(`[probe-child] blocked non-mock fetch: ${url}\n`)
    return Promise.resolve(
      new Response('probe: external network blocked', { status: 503 }),
    )
  }) as typeof fetch
}

async function waitForGoFile(goFile: string): Promise<void> {
  const { existsSync } = await import('fs')
  const start = Date.now()
  while (!existsSync(goFile)) {
    if (Date.now() - start > 20_000) {
      throw new Error('timed out waiting for go file')
    }
    await Bun.sleep(10)
  }
}

function printResult(result: Record<string, unknown>): void {
  console.log(`RESULT:${JSON.stringify(result)}`)
}

async function main(): Promise<void> {
  const mode = requireEnv('PROBE_MODE')

  const { enableConfigs } = await import('../utils/config.js')
  enableConfigs()

  if (mode === 'seed-config') {
    const { saveCodexOAuthTokens } = await import('../utils/auth.js')
    saveCodexOAuthTokens({
      accessToken: requireEnv('PROBE_ACCESS_TOKEN'),
      refreshToken: requireEnv('PROBE_REFRESH_TOKEN'),
      expiresAt: Number(requireEnv('PROBE_EXPIRES_AT')),
      accountId: requireEnv('PROBE_ACCOUNT_ID'),
    })
    printResult({ ok: true })
    return
  }

  if (mode === 'read-config') {
    const { getCodexOAuthTokens } = await import('../utils/auth.js')
    printResult({ ok: true, tokens: getCodexOAuthTokens() })
    return
  }

  patchFetch(requireEnv('PROBE_TOKEN_URL'))
  const goFile = requireEnv('PROBE_GO_FILE')

  if (mode === 'contend-config') {
    // The real codex-core resolution path: pool init imports the config-file
    // account (source 'config', no vaultFilePath), so maybeRefreshAccount takes
    // the raw refreshCodexToken → saveCodexOAuthTokens branch under contention.
    const { resolveCodexCoreAccount } = await import('./accounts.js')
    const { writeFileSync } = await import('fs')
    writeFileSync(`${goFile}.ready.${process.pid}`, '1')
    await waitForGoFile(goFile)
    try {
      const account = await resolveCodexCoreAccount(requireEnv('PROBE_ACCOUNT_ID'))
      printResult({
        ok: true,
        accountId: account.accountId,
        accessToken: account.accessToken,
        refreshToken: account.refreshToken,
      })
    } catch (error) {
      printResult({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
    return
  }

  if (mode === 'contend-vault') {
    // The pool/vault path Phase-3 dogfooding exercises on a 401: the stateful
    // refreshAccountTokens with its proper-lockfile + concurrent recovery.
    const { refreshAccountTokens } = await import(
      '../services/api/codexTokenRefresh.js'
    )
    const { writeFileSync } = await import('fs')
    writeFileSync(`${goFile}.ready.${process.pid}`, '1')
    await waitForGoFile(goFile)
    try {
      const refreshed = await refreshAccountTokens(
        requireEnv('PROBE_ACCOUNT_ID'),
        requireEnv('PROBE_REFRESH_TOKEN'),
        requireEnv('PROBE_VAULT_FILE'),
      )
      printResult({
        ok: true,
        accountId: refreshed.accountId,
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        status: refreshed.status,
      })
    } catch (error) {
      printResult({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
    return
  }

  throw new Error(`unknown PROBE_MODE: ${mode}`)
}

void main().catch(error => {
  printResult({
    ok: false,
    error: error instanceof Error ? (error.stack ?? error.message) : String(error),
  })
  process.exit(1)
})
