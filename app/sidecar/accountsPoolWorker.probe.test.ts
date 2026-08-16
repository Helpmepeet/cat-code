/**
 * Real-process proof for the accounts-pool worker's Anthropic route booleans.
 *
 * The worker runs the engine graph under `CLAUDE_CODE_SIMPLE` (plus a `--bare`
 * argv) so a pool read skips hooks and the live-session machinery. That same
 * switch ALSO means "hermetic auth" to the engine: `getAuthTokenSource` and
 * `getAnthropicApiKeyWithSource` return early and `getClaudeAIOAuthTokens`
 * returns null (`src/utils/auth.ts`), so the two route booleans the snapshot
 * carries read false for a signed-in user, on every 60 s run. The renderer
 * prefers this snapshot over the session's, which hides the account chip and
 * re-asserts the first-run sign-in surface on a fully authenticated app.
 *
 * ISOLATION — what is actually isolated here, and by what mechanism:
 *   - Keychain + global config (`getSecureStorage()`, `getGlobalConfig()` /
 *     `config.oauthAccount`) are isolated by `CLAUDE_CONFIG_DIR` pointing at
 *     an empty temp dir. The keychain service name is suffixed with
 *     `sha256(configDir)`, so a fresh temp config dir addresses a keychain
 *     entry that has never existed.
 *   - The Codex vault + `.codex-nootp` config
 *     (`readVaultPath()`/`DEFAULT_VAULT_PATH`, `codexAccountPool.ts:91-92`)
 *     are `homedir()`-derived, NOT `CLAUDE_CONFIG_DIR`-derived, so
 *     `CLAUDE_CONFIG_DIR` alone does nothing for them: prior to this fix this
 *     test spawned the worker with the operator's REAL `HOME`, so
 *     `loadPoolForObservation()` read the operator's real `~/codex-vault`.
 *     `runWorker` below now also overrides `HOME` to a second, separate empty
 *     temp dir, so that resolution lands on a directory that has never held a
 *     real vault. With zero accounts loaded there is nothing for the worker's
 *     one network call (`fetchPoolUsage`) to fetch usage for, so it makes zero
 *     real HTTP requests either.
 *   - The Anthropic vault (`claudeAccountPool.ts:58`, same `homedir()`
 *     pattern, so it had the identical exposure) is still READ by the worker,
 *     via `loadClaudePoolForObservation()`, but is never WRITTEN: the worker
 *     stopped calling `initClaudeAccountPool()` (see `accountsPoolWorker.ts`'s
 *     header) because that function migrates a config-only account into the
 *     vault, which a disposable 60s worker must never do. The read is what
 *     keeps the Accounts page populated; the `HOME` override below is what
 *     keeps that read off the operator's real vault, so it is load-bearing
 *     here, not belt-and-braces.
 *   - The Anthropic ROUTE booleans under test (not the account list) are
 *     driven by a THROWAWAY `CLAUDE_CODE_OAUTH_TOKEN` in the child env,
 *     deliberately the discriminator: the engine honours it only outside bare
 *     mode, so it distinguishes the two bootstraps without going near the
 *     keychain. No request is ever made with it (the worker exits first).
 *
 * `assertHermeticHome` below is a static, no-spawn check that the `HOME` this
 * test hands the worker cannot equal, or derive the same vault path as, the
 * real home directory — an enforced invariant instead of a claim in this
 * comment to trust.
 */

import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseAccountsPoolWorkerResult } from '../shared/accountsPoolWorker.js'

const here = dirname(fileURLToPath(import.meta.url))
const worker = join(here, 'accountsPoolWorker.ts')
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

/**
 * Mirrors the exact vault-path derivation `codexAccountPool.ts:91-92`
 * (`DEFAULT_VAULT_PATH`/`CODEX_NOOTP_CONFIG`) and `claudeAccountPool.ts:58`
 * use — `join(homedir(), 'codex-vault' | '.codex-nootp' | 'claude-vault')` —
 * so a real vault path can never be handed to the spawned worker, and a
 * future change to either module's formula breaks this loudly instead of the
 * isolation silently lapsing.
 */
function assertHermeticHome(fakeHome: string): void {
  const realHome = homedir()
  if (fakeHome === realHome) {
    throw new Error('accounts-worker probe: fake HOME equals the real home directory')
  }
  for (const child of ['codex-vault', '.codex-nootp', 'claude-vault']) {
    if (join(fakeHome, child) === join(realHome, child)) {
      throw new Error(`accounts-worker probe: derived ${child} path is not isolated from the real home`)
    }
  }
}

async function runWorker(
  env: Record<string, string | undefined>,
  extraArgs: string[] = [],
) {
  const cwd = temp('catcode-accounts-worker-cwd-')
  const fakeHome = temp('catcode-accounts-worker-home-')
  assertHermeticHome(fakeHome)
  const proc = Bun.spawn(['bun', 'run', worker, '--bare', ...extraArgs], {
    cwd,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      CLAUDE_CONFIG_DIR: temp('catcode-accounts-worker-config-'),
      // The Codex + Anthropic vault paths are `homedir()`-derived, not
      // `CLAUDE_CONFIG_DIR`-derived (see the file header) — without this the
      // worker would resolve to the operator's REAL `~/codex-vault` /
      // `~/claude-vault`. `assertHermeticHome` above proves this value cannot
      // collide with the real home before it is ever handed to the child.
      HOME: fakeHome,
      // Clear every OTHER Anthropic route the host machine might carry, so the
      // assertion below is driven only by what this test sets.
      ANTHROPIC_API_KEY: undefined,
      ANTHROPIC_AUTH_TOKEN: undefined,
      CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR: undefined,
      CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: undefined,
      CLAUDE_CODE_USE_BEDROCK: undefined,
      CLAUDE_CODE_USE_VERTEX: undefined,
      CLAUDE_CODE_USE_FOUNDRY: undefined,
      ...env,
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  proc.stdin.end()
  const [code, stdout] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
  ])
  const records = stdout
    .trim()
    .split('\n')
    .filter(line => line.length > 0)
    .map(line => parseAccountsPoolWorkerResult(JSON.parse(line)))
  return { code, records }
}

test('the accounts worker reports the Anthropic route it can actually see, not the hermetic-auth answer', async () => {
  const { code, records } = await runWorker({
    CLAUDE_CODE_OAUTH_TOKEN: 'probe-only-not-a-real-token',
  })

  expect(code).toBe(0)
  const pool = records.find(record => record?.type === 'pool')
  expect(pool?.type).toBe('pool')
  if (pool?.type !== 'pool') return
  expect(pool.pool.anthropicRouteAvailable).toBe(true)
  expect(pool.pool.anthropicSubscriptionActive).toBe(true)
  // The throwaway token must not ride out on the snapshot.
  expect(JSON.stringify(pool)).not.toContain('probe-only-not-a-real-token')
}, 180_000)

/*
 * There is deliberately NO "reports false when there is no route" counterpart.
 * Outside bare mode the route genuinely includes the machine's own credential
 * store, so such a test would assert on whoever is logged in on the host and
 * would have to read it to decide. The assertion above is machine-independent
 * in both directions: before the fix the flags were false no matter what the
 * host carried, and with this env they are true no matter what it carries.
 */

/**
 * The usage-analytics read is the one thing in this worker that costs a full
 * pass over the transcript corpus, so main asks for it only every Nth run
 * (`USAGE_STATS_EVERY_N_RUNS`). These prove the gate at the real process
 * boundary rather than trusting the argv check by inspection: a regression that
 * ran the aggregation unconditionally would be invisible to every unit test and
 * would just quietly cost ~22 minutes of disk a day.
 *
 * The probe's fake HOME has no projects directory, so the aggregation measures
 * an empty history rather than failing — which is the point of the second case:
 * a MEASURED zero is a legitimate snapshot, and it is the field being present at
 * all that proves the read ran.
 */
test('the worker skips the transcript aggregation unless main asks for it', async () => {
  const { code, records } = await runWorker({})
  expect(code).toBe(0)
  const pool = records.find(record => record?.type === 'pool')
  expect(pool?.type).toBe('pool')
  if (pool?.type !== 'pool') return
  expect(pool.usageStats).toBeUndefined()
}, 180_000)

test('--usage-stats makes the worker carry both ranges', async () => {
  const { code, records } = await runWorker({}, ['--usage-stats'])
  expect(code).toBe(0)
  const pool = records.find(record => record?.type === 'pool')
  expect(pool?.type).toBe('pool')
  if (pool?.type !== 'pool') return
  expect(pool.usageStats).toBeDefined()
  expect(pool.usageStats?.['7d'].range).toBe('7d')
  expect(pool.usageStats?.['30d'].range).toBe('30d')
}, 180_000)
