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

/**
 * The stages a downstream process reports back rather than performs. This is the
 * single source of truth: `DeliveryAcknowledgement['stage']` derives from it, and
 * so does the classifier. Three hand-maintained copies of this set used to exist,
 * and a `default` arm meant a new stage was silently labelled an action.
 */
export const DELIVERY_ACKNOWLEDGEMENT_STAGES = [
  'preload.received',
  'renderer.subscription.received',
  'renderer.state.queued',
  'renderer.state.applied',
  'renderer.ui.committed',
] as const

export type DeliveryAcknowledgementStage = (typeof DELIVERY_ACKNOWLEDGEMENT_STAGES)[number]

/** Compilation fails here if an acknowledgement stage is not a delivery stage. */
const _acknowledgementStagesAreDeliveryStages: Record<DeliveryAcknowledgementStage, DeliveryStage> = {
  'preload.received': 'preload.received',
  'renderer.subscription.received': 'renderer.subscription.received',
  'renderer.state.queued': 'renderer.state.queued',
  'renderer.state.applied': 'renderer.state.applied',
  'renderer.ui.committed': 'renderer.ui.committed',
}
void _acknowledgementStagesAreDeliveryStages

export type DeliveryObservationKind = 'action' | 'acknowledgement'

export function deliveryObservationKind(stage: DeliveryStage): DeliveryObservationKind {
  return (DELIVERY_ACKNOWLEDGEMENT_STAGES as readonly string[]).includes(stage)
    ? 'acknowledgement'
    : 'action'
}

export type DeliveryAnomalyScope = 'source_sequence' | 'stage_sequence'

/**
 * Shared so the producer and the export validator cannot drift. When they did,
 * the cross-check silently rejected records the producer had just written.
 */
export function deliveryAnomalyScope(recordKind: string): DeliveryAnomalyScope {
  return recordKind === 'trace.sequence.gap' ? 'source_sequence' : 'stage_sequence'
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
  stage: DeliveryAcknowledgementStage
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
