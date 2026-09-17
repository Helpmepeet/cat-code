import { expect, test } from 'bun:test'
import { createModelCallRecorder } from './modelAttemptRecorder.js'

test('records stable call and attempt identities with monotonic first-text and terminal durations', () => {
  const writes: { kind: string; entry: Record<string, unknown> }[] = []
  const times = [10, 42.4, 75.6, 100, 130]
  const ids = ['call-a', 'attempt-a', 'attempt-b']
  const recorder = createModelCallRecorder({
    monotonicNow: () => times.shift()!,
    id: () => ids.shift()!,
    sink: {
      start: entry => writes.push({ kind: 'start', entry }),
      firstText: entry => writes.push({ kind: 'text', entry }),
      end: entry => writes.push({ kind: 'end', entry }),
    },
  })
  const attempt = recorder.startAttempt({
    model: 'claude-sonnet-4-6',
    provider: 'firstParty',
    mode: 'streaming',
  })
  attempt.noteFirstText('hello')
  attempt.noteFirstText('ignored')
  attempt.end('succeeded')
  attempt.end('failed')
  const retry = recorder.startAttempt({
    model: 'claude-sonnet-4-6',
    provider: 'firstParty',
    mode: 'streaming',
  })
  retry.end('cancelled')

  expect(writes).toEqual([
    { kind: 'start', entry: { schema_version: 1, call_id: 'call-a', attempt_id: 'attempt-a', attempt_index: 1, provider: 'firstParty', model: 'claude-sonnet-4-6', mode: 'streaming' } },
    { kind: 'text', entry: { schema_version: 1, call_id: 'call-a', attempt_id: 'attempt-a', duration_ms: 32 } },
    { kind: 'end', entry: { schema_version: 1, call_id: 'call-a', attempt_id: 'attempt-a', outcome: 'succeeded', duration_ms: 66 } },
    { kind: 'start', entry: { schema_version: 1, call_id: 'call-a', attempt_id: 'attempt-b', attempt_index: 2, provider: 'firstParty', model: 'claude-sonnet-4-6', mode: 'streaming' } },
    { kind: 'end', entry: { schema_version: 1, call_id: 'call-a', attempt_id: 'attempt-b', outcome: 'cancelled', duration_ms: 30 } },
  ])
})

test('non-streaming and empty text stay unavailable while sink failures cannot alter control flow', () => {
  let now = 5
  const writes: string[] = []
  const recorder = createModelCallRecorder({
    monotonicNow: () => now,
    id: (() => { let n = 0; return () => `id-${++n}` })(),
    sink: {
      start: () => { throw new Error('disk unavailable') },
      firstText: () => writes.push('text'),
      end: () => writes.push('end'),
    },
  })
  const attempt = recorder.startAttempt({ model: 'model', provider: 'openai', mode: 'non_streaming' })
  attempt.noteFirstText('full response arrived')
  attempt.noteFirstText('')
  now = 8
  expect(() => attempt.end('cancelled')).not.toThrow()
  expect(writes).toEqual(['end'])
})
