import { expect, test } from 'bun:test'
import { ACCOUNT_CONTROL_VERSION, parseAccountControlEvent, parseAccountControlVerb, parseAccountLoginReceipt } from './accountControlWorker.js'

const receipt = {
  provider: 'anthropic' as const, accountId: 'actual-account', operationId: 'engine-operation',
  outcome: 'committed' as const, loginGeneration: 2,
}

test('selection generation is optional but must be a safe nonnegative integer', () => {
  const verb = { type: 'account.switch', requestId: 'select', accountId: 'account', provider: 'anthropic' }
  expect(parseAccountControlVerb(verb)).not.toBeNull()
  expect(parseAccountControlVerb({ ...verb, expectedLoginGeneration: 0 })).not.toBeNull()
  for (const generation of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, null, '1']) {
    expect(parseAccountControlVerb({ ...verb, expectedLoginGeneration: generation })).toBeNull()
  }
})

test('login receipts accept only closed redacted committed authority', () => {
  expect(parseAccountLoginReceipt(receipt)).toEqual(receipt)
  for (const invalid of [
    { ...receipt, accessToken: 'not-allowed' }, { ...receipt, loginGeneration: null },
    { ...receipt, loginGeneration: -1 }, { ...receipt, loginGeneration: 1.5 },
    { ...receipt, operationId: '' }, { ...receipt, accountId: '' },
    { ...receipt, outcome: 'uncertain' }, { ...receipt, provider: 'other' },
  ]) expect(parseAccountLoginReceipt(invalid)).toBeNull()
  expect(parseAccountLoginReceipt({ ...receipt, outcome: 'persistence_pending', loginGeneration: null })).not.toBeNull()
})

test('host progress requires paired request and receipt with matching actual provider', () => {
  const event = {
    type: 'progress', version: ACCOUNT_CONTROL_VERSION, provider: 'anthropic',
    progress: { state: 'success', loginRequestId: 'origin-request', receipt },
  } as const
  expect(parseAccountControlEvent(event)).toEqual(event)
  expect(parseAccountControlEvent({ ...event, provider: 'openai' })).toBeNull()
  expect(parseAccountControlEvent({ ...event, progress: { state: 'success', receipt } })).toBeNull()
  expect(parseAccountControlEvent({ ...event, progress: { state: 'success', loginRequestId: 'origin-request' } })).toBeNull()
  expect(parseAccountControlEvent({ ...event, progress: { ...event.progress, credentials: {} } })).toBeNull()
  // Legacy success can refresh inventory but cannot authorize a chat reconnect.
  expect(parseAccountControlEvent({ ...event, progress: { state: 'success' } })).not.toBeNull()
})
