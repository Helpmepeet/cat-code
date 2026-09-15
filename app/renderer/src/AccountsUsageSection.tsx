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

import type { ReactNode } from 'react'
import {
  DailyModelTokenChart,
  DailyActivityChart,
  TokensPerSessionChart,
  ModelBreakdownBars,
  CacheUsageBar,
  ActivitySparkline,
  UsageBarsIcon,
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

/** The measured number on a KPI card, in the one type treatment all four share. */
function KpiValue({ children }: { children: ReactNode }) {
  return (
    <span className="font-mono text-xl font-bold tracking-tight text-text-primary">
      {children}
    </span>
  )
}

/**
 * One KPI card: its label, then the measured value or the not-loaded stand-in
 * that keeps the card from claiming a result it does not have.
 *
 * `bodyClass` carries the per-card layout of the value row, the only thing the
 * four differ in. `trailing` renders in BOTH states, so the tokens card's
 * sparkline stays on screen while the snapshot is still coming.
 */
function KpiCard({
  label,
  dataState,
  bodyClass,
  children,
  trailing,
}: {
  label: ReactNode
  dataState: UsageStatsDisplayState
  bodyClass: string
  children: ReactNode
  trailing?: ReactNode
}) {
  return (
    <div className="flex flex-col justify-between rounded-xl border border-shell-seam bg-surface-panel p-3.5">
      <span className="text-[12px] text-text-subtle">{label}</span>
      <div className={bodyClass}>
        {dataState === 'loaded' ? children : <UnknownValue dataState={dataState} />}
        {trailing}
      </div>
    </div>
  )
}

/**
 * One half-width analytics panel: heading, a line of description, then the
 * chart centred in whatever height is left.
 *
 * `descriptionGap` exists only because the caching panel sits 4px tighter than
 * the other three. Matching them would be a visual change, not a simplification.
 */
function ChartCard({
  title,
  description,
  descriptionGap = 'mb-4',
  children,
}: {
  title: string
  description: string
  descriptionGap?: 'mb-3' | 'mb-4'
  children: ReactNode
}) {
  return (
    <div className="flex flex-col rounded-xl border border-shell-seam bg-surface-panel p-4">
      <h3 className="mb-1 text-[12px] font-semibold text-text-primary">{title}</h3>
      <p className={`${descriptionGap} text-[11px] text-text-subtle`}>{description}</p>
      <div className="flex flex-1 flex-col justify-center">{children}</div>
    </div>
  )
}

export function AccountsUsageSection({
  stats,
  activeRange,
  onRangeChange,
}: AccountsUsageSectionProps) {
  const dataState = useUsageStatsDisplayState(stats !== null)
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
            <UsageBarsIcon className="h-4 w-4 text-accent" strokeWidth="2" />
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
        <KpiCard
          label={<>Tokens in {activeRange === '30d' ? '30d' : '7d'}</>}
          dataState={dataState}
          bodyClass="mt-1.5 flex items-baseline justify-between"
          trailing={<ActivitySparkline data={dailyTotals} />}
        >
          <KpiValue>{formatTokens(totalTokens)}</KpiValue>
        </KpiCard>

        <KpiCard label="Daily Average" dataState={dataState} bodyClass="mt-1.5">
          <KpiValue>{formatTokens(dailyAverage)}</KpiValue>
          <span className="ml-1 text-[11px] text-text-subtle">/ active day</span>
        </KpiCard>

        <KpiCard
          label="Cache Hit Rate"
          dataState={dataState}
          bodyClass="mt-1.5 flex items-baseline gap-1.5"
        >
          <KpiValue>{cacheHitRate}%</KpiValue>
          <span className="text-[11px] font-medium text-emerald-400">
            prompt cache
          </span>
        </KpiCard>

        <KpiCard label="Active Sessions" dataState={dataState} bodyClass="mt-1.5">
          <KpiValue>{totalSessions}</KpiValue>
          <span className="ml-1 text-[11px] text-text-subtle">
            ({totalMessages.toLocaleString()} msgs)
          </span>
        </KpiCard>
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
        <ChartCard
          title="Work per Day"
          description="Sessions, messages, and tool calls, each on its own scale"
        >
          <DailyActivityChart
            dailyActivity={stats?.dailyActivity ?? []}
            range={activeRange}
            dataState={dataState}
          />
        </ChartCard>

        <ChartCard
          title="Tokens per Session"
          description="What one session costs, day by day, against the window average"
        >
          <TokensPerSessionChart
            dailyModelTokens={stats?.dailyModelTokens ?? []}
            dailyActivity={stats?.dailyActivity ?? []}
            range={activeRange}
            dataState={dataState}
          />
        </ChartCard>
      </div>

      {/* Breakdown Grid */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ChartCard
          title="Token Distribution by Model"
          description="Share of tokens per model, split into input and output"
        >
          <ModelBreakdownBars
            modelUsage={stats?.modelUsage ?? {}}
            dataState={dataState}
          />
        </ChartCard>

        <ChartCard
          title="Prompt Caching & Efficiency"
          description="Cache reads, writes, and fresh token balance"
          descriptionGap="mb-3"
        >
          <CacheUsageBar
            cacheReadTokens={stats?.cacheReadTokens ?? 0}
            cacheWriteTokens={stats?.cacheWriteTokens ?? 0}
            freshInputTokens={stats?.freshInputTokens ?? 0}
            cacheHitRate={cacheHitRate}
            dataState={dataState}
          />
        </ChartCard>
      </div>
    </div>
  )
}
