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
