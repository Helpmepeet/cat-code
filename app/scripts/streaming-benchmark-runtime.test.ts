import { expect, test } from 'bun:test'
import { advanceDocumentSubscription, isCurrentDocumentAcknowledgement } from './streaming-benchmark-runtime.js'

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
