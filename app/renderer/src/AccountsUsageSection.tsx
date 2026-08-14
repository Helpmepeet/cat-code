/**
 * Accounts usage analytics section (Anti-Potemkin compliant).
 * Sourced directly from real engine session aggregation (`UsageStatsSnapshot`).
 * Controls all charts and metrics with a unified global 7d / 30d range toggle.
 * Exports ONLY React components (Fast Refresh rule).
 */

import {
  DailyModelTokenChart,
  ModelBreakdownBars,
  CacheUsageBar,
  ActivitySparkline,
} from './AccountsUsageCharts.js'
import { formatTokens } from './statsState.js'
import type { UsageStatsRange, UsageStatsSnapshot } from '../../shared/protocol.js'

export type AccountsUsageSectionProps = {
  stats: UsageStatsSnapshot | null
  activeRange: UsageStatsRange
  onRangeChange: (range: UsageStatsRange) => void
}

export function AccountsUsageSection({
  stats,
  activeRange,
  onRangeChange,
}: AccountsUsageSectionProps) {
  const totalTokens = stats?.totalTokens ?? 0
  const activeDays = stats?.activeDays ?? 0
  const dailyAverage =
    activeDays > 0 ? Math.round(totalTokens / activeDays) : totalTokens
  const cacheHitRate = stats?.cacheHitRate ?? 0
  const totalSessions = stats?.totalSessions ?? 0
  const totalMessages = stats?.totalMessages ?? 0

  // Extract daily token totals for the mini sparkline
  const dailyTotals = (stats?.dailyModelTokens ?? []).map(entry => {
    let daySum = 0
    for (const val of Object.values(entry.tokensByModel)) {
      daySum += val ?? 0
    }
    return daySum
  })

  return (
    <div className="flex flex-col gap-5 pt-2" data-testid="accounts-usage-section">
      {/* Section Header with Global 7d / 30d Range Toggle */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border-b border-border/60 pb-3">
        <div>
          <div className="flex items-center gap-2">
            <svg
              className="h-4 w-4 text-amber-500"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth="2"
              stroke="currentColor"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 0 1 3 19.875v-6.75ZM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V8.625ZM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V4.125Z"
              />
            </svg>
            <h2 className="text-sm font-semibold tracking-tight text-foreground">
              Usage Analytics
            </h2>
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">
            Real token consumption aggregated from session activity across all models
          </p>
        </div>

        {/* Global Range Toggle */}
        <div
          className="inline-flex self-start sm:self-auto rounded-lg border border-border/80 bg-muted/40 p-0.5"
          role="group"
          aria-label="Time window range filter"
        >
          <button
            type="button"
            onClick={() => onRangeChange('7d')}
            className={`px-3 py-1 text-xs font-medium rounded-md transition-colors cursor-pointer ${
              activeRange === '7d'
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            }`}
            data-testid="stats-range-7d"
          >
            7 Days
          </button>
          <button
            type="button"
            onClick={() => onRangeChange('30d')}
            className={`px-3 py-1 text-xs font-medium rounded-md transition-colors cursor-pointer ${
              activeRange === '30d'
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            }`}
            data-testid="stats-range-30d"
          >
            30 Days
          </button>
        </div>
      </div>

      {/* 4 Summary Cards (KPIs) */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {/* Tokens in Period */}
        <div className="flex flex-col justify-between rounded-xl border border-border/70 bg-card/60 p-3.5 shadow-xs">
          <span className="text-xs text-muted-foreground">Tokens in {activeRange === '30d' ? '30d' : '7d'}</span>
          <div className="flex items-baseline justify-between mt-1.5">
            <span className="text-xl font-bold tracking-tight text-foreground font-mono">
              {formatTokens(totalTokens)}
            </span>
            <ActivitySparkline data={dailyTotals} color="#d97706" />
          </div>
        </div>

        {/* Daily Average */}
        <div className="flex flex-col justify-between rounded-xl border border-border/70 bg-card/60 p-3.5 shadow-xs">
          <span className="text-xs text-muted-foreground">Daily Average</span>
          <div className="mt-1.5">
            <span className="text-xl font-bold tracking-tight text-foreground font-mono">
              {formatTokens(dailyAverage)}
            </span>
            <span className="text-[11px] text-muted-foreground ml-1">/ active day</span>
          </div>
        </div>

        {/* Cache Hit Rate */}
        <div className="flex flex-col justify-between rounded-xl border border-border/70 bg-card/60 p-3.5 shadow-xs">
          <span className="text-xs text-muted-foreground">Cache Hit Rate</span>
          <div className="mt-1.5 flex items-baseline gap-1.5">
            <span className="text-xl font-bold tracking-tight text-foreground font-mono">
              {cacheHitRate}%
            </span>
            <span className="text-[11px] text-emerald-500 font-medium">prompt cache</span>
          </div>
        </div>

        {/* Sessions & Messages */}
        <div className="flex flex-col justify-between rounded-xl border border-border/70 bg-card/60 p-3.5 shadow-xs">
          <span className="text-xs text-muted-foreground">Active Sessions</span>
          <div className="mt-1.5">
            <span className="text-xl font-bold tracking-tight text-foreground font-mono">
              {totalSessions}
            </span>
            <span className="text-[11px] text-muted-foreground ml-1">
              ({totalMessages.toLocaleString()} msgs)
            </span>
          </div>
        </div>
      </div>

      {/* Daily Tokens by Model Chart */}
      <div className="rounded-xl border border-border/70 bg-card/60 p-4 shadow-xs">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="text-xs font-semibold text-foreground">
              Daily Tokens by Model
            </h3>
            <p className="text-[11px] text-muted-foreground">
              Daily volume curves over the selected {activeRange === '30d' ? '30-day' : '7-day'} window
            </p>
          </div>
        </div>
        <DailyModelTokenChart
          dailyModelTokens={stats?.dailyModelTokens ?? []}
          range={activeRange}
        />
      </div>

      {/* Breakdown Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Token Distribution by Model */}
        <div className="rounded-xl border border-border/70 bg-card/60 p-4 shadow-xs flex flex-col">
          <h3 className="text-xs font-semibold text-foreground mb-1">
            Token Distribution by Model
          </h3>
          <p className="text-[11px] text-muted-foreground mb-4">
            Total tokens consumed per model during this period
          </p>
          <div className="flex-1 flex flex-col justify-center">
            <ModelBreakdownBars modelUsage={stats?.modelUsage ?? {}} />
          </div>
        </div>

        {/* Prompt Caching & Efficiency */}
        <div className="rounded-xl border border-border/70 bg-card/60 p-4 shadow-xs flex flex-col">
          <h3 className="text-xs font-semibold text-foreground mb-1">
            Prompt Caching & Efficiency
          </h3>
          <p className="text-[11px] text-muted-foreground mb-3">
            Cache reads, writes, and fresh token balance
          </p>
          <div className="flex-1 flex flex-col justify-center">
            <CacheUsageBar
              cacheReadTokens={stats?.cacheReadTokens ?? 0}
              cacheWriteTokens={stats?.cacheWriteTokens ?? 0}
              freshInputTokens={stats?.freshInputTokens ?? 0}
              cacheHitRate={cacheHitRate}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
