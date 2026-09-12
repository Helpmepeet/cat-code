import type { ServerFrame } from '../shared/protocol.js'

export type DocumentSubscription = { documentId: string; epoch: number }
export type ClockCalibration = { rendererToMainOffsetMs: number; uncertaintyMs: number }

/** Endpoint round-trip uncertainty and observed half-drift are independent bounds. */
export function clockAlignmentUncertaintyMs(before: ClockCalibration, after: ClockCalibration): number {
  const endpointUncertainty = Math.max(before.uncertaintyMs, after.uncertaintyMs)
  const halfDrift = Math.abs(after.rendererToMainOffsetMs - before.rendererToMainOffsetMs) / 2
  return endpointUncertainty + halfDrift
}

export function advanceDocumentSubscription(current: DocumentSubscription, documentId: string): DocumentSubscription {
  return documentId === current.documentId
    ? { documentId, epoch: current.epoch + 1 }
    : { documentId, epoch: 1 }
}

export function isCurrentDocumentAcknowledgement(
  current: DocumentSubscription,
  acknowledgement: { documentId: string; subscriptionEpoch: number },
): boolean {
  return acknowledgement.documentId === current.documentId && acknowledgement.subscriptionEpoch === current.epoch
}

/** Bulk bootstrap is state setup, outside the scored replay/ACK measurement. */
export function markerTracedBootstrap(initial: readonly ServerFrame[], snapshots: readonly ServerFrame[], terminalMarker: ServerFrame | readonly ServerFrame[]): ServerFrame[] {
  const markers = Array.isArray(terminalMarker) ? terminalMarker : [terminalMarker]
  if (markers.length < 1 || markers.some(marker => !marker.deliveryTrace)) throw new Error('bootstrap markers must be traced')
  const withoutTrace = (frame: ServerFrame): ServerFrame => {
    if (!frame.deliveryTrace) return frame
    const { deliveryTrace: _deliveryTrace, ...rest } = frame
    return rest as ServerFrame
  }
  return [...initial.map(withoutTrace), ...snapshots.map(withoutTrace), ...markers]
}
