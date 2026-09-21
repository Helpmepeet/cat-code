import { useId, useState } from 'react';
import { usageAxisCeiling, usageChartDate, usageChartTicks, usageFlowSeries, type UsageFlowMode } from './usageGraphState.js';
import { UsageAreaTrend } from './UsageAreaTrend.js';
import { usageBucketDays, usageBucketLabel, usageDatePosition } from './usageTrendState.js';
import type { UsageRangeSummary } from '../../shared/usageDashboard.js';
import { useUsageChartWidth, usageCompact, usageNumber, usageTotal } from './usageDashboardState.js';
import { usageFlowSamples, usageStackedAreaGeometry } from './usageStackedAreaState.js';
export function UsageTokenFlow({ summary, colors, selected, onSelect, partial }: {
    summary: UsageRangeSummary;
    colors: Record<string, string>;
    selected: string;
    onSelect: (date: string) => void;
    partial: boolean;
}) {
    const [mode, setMode] = useState<UsageFlowMode>('type');
    const [hideReads, setHideReads] = useState(false);
    const [hovered, setHovered] = useState('');
    const clipId = `usage-flow-${useId().replaceAll(':', '')}`;
    const series = usageFlowSeries(summary, colors, mode, hideReads);
    const shownTotal = (day: UsageRangeSummary['days'][number]) => series.reduce((sum, item) => sum + item.value(day), 0);
    const detail = summary.days.find(day => day.date === hovered);
    const max = usageAxisCeiling(Math.max(1, ...summary.days.map(shownTotal)));
    const chart = useUsageChartWidth();
    const narrow = chart.width < 560, left = 0, right = chart.width;
    const height = narrow ? 250 : 300, bottom = height - 34, top = 10, plotHeight = bottom - top;
    const width = right - left;
    const span = Math.max(1, (Date.parse(summary.endExclusive) - Date.parse(summary.startInclusive)) / 86400000);
    const bucketDays = usageBucketDays(summary);
    const step = width * bucketDays / span;
    const slotX = (date: string) => left + (Date.parse(`${date}T00:00:00.000Z`) - Date.parse(summary.startInclusive)) / 86400000 / span * width;
    const slotWidth = (date: string) => Math.min(step, right - slotX(date));
    const slotCenter = (date: string) => slotX(date) + slotWidth(date) / 2;
    const ticks = usageChartTicks(summary.startInclusive, summary.endExclusive, width)
        .filter((_, index, all) => all.length <= (narrow ? 4 : 6) || index % Math.ceil(all.length / (narrow ? 4 : 6)) === 0 || index === all.length - 1);
    const samples = usageFlowSamples(summary, series);
    const areaSamples = samples.map(sample => ({ x: slotCenter(sample.date), values: sample.values }));
    const firstValues = areaSamples[0]?.values ?? series.map(() => 0);
    const lastValues = areaSamples.at(-1)?.values ?? firstValues;
    const geometry = usageStackedAreaGeometry([
        { x: left, values: firstValues },
        ...areaSamples,
        { x: right, values: lastValues },
    ], max, top, bottom);
    const displayedTotal = series.reduce((sum, item) => sum + item.total, 0);
    const tooltipHeight = 32 + series.length * 20 + (hideReads && mode === 'type' ? 20 : 0);
    return <>
    <div className="usage-flow-toolbar"><div className="usage-flow-heading"><h2 className="usage-panel-heading">Token flow</h2><div><strong>{usageNumber(displayedTotal)}</strong><span>tokens</span></div>{hideReads && mode === 'type' && <small>Excluding cache reads</small>}</div>
      <div className="usage-flow-controls"><button className="usage-toggle" type="button" disabled={mode === 'model'} aria-pressed={hideReads && mode === 'type'} onClick={() => setHideReads(!hideReads)}>Hide cache reads</button><div className="usage-range" role="group" aria-label="Stack tokens by">{(['type', 'model'] as const).map(value => <button key={value} type="button" aria-pressed={mode === value} onClick={() => setMode(value)}>By {value}</button>)}</div></div>
    </div>
    <svg className="usage-chart usage-flow-chart" onMouseLeave={() => setHovered('')} ref={chart.ref} viewBox={`0 0 ${chart.width} ${height}`} aria-label={`${bucketDays > 1 ? `${bucketDays}-day` : 'Daily'} recorded tokens by ${mode}${hideReads && mode === 'type' ? ', excluding cache reads' : ''}`}>
        <defs><clipPath id={clipId}><rect x={left} y={top} width={width} height={plotHeight}/></clipPath></defs>
        {[0, 1 / 3, 2 / 3, 1].map(fraction => <line key={fraction} x1={left} y1={bottom - fraction * plotHeight} x2={right} y2={bottom - fraction * plotHeight} className="usage-flow-grid-line"/>)}
        <g clipPath={`url(#${clipId})`} className="usage-flow-areas" aria-hidden="true">{geometry.paths.map((path, index) => <path key={series[index]!.id} className="usage-flow-area" fill={series[index]!.color} d={path}/>)}</g>
        {summary.days.map((day, i) => {
            return <g key={day.date} className="usage-flow-hit" role="button" tabIndex={0} aria-pressed={selected === day.date} onMouseEnter={() => setHovered(day.date)} onFocus={() => setHovered(day.date)} onBlur={() => setHovered('')} aria-label={`${usageBucketLabel(summary, day.date)}: ${usageNumber(shownTotal(day))} recorded tokens${partial ? ', partial history' : ''}`} onClick={() => onSelect(day.date)} onKeyDown={event => {
                if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(day.date); }
                else if (event.key === 'Escape') setHovered('');
                else if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
                    event.preventDefault();
                    const next = Math.max(0, Math.min(summary.days.length - 1, i + (event.key === 'ArrowRight' ? 1 : -1)));
                    onSelect(summary.days[next]!.date);
                    event.currentTarget.ownerSVGElement?.querySelectorAll<SVGGElement>('[role="button"]')[next]?.focus();
                }
            }}>
                {selected === day.date && <><rect x={slotX(day.date)} y={top} width={slotWidth(day.date)} height={plotHeight} className="usage-flow-selected"/><line x1={slotCenter(day.date)} x2={slotCenter(day.date)} y1={top} y2={bottom} className="usage-flow-selection-line"/></>}
                {usageTotal(day.tokens) === 0 && partial && <text x={slotCenter(day.date)} y={bottom - 8} textAnchor="middle" className="usage-axis">?</text>}
                <rect className="usage-flow-hit-target" x={slotX(day.date)} y={top} width={slotWidth(day.date)} height={plotHeight + 8} fill="transparent"/>
            </g>;
        })}
        {ticks.map((date, index) => <text key={date} x={left + usageDatePosition(summary, date) * width} y={height - 9} textAnchor={index === 0 ? 'start' : index === ticks.length - 1 ? 'end' : 'middle'} className="usage-axis">{usageChartDate(date, span > 365)}</text>)}
        {detail && <g className="usage-chart-tooltip" pointerEvents="none" aria-hidden="true" transform={`translate(${Math.max(0, Math.min(chart.width - 230, slotCenter(detail.date) + 10))},${top + 6})`}>
            <rect width="230" height={tooltipHeight} rx="7"/>
            <text x="12" y="20" className="usage-tooltip-title">{usageBucketLabel(summary, detail.date)}</text>
            {series.map((item, i) => <g key={item.id}><text x="12" y={42 + i * 20}>{item.label}</text><text x="218" y={42 + i * 20} textAnchor="end">{usageCompact(item.value(detail))}</text></g>)}
            {hideReads && mode === 'type' && <text x="12" y={42 + series.length * 20}>Total incl. cache: {usageCompact(usageTotal(detail.tokens))}</text>}
        </g>}
    </svg>
    <div className="usage-legend usage-flow-legend" aria-label="Token flow legend">{series.map(item => <span key={item.id}><svg width="10" height="10" aria-hidden="true"><circle cx="5" cy="5" r="5" fill={item.color}/></svg><span>{item.label}</span><b>{usageCompact(item.total)}</b></span>)}</div>
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
