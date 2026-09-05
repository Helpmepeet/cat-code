/**
 * RAM-0 hermetic sidecar memory probe (measurement instrument, NO secrets).
 *
 * Spawns exactly ONE real Bun sidecar (`app/sidecar/index.ts`) in a fully
 * sandboxed environment and samples its resident memory over a dwell, then
 * kills it and VERIFIES the process is gone. It is the durable, re-runnable
 * instrument the RAM-0 protocol (audit §RAM-0 / F1) requires: the predecessor
 * PER-SESSION-COST / cut-list numbers were single-run scratch scripts that were
 * never retained.
 *
 * Sandbox (hermetic, account-free):
 *   - `CLAUDE_CONFIG_DIR` → a caller-supplied fresh dir (the corpus lives under
 *     `<configDir>/projects/`); the engine's config home + credential vault are
 *     both keyed off this (`envUtils.ts:15`), so a fresh dir is keyless.
 *   - credential env vars deleted (ANTHROPIC_API_KEY, OPENAI_API_KEY, OAuth …)
 *     → boot is keyless (boot needs no key; only a live turn does).
 *   - network poisoned: HTTP(S)/ALL proxy → 127.0.0.1:9 (closed), plus
 *     DISABLE_AUTOUPDATER / CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC / CI so the
 *     best-effort startup GETs fail fast instead of reaching the internet.
 *   - idle TTL disabled (`CATCODE_SIDECAR_IDLE_TTL_MS=0`) so the janitor never
 *     reaps the process mid-measurement.
 *
 * Memory: RSS via `ps` AND macOS physical footprint (+ peak) via
 * `vmmap --summary`. Every raw `ps`/`vmmap` capture is written to the out dir
 * (retained — the F1 defect was discarding raw output).
 *
 * Lifecycle safety: the spawned PID is written to `<out>/<label>.pids` the
 * instant it exists; a `finally` kills it (+ any children) and asserts via
 * `ps -p` that nothing survived, recording the result in the JSON.
 *
 * Usage (single run):
 *   bun run app/scripts/ram-probe.ts \
 *     --config-dir <dir> --label boot600 --out <outDir> \
 *     --mode real --attach --dwell-ms 240000 --sample-ms 30000 \
 *     [--mimalloc-purge-delay 0]
 *
 * Prints the run result as JSON to stdout.
 */

import { spawn as bunSpawn } from 'bun'
import { connect, type Socket } from 'node:net'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  descendantPids,
  hermeticSidecarEnv,
  isAlive,
  parseArgs,
  psRssMB,
  sleep,
  vmmapSummary,
  waitForSocket,
} from './ramInstrument.js'

const here = dirname(fileURLToPath(import.meta.url))
const SIDECAR_ENTRY = join(here, '..', 'sidecar', 'index.ts')

type Sample = {
  label: string
  elapsedMs: number
  rssMB: number | null
  footprintMB: number | null
  footprintPeakMB: number | null
}

// ---- Lifecycle safety: never leak the spawned sidecar (review F2) ----
// A SIGTERM/SIGINT/SIGHUP during the dwell would otherwise bypass run()'s
// `finally` and orphan the sidecar. Register handlers that synchronously kill the
// whole process tree before exiting; `cleaned` makes it idempotent so a signal
// and the finally cannot double-run.
let activeProc: ReturnType<typeof bunSpawn> | null = null
let activeSock: Socket | null = null
let cleaned = false

/**
 * SIGKILL one raw pid. Only ever called for a descendant captured while its
 * parent was provably alive — a pid whose process has exited is free for the OS
 * to reuse, so signalling it by number could hit an unrelated process.
 */
function killPid(pid: number): void {
  try { execFileSync('kill', ['-9', String(pid)]) } catch { /* already gone */ }
}

/** True once Bun has reaped the child — its pid must not be signalled again. */
function hasExited(proc: ReturnType<typeof bunSpawn>): boolean {
  return proc.exitCode !== null || proc.signalCode !== null
}

/** Kill the sidecar through its Bun handle (never by pid), descendants first. */
function killSidecar(proc: ReturnType<typeof bunSpawn>): void {
  if (hasExited(proc)) return
  const pid = proc.pid
  if (pid) for (const kid of descendantPids(pid)) killPid(kid)
  proc.kill(9)
}

function emergencyCleanup(): void {
  if (cleaned) return
  cleaned = true
  try { activeSock?.destroy() } catch { /* ignore */ }
  if (activeProc) killSidecar(activeProc)
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(sig, () => {
    emergencyCleanup()
    process.exit(1)
  })
}

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const configDir = args['config-dir']
  const label = args.label ?? 'run'
  // Inside the app package, where .gitignore covers .ram-scratch/ whatever cwd
  // the probe was invoked from (the documented usage runs it from the repo root).
  const outDir = args.out ?? join(here, '..', '.ram-scratch', 'out')
  const mode = args.mode ?? 'real' // real | probe
  const attach = args.attach === 'true' || args.attach === undefined ? args.attach === 'true' : false
  const doAttach = 'attach' in args
  const dwellMs = Number(args['dwell-ms'] ?? '240000')
  const sampleMs = Number(args['sample-ms'] ?? '30000')
  const mimallocPurgeDelay = args['mimalloc-purge-delay']
  const settleMs = Number(args['settle-ms'] ?? '2500')

  if (!configDir) {
    process.stderr.write('ram-probe: --config-dir is required\n')
    process.exit(2)
  }
  mkdirSync(outDir, { recursive: true })

  // Sandbox cwd for the engine's project identity (must be a real directory).
  const socketDir = mkdtempSync(join('/tmp', 'ram0-'))
  const socketPath = join(socketDir, 's.sock')
  const cwdDir = join(socketDir, 'cwd')
  mkdirSync(cwdDir, { recursive: true })

  const pidFile = join(outDir, `${label}.pids`)
  const rawFile = join(outDir, `${label}.vmmap.txt`)
  const stderrFile = join(outDir, `${label}.sidecar.stderr.log`)

  const env = hermeticSidecarEnv({
    configDir,
    socketPath,
    sessionId: `ram0-${label}`,
    cwdDir,
  })
  if (mode === 'probe') env.CATCODE_SIDECAR_PROBE = '1'
  if (mimallocPurgeDelay !== undefined) env.MIMALLOC_PURGE_DELAY = String(mimallocPurgeDelay)

  const stderrChunks: string[] = []
  let proc: ReturnType<typeof bunSpawn> | null = null
  let sock: Socket | null = null
  const samples: Sample[] = []
  const t0 = Date.now()

  const sample = (lbl: string): void => {
    const pid = proc?.pid
    if (!pid) return
    const rssMB = psRssMB(pid)
    const { raw, footprintMB, peakMB } = vmmapSummary(pid)
    appendFileSync(
      rawFile,
      `\n===== ${lbl} @ ${((Date.now() - t0) / 1000).toFixed(1)}s pid=${pid} rss=${rssMB}MB footprint=${footprintMB}MB peak=${peakMB}MB =====\n${raw}\n`,
    )
    samples.push({ label: lbl, elapsedMs: Date.now() - t0, rssMB, footprintMB, footprintPeakMB: peakMB })
    process.stderr.write(`[probe:${label}] ${lbl} rss=${rssMB}MB footprint=${footprintMB}MB peak=${peakMB}MB\n`)
  }

  let killVerified = false
  let survivors: number[] = []
  try {
    writeFileSync(rawFile, `# RAM-0 raw vmmap captures — label=${label} mode=${mode} attach=${doAttach && attach}\n`)
    proc = bunSpawn(['bun', 'run', SIDECAR_ENTRY], {
      cwd: cwdDir,
      env,
      stdout: 'ignore',
      stderr: 'pipe',
    })
    // Record the PID the instant it exists.
    writeFileSync(pidFile, `${proc.pid}\n`)
    activeProc = proc

    // Drain stderr for diagnostics (READY line, resume/fatal).
    void (async () => {
      try {
        const reader = (proc!.stderr as ReadableStream<Uint8Array>).getReader()
        const dec = new TextDecoder()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          const s = dec.decode(value)
          stderrChunks.push(s)
          appendFileSync(stderrFile, s)
        }
      } catch { /* process gone */ }
    })()

    await waitForSocket(socketPath)
    // Let boot fully settle (module graph + init + controller construction) so
    // the "boot floor" is the real listening-idle plateau, not a mid-init dip.
    await sleep(settleMs)
    sample('boot')

    if (doAttach && attach) {
      sock = connect({ path: socketPath })
      activeSock = sock
      sock.on('error', () => { /* the process may exit under teardown */ })
      sock.on('data', () => { /* drain attach snapshots + refresh broadcasts */ })
      await new Promise<void>((resolve, reject) => {
        sock!.once('connect', resolve)
        sock!.once('error', reject)
      })
      // First catalog enumeration is kicked on attach (sidecarServer.ts:588);
      // give it time to complete before the first attached sample.
      await sleep(settleMs)
      sample('attached-first-enum')

      // Sample every sampleMs across the dwell — the 30s catalog re-enumeration
      // (sidecarServer.ts:449) drives the allocator toward its plateau.
      const deadline = Date.now() + dwellMs
      let cycle = 1
      while (Date.now() < deadline) {
        await sleep(Math.min(sampleMs, Math.max(0, deadline - Date.now())))
        sample(`attached-cycle-${cycle}`)
        cycle++
      }
    } else {
      // Boot-floor-only (no attach): hold briefly and resample to confirm the
      // listening-idle floor is stable.
      await sleep(Math.min(dwellMs, 5000))
      sample('boot-settled')
    }
  } finally {
    // ---- Kill + verify the FULL process tree (lifecycle safety, review F2) ----
    cleaned = true // a late signal must not re-run cleanup on top of this
    try { sock?.destroy() } catch { /* ignore */ }
    if (proc && hasExited(proc)) {
      // The sidecar exited on its own (crash / self-exit). Nothing survives, and
      // its pid may already belong to another process, so it is not touched.
      killVerified = true
      appendFileSync(pidFile, 'killVerified=true survivors=none (exited on its own)\n')
    } else if (proc?.pid) {
      const pid = proc.pid
      const tree = descendantPids(pid) // gather BEFORE killing — dead parents lose their children
      killSidecar(proc)
      // Wait for the OS to reap.
      const waitStart = Date.now()
      while ([pid, ...tree].some(isAlive) && Date.now() - waitStart < 5000) {
        await sleep(100)
      }
      survivors = [pid, ...tree].filter(isAlive)
      killVerified = survivors.length === 0
      appendFileSync(pidFile, `killVerified=${killVerified} survivors=${survivors.join(',') || 'none'}\n`)
    }
    try { rmSync(socketDir, { recursive: true, force: true }) } catch { /* ignore */ }
  }

  const result = {
    label,
    mode,
    attached: doAttach && attach,
    dwellMs,
    sampleMs,
    mimallocPurgeDelay: mimallocPurgeDelay ?? null,
    configDir,
    sidecarEntry: SIDECAR_ENTRY,
    reachedReady: stderrChunks.join('').includes('[sidecar] READY'),
    killVerified,
    survivors,
    samples,
    rawVmmapFile: rawFile,
    pidFile,
    stderrTail: stderrChunks.join('').split('\n').slice(-6).join('\n'),
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  // A surviving sidecar is a cleanup failure, not a valid measurement (review F2).
  if (!killVerified) process.exitCode = 3
}

run().catch(err => {
  process.stderr.write(`ram-probe fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`)
  process.exit(1)
})
