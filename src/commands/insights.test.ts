import { describe, expect, test } from 'bun:test'
import { extractMissingFacetsForInsights } from './insights.js'
import type { LogOption } from '../types/logs.js'

type TestFacet = Awaited<ReturnType<typeof extractMissingFacetsForInsights>> extends Map<
  string,
  infer F
>
  ? F
  : never

function makeFacet(sessionId: string): TestFacet {
  return {
    session_id: sessionId,
    underlying_goal: 'Fix insight report data',
    goal_categories: { debug_investigate: 1 },
    outcome: 'fully_achieved',
    user_satisfaction_counts: { satisfied: 1 },
    claude_helpfulness: 'very_helpful',
    session_type: 'single_task',
    friction_counts: { tool_failed: 1 },
    friction_detail: 'Facet extraction failed under too much concurrency.',
    primary_success: 'good_debugging',
    brief_summary: 'Debugged empty insight facets.',
  }
}

describe('extractMissingFacetsForInsights', () => {
  test('limits concurrent facet extraction calls', async () => {
    let active = 0
    let maxActive = 0
    const saved: string[] = []
    const items = Array.from({ length: 8 }, (_, i) => ({
      log: {} as LogOption,
      sessionId: `session-${i}`,
    }))

    const facets = await extractMissingFacetsForInsights(items, {
      concurrency: 3,
      extractFacets: async (_log, sessionId) => {
        active++
        maxActive = Math.max(maxActive, active)
        await new Promise(resolve => setTimeout(resolve, 1))
        active--
        return makeFacet(sessionId)
      },
      saveFacets: async facet => {
        saved.push(facet.session_id)
      },
    })

    expect(maxActive).toBeLessThanOrEqual(3)
    expect(facets.size).toBe(items.length)
    expect(saved.sort()).toEqual(items.map(item => item.sessionId).sort())
  })

  test('fails instead of returning an empty facet set when every extraction fails', async () => {
    const items = [
      { log: {} as LogOption, sessionId: 'session-1' },
      { log: {} as LogOption, sessionId: 'session-2' },
    ]

    await expect(
      extractMissingFacetsForInsights(items, {
        extractFacets: async () => null,
        saveFacets: async () => {},
      }),
    ).rejects.toThrow('Could not extract any usage insight facets')
  })
})
