/** Paced component comparison. This does NOT measure Electron or React commits. */
import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { createFixture, digest, manifest, type Workload } from './fixture.js'
import { createLiveFrameDeliveryCoordinator } from '../../../app/main/liveFrameBatcher.js'
import { applyServerFrameBatch, withBatch, type ServerFrameBatchHandlers } from '../../../app/renderer/src/serverFrameBatch.js'
import { createTranscriptState } from '../../../app/renderer/src/transcriptProjector.js'
import { reduceLiveTranscriptState } from '../../../app/renderer/src/previewTranscriptState.js'
import { createRawMessageLogState, reduceServerFrame } from '../../../app/renderer/src/rawMessageLog.js'
import { createPermissionState, reducePermissionState } from '../../../app/renderer/src/permissionState.js'
import { createConnectionState, reduceConnectionState } from '../../../app/renderer/src/connectionState.js'
import type { ServerFrame } from '../../../app/shared/protocol.js'

const args = process.argv.slice(2)
const smoke = args.includes('--smoke')
const flag = (key: string) => { const i = args.indexOf(key); return i < 0 ? undefined : args[i + 1] }
const root = fileURLToPath(new URL('../../../', import.meta.url))
const policyFilter = flag('--policy')
const workloadFilter = flag('--workload')
const sources = [
  'app/main/liveFrameBatcher.ts', 'app/main/main.ts',
  'app/renderer/src/serverFrameBatch.ts', 'app/renderer/src/transcriptProjector.ts',
  'app/renderer/src/previewTranscriptState.ts', 'app/renderer/src/rawMessageLog.ts',
  'app/renderer/src/permissionState.ts', 'app/renderer/src/connectionState.ts',
  'docs/reports/2026-09-12-live-streaming-measurements/fixture.ts',
  'docs/reports/2026-09-12-live-streaming-measurements/run-headless.ts',
]
const sourceHashes = () => Object.fromEntries(sources.map(path => [path,
  createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex'),
]))

function createRenderer(sessionCount: number) {
  let transcript = createTranscriptState()
  let rawLog = createRawMessageLogState()
  let permission = createPermissionState()
  let connection = createConnectionState()
  let active: string | null = 'benchmark-session-0'
  let dispatchCalls = 0
  const roster = Object.fromEntries(Array.from({ length: sessionCount }, (_, i) => [`benchmark-session-${i}`, {}]))
  const raw = withBatch(reduceServerFrame)
  const perm = withBatch(reducePermissionState)
  const conn = withBatch(reduceConnectionState)
  const noop = () => { dispatchCalls++ }
  const handlers: ServerFrameBatchHandlers = {
    getRosterById: () => roster,
    setActiveSessionId: updater => { dispatchCalls++; active = updater(active) },
    dispatchRawLog: action => { dispatchCalls++; rawLog = raw(rawLog, action) },
    dispatchPermission: action => { dispatchCalls++; permission = perm(permission, action) },
    dispatchConnection: action => { dispatchCalls++; connection = conn(connection, action) },
    dispatchTranscript: action => { dispatchCalls++; transcript = reduceLiveTranscriptState(transcript, action) },
    dispatchSettings: noop, dispatchAgentConfig: noop, dispatchExtensions: noop,
    dispatchGoalMemory: noop, dispatchTasks: noop, dispatchWorkers: noop,
    dispatchLease: noop, dispatchAccounts: noop, dispatchWorkspaceTrust: noop,
    dispatchDiagnostics: noop, dispatchRunControls: noop, dispatchContextBreakdown: noop,
    dispatchRemoteSettings: noop, dispatchSlashCatalog: noop, dispatchQueuedPrompts: noop,
    dispatchSessionActionRuntime: noop, dispatchVerbAckResult: noop,
  }
  return {
    apply: (frames: ServerFrame[]) => applyServerFrameBatch(frames, handlers),
    state: () => ({ transcript, rawLog, permission, connection, active }),
    dispatches: () => dispatchCalls,
  }
}

function percentile(values: number[], percent: number) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.ceil(percent * sorted.length) - 1]!
}

async function run(workload: Workload, policy: string, durationMs: number) {
  const fixture = createFixture(workload, durationMs)
  const renderer = createRenderer(workload.sessions)
  renderer.apply(fixture.initial)
  const beforeDispatches = renderer.dispatches()
  const delivered: ServerFrame[] = []
  const receivedAt = new Map<ServerFrame, number>()
  const scheduleLags: number[] = []
  const deliveryWaits: number[] = []
  const foldLatencies: number[] = []
  let sends = 0
  let inFlightTimers = 0
  let maxTimers = 0
  const sendNow = (frames: ServerFrame[]) => {
    const deliveredAt = performance.now()
    sends++
    renderer.apply(frames)
    const foldedAt = performance.now()
    for (const frame of frames) {
      delivered.push(frame)
      deliveryWaits.push(deliveredAt - receivedAt.get(frame)!)
      foldLatencies.push(foldedAt - receivedAt.get(frame)!)
    }
  }
  const timerHandles = new Set<ReturnType<typeof setTimeout>>()
  const coordinator = createLiveFrameDeliveryCoordinator({
    delayMs: policy === 'original' ? 0 : Number(policy), now: () => performance.now(),
    isDestinationAvailable: () => true,
    onSendFailure: error => { throw error },
    sendNow,
    setTimer: (fn, ms) => {
      const handle = setTimeout(() => {
        if (timerHandles.delete(handle)) inFlightTimers--
        fn()
      }, ms)
      timerHandles.add(handle)
      inFlightTimers++
      maxTimers = Math.max(maxTimers, inFlightTimers)
      return handle
    },
    clearTimer: handle => {
      clearTimeout(handle)
      if (timerHandles.delete(handle)) inFlightTimers--
    },
  })
  const cpuAtStart = process.cpuUsage()
  const start = performance.now()
  let i = 0
  while (i < fixture.arrivals.length) {
    const due = fixture.arrivals[i]!.atMs
    const remaining = start + due - performance.now()
    if (remaining > 0.5) {
      await Bun.sleep(Math.max(1, Math.floor(remaining)))
      continue
    }
    const arrival = fixture.arrivals[i++]!
    const received = performance.now()
    receivedAt.set(arrival.frame, received)
    scheduleLags.push(Math.max(0, received - start - arrival.atMs))
    if (policy === 'original') sendNow([arrival.frame])
    else coordinator.deliver([arrival.frame], 'ordinary-live')
    if (arrival.barrier) assert.equal(delivered.length, i, 'semantic barrier did not flush the accepted prefix')
  }
  coordinator.flush()
  const elapsedMs = performance.now() - start
  const cpu = process.cpuUsage(cpuAtStart)
  const stats = coordinator.stats()
  coordinator.dispose()
  assert.equal(inFlightTimers, 0, 'scheduler retained an idle timer')
  assert.deepEqual(delivered, fixture.arrivals.map(a => a.frame), 'lost, changed or reordered frames')
  assert.equal(digest({ initial: fixture.initial, arrivals: fixture.arrivals }), fixture.hash, 'fixture mutated')
  // Full state check is outside the CPU measurement. This exercises the real
  // four reducers; it makes no assertion about unmodelled stores/React effects.
  const expected = createRenderer(workload.sessions)
  expected.apply(fixture.initial)
  for (const arrival of fixture.arrivals) expected.apply([arrival.frame])
  assert.deepEqual(renderer.state(), expected.state(), 'final renderer state differs')
  return {
    workload: workload.id, policy, fixtureHash: fixture.hash, sourceFrames: fixture.arrivals.length,
    elapsedMs, cpuUserMs: cpu.user / 1000, cpuSystemMs: cpu.system / 1000,
    cpuTotalMs: (cpu.user + cpu.system) / 1000, sends,
    dispatchCalls: renderer.dispatches() - beforeDispatches,
    deliveryWaitP95Ms: percentile(deliveryWaits, .95), deliveryWaitP99Ms: percentile(deliveryWaits, .99),
    arrivalToReducerFoldP95Ms: percentile(foldLatencies, .95),
    arrivalToReducerFoldP99Ms: percentile(foldLatencies, .99),
    feederLatenessP99Ms: percentile(scheduleLags, .99), maxTimers, idleTimers: inFlightTimers,
    scheduler: stats, correctFramesAndFinalState: true,
  }
}

const beforeSources = sourceHashes()
const workloads = manifest.workloads.filter(w => !workloadFilter || w.id === workloadFilter)
const policies = manifest.policies.filter(p => !policyFilter || p === policyFilter)
assert(workloads.length && policies.length, 'unknown workload or policy')
const repetitions = smoke ? 1 : manifest.repetitions
const durationMs = smoke ? 250 : manifest.durationMs
const outPath = resolve(root, flag('--out') ?? `docs/reports/2026-09-12-live-streaming-measurements/${smoke ? 'smoke' : 'headless'}-results.json`)
assert(!existsSync(outPath), 'choose a new --out path; previous measurement samples are immutable')
const results: Array<Awaited<ReturnType<typeof run>>> = []
const identity = {
  tier: smoke ? 'functional smoke; CPU is not scored' : 'paced single-process scheduler + four renderer reducers',
  omissions: ['attachment/replay buffer', 'delivery trace logging', 'Electron IPC', 'preload/ACKs', 'React rendering/commits', 'other store reducer work', 'sidecars/providers', 'whole-app CPU and energy'],
  manifest, manifestHash: digest(manifest), runtime: Bun.version,
  sourceRevision: execFileSync('git', ['-c', 'core.fsmonitor=false', 'rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  sourceHashes: beforeSources,
}
for (let repetition = 0; repetition < repetitions; repetition++) {
  const order = [...policies.slice(repetition % policies.length), ...policies.slice(0, repetition % policies.length)]
  for (const workload of workloads) {
    for (const policy of order) {
      if (!smoke) await run(workload, policy, manifest.warmupMs)
      const result = await run(workload, policy, durationMs)
      results.push(result)
      writeFileSync(outPath, JSON.stringify({ ...identity, results }, null, 2) + '\n')
      console.log(JSON.stringify({ repetition, workload: workload.id, policy, cpuTotalMs: result.cpuTotalMs, sends: result.sends, frames: result.sourceFrames }))
    }
  }
}
assert.deepEqual(sourceHashes(), beforeSources, 'measured source changed during this run; samples invalid')
console.log(`Saved ${results.length} ${smoke ? 'functional smoke' : 'component'} samples; actual commit/whole-app performance gates are unverified.`)
