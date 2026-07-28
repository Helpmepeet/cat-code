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
 * ISOLATION — nothing here reads the operator's real credentials.
 * `CLAUDE_CONFIG_DIR` is an empty temp home, so vault and config are empty, and
 * the route is driven by a THROWAWAY `CLAUDE_CODE_OAUTH_TOKEN` in the child
 * env. That variable is deliberately the discriminator: the engine honours it
 * only outside bare mode, so it distinguishes the two bootstraps without going
 * near the keychain. No request is ever made with it (the worker exits first).
 */

import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
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

async function runWorker(env: Record<string, string | undefined>) {
  const cwd = temp('catcode-accounts-worker-cwd-')
  const proc = Bun.spawn(['bun', 'run', worker, '--bare'], {
    cwd,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      CLAUDE_CONFIG_DIR: temp('catcode-accounts-worker-config-'),
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
