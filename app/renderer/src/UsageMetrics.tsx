import type { UsageRangeSummary } from '../../shared/usageDashboard.js';
import { usageCompact, usageNumber, usagePercent, usageTotal, usageShare } from './usageDashboardState.js';
export function UsageMetrics({ summary, unknown, partial }: { summary?: UsageRangeSummary; unknown: string; partial: boolean }) {
    const items = [
        { label: 'Total tokens', value: summary ? usageCompact(usageTotal(summary.tokens)) : unknown, series: summary?.days.map(day => usageTotal(day.tokens)) ?? [] },
        { label: 'Per active day', value: summary ? usageCompact(summary.activeDays ? usageTotal(summary.tokens) / summary.activeDays : 0) : unknown, series: [] },
        { label: 'Sessions used', value: summary ? usageNumber(summary.sessions) : unknown, series: summary?.days.map(day => day.sessions) ?? [] },
        { label: 'Tool requests', value: summary ? usageNumber(summary.requests) : unknown, series: summary?.days.map(day => day.requests) ?? [] },
        { label: 'Cached input', value: summary ? partial ? 'Unavailable' : usagePercent(summary.cachedInputShare) : unknown, series: partial ? [] : summary?.days.map(day => usageShare(day.tokens)).filter((value): value is number => value !== null) ?? [] },
    ];
    return <section className="usage-overview" aria-label="Usage overview"><div className="usage-cards">{items.map(item => {
        const max = Math.max(1, ...item.series);
        const points = item.series.map((value, index) => `${1 + index / Math.max(1, item.series.length - 1) * 62},${17 - value / max * 15}`).join(' ');
        return <section className="usage-metric" key={item.label}><h2>{item.label}</h2><strong>{item.value}</strong><div className="usage-metric-foot">{item.series.length > 1 && <svg viewBox="0 0 64 18" aria-hidden="true"><polyline points={points}/></svg>}</div></section>;
    })}</div></section>;
}
