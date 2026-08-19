import { describe, expect, test } from 'bun:test'
import {
  computeChartSeries,
  computeDailyActivitySeries,
  computeModelBreakdown,
  computeTokensPerSessionSeries,
  formatDateLabel,
  formatModelDisplayName,
  formatTokens,
  getModelColor,
  selectAxisLabelIndices,
} from './statsState.js'

describe('statsState', () => {
  test('formatTokens formats numbers into readable magnitudes', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(-50)).toBe('0')
    expect(formatTokens(500)).toBe('500')
    expect(formatTokens(1234)).toBe('1.2k')
    expect(formatTokens(45600)).toBe('45.6k')
    expect(formatTokens(2260000)).toBe('2.26M')
    expect(formatTokens(15400000)).toBe('15.4M')
  })

  test('formatDateLabel formats YYYY-MM-DD into short month + day', () => {
    expect(formatDateLabel('2026-08-14')).toBe('Aug 14')
    expect(formatDateLabel('2026-01-01')).toBe('Jan 1')
    expect(formatDateLabel('invalid')).toBe('invalid')
  })

  test('formatModelDisplayName maps canonical IDs to human titles', () => {
    expect(formatModelDisplayName('claude-3-5-sonnet-20241022')).toBe('Claude 3.5 Sonnet')
    expect(formatModelDisplayName('claude-3-opus-20240229')).toBe('Claude 3 Opus')
    expect(formatModelDisplayName('gpt-4o')).toBe('GPT-4o')
    expect(formatModelDisplayName('custom-model')).toBe('custom-model')
  })

  test('formatModelDisplayName speaks the engine\'s own marketing vocabulary', () => {
    // Mirrors `getMarketingNameForModel` (`src/utils/model/model.ts:785`), which
    // is what the composer rail already prints for the SESSION's model. Two
    // different names for one model in one window is the bug this prevents.
    expect(formatModelDisplayName('claude-sonnet-5-20260115')).toBe('Sonnet 5')
    expect(formatModelDisplayName('claude-opus-5')).toBe('Opus 5')
    expect(formatModelDisplayName('claude-fable-5')).toBe('Fable 5')
    expect(formatModelDisplayName('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
    expect(formatModelDisplayName('gpt-5.6-luna')).toBe('GPT-5.6 Luna')
    expect(formatModelDisplayName('gpt-5.6-sol')).toBe('GPT-5.6 Sol')
  })

  test('formatModelDisplayName tests the specific 4.x ids before the general ones', () => {
    // `claude-opus-4` is a substring of `claude-opus-4-5`, so a reordering here
    // silently relabels every 4.5 run as plain Opus 4.
    expect(formatModelDisplayName('claude-opus-4-5-20251101')).toBe('Opus 4.5')
    expect(formatModelDisplayName('claude-opus-4-1-20250805')).toBe('Opus 4.1')
    expect(formatModelDisplayName('claude-opus-4-20250514')).toBe('Opus 4')
    expect(formatModelDisplayName('claude-sonnet-4-5-20250929')).toBe('Sonnet 4.5')
    expect(formatModelDisplayName('claude-sonnet-4-20250514')).toBe('Sonnet 4')
  })

  test('formatModelDisplayName keeps the 1M-context marker, which changes what the run is', () => {
    expect(formatModelDisplayName('claude-sonnet-5[1m]')).toBe('Sonnet 5 (with 1M context)')
    expect(formatModelDisplayName('claude-opus-5[1M]')).toBe('Opus 5 (with 1M context)')
  })

  test('getModelColor provides distinct colors for known models', () => {
    const sonnetColor = getModelColor('claude-3-5-sonnet')
    const gptColor = getModelColor('gpt-4o')
    expect(sonnetColor).toBe('#d97706')
    expect(gptColor).toBe('#0284c7')
  })

  test('computeChartSeries processes dailyModelTokens into aligned arrays', () => {
    const raw = [
      {
        date: '2026-08-13',
        tokensByModel: {
          'claude-3-5-sonnet': 10000,
          'claude-3-opus': 5000,
        },
      },
      {
        date: '2026-08-14',
        tokensByModel: {
          'claude-3-5-sonnet': 20000,
          'claude-3-opus': 10000,
        },
      },
    ]

    const chart = computeChartSeries(raw)
    expect(chart.dates).toEqual(['2026-08-13', '2026-08-14'])
    expect(chart.displayDates).toEqual(['Aug 13', 'Aug 14'])
    expect(chart.series).toHaveLength(2)
    expect(chart.series[0]?.name).toBe('claude-3-5-sonnet')
    expect(chart.series[0]?.values).toEqual([10000, 20000])
    expect(chart.series[1]?.name).toBe('claude-3-opus')
    expect(chart.series[1]?.values).toEqual([5000, 10000])
    expect(chart.maxDailyTotal).toBe(30000)
    expect(chart.totalWindowTokens).toBe(45000)
  })

  test('computeModelBreakdown computes sorted percentages', () => {
    const modelUsage = {
      'claude-3-5-sonnet': {
        inputTokens: 30000,
        outputTokens: 10000,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      },
      'gpt-4o': {
        inputTokens: 10000,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      },
    }

    const breakdown = computeModelBreakdown(modelUsage)
    expect(breakdown).toHaveLength(2)
    expect(breakdown[0]?.modelName).toBe('claude-3-5-sonnet')
    expect(breakdown[0]?.totalTokens).toBe(40000)
    expect(breakdown[0]?.percentage).toBe(80)
    expect(breakdown[1]?.modelName).toBe('gpt-4o')
    expect(breakdown[1]?.totalTokens).toBe(10000)
    expect(breakdown[1]?.percentage).toBe(20)
  })

  test('computeModelBreakdown keeps the input/output split the bars now draw', () => {
    const breakdown = computeModelBreakdown({
      'claude-3-5-sonnet': {
        inputTokens: 30000,
        outputTokens: 10000,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      },
    })
    expect(breakdown[0]?.inputTokens).toBe(30000)
    expect(breakdown[0]?.outputTokens).toBe(10000)
  })

  /* --------------------------------------------------------------------- *
   * X-axis label placement
   * --------------------------------------------------------------------- */

  test('selectAxisLabelIndices never lets two labels overlap, at any point count', () => {
    // THE REGRESSION, operator-reported: the old rule sampled with `i % step`
    // and then force-drew the last index, which lands wherever the data ends.
    // At 20/22/26 points on the wide chart and 11/14/17/18/21 on the narrow one
    // the final label rendered on top of its neighbour, reading "Aug 1Aug 16".
    // Swept rather than spot-checked, because the failure is arithmetic and only
    // appears at counts nobody thinks to pick by hand.
    for (const [plotWidth, minGap] of [
      [578, 42], // DailyModelTokenChart
      [272, 38], // TokensPerSessionChart
    ] as const) {
      for (let pointCount = 2; pointCount <= 60; pointCount++) {
        const indices = selectAxisLabelIndices(pointCount, plotWidth, minGap)
        const positions = indices.map(i => (i / (pointCount - 1)) * plotWidth)
        for (let k = 1; k < positions.length; k++) {
          const gap = (positions[k] ?? 0) - (positions[k - 1] ?? 0)
          expect(gap).toBeGreaterThanOrEqual(minGap)
        }
      }
    }
  })

  test('selectAxisLabelIndices always names both ends of the window', () => {
    // The reason the old code force-drew the last index. Dropping it to fix the
    // overlap would trade one bug for another: an axis that stops short reads as
    // a window that stops short.
    for (let pointCount = 2; pointCount <= 60; pointCount++) {
      const indices = selectAxisLabelIndices(pointCount, 272, 38)
      expect(indices[0]).toBe(0)
      expect(indices[indices.length - 1]).toBe(pointCount - 1)
      // Strictly ascending, no repeats: a duplicated index double-paints.
      for (let k = 1; k < indices.length; k++) {
        expect(indices[k]!).toBeGreaterThan(indices[k - 1]!)
      }
    }
  })

  test('selectAxisLabelIndices handles the degenerate counts', () => {
    expect(selectAxisLabelIndices(0, 272, 38)).toEqual([])
    expect(selectAxisLabelIndices(1, 272, 38)).toEqual([0])
    // Two points closer together than one label: both ends still get named,
    // because naming neither is worse than a tight pair at the extremes.
    expect(selectAxisLabelIndices(2, 10, 38)).toEqual([0, 1])
  })

  /* --------------------------------------------------------------------- *
   * Work per day
   * --------------------------------------------------------------------- */

  test('computeDailyActivitySeries keeps each measure on its own scale', () => {
    const series = computeDailyActivitySeries([
      { date: '2026-08-13', messageCount: 812, sessionCount: 9, toolCallCount: 240 },
      { date: '2026-08-14', messageCount: 400, sessionCount: 12, toolCallCount: 90 },
    ])

    expect(series.dates).toEqual(['2026-08-13', '2026-08-14'])
    expect(series.displayDates).toEqual(['Aug 13', 'Aug 14'])
    expect(series.sessions).toEqual([9, 12])
    expect(series.messages).toEqual([812, 400])
    expect(series.toolCalls).toEqual([240, 90])
    // Separate maxima are the whole point: one shared scale would flatten
    // sessions (peak 12) against messages (peak 812) into the baseline.
    expect(series.maxSessions).toBe(12)
    expect(series.maxMessages).toBe(812)
    expect(series.maxToolCalls).toBe(240)
    expect(series.totalSessions).toBe(21)
    expect(series.totalMessages).toBe(1212)
    expect(series.totalToolCalls).toBe(330)
  })

  test('computeDailyActivitySeries handles an empty window without NaN maxima', () => {
    const series = computeDailyActivitySeries([])
    expect(series.dates).toEqual([])
    expect(series.maxSessions).toBe(0)
    expect(series.maxMessages).toBe(0)
    expect(series.totalSessions).toBe(0)
  })

  /* --------------------------------------------------------------------- *
   * Tokens per session
   * --------------------------------------------------------------------- */

  test('computeTokensPerSessionSeries divides each day by its own sessions', () => {
    const series = computeTokensPerSessionSeries(
      [
        { date: '2026-08-13', tokensByModel: { 'gpt-5.6-sol': 90_000 } },
        { date: '2026-08-14', tokensByModel: { 'gpt-5.6-sol': 40_000, 'o3-mini': 20_000 } },
      ],
      [
        { date: '2026-08-13', messageCount: 300, sessionCount: 9, toolCallCount: 40 },
        { date: '2026-08-14', messageCount: 100, sessionCount: 4, toolCallCount: 10 },
      ],
    )

    expect(series.values).toEqual([10_000, 15_000])
    expect(series.maxValue).toBe(15_000)
    // Window aggregate: 150,000 tokens over 13 sessions and 400 messages.
    expect(series.averagePerSession).toBe(11_538)
    expect(series.averagePerMessage).toBe(375)
    expect(series.subagentOnlyDays).toBe(0)
  })

  test('computeTokensPerSessionSeries joins by date, never by position', () => {
    // THE TRAP. The two series come from different upstream predicates, so their
    // date sets differ: a subagent-only day carries tokens and no session start
    // (`src/utils/stats.ts:290` vs `:373`). Zipping by index would pair Aug 14's
    // tokens with Aug 12's session count and plot a number that is nobody's.
    const series = computeTokensPerSessionSeries(
      [
        { date: '2026-08-12', tokensByModel: { 'gpt-5.6-sol': 84_720 } },
        { date: '2026-08-14', tokensByModel: { 'gpt-5.6-sol': 60_000 } },
      ],
      [{ date: '2026-08-14', messageCount: 200, sessionCount: 4, toolCallCount: 30 }],
    )

    expect(series.dates).toEqual(['2026-08-14'])
    expect(series.values).toEqual([15_000])
    // Not dropped, not drawn as a spike: counted and reported.
    expect(series.subagentOnlyDays).toBe(1)
    // The unplotted day's tokens still count toward what a session really costs.
    expect(series.averagePerSession).toBe(Math.round(144_720 / 4))
  })

  test('computeTokensPerSessionSeries never divides by a zero session count', () => {
    const series = computeTokensPerSessionSeries(
      [{ date: '2026-08-14', tokensByModel: { 'gpt-5.6-sol': 60_000 } }],
      [{ date: '2026-08-14', messageCount: 0, sessionCount: 0, toolCallCount: 0 }],
    )
    expect(series.values).toEqual([])
    expect(series.values.every(Number.isFinite)).toBe(true)
    expect(series.averagePerSession).toBe(0)
    expect(series.subagentOnlyDays).toBe(1)
  })

  test('computeTokensPerSessionSeries plots a session day that spent nothing', () => {
    // Sessions with no token entry are a measured zero, not a missing day.
    const series = computeTokensPerSessionSeries(
      [],
      [{ date: '2026-08-14', messageCount: 3, sessionCount: 2, toolCallCount: 0 }],
    )
    expect(series.values).toEqual([0])
    expect(series.averagePerSession).toBe(0)
  })
})
