/**
 * Real usage analytics charts (Anti-Potemkin compliant).
 * Renders actual historical token usage from `UsageStatsSnapshot`.
 * Exports ONLY React components (Fast Refresh rule).
 *
 * Every chart takes `dataState`. Neither `pending` nor `unavailable` may be
 * drawn as an empty RESULT: an empty-state message is a claim about the user's
 * history, and only a snapshot that actually arrived entitles us to make it. See
 * the section module for the theme-token rule these files broke.
 */

import { useState, type ReactNode } from 'react'
import {
  computeChartSeries,
  computeDailyActivitySeries,
  computeModelBreakdown,
  computeTokensPerSessionSeries,
  formatTokens,
  type ChartMultiSeries,
  type ModelBreakdownItem,
  type UsageStatsDisplayState,
} from './statsState.js'
import type {
  UsageStatsDailyActivityItem,
  UsageStatsDailyModelTokens,
  UsageStatsModelUsageItem,
} from '../../shared/protocol.js'

export type DailyModelTokenChartProps = {
  dailyModelTokens: UsageStatsDailyModelTokens[]
  range: '7d' | '30d'
  /** Whether a snapshot arrived, is still coming, or failed to. */
  dataState?: UsageStatsDisplayState
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
  dataState = 'loaded',
}: DailyModelTokenChartProps) {
  const chartData: ChartMultiSeries = computeChartSeries(dailyModelTokens)
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null)

  if (dataState === 'pending') {
    return (
      <ChartPlaceholder>
        <span className="mb-2.5 h-4 w-4 animate-spin rounded-full border-2 border-shell-seam border-t-text-muted" />
        <span className="font-medium text-text-muted">Loading usage analytics</span>
      </ChartPlaceholder>
    )
  }

  if (dataState === 'unavailable') {
    return (
      <ChartPlaceholder>
        <span className="font-medium text-text-muted">
          Could not read session history
        </span>
        <span className="mt-0.5 text-text-subtle">This retries automatically.</span>
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

/**
 * The terse not-loaded treatment for the cards that sit BESIDE the big chart.
 * The full "Could not read session history" sentence lives in one place, on the
 * chart card above; four copies of it would be noise.
 */
function TerseDataState({ dataState }: { dataState: UsageStatsDisplayState }) {
  return (
    <div className="p-4 text-center text-[12px] text-text-ghost">
      {dataState === 'pending' ? 'Loading' : 'Unavailable'}
    </div>
  )
}

const STRIP_WIDTH = 320
const STRIP_HEIGHT = 44
const STRIP_BAR_GAP = 2

type ActivityStripProps = {
  values: number[]
  max: number
  hoveredIndex: number | null
  onHover: (index: number | null) => void
  label: string
}

/**
 * One row of the small-multiples strip: bars on their own scale.
 *
 * A day that recorded zero draws a baseline stub rather than nothing, so an idle
 * day is visibly idle instead of looking like a gap in the data.
 */
function ActivityStrip({ values, max, hoveredIndex, onHover, label }: ActivityStripProps) {
  const count = Math.max(1, values.length)
  const colWidth = STRIP_WIDTH / count
  const barWidth = Math.max(1.5, colWidth - STRIP_BAR_GAP)
  const scale = max > 0 ? max : 1

  return (
    <svg
      viewBox={`0 0 ${STRIP_WIDTH} ${STRIP_HEIGHT}`}
      className="w-full text-accent"
      style={{ height: 'auto' }}
      role="img"
      aria-label={`${label} per day`}
    >
      {values.map((value, i) => {
        const barHeight = value > 0 ? Math.max(2, (value / scale) * STRIP_HEIGHT) : 1.5
        const x = i * colWidth + (colWidth - barWidth) / 2
        return (
          <rect
            key={`bar-${i}`}
            x={x}
            y={STRIP_HEIGHT - barHeight}
            width={barWidth}
            height={barHeight}
            rx="1.5"
            fill="currentColor"
            fillOpacity={value > 0 ? (hoveredIndex === i ? 1 : 0.7) : 0.25}
            className="transition-opacity"
          />
        )
      })}
      {/* Hover targets, wider than the bars so thin days stay reachable. */}
      {values.map((_, i) => (
        <rect
          key={`hit-${i}`}
          x={i * colWidth}
          y={0}
          width={colWidth}
          height={STRIP_HEIGHT}
          fill="transparent"
          className="cursor-pointer"
          onMouseEnter={() => onHover(i)}
        />
      ))}
    </svg>
  )
}

export type DailyActivityChartProps = {
  dailyActivity: UsageStatsDailyActivityItem[]
  range: '7d' | '30d'
  /** Whether a snapshot arrived, is still coming, or failed to. */
  dataState?: UsageStatsDisplayState
}

/**
 * Sessions, messages, and tool calls per day, as three small multiples.
 *
 * Small multiples rather than grouped bars because the three measures differ by
 * one to two orders of magnitude; see `computeDailyActivitySeries` for why a
 * second y-axis is not the alternative.
 */
export function DailyActivityChart({
  dailyActivity,
  range,
  dataState = 'loaded',
}: DailyActivityChartProps) {
  const series = computeDailyActivitySeries(dailyActivity)
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null)

  if (dataState !== 'loaded') return <TerseDataState dataState={dataState} />

  if (series.dates.length === 0) {
    return (
      <div className="p-4 text-center text-[12px] text-text-subtle">
        No sessions in this {range === '30d' ? '30-day' : '7-day'} period.
      </div>
    )
  }

  const rows = [
    { label: 'Sessions', values: series.sessions, max: series.maxSessions },
    { label: 'Messages', values: series.messages, max: series.maxMessages },
    { label: 'Tool calls', values: series.toolCalls, max: series.maxToolCalls },
  ]

  const firstDate = series.displayDates[0] ?? ''
  const lastDate = series.displayDates[series.displayDates.length - 1] ?? ''

  return (
    <div
      className="flex flex-col gap-3"
      onMouseLeave={() => setHoveredIndex(null)}
      data-testid="daily-activity-chart"
    >
      {rows.map(row => (
        <div key={row.label} className="flex flex-col gap-1">
          <div className="flex items-baseline justify-between text-[11px]">
            <span className="font-medium text-text-primary">{row.label}</span>
            <span className="font-mono text-text-subtle">
              peak {row.max.toLocaleString()}
            </span>
          </div>
          <ActivityStrip
            values={row.values}
            max={row.max}
            hoveredIndex={hoveredIndex}
            onHover={setHoveredIndex}
            label={row.label}
          />
        </div>
      ))}

      {/* Window ends only. Per-day labels collide at 30 points in a half-width
          card, and the hover readout already names any specific day. */}
      <div className="flex items-center justify-between font-mono text-[10px] text-text-subtle">
        <span>{firstDate}</span>
        <span>{lastDate}</span>
      </div>

      {hoveredIndex !== null && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-shell-seam bg-surface-raised px-3 py-2 text-[11px]">
          <span className="font-mono font-semibold text-text-primary">
            {series.displayDates[hoveredIndex]}
          </span>
          {rows.map(row => (
            <span key={row.label} className="text-text-subtle">
              {row.label}{' '}
              <span className="font-mono font-medium text-text-primary">
                {(row.values[hoveredIndex] ?? 0).toLocaleString()}
              </span>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

export type TokensPerSessionChartProps = {
  dailyModelTokens: UsageStatsDailyModelTokens[]
  dailyActivity: UsageStatsDailyActivityItem[]
  range: '7d' | '30d'
  /** Whether a snapshot arrived, is still coming, or failed to. */
  dataState?: UsageStatsDisplayState
}

/**
 * Tokens consumed per session, day by day, against the window average.
 *
 * One series, so no legend: the card title names it. The dashed reference line
 * is the window aggregate, which is weighted by session count and is not the
 * mean of the plotted dots (`computeTokensPerSessionSeries`).
 */
export function TokensPerSessionChart({
  dailyModelTokens,
  dailyActivity,
  range,
  dataState = 'loaded',
}: TokensPerSessionChartProps) {
  const series = computeTokensPerSessionSeries(dailyModelTokens, dailyActivity)
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null)

  if (dataState !== 'loaded') return <TerseDataState dataState={dataState} />

  if (series.values.length === 0) {
    return (
      <div className="p-4 text-center text-[12px] text-text-subtle">
        No sessions to measure in this {range === '30d' ? '30-day' : '7-day'} period.
      </div>
    )
  }

  const width = 320
  const height = 130
  const padLeft = 40
  const padRight = 8
  const padTop = 12
  const padBottom = 20
  const plotWidth = width - padLeft - padRight
  const plotHeight = height - padTop - padBottom

  const pointCount = series.values.length
  const maxVal = series.maxValue > 0 ? series.maxValue * 1.15 : 1000

  const getX = (i: number) => {
    if (pointCount <= 1) return padLeft + plotWidth / 2
    return padLeft + (i / (pointCount - 1)) * plotWidth
  }
  const getY = (val: number) =>
    padTop + plotHeight - (Math.max(0, val) / maxVal) * plotHeight

  const linePoints = series.values.map((v, i) => `${getX(i)},${getY(v)}`).join(' ')
  const areaPoints = [
    `${getX(0)},${padTop + plotHeight}`,
    ...series.values.map((v, i) => `${getX(i)},${getY(v)}`),
    `${getX(pointCount - 1)},${padTop + plotHeight}`,
  ].join(' ')

  const averageY = getY(series.averagePerSession)
  const showAverageLine = series.averagePerSession > 0 && series.averagePerSession <= maxVal
  const labelStep = pointCount > 8 ? Math.ceil(pointCount / 4) : 1

  return (
    <div className="flex flex-col gap-3" data-testid="tokens-per-session-chart">
      <div className="relative w-full overflow-hidden rounded-lg bg-white/[0.02] p-2">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="w-full select-none text-accent"
          style={{ height: 'auto' }}
          role="img"
          aria-label="Tokens per session by day"
          onMouseLeave={() => setHoveredIndex(null)}
        >
          {[0, maxVal * 0.5, maxVal].map((val, idx) => (
            <g key={`ytick-${idx}`}>
              <line
                x1={padLeft}
                y1={getY(val)}
                x2={width - padRight}
                y2={getY(val)}
                stroke="currentColor"
                className="text-text-ghost/40"
                strokeDasharray="3 3"
                strokeWidth="1"
              />
              <text
                x={padLeft - 6}
                y={getY(val) + 3}
                textAnchor="end"
                fontSize="9"
                className="fill-text-subtle font-mono"
              >
                {formatTokens(Math.round(val))}
              </text>
            </g>
          ))}

          <polygon points={areaPoints} fill="currentColor" fillOpacity="0.08" />
          <polyline
            points={linePoints}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />

          {showAverageLine && (
            <line
              x1={padLeft}
              y1={averageY}
              x2={width - padRight}
              y2={averageY}
              stroke="currentColor"
              className="text-text-muted"
              strokeWidth="1"
              strokeDasharray="4 3"
            />
          )}

          {series.values.map((v, i) => (
            <circle
              key={`dot-${i}`}
              cx={getX(i)}
              cy={getY(v)}
              r={hoveredIndex === i ? '4' : '2.5'}
              fill="currentColor"
              stroke="var(--color-surface-panel)"
              strokeWidth="1.5"
              className="transition-all"
            />
          ))}

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

          {series.values.map((_, i) => {
            const colWidth = plotWidth / Math.max(1, pointCount)
            return (
              <rect
                key={`hit-${i}`}
                x={Math.max(0, getX(i) - colWidth / 2)}
                y={padTop}
                width={Math.max(12, colWidth)}
                height={plotHeight}
                fill="transparent"
                className="cursor-pointer"
                onMouseEnter={() => setHoveredIndex(i)}
              />
            )
          })}

          {series.displayDates.map((dateLabel, i) => {
            if (i !== 0 && i !== pointCount - 1 && i % labelStep !== 0) return null
            return (
              <text
                key={`xlabel-${i}`}
                x={getX(i)}
                y={height - 5}
                textAnchor="middle"
                fontSize="9"
                className="fill-text-subtle font-mono"
              >
                {dateLabel}
              </text>
            )
          })}
        </svg>
      </div>

      {hoveredIndex !== null ? (
        <div className="flex items-center justify-between rounded-lg border border-shell-seam bg-surface-raised px-3 py-2 text-[11px]">
          <span className="font-mono font-semibold text-text-primary">
            {series.displayDates[hoveredIndex]}
          </span>
          <span className="text-text-subtle">
            <span className="font-mono font-medium text-text-primary">
              {formatTokens(series.values[hoveredIndex] ?? 0)}
            </span>{' '}
            per session
          </span>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-x-3 text-[11px] text-text-subtle">
          <span>
            Average{' '}
            <span className="font-mono font-medium text-text-primary">
              {formatTokens(series.averagePerSession)}
            </span>{' '}
            per session
          </span>
          <span>
            <span className="font-mono font-medium text-text-primary">
              {formatTokens(series.averagePerMessage)}
            </span>{' '}
            per message
          </span>
        </div>
      )}

      {series.subagentOnlyDays > 0 && (
        <p className="text-[11px] text-text-subtle">
          {series.subagentOnlyDays}{' '}
          {series.subagentOnlyDays === 1 ? 'day is' : 'days are'} not plotted:
          those tokens came from subagent runs with no session of their own.
        </p>
      )}
    </div>
  )
}

export type ModelBreakdownBarsProps = {
  modelUsage: Record<string, UsageStatsModelUsageItem>
  /** Whether a snapshot arrived, is still coming, or failed to. */
  dataState?: UsageStatsDisplayState
}

/** Input's share of one model's own tokens; the output segment takes the rest. */
function inputShare(item: ModelBreakdownItem): number {
  if (item.totalTokens <= 0) return 0
  return (item.inputTokens / item.totalTokens) * 100
}

/**
 * Horizontal progress bars visualizing token share per model, split by direction.
 *
 * The bar's LENGTH is the model's share of all tokens; the split WITHIN it is
 * input versus output, which `computeModelBreakdown` has always returned and
 * this chart used to discard. Output is the number that separates one model from
 * another, and it was the one number the card could not show.
 *
 * Direction is carried by lightness of the single model hue plus a printed
 * figure for each side, never by hue alone: the hue is the model's identity, and
 * spending it on a second variable would collide with the legend above.
 */
export function ModelBreakdownBars({
  modelUsage,
  dataState = 'loaded',
}: ModelBreakdownBarsProps) {
  const items: ModelBreakdownItem[] = computeModelBreakdown(modelUsage)

  if (dataState !== 'loaded') {
    // One word, because the chart card above already carries the full message.
    return (
      <div className="p-4 text-center text-[12px] text-text-ghost">
        {dataState === 'pending' ? 'Loading' : 'Unavailable'}
      </div>
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
          {/* Track, then the model's share split input / output */}
          <div className="h-2 w-full overflow-hidden rounded-full bg-white/[0.07]">
            <div
              className="flex h-full gap-[2px] overflow-hidden rounded-full transition-all duration-300"
              style={{ width: `${Math.max(item.percentage, 2)}%` }}
            >
              <div
                className="h-full"
                style={{
                  width: `${inputShare(item)}%`,
                  backgroundColor: item.color,
                  opacity: 0.45,
                }}
                title={`Input: ${formatTokens(item.inputTokens)}`}
              />
              <div
                className="h-full flex-1"
                style={{ backgroundColor: item.color }}
                title={`Output: ${formatTokens(item.outputTokens)}`}
              />
            </div>
          </div>

          <div className="flex items-center gap-3 text-[10px] text-text-subtle">
            <span className="flex items-center gap-1.5">
              <span
                className="h-1.5 w-1.5 rounded-full"
                style={{ backgroundColor: item.color, opacity: 0.45 }}
              />
              in{' '}
              <span className="font-mono text-text-muted">
                {formatTokens(item.inputTokens)}
              </span>
            </span>
            <span className="flex items-center gap-1.5">
              <span
                className="h-1.5 w-1.5 rounded-full"
                style={{ backgroundColor: item.color }}
              />
              out{' '}
              <span className="font-mono text-text-muted">
                {formatTokens(item.outputTokens)}
              </span>
            </span>
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
  /** Whether a snapshot arrived, is still coming, or failed to. */
  dataState?: UsageStatsDisplayState
}

/**
 * 3-segment stacked bar showing Prompt Cache read vs fresh input vs cache write.
 */
export function CacheUsageBar({
  cacheReadTokens,
  cacheWriteTokens,
  freshInputTokens,
  cacheHitRate,
  dataState = 'loaded',
}: CacheUsageBarProps) {
  if (dataState !== 'loaded') {
    return (
      <div className="p-4 text-center text-[12px] text-text-ghost">
        {dataState === 'pending' ? 'Loading' : 'Unavailable'}
      </div>
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
  width?: number
  height?: number
}

/**
 * Compact mini SVG sparkline for summary cards. Draws in `currentColor` from the
 * `text-accent` on the svg, so it tracks the accent theme; it carries no colour
 * prop because nothing needs one, and the hardcoded blue it used to default to
 * was invisible to every accent choice.
 */
export function ActivitySparkline({
  data,
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
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        points={points}
      />
    </svg>
  )
}
