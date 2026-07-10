import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { AgentId } from '../../types/ids.js'
import type { Message } from '../../types/message.js'

// QuerySource is a string-union type; the functions under test accept it but we
// only ever pass valid members, so a thin local alias keeps the tests honest
// without importing the (type-only) querySource module.
type QuerySource = Parameters<
  typeof import('./promptCacheBreakDetection.js').checkResponseForCacheBreak
>[0]

// Captured prompt-cache-break diagnostics. promptCacheBreakDetection records the
// final classified reason via recordPromptCacheBreak (transcript write); we
// intercept it to observe the reason for both the main and subagent paths, since
// the user-visible warning is only queued for the main thread.
type CapturedBreak = {
  querySource: string
  agentId?: AgentId
  reason: string
  staleResponseIdRetry: boolean
}
const capturedBreaks: CapturedBreak[] = []

const STALE_EVICTION_LABEL = 'server evicted previous_response_id'

beforeEach(async () => {
  capturedBreaks.length = 0
  // Capture the real sessionStorage module BEFORE mocking so we can preserve
  // every other export (filesystem helpers transitively read getProjectDir from
  // here) and override only recordPromptCacheBreak.
  const actualSessionStorage = await import('../../utils/sessionStorage.js')
  await mock.module('src/utils/sessionStorage.js', () => ({
    ...actualSessionStorage,
    recordPromptCacheBreak: (entry: CapturedBreak) => {
      capturedBreaks.push({
        querySource: entry.querySource,
        agentId: entry.agentId,
        reason: entry.reason,
        staleResponseIdRetry: entry.staleResponseIdRetry,
      })
    },
  }))
})

afterEach(async () => {
  const { resetPromptCacheBreakDetection } = await import(
    './promptCacheBreakDetection.js'
  )
  resetPromptCacheBreakDetection()
  mock.restore()
})

/**
 * Primes a tracked source through two recorded turns so the third response has a
 * non-null cache-read baseline, then signals a stale previous_response_id retry
 * and feeds a cache-read drop. Returns the detection module so the caller can
 * drain user-visible warnings.
 */
async function drivStaleRetryThenBreak(opts: {
  querySource: QuerySource
  trackingKey: string
  agentId?: AgentId
}): Promise<typeof import('./promptCacheBreakDetection.js')> {
  const mod = await import('./promptCacheBreakDetection.js')
  const {
    recordPromptState,
    checkResponseForCacheBreak,
    notifyStaleResponseIdRetry,
  } = mod

  const snapshot = {
    system: [{ type: 'text' as const, text: 'stable system prompt' }],
    toolSchemas: [],
    querySource: opts.querySource,
    model: 'gpt-5.6-terra',
    ...(opts.agentId ? { agentId: opts.agentId } : {}),
  }
  const noMessages: Message[] = []

  // Turn 1: establishes tracking state (callCount = 1).
  recordPromptState(snapshot)
  await checkResponseForCacheBreak(
    opts.querySource,
    5000, // cacheReadTokens — sets the baseline
    0,
    noMessages,
    opts.agentId,
  )

  // WS transport reports the chained response_id was evicted and retried as a
  // full send. The callback maps the conversation ID to the tracking key; here
  // we feed the resolved key directly to exercise notify → check end to end.
  notifyStaleResponseIdRetry(opts.trackingKey)

  // Turn 2: same prompt (no client-side change), then a cache-read collapse.
  recordPromptState(snapshot)
  await checkResponseForCacheBreak(
    opts.querySource,
    0, // cacheReadTokens — large drop from 5000 → break detected
    0,
    noMessages,
    opts.agentId,
  )

  return mod
}

describe('promptCacheBreakDetection stale previous_response_id retry', () => {
  test('main thread: stale retry surfaces the eviction reason and a user warning', async () => {
    const mod = await drivStaleRetryThenBreak({
      querySource: 'repl_main_thread' as QuerySource,
      trackingKey: 'repl_main_thread',
    })

    // Diagnostic reason carries the eviction label.
    const mainBreak = capturedBreaks.find(
      b => b.querySource === 'repl_main_thread',
    )
    expect(mainBreak).toBeDefined()
    expect(mainBreak?.staleResponseIdRetry).toBe(true)
    expect(mainBreak?.reason).toContain(STALE_EVICTION_LABEL)

    // Main thread also queues a user-visible cache-miss warning.
    const warnings = mod.drainCacheWarnings()
    expect(warnings.some(w => w.includes(STALE_EVICTION_LABEL))).toBe(true)
  })

  test('subagent: stale retry under the raw agentId surfaces the eviction reason', async () => {
    const agentId = 'agent_subtask_42' as AgentId
    const mod = await drivStaleRetryThenBreak({
      // Tracked prefix so getTrackingKey keys by the raw agentId.
      querySource: 'agent:custom' as QuerySource,
      trackingKey: agentId,
      agentId,
    })

    const subBreak = capturedBreaks.find(b => b.agentId === agentId)
    expect(subBreak).toBeDefined()
    expect(subBreak?.staleResponseIdRetry).toBe(true)
    expect(subBreak?.reason).toContain(STALE_EVICTION_LABEL)

    // Subagent breaks are diagnostic-only — no user-facing warning is queued.
    const warnings = mod.drainCacheWarnings()
    expect(warnings).toHaveLength(0)
  })

  test('subagent: the wrong agent-prefixed key does NOT reach the subagent state', async () => {
    // Regression guard for the original bug: notifying `agent:${id}` (instead of
    // the raw agentId) must not flip the subagent's staleResponseIdRetry flag,
    // so the eviction label would be missing from the resulting break.
    const agentId = 'agent_subtask_99' as AgentId
    await drivStaleRetryThenBreak({
      querySource: 'agent:custom' as QuerySource,
      trackingKey: `agent:${agentId}`, // the buggy mapping
      agentId,
    })

    const subBreak = capturedBreaks.find(b => b.agentId === agentId)
    expect(subBreak).toBeDefined()
    // A break is still detected (cache read dropped), but it is NOT labeled as a
    // stale-response-id eviction because the notify missed the tracking key.
    expect(subBreak?.staleResponseIdRetry).toBe(false)
    expect(subBreak?.reason).not.toContain(STALE_EVICTION_LABEL)
  })
})
