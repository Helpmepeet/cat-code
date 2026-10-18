import { Fragment, useState } from 'react';
import type { UsageRangeSummary, UsageRankedSession } from '../../shared/usageDashboard.js';
import { resolveSessionOpenRoute, type MergedSessionRow } from './sessionsCatalogState.js';
import { usageCompact, usageNumber, usagePercent, usageTotal } from './usageDashboardState.js';
import { analyticsLine, integrationSeries, rankedSessions, sessionColumns, sessionDailySeries, sessionFigures, sessionLabel, sessionLastActive, sessionSpend, type AnalyticsPoint, type SessionSortKey } from './usageAnalyticsSessionsState.js';
import './usageAnalyticsSessions.css';

function AnalyticsLines({ points, labels, summary, label }: { points: AnalyticsPoint[]; labels: string[]; summary: UsageRangeSummary; label: string }) {
    const [hover, setHover] = useState<string | null>(null);
    const max = Math.max(1, ...points.flatMap(point => point.values));
    const active = points.find(point => point.date === hover);
    return <div className="uas-chart"><svg viewBox="0 0 600 180" role="img" aria-label={label}>
        <line className="uas-axis" x1="32" x2="576" y1="150" y2="150" />
        <text x="4" y="22">{usageCompact(max)}</text><text x="4" y="153">0</text>
        {labels.map((name, index) => <path key={name} className={`uas-line uas-color-${index}`} d={analyticsLine(points, index, summary.startDate, summary.endDateExclusive, max)} />)}
        {points.map(point => {
            const x = Number(analyticsLine([point], 0, summary.startDate, summary.endDateExclusive, max).match(/^M([^,]+)/)?.[1] ?? 32);
            return <g key={point.date} tabIndex={0} onFocus={() => setHover(point.date)} onBlur={() => setHover(null)} onMouseEnter={() => setHover(point.date)} onMouseLeave={() => setHover(null)} aria-label={`${point.date} to ${point.endDate} exclusive: ${labels.map((name, i) => `${name} ${usageNumber(point.values[i] ?? 0)}`).join(', ')}`}>
                <rect x={x - 5} y="15" width="10" height="140" fill="transparent" />
                {point.values.map((value, index) => <circle key={index} className={`uas-dot uas-color-${index}`} cx={x} cy={150 - value / max * 130} r={points.length === 1 || active === point ? 3 : 1.5} />)}
            </g>;
        })}
        <text x="32" y="174">{summary.startDate}</text><text x="576" y="174" textAnchor="end">{points.at(-1)?.date ?? summary.startDate}</text>
    </svg><div className="uas-readout" aria-live="polite">{active ? `${active.date} to ${active.endDate} exclusive · ${labels.map((name, i) => `${name} ${usageNumber(active.values[i] ?? 0)}`).join(' · ')}` : '\u00a0'}</div></div>;
}
function SessionDetail({ item, summary, row, onOpenSession }: { item: UsageRankedSession; summary: UsageRangeSummary; row: MergedSessionRow | null; onOpenSession?: (row: MergedSessionRow) => void }) {
    const points = sessionDailySeries(item, summary);
    const total = usageTotal(item.tokens);
    return <div className="uas-detail">
        <div><h4>Tokens per day</h4>{item.dailyDetail === 'unavailable' ? <p>Daily session detail is unavailable for this range.</p> : <AnalyticsLines points={points} labels={['Tokens']} summary={summary} label="Session tokens per day" />}</div>
        <div><h4>Tokens by source</h4><svg className="uas-composition" viewBox="0 0 100 8" role="img" aria-label="Token source shares">{(['chat', 'subagents', 'compaction'] as const).map((source, i, sources) => <rect key={source} className={`uas-source-${source}`} x={total ? sources.slice(0, i).reduce((n, key) => n + usageTotal(item.tokenSources[key]), 0) / total * 100 : 0} y="0" width={total ? usageTotal(item.tokenSources[source]) / total * 100 : 0} height="8" />)}</svg>
            <dl>{(['chat', 'subagents', 'compaction'] as const).map(source => <Fragment key={source}><dt>{source === 'chat' ? 'Chat' : source === 'subagents' ? 'Subagents' : 'Compaction'}</dt><dd>{usageCompact(usageTotal(item.tokenSources[source]))}</dd></Fragment>)}</dl>
            <h4>Configured-rate subtotal</h4><p>{sessionSpend(item)}</p><p className="uas-note">{usageNumber(item.tokenCost?.pricedTokens ?? 0)} of {usageNumber(total)} tokens priced. Not a bill.</p>
        </div>
        <div><h4>Models</h4><dl>{item.models.map(model => <Fragment key={model.id}><dt>{model.label}</dt><dd>{usageCompact(usageTotal(model.tokens))}</dd></Fragment>)}</dl>{item.modelDetail.state === 'grouped' && <p className="uas-note">Includes grouped models.</p>}</div>
        <div><h4>Tools</h4>{item.tools.length ? <table><thead><tr><th>Tool</th><th>Calls</th><th>Errors</th></tr></thead><tbody>{[...item.tools].sort((a, b) => b.requests - a.requests || a.id.localeCompare(b.id)).map(tool => <tr key={tool.id}><th scope="row">{tool.label}</th><td>{usageNumber(tool.requests)}</td><td className={tool.errors ? 'uas-error' : ''}>{usageNumber(tool.errors)}</td></tr>)}</tbody></table> : <p>No tool calls recorded.</p>}
            {row && onOpenSession && resolveSessionOpenRoute(row).kind !== 'none' && <button type="button" className="uas-open" onClick={() => onOpenSession(row)}>Open session</button>}
        </div>
    </div>;
}
export function UsageAnalyticsSessions({ summary, sessionRows = [], onOpenSession, partial }: { summary: UsageRangeSummary; sessionRows?: readonly MergedSessionRow[]; onOpenSession?: (row: MergedSessionRow) => void; partial: boolean }) {
    const [sort, setSort] = useState<SessionSortKey>('tokens');
    const [ascending, setAscending] = useState(false);
    const [expanded, setExpanded] = useState<string[]>([]);
    const figures = sessionFigures(summary);
    const items = rankedSessions(summary, sort, ascending, sessionRows);
    const toggle = (id: string) => setExpanded(current => current.includes(id) ? current.filter(value => value !== id) : [...current, id]);
    const sortBy = (key: SessionSortKey, toggleDirection: boolean) => { setSort(key); setAscending(toggleDirection && sort === key ? !ascending : key === 'session'); };
    return <section className="uas" aria-label="Sessions"><h2>Sessions</h2><div className="uas-card">
        <header><h3>Top sessions</h3><div className="uas-switch" role="group" aria-label="Rank sessions by">{(['tokens', 'errors'] as const).map(key => <button type="button" key={key} aria-pressed={sort === key} onClick={() => sortBy(key, false)}>{key === 'tokens' ? 'By tokens' : 'By tool errors'}</button>)}</div></header>
        <dl className="uas-figures">{[['Sessions', usageNumber(summary.sessions)], ['Top 10 share of tokens', usagePercent(figures.top10)], ['Tokens from subagents', usagePercent(figures.subagents)], ['Tokens for compaction', usagePercent(figures.compaction)], ['Tokens per session, median', figures.median === null ? 'Unavailable' : usageCompact(figures.median)]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
        {partial && <p className="uas-note">Partial retained history.</p>}
        <div className="uas-table-scroll"><table className="uas-sessions"><thead><tr>{sessionColumns.map(column => <th key={column.key} scope="col" className={column.secondary ? 'uas-secondary' : undefined} aria-sort={sort === column.key ? ascending ? 'ascending' : 'descending' : 'none'}><button type="button" onClick={() => sortBy(column.key, true)}>{column.label}</button></th>)}</tr></thead>
            <tbody>{items.map(item => {
                const { row, label } = sessionLabel(item, sessionRows);
                const open = expanded.includes(`${summary.range}:${item.id}`);
                const total = usageTotal(item.tokens);
                return <Fragment key={item.id}>
                    <tr className="uas-session-row" tabIndex={0} aria-expanded={open} onClick={() => toggle(`${summary.range}:${item.id}`)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle(`${summary.range}:${item.id}`); } }}>
                        <th scope="row"><span className="uas-title">{label}</span><small>{item.project?.label}</small></th>
                        <td>{usageCompact(total)}<svg className="uas-meter" viewBox="0 0 100 3" aria-hidden="true"><rect width={total / Math.max(...items.map(value => usageTotal(value.tokens)), 1) * 100} height="3" /></svg></td>
                        <td className="uas-secondary">{usagePercent(total ? usageTotal(item.tokenSources.subagents) / total * 100 : null)}</td>
                        <td className="uas-secondary">{usageNumber(item.requests)}</td>
                        <td className={item.errors ? 'uas-error' : ''}>{usageNumber(item.errors)}</td>
                        <td>{usagePercent(item.results ? item.errors / item.results * 100 : null)}</td>
                        <td className="uas-secondary"><time dateTime={item.lastActiveAt} title={item.lastActiveAt}>{sessionLastActive(item.lastActiveAt)}</time></td>
                    </tr>
                    {open && <tr className="uas-detail-row"><td colSpan={7}><SessionDetail item={item} summary={summary} row={row} onOpenSession={onOpenSession} /></td></tr>}
                </Fragment>;
            })}</tbody></table></div>
        {!items.length && <p className="uas-note">No contributing sessions recorded.</p>}
        {summary.rankedSessions.state === 'truncated' && <p className="uas-note">{usageNumber(items.length)} ranked sessions shown; {usageNumber(summary.rankedSessions.omitted)} omitted. Range totals include all sessions.</p>}
    </div></section>;
}
export function UsageAnalyticsIntegrations({ summary, partial }: { summary: UsageRangeSummary; partial: boolean }) {
    return <section className="uas" aria-label="Skills and integrations"><h2>Skills &amp; integrations</h2><div className="uas-integrations">{(['skills', 'integrations'] as const).map(kind => {
        const data = integrationSeries(summary, kind);
        const title = kind === 'skills' ? 'Skills used' : 'Integrations called';
        return <div className="uas-card" key={kind}><h3>{title}</h3><div className="uas-big">{usageNumber(data.total)}</div>{partial && <p className="uas-note">Partial retained history.</p>}{summary.range === '30d' && <p className="uas-note">Weekly totals</p>}{summary.range === 'all' && <p className="uas-note">{(summary.bucketDays ?? 1) > 1 ? `Each retained bucket spans up to ${summary.bucketDays} days.` : 'Only retained days are shown.'}</p>}
            {data.series.length ? <><AnalyticsLines points={data.points} labels={data.series.map(series => series.label)} summary={summary} label={title} /><ul className="uas-legend">{data.series.map((series, index) => <li key={series.id}><span className={`uas-swatch uas-color-${index}`} />{series.label} <strong>{usageNumber(series.total)}</strong></li>)}</ul></> : <p className="uas-note">No {kind === 'skills' ? 'skill uses' : 'integration calls'} recorded.</p>}</div>;
    })}</div></section>;
}
