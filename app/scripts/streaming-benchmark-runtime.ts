import type { ServerFrame } from '../shared/protocol.js'

export type DocumentSubscription = { documentId: string; epoch: number }

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
export function markerTracedBootstrap(initial: readonly ServerFrame[], snapshots: readonly ServerFrame[], terminalMarker: ServerFrame): ServerFrame[] {
  if (!terminalMarker.deliveryTrace) throw new Error('bootstrap marker must be traced')
  const withoutTrace = (frame: ServerFrame): ServerFrame => {
    if (!frame.deliveryTrace) return frame
    const { deliveryTrace: _deliveryTrace, ...rest } = frame
    return rest as ServerFrame
  }
  return [...initial.map(withoutTrace), ...snapshots.map(withoutTrace), terminalMarker]
}
