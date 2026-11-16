import { expect, test } from 'bun:test'
import { coercePermissionResponse } from './permissionResponse.js'

for (const applySuggestions of [undefined, [], [0, 2]]) {
  test(`qualified approval survives main boundary with ${JSON.stringify(applySuggestions)}`, () => {
    const response = coercePermissionResponse({ behavior: 'allow', updatedInput: {}, acceptFeedback: 'only inspect', applySuggestions })
    expect(response).toEqual({ behavior: 'allow', updatedInput: {}, acceptFeedback: 'only inspect', ...(applySuggestions?.length ? { applySuggestions } : {}) })
  })
}
test('feedback validation fails closed, including nonallow responses', () => {
  for (const acceptFeedback of [null, 7, {}, 'x'.repeat(16_385)]) {
    expect(coercePermissionResponse({ behavior: 'allow', acceptFeedback })).toBeNull()
  }
  expect(coercePermissionResponse({ behavior: 'deny', message: 'no', acceptFeedback: 'qualified' })).toBeNull()
  expect(coercePermissionResponse({ behavior: 'allow', acceptFeedback: 'x'.repeat(16_384) })?.behavior).toBe('allow')
  expect(coercePermissionResponse({ behavior: 'allow', acceptFeedback: '' })).toEqual({ behavior: 'allow', updatedInput: {}, acceptFeedback: '' })
})
test('suggestions remain indices only and renderer rules are not forwarded', () => {
  for (const applySuggestions of [[-1], [0.5], ['0'], {}, [NaN]]) {
    expect(coercePermissionResponse({ behavior: 'allow', acceptFeedback: 'inspect', applySuggestions })).toBeNull()
  }
  expect(coercePermissionResponse({ behavior: 'allow', updatedPermissions: ['anything'] })).toEqual({ behavior: 'allow', updatedInput: {} })
  expect(coercePermissionResponse({ behavior: 'deny', message: 'no' })).toEqual({ behavior: 'deny', message: 'no' })
})
