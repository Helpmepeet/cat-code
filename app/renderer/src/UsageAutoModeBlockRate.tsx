import { useState } from 'react'
import type { AutoModeUsagePopulation, AutoModeUsageSummary } from '../../shared/usageAutoMode.js'
import { usageAxisCeiling, usageChartDate, usageChartTicks } from './usageGraphState.js'
import { useUsageChartWidth, usageNumber, usagePercent } from './usageDashboardState.js'
import {
  autoModeCommandRateHeadline,
  autoModeCommandRatePoints,
  confirmedRateSegments,
  type AutoModeRatePoint,
} from './usageAutoModeState.js'
import './usageAutoModeBlockRate.css'

type UsageAutoModeBlockRateProps = {
  summary: AutoModeUsageSummary
  startDate: string
  endDateExclusive: string
  bucketDays?: number
}

const DAY_MS = 86_400_000

function bucketLabel(date: string, bucketDays: number, endDateExclusive: string): string {
  if (bucketDays === 1) return date
  const finalDay = Math.min(
    Date.parse(`${date}T00:00:00.000Z`) + bucketDays * DAY_MS,
    Date.parse(`${endDateExclusive}T00:00:00.000Z`),
  ) - DAY_MS
  return `${date} to ${new Date(finalDay).toISOString().slice(0, 10)}`
}

function pointDetails(point: AutoModeRatePoint, population: AutoModeUsagePopulation): string {
  const errors = population.outcomes.operational_error
  const reviews = population.outcomes.review_required
  const unresolved = population.outcomes.incomplete + population.outcomes.unknown_outcome
  const rate = point.rate === null ? 'Unavailable' : usagePercent(point.rate * 100)
  const known = [
    errors ? `${usageNumber(errors)} operational ${errors === 1 ? 'error' : 'errors'}` : '',
    reviews ? `${usageNumber(reviews)} review-required ${reviews === 1 ? 'decision' : 'decisions'}` : '',
  ].filter(Boolean)
  return [
    `${usageNumber(point.numerator)} policy-denied commands / ${usageNumber(point.denominator)} recorded commands`,
    rate,
    ...known,
    unresolved ? `${usageNumber(unresolved)} unresolved` : '',
  ].filter(Boolean).join(', ')
}

function pointStateLabel(point: AutoModeRatePoint): string {
  if (point.state === 'confirmed') return 'Confirmed'
  if (point.state === 'provisional') return 'Provisional'
  return 'Incomplete coverage'
}

export function UsageAutoModeBlockRate({
  summary,
  startDate,
  endDateExclusive,
  bucketDays = 1,
}: UsageAutoModeBlockRateProps) {
  const chart = useUsageChartWidth()
  const points = autoModeCommandRatePoints(summary)
  const confirmedSegments = confirmedRateSegments(points, bucketDays)
  const numericPoints = points.filter((point): point is AutoModeRatePoint & { rate: number } => point.rate !== null)
  const [activeDate, setActiveDate] = useState<string | null>(null)
  const active = points.find(point => point.date === activeDate) ?? null
  const headline = autoModeCommandRateHeadline(summary)
  const height = chart.width < 360 ? 150 : 174
  const top = 20
  const bottom = height - 25
  const left = 44
  const right = chart.width - 10
  const peak = Math.max(0, ...numericPoints.map(point => point.rate * 100))
  const ceiling = Math.min(100, Math.max(5, usageAxisCeiling(peak * 1.15)))
  const start = Date.parse(`${startDate}T00:00:00.000Z`)
  const end = Date.parse(`${endDateExclusive}T00:00:00.000Z`) - DAY_MS
  const x = (date: string) => {
    const range = end - start
    const position = range <= 0 ? 0.5 : (Date.parse(`${date}T00:00:00.000Z`) - start) / range
    return left + Math.max(0, Math.min(1, position)) * (right - left)
  }
  const y = (rate: number) => bottom - rate * 100 / ceiling * (bottom - top)
  const ticks = usageChartTicks(startDate, endDateExclusive, right - left)
  const includeYear = Date.parse(`${endDateExclusive}T00:00:00.000Z`) - start > 365 * DAY_MS
  const headlineText = headline.rate === null
    ? 'Unavailable'
    : `${headline.state === 'provisional' ? 'Provisional ' : ''}${usagePercent(headline.rate * 100)}`
  const emptyMessage = headline.denominator === 0 && headline.state === 'unavailable' && summary.commands.coverage.state === 'complete'
    ? 'No command attempts'
    : 'Complete command coverage is unavailable'

  return <section className="usage-auto-mode-block-rate" aria-labelledby="usage-auto-mode-block-rate-title">
    <header>
      <div>
        <h3 id="usage-auto-mode-block-rate-title">Command block rate</h3>
        <p>Policy-denied commands / command attempts</p>
      </div>
      {headline.rate !== null && <div className={`usage-auto-mode-block-rate-headline usage-auto-mode-rate-${headline.state}`}>
        <strong>{headlineText}</strong>
        <span>{usageNumber(headline.numerator)} / {usageNumber(headline.denominator)} commands</span>
      </div>}
    </header>
    {numericPoints.length > 0
      ? <svg
          ref={chart.ref}
          className="usage-auto-mode-block-rate-chart"
          viewBox={`0 0 ${chart.width} ${height}`}
          role="group"
          aria-label={`Command block rate, 0 to ${ceiling}%`}
          onMouseLeave={() => setActiveDate(null)}
        >
          {[0, 1 / 3, 2 / 3, 1].map(fraction => {
            const value = ceiling * fraction
            return <g key={fraction}>
              <text x={left - 7} y={y(value / 100) + 4} textAnchor="end" className="usage-axis">{Number(value.toFixed(1))}%</text>
              <line x1={left} x2={right} y1={y(value / 100)} y2={y(value / 100)} className="usage-auto-mode-block-rate-grid"/>
            </g>
          })}
          {confirmedSegments.map((segment, index) => <path
            key={index}
            d={segment.map((point, pointIndex) => `${pointIndex ? 'L' : 'M'}${x(point.date)},${y(point.rate!)}`).join(' ')}
            className="usage-auto-mode-block-rate-line"
          />)}
          {numericPoints.map((point, index) => {
            const population = summary.buckets.find(bucket => bucket.date === point.date)?.commands ?? summary.commands
            const label = `${bucketLabel(point.date, bucketDays, endDateExclusive)}: ${pointDetails(point, population)}. ${pointStateLabel(point)}.`
            return <g
              key={point.date}
              className="usage-auto-mode-block-rate-point"
              role="button"
              tabIndex={activeDate === point.date || activeDate === null && index === 0 ? 0 : -1}
              aria-label={label}
              onMouseEnter={() => setActiveDate(point.date)}
              onFocus={() => setActiveDate(point.date)}
              onBlur={() => setActiveDate(null)}
              onClick={() => setActiveDate(point.date)}
              onKeyDown={event => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  setActiveDate(point.date)
                } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                  event.preventDefault()
                  const next = Math.max(0, Math.min(numericPoints.length - 1, index + (event.key === 'ArrowRight' ? 1 : -1)))
                  setActiveDate(numericPoints[next]!.date)
                  event.currentTarget.ownerSVGElement?.querySelectorAll<SVGGElement>('.usage-auto-mode-block-rate-point')[next]?.focus()
                } else if (event.key === 'Escape') {
                  setActiveDate(null)
                }
              }}
            >
              <title>{label}</title>
              <circle cx={x(point.date)} cy={y(point.rate)} r={activeDate === point.date ? 4.5 : 3.2} className={`usage-auto-mode-block-rate-dot usage-auto-mode-rate-${point.state}`}/>
              <rect
                x={Math.max(left - 8, index ? (x(numericPoints[index - 1]!.date) + x(point.date)) / 2 : left - 8)}
                y={top}
                width={Math.max(8, (index < numericPoints.length - 1 ? (x(point.date) + x(numericPoints[index + 1]!.date)) / 2 : right + 8) - (index ? (x(numericPoints[index - 1]!.date) + x(point.date)) / 2 : left - 8))}
                height={bottom - top}
                fill="transparent"
              />
            </g>
          })}
          {ticks.map((date, index) => <text key={date} x={x(date)} y={height - 3} textAnchor={index === 0 ? 'start' : index === ticks.length - 1 ? 'end' : 'middle'} className="usage-axis">{usageChartDate(date, includeYear)}</text>)}
        </svg>
      : <p className="usage-note">{emptyMessage}</p>}
    {active && <div className="usage-auto-mode-block-rate-readout" role="status">
      <strong>{bucketLabel(active.date, bucketDays, endDateExclusive)}</strong>
      <span>{pointDetails(active, summary.buckets.find(bucket => bucket.date === active.date)?.commands ?? summary.commands)}</span>
      <span>{pointStateLabel(active)}</span>
    </div>}
  </section>
}
