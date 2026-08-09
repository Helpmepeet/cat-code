/** Metadata-only delivery tracing. This never serializes a frame payload. */

import { randomUUID } from 'node:crypto'

export const DELIVERY_STAGES = [
  'engine.produced',
  'sidecar.received',
  'sidecar.socket.queued',
  'sidecar.socket.sent',
  'supervisor.socket.received',
  'host.received',
  'attachment.buffered',
  'attachment.replayed',
  'main.ipc.queued',
  'main.ipc.sent',
  'preload.received',
  'renderer.subscription.received',
  'renderer.state.queued',
  'renderer.state.applied',
  'renderer.ui.committed',
] as const

export type DeliveryStage = (typeof DELIVERY_STAGES)[number]

export type DeliveryObservationKind = 'action' | 'acknowledgement'

export function deliveryObservationKind(stage: DeliveryStage): DeliveryObservationKind {
  switch (stage) {
    case 'preload.received':
    case 'renderer.subscription.received':
    case 'renderer.state.queued':
    case 'renderer.state.applied':
    case 'renderer.ui.committed':
      return 'acknowledgement'
    default:
      return 'action'
  }
}

/** Additive envelope metadata; never inspect or rewrite AppSessionEvent content. */
export type DeliveryTrace = Readonly<{
  streamEpoch: string
  sequence: number
  traceId: string
  deliveryAttempt: number
  replay: boolean
  /** Identity and clocks from the sidecar process which minted the sequence. */
  sourceProcessInstanceId: string
  sourceWallTimestamp: string
  sourceMonotonicTimestampMs: number
  connectionEpoch: number
}>

export type DeliveryAcknowledgement = Readonly<{
  sessionId: string
  streamEpoch: string
  sequence: number
  deliveryAttempt: number
  traceId: string
  stage: Extract<DeliveryStage, 'preload.received' | 'renderer.subscription.received' | 'renderer.state.queued' | 'renderer.state.applied' | 'renderer.ui.committed'>
  documentId: string
  subscriptionEpoch: number
  rendererProcessInstanceId: string
  rendererProcessStartedAt: string
}>

/**
 * A sidecar-originated, metadata-only causal marker.  It travels on the
 * dedicated diagnostics descriptor rather than in the frame payload, so a
 * frame that never reaches main can still leave truthful evidence.
 */
export type SidecarDeliveryStageRecord = Readonly<{
  recordKind: 'delivery.trace'
  sessionId: string
  trace: DeliveryTrace
  stage: Extract<DeliveryStage, 'engine.produced' | 'sidecar.received' | 'sidecar.socket.queued' | 'sidecar.socket.sent'>
  frameKind: string
  wallTimestamp: string
  monotonicTimestampMs: number
  processInstanceId: string
  processStartedAt: string
}>

export function mintDeliveryTrace(
  sequence: number,
  streamEpoch: string = randomUUID(),
  sourceProcessInstanceId: string = randomUUID(),
  now: () => Date = () => new Date(),
  monotonicNow: () => number = () => performance.now(),
  connectionEpoch = 1,
): DeliveryTrace {
  return {
    streamEpoch,
    sequence,
    traceId: randomUUID(),
    deliveryAttempt: 1,
    replay: false,
    sourceProcessInstanceId,
    sourceWallTimestamp: now().toISOString(),
    sourceMonotonicTimestampMs: monotonicNow(),
    connectionEpoch,
  }
}

export function replayDeliveryTrace(trace: DeliveryTrace): DeliveryTrace {
  return { ...trace, deliveryAttempt: trace.deliveryAttempt + 1, replay: true }
}

export function isDeliveryStage(value: unknown): value is DeliveryStage {
  return typeof value === 'string' && (DELIVERY_STAGES as readonly string[]).includes(value)
}

export function isSafeDeliveryIdentifier(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}
