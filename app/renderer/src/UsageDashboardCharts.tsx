import { useState } from 'react';
import { usageFlowSeries, type UsageFlowMode } from './usageGraphState.js';
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
    const detail = summary.days.find(day => day.date === (hovered || selected));
    const peak = Math.max(1, ...summary.days.map(shownTotal));
    const unit = 10 ** Math.floor(Math.log10(peak));
    const max = Math.ceil(peak / unit) * unit;
    const chart = useUsageChartWidth();
    const width = chart.width - 56, height = 160;
    const span = (Date.parse(summary.endExclusive) - Date.parse(summary.startInclusive)) / 86400000;
    const step = width * usageBucketDays(summary) / Math.max(1, span);
    const dayX = (date: string) => 44 + (Date.parse(`${date}T00:00:00.000Z`) - Date.parse(summary.startInclusive)) / 86400000 / Math.max(1, span) * width;
    return <>
    <div className="usage-flow-toolbar"><div className="usage-legend" aria-label="Token flow legend">{series.map(item => <span key={item.id}><svg width="9" height="9" aria-hidden="true"><rect width="9" height="9" rx="2" fill={item.color}/></svg>{item.label}<b>{usageCompact(item.total)}</b></span>)}</div>
      <div className="usage-flow-controls"><button className="usage-toggle" type="button" disabled={mode === 'model'} aria-pressed={hideReads && mode === 'type'} onClick={() => setHideReads(!hideReads)}>Hide cache reads</button><div className="usage-range" role="group" aria-label="Stack tokens by">{(['type', 'model'] as const).map(value => <button key={value} type="button" aria-pressed={mode === value} onClick={() => setMode(value)}>By {value}</button>)}</div></div>
    </div>
    <svg className="usage-chart usage-flow-chart" onMouseLeave={() => setHovered('')} ref={chart.ref} viewBox={`0 0 ${chart.width} 210`} aria-label={`${usageBucketDays(summary) > 1 ? `${usageBucketDays(summary)}-day` : 'Daily'} recorded tokens by ${mode}${hideReads && mode === 'type' ? ', excluding cache reads' : ''}`}>
  {[0, 0.5, 1].map(fraction => <g key={fraction}><text x="36" y={184 - fraction * height + 4} textAnchor="end" className="usage-axis">{usageCompact(max * fraction)}</text><line x1="44" y1={184 - fraction * height} x2={chart.width - 12} y2={184 - fraction * height} className="usage-grid-line"/></g>)}
  {summary.days.map((day, i) => {
            let y = 184;
            const barWidth = Math.min(step, chart.width - 12 - dayX(day.date));
            return <g key={day.date} role="button" tabIndex={0} aria-pressed={selected === day.date} onMouseEnter={() => setHovered(day.date)} onFocus={() => setHovered(day.date)} onBlur={() => setHovered('')} aria-label={`${usageBucketLabel(summary, day.date)}: ${usageNumber(shownTotal(day))} recorded tokens${partial ? ', partial history' : ''}`} onClick={() => onSelect(day.date)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onSelect(day.date);
            } if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
                event.preventDefault();
                const next = summary.days[Math.max(0, Math.min(summary.days.length - 1, i + (event.key === 'ArrowRight' ? 1 : -1)))];
                if (next)
                    { onSelect(next.date); (event.currentTarget.ownerSVGElement?.querySelectorAll<SVGGElement>('[role="button"]')[summary.days.indexOf(next)])?.focus(); }
            } }}>
    <title>{`${usageBucketLabel(summary, day.date)}: ${usageCompact(shownTotal(day))} tokens`}</title>
    <rect x={dayX(day.date)} y="24" width={barWidth} height="160" fill="transparent" className={selected === day.date ? 'usage-selected' : ''}/>
    {series.map(model => { const value = model.value(day); const h = value / max * height; y -= h; return <rect key={model.id} x={dayX(day.date) + Math.min(2, barWidth / 5)} y={y} width={Math.max(0.1, barWidth - Math.min(4, barWidth / 3))} height={h} fill={model.color}/>; })}
    {usageTotal(day.tokens) === 0 && partial && <text x={dayX(day.date) + barWidth / 2} y="136" textAnchor="middle" className="usage-axis">?</text>}
   </g>;
        })}
  <text x="44" y="205" className="usage-axis">{summary.startInclusive.slice(summary.range === 'all' ? 0 : 5, 10)}</text>
  <text x={chart.width - 12} y="205" textAnchor="end" className="usage-axis">{new Date(Date.parse(summary.endExclusive) - 86400000).toISOString().slice(summary.range === 'all' ? 0 : 5, 10)}</text>
 </svg>
 <div className="usage-flow-readout" role="status">{detail && <><strong>{usageBucketLabel(summary, detail.date)}</strong>{series.map(item => <span key={item.id}>{item.label} <b>{usageCompact(item.value(detail))}</b></span>)}{detail && hideReads && mode === 'type' && <span>Total including cache <b>{usageCompact(usageTotal(detail.tokens))}</b></span>}</>}</div>
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
