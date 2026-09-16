import { usageMetricDelta } from './usageMetricDelta.js';
import type { UsageRangeSummary } from '../../shared/usageDashboard.js';
import { usageCompact, usageNumber, usagePercent, usageTotal, usageShare } from './usageDashboardState.js';
export function UsageMetrics({ summary, unknown, partial }: { summary?: UsageRangeSummary; unknown: string; partial: boolean }) {
    const previous = !partial && summary?.range !== 'all' ? summary?.previousPeriod : undefined;
    const average = (tokens: UsageRangeSummary['tokens'], activeDays: number) => activeDays ? usageTotal(tokens) / activeDays : 0;
    const delta = (current: number | null, baseline: number | null | undefined, points = false) => previous ? usageMetricDelta(current, baseline ?? null, points ? 'points' : 'percent') : null;
    const comparison = previous ? `Compared with previous ${summary?.range === '7d' ? '7' : '30'} days: ${previous.startInclusive.slice(0, 10)} 00:00 to ${previous.endInclusive.slice(0, 16).replace('T', ' ')} UTC` : '';
    const items = [
        { label: 'Total tokens', delta: delta(summary ? usageTotal(summary.tokens) : null, previous ? usageTotal(previous.tokens) : null), value: summary ? usageCompact(usageTotal(summary.tokens)) : unknown, series: summary?.days.map(day => usageTotal(day.tokens)) ?? [] },
        { label: 'Per active day', delta: delta(summary ? average(summary.tokens, summary.activeDays) : null, previous ? average(previous.tokens, previous.activeDays) : null), value: summary ? usageCompact(summary.activeDays ? usageTotal(summary.tokens) / summary.activeDays : 0) : unknown, series: [] },
        { label: 'Sessions used', delta: delta(summary?.sessions ?? null, previous?.sessions), value: summary ? usageNumber(summary.sessions) : unknown, series: summary?.days.map(day => day.sessions) ?? [] },
        { label: 'Tool requests', delta: delta(summary?.requests ?? null, previous?.requests), value: summary ? usageNumber(summary.requests) : unknown, series: summary?.days.map(day => day.requests) ?? [] },
        { label: 'Cached input', delta: delta(summary?.cachedInputShare ?? null, previous?.cachedInputShare, true), value: summary ? partial ? 'Unavailable' : usagePercent(summary.cachedInputShare) : unknown, series: partial ? [] : summary?.days.map(day => usageShare(day.tokens)).filter((value): value is number => value !== null) ?? [] },
    ];
    return <section className="usage-overview" aria-label="Usage overview"><div className="usage-cards">{items.map(item => {
        const max = Math.max(1, ...item.series);
        const points = item.series.map((value, index) => `${1 + index / Math.max(1, item.series.length - 1) * 62},${17 - value / max * 15}`).join(' ');
        return <section className="usage-metric" key={item.label}><h2>{item.label}</h2><strong>{item.value}</strong><div className="usage-metric-foot">{item.delta && <span className={`usage-metric-delta usage-delta-${item.delta.direction}`} role="img" aria-label={`${item.label}: ${item.delta.description}. ${comparison}`} title={`${item.delta.description}. ${comparison}`}>{item.delta.text}</span>}{item.series.length > 1 && <svg viewBox="0 0 64 18" aria-hidden="true"><polyline points={points}/></svg>}</div></section>;
    })}</div></section>;
}
