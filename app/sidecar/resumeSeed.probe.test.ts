/**
 * F1 acceptance probe (host-plane review 2026-07-05): a restored session
 * OPERATES ON its pre-quit context — the resumed transcript is the live turn
 * context of the real QueryEngine the sidecar serves, not merely a loader
 * return value (the camouflage that hid F1) or an id echo.
 *
 * Same shape as the P3-1 probes: mint a real transcript through the engine's
 * own persistence, then drive `resumeSeedProbe.fixture.ts` in its own Bun
 * process rooted at the session cwd. The fixture runs the REAL resume + the
 * REAL production construction (`createSidecarSessionController` with the
 * seed) and reports the captured QueryEngine's live message state. The live
 * credentialed model-answers-from-context proof remains P3-8's anti-Potemkin
 * gate by design.
 *
 * Run: `bun test app/sidecar/resumeSeed.probe.test.ts`
 */

import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const here = dirname(fileURLToPath(import.meta.url))
const minter = join(here, 'mintTranscript.fixture.ts')
const seedProbe = join(here, 'resumeSeedProbe.fixture.ts')

// Each child boots the full engine graph + init(); well past Bun's 5s default
// on a cold module cache (same headroom as the P3-1 probes).
const TEST_TIMEOUT_MS = 120_000

const tempDirs: string[] = []

afterEach(() => {
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

async function runChild(opts: {
  entry: string
  args: string[]
  cwd: string
  configHome: string
  extraEnv?: Record<string, string>
}): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['bun', 'run', opts.entry, ...opts.args], {
    cwd: opts.cwd,
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: opts.configHome,
      ...opts.extraEnv,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return { code, stdout, stderr }
}

test('F1: the resumed transcript is the live turn context of the engine the sidecar serves', async () => {
  const configHome = tmp('catcode-f1-cfg-')
  const cwd = tmp('catcode-f1-wd-')
  const engineSessionId = randomUUID()
  const marker = `nonce-${randomUUID()}`

  const mint = await runChild({
    entry: minter,
    args: [engineSessionId, marker],
    cwd,
    configHome,
    // bun test sets NODE_ENV=test, which no-ops transcript persistence; opt the
    // mint child back in (the engine's purpose-built test escape hatch).
    extraEnv: { TEST_ENABLE_SESSION_PERSISTENCE: '1' },
  })
  if (mint.code !== 0) {
    throw new Error(`mint failed (exit ${mint.code}): ${mint.stderr}`)
  }

  const probe = await runChild({
    entry: seedProbe,
    args: [engineSessionId, marker],
    cwd,
    configHome,
  })
  if (probe.code !== 0) {
    throw new Error(
      `seed probe failed (exit ${probe.code}): ${probe.stderr}\nstdout: ${probe.stdout}`,
    )
  }
  const line = probe.stdout.split('\n').find(l => l.startsWith('SEED_RESULT='))
  if (!line) {
    throw new Error(
      `seed probe produced no result line.\nstdout: ${probe.stdout}\nstderr: ${probe.stderr}`,
    )
  }
  const result = JSON.parse(line.slice('SEED_RESULT='.length)) as {
    engineSessionId: string
    seededCount: number
    controllerBuilt: boolean
    engineHeldCount: number
    engineHasMarker: boolean
    engineHeldUuidsMatchResumed: boolean
  }

  // Id adoption (the old, insufficient claim) still holds…
  expect(result.engineSessionId).toBe(engineSessionId)
  // …and the production construction accepted the seed…
  expect(result.controllerBuilt).toBe(true)
  expect(result.seededCount).toBe(2)
  // …and the REAL engine's live turn context IS the restored transcript: the
  // pre-quit nonce is in the state submit reads, message-for-message by uuid.
  expect(result.engineHeldCount).toBe(2)
  expect(result.engineHasMarker).toBe(true)
  expect(result.engineHeldUuidsMatchResumed).toBe(true)
}, TEST_TIMEOUT_MS)
