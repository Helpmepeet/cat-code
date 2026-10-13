import { expect, test } from 'bun:test'
import { parseScheduledTaskOptionsRequest, parseScheduledTaskOptionsResult, validScheduledTaskOptionsPayload } from './scheduledTaskOptions.js'

const result = { type: 'scheduled-options-result', version: 1,
  models: [{ value: 'gpt-6-sol', label: 'Sol', provider: 'openai', effortOptions: ['ultra'] }],
  defaultEffortOptions: ['high'], projectPaths: ['/project'] }
test('options observation has fixed undefined-only host input and closed worker schemas', () => {
  expect(validScheduledTaskOptionsPayload(undefined)).toBe(true)
  for (const payload of [null, {}, { cwd: '/private' }, { sessionId: crypto.randomUUID() }, []]) expect(validScheduledTaskOptionsPayload(payload)).toBe(false)
  expect(parseScheduledTaskOptionsRequest({ type: 'scheduled-options', version: 1 })).not.toBeNull()
  expect(parseScheduledTaskOptionsRequest({ type: 'scheduled-options', version: 1, cwd: '/private' })).toBeNull()
  expect(parseScheduledTaskOptionsResult(result)).not.toBeNull()
  for (const invalid of [{ ...result, extra: true }, { ...result, version: 2 },
    { ...result, projectPaths: ['relative'] }, { ...result, defaultEffortOptions: ['invented'] },
    { ...result, models: [{ ...result.models[0], provider: 'unknown' }] },
    { ...result, models: [{ ...result.models[0], credentials: 'secret' }] }]) {
    expect(parseScheduledTaskOptionsResult(invalid)).toBeNull()
  }
})
