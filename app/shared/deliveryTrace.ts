/** Metadata-only delivery tracing. This never serializes a frame payload. */

import { randomUUID } from 'node:crypto'
import type { SDKMessage } from '@cat-code/engine/session-events'

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

/**
 * The per-frame trace record's schema version. Version 1 was one record per
 * stage transition, which cost 8,852 B for a 771 B frame: twelve copies of the
 * same six identifiers, 31% of the lane, and a 100 MB budget that held about
 * ten minutes of history. Version 2 is one record per frame sequence carrying
 * the same stage timestamps as offsets. The anomaly and rollup records are
 * unchanged and stay at 1, so only this record's shape moved.
 */
export const DELIVERY_TRACE_SCHEMA_VERSION = 2

/**
 * Why a frame's one record was written. `terminal` is the only value that means
 * the frame was observed all the way through; every other value is a partial
 * stage set flushed so a frame that STOPPED still leaves evidence, which is the
 * whole reason this lane exists.
 */
export const DELIVERY_FRAME_FLUSH_REASONS = [
  'terminal', 'buffered', 'quiescent', 'evicted', 'shutdown',
] as const

export type DeliveryFrameFlushReason = (typeof DELIVERY_FRAME_FLUSH_REASONS)[number]

export function isDeliveryFrameFlushReason(value: unknown): value is DeliveryFrameFlushReason {
  return typeof value === 'string' && (DELIVERY_FRAME_FLUSH_REASONS as readonly string[]).includes(value)
}

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
 *
 * `source_sequence` belongs to `trace.sequence.gap` alone, which since
 * 2026-08-10 means a frame that never crossed the socket. Everything else,
 * `trace.source.incomplete` included, is scoped to one stage's own marker
 * coverage: the sidecar stages ride a lossy descriptor, so a hole there is
 * missing evidence rather than a missing frame.
 */
export function deliveryAnomalyScope(recordKind: string): DeliveryAnomalyScope {
  return recordKind === 'trace.sequence.gap' ? 'source_sequence' : 'stage_sequence'
}

/**
 * The SDK message type an `event` frame carried, as a payload-free tag.
 *
 * This is a SECOND discriminator, beside `frameKind`, and the two answer
 * different questions. `frameKind` is the ServerFrame envelope discriminant
 * (`SERVER_FRAME_KINDS`, `protocol.ts`), and EVERY conversation frame is
 * `event`, so a trace of them cannot say whether a run ended in a `result`.
 * That is exactly the question the 2026-08-10 hang investigation could not
 * answer from a trace with perfect 11-stage continuity, filed as item B3 in
 * `docs/reports/2026-08-10-overnight-hang-log-request.md`.
 *
 * A type tag is not content: no text, no tool names, no ids. Frames carrying no
 * SDK message (`ready`, `pong`, the snapshot kinds) simply have no tag; there is
 * no value standing for "not a message".
 *
 * These five are a deliberate SUBSET of the engine's 15 `SDKMessage`
 * discriminants, not the whole union: they are the turn-shaped ones a delivery
 * question is asked about. Two further app-seam variants (`tool_progress`,
 * `tool_use_summary`) therefore stay untagged, so an absent tag means "no tag
 * for this frame", never "not an SDK message".
 *
 * `satisfies` is the tripwire: compilation fails if a name here is not an
 * `SDKMessage` discriminant, so a renamed engine variant cannot leave behind a
 * tag no frame can ever carry. The reverse direction is deliberately not total,
 * which is what makes the subset above legal.
 */
export const DELIVERY_MESSAGE_KINDS = [
  'assistant', 'user', 'system', 'result', 'stream_event',
] as const satisfies readonly SDKMessage['type'][]

export type DeliveryMessageKind = (typeof DELIVERY_MESSAGE_KINDS)[number]

export function isDeliveryMessageKind(value: unknown): value is DeliveryMessageKind {
  return typeof value === 'string' && (DELIVERY_MESSAGE_KINDS as readonly string[]).includes(value)
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
