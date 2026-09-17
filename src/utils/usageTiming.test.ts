import { expect, test } from 'bun:test'
import { summarizeUsageTiming } from './usageTiming.js'

test('summarizes retries, terminal outcomes, and measured latency populations', () => {
  const timing = summarizeUsageTiming(
    [
      {
        callId: 'call-a',
        mode: 'streaming',
        outcome: 'failed',
        durationMs: 20,
        firstTextMs: null,
      },
      {
        callId: 'call-a',
        mode: 'streaming',
        outcome: 'succeeded',
        durationMs: 100,
        firstTextMs: 40,
      },
      {
        callId: 'call-b',
        mode: 'non_streaming',
        outcome: 'succeeded',
        durationMs: 300,
        firstTextMs: null,
      },
      {
        callId: 'call-c',
        mode: 'streaming',
        outcome: 'incomplete',
        durationMs: null,
        firstTextMs: 80,
      },
    ],
    [
      { outcome: 'succeeded', durationMs: 10 },
      { outcome: 'failed', durationMs: 30 },
      { outcome: 'cancelled', durationMs: 50 },
      { outcome: 'incomplete', durationMs: null },
    ],
  )

  expect(timing.models).toEqual({
    state: 'available',
    logicalCalls: 3,
    retriedCalls: 1,
    streamingAttempts: 3,
    outcomes: {
      started: 4,
      succeeded: 2,
      failed: 1,
      cancelled: 0,
      incomplete: 1,
    },
    responseDuration: { samples: 2, p50Ms: 100, p95Ms: 300 },
    firstText: { samples: 2, p50Ms: 40, p95Ms: 80 },
  })
  expect(timing.tools).toEqual({
    state: 'available',
    outcomes: {
      started: 4,
      succeeded: 1,
      failed: 1,
      cancelled: 1,
      incomplete: 1,
    },
    duration: { samples: 1, p50Ms: 10, p95Ms: 10 },
  })
})

test('old history remains unavailable rather than appearing as zero latency', () => {
  const timing = summarizeUsageTiming([], [])
  expect(timing.models.state).toBe('unavailable')
  expect(timing.models.responseDuration).toEqual({
    samples: 0,
    p50Ms: null,
    p95Ms: null,
  })
  expect(timing.tools.state).toBe('unavailable')
})
