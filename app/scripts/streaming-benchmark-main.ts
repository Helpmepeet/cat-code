/** Focused Electron delivery-pipeline benchmark. It never starts an engine or provider. */
import { app, BrowserWindow, ipcMain } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { AttachmentGate } from '../main/attachmentGate.js'
import { createLiveFrameDeliveryCoordinator, type LiveFrameDeliveryCoordinator } from '../main/liveFrameBatcher.js'
import { createDeliveryTraceSink, deliveryMessageKindOfFrame } from '../main/deliveryTraceSink.js'
import { createFixture, digest, manifest } from '../../docs/reports/2026-09-12-live-streaming-measurements/fixture.js'
import type { SessionDescriptor } from '../shared/hostApi.js'
import type { ServerFrame } from '../shared/protocol.js'
import { mintDeliveryTrace, type DeliveryAcknowledgement } from '../shared/deliveryTrace.js'
import { createRawMessageLogState, reduceServerFrame } from '../renderer/src/rawMessageLog.js'
import { benchmarkCoverageComplete, type BenchmarkObserverCounters } from './streaming-benchmark-observer.js'
import { advanceDocumentSubscription, isCurrentDocumentAcknowledgement, markerTracedBootstrap } from './streaming-benchmark-runtime.js'
import * as channels from '../shared/ipcChannels.js'

let fatalExitStarted = false
const fatalExit = (reason: unknown) => {
  if (fatalExitStarted) return
  fatalExitStarted = true
  const message = reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason)
  process.stderr.write(`[streaming-benchmark] fatal: ${message.slice(0, 2_048)}\n`)
  try { app.exit(1) } catch { process.exit(1) }
}
process.once('uncaughtException', fatalExit)
process.once('unhandledRejection', fatalExit)
const stage = (name: string) => process.stderr.write(`[streaming-benchmark] stage=${name}\n`)
function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}
stage('module-entered')

const runDir = required('CATCODE_STREAMING_BENCHMARK_RUN_DIR')
const rendererDir = required('CATCODE_STREAMING_BENCHMARK_RENDERER_OUT')
const preloadPath = required('CATCODE_STREAMING_BENCHMARK_PRELOAD')
const workloadId = required('CATCODE_STREAMING_BENCHMARK_WORKLOAD')
const policyName = required('CATCODE_STREAMING_BENCHMARK_POLICY')
const selectedWorkload = manifest.workloads.find(item => item.id === workloadId)
if (!selectedWorkload) throw new Error(`unknown workload ${workloadId}`)
const workload = selectedWorkload
if (!['original', '0', '8', '16'].includes(policyName)) throw new Error(`unknown policy ${policyName}`)
const delayMs = policyName === 'original' ? 0 : Number(policyName)
const BOOTSTRAP_TRANSCRIPT_MARKER = 'CATCODE_SYNTHETIC_STREAMING_BENCHMARK_READY'

const userDataDir = join(runDir, 'user-data')
const sessionDataDir = join(runDir, 'session-data')
mkdirSync(userDataDir, { recursive: true })
mkdirSync(sessionDataDir, { recursive: true })
app.setPath('userData', userDataDir)
app.setPath('sessionData', sessionDataDir)

async function run(): Promise<void> {
  await app.whenReady()
  stage('app-ready')
let gate = new AttachmentGate()
let coordinator: LiveFrameDeliveryCoordinator | null = null
let sendCount = 0
const arrivalByTraceId = new Map<string, number>()
const fixture = createFixture(workload)
const scoredTraceIds = new Set(fixture.arrivals.map(item => item.frame.deliveryTrace?.traceId).filter((item): item is string => typeof item === 'string'))
const scoredAppliedTraceIds = new Set<string>()
let scoringActive = false
let rendererSubscription = { documentId: '', epoch: 0 }
let rendererReadyCount = 0
const currentDocumentSentTraceIds = new Set<string>()
const currentDocumentAppliedTraceIds = new Set<string>()
let syntheticSequence = 1_000_000
let mintMissingDeliveryTraces = true
let deliveryTrace = createDeliveryTraceSink({ configDir: join(runDir, 'config'), launchId: `benchmark-warmup-${process.pid}`, sweepIntervalMs: 0 })
const descriptors: SessionDescriptor[] = Array.from({ length: workload.sessions }, (_, index) => ({
  appSessionId: `benchmark-session-${index}`, engineSessionId: `benchmark-engine-${index}`, cwd: runDir,
  title: `Synthetic ${index + 1}`, forked: false, titleUpdatedAt: null, status: 'ready',
  restorable: false, parked: false, createdAt: 0, lastAttachedAt: index + 1, lastMessageSentAt: null,
}))

const window = new BrowserWindow({
  show: true,
  width: 1100,
  height: 720,
  webPreferences: { preload: preloadPath, sandbox: true, contextIsolation: true, nodeIntegration: false },
})

const sendNow = (frames: ServerFrame[]) => {
  sendCount++
  const traced = frames.map(frame => frame.deliveryTrace || !mintMissingDeliveryTraces ? frame : { ...frame, deliveryTrace: mintDeliveryTrace(syntheticSequence++, `benchmark-${frame.sessionId}`, `benchmark-${process.pid}`) })
  for (const frame of traced) if (frame.deliveryTrace) currentDocumentSentTraceIds.add(frame.deliveryTrace.traceId)
  for (const frame of traced) if (frame.deliveryTrace) deliveryTrace.mark({
    sessionId: frame.sessionId, trace: frame.deliveryTrace!, stage: 'main.ipc.queued', frameKind: frame.kind,
    messageKind: deliveryMessageKindOfFrame(frame), documentId: rendererSubscription.documentId, subscriptionEpoch: rendererSubscription.epoch,
  })
  window.webContents.send(channels.CH_SERVER_FRAME, traced)
  for (const frame of traced) if (frame.deliveryTrace) deliveryTrace.mark({
    sessionId: frame.sessionId, trace: frame.deliveryTrace!, stage: 'main.ipc.sent', frameKind: frame.kind,
    messageKind: deliveryMessageKindOfFrame(frame), documentId: rendererSubscription.documentId, subscriptionEpoch: rendererSubscription.epoch,
  })
}
const createCoordinator = () => createLiveFrameDeliveryCoordinator({ delayMs, sendNow,
  isDestinationAvailable: () => !window.isDestroyed() && !window.webContents.isDestroyed(), onSendFailure: error => { throw error },
})
coordinator = createCoordinator()

ipcMain.handle(channels.CH_HOST_LIST, () => descriptors)
ipcMain.handle(channels.CH_HOST_SESSIONS_CATALOG, () => ({ entries: [], truncated: false, capturedAtMs: 0 }))
ipcMain.on(channels.CH_RENDERER_READY, (_event, payload: { documentId?: unknown }) => {
  if (typeof payload?.documentId !== 'string') throw new Error('invalid renderer document id')
  const documentChanged = payload.documentId !== rendererSubscription.documentId
  rendererSubscription = advanceDocumentSubscription(rendererSubscription, payload.documentId)
  if (documentChanged) {
    currentDocumentSentTraceIds.clear()
    currentDocumentAppliedTraceIds.clear()
  }
  rendererReadyCount++
  const replay = gate.onRendererReady()
  if (replay.length > 0) sendNow(replay)
})
ipcMain.on(channels.CH_DELIVERY_ACK, (_event, payload: { acknowledgements?: DeliveryAcknowledgement[] }) => {
  if (!payload || Object.keys(payload).length !== 1 || !Array.isArray(payload.acknowledgements) || payload.acknowledgements.length < 1 || payload.acknowledgements.length > 64) return
  for (const acknowledgement of payload.acknowledgements) {
    if (!isCurrentDocumentAcknowledgement(rendererSubscription, acknowledgement)) {
      deliveryTrace.recordAcknowledgementRejected({ sessionId: acknowledgement.sessionId, streamEpoch: acknowledgement.streamEpoch, sequence: acknowledgement.sequence, reason: 'stale_document' })
      continue
    }
    if (!deliveryTrace.accepts(acknowledgement.sessionId, acknowledgement.streamEpoch, acknowledgement.sequence, acknowledgement.documentId, acknowledgement.subscriptionEpoch)) {
      deliveryTrace.recordAcknowledgementRejected({ sessionId: acknowledgement.sessionId, streamEpoch: acknowledgement.streamEpoch, sequence: acknowledgement.sequence, reason: 'unknown_sequence' })
      continue
    }
    const trace = deliveryTrace.traceFor(acknowledgement.sessionId, acknowledgement.streamEpoch, acknowledgement.sequence)
    if (!trace || trace.deliveryAttempt !== acknowledgement.deliveryAttempt || trace.traceId !== acknowledgement.traceId) {
      deliveryTrace.recordAcknowledgementRejected({ sessionId: acknowledgement.sessionId, streamEpoch: acknowledgement.streamEpoch, sequence: acknowledgement.sequence, reason: 'stale_attempt' })
      continue
    }
    deliveryTrace.mark({ sessionId: acknowledgement.sessionId, trace, stage: acknowledgement.stage,
      documentId: acknowledgement.documentId, subscriptionEpoch: acknowledgement.subscriptionEpoch,
      processInstanceId: acknowledgement.rendererProcessInstanceId, processStartedAt: acknowledgement.rendererProcessStartedAt })
    if (scoringActive && acknowledgement.stage === 'renderer.state.applied' && scoredTraceIds.has(acknowledgement.traceId)) {
      scoredAppliedTraceIds.add(acknowledgement.traceId)
    }
    if (acknowledgement.stage === 'renderer.state.applied') currentDocumentAppliedTraceIds.add(acknowledgement.traceId)
  }
})
ipcMain.on(channels.CH_RENDERER_FAULT, (_event, payload) => {
  throw new Error(`renderer fault: ${typeof payload?.kind === 'string' ? payload.kind : 'unknown'}`)
})
ipcMain.on(channels.CH_HOST_VISIBLE_SESSIONS, () => {})
ipcMain.on(channels.CH_SET_APPEARANCE, () => {})
ipcMain.on(channels.CH_SET_GLASS_MODE, () => {})

mintMissingDeliveryTraces = false
for (const frame of bootstrapFrames(fixture.initial)) gate.onFrame(frame.sessionId, frame)
const initialReadyCount = rendererReadyCount
await window.loadFile(join(rendererDir, 'index.html'))
await waitForBootstrap(window, initialReadyCount)
stage('bootstrap-ready')
mintMissingDeliveryTraces = true
const warmup = createFixture(workload, manifest.warmupMs)
await deliverFixture(warmup, false)
coordinator.flush()
await waitForCurrentDocumentAcknowledgements()
stage('warmup-complete')
// Score in a fresh renderer document with fresh attachment/coordinator state.
// Warmup exercises the same Electron/main/IPC/React path, but no claim is made
// that renderer-document state or JavaScript JIT state survives this reload.
coordinator.dispose()
deliveryTrace.close()
deliveryTrace = createDeliveryTraceSink({ configDir: join(runDir, 'config'), launchId: `benchmark-scored-${process.pid}`, sweepIntervalMs: 0 })
gate.reset()
gate = new AttachmentGate()
coordinator = createCoordinator()
arrivalByTraceId.clear()
mintMissingDeliveryTraces = false
for (const frame of bootstrapFrames(fixture.initial)) gate.onFrame(frame.sessionId, frame)
const priorReadyCount = rendererReadyCount
await window.reload()
await waitForBootstrap(window, priorReadyCount)
await waitForCurrentDocumentAcknowledgements()
stage('scored-bootstrap-ready')
mintMissingDeliveryTraces = true
await window.webContents.executeJavaScript('window.__CATCODE_STREAMING_BENCHMARK__.reset()')
sendCount = 0
scoredAppliedTraceIds.clear()
scoringActive = true
const expectedChanging = rawChangingFrames(fixture.initial, fixture.arrivals.map(item => item.frame))

// Align main's monotonic clock to the renderer clock. Half the minimum round
// trip bounds the offset uncertainty; before and after samples expose drift.
const calibrationBefore = await calibrate(window)
const processMetricsBefore = cpuSnapshot()
const cpuStart = process.cpuUsage()
const wallStart = performance.now()
await deliverFixture(fixture, true, wallStart)
coordinator.flush()
await waitForCoverage(window, expectedChanging.length)
await waitForAcknowledgements(scoredTraceIds.size)
const wallEnd = performance.now()
const cpu = process.cpuUsage(cpuStart)
const processMetrics = app.getAppMetrics()
const processMetricsAfter = cpuSnapshot(processMetrics)
const calibrationAfter = await calibrate(window)
const observer = await window.webContents.executeJavaScript('window.__CATCODE_STREAMING_BENCHMARK__.snapshot()')
const commits = Array.isArray(observer.commits) ? observer.commits : []
const observedTraceIds = commits.flatMap((commit: { frames?: Array<{ traceId: string }> }) => (commit.frames ?? []).map(item => item.traceId))
const expectedTraceIds = expectedChanging.map(item => item.deliveryTrace!.traceId)
if (observer.overflowed || digest(observedTraceIds) !== digest(expectedTraceIds)) {
  throw new Error('observer frame coverage/order mismatch')
}
const latencies: number[] = []
const rendererToMainOffsetMs = (calibrationBefore.rendererToMainOffsetMs + calibrationAfter.rendererToMainOffsetMs) / 2
for (const commit of commits) for (const identity of commit.frames ?? []) {
  const arrival = arrivalByTraceId.get(identity.traceId)
  if (arrival !== undefined) latencies.push(commit.atMs + rendererToMainOffsetMs - arrival)
}
const result = {
  schemaVersion: 1, tier: 'focused-electron-delivery-pipeline', workload: workload.id, policy: policyName,
  fixtureHash: fixture.hash, deliveredFrames: fixture.arrivals.length, expectedCommittedRawFrames: expectedChanging.length, observedCommittedRawFrames: latencies.length,
  sendCount, dispatchCount: observer.dispatchCount, commitCount: observer.commitCount,
  noRawStateChangeFrames: observer.noRawStateChangeCount, observerOverflowed: observer.overflowed, queue: coordinator.stats(),
  wallMs: wallEnd - wallStart, mainCpuMicros: cpu.user + cpu.system,
  electronCpu: cpuDeltas(processMetricsBefore, processMetricsAfter),
  latencyMs: latencies, calibration: { before: calibrationBefore, after: calibrationAfter },
  clockAlignmentUncertaintyMs: Math.max(
    calibrationBefore.uncertaintyMs,
    calibrationAfter.uncertaintyMs,
    Math.abs(calibrationAfter.rendererToMainOffsetMs - calibrationBefore.rendererToMainOffsetMs) / 2,
  ),
  expectedTraceHash: digest(expectedTraceIds), observedTraceHash: digest(observedTraceIds), frameOrderVerified: true,
  finalRawMessageCount: commits.at(-1)?.rawMessageCount ?? -1,
  ownedPids: [process.pid, ...app.getAppMetrics().map(item => item.pid)].filter((pid, index, all) => all.indexOf(pid) === index),
  omittedMainWork: ['engine/supervisor/host workers', 'production window recovery and health timers', 'operational-log writes outside delivery tracing'],
  bootstrapTracing: 'terminal-marker-only; bulk history replay and its acknowledgement cost are excluded',
}
writeFileSync(join(runDir, 'result.json'), `${JSON.stringify(result)}\n`)
stage('result-saved')
coordinator.dispose()
deliveryTrace.close()
window.destroy()
app.quit()

function sleep(ms: number) { return new Promise(resolve => setTimeout(resolve, ms)) }
async function waitForCoverage(target: BrowserWindow, expected: number) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const value = await target.webContents.executeJavaScript('window.__CATCODE_STREAMING_BENCHMARK__.counters()') as BenchmarkObserverCounters
    if (benchmarkCoverageComplete(value, expected)) return
    await sleep(20)
  }
  throw new Error('final commit/state coverage barrier timed out')
}
async function waitForCurrentDocumentAcknowledgements() {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if ([...currentDocumentSentTraceIds].every(traceId => currentDocumentAppliedTraceIds.has(traceId))) return
    await sleep(20)
  }
  throw new Error(`bootstrap acknowledgement barrier timed out (${currentDocumentAppliedTraceIds.size}/${currentDocumentSentTraceIds.size})`)
}
async function waitForAcknowledgements(expected: number) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (scoredAppliedTraceIds.size === expected) return
    await sleep(20)
  }
  throw new Error(`delivery acknowledgement barrier timed out (${scoredAppliedTraceIds.size}/${expected})`)
}
async function calibrate(target: BrowserWindow) {
  const samples: Array<{ offset: number; uncertainty: number }> = []
  for (let index = 0; index < 9; index++) {
    const before = performance.now()
    const renderer = await target.webContents.executeJavaScript('performance.now()') as number
    const after = performance.now()
    samples.push({ offset: (before + after) / 2 - renderer, uncertainty: (after - before) / 2 })
  }
  samples.sort((a, b) => a.uncertainty - b.uncertainty)
  return { rendererToMainOffsetMs: samples[0]!.offset, uncertaintyMs: samples[0]!.uncertainty }
}

function bootstrapFrames(initial: readonly ServerFrame[]): ServerFrame[] {
  const extras: ServerFrame[] = []
  for (const descriptor of descriptors) {
    extras.push({ kind: 'workspace-trust.snapshot', protocolVersion: 1, sessionId: descriptor.appSessionId,
      workspaceTrust: { trusted: true, detectedRepo: null, trustRoot: runDir } })
    extras.push({ kind: 'accounts.snapshot', protocolVersion: 1, sessionId: descriptor.appSessionId, accounts: {
      accounts: [], activeAccountId: null, readyCount: 0, poolCount: 0, initialized: true,
      anthropicAccounts: [], anthropicActiveAccountId: null, anthropicReadyCount: 0,
      anthropicPoolCount: 0, anthropicInitialized: true, anthropicRouteAvailable: true,
    } })
  }
  const first = descriptors[0]
  if (!first) return [...initial, ...extras]
  const marker: ServerFrame = { kind: 'event', protocolVersion: 1, sessionId: first.appSessionId, event: {
    type: 'message', message: { type: 'assistant', uuid: 'benchmark-bootstrap-marker', parent_tool_use_id: null,
      session_id: first.appSessionId, message: { id: 'benchmark-bootstrap-marker', role: 'assistant', content: [{ type: 'text', text: BOOTSTRAP_TRANSCRIPT_MARKER }] } } as never,
  }, deliveryTrace: mintDeliveryTrace(syntheticSequence++, `bootstrap-${first.appSessionId}`, `benchmark-${process.pid}`) }
  return markerTracedBootstrap(initial, extras, marker)
}

async function deliverFixture(input: ReturnType<typeof createFixture>, scored: boolean, start = performance.now()) {
  for (const arrival of input.arrivals) {
    const wait = start + arrival.atMs - performance.now()
    if (wait > 0) await sleep(wait)
    if (scored) {
      const traceId = arrival.frame.deliveryTrace?.traceId
      if (traceId) arrivalByTraceId.set(traceId, performance.now())
    }
    const forwarded = gate.onFrame(arrival.frame.sessionId, arrival.frame)
    if (forwarded.length === 0) continue
    if (policyName === 'original') sendNow(forwarded)
    else coordinator!.deliver(forwarded, arrival.barrier ? 'immediate' : 'ordinary-live')
  }
}

function rawChangingFrames(initial: readonly ServerFrame[], arrivals: readonly ServerFrame[]): ServerFrame[] {
  let state = createRawMessageLogState()
  for (const frame of initial) state = reduceServerFrame(state, frame)
  const changing: ServerFrame[] = []
  for (const frame of arrivals) {
    const next = reduceServerFrame(state, frame)
    if (next !== state) changing.push(frame)
    state = next
  }
  return changing
}

async function waitForBootstrap(target: BrowserWindow, priorReadyCount: number) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const view = await target.webContents.executeJavaScript(`({
      visible: document.visibilityState === 'visible',
      titleVisible: document.body.textContent.includes('Synthetic 1'),
      transcriptMarkerVisible: document.body.textContent.includes('${BOOTSTRAP_TRANSCRIPT_MARKER}'),
      trustGate: document.body.textContent.includes('Trust this workspace?'),
      signInGate: document.querySelector('[aria-label="Sign in"]') !== null,
      observer: window.__CATCODE_STREAMING_BENCHMARK__?.snapshot?.()
    })`)
    if (rendererReadyCount > priorReadyCount && view.visible && view.titleVisible && view.transcriptMarkerVisible && !view.trustGate && !view.signInGate && view.observer?.layoutCommitCount > 0) return
    await sleep(20)
  }
  throw new Error('renderer did not reach committed visible transcript bootstrap')
}

type CpuPoint = { type: string; pid: number; cumulative: number | null; percent: number }
function cpuSnapshot(metrics = app.getAppMetrics()): CpuPoint[] {
  return metrics.filter(item => item.type === 'Browser' || item.type === 'Tab').map(item => ({
    type: item.type, pid: item.pid, cumulative: item.cpu.cumulativeCPUUsage ?? null, percent: item.cpu.percentCPUUsage,
  }))
}
function cpuDeltas(before: CpuPoint[], after: CpuPoint[]) {
  const previous = new Map(before.map(item => [item.pid, item]))
  const samePids = before.length === after.length && after.every(item => previous.has(item.pid))
  const completeCumulative = samePids && after.every(item => item.cumulative !== null && previous.get(item.pid)?.cumulative !== null)
  return {
    valid: completeCumulative,
    reason: !samePids ? 'process_set_changed' : completeCumulative ? null : 'cumulative_cpu_unavailable',
    processes: after.map(item => {
      const prior = previous.get(item.pid)
      return { ...item, cumulativeDeltaSeconds: !prior || item.cumulative === null || prior.cumulative === null
        ? null : item.cumulative - prior.cumulative }
    }),
  }
}
}

void run().catch(fatalExit)
