/**
 * Accounts usage analytics section (Anti-Potemkin compliant).
 * Sourced directly from real engine session aggregation (`UsageStatsSnapshot`).
 * Controls all charts and metrics with a unified global 7d / 30d range toggle.
 * Exports ONLY React components (Fast Refresh rule).
 *
 * `stats === null` is NOT-LOADED and is rendered as such, never as zeros. The
 * two states look identical in the data (`0` tokens either way) and mean
 * opposite things, and collapsing them with `?? 0` is what made this section
 * tell users with real history that they had no session activity. Not-loaded is
 * itself two states (`useUsageStatsDisplayState`): still coming, or long enough
 * that the read demonstrably failed, because a spinner that never ends is its
 * own wrong answer.
 *
 * Styling note: this section previously used `bg-card` / `text-foreground` /
 * `text-muted-foreground` / `border-border` / `bg-muted`. Those are shadcn
 * names and this app defines none of them, so Tailwind generated no such
 * utilities: every card lost its surface, every muted label rendered at full
 * `--color-text-primary`, and `border` fell back to v4's default `currentColor`,
 * outlining the whole page in near-white. Use the tokens in `theme.css`.
 */

import {
  DailyModelTokenChart,
  DailyActivityChart,
  TokensPerSessionChart,
  ModelBreakdownBars,
  CacheUsageBar,
  ActivitySparkline,
} from './AccountsUsageCharts.js'
import {
  formatTokens,
  useUsageStatsDisplayState,
  type UsageStatsDisplayState,
} from './statsState.js'
import type { UsageStatsRange, UsageStatsSnapshot } from '../../shared/protocol.js'

export type AccountsUsageSectionProps = {
  stats: UsageStatsSnapshot | null
  activeRange: UsageStatsRange
  onRangeChange: (range: UsageStatsRange) => void
}

/**
 * A KPI value that is not known. Deliberately not `0` and not a dash: both read
 * as a measured result. `leading-7` matches the 1.75rem line box of the
 * `text-xl` value it stands in for, so the card does not resize when the real
 * number lands.
 */
function UnknownValue({ dataState }: { dataState: UsageStatsDisplayState }) {
  return (
    <span className="text-[13px] font-medium leading-7 text-text-ghost">
      {dataState === 'pending' ? 'Loading' : 'Unavailable'}
    </span>
  )
}

export function AccountsUsageSection({
  stats,
  activeRange,
  onRangeChange,
}: AccountsUsageSectionProps) {
  const dataState = useUsageStatsDisplayState(stats !== null)
  const isUnknown = dataState !== 'loaded'
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
      <div className="flex flex-col gap-3 border-b border-shell-seam pb-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <svg
              className="h-4 w-4 text-accent"
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
            <h2 className="text-[13px] font-semibold tracking-tight text-text-primary">
              Usage Analytics
            </h2>
          </div>
          <p className="mt-0.5 text-[12px] text-text-subtle">
            Real token consumption aggregated from session activity across all models
          </p>
        </div>

        {/* Global Range Toggle */}
        <div
          className="inline-flex self-start rounded-lg border border-shell-seam bg-white/[0.03] p-0.5 sm:self-auto"
          role="group"
          aria-label="Time window range filter"
        >
          <button
            type="button"
            onClick={() => onRangeChange('7d')}
            className={`cursor-pointer rounded-md px-3 py-1 text-[12px] font-medium transition-colors ${
              activeRange === '7d'
                ? 'bg-white/[0.08] text-text-primary'
                : 'text-text-subtle hover:text-text-primary'
            }`}
            data-testid="stats-range-7d"
          >
            7 Days
          </button>
          <button
            type="button"
            onClick={() => onRangeChange('30d')}
            className={`cursor-pointer rounded-md px-3 py-1 text-[12px] font-medium transition-colors ${
              activeRange === '30d'
                ? 'bg-white/[0.08] text-text-primary'
                : 'text-text-subtle hover:text-text-primary'
            }`}
            data-testid="stats-range-30d"
          >
            30 Days
          </button>
        </div>
      </div>

      {/* 4 Summary Cards (KPIs) */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {/* Tokens in Period */}
        <div className="flex flex-col justify-between rounded-xl border border-shell-seam bg-surface-panel p-3.5">
          <span className="text-[12px] text-text-subtle">
            Tokens in {activeRange === '30d' ? '30d' : '7d'}
          </span>
          <div className="mt-1.5 flex items-baseline justify-between">
            {isUnknown ? (
              <UnknownValue dataState={dataState} />
            ) : (
              <span className="font-mono text-xl font-bold tracking-tight text-text-primary">
                {formatTokens(totalTokens)}
              </span>
            )}
            <ActivitySparkline data={dailyTotals} />
          </div>
        </div>

        {/* Daily Average */}
        <div className="flex flex-col justify-between rounded-xl border border-shell-seam bg-surface-panel p-3.5">
          <span className="text-[12px] text-text-subtle">Daily Average</span>
          <div className="mt-1.5">
            {isUnknown ? (
              <UnknownValue dataState={dataState} />
            ) : (
              <>
                <span className="font-mono text-xl font-bold tracking-tight text-text-primary">
                  {formatTokens(dailyAverage)}
                </span>
                <span className="ml-1 text-[11px] text-text-subtle">/ active day</span>
              </>
            )}
          </div>
        </div>

        {/* Cache Hit Rate */}
        <div className="flex flex-col justify-between rounded-xl border border-shell-seam bg-surface-panel p-3.5">
          <span className="text-[12px] text-text-subtle">Cache Hit Rate</span>
          <div className="mt-1.5 flex items-baseline gap-1.5">
            {isUnknown ? (
              <UnknownValue dataState={dataState} />
            ) : (
              <>
                <span className="font-mono text-xl font-bold tracking-tight text-text-primary">
                  {cacheHitRate}%
                </span>
                <span className="text-[11px] font-medium text-emerald-400">
                  prompt cache
                </span>
              </>
            )}
          </div>
        </div>

        {/* Sessions & Messages */}
        <div className="flex flex-col justify-between rounded-xl border border-shell-seam bg-surface-panel p-3.5">
          <span className="text-[12px] text-text-subtle">Active Sessions</span>
          <div className="mt-1.5">
            {isUnknown ? (
              <UnknownValue dataState={dataState} />
            ) : (
              <>
                <span className="font-mono text-xl font-bold tracking-tight text-text-primary">
                  {totalSessions}
                </span>
                <span className="ml-1 text-[11px] text-text-subtle">
                  ({totalMessages.toLocaleString()} msgs)
                </span>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Daily Tokens by Model Chart */}
      <div className="rounded-xl border border-shell-seam bg-surface-panel p-4">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h3 className="text-[12px] font-semibold text-text-primary">
              Daily Tokens by Model
            </h3>
            <p className="text-[11px] text-text-subtle">
              Daily volume curves over the selected{' '}
              {activeRange === '30d' ? '30-day' : '7-day'} window
            </p>
          </div>
        </div>
        <DailyModelTokenChart
          dailyModelTokens={stats?.dailyModelTokens ?? []}
          range={activeRange}
          dataState={dataState}
        />
      </div>

      {/* Workload Grid: what the tokens were spent on, and what a session costs */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Work per Day */}
        <div className="flex flex-col rounded-xl border border-shell-seam bg-surface-panel p-4">
          <h3 className="mb-1 text-[12px] font-semibold text-text-primary">
            Work per Day
          </h3>
          <p className="mb-4 text-[11px] text-text-subtle">
            Sessions, messages, and tool calls, each on its own scale
          </p>
          <div className="flex flex-1 flex-col justify-center">
            <DailyActivityChart
              dailyActivity={stats?.dailyActivity ?? []}
              range={activeRange}
              dataState={dataState}
            />
          </div>
        </div>

        {/* Tokens per Session */}
        <div className="flex flex-col rounded-xl border border-shell-seam bg-surface-panel p-4">
          <h3 className="mb-1 text-[12px] font-semibold text-text-primary">
            Tokens per Session
          </h3>
          <p className="mb-4 text-[11px] text-text-subtle">
            What one session costs, day by day, against the window average
          </p>
          <div className="flex flex-1 flex-col justify-center">
            <TokensPerSessionChart
              dailyModelTokens={stats?.dailyModelTokens ?? []}
              dailyActivity={stats?.dailyActivity ?? []}
              range={activeRange}
              dataState={dataState}
            />
          </div>
        </div>
      </div>

      {/* Breakdown Grid */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Token Distribution by Model */}
        <div className="flex flex-col rounded-xl border border-shell-seam bg-surface-panel p-4">
          <h3 className="mb-1 text-[12px] font-semibold text-text-primary">
            Token Distribution by Model
          </h3>
          <p className="mb-4 text-[11px] text-text-subtle">
            Share of tokens per model, split into input and output
          </p>
          <div className="flex flex-1 flex-col justify-center">
            <ModelBreakdownBars
              modelUsage={stats?.modelUsage ?? {}}
              dataState={dataState}
            />
          </div>
        </div>

        {/* Prompt Caching & Efficiency */}
        <div className="flex flex-col rounded-xl border border-shell-seam bg-surface-panel p-4">
          <h3 className="mb-1 text-[12px] font-semibold text-text-primary">
            Prompt Caching & Efficiency
          </h3>
          <p className="mb-3 text-[11px] text-text-subtle">
            Cache reads, writes, and fresh token balance
          </p>
          <div className="flex flex-1 flex-col justify-center">
            <CacheUsageBar
              cacheReadTokens={stats?.cacheReadTokens ?? 0}
              cacheWriteTokens={stats?.cacheWriteTokens ?? 0}
              freshInputTokens={stats?.freshInputTokens ?? 0}
              cacheHitRate={cacheHitRate}
              dataState={dataState}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
