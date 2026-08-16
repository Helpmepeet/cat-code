/**
 * The defect this section shipped with was a RENDERING conflation, not a data
 * bug: `stats === null` (nothing has arrived) and a snapshot of all zeros (the
 * user genuinely has no history) were collapsed by `?? 0` / `?? []`, so a page
 * that had simply never been fed printed "No session activity recorded" at a
 * user with 33,482 messages. Reducer and boundary tests cannot catch that — they
 * assert the value, and the value was never the problem. These render the
 * component and assert on what the user would actually read.
 */
import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

import { AccountsUsageSection } from './AccountsUsageSection.js'
import {
  CacheUsageBar,
  DailyModelTokenChart,
  ModelBreakdownBars,
} from './AccountsUsageCharts.js'
import type { UsageStatsSnapshot } from '../../shared/protocol.js'

const EMPTY_CLAIM = 'No session activity recorded'

function stats(over: Partial<UsageStatsSnapshot> = {}): UsageStatsSnapshot {
  return {
    range: '7d',
    totalTokens: 2_138_901,
    dailyModelTokens: [
      { date: '2026-08-12', tokensByModel: { 'gpt-5.6-sol': 84_720 } },
      { date: '2026-08-13', tokensByModel: { 'gpt-5.6-sol': 562_713 } },
    ],
    modelUsage: {
      'gpt-5.6-sol': {
        inputTokens: 400_000,
        outputTokens: 162_713,
        cacheCreationInputTokens: 12_000,
        cacheReadInputTokens: 900_000,
      },
    },
    dailyActivity: [
      { date: '2026-08-13', messageCount: 812, sessionCount: 9, toolCallCount: 240 },
    ],
    cacheHitRate: 68,
    cacheReadTokens: 900_000,
    cacheWriteTokens: 12_000,
    freshInputTokens: 400_000,
    totalSessions: 76,
    totalMessages: 33_482,
    activeDays: 4,
    ...over,
  }
}

function render(snapshot: UsageStatsSnapshot | null): string {
  return renderToStaticMarkup(
    <AccountsUsageSection
      stats={snapshot}
      activeRange="7d"
      onRangeChange={() => {}}
    />,
  )
}

test('a not-loaded snapshot never claims the user has no history', () => {
  // THE REGRESSION. Before the fix this rendered the empty-history claim plus a
  // wall of zeros, which is what the user reported.
  const html = render(null)
  expect(html).not.toContain(EMPTY_CLAIM)
  expect(html).toContain('Loading')
})

test('a genuinely empty snapshot still says so', () => {
  // The claim is not banned, it is earned: a snapshot that actually arrived and
  // measured zero is entitled to make it.
  const html = render(
    stats({
      totalTokens: 0,
      dailyModelTokens: [],
      modelUsage: {},
      dailyActivity: [],
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      freshInputTokens: 0,
      cacheHitRate: 0,
      totalSessions: 0,
      totalMessages: 0,
      activeDays: 0,
    }),
  )
  expect(html).toContain(EMPTY_CLAIM)
  expect(html).not.toContain('Loading')
})

test('a real snapshot renders its own totals, not zeros', () => {
  const html = render(stats())
  expect(html).not.toContain(EMPTY_CLAIM)
  expect(html).not.toContain('Loading')
  expect(html).toContain('76')
  expect(html).toContain('33,482')
  // 2,138,901 tokens over 4 active days, through the shared token formatter.
  expect(html).toContain('2.14M')
  expect(html).toContain('535k')
  expect(html).toContain('68%')
})

test('the section carries no undefined Tailwind colour tokens', () => {
  // The theme half of the same bug: these are shadcn names this app never
  // defines, so Tailwind generated no utility for them and `border` fell back to
  // v4's default `currentColor`, outlining every card in near-white. They are
  // invisible to tsc and to every other test, which is why they survived.
  const html = render(stats()) + render(null)
  for (const token of [
    'bg-card',
    'text-foreground',
    'text-muted-foreground',
    'border-border',
    'bg-muted',
    'bg-background',
  ]) {
    expect(html).not.toContain(token)
  }
})

/* ------------------------------------------------------------------------- *
 * The third state: the read demonstrably failed
 * ------------------------------------------------------------------------- */

test('the failed state names what failed and says it recovers on its own', () => {
  const html = renderToStaticMarkup(
    <DailyModelTokenChart dailyModelTokens={[]} range="7d" dataState="unavailable" />,
  )
  expect(html).toContain('Could not read session history')
  expect(html).toContain('This retries automatically.')
  // Still not the empty-history claim: a failed read measured nothing.
  expect(html).not.toContain(EMPTY_CLAIM)
  expect(html).not.toContain('Loading')
})

test('a failed read never shows a spinner', () => {
  // The point of the third state. `animate-spin` belongs to `pending` only;
  // leaving it on a failed read is the eternal-spinner bug this replaces.
  const failed = renderToStaticMarkup(
    <DailyModelTokenChart dailyModelTokens={[]} range="7d" dataState="unavailable" />,
  )
  const waiting = renderToStaticMarkup(
    <DailyModelTokenChart dailyModelTokens={[]} range="7d" dataState="pending" />,
  )
  expect(failed).not.toContain('animate-spin')
  expect(waiting).toContain('animate-spin')
})

test('the breakdown cards stay terse, the message lives in one place', () => {
  // Four copies of the full sentence would be noise; the chart card carries it.
  for (const html of [
    renderToStaticMarkup(<ModelBreakdownBars modelUsage={{}} dataState="unavailable" />),
    renderToStaticMarkup(
      <CacheUsageBar
        cacheReadTokens={0}
        cacheWriteTokens={0}
        freshInputTokens={0}
        cacheHitRate={0}
        dataState="unavailable"
      />,
    ),
  ]) {
    expect(html).toContain('Unavailable')
    expect(html).not.toContain('Could not read session history')
    expect(html).not.toContain(EMPTY_CLAIM)
  }
})

test('an unavailable breakdown card does not claim no model activity', () => {
  const html = renderToStaticMarkup(
    <ModelBreakdownBars modelUsage={{}} dataState="unavailable" />,
  )
  expect(html).not.toContain('No model activity')
})
