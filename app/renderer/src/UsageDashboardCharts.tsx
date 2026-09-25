import { useId, useState } from 'react';
import { usageAxisCeiling, usageChartDate, usageChartTicks, usageFlowSeries, type UsageFlowMode } from './usageGraphState.js';
import { UsageAreaTrend } from './UsageAreaTrend.js';
import { usageBucketDays, usageBucketLabel, usageDatePosition } from './usageTrendState.js';
import type { UsageRangeSummary } from '../../shared/usageDashboard.js';
import { isRetiredUsageModel } from '../../shared/usageModelStatus.js';
import { useUsageChartWidth, usageCompact, usageNumber, usageTotal } from './usageDashboardState.js';
import { usageFlowSamples, usageStackedAreaGeometry } from './usageStackedAreaState.js';
export function UsageTokenFlow({ summary, colors, selected, onSelect }: {
    summary: UsageRangeSummary;
    colors: Record<string, string>;
    selected: string;
    onSelect: (date: string) => void;
    partial: boolean;
}) {
    const [mode, setMode] = useState<UsageFlowMode>('type');
    const [showAllModels, setShowAllModels] = useState(false);
    const [hiddenSeries, setHiddenSeries] = useState<Record<UsageFlowMode, string[]>>({ type: [], model: [] });
    const [hovered, setHovered] = useState('');
    const [focusedDate, setFocusedDate] = useState('');
    const clipId = `usage-flow-${useId().replaceAll(':', '')}`;
    const hasRetiredModels = summary.models.some(isRetiredUsageModel);
    const scopeLabel = mode === 'model' && hasRetiredModels ? showAllModels ? 'all models' : 'current models' : mode;
    const modelSummary = mode === 'model' && hasRetiredModels && !showAllModels
        ? { ...summary, models: summary.models.filter(model => !isRetiredUsageModel(model)) }
        : summary;
    const availableSeries = usageFlowSeries(modelSummary, colors, mode);
    const hidden = new Set(hiddenSeries[mode]);
    const series = usageFlowSeries(modelSummary, colors, mode, hidden);
    const toggleSeries = (id: string) => setHiddenSeries(current => {
        const next = new Set(current[mode]);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return { ...current, [mode]: [...next] };
    });
    const shownTotal = (day: UsageRangeSummary['days'][number]) => series.reduce((sum, item) => sum + item.value(day), 0);
    const detail = summary.days.find(day => day.date === hovered);
    const max = usageAxisCeiling(Math.max(1, ...summary.days.map(shownTotal)));
    const chart = useUsageChartWidth();
    const narrow = chart.width < 560, left = 46, right = chart.width - 8;
    const height = narrow ? 250 : 300, bottom = height - 34, top = 10, plotHeight = bottom - top;
    const width = right - left;
    const firstDay = Date.parse(`${summary.startDate}T00:00:00.000Z`);
    const span = Math.max(1, (Date.parse(`${summary.endDateExclusive}T00:00:00.000Z`) - firstDay) / 86400000);
    const bucketDays = usageBucketDays(summary);
    const step = width * bucketDays / span;
    const slotX = (date: string) => left + (Date.parse(`${date}T00:00:00.000Z`) - firstDay) / 86400000 / span * width;
    const slotWidth = (date: string) => Math.min(step, right - slotX(date));
    const slotCenter = (date: string) => slotX(date) + slotWidth(date) / 2;
    const ticks = usageChartTicks(summary.startDate, summary.endDateExclusive, width)
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
    const thinSeries = series.map(item => {
        const projectedPeak = Math.max(0, ...summary.days.map(day => item.value(day))) / max * plotHeight;
        return projectedPeak > 0 && projectedPeak < 1;
    });
    let hoverCumulative = 0;
    const hoverPoints = detail ? series.flatMap(item => {
        const value = item.value(detail);
        hoverCumulative += value;
        return value > 0 ? [{ id: item.id, label: item.label, color: item.color, value, y: bottom - hoverCumulative / max * plotHeight }] : [];
    }) : [];
    const tooltipWidth = 190, tooltipHeight = 28 + hoverPoints.length * 18;
    const hoverX = detail ? slotCenter(detail.date) : 0;
    const tooltipX = Math.max(0, Math.min(chart.width - tooltipWidth, hoverX > chart.width / 2 ? hoverX - tooltipWidth - 14 : hoverX + 14));
    const tooltipY = Math.max(top, Math.min(bottom - tooltipHeight, (hoverPoints.length ? Math.min(...hoverPoints.map(point => point.y)) : top) - 18));
    return <>
    <div className="usage-flow-toolbar"><div className="usage-flow-heading"><h2 className="usage-panel-heading">Tokens</h2></div>
      <div className="usage-flow-controls"><div className="usage-range" role="group" aria-label="Stack tokens by">{(['type', 'model'] as const).map(value => <button key={value} type="button" aria-pressed={mode === value} onClick={() => setMode(value)}>By {value}</button>)}</div>{mode === 'model' && hasRetiredModels && <div className="usage-range" role="group" aria-label="Model history"><button type="button" aria-pressed={!showAllModels} onClick={() => setShowAllModels(false)}>Current</button><button type="button" aria-pressed={showAllModels} onClick={() => setShowAllModels(true)}>All models</button></div>}</div>
    </div>
    <svg className="usage-chart usage-flow-chart" shapeRendering="geometricPrecision" onMouseLeave={() => setHovered('')} ref={chart.ref} viewBox={`0 0 ${chart.width} ${height}`} aria-label={`${bucketDays > 1 ? `${bucketDays}-day` : 'Daily'} recorded tokens by ${scopeLabel}${hidden.size ? `, ${hidden.size} hidden` : ''}`}>
        <defs><clipPath id={clipId}><rect x={left} y={top} width={width} height={plotHeight}/></clipPath></defs>
        {[0, 1 / 3, 2 / 3, 1].map(fraction => <g key={fraction}><line x1={left} y1={bottom - fraction * plotHeight} x2={right} y2={bottom - fraction * plotHeight} className="usage-flow-grid-line"/><text x={left - 8} y={bottom - fraction * plotHeight + 4} textAnchor="end" className="usage-axis">{usageCompact(Math.round(max * fraction))}</text></g>)}
        {selected && summary.days.some(day => day.date === selected) && <rect x={slotX(selected)} y={top} width={slotWidth(selected)} height={plotHeight} className="usage-selected" aria-hidden="true"/>}
        <g clipPath={`url(#${clipId})`} className="usage-flow-areas" aria-hidden="true">
            {geometry.paths.map((path, index) => <path key={series[index]!.id} className="usage-flow-area" fill={series[index]!.color} d={path}/>)}
            {geometry.centerPaths.flatMap((paths, index) => thinSeries[index] ? paths.map((path, part) => <path key={`${series[index]!.id}:${part}`} className="usage-flow-thin-series" fill="none" stroke={series[index]!.color} strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" d={path}/>) : [])}
        </g>
        {summary.days.map((day, i) => {
            return <g key={day.date} className="usage-flow-hit" role="button" tabIndex={focusedDate === day.date || (!focusedDate && (selected === day.date || (!selected && i === 0))) ? 0 : -1} aria-pressed={selected === day.date} onMouseEnter={() => setHovered(day.date)} onFocus={() => { setFocusedDate(day.date); setHovered(day.date); }} onBlur={() => setHovered('')} aria-label={`${usageBucketLabel(summary, day.date)}: ${usageNumber(shownTotal(day))} recorded tokens${mode === 'model' && hasRetiredModels && !showAllModels ? ' from current models' : ''}`} onClick={() => onSelect(day.date)} onKeyDown={event => {
                if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(day.date); }
                else if (event.key === 'Escape') { setHovered(''); onSelect(''); }
                else if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
                    event.preventDefault();
                    const next = Math.max(0, Math.min(summary.days.length - 1, i + (event.key === 'ArrowRight' ? 1 : -1)));
                    setFocusedDate(summary.days[next]!.date);
                    event.currentTarget.ownerSVGElement?.querySelectorAll<SVGGElement>('[role="button"]')[next]?.focus();
                }
            }}>
                <rect className="usage-flow-hit-target" x={slotX(day.date)} y={top} width={slotWidth(day.date)} height={plotHeight + 8} fill="transparent"/>
                {selected === day.date && <rect x={slotX(day.date)} y={bottom + 4} width={slotWidth(day.date)} height={3} rx={1.5} className="usage-selection-underline" aria-hidden="true"/>}
            </g>;
        })}
        {detail && hoverPoints.length > 0 && <g className="usage-flow-hover-markers" pointerEvents="none" aria-hidden="true">
            {hoverPoints.map(point => <circle key={point.id} cx={hoverX} cy={point.y} r="5.5" fill={point.color} className="usage-flow-hover-point"/>)}
        </g>}
        {ticks.map((date, index) => <text key={date} x={left + usageDatePosition(summary, date) * width} y={height - 9} textAnchor={index === 0 ? 'start' : index === ticks.length - 1 ? 'end' : 'middle'} className="usage-axis">{usageChartDate(date, span > 365)}</text>)}
        {detail && <g className="usage-chart-tooltip usage-flow-tooltip" pointerEvents="none" aria-hidden="true" transform={`translate(${tooltipX},${tooltipY})`}>
            <rect width={tooltipWidth} height={tooltipHeight} rx="8"/>
            <text x="10" y="17" className="usage-tooltip-title">{usageBucketLabel(summary, detail.date)}</text>
            {hoverPoints.map((point, index) => <g key={point.id} className="usage-flow-tooltip-row">
                <circle cx="10" cy={33 + index * 18} r="2.5" fill={point.color}/>
                <text x="18" y={37 + index * 18}>{point.label}</text>
                <text x={tooltipWidth - 10} y={37 + index * 18} textAnchor="end" className="usage-flow-tooltip-value">{usageCompact(point.value)}</text>
            </g>)}
        </g>}
    </svg>
    {mode === 'model' && !showAllModels && hasRetiredModels && availableSeries.length === 0 && <p className="usage-note">No current model usage in this period.</p>}
    <div className="usage-legend usage-flow-legend" aria-label="Token flow series">{availableSeries.map(item => {
        const shown = !hidden.has(item.id);
        return <button key={item.id} className="usage-flow-series-toggle" type="button" aria-pressed={shown} aria-label={`${shown ? 'Hide' : 'Show'} ${item.label}`} onClick={() => toggleSeries(item.id)}>
            <svg className="usage-flow-series-dot" width="10" height="10" aria-hidden="true"><circle cx="5" cy="5" r="5" fill={item.color}/></svg>
            <span>{item.label}</span><b>{usageCompact(item.total)}</b>
            <svg className="usage-flow-series-eye" viewBox="0 0 20 20" aria-hidden="true"><path d="M2.5 10s2.7-4 7.5-4 7.5 4 7.5 4-2.7 4-7.5 4-7.5-4-7.5-4Z"/><circle cx="10" cy="10" r="2"/>{!shown && <path d="m3 3 14 14"/>}</svg>
        </button>;
    })}</div>
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
