import { useId, useState } from 'react';
import type { UsageRangeSummary } from '../../shared/usageDashboard.js';
import { usageBucketDays, usageBucketLabel, usageDatePosition, usageTrendPoints } from './usageTrendState.js';
import { useUsageChartWidth, usageCacheBounds, usageCompact, usageNumber, usagePercent } from './usageDashboardState.js';

export function UsageAreaTrend({ summary, metric, partial, selected = '', onSelect = () => {} }: {
    summary: UsageRangeSummary;
    metric: 'cache' | 'requests' | 'errors';
    partial: boolean;
    selected?: string;
    onSelect?: (date: string) => void;
}) {
    const [hovered, setHovered] = useState<string | null>(null);
    const chart = useUsageChartWidth(), fillId = useId();
    const cache = metric === 'cache', percent = metric !== 'requests';
    const points = usageTrendPoints(summary, metric);
    const valid = points.filter(point => point.value !== null);
    const unavailable = cache && partial;
    const peak = Math.max(1, ...valid.map(point => point.value!));
    const unit = 10 ** Math.floor(Math.log10(peak));
    const { min, max } = cache ? usageCacheBounds(unavailable ? [] : points.map(point => point.value)) : { min: 0, max: Math.ceil(peak / unit) * unit };
    const x = (date: string) => 56 + usageDatePosition(summary, date) * (chart.width - 70);
    const y = (value: number) => 110 - (value - min) / (max - min) * 90;
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
        <svg ref={chart.ref} className="usage-chart usage-trend-chart" viewBox={`0 0 ${chart.width} 138`} aria-label={unavailable ? 'Cached input share unavailable for partial history' : `${label}, ${min} to ${max}${percent ? ' percent' : ''}`} onMouseLeave={() => setHovered(null)}>
            <defs><linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="currentColor" stopOpacity="0.3"/><stop offset="100%" stopColor="currentColor" stopOpacity="0.02"/></linearGradient></defs>
            {detail && <line x1={x(detail.date)} x2={x(detail.date)} y1="20" y2="110" className="usage-trend-marker"/>}
            {[max, (min + max) / 2, min].map(value => <g key={value}><text x="42" y={y(value) + 4} textAnchor="end" className="usage-axis">{percent ? `${Number(value.toFixed(1))}%` : usageCompact(value)}</text><line x1="56" x2={chart.width - 14} y1={y(value)} y2={y(value)} className="usage-trend-grid"/></g>)}
            {!unavailable && segments.map((items, i) => {
                const path = items.map((point, index) => `${index ? 'L' : 'M'}${x(point.date)},${y(point.value!)}`).join(' ');
                return <g key={i}>{metric !== 'errors' && <path d={`${path} L${x(items.at(-1)!.date)},110 L${x(items[0]!.date)},110 Z`} fill={`url(#${fillId})`}/>}<path d={path} className="usage-area-line"/></g>;
            })}
            {!unavailable && valid.map((point, i) => <g key={point.date} tabIndex={shown === point.date || !valid.some(p => p.date === shown) && i === 0 ? 0 : -1} role="button" aria-pressed={selected === point.date} aria-label={`${usageBucketLabel(summary, point.date)}: ${exactValue(point.value!)}${partial ? ', partial history' : ''}`}
                onMouseEnter={() => setHovered(point.date)} onFocus={() => setHovered(point.date)} onBlur={() => setHovered(null)}
                onClick={() => { onSelect(point.date); }} onKeyDown={event => {
                    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(point.date); }
                    else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); event.currentTarget.ownerSVGElement?.querySelectorAll<SVGGElement>('[role="button"]')[Math.max(0, Math.min(valid.length - 1, i + (event.key === 'ArrowRight' ? 1 : -1)))]?.focus(); }
                }}>
                <title>{`${usageBucketLabel(summary, point.date)}: ${exactValue(point.value!)}`}</title>
                <circle cx={x(point.date)} cy={y(point.value!)} r={shown === point.date ? 4 : 2.5} className="usage-area-point"/>
                <circle cx={x(point.date)} cy={y(point.value!)} r="9" fill="transparent"/>
            </g>)}
            <text x="56" y="134" className="usage-axis">{summary.startInclusive.slice(summary.range === 'all' ? 0 : 5, 10)}</text><text x={chart.width - 14} y="134" textAnchor="end" className="usage-axis">{new Date(Date.parse(summary.endExclusive) - 86400000).toISOString().slice(summary.range === 'all' ? 0 : 5, 10)}</text>
        </svg>
        {unavailable ? <p className="usage-note">Cache share is unavailable while history is partial.</p> : !valid.length && metric === 'errors' ? <p className="usage-note">No matched tool results in this period.</p> : <div className="usage-trend-readout" role="status">{detail && <><strong>{usageBucketLabel(summary, detail.date)}</strong><span>{exactValue(detail.value!)}</span></>}</div>}
        {usageBucketDays(summary) > 1 && <p className="usage-note">{usageBucketDays(summary)}-day {cache ? 'input shares' : metric === 'errors' ? 'error rates' : 'totals'}</p>}
    </div>;
}
