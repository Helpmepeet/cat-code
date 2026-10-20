import { Fragment, useEffect, useRef, useState } from 'react';
import type { UsageRangeSummary, UsageRankedSession } from '../../shared/usageDashboard.js';
import { resolveSessionOpenRoute, type MergedSessionRow } from './sessionsCatalogState.js';
import { usageCompact, usageNumber, usagePercent, usageTotal } from './usageDashboardState.js';
import { analyticsModelFamily, usageAnalyticsToolColor } from './usageAnalyticsDetailsState.js';
import { analyticsCalendarTickIndices, analyticsDateLabel, analyticsMonotone, analyticsNearestIndex, analyticsScale, integrationSeries, rankedSessions, sessionColumns, sessionDailySeries, sessionErrorMedian, sessionFigures, sessionLabel, sessionLastActive, sessionSourceSegments, sessionSpan, sessionSpend, type AnalyticsPoint, type SessionSortKey } from './usageAnalyticsSessionsState.js';
import './usageAnalyticsSessions.css';

function AnalyticsLines({ points, labels, label, height = 220, weekly = false, calendar = false, otherIndex = -1 }: { points: AnalyticsPoint[]; labels: string[]; label: string; height?: number; weekly?: boolean; calendar?: boolean; otherIndex?: number }) {
    const box = useRef<HTMLDivElement>(null);
    const [width, setWidth] = useState(500);
    const [hover, setHover] = useState<number | null>(null);
    useEffect(() => {
        if (!box.current || typeof ResizeObserver === 'undefined') return;
        const observer = new ResizeObserver(([entry]) => { if (entry && entry.contentRect.width > 0) setWidth(entry.contentRect.width); });
        observer.observe(box.current);
        return () => observer.disconnect();
    }, []);
    const scale = analyticsScale(Math.max(1, ...points.flatMap(point => point.values)));
    const left = Math.max(30, usageCompact(scale.top).length * 7 + 12), right = Math.max(left + 1, width - 8), bottom = height - 26;
    const x = (index: number) => {
        if (points.length === 1) return (left + right) / 2;
        const fraction = calendar && points.length > 1
            ? (Date.parse(points[index]!.date) - Date.parse(points[0]!.date)) / (Date.parse(points.at(-1)!.date) - Date.parse(points[0]!.date))
            : index / Math.max(1, points.length - 1);
        return left + fraction * (right - left);
    };
    const y = (value: number) => bottom - value / scale.top * (bottom - 12);
    const active = hover === null ? null : points[hover];
    const tooltipWidth = Math.min(250, Math.max(170, width - 16));
    const values = active ? labels.map((name, index) => ({ name, index, value: active.values[index] ?? 0 })).sort((a, b) => b.value - a.value) : [];
    const colorClass = (index: number) => `uas-color-${index === otherIndex ? 4 : index}`;
    const tickCount = Math.min(points.length, Math.max(2, Math.floor((right - left) / 65)));
    const tickIndices = calendar
        ? analyticsCalendarTickIndices(points.map((_, i) => x(i)), points.map(point => analyticsDateLabel(point.date).length * 6.5))
        : new Set(Array.from({ length: tickCount }, (_, i) => Math.round(i * (points.length - 1) / Math.max(1, tickCount - 1))));
    return <div className="uas-chart" ref={box}><svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label}>
        {scale.ticks.map(value => <g key={value}><line className={value ? 'uas-grid' : 'uas-axis'} x1={left} x2={right} y1={y(value)} y2={y(value)} /><text x={left - 8} y={y(value)} dy=".32em" textAnchor="end">{usageCompact(value)}</text></g>)}
        {labels.map((name, index) => <path key={name} className={`uas-line ${colorClass(index)}`} d={analyticsMonotone(points.map((point, i) => ({ x: x(i), y: y(point.values[index] ?? 0) })))} />)}
        {points.map((point, index) => tickIndices.has(index) ? <text className="uas-x-axis-label" key={point.date} x={x(index)} y={height - 6} textAnchor={index === 0 ? 'start' : index === points.length - 1 ? 'end' : 'middle'}>{analyticsDateLabel(point.date)}</text> : null)}
        {active && hover !== null && <g className="uas-crosshair"><line x1={x(hover)} x2={x(hover)} y1="12" y2={bottom} />{active.values.map((value, index) => <circle key={index} className={`uas-dot ${colorClass(index)}`} cx={x(hover)} cy={y(value)} r="3.5" />)}</g>}
        <rect className="uas-pick" x={left} y="12" width={right - left} height={bottom - 12} fill="transparent" tabIndex={0} role="group" aria-label={label} onMouseMove={event => {
            const bounds = event.currentTarget.ownerSVGElement!.getBoundingClientRect();
            const pointer = bounds.width ? (event.clientX - bounds.left) / bounds.width * width : event.clientX;
            setHover(calendar ? points.reduce((nearest, _, index) => Math.abs(x(index) - pointer) < Math.abs(x(nearest) - pointer) ? index : nearest, 0) : analyticsNearestIndex(pointer, left, right, points.length));
        }} onMouseLeave={() => setHover(null)} onFocus={() => setHover(0)} onBlur={() => setHover(null)} onKeyDown={event => {
            if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); setHover(current => Math.max(0, Math.min(points.length - 1, (current ?? 0) + (event.key === 'ArrowRight' ? 1 : -1)))); }
            if (event.key === 'Escape') setHover(null);
        }} />
        {active && hover !== null && <foreignObject className="uas-tip-position" x={Math.max(4, Math.min(width - tooltipWidth - 4, x(hover) + 12))} y="18" width={tooltipWidth} height={Math.min(height - 20, 45 + values.length * 21)}><div className="uas-tip" role="status"><strong>{weekly ? 'Week of ' : ''}{analyticsDateLabel(active.date)}</strong>{values.map(value => <div key={value.name}><span className={`uas-swatch ${colorClass(value.index)}`} /><span>{value.name}</span><b>{usageNumber(value.value)}</b></div>)}</div></foreignObject>}
    </svg></div>;
}
function Swatch({ className, color }: { className?: string; color?: string }) {
    return <svg className={`uas-key ${className ?? ''}`} viewBox="0 0 8 8" width="8" height="8" aria-hidden="true"><circle cx="4" cy="4" r="4" fill={color ?? 'currentColor'} /></svg>;
}
function SessionDetail({ item, summary, row, onOpenSession }: { item: UsageRankedSession; summary: UsageRangeSummary; row: MergedSessionRow | null; onOpenSession?: (row: MergedSessionRow) => void }) {
    const points = sessionDailySeries(item, summary);
    const total = usageTotal(item.tokens);
    const [sourceHover, setSourceHover] = useState<string | null>(null);
    const sourceBar = useRef<SVGSVGElement>(null);
    const [sourceWidth, setSourceWidth] = useState(200);
    useEffect(() => {
        if (!sourceBar.current || typeof ResizeObserver === 'undefined') return;
        const observer = new ResizeObserver(([entry]) => { if (entry && entry.contentRect.width > 0) setSourceWidth(entry.contentRect.width); });
        observer.observe(sourceBar.current);
        return () => observer.disconnect();
    }, []);
    return <div className="uas-detail">
        <div><h4>Tokens per day</h4>{item.dailyDetail === 'unavailable' ? <p>Daily session detail is unavailable for this range.</p> : points.length === 1 ? <p className="uas-single">{usageCompact(points[0]!.values[0]!)} on {analyticsDateLabel(points[0]!.date)}</p> : points.length ? <AnalyticsLines points={points} labels={['Tokens']} label="Session tokens per day" height={120} /> : <p>No daily tokens recorded.</p>}</div>
        <div className="uas-source-panel"><h4>Spent by</h4><svg ref={sourceBar} className="uas-composition" viewBox={`0 0 ${sourceWidth} 10`} preserveAspectRatio="none" role="img" aria-label="Token source shares">{sessionSourceSegments(item, sourceWidth).map(({ source, x, width }) => <rect key={source} className={`uas-source-${source}${sourceHover && sourceHover !== source ? ' uas-dim' : ''}`} x={x} y="0" width={width} height="10" tabIndex={0} onMouseEnter={() => setSourceHover(source)} onMouseLeave={() => setSourceHover(null)} onFocus={() => setSourceHover(source)} onBlur={() => setSourceHover(null)} aria-label={`${source}: ${usageCompact(usageTotal(item.tokenSources[source]))}`} />)}</svg>
            {sourceHover && <div className="uas-tip uas-source-tip" role="status">{sourceHover === 'chat' ? 'Chat' : sourceHover === 'subagents' ? 'Subagents' : 'Compaction'} · {usageCompact(usageTotal(item.tokenSources[sourceHover as keyof typeof item.tokenSources]))} · {usagePercent(total ? usageTotal(item.tokenSources[sourceHover as keyof typeof item.tokenSources]) / total * 100 : null)}</div>}
            <ul className="uas-composition-list">{(['chat', 'subagents', 'compaction'] as const).filter(source => usageTotal(item.tokenSources[source]) > 0).map(source => <li key={source} className={sourceHover && sourceHover !== source ? 'uas-dim' : undefined}><Swatch className={`uas-source-key-${source}`} /><span>{source === 'chat' ? 'Chat' : source === 'subagents' ? 'Subagents' : 'Compaction'}</span><strong>{usageCompact(usageTotal(item.tokenSources[source]))}</strong><span>{usagePercent(total ? usageTotal(item.tokenSources[source]) / total * 100 : null)}</span></li>)}</ul>
            <h4 className="uas-price-heading">Spend estimate</h4><p>{sessionSpend(item)}</p>{(item.tokenCost?.pricedTokens ?? 0) < total && <p className="uas-note">{usageNumber(item.tokenCost?.pricedTokens ?? 0)} of {usageNumber(total)} tokens priced</p>}
        </div>
        <div><h4>Models</h4><ul className="uas-composition-list">{item.models.map(model => <li key={model.id}><Swatch className={`uas-family-${analyticsModelFamily(model.label)}`} /><span>{model.label}</span><strong>{usageCompact(usageTotal(model.tokens))}</strong><span>{usagePercent(total ? usageTotal(model.tokens) / total * 100 : null)}</span></li>)}</ul></div>
        <div><h4>Tools</h4>{item.tools.length ? <div className="uas-tools">{[...item.tools].sort((a, b) => b.requests - a.requests || a.id.localeCompare(b.id)).map(tool => <div className="uas-tool" key={tool.id}><span><Swatch color={usageAnalyticsToolColor(tool.label)} />{tool.label}</span><span>{usageNumber(tool.requests)}</span><span className={tool.errors ? 'uas-error' : ''}>{tool.errors ? `${usageNumber(tool.errors)} failed` : '—'}</span></div>)}</div> : <p>No tool calls recorded.</p>}
            {row && onOpenSession && resolveSessionOpenRoute(row).kind !== 'none' && <button type="button" className="uas-open" onClick={() => onOpenSession(row)}>Open session</button>}
        </div>
    </div>;
}
export function UsageAnalyticsSessions({ summary, sessionRows = [], onOpenSession, timezone = 'UTC' }: { summary: UsageRangeSummary; sessionRows?: readonly MergedSessionRow[]; onOpenSession?: (row: MergedSessionRow) => void; timezone?: string }) {
    const [sort, setSort] = useState<SessionSortKey>('tokens');
    const [ascending, setAscending] = useState(false);
    const [expanded, setExpanded] = useState<string[]>([]);
    const figures = sessionFigures(summary);
    const items = rankedSessions(summary, sort, ascending, sessionRows);
    const median = sessionErrorMedian(items);
    const maxErrors = Math.max(1, ...items.map(item => item.errors));
    const toggle = (id: string) => setExpanded(current => current.includes(id) ? current.filter(value => value !== id) : [...current, id]);
    const sortBy = (key: SessionSortKey, toggleDirection: boolean) => { setSort(key); setAscending(toggleDirection && sort === key ? !ascending : key === 'session'); };
    return <section className="uas" aria-label="Sessions"><h2>Sessions</h2><div className="uas-card">
        <header><h3>Top sessions</h3><div className="uas-switch" role="group" aria-label="Rank sessions by">{(['tokens', 'errors'] as const).map(key => <button type="button" key={key} aria-pressed={sort === key} onClick={() => sortBy(key, false)}>{key === 'tokens' ? 'By tokens' : 'By tool errors'}</button>)}</div></header>
        <dl className="uas-figures">{[['Top 10 share of tokens', usagePercent(figures.top10)], ['Spent by subagents', usagePercent(figures.subagents)], ['Spent on compaction', usagePercent(figures.compaction)], ['Tokens per session, median', figures.median === null ? 'Unavailable' : usageCompact(figures.median)]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
        <div className="uas-table-scroll"><table className="uas-sessions"><thead><tr>{sessionColumns.map(column => <th key={column.key} scope="col" className={column.secondary ? 'uas-secondary' : undefined} aria-sort={sort === column.key ? ascending ? 'ascending' : 'descending' : 'none'}><button type="button" onClick={() => sortBy(column.key, true)}>{column.label}</button></th>)}</tr></thead>
            <tbody>{items.map(item => {
                const { row, label } = sessionLabel(item, sessionRows);
                const open = expanded.includes(`${summary.range}:${item.id}`);
                const total = usageTotal(item.tokens);
                const model = [...item.models].sort((a, b) => usageTotal(b.tokens) - usageTotal(a.tokens))[0];
                const span = sessionSpan(item);
                const hot = median !== null && item.results > 0 && item.errors / item.results > median * 1.5 && item.errors >= 10;
                return <Fragment key={item.id}>
                    <tr className="uas-session-row" tabIndex={0} aria-expanded={open} onClick={() => toggle(`${summary.range}:${item.id}`)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle(`${summary.range}:${item.id}`); } }}>
                        <th scope="row"><span className="uas-title" title={label}>{label}</span><small className="uas-meta">{model && <><Swatch className={`uas-family-${analyticsModelFamily(model.label)}`} />{model.label}<span>·</span></>}{item.project?.label}{item.engineSessionId && <><span>·</span><span className="uas-mono">{item.engineSessionId.slice(0, 8)}</span></>}</small></th>
                        <td><span className="uas-session-number">{usageCompact(total)}</span><svg className="uas-meter" viewBox="0 0 100 3" aria-hidden="true"><rect width={total / Math.max(...items.map(value => usageTotal(value.tokens)), 1) * 100} height="3" /></svg></td>
                        <td className="uas-secondary">{total ? `${Math.round(usageTotal(item.tokenSources.subagents) / total * 100)}%` : '—'}</td>
                        <td className="uas-secondary">{usageNumber(item.requests)}</td>
                        <td><span className="uas-session-number">{usageNumber(item.errors)}</span><svg className="uas-meter uas-error-meter" viewBox="0 0 100 3" aria-hidden="true"><rect width={item.errors / maxErrors * 100} height="3" /></svg></td>
                        <td><span className={hot ? 'uas-flag' : undefined}>{usagePercent(item.results ? item.errors / item.results * 100 : null)}</span></td>
                        <td className="uas-secondary"><time dateTime={item.lastActiveAt} title={item.lastActiveAt}>{sessionLastActive(item.lastActiveAt, timezone)}</time>{span && <small>{span}</small>}</td>
                    </tr>
                    {open && <tr className="uas-detail-row"><td colSpan={7}><SessionDetail item={item} summary={summary} row={row} onOpenSession={onOpenSession} /></td></tr>}
                </Fragment>;
            })}</tbody></table></div>
        {!items.length && <p className="uas-note">{summary.rankedSessions.omitted > 0 ? 'Ranked session detail is unavailable for this range.' : 'No contributing sessions recorded.'}</p>}
        {summary.rankedSessions.state === 'truncated' && items.length > 0 && <p className="uas-note">Top {usageNumber(items.length)} of {usageNumber(items.length + summary.rankedSessions.omitted)} sessions</p>}
    </div></section>;
}
export function UsageAnalyticsIntegrations({ summary }: { summary: UsageRangeSummary }) {
    return <section className="uas" aria-label="Skills and integrations"><h2>Skills &amp; integrations</h2><div className="uas-integrations">{(['skills', 'integrations'] as const).map(kind => {
        const data = integrationSeries(summary, kind);
        const title = kind === 'skills' ? 'Skills used' : 'Integrations called';
        return <div className="uas-card" key={kind}><header className="uas-integration-header"><div className="uas-eyebrow">{title}</div><div className="uas-big">{usageNumber(data.total)}</div>{summary.range === '30d' && <p className="uas-note">Weekly totals</p>}</header>
            {data.series.length ? <><AnalyticsLines points={data.points} labels={data.series.map(series => series.label)} label={title} weekly={summary.range === '30d'} calendar={summary.range === 'all'} otherIndex={data.series.findIndex(series => series.id === '__other')} /><ul className="uas-legend">{data.series.map((series, index) => <li key={series.id}><span className={`uas-swatch uas-color-${series.id === '__other' ? 4 : index}`} />{series.label}</li>)}</ul></> : <p className="uas-note">No {kind === 'skills' ? 'skill uses' : 'integration calls'} recorded.</p>}</div>;
    })}</div></section>;
}
