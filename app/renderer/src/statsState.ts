/**
 * Renderer state helpers and formatters for real engine-backed token usage analytics.
 * Pure logic and hooks only — zero React components in this module (Fast Refresh safe).
 */

import { useEffect, useState } from 'react'

import type {
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
 */
export function formatModelDisplayName(modelName: string): string {
  if (!modelName) return 'Unknown Model'
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
