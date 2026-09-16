import { useState } from 'react';
import type { UsageRangeSummary } from '../../shared/usageDashboard.js';
import { usageBucketDays, usageBucketLabel, usageDatePosition, usageTrendPoints } from './usageTrendState.js';
import { usageAxisCeiling, usageChartDate, usageChartTicks } from './usageGraphState.js';
import { useUsageChartWidth, usageCompact, usageNumber, usagePercent } from './usageDashboardState.js';

export function UsageAreaTrend({ summary, metric, partial, selected = '', onSelect = () => {} }: {
    summary: UsageRangeSummary;
    metric: 'cache' | 'requests' | 'errors';
    partial: boolean;
    selected?: string;
    onSelect?: (date: string) => void;
}) {
    const [hovered, setHovered] = useState<string | null>(null);
    const chart = useUsageChartWidth();
    const cache = metric === 'cache', percent = metric !== 'requests';
    const points = usageTrendPoints(summary, metric);
    const valid = points.filter(point => point.value !== null);
    const unavailable = cache && partial;
    const peak = Math.max(1, ...valid.map(point => point.value!));
    const values = unavailable ? [] : valid.map(point => point.value!);
    const low = values.length ? Math.min(...values) : 0, high = values.length ? Math.max(...values) : 100;
    const min = cache ? Math.max(0, Math.floor((low - 1.5) / 5) * 5) : 0;
    const max = cache ? Math.min(100, Math.ceil((high + 1.5) / 5) * 5) : usageAxisCeiling(peak * 1.15);
    const height = chart.width < 360 ? 128 : 150, top = 12, bottom = height - 22;
    const left = 40, right = chart.width - 10;
    const x = (date: string) => left + usageDatePosition(summary, date) * (right - left);
    const y = (value: number) => bottom - (value - min) / (max - min) * (bottom - top);
    const ticks = usageChartTicks(summary.startInclusive, summary.endExclusive, right - left);
    const includeYear = Date.parse(summary.endExclusive) - Date.parse(summary.startInclusive) > 365 * 86400000;
    const segments: typeof points[] = [];
    let segment: typeof points = [];
    for (const point of points) {
        if (point.value === null) { if (segment.length) segments.push(segment); segment = []; }
        else segment.push(point);
    }
    if (segment.length) segments.push(segment);
    const shown = hovered ?? selected;
    const detail = points.find(point => point.date === shown && point.value !== null);
    const exactValue = (value: number) => cache ? `${usagePercent(value)} cached input` : metric === 'errors' ? `${usagePercent(value)} errors / matched results` : `${usageNumber(value)} tool requests`;
    const label = cache ? 'Cached input share' : metric === 'errors' ? 'Tool error rate' : 'Tool requests';
    return <div className={`usage-area-trend usage-area-${metric}`}>
        <svg ref={chart.ref} className="usage-chart usage-trend-chart" viewBox={`0 0 ${chart.width} ${height}`} aria-label={unavailable ? 'Cached input share unavailable for partial history' : `${label}, ${min} to ${max}${percent ? ' percent' : ''}`} onMouseLeave={() => setHovered(null)}>
            {detail && <line x1={x(detail.date)} x2={x(detail.date)} y1={top} y2={bottom} className="usage-trend-marker"/>}
            {[0, 1 / 3, 2 / 3, 1].map(fraction => {
                const value = min + (max - min) * fraction;
                return <g key={fraction}><text x={left - 7} y={y(value) + 4} textAnchor="end" className="usage-axis">{percent ? `${Number(value.toFixed(1))}%` : usageCompact(value)}</text><line x1={left} x2={right} y1={y(value)} y2={y(value)} className="usage-trend-grid"/></g>;
            })}
            {!unavailable && segments.map((items, i) => {
                const path = items.map((point, index) => `${index ? 'L' : 'M'}${x(point.date)},${y(point.value!)}`).join(' ');
                return <g key={i}>{metric !== 'errors' && <path d={`${path} L${x(items.at(-1)!.date)},${bottom} L${x(items[0]!.date)},${bottom} Z`} className="usage-area-fill"/>}<path d={path} className="usage-area-line"/></g>;
            })}
            {!unavailable && valid.map((point, i) => <g key={point.date} tabIndex={shown === point.date || !valid.some(p => p.date === shown) && i === 0 ? 0 : -1} role="button" aria-pressed={selected === point.date} aria-label={`${usageBucketLabel(summary, point.date)}: ${exactValue(point.value!)}${partial ? ', partial history' : ''}`}
                onMouseEnter={() => setHovered(point.date)} onFocus={() => setHovered(point.date)} onBlur={() => setHovered(null)}
                onClick={() => { onSelect(point.date); }} onKeyDown={event => {
                    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(point.date); }
                    else if (event.key === 'Escape') setHovered(null);
                    else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); event.currentTarget.ownerSVGElement?.querySelectorAll<SVGGElement>('[role="button"]')[Math.max(0, Math.min(valid.length - 1, i + (event.key === 'ArrowRight' ? 1 : -1)))]?.focus(); }
                }}>
                <title>{`${usageBucketLabel(summary, point.date)}: ${exactValue(point.value!)}`}</title>
                <circle cx={x(point.date)} cy={y(point.value!)} r={shown === point.date ? 4.6 : i === valid.length - 1 ? 3.4 : 2.6} className="usage-area-point"/>
                <rect x={Math.max(left - 8, i ? (x(valid[i - 1]!.date) + x(point.date)) / 2 : left - 8)} y={top} width={Math.max(8, (i < valid.length - 1 ? (x(point.date) + x(valid[i + 1]!.date)) / 2 : right + 8) - (i ? (x(valid[i - 1]!.date) + x(point.date)) / 2 : left - 8))} height={bottom - top} fill="transparent"/>
            </g>)}
            {ticks.map((date, i) => <text key={date} x={x(date)} y={height - 3} textAnchor={i === 0 ? 'start' : i === ticks.length - 1 ? 'end' : 'middle'} className="usage-axis">{usageChartDate(date, includeYear)}</text>)}
            {hovered && detail && !unavailable && <g className="usage-chart-tooltip" pointerEvents="none" aria-hidden="true" transform={`translate(${Math.max(0, Math.min(chart.width - 250, x(detail.date) - 125))},${top})`}>
                <rect width="250" height="50" rx="7"/><text x="12" y="20" className="usage-tooltip-title">{usageBucketLabel(summary, detail.date)}</text><text x="12" y="39">{exactValue(detail.value!)}</text>
            </g>}

        </svg>
        {unavailable ? <p className="usage-note">Cache share is unavailable while history is partial.</p> : !valid.length && metric === 'errors' ? <p className="usage-note">No matched tool results in this period.</p> : <div className="usage-trend-readout usage-visually-hidden" role="status">{detail && <><strong>{usageBucketLabel(summary, detail.date)}</strong><span>{exactValue(detail.value!)}</span></>}</div>}
        {usageBucketDays(summary) > 1 && <p className="usage-note">{usageBucketDays(summary)}-day {cache ? 'input shares' : metric === 'errors' ? 'error rates' : 'totals'}</p>}
    </div>;
}
