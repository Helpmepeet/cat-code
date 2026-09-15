import { useState } from 'react';
import type { UsageRangeSummary } from '../../shared/usageDashboard.js';
import { useUsageChartWidth, usageNumber, usagePercent } from './usageDashboardState.js';

export function UsageHeatmap({ summary, asOf, onSelect, partial }: {
    summary: UsageRangeSummary; asOf: string; onSelect: (date: string) => void; partial: boolean;
}) {
    const [active, setActive] = useState(0);
    const [hovered, setHovered] = useState<number | null>(null);
    const [pinned, setPinned] = useState<number | null>(null);
    const columns = summary.days.length;
    const max = Math.max(1, ...summary.days.flatMap(d => d.hourlyRequests));
    const compact = columns <= 7;
    const chart = useUsageChartWidth();
    const left = compact ? 48 : 36, top = 8;
    const width = compact ? Math.max(384, chart.width) : left + columns * 13 + 10;
    const step = compact ? Math.min(20, Math.floor((width - left - 8) / 24)) : 13;
    const size = step - 3, height = (compact ? columns : 24) * step + 38;
    const xFor = (col: number, hour: number) => left + (compact ? hour : col) * step;
    const yFor = (col: number, hour: number) => top + (compact ? col : hour) * step;
    const shown = hovered ?? pinned;
    const cell = shown === null ? null : { day: summary.days[shown % columns]!, hour: Math.floor(shown / columns) };
    const isFuture = (date: string, hour: number) => Date.parse(`${date}T${String(hour).padStart(2, '0')}:00:00.000Z`) > Date.parse(asOf);
    const labels = new Set(columns <= 7 ? [0, columns - 1] : [0, Math.floor(columns / 3), Math.floor(columns * 2 / 3), columns - 1]);
    return <>
        <div className="usage-chart-toolbar"><span>Tool requests · UTC</span><div className="usage-heat-key" aria-label="Intensity from fewer to more requests"><span>Less</span>{[0,1,2,3,4].map(n => <i key={n} className={`usage-heat-${n}`}/>)}<span>More</span></div></div>
        <div className="usage-heat-scroll">
        <svg ref={chart.ref} className={`usage-heatmap${compact ? ' usage-heatmap-week' : ''}`} width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-label="Hourly tool requests by day, UTC" onMouseLeave={() => setHovered(null)}>
            {compact ? summary.days.map((day, col) => <text key={day.date} x="0" y={yFor(col, 0) + size / 2 + 4} className="usage-axis">{day.date.slice(5)}</text>) : [0,6,12,18,23].map(hour => <text key={hour} x="0" y={top + hour * step + 9} className="usage-axis">{String(hour).padStart(2, '0')}</text>)}
            {Array.from({ length: 24 }, (_, hour) => summary.days.map((day, col) => {
                const index = hour * columns + col, value = day.hourlyRequests[hour]!;
                const future = isFuture(day.date, hour);
                const level = value === 0 ? 0 : Math.min(4, Math.max(1, Math.ceil(value / max * 4)));
                const label = `${day.date} ${String(hour).padStart(2, '0')}:00 UTC: ${future ? 'not yet recorded' : `${usageNumber(value)} tool requests${partial ? ', partial history' : ''}`}`;
                return <g key={index} role="button" tabIndex={active === index ? 0 : -1} aria-label={label} aria-pressed={pinned === index}
                    onMouseEnter={() => setHovered(index)} onFocus={() => { setActive(index); setHovered(index); }} onBlur={() => setHovered(null)}
                    onClick={() => { setPinned(pinned === index ? null : index); onSelect(day.date); }}
                    onKeyDown={event => {
                        const offsets: Record<string, number> = compact ? { ArrowLeft: -columns, ArrowRight: columns, ArrowUp: -1, ArrowDown: 1 } : { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns, ArrowDown: columns };
                        if (event.key in offsets) {
                            event.preventDefault();
                            const next = Math.max(0, Math.min(columns * 24 - 1, index + offsets[event.key]!));
                            setActive(next);
                            const nodes = event.currentTarget.ownerSVGElement?.querySelectorAll<SVGGElement>('[role="button"]');
                            nodes?.[next]?.focus();
                        } else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setPinned(index); onSelect(day.date); }
                        else if (event.key === 'Escape') { setPinned(null); setHovered(null); }
                    }}>
                    <rect x={xFor(col, hour)} y={yFor(col, hour)} width={size} height={size} rx="1.5" className={`${future ? 'usage-heat-future' : `usage-heat-${level}`} ${shown === index ? 'usage-heat-selected' : ''}`}/>
                </g>;
            }))}
            {cell && shown !== null && <g className="usage-heat-tooltip" aria-hidden="true" pointerEvents="none" transform={`translate(${Math.min(width - 190, xFor(shown % columns, cell.hour) + 12)},${yFor(shown % columns, cell.hour) > height - 70 ? yFor(shown % columns, cell.hour) - 54 : yFor(shown % columns, cell.hour) + size + 6})`}>
                <rect width="180" height="48" rx="6"/><text x="10" y="18">{cell.day.date} · {String(cell.hour).padStart(2, '0')}:00</text><text x="10" y="36">{isFuture(cell.day.date, cell.hour) ? 'Not yet recorded' : `${usageNumber(cell.day.hourlyRequests[cell.hour]!)} tool requests`}</text>
            </g>}
            {compact && [0,6,12,18,23].map(hour => <text key={hour} x={xFor(0, hour)} y={height - 8} className="usage-axis">{String(hour).padStart(2, '0')}</text>)}
            {!compact && summary.days.map((day, col) => labels.has(col) && <text key={day.date} x={left + col * step + (col === columns - 1 ? size : 0)} y={height - 8} textAnchor={col === columns - 1 ? 'end' : 'start'} className="usage-axis">{day.date.slice(5)}</text>)}
        </svg></div>
        <div className="usage-interaction-readout" role="status">{cell ? <><strong>{cell.day.date} · {String(cell.hour).padStart(2, '0')}:00 UTC</strong><span>{isFuture(cell.day.date, cell.hour) ? 'Not yet recorded' : `${usageNumber(cell.day.hourlyRequests[cell.hour]!)} tool requests`}</span></> : <span>Hover to inspect · Click to keep · Arrow keys to explore</span>}</div>
    </>;
}

export function UsageToolErrors({ summary }: { summary: UsageRangeSummary }) {
    const [mode, setMode] = useState<'count' | 'rate'>('count');
    const [selected, setSelected] = useState('');
    const rate = (tool: UsageRangeSummary['tools'][number]) => tool.results ? tool.errors / tool.results * 100 : 0;
    const tools = [...summary.tools].sort((a, b) => (mode === 'count' ? b.errors - a.errors : rate(b) - rate(a)) || b.results - a.results || a.id.localeCompare(b.id));
    const max = mode === 'count' ? Math.max(1, ...tools.map(t => t.errors)) : 100;
    const detail = tools.find(t => t.id === selected);
    return <>
        <div className="usage-chart-toolbar"><span>Errors / recorded results</span><div className="usage-range" role="group" aria-label="Tool error measure">{(['count', 'rate'] as const).map(m => <button type="button" key={m} aria-pressed={mode === m} onClick={() => setMode(m)}>{m === 'count' ? 'Count' : 'Rate'}</button>)}</div></div>
        {!tools.some(t => t.results) && <p className="usage-note">No matched tool results in this period.</p>}
        <div className="usage-error-list">{tools.map(tool => <button type="button" className="usage-error-row" key={tool.id} aria-pressed={selected === tool.id} onClick={() => setSelected(selected === tool.id ? '' : tool.id)}>
            <span>{tool.label}</span><svg className="usage-error-bar" viewBox="0 0 100 8" preserveAspectRatio="none" aria-hidden="true"><rect width="100" height="8" rx="2" className="usage-track"/><rect width={(mode === 'count' ? tool.errors : rate(tool)) / max * 100} height="8" rx="2" className="usage-error-fill"/></svg>
            <span className="usage-tool-count">{usageNumber(tool.errors)} / {usageNumber(tool.results)}</span><span className="usage-tool-count">{tool.results ? usagePercent(rate(tool)) : 'N/A'}</span>
        </button>)}</div>
        <div className="usage-interaction-readout" role="status">{detail ? <><strong>{detail.label}</strong><span>{usageNumber(detail.results - detail.errors)} successful · {usageNumber(detail.errors)} errors · {usageNumber(detail.requests - detail.results)} without a matched result</span></> : <span>Click a tool for its result breakdown</span>}</div>
    </>;
}
