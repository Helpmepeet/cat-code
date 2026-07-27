import { expect, test } from 'bun:test'
import { executeEffort } from './effort.js'

test('/effort rejects models that do not send an effort parameter', () => {
  const result = executeEffort('medium', 'claude-haiku-4-5-20251001')
  expect(result.message).toContain('not supported')
  expect(result.effortUpdate).toBeUndefined()
})

test('/effort rejects a named level the current Claude model would clamp', () => {
  const result = executeEffort('xhigh', 'claude-sonnet-4-6')
  expect(result.message).toContain('Valid options are: low, medium, high, auto')
  expect(result.effortUpdate).toBeUndefined()
})

test('/effort accepts max on Opus 4.6 without silently normalizing it', () => {
  const result = executeEffort('max', 'claude-opus-4-6')
  expect(result.message).toContain('Set effort level to Max')
  expect(result.effortUpdate?.value).toBe('max')
})
