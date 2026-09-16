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
    const peak = Math.max(1, ...summary.days.map(d => usageTotal(d.tokens)));
    const unit = 10 ** Math.floor(Math.log10(peak));
    const max = Math.ceil(peak / unit) * unit;
    const chart = useUsageChartWidth();
    const width = chart.width - 56, height = 120;
    const span = (Date.parse(summary.endExclusive) - Date.parse(summary.startInclusive)) / 86400000;
    const step = width * usageBucketDays(summary) / Math.max(1, span);
    const dayX = (date: string) => 44 + (Date.parse(`${date}T00:00:00.000Z`) - Date.parse(summary.startInclusive)) / 86400000 / Math.max(1, span) * width;
    return <svg className="usage-chart" ref={chart.ref} viewBox={`0 0 ${chart.width} 170`} aria-label={usageBucketDays(summary) > 1 ? `${usageBucketDays(summary)}-day recorded tokens by model` : "Daily recorded tokens by model"}>
  {[0, 0.5, 1].map(fraction => <g key={fraction}><text x="36" y={144 - fraction * height + 4} textAnchor="end" className="usage-axis">{usageCompact(max * fraction)}</text><line x1="44" y1={144 - fraction * height} x2={chart.width - 12} y2={144 - fraction * height} className="usage-grid-line"/></g>)}
  {summary.days.map((day, i) => {
            let y = 144;
            const barWidth = Math.min(step, chart.width - 12 - dayX(day.date));
            return <g key={day.date} role="button" tabIndex={0} aria-pressed={selected === day.date} aria-label={`${usageBucketLabel(summary, day.date)}: ${usageNumber(usageTotal(day.tokens))} recorded tokens${partial ? ', partial history' : ''}`} onClick={() => onSelect(day.date)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onSelect(day.date);
            } if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
                event.preventDefault();
                const next = summary.days[Math.max(0, Math.min(summary.days.length - 1, i + (event.key === 'ArrowRight' ? 1 : -1)))];
                if (next)
                    { onSelect(next.date); (event.currentTarget.ownerSVGElement?.querySelectorAll<SVGGElement>('[role="button"]')[summary.days.indexOf(next)])?.focus(); }
            } }}>
    <title>{`${usageBucketLabel(summary, day.date)}: ${usageCompact(usageTotal(day.tokens))} tokens`}</title>
    <rect x={dayX(day.date)} y="24" width={barWidth} height="120" fill="transparent" className={selected === day.date ? 'usage-selected' : ''}/>
    {summary.models.map(model => { const value = day.models.find(m => m.id === model.id)?.total ?? 0; const h = value / max * height; y -= h; return <rect key={model.id} x={dayX(day.date) + Math.min(2, barWidth / 5)} y={y} width={Math.max(0.1, barWidth - Math.min(4, barWidth / 3))} height={h} fill={colors[model.id]}/>; })}
    {usageTotal(day.tokens) === 0 && partial && <text x={dayX(day.date) + barWidth / 2} y="136" textAnchor="middle" className="usage-axis">?</text>}
   </g>;
        })}
  <text x="44" y="165" className="usage-axis">{summary.startInclusive.slice(summary.range === 'all' ? 0 : 5, 10)}</text>
  <text x={chart.width - 12} y="165" textAnchor="end" className="usage-axis">{new Date(Date.parse(summary.endExclusive) - 86400000).toISOString().slice(summary.range === 'all' ? 0 : 5, 10)}</text>
 </svg>;
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
