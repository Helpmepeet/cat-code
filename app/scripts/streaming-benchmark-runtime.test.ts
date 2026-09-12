import { expect, test } from 'bun:test'
import { advanceDocumentSubscription, isCurrentDocumentAcknowledgement } from './streaming-benchmark-runtime.js'
import { markerTracedBootstrap } from './streaming-benchmark-runtime.js'
import { DeliveryAckQueue } from '../preload/deliveryAckQueue.js'
import { createRendererIpcGuard } from '../preload/rendererIpcGuard.js'
import { createFixture, manifest } from '../../docs/reports/2026-09-12-live-streaming-measurements/fixture.js'
import { mintDeliveryTrace, type DeliveryAcknowledgementStage } from '../shared/deliveryTrace.js'
import type { ServerFrame } from '../shared/protocol.js'

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

test('all workload bootstraps keep a bounded traced marker whose applied ACK survives the real queue and guard', () => {
  const stages: DeliveryAcknowledgementStage[] = ['preload.received', 'renderer.subscription.received', 'renderer.state.queued', 'renderer.state.applied']
  for (const workload of manifest.workloads) {
    const fixture = createFixture(workload)
    const marker: ServerFrame = { kind: 'pong', protocolVersion: 1, sessionId: 'bootstrap', nonce: 'marker', deliveryTrace: mintDeliveryTrace(1) }
    const bootstrap = markerTracedBootstrap(fixture.initial, [], marker)
    expect(bootstrap.filter(frame => frame.deliveryTrace)).toEqual([marker])
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
    for (const stage of stages) queue.push('bootstrap', 1, 1, marker.deliveryTrace!.streamEpoch, marker.deliveryTrace!.traceId, stage)
    timers[0]?.()
    const acknowledgements = (sent[0] as { acknowledgements: Array<{ stage: string }> }).acknowledgements
    expect(acknowledgements.some(item => item.stage === 'renderer.state.applied')).toBe(true)
    expect(queue.pendingCount).toBe(0)
  }
})
