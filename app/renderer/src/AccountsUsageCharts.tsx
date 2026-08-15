/**
 * Real usage analytics charts (Anti-Potemkin compliant).
 * Renders actual historical token usage from `UsageStatsSnapshot`.
 * Exports ONLY React components (Fast Refresh rule).
 *
 * Every chart takes `pending`, which is NOT-LOADED and must never be drawn as an
 * empty result: an empty-state message is a claim about the user's history, and
 * only a snapshot that actually arrived entitles us to make it. See the section
 * module for the theme-token rule these files broke.
 */

import { useState, type ReactNode } from 'react'
import {
  computeChartSeries,
  computeModelBreakdown,
  formatTokens,
  type ChartMultiSeries,
  type ModelBreakdownItem,
} from './statsState.js'
import type {
  UsageStatsDailyModelTokens,
  UsageStatsModelUsageItem,
} from '../../shared/protocol.js'

export type DailyModelTokenChartProps = {
  dailyModelTokens: UsageStatsDailyModelTokens[]
  range: '7d' | '30d'
  /** No snapshot has arrived yet — say so, never claim an empty history. */
  pending?: boolean
}

/** Shared frame for the pending and empty states, so neither shifts the layout. */
function ChartPlaceholder({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-56 flex-col items-center justify-center rounded-xl border border-dashed border-shell-seam bg-shell-hover/35 p-6 text-center text-[12px] text-text-subtle">
      {children}
    </div>
  )
}

/**
 * Multi-series SVG area/line chart plotting real daily token volumes by model.
 */
export function DailyModelTokenChart({
  dailyModelTokens,
  range,
  pending = false,
}: DailyModelTokenChartProps) {
  const chartData: ChartMultiSeries = computeChartSeries(dailyModelTokens)
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null)

  if (pending) {
    return (
      <ChartPlaceholder>
        <span className="mb-2.5 h-4 w-4 animate-spin rounded-full border-2 border-shell-seam border-t-text-muted" />
        <span className="font-medium text-text-muted">Loading usage analytics</span>
      </ChartPlaceholder>
    )
  }

  if (chartData.dates.length === 0 || chartData.totalWindowTokens === 0) {
    return (
      <ChartPlaceholder>
        <svg
          className="mb-2.5 h-7 w-7 text-text-ghost"
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth="1.5"
          stroke="currentColor"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 0 1 3 19.875v-6.75ZM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V8.625ZM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V4.125Z"
          />
        </svg>
        <span className="font-medium text-text-muted">
          No session activity recorded
        </span>
        <span className="mt-0.5 text-text-subtle">
          No tokens were consumed in the selected{' '}
          {range === '30d' ? '30-day' : '7-day'} period.
        </span>
      </ChartPlaceholder>
    )
  }

  const width = 640
  const height = 200
  const padLeft = 46
  const padRight = 16
  const padTop = 18
  const padBottom = 26
  const plotWidth = width - padLeft - padRight
  const plotHeight = height - padTop - padBottom

  const pointCount = chartData.dates.length
  const maxVal = chartData.maxDailyTotal > 0 ? chartData.maxDailyTotal * 1.15 : 1000

  // Calculate coordinates for each date index
  const getX = (i: number) => {
    if (pointCount <= 1) return padLeft + plotWidth / 2
    return padLeft + (i / (pointCount - 1)) * plotWidth
  }

  const getY = (val: number) => {
    return padTop + plotHeight - (Math.max(0, val) / maxVal) * plotHeight
  }

  // Y-axis gridlines (0%, 50%, 100%)
  const yTicks = [0, maxVal * 0.5, maxVal]

  // Hovered day summary
  const hoveredDate = hoveredIndex !== null ? chartData.dates[hoveredIndex] : null
  const hoveredDisplayDate =
    hoveredIndex !== null ? chartData.displayDates[hoveredIndex] : null

  return (
    <div className="flex flex-col gap-3">
      {/* Chart Canvas */}
      <div className="relative w-full overflow-hidden rounded-lg bg-white/[0.02] p-2">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="w-full select-none"
          style={{ height: 'auto', maxHeight: '230px' }}
          role="img"
          aria-label="Daily Token Usage Chart"
        >
          {/* Y Axis Gridlines & Labels */}
          {yTicks.map((val, idx) => {
            const y = getY(val)
            return (
              <g key={`ytick-${idx}`}>
                <line
                  x1={padLeft}
                  y1={y}
                  x2={width - padRight}
                  y2={y}
                  stroke="currentColor"
                  className="text-text-ghost/40"
                  strokeDasharray="3 3"
                  strokeWidth="1"
                />
                <text
                  x={padLeft - 8}
                  y={y + 3.5}
                  textAnchor="end"
                  fontSize="10"
                  className="fill-text-subtle font-mono"
                >
                  {formatTokens(Math.round(val))}
                </text>
              </g>
            )
          })}

          {/* Model Curves */}
          {chartData.series.map((s, seriesIdx) => {
            const points = s.values.map((v, i) => `${getX(i)},${getY(v)}`).join(' ')
            const areaPoints = [
              `${getX(0)},${padTop + plotHeight}`,
              ...s.values.map((v, i) => `${getX(i)},${getY(v)}`),
              `${getX(pointCount - 1)},${padTop + plotHeight}`,
            ].join(' ')

            return (
              <g key={`series-${seriesIdx}`}>
                <polygon
                  points={areaPoints}
                  fill={s.color}
                  fillOpacity="0.08"
                />
                <polyline
                  points={points}
                  fill="none"
                  stroke={s.color}
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                {s.values.map((v, i) => (
                  <circle
                    key={`dot-${seriesIdx}-${i}`}
                    cx={getX(i)}
                    cy={getY(v)}
                    r={hoveredIndex === i ? '4.5' : '2.5'}
                    fill={s.color}
                    // The card this sits on, so a dot reads as punched out of it.
                    // Was `var(--card, …)`: undefined here, so every dot took the
                    // slate-blue fallback instead of the panel colour.
                    stroke="var(--color-surface-panel)"
                    strokeWidth="1.5"
                    className="transition-all"
                  />
                ))}
              </g>
            )
          })}

          {/* Hover Column Indicator */}
          {hoveredIndex !== null && (
            <line
              x1={getX(hoveredIndex)}
              y1={padTop}
              x2={getX(hoveredIndex)}
              y2={padTop + plotHeight}
              stroke="currentColor"
              className="text-text-muted"
              strokeWidth="1"
              strokeDasharray="2 2"
            />
          )}

          {/* Interactive column hover targets */}
          {chartData.dates.map((_, i) => {
            const colWidth = plotWidth / Math.max(1, pointCount)
            const x = getX(i) - colWidth / 2
            return (
              <rect
                key={`hover-target-${i}`}
                x={Math.max(0, x)}
                y={padTop}
                width={Math.max(16, colWidth)}
                height={plotHeight}
                fill="transparent"
                className="cursor-pointer"
                onMouseEnter={() => setHoveredIndex(i)}
                onMouseLeave={() => setHoveredIndex(null)}
              />
            )
          })}

          {/* X Axis Date Labels */}
          {chartData.displayDates.map((dateLabel, i) => {
            // Show all labels if <= 8 points, else sample
            const step = pointCount > 14 ? Math.ceil(pointCount / 7) : 1
            if (i !== 0 && i !== pointCount - 1 && i % step !== 0) return null
            return (
              <text
                key={`xlabel-${i}`}
                x={getX(i)}
                y={height - 6}
                textAnchor="middle"
                fontSize="10"
                className="fill-text-subtle font-mono"
              >
                {dateLabel}
              </text>
            )
          })}
        </svg>
      </div>

      {/* Tooltip / Selected Day Inspector */}
      {hoveredIndex !== null && hoveredDate && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-shell-seam bg-surface-raised px-3.5 py-2 text-xs backdrop-blur-sm">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-text-primary font-mono">
              {hoveredDisplayDate}
            </span>
            <span className="text-text-subtle font-mono text-[11px]">
              ({hoveredDate})
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {chartData.series.map((s, idx) => {
              const count = s.values[hoveredIndex] ?? 0
              if (count === 0 && chartData.series.length > 2) return null
              return (
                <div key={`hov-metric-${idx}`} className="flex items-center gap-1.5">
                  <span
                    className="h-2 w-2 rounded-full"
                    style={{ backgroundColor: s.color }}
                  />
                  <span className="text-text-subtle">{s.displayName}:</span>
                  <span className="font-mono font-medium text-text-primary">
                    {formatTokens(count)}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Models Legend */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pt-1">
        {chartData.series.map((s, idx) => (
          <div key={`legend-${idx}`} className="flex items-center gap-1.5 text-xs">
            <span
              className="h-2.5 w-2.5 rounded-full"
              style={{ backgroundColor: s.color }}
            />
            <span className="text-text-primary font-medium">{s.displayName}</span>
            <span className="text-text-subtle font-mono text-[11px]">
              ({formatTokens(s.totalTokens)})
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

export type ModelBreakdownBarsProps = {
  modelUsage: Record<string, UsageStatsModelUsageItem>
  /** No snapshot has arrived yet — say so, never claim an empty history. */
  pending?: boolean
}

/**
 * Horizontal progress bars visualizing token share per model.
 */
export function ModelBreakdownBars({
  modelUsage,
  pending = false,
}: ModelBreakdownBarsProps) {
  const items: ModelBreakdownItem[] = computeModelBreakdown(modelUsage)

  if (pending) {
    return (
      <div className="p-4 text-center text-[12px] text-text-ghost">Loading</div>
    )
  }

  if (items.length === 0) {
    return (
      <div className="p-4 text-center text-[12px] text-text-subtle">
        No model activity in this period.
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {items.map((item, idx) => (
        <div key={`model-bar-${idx}`} className="flex flex-col gap-1 text-xs">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span
                className="h-2.5 w-2.5 rounded-full"
                style={{ backgroundColor: item.color }}
              />
              <span className="font-medium text-text-primary">
                {item.displayName}
              </span>
            </div>
            <div className="flex items-center gap-2 font-mono">
              <span className="text-text-primary font-medium">
                {formatTokens(item.totalTokens)}
              </span>
              <span className="text-text-subtle text-[11px]">
                ({item.percentage}%)
              </span>
            </div>
          </div>
          {/* Track and fill bar */}
          <div className="h-2 w-full overflow-hidden rounded-full bg-white/[0.07]">
            <div
              className="h-full rounded-full transition-all duration-300"
              style={{
                width: `${Math.max(item.percentage, 2)}%`,
                backgroundColor: item.color,
              }}
            />
          </div>
        </div>
      ))}
    </div>
  )
}

export type CacheUsageBarProps = {
  cacheReadTokens: number
  cacheWriteTokens: number
  freshInputTokens: number
  cacheHitRate: number
  /** No snapshot has arrived yet — say so, never claim an empty history. */
  pending?: boolean
}

/**
 * 3-segment stacked bar showing Prompt Cache read vs fresh input vs cache write.
 */
export function CacheUsageBar({
  cacheReadTokens,
  cacheWriteTokens,
  freshInputTokens,
  cacheHitRate,
  pending = false,
}: CacheUsageBarProps) {
  if (pending) {
    return (
      <div className="p-4 text-center text-[12px] text-text-ghost">Loading</div>
    )
  }

  const total = cacheReadTokens + cacheWriteTokens + freshInputTokens

  const readPct = total > 0 ? Math.round((cacheReadTokens / total) * 100) : 0
  const inputPct = total > 0 ? Math.round((freshInputTokens / total) * 100) : 0
  const writePct = total > 0 ? Math.max(0, 100 - readPct - inputPct) : 0

  return (
    <div className="flex flex-col gap-4">
      {/* Hit Rate Banner */}
      <div className="flex items-center justify-between rounded-lg border border-shell-seam bg-white/[0.02] px-3.5 py-2.5">
        <div className="flex flex-col">
          <span className="text-xs text-text-subtle">Cache Hit Rate</span>
          <span className="text-lg font-semibold text-text-primary font-mono">
            {cacheHitRate}%
          </span>
        </div>
        <div className="text-right text-[11px] text-text-subtle">
          <span>{formatTokens(cacheReadTokens)} tokens read from cache</span>
        </div>
      </div>

      {/* Stacked 3-segment Bar */}
      <div className="flex flex-col gap-1.5">
        <div className="flex h-3 w-full overflow-hidden rounded-full bg-white/[0.07]">
          {readPct > 0 && (
            <div
              className="h-full bg-emerald-500 transition-all duration-300"
              style={{ width: `${readPct}%` }}
              title={`Cache Read: ${readPct}%`}
            />
          )}
          {inputPct > 0 && (
            <div
              className="h-full bg-blue-500 transition-all duration-300"
              style={{ width: `${inputPct}%` }}
              title={`Fresh Input: ${inputPct}%`}
            />
          )}
          {writePct > 0 && (
            <div
              className="h-full bg-amber-500 transition-all duration-300"
              style={{ width: `${writePct}%` }}
              title={`Cache Write: ${writePct}%`}
            />
          )}
        </div>

        {/* Legend */}
        <div className="grid grid-cols-3 gap-2 pt-1 text-[11px]">
          <div className="flex flex-col">
            <div className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-emerald-500" />
              <span className="text-text-subtle">Cache Read</span>
            </div>
            <span className="font-mono font-medium text-text-primary pl-3.5">
              {formatTokens(cacheReadTokens)} ({readPct}%)
            </span>
          </div>

          <div className="flex flex-col">
            <div className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-blue-500" />
              <span className="text-text-subtle">Fresh Input</span>
            </div>
            <span className="font-mono font-medium text-text-primary pl-3.5">
              {formatTokens(freshInputTokens)} ({inputPct}%)
            </span>
          </div>

          <div className="flex flex-col">
            <div className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-amber-500" />
              <span className="text-text-subtle">Cache Write</span>
            </div>
            <span className="font-mono font-medium text-text-primary pl-3.5">
              {formatTokens(cacheWriteTokens)} ({writePct}%)
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}

export type ActivitySparklineProps = {
  data: number[]
  color?: string
  width?: number
  height?: number
}

/**
 * Compact mini SVG sparkline for summary cards.
 */
export function ActivitySparkline({
  data,
  // Follows the theme by default (`text-accent` on the svg below) rather than a
  // hardcoded blue that no accent choice ever moves.
  color = 'currentColor',
  width = 64,
  height = 24,
}: ActivitySparklineProps) {
  if (!data || data.length === 0) return null

  const max = Math.max(...data, 1)
  const min = Math.min(...data, 0)
  const range = max - min || 1
  const len = data.length

  const points = data
    .map((val, i) => {
      const x = len > 1 ? (i / (len - 1)) * (width - 4) + 2 : width / 2
      const y = height - 2 - ((val - min) / range) * (height - 4)
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      className="shrink-0 overflow-visible text-accent"
      aria-hidden="true"
    >
      <polyline
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        points={points}
      />
    </svg>
  )
}
