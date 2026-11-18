import { expect, test } from 'bun:test'
import { MAX_SUGGESTION_SELECTIONS } from '../shared/limits.js'
import { preparePermissionResponse } from './permissionResponse.js'

const sessionId = '05d5f9d4-1d37-4da7-b8d1-c86eb91e7dd6'
const requestId = 'permission-1'
const prepare = (input: unknown) => preparePermissionResponse(sessionId, requestId, input)

for (const applySuggestions of [undefined, [], [0, 2]]) {
  test(`qualified approval survives main boundary with ${JSON.stringify(applySuggestions)}`, () => {
    expect(prepare({ behavior: 'allow', updatedInput: {}, acceptFeedback: 'only inspect', applySuggestions })).toEqual({
      type: 'permission.response',
      requestId,
      response: { behavior: 'allow', updatedInput: {}, acceptFeedback: 'only inspect', ...(applySuggestions?.length ? { applySuggestions } : {}) },
    })
  })
}
test('feedback validation fails closed, including nonallow responses', () => {
  for (const acceptFeedback of [null, 7, {}, 'x'.repeat(16_385)]) {
    expect(prepare({ behavior: 'allow', acceptFeedback })).toMatchObject({ kind: 'error', code: 'bad_request' })
  }
  expect(prepare({ behavior: 'deny', message: 'no', acceptFeedback: 'qualified' })).toMatchObject({ kind: 'error', code: 'bad_request' })
  expect(prepare({ behavior: 'allow', acceptFeedback: 'x'.repeat(16_384) })).toMatchObject({ response: { behavior: 'allow' } })
  expect(prepare({ behavior: 'allow', acceptFeedback: '' })).toMatchObject({ response: { behavior: 'allow', updatedInput: {}, acceptFeedback: '' } })
})
test('suggestions remain indices only and renderer rules are not forwarded', () => {
  for (const applySuggestions of [[-1], [0.5], ['0'], {}, [NaN], Array(1)]) {
    expect(prepare({ behavior: 'allow', acceptFeedback: 'inspect', applySuggestions })).toMatchObject({ kind: 'error', code: 'bad_request' })
  }
  expect(prepare({ behavior: 'allow', updatedPermissions: ['anything'] })).toEqual({
    type: 'permission.response', requestId, response: { behavior: 'allow', updatedInput: {} },
  })
  expect(prepare({ behavior: 'deny', message: 'no' })).toEqual({
    type: 'permission.response', requestId, response: { behavior: 'deny', message: 'no' },
  })
})

test('oversized selections return a rejection addressed to the submitted card', () => {
  const applySuggestions = Array.from({ length: MAX_SUGGESTION_SELECTIONS }, (_, index) => index)
  expect(prepare({ behavior: 'allow', applySuggestions })).toMatchObject({
    type: 'permission.response', requestId, response: { applySuggestions },
  })
  expect(prepare({ behavior: 'allow', applySuggestions: [...applySuggestions, MAX_SUGGESTION_SELECTIONS] })).toMatchObject({
    kind: 'error', code: 'bad_request', sessionId, requestId, retryable: true,
  })
})
