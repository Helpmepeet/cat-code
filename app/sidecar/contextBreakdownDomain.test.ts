import { describe, expect, test } from 'bun:test'
import { createSidecarContextBreakdownDomain } from './contextBreakdownDomain.js'
import type {
  ContextBreakdownCategory,
  ContextBreakdownSnapshot,
} from '../shared/protocol.js'

const SNAPSHOT: ContextBreakdownSnapshot = {
  categories: [
    { label: 'System prompt', tokens: 4_200, colorKey: 'promptBorder', deferred: false },
    { label: 'System tools', tokens: 8_600, colorKey: 'inactive', deferred: false },
    { label: 'MCP tools (deferred)', tokens: 2_900, colorKey: 'inactive', deferred: true },
    { label: 'Messages', tokens: 21_000, colorKey: 'purple_FOR_SUBAGENTS_ONLY', deferred: false },
  ],
  usedTokens: 33_800,
  contextWindow: 200_000,
  model: 'gpt-5.6-luna',
}

describe('context breakdown domain', () => {
  test('passes the engine analysis through untouched', async () => {
    const domain = createSidecarContextBreakdownDomain({
      executor: { analyze: async () => SNAPSHOT },
    })
    expect(await domain.snapshot()).toEqual(SNAPSHOT)
  })

  test('a session with no transcript yet reports null, not an empty breakdown', async () => {
    const domain = createSidecarContextBreakdownDomain({
      executor: { analyze: async () => null },
    })
    expect(await domain.snapshot()).toBeNull()
  })

  // Display degrades gracefully: an analyzer throw must cost the popover its
  // breakdown, never the connection.
  test('an analyzer failure degrades to null and reports the error', async () => {
    const seen: unknown[] = []
    const domain = createSidecarContextBreakdownDomain({
      executor: {
        analyze: async () => {
          throw new Error('tokenizer unavailable')
        },
      },
      onError: error => seen.push(error),
    })
    expect(await domain.snapshot()).toBeNull()
    expect(seen).toHaveLength(1)
    expect((seen[0] as Error).message).toBe('tokenizer unavailable')
  })

  test('deferred categories stay flagged so a reader can exclude them', async () => {
    const domain = createSidecarContextBreakdownDomain({
      executor: { analyze: async () => SNAPSHOT },
    })
    const snapshot = await domain.snapshot()
    if (!snapshot) throw new Error('expected a snapshot')
    const counted = snapshot.categories.filter(
      (c: ContextBreakdownCategory) => !c.deferred,
    )
    expect(counted.map(c => c.label)).toEqual([
      'System prompt',
      'System tools',
      'Messages',
    ])
    expect(counted.reduce((sum, c) => sum + c.tokens, 0)).toBe(snapshot.usedTokens)
  })
})
