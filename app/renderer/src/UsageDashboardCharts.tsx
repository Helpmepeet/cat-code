import { useState } from 'react';
import { usageAxisCeiling, usageChartDate, usageChartTicks, usageFlowSeries, type UsageFlowMode } from './usageGraphState.js';
import { UsageAreaTrend } from './UsageAreaTrend.js';
import { usageBucketDays, usageBucketLabel } from './usageTrendState.js';
import type { UsageRangeSummary } from '../../shared/usageDashboard.js';
import { useUsageChartWidth, usageCompact, usageNumber, usageTotal } from './usageDashboardState.js';
export function UsageDailyColumns({ summary, colors, selected, onSelect, partial }: {
    summary: UsageRangeSummary;
    colors: Record<string, string>;
    selected: string;
    onSelect: (date: string) => void;
    partial: boolean;
}) {
    const [mode, setMode] = useState<UsageFlowMode>('type');
    const [hideReads, setHideReads] = useState(false);
    const [hovered, setHovered] = useState('');
    const series = usageFlowSeries(summary, colors, mode, hideReads);
    const shownTotal = (day: UsageRangeSummary['days'][number]) => series.reduce((sum, item) => sum + item.value(day), 0);
    const detail = summary.days.find(day => day.date === hovered);
    const max = usageAxisCeiling(Math.max(1, ...summary.days.map(shownTotal)));
    const chart = useUsageChartWidth();
    const narrow = chart.width < 560, left = narrow ? 44 : 56, right = chart.width - 6;
    const height = narrow ? 230 : 300, bottom = height - 34, top = 10, plotHeight = bottom - top;
    const width = right - left;
    const span = Math.max(1, (Date.parse(summary.endExclusive) - Date.parse(summary.startInclusive)) / 86400000);
    const bucketDays = usageBucketDays(summary);
    const step = width * bucketDays / span;
    const slotX = (date: string) => left + (Date.parse(`${date}T00:00:00.000Z`) - Date.parse(summary.startInclusive)) / 86400000 / span * width;
    const slotWidth = (date: string) => Math.min(step, right - slotX(date));
    const barWidth = Math.min(narrow ? 18 : 34, step * 0.68);
    const barX = (date: string) => slotX(date) + (slotWidth(date) - barWidth) / 2;
    const ticks = usageChartTicks(summary.startInclusive, summary.endExclusive, width);
    const tooltipHeight = 32 + series.length * 20 + (hideReads && mode === 'type' ? 20 : 0);
    return <>
    <div className="usage-flow-toolbar"><h2 className="usage-panel-heading">Token flow</h2>
      <div className="usage-flow-controls"><button className="usage-toggle" type="button" disabled={mode === 'model'} aria-pressed={hideReads && mode === 'type'} onClick={() => setHideReads(!hideReads)}>Hide cache reads</button><div className="usage-range" role="group" aria-label="Stack tokens by">{(['type', 'model'] as const).map(value => <button key={value} type="button" aria-pressed={mode === value} onClick={() => setMode(value)}>By {value}</button>)}</div></div>
    </div>
    <div className="usage-legend usage-flow-legend" aria-label="Token flow legend">{series.map(item => <span key={item.id}><svg width="9" height="9" aria-hidden="true"><rect width="9" height="9" rx="2" fill={item.color}/></svg>{item.label}<b>{usageCompact(item.total)}</b></span>)}</div>
    <svg className="usage-chart usage-flow-chart" onMouseLeave={() => setHovered('')} ref={chart.ref} viewBox={`0 0 ${chart.width} ${height}`} aria-label={`${bucketDays > 1 ? `${bucketDays}-day` : 'Daily'} recorded tokens by ${mode}${hideReads && mode === 'type' ? ', excluding cache reads' : ''}`}>
        {[0, 0.25, 0.5, 0.75, 1].map(fraction => <g key={fraction}><text x={left - 10} y={bottom - fraction * plotHeight + 4} textAnchor="end" className="usage-axis">{usageCompact(max * fraction)}</text><line x1={left} y1={bottom - fraction * plotHeight} x2={right} y2={bottom - fraction * plotHeight} className="usage-grid-line"/></g>)}
        {summary.days.map((day, i) => {
            let y = bottom;
            const visible = series.filter(item => item.value(day) > 0);
            return <g key={day.date} role="button" tabIndex={0} aria-pressed={selected === day.date} onMouseEnter={() => setHovered(day.date)} onFocus={() => setHovered(day.date)} onBlur={() => setHovered('')} aria-label={`${usageBucketLabel(summary, day.date)}: ${usageNumber(shownTotal(day))} recorded tokens${partial ? ', partial history' : ''}`} onClick={() => onSelect(day.date)} onKeyDown={event => {
                if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(day.date); }
                else if (event.key === 'Escape') setHovered('');
                else if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
                    event.preventDefault();
                    const next = Math.max(0, Math.min(summary.days.length - 1, i + (event.key === 'ArrowRight' ? 1 : -1)));
                    onSelect(summary.days[next]!.date);
                    event.currentTarget.ownerSVGElement?.querySelectorAll<SVGGElement>('[role="button"]')[next]?.focus();
                }
            }}>
                {selected === day.date && <><rect x={barX(day.date) - 4} y={top} width={barWidth + 8} height={plotHeight + 2} rx="3" className="usage-selected"/><rect x={barX(day.date) - 2} y={bottom + 4} width={barWidth + 4} height="2" rx="1" className="usage-selection-underline"/></>}
                {visible.map((item, index) => {
                    const segmentHeight = item.value(day) / max * plotHeight;
                    y -= segmentHeight;
                    const gap = index < visible.length - 1 ? Math.min(2, segmentHeight / 3) : 0;
                    const rounded = index === visible.length - 1 ? Math.min(4, barWidth / 2, segmentHeight / 2) : 0;
                    const x = barX(day.date), h = Math.max(0.25, segmentHeight - gap);
                    return <path key={item.id} className="usage-flow-segment" fill={item.color} d={`M${x},${y + h} V${y + rounded} Q${x},${y} ${x + rounded},${y} H${x + barWidth - rounded} Q${x + barWidth},${y} ${x + barWidth},${y + rounded} V${y + h} Z`}/>;
                })}
                {!visible.length && <line x1={barX(day.date)} x2={barX(day.date) + barWidth} y1={bottom} y2={bottom} className="usage-zero-bar"/>}
                {usageTotal(day.tokens) === 0 && partial && <text x={barX(day.date) + barWidth / 2} y={bottom - 8} textAnchor="middle" className="usage-axis">?</text>}
                <rect x={slotX(day.date)} y={top} width={slotWidth(day.date)} height={plotHeight + 8} fill="transparent"/>
            </g>;
        })}
        {ticks.map(date => <text key={date} x={slotX(date) + Math.min(width / span, right - slotX(date)) / 2} y={height - 10} textAnchor="middle" className="usage-axis">{usageChartDate(date, span > 365)}</text>)}
        {detail && <g className="usage-chart-tooltip" pointerEvents="none" aria-hidden="true" transform={`translate(${Math.max(0, Math.min(chart.width - 230, barX(detail.date) + barWidth + 10))},${top + 6})`}>
            <rect width="230" height={tooltipHeight} rx="7"/>
            <text x="12" y="20" className="usage-tooltip-title">{usageBucketLabel(summary, detail.date)}</text>
            {series.map((item, i) => <g key={item.id}><text x="12" y={42 + i * 20}>{item.label}</text><text x="218" y={42 + i * 20} textAnchor="end">{usageCompact(item.value(detail))}</text></g>)}
            {hideReads && mode === 'type' && <text x="12" y={42 + series.length * 20}>Total incl. cache: {usageCompact(usageTotal(detail.tokens))}</text>}
        </g>}
    </svg>
    <div className="usage-flow-readout usage-visually-hidden" role="status">{detail && <><strong>{usageBucketLabel(summary, detail.date)}</strong>{series.map(item => <span key={item.id}>{item.label} <b>{usageCompact(item.value(detail))}</b></span>)}</>}</div>
    </>;
}
export function UsageCacheChart({ summary, partial, selected = '', onSelect = () => {} }: {
    selected?: string;
    onSelect?: (date: string) => void;
    summary: UsageRangeSummary;
    partial: boolean;
}) {
    return <UsageAreaTrend summary={summary} metric="cache" partial={partial} selected={selected} onSelect={onSelect}/>;
}
export function UsageActivityRows({ summary, selected, onSelect, partial }: {
    summary: UsageRangeSummary;
    selected: string;
    onSelect: (date: string) => void;
    partial: boolean;
}) {
    return <>{(['sessions', 'requests'] as const).map(key => {
            const max = Math.max(1, ...summary.days.map(d => d[key]));
            return <div className="usage-activity-row" key={key}><div><span>{key === 'sessions' ? 'Sessions used' : 'Tool requests'}</span><small>0–{usageNumber(max)}</small></div><svg preserveAspectRatio="none" viewBox="0 0 600 72" aria-label={`${key === 'sessions' ? 'Sessions used' : 'Tool requests'}, separate scale from 0 to ${max}`}>
   {summary.days.map((d, i) => <g key={d.date} tabIndex={0} role="button" aria-pressed={selected === d.date} aria-label={`${d.date}: ${d[key]} ${key}${partial ? ', partial history' : ''}`} onFocus={() => onSelect(d.date)} onClick={() => onSelect(d.date)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onSelect(d.date);
            } }}><rect x={i * 600 / summary.days.length} y="0" width={600 / summary.days.length} height="60" fill="transparent"/><rect x={i * 600 / summary.days.length + 2} y={55 - d[key] / max * 50} width={Math.max(1, 600 / summary.days.length - 4)} height={d[key] / max * 50} className="usage-accent"/></g>)}
  </svg></div>;
        })}</>;
}
