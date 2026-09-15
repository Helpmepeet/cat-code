/**
 * DR-2 — Cross-process Codex token-refresh contention probe (desktop-app
 * migration, Phase-3 pre-work; docs/migration/reviews/2026-07-02-direction-review.md §DR-2).
 *
 * QUESTION: N-process (one engine process per session, the P0-4 verdict) means
 * N concurrent writers to the SHARED token stores. Codex refresh ROTATES the
 * refresh token (the old one dies server-side). Do two real engine processes
 * refreshing ONE account race the rotation and strand a dead token on disk?
 *
 * THE TWO PATHS (verified against source, 2026-07-03):
 *   1. config branch — src/codex-core/accounts.ts maybeRefreshAccount: accounts
 *      with source 'config' / no vault file take refreshCodexToken (raw fetch,
 *      src/services/oauth/codex-client.ts:237) → saveCodexOAuthTokens. Note:
 *      initAccountPool imports the config-file login into the pool AS source
 *      'config' with vaultFilePath null, so this is the NORMAL path for a
 *      config-sourced account, not a rare fallback.
 *   2. vault branch — src/services/api/codexTokenRefresh.ts refreshAccountTokens:
 *      proper-lockfile on the vault file (:290) + in-process single-flight
 *      (:264) + rotated-token recovery under the lock (:309). This machinery
 *      landed 2026-06-16 (5a7b744) but had never been exercised by two REAL
 *      processes (the P0-4 caveat: "two real engines never ran concurrent work").
 *
 * WHAT THIS PROBE DOES (honest scope): spawns TWO real Bun child processes per
 * scenario (accountRefreshContention.probe.child.ts), both running the REAL
 * refresh-and-persist engine code against one isolated HOME/CLAUDE_CONFIG_DIR.
 * A file barrier releases both at once. The one substitution is the network
 * destination: a local mock OAuth endpoint with STRICT rotation semantics
 * (every refresh token is single-use; reusing a burned token → invalid_grant,
 * modeling OAuth refresh-token reuse detection). No live credential is used —
 * the race is a property of unserialized read-refresh-persist on shared files,
 * not of OpenAI's server.
 *
 * PASS CRITERIA (both scenarios): the mock endpoint sees EXACTLY ONE refresh
 * per contention (the loser must adopt the winner's persisted tokens, not burn
 * the rotation), both processes end holding the SAME live tokens, and the disk
 * store holds the rotated refresh token.
 *
 * Reproduce:  bun test src/codex-core/accountRefreshContention.probe.test.ts
 */
import { afterAll, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { basename, dirname, join } from 'path'
import { createCodexCredentialLifecycle } from '../services/api/codexCredentialLifecycle.js'

/**
 * Scenarios are isolated per-HOME (scenarioDirs below) AND use distinct
 * account ids — belt and braces against cross-scenario account leakage (the
 * engine's pool merge prefers vault metadata over the config account for the
 * same id: mergePoolAccounts, codexAccountPool.ts).
 */
const ACCOUNT_ID = 'ca11ab1e-0000-4000-8000-0000000000d2'
const CRASH_ACCOUNT_ID = 'ca11ab1e-0000-4000-8000-0000000000c3'
const IDSW_ACCOUNT_ID = 'ca11ab1e-0000-4000-8000-0000000000c4'
/** F1 image-path scenario: a sole vault-backed account. */
const IMAGE_ACCOUNT_ID = 'ca11ab1e-0000-4000-8000-0000000000f1'
/** The account the mock rotates INTO for the identity-mismatch scenario. */
const NEW_IDENTITY_ID = 'beefbeef-1111-4222-8333-000000000b0b'
const CHILD_ENTRY = join(import.meta.dir, 'accountRefreshContention.probe.child.ts')

/** Widen the race window so both children's requests overlap in real time. */
const MOCK_LATENCY_MS = 300

const scratch = mkdtempSync(join(tmpdir(), 'dr2-refresh-probe-'))

/**
 * Per-scenario HOME/config isolation. Sharing one HOME across scenarios lets
 * one scenario's leftover accounts leak into the next scenario's pool init
 * (which can fire stray refreshes at that scenario's strict mock and poison
 * its attempt log) — the exact shared-mutable-state class this probe exists
 * to catch, so the probe does not commit it itself.
 */
type ScenarioDirs = { home: string; config: string }
function scenarioDirs(name: string): ScenarioDirs {
  const home = join(scratch, name, 'home')
  const config = join(scratch, name, 'config')
  mkdirSync(home, { recursive: true })
  mkdirSync(config, { recursive: true })
  return { home, config }
}

/* ------------------------------------------------------------------------- *
 * Mock OAuth token endpoint — strict rotation, sequential processing.
 * ------------------------------------------------------------------------- */

type RefreshAttempt = { token: string; outcome: 'rotated' | 'invalid_grant' }

function b64url(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

/** Unsigned JWT whose payload satisfies extractCodexAccountId (codex-client.ts). */
function mintAccessJwt(accountId: string, serial: number): string {
  const header = b64url({ alg: 'none', typ: 'JWT' })
  const payload = b64url({
    'https://api.openai.com/auth': { chatgpt_account_id: accountId },
    email: 'dr2-probe@example.com',
    serial,
  })
  return `${header}.${payload}.probe-sig`
}

type StrictRotationServerOptions = {
  /**
   * Delay BEFORE validating/rotating — widens the window in which an
   * unserialized second client would still be holding the pre-rotation token.
   */
  preValidateDelayMs?: number
  /**
   * Delay AFTER the rotation is committed but BEFORE the response is
   * delivered — the crash window: the server has burned the old token while
   * the client dies never learning the new one.
   */
  postCommitDelayMs?: number
  /**
   * Mint rotated access tokens under a DIFFERENT account id (models the
   * server-side identity-mismatch rotation accounts.ts must tombstone).
   */
  identitySwitchTo?: string
  /** Account id to mint successful tokens under (default: scenario-1's id). */
  mintAccountId?: string
}

class StrictRotationServer {
  attempts: RefreshAttempt[] = []
  private expected: string
  private serial = 0
  private readonly burned = new Set<string>()
  private readonly options: StrictRotationServerOptions
  /** Serializes request processing so validation models a strict server. */
  private queue: Promise<unknown> = Promise.resolve()
  private readonly server: ReturnType<typeof Bun.serve>

  constructor(initialRefreshToken: string, options: StrictRotationServerOptions = {}) {
    this.expected = initialRefreshToken
    this.options = options
    this.server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: request => this.enqueue(request),
    })
  }

  get url(): string {
    return `http://127.0.0.1:${this.server.port}/oauth/token`
  }

  get currentRefreshToken(): string {
    return this.expected
  }

  get lastAccessToken(): string {
    return mintAccessJwt(this.mintedAccountId, this.serial)
  }

  private get mintedAccountId(): string {
    return this.options.identitySwitchTo ?? this.options.mintAccountId ?? ACCOUNT_ID
  }

  stop(): void {
    this.server.stop(true)
  }

  private enqueue(request: Request): Promise<Response> {
    const next = this.queue.then(() => this.handle(request))
    // Keep the chain alive even when a handler rejects.
    this.queue = next.catch(() => {})
    return next
  }

  private async handle(request: Request): Promise<Response> {
    const refreshToken = await readRefreshToken(request)
    if (process.env.DR2_DEBUG) {
      console.log(`[mock:${this.server.port}] +${Date.now() % 100000} token=${refreshToken}`)
    }
    await Bun.sleep(this.options.preValidateDelayMs ?? MOCK_LATENCY_MS)
    if (refreshToken !== this.expected || this.burned.has(refreshToken)) {
      this.attempts.push({ token: refreshToken, outcome: 'invalid_grant' })
      return Response.json({ error: 'invalid_grant' }, { status: 400 })
    }
    // Rotation is COMMITTED here — the old token is burned server-side from
    // this point on, whether or not the client ever receives the response.
    this.burned.add(refreshToken)
    this.serial += 1
    this.expected = `R${this.serial}`
    this.attempts.push({ token: refreshToken, outcome: 'rotated' })
    if (this.options.postCommitDelayMs) {
      await Bun.sleep(this.options.postCommitDelayMs)
    }
    return Response.json({
      access_token: mintAccessJwt(this.mintedAccountId, this.serial),
      refresh_token: this.expected,
      id_token: mintAccessJwt(this.mintedAccountId, this.serial),
      expires_in: 3600,
    })
  }
}

/** Both real clients hit the endpoint differently: form-encoded vs JSON body. */
async function readRefreshToken(request: Request): Promise<string> {
  const contentType = request.headers.get('content-type') ?? ''
  if (contentType.includes('application/json')) {
    const body = (await request.json()) as { refresh_token?: string }
    return body.refresh_token ?? ''
  }
  const body = await request.text()
  return new URLSearchParams(body).get('refresh_token') ?? ''
}

/* ------------------------------------------------------------------------- *
 * Child process driver
 * ------------------------------------------------------------------------- */

type ChildResult = {
  ok: boolean
  accountId?: string
  accessToken?: string
  refreshToken?: string
  status?: string
  error?: string
  tokens?: {
    accessToken: string
    refreshToken: string
    expiresAt: number
    accountId: string
  } | null
}

async function runChild(
  dirs: ScenarioDirs,
  env: Record<string, string>,
): Promise<ChildResult> {
  const child = spawnChild(dirs, env)
  return await child.result
}

function spawnChild(
  dirs: ScenarioDirs,
  env: Record<string, string>,
): {
  proc: ReturnType<typeof Bun.spawn>
  result: Promise<ChildResult>
} {
  const proc = Bun.spawn({
    cmd: [process.execPath, 'run', CHILD_ENTRY],
    env: {
      PATH: process.env.PATH ?? '',
      HOME: dirs.home,
      CLAUDE_CONFIG_DIR: dirs.config,
      // CRITICAL: not 'test' — under NODE_ENV=test the engine's GlobalConfig is
      // an in-memory object and there is no cross-process persistence to race.
      NODE_ENV: 'development',
      ...env,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const result = (async () => {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    await proc.exited
    const line = stdout.split('\n').find(l => l.startsWith('RESULT:'))
    if (!line) {
      throw new Error(
        `child printed no RESULT line.\nstdout: ${stdout}\nstderr: ${stderr}`,
      )
    }
    return JSON.parse(line.slice('RESULT:'.length)) as ChildResult
  })()
  return { proc, result }
}

/** Release `count` contenders at once: wait for their ready markers, then GO. */
async function releaseBarrier(goFile: string, count = 2): Promise<void> {
  const start = Date.now()
  while (readyMarkers(goFile) < count) {
    if (Date.now() - start > 30_000) {
      throw new Error('timed out waiting for contenders to become ready')
    }
    await Bun.sleep(20)
  }
  writeFileSync(goFile, 'go')
}

function readyMarkers(goFile: string): number {
  const base = basename(goFile)
  try {
    return readdirSync(dirname(goFile)).filter(f => f.startsWith(`${base}.ready.`))
      .length
  } catch {
    return 0
  }
}

async function establishProbeLifecycle(
  directory: string,
  accountId: string,
): Promise<void> {
  const lifecycle = createCodexCredentialLifecycle({ directory })
  await lifecycle.withTransaction(
    accountId,
    { operationKind: 'login', operationId: `probe-login-${accountId}` },
    permit => {
      const prepared = lifecycle.prepareLogin(permit)
      if (prepared.status !== 'applied') {
        throw new Error('probe lifecycle preparation failed')
      }
      const committed = lifecycle.commitLogin(permit, {
        expectedGeneration: prepared.record.credentialGeneration,
      })
      if (committed.status !== 'applied') {
        throw new Error('probe lifecycle commit failed')
      }
    },
  )
}

async function waitFor(
  condition: () => boolean,
  timeoutMs: number,
  what: string,
): Promise<void> {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out waiting for ${what}`)
    }
    await Bun.sleep(20)
  }
}

/** The raw-refresh attempt ledger the children write (accounts.ts DR-2). */
function readLedger(
  dirs: ScenarioDirs,
): Record<string, { state: string; reason?: string; rotatedToAccountId?: string }> {
  try {
    const parsed = JSON.parse(
      readFileSync(join(dirs.config, 'codex-raw-refresh.state.json'), 'utf-8'),
    ) as { accounts?: Record<string, { state: string; rotatedToAccountId?: string }> }
    return parsed.accounts ?? {}
  } catch {
    return {}
  }
}

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

/* ------------------------------------------------------------------------- *
 * Scenario 1 — config branch (codex-core maybeRefreshAccount raw path)
 * ------------------------------------------------------------------------- */

describe('DR-2 cross-process refresh contention (two real engine processes)', () => {
  test(
    'config branch: two processes refreshing one config account burn ONE rotation and converge',
    async () => {
      const server = new StrictRotationServer('R0')
      const dirs = scenarioDirs('s1-config')
      try {
        // Seed the scenario's config store through the real engine writer.
        const seed = await runChild(dirs, {
          PROBE_MODE: 'seed-config',
          PROBE_ACCOUNT_ID: ACCOUNT_ID,
          PROBE_ACCESS_TOKEN: mintAccessJwt(ACCOUNT_ID, 0),
          PROBE_REFRESH_TOKEN: 'R0',
          PROBE_CREDENTIAL_GENERATION: '1',
          // Inside the refresh skew (60s) → maybeRefreshAccount refreshes; not
          // yet expired → the pool does not pre-mark the account dead.
          PROBE_EXPIRES_AT: String(Date.now() + 30_000),
        })
        expect(seed.ok).toBe(true)
        await establishProbeLifecycle(
          join(dirs.config, 'codex-credential-lifecycle'),
          ACCOUNT_ID,
        )

        const goFile = join(scratch, 'go-config')
        const contenderEnv = {
          PROBE_MODE: 'contend-config',
          PROBE_TOKEN_URL: server.url,
          PROBE_GO_FILE: goFile,
          PROBE_ACCOUNT_ID: ACCOUNT_ID,
        }
        const a = spawnChild(dirs, contenderEnv)
        const b = spawnChild(dirs, contenderEnv)
        await releaseBarrier(goFile)
        const [resultA, resultB] = await Promise.all([a.result, b.result])

        // The clobber this probe exists to catch: both processes spending the
        // SAME refresh token (attempts > 1 / an invalid_grant), or a loser
        // erroring out and dropping the account ("accounts keep logging out").
        expect(resultA.ok).toBe(true)
        expect(resultB.ok).toBe(true)
        expect(server.attempts).toHaveLength(1)
        expect(server.attempts[0]).toEqual({ token: 'R0', outcome: 'rotated' })

        // Both processes converge on the SAME live rotation.
        expect(resultA.accessToken).toBe(server.lastAccessToken)
        expect(resultB.accessToken).toBe(server.lastAccessToken)
        expect(resultA.refreshToken).toBe(server.currentRefreshToken)
        expect(resultB.refreshToken).toBe(server.currentRefreshToken)

        // And the disk store holds the live rotated refresh token.
        const readBack = await runChild(dirs, { PROBE_MODE: 'read-config' })
        expect(readBack.ok).toBe(true)
        expect(readBack.tokens?.refreshToken).toBe(server.currentRefreshToken)
        expect(readBack.tokens?.accountId).toBe(ACCOUNT_ID)
      } finally {
        server.stop()
      }
    },
    120_000,
  )

  /* ----------------------------------------------------------------------- *
   * Scenario 2 — vault branch (refreshAccountTokens: the pool path a Phase-3
   * sidecar hits on a 401). Validates the EXISTING lock + recovery machinery
   * with two REAL processes — the P0-4 caveat this probe retires.
   * ----------------------------------------------------------------------- */

  test(
    'vault branch: existing proper-lockfile + recovery holds across two real processes',
    async () => {
      const server = new StrictRotationServer('R0')
      const dirs = scenarioDirs('s2-vault')
      try {
        const accountsDir = join(dirs.home, 'codex-vault', 'accounts')
        mkdirSync(accountsDir, { recursive: true })
        const vaultFile = join(accountsDir, `${ACCOUNT_ID}.json`)
        writeFileSync(
          vaultFile,
          `${JSON.stringify(
            {
              tokens: {
                access_token: mintAccessJwt(ACCOUNT_ID, 0),
                refresh_token: 'R0',
                account_id: ACCOUNT_ID,
                credential_generation: 1,
                expires_at: Date.now() + 30_000,
              },
              version: 1,
            },
            null,
            2,
          )}\n`,
        )

        const goFile = join(scratch, 'go-vault')
        const contenderEnv = {
          PROBE_MODE: 'contend-vault',
          PROBE_TOKEN_URL: server.url,
          PROBE_GO_FILE: goFile,
          PROBE_ACCOUNT_ID: ACCOUNT_ID,
          PROBE_REFRESH_TOKEN: 'R0',
          PROBE_VAULT_FILE: vaultFile,
          PROBE_CREDENTIAL_GENERATION: '1',
        }
        await establishProbeLifecycle(
          join(dirs.config, 'codex-credential-lifecycle'),
          ACCOUNT_ID,
        )
        const a = spawnChild(dirs, contenderEnv)
        const b = spawnChild(dirs, contenderEnv)
        await releaseBarrier(goFile)
        const [resultA, resultB] = await Promise.all([a.result, b.result])

        expect(resultA.ok).toBe(true)
        expect(resultB.ok).toBe(true)
        expect(server.attempts).toHaveLength(1)
        expect(server.attempts[0]).toEqual({ token: 'R0', outcome: 'rotated' })
        expect(resultA.refreshToken).toBe(server.currentRefreshToken)
        expect(resultB.refreshToken).toBe(server.currentRefreshToken)

        const vault = JSON.parse(readFileSync(vaultFile, 'utf-8')) as {
          tokens?: { refresh_token?: string }
          refresh?: { state?: string }
        }
        expect(vault.tokens?.refresh_token).toBe(server.currentRefreshToken)
        expect(vault.refresh?.state).toBe('idle')
        expect(existsSync(`${vaultFile}.lock`)).toBe(false)
      } finally {
        server.stop()
      }
    },
    120_000,
  )

  /* ----------------------------------------------------------------------- *
   * Scenario 3 — crash AFTER server-side rotation (the review's Critical).
   * The server burns R0 and the client dies before learning R1: R1 is gone
   * forever, so no client can "recover" the chain — the ledger's job is to
   * turn that into ONE definitive probe + a terminal re-login verdict instead
   * of an endless misleading retry loop.
   * ----------------------------------------------------------------------- */

  test(
    'crash after rotation: ledger probes the stranded token once, then verdicts re-login with zero further burns',
    async () => {
      const seedToken = 'R0-crash'
      const server = new StrictRotationServer(seedToken, {
        preValidateDelayMs: 0,
        // rotation commits at arrival; response delivery is delayed so the
        // parent can kill the client inside the committed-but-undelivered gap
        postCommitDelayMs: 8_000,
        mintAccountId: CRASH_ACCOUNT_ID,
      })
      const dirs = scenarioDirs('s3-crash')
      try {
        const seed = await runChild(dirs, {
          PROBE_MODE: 'seed-config',
          PROBE_ACCOUNT_ID: CRASH_ACCOUNT_ID,
          PROBE_ACCESS_TOKEN: mintAccessJwt(CRASH_ACCOUNT_ID, 0),
          PROBE_REFRESH_TOKEN: seedToken,
          PROBE_CREDENTIAL_GENERATION: '1',
          PROBE_EXPIRES_AT: String(Date.now() + 30_000),
        })
        expect(seed.ok).toBe(true)
        await establishProbeLifecycle(
          join(dirs.config, 'codex-credential-lifecycle'),
          CRASH_ACCOUNT_ID,
        )

        // Child A: fires the refresh; the mock commits the rotation; A is
        // SIGKILLed while awaiting the response (its in_flight ledger entry
        // was written BEFORE the request left — that is the crash-safety core).
        const goA = join(scratch, 'go-crash-a')
        const a = spawnChild(dirs, {
          PROBE_MODE: 'contend-config',
          PROBE_TOKEN_URL: server.url,
          PROBE_GO_FILE: goA,
          PROBE_ACCOUNT_ID: CRASH_ACCOUNT_ID,
        })
        await releaseBarrier(goA, 1)
        await waitFor(() => server.attempts.length >= 1, 20_000, 'rotation commit')
        a.proc.kill('SIGKILL')
        await a.proc.exited
        await a.result.catch(() => null) // killed child prints no RESULT line
        // A died holding the advisory lock; proper-lockfile would declare it
        // stale after 60s. Simulate that expiry so the test stays fast — the
        // staleness mechanism itself is upstream-tested.
        rmSync(join(dirs.config, 'codex-raw-refresh.lock'), { recursive: true, force: true })
        const lifecycle = createCodexCredentialLifecycle({
          directory: join(dirs.config, 'codex-credential-lifecycle'),
        })
        rmSync(
          lifecycle.getPaths(CRASH_ACCOUNT_ID).lockPath,
          { recursive: true, force: true },
        )

        // Child B: finds in_flight for the same token hash → probes it ONCE →
        // definitive invalid_grant → terminal reauth_required + honest error.
        const goB = join(scratch, 'go-crash-b')
        const b = spawnChild(dirs, {
          PROBE_MODE: 'contend-config',
          PROBE_TOKEN_URL: server.url,
          PROBE_GO_FILE: goB,
          PROBE_ACCOUNT_ID: CRASH_ACCOUNT_ID,
        })
        await releaseBarrier(goB, 1)
        const resultB = await b.result
        expect(resultB.ok).toBe(false)
        expect(resultB.error ?? '').toContain('Please re-login')
        expect(server.attempts).toEqual([
          { token: seedToken, outcome: 'rotated' },
          { token: seedToken, outcome: 'invalid_grant' },
        ])

        // Child C: the terminal verdict is honored with ZERO network traffic.
        const goC = join(scratch, 'go-crash-c')
        const c = spawnChild(dirs, {
          PROBE_MODE: 'contend-config',
          PROBE_TOKEN_URL: server.url,
          PROBE_GO_FILE: goC,
          PROBE_ACCOUNT_ID: CRASH_ACCOUNT_ID,
        })
        await releaseBarrier(goC, 1)
        const resultC = await c.result
        expect(resultC.ok).toBe(false)
        expect(resultC.error ?? '').toContain('Please re-login')
        expect(server.attempts).toHaveLength(2)

        expect(readLedger(dirs)[CRASH_ACCOUNT_ID]?.state).toBe('reauth_required')
      } finally {
        server.stop()
      }
    },
    120_000,
  )

  /* ----------------------------------------------------------------------- *
   * Scenario 4 — identity-mismatch rotation under contention. A refresh of
   * account A returns account B; lifecycle reauth_required plus the raw ledger
   * must stop every contender WITHOUT a second burn or a B installation.
   * ----------------------------------------------------------------------- */

  test(
    'identity-mismatch contention: lifecycle tombstone stops contenders; exactly one rotation is spent',
    async () => {
      const seedToken = 'R0-idsw'
      const server = new StrictRotationServer(seedToken, {
        identitySwitchTo: NEW_IDENTITY_ID,
      })
      const dirs = scenarioDirs('s4-idsw')
      try {
        const seed = await runChild(dirs, {
          PROBE_MODE: 'seed-config',
          PROBE_ACCOUNT_ID: IDSW_ACCOUNT_ID,
          PROBE_ACCESS_TOKEN: mintAccessJwt(IDSW_ACCOUNT_ID, 0),
          PROBE_REFRESH_TOKEN: seedToken,
          PROBE_CREDENTIAL_GENERATION: '1',
          PROBE_EXPIRES_AT: String(Date.now() + 30_000),
        })
        expect(seed.ok).toBe(true)
        await establishProbeLifecycle(
          join(dirs.config, 'codex-credential-lifecycle'),
          IDSW_ACCOUNT_ID,
        )

        const goFile = join(scratch, 'go-idsw')
        const contenderEnv = {
          PROBE_MODE: 'contend-config',
          PROBE_TOKEN_URL: server.url,
          PROBE_GO_FILE: goFile,
          PROBE_ACCOUNT_ID: IDSW_ACCOUNT_ID,
        }
        const a = spawnChild(dirs, contenderEnv)
        const b = spawnChild(dirs, contenderEnv)
        await releaseBarrier(goFile)
        const [resultA, resultB] = await Promise.all([a.result, b.result])

        // THE core assertion: one rotation spent, ever. The loser must not
        // touch the network with A's dead token.
        expect(server.attempts).toEqual([{ token: seedToken, outcome: 'rotated' }])

        // Neither child installs the returned identity. The lifecycle tombstone
        // requires an explicit login before either identity is usable again.
        const results = [resultA, resultB]
        const winners = results.filter(r => r.ok)
        const losers = results.filter(r => !r.ok)
        expect(winners).toHaveLength(0)
        expect(losers).toHaveLength(2)
        expect(losers.every(r => (r.error ?? '').includes('Please re-login'))).toBe(true)

        const tombstone = readLedger(dirs)[IDSW_ACCOUNT_ID]
        expect(tombstone?.state).toBe('reauth_required')
        expect(tombstone?.rotatedToAccountId).toBe(NEW_IDENTITY_ID)

        // The persisted config store still holds A's burned token. B was never
        // written by the raw refresh path.
        const readBack = await runChild(dirs, { PROBE_MODE: 'read-config' })
        expect(readBack.tokens?.accountId).toBe(IDSW_ACCOUNT_ID)
        expect(readBack.tokens?.refreshToken).toBe(seedToken)
      } finally {
        server.stop()
      }
    },
    120_000,
  )

  /* ----------------------------------------------------------------------- *
   * Scenario 5 — F1: the image path (GenerateImageTool.getImageAuth) on a
   * sole near-expiry VAULT account, under two real processes. F1's fix
   * rerouted image auth off the naked refresh + config-only save (which burned
   * the vault's rotate-once token and stranded the successor in config) and
   * onto resolveCodexOAuthTokensForLeaseOwner → maybeRefreshAccount → the vault
   * state machine. This proves that reroute holds under contention: exactly one
   * rotation is spent and the VAULT — not a config successor — ends up holding
   * the live token. Login writes both config and vault, so both are seeded.
   * ----------------------------------------------------------------------- */

  test(
    'image-auth path: two processes refreshing a sole vault account burn ONE rotation and leave the vault live',
    async () => {
      const server = new StrictRotationServer('R0', { mintAccountId: IMAGE_ACCOUNT_ID })
      const dirs = scenarioDirs('s5-image-auth')
      try {
        // Login writes BOTH stores; the config mirror is the exact bait F1's
        // bug poisoned. Seed it through the real writer, then write the vault.
        const seed = await runChild(dirs, {
          PROBE_MODE: 'seed-config',
          PROBE_ACCOUNT_ID: IMAGE_ACCOUNT_ID,
          PROBE_ACCESS_TOKEN: mintAccessJwt(IMAGE_ACCOUNT_ID, 0),
          PROBE_REFRESH_TOKEN: 'R0',
          PROBE_EXPIRES_AT: String(Date.now() + 30_000),
        })
        expect(seed.ok).toBe(true)

        const accountsDir = join(dirs.home, 'codex-vault', 'accounts')
        mkdirSync(accountsDir, { recursive: true })
        const vaultFile = join(accountsDir, `${IMAGE_ACCOUNT_ID}.json`)
        writeFileSync(
          vaultFile,
          `${JSON.stringify(
            {
              tokens: {
                access_token: mintAccessJwt(IMAGE_ACCOUNT_ID, 0),
                refresh_token: 'R0',
                account_id: IMAGE_ACCOUNT_ID,
                credential_generation: 1,
                // Within the 60s refresh skew but not expired → the resolver
                // refreshes it and the pool does not pre-mark it dead.
                expires_at: Date.now() + 30_000,
              },
              refresh: { state: 'idle' },
              version: 1,
            },
            null,
            2,
          )}\n`,
        )

        const goFile = join(scratch, 'go-image-auth')
        const contenderEnv = {
          PROBE_MODE: 'contend-image-auth',
          PROBE_TOKEN_URL: server.url,
          PROBE_GO_FILE: goFile,
          PROBE_ACCOUNT_ID: IMAGE_ACCOUNT_ID,
        }
        await establishProbeLifecycle(
          join(dirs.config, 'codex-credential-lifecycle'),
          IMAGE_ACCOUNT_ID,
        )
        const a = spawnChild(dirs, contenderEnv)
        const b = spawnChild(dirs, contenderEnv)
        await releaseBarrier(goFile)
        const [resultA, resultB] = await Promise.all([a.result, b.result])

        // The F1 clobber this guards: a second rotation burned, or a loser
        // dropping the sole account ("logged in but cannot send").
        expect(resultA.ok).toBe(true)
        expect(resultB.ok).toBe(true)
        expect(server.attempts).toHaveLength(1)
        expect(server.attempts[0]).toEqual({ token: 'R0', outcome: 'rotated' })

        // Both processes converge on the SAME live rotation via the image path.
        expect(resultA.accountId).toBe(IMAGE_ACCOUNT_ID)
        expect(resultB.accountId).toBe(IMAGE_ACCOUNT_ID)
        expect(resultA.accessToken).toBe(server.lastAccessToken)
        expect(resultB.accessToken).toBe(server.lastAccessToken)
        expect(resultA.refreshToken).toBe(server.currentRefreshToken)
        expect(resultB.refreshToken).toBe(server.currentRefreshToken)

        // The VAULT (not just a config successor) holds the live rotation and
        // its refresh state machine is settled — the poisoning F1 caused would
        // instead strand the burned token here.
        const vault = JSON.parse(readFileSync(vaultFile, 'utf-8')) as {
          tokens?: { refresh_token?: string; account_id?: string }
          refresh?: { state?: string }
        }
        expect(vault.tokens?.refresh_token).toBe(server.currentRefreshToken)
        expect(vault.tokens?.account_id).toBe(IMAGE_ACCOUNT_ID)
        expect(vault.refresh?.state).toBe('idle')
        expect(existsSync(`${vaultFile}.lock`)).toBe(false)
      } finally {
        server.stop()
      }
    },
    120_000,
  )
})
