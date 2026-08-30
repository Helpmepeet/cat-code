/**
 * Codex prompt_cache_key rebind probe (round10 finding 4).
 *
 * TEST EVIDENCE
 * - Claim: `initializeSidecarRuntime` (app/sidecar/initializeRuntime.ts) binds
 *   the Codex prompt_cache_key to the engine session id, and re-pins it via
 *   `onSessionSwitch` when a later `switchSession` call adopts a different
 *   (durable, resumed) id — mirroring `src/setup.ts:90` and `:97-99`. Before
 *   the fix, the sidecar never called `setCodexPromptCacheKey` at all (the
 *   only Codex-cache call anywhere in `app/` was `resetCodexCacheContext()`,
 *   `app/sidecar/accountsDomain.ts:564`, which only clears the derived map),
 *   so `codex-fetch-adapter.ts` fell back to its own per-process random
 *   `CODEX_SESSION_ID` (`src/services/api/codex-fetch-adapter.ts:68`). Two
 *   sidecar processes that both adopt the SAME durable session id therefore
 *   computed DIFFERENT Codex conversation ids, sending a cold prompt-cache
 *   prefix on every sidecar respawn (idle-park, crash restart, window reopen
 *   — `app/supervisor/supervisor.ts:360`, `app/sidecar/index.ts:200`).
 * - Production entry point: `app/sidecar/index.ts:217` calls
 *   `initializeSidecarRuntime()` BEFORE `resumeEngineSession()` (`:244`);
 *   resume's `processResumedConversation` internally calls `switchSession`
 *   (`app/sidecar/sessionResume.ts:14`), which fires `onSessionSwitch`.
 * - Proof layer: process. Two real, separate Bun processes each run the real
 *   `initializeSidecarRuntime()` production function
 *   (`codexCacheKeyBind.fixture.ts`), then adopt the same durable id via the
 *   exact `switchSession` call resume makes internally. No credentials and no
 *   model call — this only derives a cache key, never sends a request.
 * - UNVERIFIED here: that a live Codex account request actually reuses the
 *   server-side cache (needs a real API call, out of scope — a cache-key
 *   derivation test must never burn quota), and that a full
 *   transcript-backed `resumeEngineSession()` calls `switchSession` at the
 *   right point — that path is documented and exercised by
 *   `sessionResume.probe.test.ts` and `sessionResume.ts`'s own doc comment,
 *   not re-proven here to avoid taking the same transcript's resume lease
 *   twice in a row across two real processes (unrelated machinery).
 *
 * Run: `bun test app/sidecar/codexCacheKeyResume.probe.test.ts`
 */

import { afterEach, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  _getConversationIdForRequestForTest,
  setCodexPromptCacheKey,
} from '../../src/services/api/codex-fetch-adapter.js'

const here = dirname(fileURLToPath(import.meta.url))
const bindProbe = join(here, 'codexCacheKeyBind.fixture.ts')

// Each run boots the full engine graph in a cold Bun process.
const TEST_TIMEOUT_MS = 120_000

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function readValue(stdout: string, key: string): string {
  const line = stdout.split('\n').find(entry => entry.startsWith(`${key}=`))
  if (!line) throw new Error(`fixture did not report ${key}: ${stdout}`)
  return line.slice(key.length + 1)
}

async function run(
  command: string[],
  cwd: string,
  configHome: string,
): Promise<string> {
  const child = Bun.spawn(['bun', 'run', ...command], {
    cwd,
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: configHome,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (code !== 0) {
    throw new Error(`${command[0]} failed (exit ${code}): ${stderr}`)
  }
  return stdout
}

test('two sidecar processes that adopt the same durable session id derive the same Codex conversation id', async () => {
  const configHome = tmp('catcode-codex-cache-cfg-')
  const cwd = tmp('catcode-codex-cache-cwd-')
  const durableSessionId = randomUUID()
  const accountId = 'probe-account'
  const model = 'gpt-5.6-sol'

  const outA = await run(
    [bindProbe, accountId, model, durableSessionId],
    cwd,
    configHome,
  )
  const outB = await run(
    [bindProbe, accountId, model, durableSessionId],
    cwd,
    configHome,
  )

  const sessionIdA = readValue(outA, 'BOUND_SESSION_ID')
  const sessionIdB = readValue(outB, 'BOUND_SESSION_ID')
  const convIdA = readValue(outA, 'CONV_ID')
  const convIdB = readValue(outB, 'CONV_ID')

  // Control: both processes actually adopted the SAME durable id (this half
  // is pre-existing switchSession behavior, unaffected by the fix).
  expect(sessionIdA).toBe(durableSessionId)
  expect(sessionIdB).toBe(durableSessionId)

  // The fix under test: two separate processes pinned to the same durable
  // session id must compute the same Codex conversation id, not each
  // process's own random per-process fallback.
  expect(convIdA).toBe(convIdB)

  // Independently reproduce the expected value in THIS process to prove the
  // shared id is actually derived from the durable session id, not just
  // accidentally equal to each other.
  setCodexPromptCacheKey(durableSessionId)
  const expected = _getConversationIdForRequestForTest(accountId, model)
  expect(convIdA).toBe(expected)
}, TEST_TIMEOUT_MS)
