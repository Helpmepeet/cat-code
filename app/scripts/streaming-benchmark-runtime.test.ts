import { expect, test } from 'bun:test'
import { advanceDocumentSubscription, clockAlignmentUncertaintyMs, isCurrentDocumentAcknowledgement } from './streaming-benchmark-runtime.js'
import { markerTracedBootstrap } from './streaming-benchmark-runtime.js'
import { DeliveryAckQueue } from '../preload/deliveryAckQueue.js'
import { createRendererIpcGuard } from '../preload/rendererIpcGuard.js'
import { createFixture, manifest } from '../../docs/reports/2026-09-12-live-streaming-measurements/fixture.js'
import { mintDeliveryTrace, type DeliveryAcknowledgementStage } from '../shared/deliveryTrace.js'
import type { ServerFrame } from '../shared/protocol.js'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

test('a fresh document restarts at the preload epoch while same-document readiness advances', () => {
  expect(advanceDocumentSubscription({ documentId: 'old', epoch: 7 }, 'new')).toEqual({ documentId: 'new', epoch: 1 })
  expect(advanceDocumentSubscription({ documentId: 'same', epoch: 1 }, 'same')).toEqual({ documentId: 'same', epoch: 2 })
})

test('acknowledgements must match both current document and current epoch', () => {
  const current = { documentId: 'new', epoch: 1 }
  expect(isCurrentDocumentAcknowledgement(current, { documentId: 'new', subscriptionEpoch: 1 })).toBe(true)
  expect(isCurrentDocumentAcknowledgement(current, { documentId: 'old', subscriptionEpoch: 1 })).toBe(false)
  expect(isCurrentDocumentAcknowledgement(current, { documentId: 'new', subscriptionEpoch: 2 })).toBe(false)
})

test('clock alignment bound adds endpoint uncertainty and observed half-drift', () => {
  expect(clockAlignmentUncertaintyMs(
    { rendererToMainOffsetMs: 2.0, uncertaintyMs: 0.04 },
    { rendererToMainOffsetMs: 2.2, uncertaintyMs: 0.05 },
  )).toBeCloseTo(0.15, 12)
})

test('all workload bootstraps keep a bounded traced marker whose applied ACK survives the real queue and guard', () => {
  const stages: DeliveryAcknowledgementStage[] = ['preload.received', 'renderer.subscription.received', 'renderer.state.queued', 'renderer.state.applied']
  for (const workload of manifest.workloads) {
    const fixture = createFixture(workload)
    const markers: ServerFrame[] = Array.from({ length: workload.sessions }, (_, index) => ({
      kind: 'pong', protocolVersion: 1, sessionId: `bootstrap-${index}`, nonce: 'marker', deliveryTrace: mintDeliveryTrace(index + 1),
    }))
    const bootstrap = markerTracedBootstrap(fixture.initial, [], markers)
    expect(bootstrap.filter(frame => frame.deliveryTrace)).toEqual(markers)
    const timers: Array<() => void> = []
    const sent: unknown[] = []
    const guard = createRendererIpcGuard({ now: () => 1 })
    const queue = new DeliveryAckQueue({
      assertAllowed: (payload, kind) => guard.assertAllowed(payload, kind),
      send: (_channel, payload) => sent.push(payload),
      documentId: 'document', processInstanceId: 'renderer', processStartedAt: '2026-09-12T00:00:00.000Z',
      getSubscriptionEpoch: () => 1,
      setTimeout: callback => { timers.push(callback); return callback as unknown as ReturnType<typeof setTimeout> },
      clearTimeout: () => {},
    }, { channel: 'ack', maxBatchSize: 64, maxPending: 1024, flushIntervalMs: 50 })
    for (const marker of markers) for (const stage of stages) queue.push(marker.sessionId, marker.deliveryTrace!.sequence, 1, marker.deliveryTrace!.streamEpoch, marker.deliveryTrace!.traceId, stage)
    timers[0]?.()
    const acknowledgements = (sent[0] as { acknowledgements: Array<{ stage: string }> }).acknowledgements
    expect(acknowledgements.filter(item => item.stage === 'renderer.state.applied')).toHaveLength(workload.sessions)
    expect(queue.pendingCount).toBe(0)
  }
})

test('Electron entry finishes module evaluation before awaiting app readiness', () => {
  const source = readFileSync(resolve(import.meta.dir, 'streaming-benchmark-main.ts'), 'utf8')
  expect(source).toContain('async function run(): Promise<void>')
  expect(source).toContain('void run().catch(fatalExit)')
  expect(source).not.toMatch(/^await app\.whenReady\(\)/m)
})
