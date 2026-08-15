/**
 * Renderer memory trajectory sampler (instrument, NO secrets).
 *
 * Automates the numeric half of the CC-59 Phase 7 live memory gate
 * (`docs/plans/2026-08-15-cc59-transcript-leaf-virtualization-execution.md`).
 * That gate asks a human to hand-record about twenty numbers at five timepoints
 * across three workloads, which nobody will ever do; this samples them on a
 * fixed interval and prints a verdict table. The layout half of the gate
 * (anchor error, bottom gap, does the text look right) stays with the operator
 * and is printed as such, never scored.
 *
 * This script ATTACHES to an app the operator already started. It never
 * launches, drives, or signals the desktop app: launching is a GUI action on
 * the operator's machine (CLAUDE.md §8 rule 8), and the only processes it
 * touches are read-only `vmmap` and `ps` captures of a pid the app itself
 * published.
 *
 * Start the app first, in its own terminal:
 *
 *   cd /Users/pt/cat-code && \
 *   CATCODE_TEST_CWD_ALLOWLIST=/Users/pt/cat-code \
 *   CATCODE_INITIAL_CWD=/Users/pt/cat-code \
 *   CATCODE_DEBUG_STATE=1 \
 *   bun run --cwd app dev
 *
 * Then, in a second terminal, run the workload in the app while this samples:
 *
 *   cd /Users/pt/cat-code && \
 *   bun run app/scripts/renderer-memory-trajectory.ts --workload three-pane
 *
 * Sources, all pre-existing (nothing here adds collection):
 *  - renderer pid: the `window.created` / `renderer.recovery.succeeded` records
 *    main writes to the operational log (`app/main/main.ts:1384,1391`).
 *  - memory: `vmmap --summary <pid>`, the instrument `ram-probe.ts` uses.
 *  - JS heap, working set, committed renders, event-loop lag: the app's
 *    `renderer.health.sample` records (`app/shared/operationalLog.ts:130`).
 *  - open panes: the debug state file main writes under CATCODE_DEBUG_STATE=1
 *    (`app/main/main.ts:2325`).
 *
 * Reading, not writing: the operational log is the app's private diagnostics.
 * This script consumes only its closed numeric fields, and copies no log text
 * into its output.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultRegistryDir } from '../host/registry.js'
import {
  WORKLOAD_IDS,
  buildTrajectoryRun,
  formatSummary,
  parseVmmapSummary,
  selectTagRow,
  type SeriesOptions,
  type TrajectorySample,
  type WorkloadId,
} from './rendererMemoryTrajectory.js'

const here = dirname(fileURLToPath(import.meta.url))

const USAGE = `Renderer memory trajectory sampler

  bun run app/scripts/renderer-memory-trajectory.ts --workload <id> [options]

  --workload <id>        one of: ${WORKLOAD_IDS.join(', ')}
  --minutes <n>          run length in minutes (default 15)
  --interval-sec <n>     seconds between samples (default 30)
  --warmup-min <n>       minutes ignored by the slope fit (default 5)
  --final-window-min <n> minutes of the trailing growth window (default 5)
  --label <name>         output file name stem (default: workload plus a timestamp)
  --out <dir>            output directory (default app/.ram-scratch/trajectory)
  --pid <n>              renderer pid override, when the log cannot be read
  --log <path>           operational log override

Start the desktop app yourself before running this. Press Ctrl-C at any time to
stop early and still get a run file and a summary.
`

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    const next = argv[index + 1]
    out[key] = next !== undefined && !next.startsWith('--') ? argv[++index] : 'true'
  }
  return out
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`)
  process.exit(2)
}

/* -------------------------------------------------------------------------- *
 * Operational log reader
 * -------------------------------------------------------------------------- */

type LogRecord = {
  timestamp: string
  event: string
  fields: Record<string, unknown>
}

/**
 * The sink rotates at 512 KB into a new file and repoints `latest-operational`,
 * so the resolved target is re-checked every drain and the byte offset resets
 * when it moves. Following the symlink's original target instead would go quiet
 * exactly when the app is busiest.
 */
function createLogReader(symlinkPath: string) {
  let resolved: string | null = null
  let offset = 0
  return {
    drain(): LogRecord[] {
      let target: string
      try {
        target = realpathSync(symlinkPath)
      } catch {
        return []
      }
      if (target !== resolved) {
        resolved = target
        offset = 0
      }
      let size = 0
      try {
        size = statSync(target).size
      } catch {
        return []
      }
      if (size <= offset) {
        // A truncated file is a new launch writing over the same path.
        if (size < offset) offset = 0
        else return []
      }
      let text: string
      try {
        text = readFileSync(target).subarray(offset, size).toString('utf8')
      } catch {
        return []
      }
      const lastNewline = text.lastIndexOf('\n')
      if (lastNewline < 0) return []
      offset += Buffer.byteLength(text.slice(0, lastNewline + 1))
      const records: LogRecord[] = []
      for (const line of text.slice(0, lastNewline).split('\n')) {
        if (!line.trim()) continue
        try {
          const parsed: unknown = JSON.parse(line)
          if (!parsed || typeof parsed !== 'object') continue
          const item = parsed as Record<string, unknown>
          if (typeof item.event !== 'string' || typeof item.timestamp !== 'string') continue
          const fields = item.fields && typeof item.fields === 'object' && !Array.isArray(item.fields)
            ? (item.fields as Record<string, unknown>)
            : {}
          records.push({ timestamp: item.timestamp, event: item.event, fields })
        } catch {
          // A half-written trailing line is normal while the app is running.
        }
      }
      return records
    },
    resolvedPath(): string | null {
      return resolved
    },
  }
}

function numberField(record: LogRecord, key: string): number | null {
  const value = record.fields[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

const RENDERER_PID_EVENTS = new Set(['window.created', 'renderer.recovery.succeeded'])

/* -------------------------------------------------------------------------- *
 * Process capture
 * -------------------------------------------------------------------------- */

function isAlive(pid: number): boolean {
  try {
    execFileSync('ps', ['-p', String(pid)], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function rssBytes(pid: number): number | null {
  try {
    const kib = Number.parseInt(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim(), 10)
    return Number.isFinite(kib) ? kib * 1024 : null
  } catch {
    return null
  }
}

function vmmapText(pid: number): { text: string; error: string | null } {
  try {
    return {
      text: execFileSync('vmmap', ['--summary', String(pid)], {
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
        // vmmap warns on stderr that it cannot examine the PartitionAlloc malloc
        // zone. That warning is expected and irrelevant: the region-type table
        // this reads is unaffected by it.
        stdio: ['ignore', 'pipe', 'ignore'],
      }),
      error: null,
    }
  } catch (error) {
    return { text: '', error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * The debug state file survives the launch that wrote it, so a run started
 * without CATCODE_DEBUG_STATE=1 would otherwise report a previous session's
 * pane count as this run's. `writtenAt` decides whether it describes now.
 */
function readPaneCount(registryDir: string, maxAgeMs: number): number | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(registryDir, 'debug', 'state.json'), 'utf8'))
    if (!parsed || typeof parsed !== 'object') return null
    const file = parsed as Record<string, unknown>
    const writtenAt = file.writtenAt
    if (typeof writtenAt !== 'number' || Date.now() - writtenAt > maxAgeMs) return null
    const renderer = file.renderer
    if (!renderer || typeof renderer !== 'object') return null
    const tabs = (renderer as Record<string, unknown>).tabs
    return Array.isArray(tabs) ? tabs.length : null
  } catch {
    return null
  }
}

/* -------------------------------------------------------------------------- *
 * Run
 * -------------------------------------------------------------------------- */

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

let stopRequested = false
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (stopRequested) process.exit(130)
    stopRequested = true
    process.stderr.write('\nstopping after the current sample, the run file will still be written\n')
  })
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.help === 'true' || args.h === 'true') {
    process.stdout.write(USAGE)
    return
  }

  const workload = (args.workload ?? 'unspecified') as WorkloadId
  if (!WORKLOAD_IDS.includes(workload)) {
    fail(`unknown workload ${String(args.workload)}\n\n${USAGE}`)
  }

  const minutes = Number(args.minutes ?? '15')
  const intervalSec = Number(args['interval-sec'] ?? '30')
  const warmUpMin = Number(args['warmup-min'] ?? '5')
  const finalWindowMin = Number(args['final-window-min'] ?? '5')
  if (![minutes, intervalSec, warmUpMin, finalWindowMin].every(value => Number.isFinite(value) && value > 0)) {
    fail('minutes, interval-sec, warmup-min, and final-window-min must all be positive numbers')
  }
  // Otherwise the run has no settled stretch to measure and the gate scores
  // warm-up allocation as if it were the steady state.
  if (warmUpMin + finalWindowMin >= minutes) {
    fail(
      `warmup-min (${warmUpMin}) plus final-window-min (${finalWindowMin}) must be less than minutes (${minutes})`,
    )
  }

  const registryDir = defaultRegistryDir()
  const logPath = args.log ?? join(registryDir, 'logs', 'latest-operational')
  const outDir = args.out ?? join(here, '..', '.ram-scratch', 'trajectory')
  const label = args.label ?? `${workload}-${new Date().toISOString().replace(/[:.]/g, '-')}`

  // Fail on a bad log path now, not after fifteen minutes of empty samples.
  if (args.log && !existsSync(args.log)) fail(`no operational log at ${args.log}`)

  const reader = createLogReader(logPath)
  let rendererPid: number | null = null
  const startupRecords = reader.drain()
  for (const record of startupRecords) {
    if (RENDERER_PID_EVENTS.has(record.event)) {
      const pid = numberField(record, 'pid')
      if (pid !== null) rendererPid = pid
    }
  }

  if (args.pid) {
    const override = Number(args.pid)
    if (!Number.isInteger(override) || override <= 0) fail('--pid must be a positive integer')
    rendererPid = override
  }

  if (rendererPid === null || !isAlive(rendererPid)) {
    const reason = rendererPid === null
      ? `no renderer pid was found in ${logPath}`
      : `the renderer pid ${rendererPid} from ${logPath} is not running`
    fail(
      `${reason}\n\n` +
      'Start the desktop app first, in its own terminal, then run this again:\n\n' +
      '  cd /Users/pt/cat-code && \\\n' +
      '  CATCODE_TEST_CWD_ALLOWLIST=/Users/pt/cat-code \\\n' +
      '  CATCODE_INITIAL_CWD=/Users/pt/cat-code \\\n' +
      '  CATCODE_DEBUG_STATE=1 \\\n' +
      '  bun run --cwd app dev\n\n' +
      'If the app is running but its log cannot be read, pass --pid with the renderer process id.',
    )
  }

  mkdirSync(outDir, { recursive: true })

  const intervalMs = intervalSec * 1000
  const plannedDurationMs = minutes * 60_000
  const seriesOptions: SeriesOptions = {
    warmUpMs: warmUpMin * 60_000,
    finalWindowMs: finalWindowMin * 60_000,
    // Half a MB per minute of drift between the run's two halves is sampling
    // noise, not an accelerating leak.
    accelerationTolerancePerMinute: 0.5,
  }
  // A health record is written on the app's own 30s clock, so pairing it with a
  // vmmap capture is always slightly stale. Two intervals is the point past
  // which the reading describes a different part of the run.
  const healthMaxAgeMs = 2 * intervalMs

  const startedAt = Date.now()
  const startedAtIso = new Date(startedAt).toISOString()
  process.stderr.write(
    `sampling renderer pid ${rendererPid} every ${intervalSec}s for ${minutes} min\n` +
    `workload ${workload}, output ${outDir}\n` +
    'run the workload in the app now. Ctrl-C stops early and still writes the run file.\n\n',
  )

  const samples: TrajectorySample[] = []
  let latestHealth: { atMs: number; record: LogRecord } | null = null
  let stoppedReason = 'run length reached'

  for (let index = 0; ; index++) {
    const drained = reader.drain()
    for (const record of drained) {
      if (RENDERER_PID_EVENTS.has(record.event)) {
        const pid = numberField(record, 'pid')
        if (pid !== null && pid !== rendererPid) {
          process.stderr.write(`renderer process changed to pid ${pid}, following it\n`)
          rendererPid = pid
        }
      }
      if (record.event === 'renderer.process.gone') {
        process.stderr.write('the renderer process died during the run\n')
      }
      if (record.event === 'renderer.health.sample' || record.event === 'renderer.health.recovered') {
        latestHealth = { atMs: Date.parse(record.timestamp), record }
      }
    }

    const now = Date.now()
    const elapsedMs = now - startedAt
    const health = latestHealth !== null && now - latestHealth.atMs <= healthMaxAgeMs ? latestHealth : null
    const workingSetKiB = health === null ? null : numberField(health.record, 'rendererWorkingSetKiB')
    const visible = health === null ? null : health.record.fields.visible
    const capture = vmmapText(rendererPid)
    const summary = parseVmmapSummary(capture.text)
    const partitionAlloc = selectTagRow(summary, 'partitionAlloc')
    const v8 = selectTagRow(summary, 'v8')
    const blinkGc = selectTagRow(summary, 'blinkGc')

    const sample: TrajectorySample = {
      index,
      atIso: new Date(now).toISOString(),
      elapsedMs,
      rendererPid,
      footprintBytes: summary.footprintBytes,
      footprintPeakBytes: summary.footprintPeakBytes,
      partitionAllocResidentBytes: partitionAlloc?.residentBytes ?? null,
      partitionAllocDirtyBytes: partitionAlloc?.dirtyBytes ?? null,
      partitionAllocRegionCount: partitionAlloc?.regionCount ?? null,
      v8ResidentBytes: v8?.residentBytes ?? null,
      v8DirtyBytes: v8?.dirtyBytes ?? null,
      blinkGcResidentBytes: blinkGc?.residentBytes ?? null,
      totalResidentBytes: summary.totalResidentBytes,
      totalRegionCount: summary.totalRegionCount,
      rssBytes: rssBytes(rendererPid),
      jsHeapUsedBytes: health === null ? null : numberField(health.record, 'jsHeapUsedBytes'),
      rendererWorkingSetBytes: workingSetKiB === null ? null : workingSetKiB * 1024,
      rendersCommitted: health === null ? null : numberField(health.record, 'rendersCommitted'),
      eventLoopLagMs: health === null ? null : numberField(health.record, 'eventLoopLagMs'),
      sessions: health === null ? null : numberField(health.record, 'sessions'),
      visible: typeof visible === 'boolean' ? visible : null,
      healthAgeMs: health === null ? null : now - health.atMs,
      paneCount: readPaneCount(registryDir, healthMaxAgeMs),
      ...(capture.error === null ? {} : { error: capture.error }),
    }
    samples.push(sample)

    const mb = (value: number | null): string => (value === null ? 'none' : (value / (1024 * 1024)).toFixed(1))
    process.stderr.write(
      `[${(elapsedMs / 60_000).toFixed(1)}m] footprint ${mb(sample.footprintBytes)} MB, ` +
      `PartitionAlloc dirty ${mb(sample.partitionAllocDirtyBytes)} MB in ${sample.partitionAllocRegionCount ?? 'none'} regions, ` +
      `V8 ${mb(sample.v8ResidentBytes)} MB, JS heap ${mb(sample.jsHeapUsedBytes)} MB` +
      (sample.error ? `, vmmap failed: ${sample.error}` : '') +
      (sample.visible === false ? ', window hidden' : '') +
      '\n',
    )

    if (stopRequested) {
      stoppedReason = 'stopped by the operator'
      break
    }
    if (!isAlive(rendererPid)) {
      stoppedReason = 'the renderer process is gone'
      break
    }
    if (elapsedMs + intervalMs > plannedDurationMs) break

    const wakeAt = startedAt + (index + 1) * intervalMs
    while (Date.now() < wakeAt && !stopRequested) {
      await sleep(Math.min(500, Math.max(0, wakeAt - Date.now())))
    }
  }

  const run = buildTrajectoryRun({
    label,
    workload,
    startedAtIso,
    finishedAtIso: new Date().toISOString(),
    rendererPid,
    intervalMs,
    plannedDurationMs,
    stoppedReason,
    samples,
    seriesOptions,
  })

  const runFile = join(outDir, `${label}.run.json`)
  const summaryFile = join(outDir, `${label}.summary.txt`)
  const summaryText = formatSummary(run)
  writeFileSync(runFile, `${JSON.stringify(run, null, 2)}\n`)
  writeFileSync(summaryFile, `${summaryText}\n`)

  process.stdout.write(`\n${summaryText}\n\n`)
  process.stdout.write(`run file ${runFile}\nsummary  ${summaryFile}\n`)
  process.stdout.write('Compare two runs by diffing their run files, which carry the same schema.\n')

  if (run.verdicts.some(verdict => verdict.status === 'fail')) process.exitCode = 1
}

main().catch(error => {
  process.stderr.write(`renderer-memory-trajectory failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exit(1)
})
