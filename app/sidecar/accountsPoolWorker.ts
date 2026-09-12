/**
 * Accounts-pool worker (accounts owner — `docs/migration/decisions/ACCOUNTS-OWNERSHIP.md`).
 * ONE disposable engine-graph process. In its ordinary mode it reads the global
 * account pool once. In `--account-delete` mode it accepts one strictly validated
 * confirmed delete over stdin and runs it through `accountsDomain`; in
 * `--account-sign-out` mode it accepts one targeted lifecycle request and emits
 * the engine's bounded receipt. All modes emit one bounded NDJSON result and
 * exit. The worker is separate from live N-process sidecars, so global profile
 * mutations never borrow a chat session.
 *
 * Main re-spawns it on a timer and remains engine-free. This worker reuses the
 * EXISTING redaction (`buildAccountsSnapshot`, the same pure projection the
 * sidecar accounts domain emits) rather than re-deriving the shape
 * (CLAUDE.md §8 rule 10).
 *
 * OBSERVATION-FIRST BOOTSTRAP — now shared by all three disposable workers (the
 * two siblings adopted it after shipping the full bootstrap for a while). Full
 * `init()` fires `void initAccountPool()` (`src/entrypoints/init.ts:90`), which starts
 * periodic token refresh, quarantine probes, and a startup `touchAll()`. On a
 * 60 s timer that would drive real cross-process credential rotation against the
 * vault forever. So this worker takes the engine's OWN observation-only entry
 * point instead — `loadPoolForObservation()`, extracted upstream for exactly
 * this class of caller ("observation-only callers (e.g. the `codex status`
 * subcommand) can load the pool without triggering token refresh, quarantine
 * probes, or usage polls", `codexAccountPool.ts:171-181`) — plus the MACRO shim
 * alone from `initializeRuntime.ts`.
 *
 * The Anthropic pool now has the same shape of entry point:
 * `loadClaudePoolForObservation()` (`claudeAccountPool.ts:101`), extracted
 * from `initClaudeAccountPool()` the same way. `initClaudeAccountPool()`
 * (`claudeAccountPool.ts:152`) is the one that can WRITE a fresh vault file
 * (`saveClaudeTokenToVault`, `claudeAccountPool.ts:624`) whenever it finds a
 * keychain/config account not yet present in the vault — including one the
 * operator just deleted with `/delete-account`, since delete leaves the
 * keychain blob and `config.oauthAccount` intact. A read from a 60 s
 * disposable timer must not write, so this worker calls
 * `loadClaudePoolForObservation()` instead: it merges vault accounts and, in
 * memory only, a config-only account into the SAME pool shape
 * `initClaudeAccountPool()` would produce, but never performs that write.
 * Because a config-only account looks identical whether it is the legacy
 * pre-vault single-account case or a `/delete-account`'d account's lingering
 * keychain/config remnant, this worker can still show that one edge case in
 * the emitted list — what it guarantees is narrower and disk-only: this
 * unattended observation mode never re-creates the vault file, so a deletion is
 * never undone on disk by an idle background read. Delete mode performs only the
 * explicitly confirmed write after this same fresh load. The two Anthropic ROUTE
 * booleans below are read through a separate, disk-write-free path and stay
 * accurate regardless.
 *
 * The ONE outbound network call is `fetchPoolUsage`, the same read-only (GET,
 * existing tokens, no refresh, no completion burn) call the sidecar accounts
 * domain already makes. It is what keeps the headroom numbers live; a failure
 * degrades to "pool without fresh usage" and never fails the run. Its
 * module-level cache (`codexUsage.ts:93`, 1-minute TTL) does not help this
 * process: each run is a fresh disposable worker, so `cachedSnapshot` always
 * starts `null` here and every run performs a live fetch regardless of poll
 * interval — see `accountsPoolRunner.ts`'s cadence comment for the actual
 * reason the interval is 60 s.
 *
 * It also aggregates the Accounts page's usage analytics for both ranges
 * (`readUsageStats`), for the same reason the pool read moved here: that page
 * must work with no session open. Local disk only, and best-effort — a failure
 * omits the field and never fails the run. Unlike everything else here it runs
 * only when main passes `--usage-stats`, because it is a full pass over the
 * transcript corpus rather than a bounded vault read; the cadence and its
 * reasoning live on `USAGE_STATS_EVERY_N_RUNS` in `app/main/accountsPoolRunner.ts`.
 *
 * The emitted record is the ALREADY-redacted `AccountsSnapshot` (no token, no
 * vault path by construction), and it is `secretGuard`-scanned here AND again at
 * main's parse boundary. stderr is diagnostics only.
 */

import {
  ACCOUNTS_POOL_WORKER_BOUNDARY_VERSION,
  MAX_ACCOUNTS_POOL_WORKER_RECORD_BYTES,
  parseAccountsPoolWorkerDeleteRequest,
  parseAccountsPoolWorkerSignOutRequest,
  shedOversizeUsageStats,
  type AccountsPoolWorkerDeleteRequest,
  type AccountsPoolWorkerResult,
  type AccountsPoolWorkerSignOutRequest,
} from '../shared/accountsPoolWorker.js'
import { scanForSecrets } from '../shared/secretGuard.js'
import type {
  AccountSignOutReceipt,
  UsageStatsByRange,
} from '../shared/protocol.js'
import {
  bootstrapWorkerEngine,
  emitWorkerRecord,
  errorText,
  runDisposableWorker,
} from './workerRuntime.js'

// Set the one-switch minimal mode before ANY engine module is dynamically
// imported (mirrors `sessionsCatalogWorker.ts:40`): a pool read must not drag in
// SessionStart hooks or the live-session machinery. `workerRuntime.js` above is
// engine-free by contract, so importing it does not pre-empt this.
process.env.CLAUDE_CODE_SIMPLE = '1'

async function main(): Promise<void> {
  const deleteRequest = process.argv.includes('--account-delete')
    ? await readDeleteRequest()
    : null
  const signOutRecovery = process.argv.includes('--account-sign-out-recovery')
  const signOutRequest = process.argv.includes('--account-sign-out')
    ? await readSignOutRequest()
    : null
  if (signOutRecovery && !signOutRequest) {
    throw new Error('account sign-out recovery requires account sign-out mode')
  }

  // Engine imports happen only after SIMPLE is fixed for the process. The static
  // imports above are engine-free (shared boundary + secretGuard), so the
  // ~189 MB engine import is paid only here, per run.
  const [
    { getCodexProfileInventory, getPoolStatus, loadPoolForObservation },
    { loadClaudePoolForObservation },
    { buildAccountsSnapshot, createSidecarAccountsDomain },
    { recoverCodexAccountSignOut, signOutCodexAccount },
  ] = await Promise.all([
    import('../../src/services/api/codexAccountPool.js'),
    import('../../src/services/api/claudeAccountPool.js'),
    import('./accountsDomain.js'),
    import('../../src/services/api/codexAccountSignOut.js'),
  ])
  // Both pool loads below read the global config, so the config latch this
  // opens is load-bearing here, not just hygiene.
  await bootstrapWorkerEngine()

  // The Codex load is disk-only observation; it neither refreshes a token nor
  // writes a vault file (see the file header). Sign-out needs this fresh pool
  // before resolving the targeted account, but it does not need the optional
  // Anthropic observation.
  await loadPoolForObservation()

  if (signOutRequest) {
    const input = {
      accountId: signOutRequest.verb.accountId,
      expectedCredentialGeneration:
        signOutRequest.verb.expectedCredentialGeneration,
      operationId: signOutRequest.verb.requestId,
    }
    let receipt: AccountSignOutReceipt
    try {
      const transaction = signOutRecovery
        ? await recoverCodexAccountSignOut(input)
        : await signOutCodexAccount(input)
      receipt = {
        outcome: transaction.status,
        accountId: transaction.accountId,
        expectedCredentialGeneration:
          signOutRequest.verb.expectedCredentialGeneration,
        observedCredentialGeneration: transaction.lifecycleGeneration,
        lifecycleState: transaction.lifecycleState,
        operationId: transaction.operationId,
        targetWasActive: transaction.targetWasActive,
        replacementActiveAccountId: transaction.replacementActiveAccountId,
      }
    } catch {
      receipt = {
        outcome: 'retryable_unknown',
        accountId: signOutRequest.verb.accountId,
        expectedCredentialGeneration:
          signOutRequest.verb.expectedCredentialGeneration,
        observedCredentialGeneration: null,
        lifecycleState: null,
        operationId: signOutRequest.verb.requestId,
        targetWasActive: false,
        replacementActiveAccountId: null,
      }
    }
    const result: AccountsPoolWorkerResult = {
      type: 'account-sign-out',
      version: ACCOUNTS_POOL_WORKER_BOUNDARY_VERSION,
      requestId: signOutRequest.verb.requestId,
      verb: 'account.logout',
      receipt,
    }
    if (!scanForSecrets(result).ok) {
      process.stderr.write('[accounts-worker] blocked secret-keyed sign-out result\n')
      await emit({
        type: 'failure',
        version: ACCOUNTS_POOL_WORKER_BOUNDARY_VERSION,
        reason: 'internal',
      })
      process.exit(0)
    }
    await emit(result)
    process.exit(0)
  }

  loadClaudePoolForObservation()

  const deleteOutcome = deleteRequest
    ? await createSidecarAccountsDomain().runVerb(deleteRequest.verb)
    : null

  // Live usage headroom — the reason this page polls at all. Best-effort: an
  // offline or stale-token run still emits the pool with whatever usage the
  // accounts already carry.
  try {
    const { fetchPoolUsage } = await import('../../src/services/api/codexUsage.js')
    await fetchPoolUsage({ updateRoutingHints: true })
  } catch (error) {
    process.stderr.write(
      `[accounts-worker] usage refresh skipped: ${errorText(error)}\n`,
    )
  }

  // `CLAUDE_CODE_SIMPLE` above buys "skip hooks and the live-session machinery",
  // but the same switch ALSO means "hermetic auth" to the engine: under it
  // `getAuthTokenSource` and `getAnthropicApiKeyWithSource` return early
  // (`src/utils/auth.ts`) and `getClaudeAIOAuthTokens` returns null, so the two
  // Anthropic route booleans `buildAccountsSnapshot` derives by default would
  // read false for every signed-in user, every run. The renderer prefers this
  // snapshot over the session's, so that hides the account chip and re-asserts
  // the first-run sign-in surface on a fully authenticated app. Read them the
  // way a normal session sidecar does instead, and pass them in explicitly.
  const anthropic = await readAnthropicRouteFacts()

  let pool
  try {
    pool = buildAccountsSnapshot(
      getPoolStatus(),
      Date.now(),
      undefined,
      anthropic.routeAvailable,
      anthropic.subscriptionActive,
      getCodexProfileInventory(),
    )
  } catch (error) {
    // A read failure degrades to "no pool" — main keeps its last good snapshot
    // (the renderer never blanks). Report it explicitly so the runner
    // distinguishes a clean empty pool from a failed read.
    process.stderr.write(`[accounts-worker] pool read failed: ${errorText(error)}\n`)
    await emit({
      type: 'failure',
      version: ACCOUNTS_POOL_WORKER_BOUNDARY_VERSION,
      reason: 'internal',
    })
    process.exit(0)
  }

  if (deleteOutcome) {
    const result: AccountsPoolWorkerResult = {
      type: 'account-delete',
      version: ACCOUNTS_POOL_WORKER_BOUNDARY_VERSION,
      requestId: deleteRequest!.verb.requestId,
      verb: 'account.delete',
      ok: deleteOutcome.result.ok,
      message: deleteOutcome.result.message,
      pool,
    }
    const secret = scanForSecrets(result)
    if (!secret.ok) {
      process.stderr.write('[accounts-worker] blocked secret-keyed delete result\n')
      await emit({
        type: 'failure',
        version: ACCOUNTS_POOL_WORKER_BOUNDARY_VERSION,
        reason: 'internal',
      })
      process.exit(0)
    }
    await emit(result)
    process.exit(0)
  }

  const result: AccountsPoolWorkerResult = {
    type: 'pool',
    version: ACCOUNTS_POOL_WORKER_BOUNDARY_VERSION,
    pool,
  }
  // Only when main asked. It gates this per run because the read is a full pass
  // over the transcript corpus, unlike everything else in this worker — see
  // `USAGE_STATS_EVERY_N_RUNS` in `app/main/accountsPoolRunner.ts` for the
  // cadence and its reason.
  const usageStats = process.argv.includes('--usage-stats')
    ? await readUsageStats()
    : null
  if (usageStats) result.usageStats = usageStats
  if (shedOversizeUsageStats(result).shed) {
    process.stderr.write('[accounts-worker] usage stats dropped: record too large\n')
  }
  const secret = scanForSecrets(result)
  if (!secret.ok) {
    process.stderr.write('[accounts-worker] blocked secret-keyed pool result\n')
    await emit({
      type: 'failure',
      version: ACCOUNTS_POOL_WORKER_BOUNDARY_VERSION,
      reason: 'internal',
    })
    process.exit(0)
  }
  await emit(result)
  // The engine registers long-lived handles (config watchers). This is a
  // disposable single-shot process, so terminate explicitly instead of waiting
  // for those unrelated handles to drain (mirrors the sibling workers).
  process.exit(0)
}

/**
 * Usage analytics for both ranges, through the SAME `statsDomain` projection a
 * session sidecar uses (CLAUDE.md §8 rule 10 — reuse the real entry point, do
 * not re-derive the aggregation here). Local disk only: no network, no
 * credential, no config write.
 *
 * Best-effort by contract, and it must FAIL rather than degrade. Either range
 * reading null omits the WHOLE field, so the renderer keeps its last good value
 * and the empty-history claim stays something only a successful read can make.
 * Degrading a failure to a zeroed snapshot instead would publish "you have no
 * history" as measured fact, which is the exact bug this feed was built to fix.
 *
 * `bypassCache` is deliberately NOT set: the domain's 5-second TTL cannot span
 * two runs of this disposable process (a fresh one starts cold every time), so
 * asking for a bypass would claim a behavioural difference that does not exist.
 */
async function readUsageStats(): Promise<UsageStatsByRange | null> {
  try {
    const { tryGetUsageStatsSnapshot } = await import('./statsDomain.js')
    const [sevenDay, thirtyDay] = await Promise.all([
      tryGetUsageStatsSnapshot('7d'),
      tryGetUsageStatsSnapshot('30d'),
    ])
    if (!sevenDay || !thirtyDay) {
      process.stderr.write('[accounts-worker] usage stats read failed\n')
      return null
    }
    return { '7d': sevenDay, '30d': thirtyDay }
  } catch (error) {
    process.stderr.write(
      `[accounts-worker] usage stats skipped: ${errorText(error)}\n`,
    )
    return null
  }
}

/**
 * The two Anthropic route booleans, read with the minimal-mode switch lifted for
 * exactly the duration of the read. This is the SAME pair a live session sidecar
 * reads (`accountsDomain.buildAccountsSnapshot` defaults), so no new credential
 * surface is introduced here; it is only being taken outside the hermetic-auth
 * gate that `CLAUDE_CODE_SIMPLE` also turns on. The memoized OAuth token read is
 * cleared on both sides so neither a stale bare-mode `null` is reused nor a
 * non-bare token is left cached in this process. Degrades to false on any
 * failure: the snapshot must never claim a route the process could not confirm.
 */
async function readAnthropicRouteFacts(): Promise<{
  routeAvailable: boolean
  subscriptionActive: boolean
}> {
  const [{ clearOAuthTokenCache, hasAnthropicCredentials }, { resolveAnthropicSubscriptionActive }] =
    await Promise.all([
      import('../../src/utils/auth.js'),
      import('./accountsDomain.js'),
    ])
  // `isBareMode()` reads BOTH the env var and argv (`src/utils/envUtils.ts`),
  // and main launches this worker with `--bare` on the command line, so lifting
  // one without the other changes nothing. Nothing awaits inside the window, so
  // no other code observes the temporarily-restored argv.
  const minimal = process.env.CLAUDE_CODE_SIMPLE
  const argv = process.argv
  delete process.env.CLAUDE_CODE_SIMPLE
  process.argv = argv.filter(arg => arg !== '--bare')
  try {
    clearOAuthTokenCache()
    return {
      routeAvailable: hasAnthropicCredentials(),
      subscriptionActive: resolveAnthropicSubscriptionActive(),
    }
  } catch (error) {
    process.stderr.write(
      `[accounts-worker] anthropic route read failed: ${errorText(error)}\n`,
    )
    return { routeAvailable: false, subscriptionActive: false }
  } finally {
    if (minimal !== undefined) process.env.CLAUDE_CODE_SIMPLE = minimal
    process.argv = argv
    clearOAuthTokenCache()
  }
}

function emit(result: AccountsPoolWorkerResult): Promise<void> {
  return emitWorkerRecord(
    result,
    MAX_ACCOUNTS_POOL_WORKER_RECORD_BYTES,
    'accounts pool result',
  )
}

async function readDeleteRequest(): Promise<AccountsPoolWorkerDeleteRequest> {
  const input = Buffer.from(
    await new Response(Bun.stdin.stream()).arrayBuffer(),
  )
  if (input.byteLength > MAX_ACCOUNTS_POOL_WORKER_RECORD_BYTES) {
    throw new Error('accounts delete request exceeds record limit')
  }
  const lines = input
    .toString('utf8')
    .split('\n')
    .filter(line => line.length > 0)
  if (lines.length !== 1) {
    throw new Error('accounts delete worker requires exactly one request record')
  }
  let raw: unknown
  try {
    raw = JSON.parse(lines[0]!)
  } catch {
    throw new Error('accounts delete request is not valid JSON')
  }
  const request = parseAccountsPoolWorkerDeleteRequest(raw)
  if (!request) throw new Error('accounts delete request failed validation')
  return request
}

async function readSignOutRequest(): Promise<AccountsPoolWorkerSignOutRequest> {
  const input = Buffer.from(
    await new Response(Bun.stdin.stream()).arrayBuffer(),
  )
  if (input.byteLength > MAX_ACCOUNTS_POOL_WORKER_RECORD_BYTES) {
    throw new Error('accounts sign-out request exceeds record limit')
  }
  const lines = input
    .toString('utf8')
    .split('\n')
    .filter(line => line.length > 0)
  if (lines.length !== 1) {
    throw new Error('accounts sign-out worker requires exactly one request record')
  }
  let raw: unknown
  try {
    raw = JSON.parse(lines[0]!)
  } catch {
    throw new Error('accounts sign-out request is not valid JSON')
  }
  const request = parseAccountsPoolWorkerSignOutRequest(raw)
  if (!request) throw new Error('accounts sign-out request failed validation')
  return request
}

runDisposableWorker('accounts-worker', main)
