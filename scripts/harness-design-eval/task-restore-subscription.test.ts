import { expect, test } from 'bun:test'
import { subscriptionUsage } from './task-restore/subscription.js'
import { exposure } from './task-restore/run.js'

// Authoring gate: subscription usage is inclusive and provider-authoritative.
// Anthropic accounting cannot catch cache double-counting, lost reasoning or
// missing raw completion here. No production seam or model mock is required.
test('subscription accounting keeps failed requests and inclusive cache/reasoning counts', () => {
  const records = [
    { kind: 'request', attempt: 1 },
    { kind: 'provider-response', attempt: 1, status: 200, completed: true,
      usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 80 }, output_tokens: 30, output_tokens_details: { reasoning_tokens: 20 } } },
    { kind: 'request', attempt: 2 },
    { kind: 'provider-response', attempt: 2, status: 500, completed: false },
    { kind: 'request', attempt: 3 },
  ]
  expect(subscriptionUsage(records)).toEqual({ input: 100, cached: 80, output: 30, reasoning: 20,
    unknownAttempts: 2, attempts: 3, inputIncludesCached: true, outputIncludesReasoning: true })
  records[1]!.completed = false
  expect(subscriptionUsage(records).unknownAttempts).toBe(3)
})

// The final Responses input, rather than an earlier Messages projection,
// establishes delivery. A translator omission must invalidate this evidence.
test('restoration exposure uses final subscription input', () => {
  const record = { kind: 'request', phase: 'work', body: { tools: [{ name: 'Bash' }],
    messages: [{ text: 'Unfinished tracked work at compaction.' }] },
    providerBody: { input: [{ text: 'retained-tracking-id' }] } }
  expect(exposure([record], { trackingIds: ['retained-tracking-id'] }, true)).toMatchObject({ snapshotCount: 0, valid: false })
  record.providerBody.input = [{ text: 'Unfinished tracked work at compaction.' }]
  expect(exposure([record], { trackingIds: ['retained-tracking-id'] }, true)).toMatchObject({ snapshotCount: 1, valid: true })
})
