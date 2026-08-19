/**
 * Renderer state helpers and formatters for real engine-backed token usage analytics.
 * Pure logic and hooks only — zero React components in this module (Fast Refresh safe).
 */

import { useEffect, useState } from 'react'

import type {
  UsageStatsDailyActivityItem,
  UsageStatsDailyModelTokens,
  UsageStatsModelUsageItem,
  UsageStatsRange,
  UsageStatsSnapshot,
} from '../../shared/protocol.js'

export type { UsageStatsRange, UsageStatsSnapshot }

/**
 * What the analytics section is entitled to say right now.
 *
 *  - `loaded`      a snapshot arrived; render it, including a genuinely empty one.
 *  - `pending`     nothing yet, and not long enough to conclude anything.
 *  - `unavailable` long enough that a run had its full budget and did not deliver.
 *
 * The middle and last states are both "no data" and must not be drawn the same:
 * an empty-history claim needs a snapshot, and an eternal spinner is its own
 * wrong answer once the feed has demonstrably failed.
 */
export type UsageStatsDisplayState = 'loaded' | 'pending' | 'unavailable'

/**
 * How long to wait for a first snapshot before reporting failure.
 *
 * Deliberately equal to the worker's own budget
 * (`ACCOUNTS_POOL_WORKER_TIMEOUT_MS`, `app/main/accountsPoolRunner.ts`): below
 * that, a run can still be legitimately in flight (the first one pays a ~189 MB
 * engine import), so a shorter wait would report failure at a working system and
 * then take it back. At this value, "unavailable" means a run had its whole
 * budget and produced nothing.
 */
export const USAGE_STATS_PENDING_TIMEOUT_MS = 2 * 60 * 1000

/**
 * Resolve the display state, flipping `pending` to `unavailable` once the wait
 * exceeds `timeoutMs`.
 *
 * The clock starts when this mounts without data, NOT when the app launched, so
 * re-opening the page while the feed is broken spends the wait again before
 * saying so. Accepted: the alternative is a launch timestamp in reducer state,
 * and being briefly over-optimistic about a failure is the harmless direction.
 *
 * Renders `pending` under SSR, where effects never run — which is the correct
 * first paint in the browser too.
 */
export function useUsageStatsDisplayState(
  hasStats: boolean,
  timeoutMs: number = USAGE_STATS_PENDING_TIMEOUT_MS,
): UsageStatsDisplayState {
  const [timedOut, setTimedOut] = useState(false)

  useEffect(() => {
    // Data present: no clock, and any previous verdict is retracted — a feed
    // that recovers must not leave the page reporting a failure it healed from.
    if (hasStats) {
      setTimedOut(false)
      return
    }
    setTimedOut(false)
    const handle = setTimeout(() => setTimedOut(true), timeoutMs)
    return () => clearTimeout(handle)
  }, [hasStats, timeoutMs])

  if (hasStats) return 'loaded'
  return timedOut ? 'unavailable' : 'pending'
}

/**
 * Human-friendly token formatting (e.g. "2.26M", "850.4k", "1,200", "0").
 */
export function formatTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return '0'
  if (tokens >= 1_000_000) {
    const val = tokens / 1_000_000
    return `${val >= 10 ? val.toFixed(1) : val.toFixed(2)}M`
  }
  if (tokens >= 1_000) {
    const val = tokens / 1_000
    return `${val >= 100 ? Math.round(val) : val.toFixed(1)}k`
  }
  return tokens.toLocaleString()
}

/**
 * Format a YYYY-MM-DD string into a compact readable label (e.g. "Aug 14").
 */
export function formatDateLabel(dateStr: string): string {
  if (!dateStr || typeof dateStr !== 'string') return ''
  const parts = dateStr.split('-')
  if (parts.length < 3) return dateStr
  const monthNames = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ]
  const monthIdx = parseInt(parts[1] ?? '', 10) - 1
  const day = parseInt(parts[2] ?? '', 10)
  if (monthIdx >= 0 && monthIdx < 12 && Number.isFinite(day)) {
    return `${monthNames[monthIdx]} ${day}`
  }
  return dateStr
}

/**
 * Curated palette for AI models that is theme-safe (works on both dark & light backgrounds).
 */
const MODEL_COLORS: Record<string, string> = {
  'claude-3-5-sonnet': '#d97706', // amber-600
  'claude-3-5-sonnet-20241022': '#d97706',
  'claude-3-5-sonnet-20240620': '#d97706',
  'claude-3-7-sonnet': '#ea580c', // orange-600
  'claude-3-opus': '#7c3aed', // violet-600
  'claude-3-opus-20240229': '#7c3aed',
  'claude-3-5-haiku': '#059669', // emerald-600
  'claude-3-5-haiku-20241022': '#059669',
  'claude-3-haiku-20240307': '#10b981',
  'gpt-4o': '#0284c7', // light-blue-600
  'gpt-4o-mini': '#06b6d4', // cyan-500
  'o1': '#4f46e5', // indigo-600
  'o1-preview': '#4f46e5',
  'o3-mini': '#2563eb', // blue-600
}

const FALLBACK_PALETTE = [
  '#f59e0b', // amber-500
  '#3b82f6', // blue-500
  '#10b981', // emerald-500
  '#8b5cf6', // purple-500
  '#ec4899', // pink-500
  '#06b6d4', // cyan-500
  '#64748b', // slate-500
]

export function getModelColor(modelName: string, index = 0): string {
  const normalized = modelName.toLowerCase()
  for (const [key, color] of Object.entries(MODEL_COLORS)) {
    if (normalized.includes(key)) return color
  }
  return FALLBACK_PALETTE[index % FALLBACK_PALETTE.length] ?? '#64748b'
}

/**
 * Formats model names into short display labels.
 *
 * The renderer-side mirror of the engine's `getMarketingNameForModel`
 * (`src/utils/model/model.ts:785`), whose exact wording the seam already speaks
 * on the composer rail (`RunControlsSnapshot.model.label`). It is mirrored
 * rather than called because the engine module is not in the renderer's graph,
 * and mirrored HERE rather than forked into a second formatter so the app has
 * one answer to "what is this model called". Ordering is the engine's:
 * `claude-opus-4-5` has to be tested before `claude-opus-4`.
 *
 * The pre-4 entries below predate this and stay as they are; the engine spells
 * those the same way.
 */
export function formatModelDisplayName(modelName: string): string {
  if (!modelName) return 'Unknown Model'
  // `[1m]` rides the model id itself and changes what the run IS, so it travels
  // with the name rather than being trimmed for width (engine, `model.ts:791`).
  const long = modelName.toLowerCase().includes('[1m]')
  const wide = (label: string): string =>
    long ? `${label} (with 1M context)` : label
  if (modelName.includes('claude-fable-5')) return wide('Fable 5')
  if (modelName.includes('claude-opus-5')) return wide('Opus 5')
  if (modelName.includes('claude-sonnet-5')) return wide('Sonnet 5')
  if (modelName.includes('claude-opus-4-6')) return wide('Opus 4.6')
  if (modelName.includes('claude-opus-4-5')) return 'Opus 4.5'
  if (modelName.includes('claude-opus-4-1')) return 'Opus 4.1'
  if (modelName.includes('claude-opus-4')) return 'Opus 4'
  if (modelName.includes('claude-sonnet-4-6')) return wide('Sonnet 4.6')
  if (modelName.includes('claude-sonnet-4-5')) return wide('Sonnet 4.5')
  if (modelName.includes('claude-sonnet-4')) return wide('Sonnet 4')
  if (modelName.includes('claude-haiku-4-5')) return 'Haiku 4.5'
  if (modelName.includes('gpt-5.6-sol')) return 'GPT-5.6 Sol'
  if (modelName.includes('gpt-5.6-terra')) return 'GPT-5.6 Terra'
  if (modelName.includes('gpt-5.6-luna')) return 'GPT-5.6 Luna'
  if (modelName.includes('claude-3-7-sonnet')) return 'Claude 3.7 Sonnet'
  if (modelName.includes('claude-3-5-sonnet')) return 'Claude 3.5 Sonnet'
  if (modelName.includes('claude-3-5-haiku')) return 'Claude 3.5 Haiku'
  if (modelName.includes('claude-3-opus')) return 'Claude 3 Opus'
  if (modelName.includes('claude-3-haiku')) return 'Claude 3 Haiku'
  if (modelName.includes('gpt-4o-mini')) return 'GPT-4o mini'
  if (modelName.includes('gpt-4o')) return 'GPT-4o'
  if (modelName.includes('o3-mini')) return 'o3-mini'
  if (modelName.includes('o1')) return 'o1'
  return modelName
}

export type ModelSeriesData = {
  name: string
  displayName: string
  color: string
  totalTokens: number
  values: number[]
}

export type ChartMultiSeries = {
  dates: string[]
  displayDates: string[]
  series: ModelSeriesData[]
  maxDailyTotal: number
  totalWindowTokens: number
}

/**
 * Transforms real `dailyModelTokens` into multi-line SVG plot coordinates.
 */
export function computeChartSeries(
  dailyModelTokens: UsageStatsDailyModelTokens[],
): ChartMultiSeries {
  if (!dailyModelTokens || dailyModelTokens.length === 0) {
    return {
      dates: [],
      displayDates: [],
      series: [],
      maxDailyTotal: 0,
      totalWindowTokens: 0,
    }
  }

  // Collect all unique model names in the window
  const modelTotals: Record<string, number> = {}
  for (const entry of dailyModelTokens) {
    for (const [model, count] of Object.entries(entry.tokensByModel)) {
      modelTotals[model] = (modelTotals[model] ?? 0) + (count ?? 0)
    }
  }

  // Sort models descending by total tokens
  const sortedModels = Object.keys(modelTotals).sort(
    (a, b) => (modelTotals[b] ?? 0) - (modelTotals[a] ?? 0),
  )

  const dates: string[] = []
  const displayDates: string[] = []
  let maxDailyTotal = 0
  let totalWindowTokens = 0

  for (const entry of dailyModelTokens) {
    dates.push(entry.date)
    displayDates.push(formatDateLabel(entry.date))
    let dayTotal = 0
    for (const count of Object.values(entry.tokensByModel)) {
      dayTotal += count ?? 0
    }
    if (dayTotal > maxDailyTotal) maxDailyTotal = dayTotal
    totalWindowTokens += dayTotal
  }

  const series: ModelSeriesData[] = sortedModels.map((modelName, idx) => {
    const values = dailyModelTokens.map(
      entry => entry.tokensByModel[modelName] ?? 0,
    )
    return {
      name: modelName,
      displayName: formatModelDisplayName(modelName),
      color: getModelColor(modelName, idx),
      totalTokens: modelTotals[modelName] ?? 0,
      values,
    }
  })

  return {
    dates,
    displayDates,
    series,
    maxDailyTotal,
    totalWindowTokens,
  }
}

/**
 * Pick x-axis label positions that cannot overlap.
 *
 * Every chart here samples labels with `i % step`, then force-draws the LAST
 * one so the window's end is named. Those two rules fight: the final label lands
 * wherever the data ends, which can be one index after a sampled label, and at
 * that width the two render on top of each other. Measured before this existed:
 * the 640-wide chart collided at 20, 22 and 26 points, the 320-wide one at 11,
 * 14, 17, 18 and 21. The operator saw it as a smear reading "Aug 1Aug 16".
 *
 * Walks left to right keeping the first index, taking a candidate only when it
 * clears both its predecessor AND leaves room for the last label, then appends
 * the last. So both ends are always named and nothing collides, at any count.
 *
 * `minGap` and `plotWidth` are in the caller's viewBox units; the caller owns
 * the font metric, since the two charts do not share a font size.
 */
export function selectAxisLabelIndices(
  pointCount: number,
  plotWidth: number,
  minGap: number,
): number[] {
  if (pointCount <= 0) return []
  if (pointCount === 1) return [0]

  const positionOf = (index: number) => (index / (pointCount - 1)) * plotWidth
  const lastPosition = plotWidth
  const kept: number[] = [0]

  for (let i = 1; i < pointCount - 1; i++) {
    const position = positionOf(i)
    const previous = positionOf(kept[kept.length - 1] ?? 0)
    if (position - previous < minGap) continue
    if (lastPosition - position < minGap) continue
    kept.push(i)
  }

  // The last label is never dropped: it names where the window ends. The loop
  // above already refused anything that would crowd it.
  if (lastPosition - positionOf(kept[kept.length - 1] ?? 0) < minGap) {
    if (kept.length > 1) kept.pop()
  }
  kept.push(pointCount - 1)
  return kept
}

export type DailyActivitySeries = {
  dates: string[]
  displayDates: string[]
  sessions: number[]
  messages: number[]
  toolCalls: number[]
  maxSessions: number
  maxMessages: number
  maxToolCalls: number
  totalSessions: number
  totalMessages: number
  totalToolCalls: number
}

/**
 * Transforms `dailyActivity` into three aligned per-day series.
 *
 * They are deliberately kept apart with their own maxima rather than merged onto
 * one axis: message counts run one to two orders of magnitude above session
 * counts, so a shared scale flattens sessions into the baseline, and a second
 * y-axis to rescue them is the one chart form that is never correct. The three
 * are drawn as small multiples instead.
 *
 * Order is the engine's own (ascending by date, `src/utils/stats.ts:389`); this
 * does not re-sort, matching `computeChartSeries`.
 */
export function computeDailyActivitySeries(
  dailyActivity: UsageStatsDailyActivityItem[],
): DailyActivitySeries {
  const dates: string[] = []
  const displayDates: string[] = []
  const sessions: number[] = []
  const messages: number[] = []
  const toolCalls: number[] = []

  for (const entry of dailyActivity ?? []) {
    dates.push(entry.date)
    displayDates.push(formatDateLabel(entry.date))
    sessions.push(entry.sessionCount ?? 0)
    messages.push(entry.messageCount ?? 0)
    toolCalls.push(entry.toolCallCount ?? 0)
  }

  const sum = (values: number[]) => values.reduce((acc, val) => acc + val, 0)

  return {
    dates,
    displayDates,
    sessions,
    messages,
    toolCalls,
    maxSessions: Math.max(0, ...sessions),
    maxMessages: Math.max(0, ...messages),
    maxToolCalls: Math.max(0, ...toolCalls),
    totalSessions: sum(sessions),
    totalMessages: sum(messages),
    totalToolCalls: sum(toolCalls),
  }
}

export type TokensPerSessionSeries = {
  dates: string[]
  displayDates: string[]
  /** Tokens divided by sessions, for each day that recorded a session. */
  values: number[]
  maxValue: number
  /** Window-wide tokens per session. See the weighting note below. */
  averagePerSession: number
  /** Window-wide tokens per message. */
  averagePerMessage: number
  /** Days carrying tokens that no session start was recorded against. */
  subagentOnlyDays: number
}

/**
 * Joins the two daily series into a per-day efficiency ratio.
 *
 * Joined BY DATE, never zipped by index: the two arrays are built from different
 * predicates upstream and their date sets genuinely differ. `dailyModelTokens`
 * gains a date whenever any file logged tokens, subagent files included
 * (`src/utils/stats.ts:373`), while `dailyActivity` gains one only for a real
 * session file (`:269`, `:290`). So a day whose only traffic was subagent runs
 * carries tokens and no sessions, and dividing those positionally would pair a
 * day's tokens with another day's session count.
 *
 * Such days are counted in `subagentOnlyDays` and left unplotted rather than
 * drawn as a spike: their tokens are real but the denominator is not zero, it is
 * unknown, and an infinite ratio is not a data point.
 *
 * `averagePerSession` is a window aggregate (all tokens over all sessions),
 * which is NOT the mean of `values` — it includes the unplotted days' tokens and
 * weights each day by its session count. That is the honest figure for "what a
 * session costs here", and it is why the reference line can sit off the visual
 * centre of the dots.
 */
export function computeTokensPerSessionSeries(
  dailyModelTokens: UsageStatsDailyModelTokens[],
  dailyActivity: UsageStatsDailyActivityItem[],
): TokensPerSessionSeries {
  const tokensByDate = new Map<string, number>()
  let totalTokens = 0
  for (const entry of dailyModelTokens ?? []) {
    let dayTotal = 0
    for (const count of Object.values(entry.tokensByModel ?? {})) {
      dayTotal += count ?? 0
    }
    tokensByDate.set(entry.date, (tokensByDate.get(entry.date) ?? 0) + dayTotal)
    totalTokens += dayTotal
  }

  const dates: string[] = []
  const displayDates: string[] = []
  const values: number[] = []
  const datesWithSessions = new Set<string>()
  let maxValue = 0
  let totalSessions = 0
  let totalMessages = 0

  for (const entry of dailyActivity ?? []) {
    const sessionCount = entry.sessionCount ?? 0
    totalSessions += sessionCount
    totalMessages += entry.messageCount ?? 0
    if (sessionCount <= 0) continue
    datesWithSessions.add(entry.date)

    const perSession = Math.round((tokensByDate.get(entry.date) ?? 0) / sessionCount)
    dates.push(entry.date)
    displayDates.push(formatDateLabel(entry.date))
    values.push(perSession)
    if (perSession > maxValue) maxValue = perSession
  }

  let subagentOnlyDays = 0
  for (const [date, tokens] of tokensByDate) {
    if (tokens > 0 && !datesWithSessions.has(date)) subagentOnlyDays++
  }

  return {
    dates,
    displayDates,
    values,
    maxValue,
    averagePerSession:
      totalSessions > 0 ? Math.round(totalTokens / totalSessions) : 0,
    averagePerMessage:
      totalMessages > 0 ? Math.round(totalTokens / totalMessages) : 0,
    subagentOnlyDays,
  }
}

export type ModelBreakdownItem = {
  modelName: string
  displayName: string
  color: string
  inputTokens: number
  outputTokens: number
  totalTokens: number
  percentage: number
}

/**
 * Computes sorted per-model token breakdown items with percentages.
 */
export function computeModelBreakdown(
  modelUsage: Record<string, UsageStatsModelUsageItem>,
): ModelBreakdownItem[] {
  const items: ModelBreakdownItem[] = []
  let grandTotal = 0

  for (const [name, usage] of Object.entries(modelUsage)) {
    const total = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
    grandTotal += total
  }

  let idx = 0
  for (const [name, usage] of Object.entries(modelUsage)) {
    const total = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
    const percentage = grandTotal > 0 ? Math.round((total / grandTotal) * 100) : 0
    items.push({
      modelName: name,
      displayName: formatModelDisplayName(name),
      color: getModelColor(name, idx++),
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      totalTokens: total,
      percentage,
    })
  }

  return items.sort((a, b) => b.totalTokens - a.totalTokens)
}
