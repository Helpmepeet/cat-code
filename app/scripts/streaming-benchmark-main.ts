/** Focused Electron delivery-pipeline benchmark. It never starts an engine or provider. */
import { app, BrowserWindow, ipcMain } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { AttachmentGate } from '../main/attachmentGate.js'
import { createLiveFrameDeliveryCoordinator, type LiveFrameDeliveryCoordinator } from '../main/liveFrameBatcher.js'
import { createFixture, digest, manifest } from '../../docs/reports/2026-09-12-live-streaming-measurements/fixture.js'
import type { HostEvent } from '../shared/hostApi.js'
import type { ServerFrame } from '../shared/protocol.js'
import * as channels from '../shared/ipcChannels.js'

const runDir = required('CATCODE_STREAMING_BENCHMARK_RUN_DIR')
const rendererDir = required('CATCODE_STREAMING_BENCHMARK_RENDERER_OUT')
const preloadPath = required('CATCODE_STREAMING_BENCHMARK_PRELOAD')
const workloadId = required('CATCODE_STREAMING_BENCHMARK_WORKLOAD')
const policyName = required('CATCODE_STREAMING_BENCHMARK_POLICY')
const workload = manifest.workloads.find(item => item.id === workloadId)
if (!workload) throw new Error(`unknown workload ${workloadId}`)
if (!['original', '0', '8', '16'].includes(policyName)) throw new Error(`unknown policy ${policyName}`)
const delayMs = policyName === 'original' ? 0 : Number(policyName)

app.setPath('userData', join(runDir, 'user-data'))
app.setPath('sessionData', join(runDir, 'session-data'))
mkdirSync(app.getPath('userData'), { recursive: true })
mkdirSync(app.getPath('sessionData'), { recursive: true })

await app.whenReady()
const gate = new AttachmentGate()
let coordinator: LiveFrameDeliveryCoordinator | null = null
let sendCount = 0
const arrivalByTraceId = new Map<string, number>()
const fixture = createFixture(workload)

const window = new BrowserWindow({
  show: true,
  width: 1100,
  height: 720,
  webPreferences: { preload: preloadPath, sandbox: true, contextIsolation: true, nodeIntegration: false },
})

const sendNow = (frames: ServerFrame[]) => {
  sendCount++
  window.webContents.send(channels.CH_SERVER_FRAME, frames)
}
coordinator = createLiveFrameDeliveryCoordinator({
  delayMs,
  sendNow,
  isDestinationAvailable: () => !window.isDestroyed() && !window.webContents.isDestroyed(),
  onSendFailure: error => { throw error },
})

ipcMain.handle(channels.CH_HOST_LIST, () => [])
ipcMain.on(channels.CH_RENDERER_READY, () => {
  const replay = gate.onRendererReady()
  if (replay.length > 0) sendNow(replay)
})
ipcMain.on(channels.CH_DELIVERY_ACK, () => {})
ipcMain.on(channels.CH_RENDERER_FAULT, (_event, payload) => {
  throw new Error(`renderer fault: ${typeof payload?.kind === 'string' ? payload.kind : 'unknown'}`)
})
ipcMain.on(channels.CH_HOST_VISIBLE_SESSIONS, () => {})
ipcMain.on(channels.CH_SET_APPEARANCE, () => {})
ipcMain.on(channels.CH_SET_GLASS_MODE, () => {})

for (const frame of fixture.initial) gate.onFrame(frame.sessionId, frame)
await window.loadFile(join(rendererDir, 'index.html'))
await waitForObserver(window)

for (let index = 0; index < workload.sessions; index++) {
  const sessionId = `benchmark-session-${index}`
  const hostEvent: HostEvent = { type: 'session-added', session: {
    appSessionId: sessionId, engineSessionId: `benchmark-engine-${index}`, cwd: runDir,
    title: `Synthetic ${index + 1}`, forked: false, titleUpdatedAt: null, status: 'ready',
    restorable: false, parked: false, createdAt: 0, lastAttachedAt: 0, lastMessageSentAt: null,
  } }
  window.webContents.send(channels.CH_HOST_EVENT, hostEvent)
}

await sleep(manifest.warmupMs)
await window.webContents.executeJavaScript('window.__CATCODE_STREAMING_BENCHMARK__.reset()')

// Align main's monotonic clock to the renderer clock. Half the minimum round
// trip bounds the offset uncertainty; before and after samples expose drift.
const calibrationBefore = await calibrate(window)
app.getAppMetrics() // establishes the per-process CPU interval
const cpuStart = process.cpuUsage()
const wallStart = performance.now()
for (const arrival of fixture.arrivals) {
  const due = wallStart + arrival.atMs
  const wait = due - performance.now()
  if (wait > 0) await sleep(wait)
  const at = performance.now()
  const traceId = arrival.frame.deliveryTrace?.traceId
  if (traceId) arrivalByTraceId.set(traceId, at)
  const forwarded = gate.onFrame(arrival.frame.sessionId, arrival.frame)
  if (forwarded.length === 0) continue
  if (policyName === 'original') sendNow(forwarded)
  else coordinator.deliver(forwarded, arrival.barrier ? 'immediate' : 'ordinary-live')
}
coordinator.flush()
await waitForCoverage(window, fixture.arrivals.length)
const wallEnd = performance.now()
const cpu = process.cpuUsage(cpuStart)
const processMetrics = app.getAppMetrics()
const calibrationAfter = await calibrate(window)
const observer = await window.webContents.executeJavaScript('window.__CATCODE_STREAMING_BENCHMARK__.snapshot()')
const commits = Array.isArray(observer.commits) ? observer.commits : []
const observedTraceIds = commits.flatMap((commit: { frames?: Array<{ traceId: string }> }) => (commit.frames ?? []).map(item => item.traceId))
const expectedTraceIds = fixture.arrivals.map(item => item.frame.deliveryTrace?.traceId).filter((item): item is string => typeof item === 'string')
if (observer.pending?.length !== 0 || digest(observedTraceIds) !== digest(expectedTraceIds)) {
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
  fixtureHash: fixture.hash, expectedFrames: fixture.arrivals.length, observedFrames: latencies.length,
  sendCount, dispatchCount: observer.dispatchCount, commitCount: observer.commitCount,
  pendingObserverFrames: observer.pending?.length ?? -1, queue: coordinator.stats(),
  wallMs: wallEnd - wallStart, mainCpuMicros: cpu.user + cpu.system,
  electronCpu: processMetrics.filter(item => item.type === 'Browser' || item.type === 'Tab').map(item => ({
    type: item.type, pid: item.pid, percentCPUUsage: item.cpu.percentCPUUsage,
    cumulativeCPUUsage: item.cpu.cumulativeCPUUsage ?? null,
  })),
  latencyMs: latencies, calibration: { before: calibrationBefore, after: calibrationAfter },
  clockAlignmentUncertaintyMs: Math.max(
    calibrationBefore.uncertaintyMs,
    calibrationAfter.uncertaintyMs,
    Math.abs(calibrationAfter.rendererToMainOffsetMs - calibrationBefore.rendererToMainOffsetMs) / 2,
  ),
  expectedTraceHash: digest(expectedTraceIds), observedTraceHash: digest(observedTraceIds), frameOrderVerified: true,
  finalRawMessageCount: commits.at(-1)?.rawMessageCount ?? -1,
}
writeFileSync(join(runDir, 'result.json'), `${JSON.stringify(result)}\n`)
coordinator.dispose()
window.destroy()
app.quit()

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}
function sleep(ms: number) { return new Promise(resolve => setTimeout(resolve, ms)) }
async function waitForObserver(target: BrowserWindow) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (await target.webContents.executeJavaScript("typeof window.__CATCODE_STREAMING_BENCHMARK__?.snapshot === 'function'")) return
    await sleep(20)
  }
  throw new Error('benchmark observer did not mount')
}
async function waitForCoverage(target: BrowserWindow, expected: number) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const value = await target.webContents.executeJavaScript('window.__CATCODE_STREAMING_BENCHMARK__.snapshot()')
    const covered = value.commits.reduce((sum: number, item: { frames: unknown[] }) => sum + item.frames.length, 0)
    if (covered >= expected && value.pending.length === 0) return
    await sleep(20)
  }
  throw new Error('final commit/state coverage barrier timed out')
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
