/**
 * IDLE-PARK fleet reclaim probe (measurement instrument, NO secrets).
 *
 * Proves idle-park (decisions/IDLE-PARK.md; merged ea5558c) reclaims the engine
 * process at the FLEET level and quantifies it — fully headless, no GUI, no
 * supervisor, no renderer. It:
 *   1. spawns N real Bun sidecars via the production entrypoint
 *      (`app/sidecar/index.ts`, exactly as ram-probe.ts:262) — that entrypoint
 *      wires the real `onPark` closure (index.ts:220 → PARKED_EXIT_CODE exit), so
 *      an `app.park` frame actually triggers the self-exit;
 *   2. waits until all reach READY, dwells, then sums RSS (`ps`) + physical
 *      footprint (`vmmap --summary`) across every live PID (baseline);
 *   3. parks a subset (default: down to a cap of 2) by opening a socket to each
 *      victim and sending a well-formed `app.park` frame — a freshly-booted idle
 *      sidecar has no active turn / permission / task, so the park gate opens
 *      (sidecarServer.ts:1155 isParkGateOpen) and it self-exits;
 *   4. verifies each victim's process is GONE and observes its exit code
 *      (expects PARKED_EXIT_CODE=5, shared/limits.ts:91);
 *   5. re-measures the SURVIVORS only and reports the delta + per-parked-session
 *      reclaim (drop ÷ victims), sanity-checked against the ~230 MB / ~190 MB
 *      single-engine boot floor (RAM-0 report);
 *   6. kills every remaining sidecar on exit/error/signal with the kill-verify
 *      idiom from ram-probe.ts:322-338 — a leaked sidecar is a failed run.
 *
 * Sandbox (hermetic, account-free — identical policy to ram-probe.ts:210-237):
 * credentials stripped, network poisoned to 127.0.0.1:9, autoupdater/nonessential
 * traffic off, and `CATCODE_SIDECAR_IDLE_TTL_MS=0` so the idle JANITOR (onIdle,
 * index.ts:210) never reaps a process mid-measurement — park (onPark) is the only
 * self-exit we exercise, and it fires ONLY from the `app.park` frame we send.
 * No turns, no provider calls, no login: booting the engine graph + sending
 * `app.park` needs no key.
 *
 * Usage:
 *   bun run app/scripts/ram-fleet.ts [--n 6] [--cap 2] [--out <dir>] \
 *     [--config-dir <shared corpus dir>] [--settle-ms 2500] \
 *     [--ready-timeout-ms 45000] [--park-timeout-ms 15000]
 *
 * Prints the run result as JSON to stdout.
 */

import { spawn as bunSpawn } from 'bun'
import { connect, type Socket } from 'node:net'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PROTOCOL_VERSION } from '../shared/protocol.js'
import { PARKED_EXIT_CODE } from '../shared/limits.js'
import { encodeFrame } from '../shared/framing.js'

const here = dirname(fileURLToPath(import.meta.url))
const SIDECAR_ENTRY = join(here, '..', 'sidecar', 'index.ts')

/** Single-engine boot floor from the RAM-0 report — the reclaim sanity target. */
const BOOT_FLOOR_RSS_MB = 230
const BOOT_FLOOR_FOOTPRINT_MB = 190

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true'
      out[key] = val
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Sampling — verbatim reuse of ram-probe.ts idioms (ram-probe.ts:75-131).
// ---------------------------------------------------------------------------

/** Parse a vmmap size token like "237.4M" / "1.2G" / "512K" / "0" → MB. */
function sizeTokenToMB(tok: string): number | null {
  const m = tok.trim().match(/^([\d.]+)\s*([KMG])?/)
  if (!m) return null
  const n = parseFloat(m[1])
  const unit = m[2]
  if (unit === 'G') return n * 1024
  if (unit === 'M') return n
  if (unit === 'K') return n / 1024
  return n / (1024 * 1024) // bytes
}

function psRssMB(pid: number): number | null {
  try {
    const out = execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' })
    const kb = parseInt(out.trim(), 10)
    return Number.isFinite(kb) ? +(kb / 1024).toFixed(1) : null
  } catch {
    return null
  }
}

function vmmapSummary(pid: number): { footprintMB: number | null; peakMB: number | null } {
  let raw = ''
  try {
    raw = execFileSync('vmmap', ['--summary', String(pid)], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  } catch {
    return { footprintMB: null, peakMB: null }
  }
  let footprintMB: number | null = null
  let peakMB: number | null = null
  for (const line of raw.split('\n')) {
    const peak = line.match(/Physical footprint \(peak\):\s*(.+)$/)
    if (peak) { peakMB = sizeTokenToMB(peak[1]); continue }
    const fp = line.match(/Physical footprint:\s*(.+)$/)
    if (fp) footprintMB = sizeTokenToMB(fp[1])
  }
  return { footprintMB, peakMB }
}

function childPids(pid: number): number[] {
  try {
    const out = execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' })
    return out.split('\n').map(s => parseInt(s.trim(), 10)).filter(n => Number.isFinite(n))
  } catch {
    return []
  }
}

function isAlive(pid: number): boolean {
  try {
    execFileSync('ps', ['-p', String(pid)], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(res => setTimeout(res, ms))
}

async function waitForSocket(socketPath: string, timeoutMs = 45_000): Promise<void> {
  const start = Date.now()
  while (!existsSync(socketPath)) {
    if (Date.now() - start > timeoutMs) throw new Error(`sidecar never bound socket at ${socketPath}`)
    await sleep(50)
  }
}

/** Every descendant pid of `pid`, gathered before any kill (ram-probe.ts:155). */
function descendantPids(pid: number): number[] {
  const kids = childPids(pid)
  return [...kids, ...kids.flatMap(descendantPids)]
}

/** Kill `pid` and all descendants, leaves first so a dead parent can't re-fork. */
function killTree(pid: number): void {
  for (const kid of childPids(pid)) killTree(kid)
  try { execFileSync('kill', ['-9', String(pid)]) } catch { /* already gone */ }
}

// ---------------------------------------------------------------------------
// Lifecycle safety: never leak ANY spawned sidecar (ram-probe.ts:145-179).
// A signal during the run must synchronously kill every live tree before exit.
// ---------------------------------------------------------------------------
type Sidecar = {
  idx: number
  id: string
  socketDir: string
  socketPath: string
  cwdDir: string
  configDir: string
  ownConfigDir: boolean
  proc: ReturnType<typeof bunSpawn>
  stderr: string[]
  role: 'victim' | 'survivor'
}

const fleet: Sidecar[] = []
const openSocks = new Set<Socket>()
let cleaned = false

function emergencyCleanup(): void {
  if (cleaned) return
  cleaned = true
  for (const s of openSocks) { try { s.destroy() } catch { /* ignore */ } }
  for (const sc of fleet) {
    const pid = sc.proc?.pid
    if (pid) killTree(pid)
  }
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(sig, () => {
    emergencyCleanup()
    process.exit(1)
  })
}

// ---------------------------------------------------------------------------
// Env — hermetic, account-free (ram-probe.ts:210-237). Per-sidecar socket /
// session / cwd / config injected by the caller.
// ---------------------------------------------------------------------------
function buildEnv(sc: { socketPath: string; sessionId: string; cwdDir: string; configDir: string }): Record<string, string> {
  const env: Record<string, string> = { ...process.env } as Record<string, string>
  for (const k of [
    'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
    'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN',
    'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN',
    'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_OPENAI',
  ]) delete env[k]
  Object.assign(env, {
    CLAUDE_CONFIG_DIR: sc.configDir,
    CATCODE_SIDECAR_SOCKET: sc.socketPath,
    CATCODE_SIDECAR_SESSION_ID: sc.sessionId,
    CATCODE_SIDECAR_CWD: sc.cwdDir,
    // Disable the idle JANITOR (onIdle) so it never reaps mid-measurement; park
    // (onPark) is the only self-exit we exercise, and only via app.park.
    CATCODE_SIDECAR_IDLE_TTL_MS: '0',
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CI: '1',
    HTTP_PROXY: 'http://127.0.0.1:9',
    HTTPS_PROXY: 'http://127.0.0.1:9',
    ALL_PROXY: 'http://127.0.0.1:9',
    http_proxy: 'http://127.0.0.1:9',
    https_proxy: 'http://127.0.0.1:9',
    all_proxy: 'http://127.0.0.1:9',
    NO_PROXY: '',
  })
  return env
}

/** Drain a sidecar's stderr into its buffer (READY detection + diagnostics). */
function drainStderr(sc: Sidecar): void {
  void (async () => {
    try {
      const reader = (sc.proc.stderr as ReadableStream<Uint8Array>).getReader()
      const dec = new TextDecoder()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        sc.stderr.push(dec.decode(value))
      }
    } catch { /* process gone */ }
  })()
}

function reachedReady(sc: Sidecar): boolean {
  return sc.stderr.join('').includes('[sidecar] READY')
}

async function waitForReady(sc: Sidecar, timeoutMs: number): Promise<void> {
  await waitForSocket(sc.socketPath, timeoutMs)
  const start = Date.now()
  while (!reachedReady(sc)) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`sidecar ${sc.id} bound socket but never printed READY`)
    }
    await sleep(50)
  }
}

type Measure = {
  idx: number
  id: string
  role: 'victim' | 'survivor'
  pid: number | undefined
  rssMB: number | null
  footprintMB: number | null
  footprintPeakMB: number | null
}

function measure(sc: Sidecar): Measure {
  const pid = sc.proc.pid
  const rssMB = pid ? psRssMB(pid) : null
  const { footprintMB, peakMB } = pid ? vmmapSummary(pid) : { footprintMB: null, peakMB: null }
  return { idx: sc.idx, id: sc.id, role: sc.role, pid, rssMB, footprintMB, footprintPeakMB: peakMB }
}

function sum(xs: Array<number | null>): number {
  return +xs.filter((x): x is number => typeof x === 'number').reduce((a, b) => a + b, 0).toFixed(1)
}

/**
 * Park one victim: open a socket, send a well-formed `app.park` frame, then wait
 * for the process to exit. The frame envelope + inner message mirror the
 * contract in protocol.ts:393 (AppParkMessage) / :423 (ClientFrame); the sidecar
 * validates it at its trust boundary (sidecarServer.ts:757 checkStrictKeys →
 * :1107 appParkMessageSchema) and, gate open, calls onPark → exit(5).
 */
async function parkVictim(
  sc: Sidecar,
  parkTimeoutMs: number,
): Promise<{ sentOk: boolean; exited: boolean; exitCode: number | null; parkedCode: boolean; note: string }> {
  const frame = {
    protocolVersion: PROTOCOL_VERSION,
    sessionId: sc.id,
    message: { type: 'app.park' as const, requestId: randomUUID() },
  }

  const sock = connect({ path: sc.socketPath })
  openSocks.add(sock)
  // The sidecar closes the connection + exits right after handling the frame; a
  // reset/close on our end is expected and must not be treated as a failure.
  sock.on('error', () => { /* peer exits under park */ })
  sock.on('data', () => { /* drain the ready/context snapshot frames */ })

  let sentOk = false
  try {
    await new Promise<void>((resolve, reject) => {
      sock.once('connect', resolve)
      sock.once('error', reject)
    })
    sock.write(encodeFrame(frame))
    sentOk = true
  } catch (e) {
    openSocks.delete(sock)
    try { sock.destroy() } catch { /* ignore */ }
    return { sentOk: false, exited: false, exitCode: null, parkedCode: false, note: `connect/write failed: ${e instanceof Error ? e.message : String(e)}` }
  }

  // Wait for the self-exit. proc.exited resolves to the exit code (verified: Bun
  // Subprocess.exited → number). Race a timeout so a refused park is a finding,
  // not a hang.
  let exitCode: number | null = null
  let exited = false
  const timeout = sleep(parkTimeoutMs).then(() => 'timeout' as const)
  const result = await Promise.race([sc.proc.exited.then(c => ({ code: c })), timeout])
  if (result !== 'timeout') {
    exited = true
    exitCode = result.code
  }

  openSocks.delete(sock)
  try { sock.destroy() } catch { /* ignore */ }

  // Cross-check the OS view: the PID must be gone.
  const pid = sc.proc.pid
  const pidGone = pid ? !isAlive(pid) : true
  const parkedCode = exitCode === PARKED_EXIT_CODE
  let note = ''
  if (!exited) note = `did NOT exit within ${parkTimeoutMs}ms (park refused or hung)`
  else if (!parkedCode) note = `exited with code ${exitCode}, expected PARKED_EXIT_CODE=${PARKED_EXIT_CODE}`
  else if (!pidGone) note = `exited(code ${exitCode}) but PID ${pid} still visible to ps`
  else note = `parked cleanly (exit ${exitCode})`

  return { sentOk, exited: exited && pidGone, exitCode, parkedCode, note }
}

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const n = Number(args.n ?? '6')
  const cap = Number(args.cap ?? '2')
  const outDir = args.out ?? join(process.cwd(), '.ram-scratch', 'fleet')
  const sharedConfigDir = args['config-dir'] // optional shared corpus; else per-sidecar empty
  const settleMs = Number(args['settle-ms'] ?? '2500')
  const readyTimeoutMs = Number(args['ready-timeout-ms'] ?? '45000')
  const parkTimeoutMs = Number(args['park-timeout-ms'] ?? '15000')

  if (!Number.isFinite(n) || n < 2) {
    process.stderr.write('ram-fleet: --n must be >= 2\n')
    process.exit(2)
  }
  if (!Number.isFinite(cap) || cap < 1 || cap >= n) {
    process.stderr.write('ram-fleet: --cap must satisfy 1 <= cap < n\n')
    process.exit(2)
  }
  const victims = n - cap
  mkdirSync(outDir, { recursive: true })
  const pidFile = join(outDir, 'fleet.pids')
  writeFileSync(pidFile, `# ram-fleet PIDs — n=${n} cap=${cap} victims=${victims}\n`)

  // ---- 1. Spawn N real sidecars via the production entrypoint. -------------
  for (let i = 0; i < n; i++) {
    const socketDir = mkdtempSync(join('/tmp', 'ramfleet-'))
    const socketPath = join(socketDir, 's.sock')
    const cwdDir = join(socketDir, 'cwd')
    mkdirSync(cwdDir, { recursive: true })
    const ownConfigDir = !sharedConfigDir
    let configDir: string
    if (sharedConfigDir) {
      configDir = sharedConfigDir
    } else {
      configDir = join(socketDir, 'config')
      mkdirSync(configDir, { recursive: true })
    }
    const id = `ramfleet-${i}-${randomUUID().slice(0, 8)}`
    const role: 'victim' | 'survivor' = i < victims ? 'victim' : 'survivor'

    const env = buildEnv({ socketPath, sessionId: id, cwdDir, configDir })
    const proc = bunSpawn(['bun', 'run', SIDECAR_ENTRY], {
      cwd: cwdDir,
      env,
      stdout: 'ignore',
      stderr: 'pipe',
    })
    const sc: Sidecar = { idx: i, id, socketDir, socketPath, cwdDir, configDir, ownConfigDir, proc, stderr: [], role }
    fleet.push(sc)
    appendFileSync(pidFile, `${proc.pid} ${role} ${id}\n`)
    drainStderr(sc)
  }

  let baseline: Measure[] = []
  let postPark: Measure[] = []
  const parkResults: Array<{ id: string; idx: number } & Awaited<ReturnType<typeof parkVictim>>> = []
  let readyFailures: string[] = []
  let killVerified = false
  let leaked: number[] = []

  try {
    // ---- 2. Wait for READY, then dwell. ------------------------------------
    for (const sc of fleet) {
      try {
        await waitForReady(sc, readyTimeoutMs)
      } catch (e) {
        readyFailures.push(`${sc.id}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    if (readyFailures.length > 0) {
      throw new Error(`sidecars failed to reach READY: ${readyFailures.join(' | ')}`)
    }
    await sleep(settleMs)

    // ---- 3. Aggregate baseline across all N live sidecars. -----------------
    baseline = fleet.map(measure)
    for (const m of baseline) {
      process.stderr.write(`[fleet:baseline] ${m.role} idx=${m.idx} pid=${m.pid} rss=${m.rssMB}MB footprint=${m.footprintMB}MB\n`)
    }

    // ---- 4. Park the victims (sequential: clean per-victim observation). ----
    for (const sc of fleet.filter(s => s.role === 'victim')) {
      process.stderr.write(`[fleet:park] parking ${sc.id} (pid=${sc.proc.pid})…\n`)
      const r = await parkVictim(sc, parkTimeoutMs)
      parkResults.push({ id: sc.id, idx: sc.idx, ...r })
      process.stderr.write(`[fleet:park] ${sc.id}: ${r.note}\n`)
    }

    // ---- 5. Re-measure the SURVIVORS only. ---------------------------------
    // Small dwell so the survivors settle after the churn of parking.
    await sleep(500)
    postPark = fleet.filter(s => s.role === 'survivor').map(measure)
    for (const m of postPark) {
      process.stderr.write(`[fleet:post] ${m.role} idx=${m.idx} pid=${m.pid} rss=${m.rssMB}MB footprint=${m.footprintMB}MB\n`)
    }
  } finally {
    // ---- 7. Kill + verify EVERY remaining sidecar (ram-probe.ts:322-338). --
    cleaned = true // a late signal must not re-run cleanup on top of this
    for (const s of openSocks) { try { s.destroy() } catch { /* ignore */ } }
    // Gather full trees BEFORE killing (dead parents lose their children).
    const allPids: number[] = []
    const trees: number[] = []
    for (const sc of fleet) {
      const pid = sc.proc.pid
      if (!pid) continue
      allPids.push(pid)
      trees.push(...descendantPids(pid))
    }
    for (const sc of fleet) {
      const pid = sc.proc.pid
      if (pid && isAlive(pid)) killTree(pid)
    }
    const watch = [...new Set([...allPids, ...trees])]
    const waitStart = Date.now()
    while (watch.some(isAlive) && Date.now() - waitStart < 5000) {
      await sleep(100)
    }
    leaked = watch.filter(isAlive)
    killVerified = leaked.length === 0
    appendFileSync(pidFile, `killVerified=${killVerified} leaked=${leaked.join(',') || 'none'}\n`)
    for (const sc of fleet) {
      try { rmSync(sc.socketDir, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  }

  // ---- 6. Report the delta. ------------------------------------------------
  const baseVictims = baseline.filter(m => m.role === 'victim')
  const baseSurvivors = baseline.filter(m => m.role === 'survivor')

  const baselineTotalRSS = sum(baseline.map(m => m.rssMB))
  const baselineTotalFootprint = sum(baseline.map(m => m.footprintMB))
  const postTotalRSS = sum(postPark.map(m => m.rssMB))
  const postTotalFootprint = sum(postPark.map(m => m.footprintMB))

  const dropRSS = +(baselineTotalRSS - postTotalRSS).toFixed(1)
  const dropFootprint = +(baselineTotalFootprint - postTotalFootprint).toFixed(1)

  const parkedOk = parkResults.filter(r => r.exited && r.parkedCode).length
  const perVictimReclaimRSS = parkedOk > 0 ? +(dropRSS / parkedOk).toFixed(1) : null
  const perVictimReclaimFootprint = parkedOk > 0 ? +(dropFootprint / parkedOk).toFixed(1) : null

  // Direct cross-check: sum of the victims' OWN baseline RSS should ≈ the drop.
  const victimBaselineRSS = sum(baseVictims.map(m => m.rssMB))
  const victimBaselineFootprint = sum(baseVictims.map(m => m.footprintMB))
  const survivorBaselineRSS = sum(baseSurvivors.map(m => m.rssMB))

  const allParked = parkResults.length === victims && parkResults.every(r => r.exited && r.parkedCode)
  const withinBootFloorBand =
    perVictimReclaimRSS !== null &&
    perVictimReclaimRSS >= BOOT_FLOOR_RSS_MB * 0.6 &&
    perVictimReclaimRSS <= BOOT_FLOOR_RSS_MB * 1.4

  const result = {
    probe: 'app/scripts/ram-fleet.ts',
    sidecarEntry: SIDECAR_ENTRY,
    n,
    cap,
    victims,
    settleMs,
    parkTimeoutMs,
    sharedConfigDir: sharedConfigDir ?? null,
    reachedReadyAll: readyFailures.length === 0,
    readyFailures,
    baseline,
    postPark,
    parkResults,
    aggregate: {
      baselineTotalRSS_MB: baselineTotalRSS,
      baselineTotalFootprint_MB: baselineTotalFootprint,
      postParkTotalRSS_MB: postTotalRSS,
      postParkTotalFootprint_MB: postTotalFootprint,
      dropRSS_MB: dropRSS,
      dropFootprint_MB: dropFootprint,
      victimsParkedOk: parkedOk,
      perParkedSessionReclaimRSS_MB: perVictimReclaimRSS,
      perParkedSessionReclaimFootprint_MB: perVictimReclaimFootprint,
      // Cross-checks:
      victimBaselineRSS_MB: victimBaselineRSS,
      victimBaselineFootprint_MB: victimBaselineFootprint,
      survivorBaselineRSS_MB: survivorBaselineRSS,
      bootFloorExpectation: { rssMB: BOOT_FLOOR_RSS_MB, footprintMB: BOOT_FLOOR_FOOTPRINT_MB },
      withinBootFloorBand,
    },
    allVictimsParkedWithCode5: allParked,
    killVerified,
    leaked,
    pidFile,
  }

  process.stdout.write(JSON.stringify(result, null, 2) + '\n')

  // Exit-code contract for machine-detectable failure:
  //   3 = a sidecar leaked after cleanup (worst — a failed run);
  //   4 = a victim refused to park / wrong exit code (a real finding);
  //   0 = clean reclaim, zero leaks.
  if (!killVerified) process.exitCode = 3
  else if (!allParked) process.exitCode = 4
}

run().catch(err => {
  emergencyCleanup()
  process.stderr.write(`ram-fleet fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`)
  process.exit(1)
})
