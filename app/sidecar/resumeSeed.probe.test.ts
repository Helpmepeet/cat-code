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
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
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

function startChild(opts: {
  entry: string
  args: string[]
  cwd: string
  configHome: string
  extraEnv?: Record<string, string>
}): {
  pid: number
  result: Promise<{ pid: number; code: number; stdout: string; stderr: string }>
} {
  const proc = Bun.spawn(['bun', 'run', opts.entry, ...opts.args], {
    cwd: opts.cwd,
    env: {
      ...process.env,
      HOME: opts.configHome,
      CLAUDE_CONFIG_DIR: opts.configHome,
      NODE_ENV: 'development',
      ...opts.extraEnv,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const pid = proc.pid
  const result = (async () => {
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      const completed = Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])
      const [code, stdout, stderr] = await Promise.race([
        completed,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            proc.kill()
            reject(new Error(`child PID ${pid} timed out`))
          }, TEST_TIMEOUT_MS - 5_000)
        }),
      ])
      return { pid, code, stdout, stderr }
    } finally {
      if (timeout) clearTimeout(timeout)
    }
  })()
  return { pid, result }
}

async function runChild(
  opts: Parameters<typeof startChild>[0],
): Promise<{ pid: number; code: number; stdout: string; stderr: string }> {
  return startChild(opts).result
}

async function waitForPidMarker(path: string, expectedPid: number): Promise<void> {
  const startedAt = Date.now()
  while (!existsSync(path)) {
    if (Date.now() - startedAt > 30_000) {
      throw new Error(`child PID ${expectedPid} did not publish readiness`)
    }
    await Bun.sleep(20)
  }
  expect(Number(readFileSync(path, 'utf8'))).toBe(expectedPid)
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
    replayMatchesVisibleEngineSeed: boolean
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
  // The visible replay may carry an archival prefix, but its aligned tail is
  // still the exact visible model seed; recovery sentinels stay internal.
  expect(result.replayMatchesVisibleEngineSeed).toBe(true)
}, TEST_TIMEOUT_MS)

test('P5-5c: a second sidecar cannot resume the same engine transcript', async () => {
  const configHome = tmp('catcode-coexist-cfg-')
  const cwd = tmp('catcode-coexist-wd-')
  const engineSessionId = randomUUID()
  const marker = `nonce-${randomUUID()}`
  const readyFile = join(configHome, 'holder.ready')
  const releaseFile = join(configHome, 'holder.release')

  const mint = await runChild({
    entry: minter,
    args: [engineSessionId, marker],
    cwd,
    configHome,
    extraEnv: { TEST_ENABLE_SESSION_PERSISTENCE: '1' },
  })
  expect(mint.code).toBe(0)

  const holder = startChild({
    entry: seedProbe,
    args: [engineSessionId, marker, readyFile, releaseFile],
    cwd,
    configHome,
  })
  await waitForPidMarker(readyFile, holder.pid)
  const terminalRegistryDir = join(configHome, 'sessions')
  expect(
    existsSync(terminalRegistryDir)
      ? readdirSync(terminalRegistryDir).includes(`${holder.pid}.json`)
      : false,
  ).toBe(false)

  const competing = await runChild({
    entry: seedProbe,
    args: [engineSessionId, marker],
    cwd,
    configHome,
  })
  expect(competing.code).not.toBe(0)
  expect(competing.stderr).toContain('already open in another Cat Code process')

  writeFileSync(releaseFile, 'release')
  expect((await holder.result).code).toBe(0)

  const afterExit = await runChild({
    entry: seedProbe,
    args: [engineSessionId, marker],
    cwd,
    configHome,
  })
  expect(afterExit.code).toBe(0)
}, TEST_TIMEOUT_MS)

test('F1/F2 projection wiring: archival display replay preserves the exact visible engine-seed tail', () => {
  // Source-level guarantee (mainSource.test idiom): model context is seeded
  // only from resumedMessages. Display history is loaded separately, then the
  // visible resumedMessages projection replaces its aligned tail byte-for-byte.
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
  expect(source).toContain('initialMessages: resumedMessages')
  expect(source).toContain('projectCurrentDisplayHistory(resumedMessages)')
  expect(source).toContain('projectResumedHistory(retainedMessages)')
  expect(source).toContain('loadDisplayTranscriptFromJsonlPath(')
  expect(source).toContain('mergeDisplayHistoryWithSeed(')
  // And resumedMessages has exactly one assignment site (the resume result).
  const assignments = source.match(/resumedMessages =/g) ?? []
  expect(assignments.length).toBe(1)
  expect(source).toContain('resumedMessages = resumed.messages')
})
