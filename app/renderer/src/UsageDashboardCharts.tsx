import { useId, useState } from 'react';
import type { UsageRangeSummary } from '../../shared/usageDashboard.js';
import { useUsageChartWidth, usageCacheBounds, usageCacheWrites, usageNumber, usagePercent, usageShare, usageTotal } from './usageDashboardState.js';
import { formatTokens } from './statsState.js';
export function UsageDailyColumns({ summary, colors, selected, onSelect, partial }: {
    summary: UsageRangeSummary;
    colors: Record<string, string>;
    selected: string;
    onSelect: (date: string) => void;
    partial: boolean;
}) {
    const max = Math.max(1, ...summary.days.map(d => usageTotal(d.tokens)));
    const chart = useUsageChartWidth();
    const width = chart.width - 56, height = 120, step = width / summary.days.length;
    const labels = new Set([0, Math.floor(summary.days.length / 2), summary.days.length - 1]);
    return <svg className="usage-chart" ref={chart.ref} viewBox={`0 0 ${chart.width} 170`} aria-label="Daily recorded tokens by model">
  {[0, 0.5, 1].map(fraction => <g key={fraction}><text x="36" y={144 - fraction * height + 4} textAnchor="end" className="usage-axis">{formatTokens(max * fraction)}</text><line x1="44" y1={144 - fraction * height} x2={chart.width - 12} y2={144 - fraction * height} className="usage-grid-line"/></g>)}
  {summary.days.map((day, i) => {
            let y = 144;
            return <g key={day.date} role="button" tabIndex={0} aria-pressed={selected === day.date} aria-label={`${day.date}: ${usageNumber(usageTotal(day.tokens))} recorded tokens${partial ? ', partial history' : ''}`} onMouseEnter={() => onSelect(day.date)} onClick={() => onSelect(day.date)} onFocus={() => onSelect(day.date)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onSelect(day.date);
            } if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
                event.preventDefault();
                const next = summary.days[Math.max(0, Math.min(summary.days.length - 1, i + (event.key === 'ArrowRight' ? 1 : -1)))];
                if (next)
                    { onSelect(next.date); (event.currentTarget.ownerSVGElement?.querySelectorAll<SVGGElement>('[role="button"]')[summary.days.indexOf(next)])?.focus(); }
            } }}>
    <rect x={44 + i * step} y="24" width={step} height="120" fill="transparent" className={selected === day.date ? 'usage-selected' : ''}/>
    {summary.models.map(model => { const value = day.models.find(m => m.id === model.id)?.total ?? 0; const h = value / max * height; y -= h; return <rect key={model.id} x={46 + i * step} y={y} width={Math.max(1, step - 4)} height={h} fill={colors[model.id]}/>; })}
    {usageTotal(day.tokens) === 0 && partial && <text x={44 + i * step + step / 2} y="136" textAnchor="middle" className="usage-axis">?</text>}
    {labels.has(i) && <text x={44 + i * step + step / 2} y="165" textAnchor="middle" className="usage-axis">{day.date.slice(5)}</text>}
   </g>;
        })}
 </svg>;
}
export function UsageModelDonut({ summary, colors }: {
    summary: UsageRangeSummary;
    colors: Record<string, string>;
}) {
    const [highlighted, setHighlighted] = useState('');
    const all = usageTotal(summary.tokens);
    const active = summary.models.find(m => m.id === highlighted);
    let offset = 0;
    return <div className="usage-model-mix">
      <svg className="usage-model-donut" viewBox="0 0 160 160" role="img" aria-label={`Model mix: ${usageNumber(all)} recorded tokens`}>
        <circle cx="80" cy="80" r="60" fill="none" strokeWidth="20" className="usage-donut-track"/>
        {summary.models.map(model => {
            const count = usageTotal(model.tokens), percent = all ? count / all * 100 : 0;
            const start = offset;
            offset += percent;
            return percent > 0 && <circle key={model.id} className={highlighted && highlighted !== model.id ? 'usage-model-muted' : ''} cx="80" cy="80" r="60" fill="none" stroke={colors[model.id]} strokeWidth="20" pathLength="100" strokeDasharray={`${percent} ${100 - percent}`} strokeDashoffset={-start} transform="rotate(-90 80 80)"><title>{`${model.label}: ${usageNumber(count)} tokens, ${percent.toFixed(2)}%`}</title></circle>;
        })}
        <text x="80" y="78" textAnchor="middle" className="usage-donut-total">{formatTokens(active ? usageTotal(active.tokens) : all)}</text>
        <text x="80" y="96" textAnchor="middle" className="usage-donut-label">tokens</text>
      </svg>
      <ul className="usage-model-key">{summary.models.map(model => {
          const count = usageTotal(model.tokens), percent = all ? count / all * 100 : 0;
          return <li key={model.id} className={highlighted && highlighted !== model.id ? 'usage-model-muted' : ''}><button type="button" aria-pressed={highlighted === model.id} onClick={() => setHighlighted(highlighted === model.id ? '' : model.id)}><svg width="8" height="8" aria-hidden="true"><rect width="8" height="8" rx="2" fill={colors[model.id]}/></svg><div><span>{model.label}</span><span className="usage-model-value">{formatTokens(count)} · {percent.toFixed(2)}%</span></div></button></li>;
      })}</ul>
    </div>;
}
export function UsageToolBars({ summary }: {
    summary: UsageRangeSummary;
}) {
    const max = Math.max(1, ...summary.tools.map(t => t.requests));
    return <div className="usage-tool-list">{summary.tools.map(tool => <div className="usage-tool-row" key={tool.id}><span>{tool.label}</span><svg preserveAspectRatio="none" className="usage-bar" viewBox="0 0 100 5" role="img" aria-label={`${tool.label}: ${usageNumber(tool.requests)} recorded requests`}><rect width="100" height="5" className="usage-track"/><rect width={tool.requests / max * 100} height="5" className="usage-accent"/></svg><span className="usage-tool-count">{usageNumber(tool.requests)}</span></div>)}</div>;
}
export function UsageCacheChart({ summary, partial, selected = '', onSelect = () => {} }: {
    selected?: string;
    onSelect?: (date: string) => void;
    summary: UsageRangeSummary;
    partial: boolean;
}) {
    const shares = summary.days.map(d => usageShare(d.tokens));
    const chart = useUsageChartWidth();
    const areaId = useId();
    const plotWidth = chart.width - 68;
    const { min, max } = usageCacheBounds(partial ? [] : shares);
    const yFor = (share: number) => 90 - (share - min) / (max - min) * 80;
    const segments: { x: number; y: number }[][] = [];
    let segment: { x: number; y: number }[] = [];
    shares.forEach((share, i) => {
        if (share === null) { if (segment.length) segments.push(segment); segment = []; }
        else segment.push({ x: 56 + i * plotWidth / Math.max(1, shares.length - 1), y: yFor(share) });
    });
    if (segment.length) segments.push(segment);
    return <><svg className="usage-chart usage-cache-chart" ref={chart.ref} viewBox={`0 0 ${chart.width} 115`} aria-label={partial ? 'Daily cached input share unavailable for partial history' : `Daily cached input share, ${min} to ${max} percent`}>
  <defs><linearGradient id={areaId} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#8970ff" stopOpacity="0.32"/><stop offset="100%" stopColor="#8970ff" stopOpacity="0.02"/></linearGradient></defs>
  {!partial && segments.filter(points => points.length > 1).map((points, i) => <path key={i} d={`M${points[0]!.x},90 ${points.map(p => `L${p.x},${p.y}`).join(' ')} L${points.at(-1)!.x},90 Z`} fill={`url(#${areaId})`}/>)}
  {[0, 0.25, 0.5, 0.75, 1].map(fraction => <line key={fraction} x1={56 + fraction * plotWidth} x2={56 + fraction * plotWidth} y1="10" y2="90" className="usage-cache-grid"/>)}
  {[max, (min + max) / 2, min].map(value => <g key={value}><text x="0" y={yFor(value) + 4} className="usage-axis">{value}%</text><line x1="56" x2={chart.width - 12} y1={yFor(value)} y2={yFor(value)} className="usage-cache-grid"/></g>)}
  {!partial && shares.map((share, i) => { if (share === null)
        return null; const x = 56 + i * plotWidth / Math.max(1, shares.length - 1), y = yFor(share); const prev = shares[i - 1]; return <g key={summary.days[i]!.date} role="button" tabIndex={0} aria-pressed={selected === summary.days[i]!.date} aria-label={`${summary.days[i]!.date}: ${usagePercent(share)} cached input`} onMouseEnter={() => onSelect(summary.days[i]!.date)} onFocus={() => onSelect(summary.days[i]!.date)} onClick={() => onSelect(summary.days[i]!.date)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(summary.days[i]!.date); } }}>{i > 0 && prev !== null && prev !== undefined && <line x1={56 + (i - 1) * plotWidth / (shares.length - 1)} y1={yFor(prev)} x2={x} y2={y} className="usage-trend"/>}<circle cx={x} cy={y} r={selected === summary.days[i]!.date ? 5 : 3} className="usage-cache-point"/><circle cx={x} cy={y} r="10" fill="transparent"/></g>; })}
  <text x="56" y="112" className="usage-axis">{summary.days[0]!.date.slice(5)}</text><text x={chart.width - 12} y="112" textAnchor="end" className="usage-axis">{summary.days.at(-1)!.date.slice(5)}</text>
 </svg>{partial && <p className="usage-note">Cache share is unavailable while history is partial.</p>}
 {!partial && selected && <div className="usage-interaction-readout" role="status"><strong>{selected}</strong><span>{usagePercent(usageShare(summary.days.find(d => d.date === selected)?.tokens ?? summary.tokens))} cached input</span></div>}
 <div className="usage-cache-spectrum" aria-hidden="true"/>
 <dl className="usage-cache-values"><div><dt>Fresh input</dt><dd>{usageNumber(summary.tokens.fresh)}</dd></div><div><dt>Cache reads</dt><dd>{usageNumber(summary.tokens.read)}</dd></div><div><dt>Cache writes</dt><dd>{usageCacheWrites(summary.tokens.write, summary.cacheWriteReporting)}</dd></div></dl></>;
}
export function UsageActivityRows({ summary, selected, onSelect, partial }: {
    summary: UsageRangeSummary;
    selected: string;
    onSelect: (date: string) => void;
    partial: boolean;
}) {
    return <>{(['sessions', 'requests'] as const).map(key => {
            const max = Math.max(1, ...summary.days.map(d => d[key]));
            return <div className="usage-activity-row" key={key}><div><span>{key === 'sessions' ? 'Active sessions' : 'Tool requests'}</span><small>0–{usageNumber(max)}</small></div><svg preserveAspectRatio="none" viewBox="0 0 600 72" aria-label={`${key === 'sessions' ? 'Active sessions' : 'Tool requests'}, separate scale from 0 to ${max}`}>
   {summary.days.map((d, i) => <g key={d.date} tabIndex={0} role="button" aria-pressed={selected === d.date} aria-label={`${d.date}: ${d[key]} ${key}${partial ? ', partial history' : ''}`} onFocus={() => onSelect(d.date)} onClick={() => onSelect(d.date)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onSelect(d.date);
            } }}><rect x={i * 600 / summary.days.length} y="0" width={600 / summary.days.length} height="60" fill="transparent"/><rect x={i * 600 / summary.days.length + 2} y={55 - d[key] / max * 50} width={Math.max(1, 600 / summary.days.length - 4)} height={d[key] / max * 50} className="usage-accent"/></g>)}
  </svg></div>;
        })}</>;
}
