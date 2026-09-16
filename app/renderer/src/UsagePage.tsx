import { useEffect, useState, type ReactNode } from 'react';
import type { UsageWindow } from '../../shared/usageDashboard.js';
import { type UsageDashboardState, initialUsageSelection, type UsageSelection, usageCompact, usageColors, usageCacheWrites, usageFailureMessage, usageNumber, usagePercent, usageShare, usageTotal } from './usageDashboardState.js';
import { UsageActivityRows, UsageDailyColumns } from './UsageDashboardCharts.js';
import { UsageHeatmap } from './UsageActivityCharts.js';
import { UsageCacheSummary, UsageModelBars, UsageToolActivity } from './UsageOverviewDetails.js';
import { UsageSessionContributors } from './UsageSessionContributors.js';
import type { MergedSessionRow } from './sessionsCatalogState.js';
import './usageDashboard.css';
type UsageAccent = 'tokens' | 'cache' | 'sessions' | 'tools';
function UsageIcon({ kind }: { kind: UsageAccent }) {
    const paths = {
        tokens: <><ellipse cx="12" cy="5" rx="7" ry="3"/><path d="M5 5v6c0 4 14 4 14 0V5M5 11v6c0 4 14 4 14 0v-6"/></>,
        cache: <path d="m13 2-8 12h6l-1 8 9-13h-6z"/>,
        sessions: <><circle cx="9" cy="7" r="3"/><path d="M3 21v-4a6 6 0 0 1 12 0v4M17 4a3 3 0 0 1 0 6M18 14a5 5 0 0 1 3 5v2"/></>,
        tools: <><path d="m12 2 9 5v10l-9 5-9-5V7zM3 7l9 5 9-5M12 12v10"/></>,
    };
    return <svg className={`usage-icon usage-${kind}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[kind]}</svg>;
}
function UsagePanel({ title, children, wide = false, accent = 'tokens' }: {
    title: string;
    children: ReactNode;
    wide?: boolean;
    accent?: UsageAccent;
}) {
    return <section className={`usage-panel${wide ? ' usage-wide' : ''}`}><h2 className="usage-panel-heading"><UsageIcon kind={accent}/>{title}</h2>{children}</section>;
}
export function UsagePage({ state, selection, onSelectionChange, sessionRows = [], onOpenSession }: {
    state: UsageDashboardState;
    selection?: UsageSelection;
    onSelectionChange?: (selection: UsageSelection) => void;
    sessionRows?: readonly MergedSessionRow[];
    onOpenSession?: (row: MergedSessionRow) => void;
}) {
    const [localSelection, setLocalSelection] = useState(initialUsageSelection);
    const currentSelection = selection ?? localSelection;
    const { range, date: selectedDate } = currentSelection;
    const updateSelection = (next: UsageSelection) => { setLocalSelection(next); onSelectionChange?.(next); };
    const setRange = (next: UsageWindow) => updateSelection({ range: next, date: '' });
    const setSelectedDate = (date: string) => updateSelection({ range, date });
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(timer); }, []);
    const snapshot = state.snapshot, summary = snapshot?.ranges[range];
    const unavailable = state.status === 'unavailable';
    const partial = snapshot?.coverage.state === 'partial';
    const stale = !!snapshot && (state.status === 'error' || now - Date.parse(snapshot.asOf) > 10 * 60000);
    const selected = summary?.days.find(d => d.date === selectedDate);
    const colors = usageColors([...new Set(snapshot ? Object.values(snapshot.ranges).flatMap(r => r.models.map(m => m.id)) : [])]);
    const unknown = state.status === 'loading' ? 'Loading' : 'Unavailable';
    const empty = summary && usageTotal(summary.tokens) === 0 && summary.records === 0 && summary.requests === 0;
    return <main className="usage-page" aria-labelledby="usage-title"><div className="usage-content">
  <header className="usage-header"><div><h1 id="usage-title">Usage</h1></div><div className="usage-range" role="group" aria-label="Usage period">{(['7d', '30d'] as const).map(r => <button key={r} type="button" aria-pressed={r === range} onClick={() => setRange(r)}>{r === '7d' ? '7 days' : '30 days'}</button>)}</div></header>
  {snapshot && summary && !unavailable && <p className="usage-note usage-freshness"><span>{summary.startInclusive.slice(0, 10)} to {summary.days.at(-1)!.date} UTC</span><span title={snapshot.asOf.replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC')}>Updated {snapshot.asOf.slice(11, 16)} UTC</span></p>}
  <div className="usage-status" role="status">
   {unavailable ? 'Usage is unavailable.' : !snapshot ? (state.status === 'loading' ? 'Loading recorded usage…' : usageFailureMessage(state.errorCode)) : <>{state.status === 'loading' && <p>Refreshing recorded usage…</p>}{stale && <p>Showing an older snapshot. {state.status === 'error' ? usageFailureMessage(state.errorCode) : 'Waiting for a fresh update.'}</p>}{partial && <p>Partial history. Totals may be incomplete.</p>}{!partial && empty && <p>No recorded usage in available history.</p>}</>}
  </div>
  <section className="usage-overview" aria-label="Usage overview">
  <div className="usage-cards">
   <section className="usage-metric usage-tokens"><UsageIcon kind="tokens"/><div><h2>Total tokens</h2><strong>{summary && !unavailable ? usageCompact(usageTotal(summary.tokens)) : unknown}</strong>{summary && !unavailable && <p>{usageCompact(summary.activeDays ? usageTotal(summary.tokens) / summary.activeDays : 0)} / active day</p>}</div></section>
   <section className="usage-metric usage-sessions"><UsageIcon kind="sessions"/><div><h2>Sessions used</h2><strong>{summary && !unavailable ? usageNumber(summary.sessions) : unknown}</strong></div></section>
   <section className="usage-metric usage-tools"><UsageIcon kind="tools"/><div><h2>Tool requests</h2><strong>{summary && !unavailable ? usageNumber(summary.requests) : unknown}</strong></div></section>
   <section className="usage-metric usage-cache"><UsageIcon kind="cache"/><div><h2>Cached input</h2><strong>{summary && !unavailable ? (partial ? 'Unavailable' : usagePercent(summary.cachedInputShare)) : unknown}</strong><p>Share of input tokens</p></div></section>
  </div></section>
  {summary && snapshot && !unavailable && <>
   <div className="usage-panels">
    <UsagePanel title="Daily token usage">
     <UsageDailyColumns summary={summary} colors={colors} selected={selected?.date ?? ''} onSelect={setSelectedDate} partial={!!partial}/>
     <ul className="usage-legend" aria-label="Model legend">{summary.models.map(model => <li key={model.id}><svg width="9" height="9" aria-hidden="true"><rect width="9" height="9" rx="2" fill={colors[model.id]}/></svg><span>{model.label}</span></li>)}</ul>
    </UsagePanel>
    <UsagePanel title="Model usage" accent="sessions"><UsageModelBars summary={summary} colors={colors}/>{summary.detail.omittedModels > 0 && <p className="usage-note">Other includes {usageNumber(summary.detail.omittedModels)} model names.</p>}</UsagePanel>
    {selected && <section className="usage-panel usage-wide usage-day-detail" aria-label={`Usage for ${selected.date}`}>
     <header className="usage-detail-header"><h2>{selected.date} UTC</h2><button type="button" onClick={() => setSelectedDate('')}>Clear selection</button></header>
     <div className="usage-day-readout" aria-live="polite">{usageCompact(usageTotal(selected.tokens))} tokens · {usageNumber(selected.sessions)} sessions · {usageNumber(selected.requests)} tool requests{partial ? ' · partial history' : ''}</div>
     <UsageSessionContributors key={selected.date} contributors={selected.contributors ?? { state: 'unavailable', omitted: 0, items: [] }} rows={sessionRows} onOpenRow={onOpenSession}/>
    </section>}
    <div className="usage-secondary-panels usage-wide">
     <UsagePanel title="Tool activity" accent="tools"><UsageToolActivity summary={summary}/></UsagePanel>
     <UsagePanel title="Prompt cache" accent="cache"><UsageCacheSummary summary={summary} partial={!!partial}/></UsagePanel>
    </div>
   </div>
   <details className="usage-disclosure usage-activity-details"><summary>Daily and hourly activity</summary>
    <UsageActivityRows summary={summary} selected={selected?.date ?? ''} onSelect={setSelectedDate} partial={!!partial}/>
    <UsageHeatmap key={range} summary={summary} asOf={snapshot.asOf} onSelect={setSelectedDate} partial={!!partial}/>
   </details>
   <details className="usage-values"><summary>Accessible values table</summary><p className="usage-note">{partial ? 'All values below describe partial history. A zero does not establish inactivity.' : 'Transcript records include user, assistant, system and attachment records in main sessions.'}</p><div className="usage-table-scroll"><table><caption>Daily recorded usage, UTC</caption><thead><tr>{['Date', 'Fresh input', 'Cache reads', 'Cache writes', 'Output', 'Total tokens', 'Cached input share', 'Sessions used', 'Transcript records', 'Tool requests'].map(h => <th key={h} scope="col">{h}</th>)}</tr></thead><tbody>{summary.days.map(d => <tr key={d.date}><th scope="row">{d.date}</th>{[d.tokens.fresh, d.tokens.read, d.tokens.write, d.tokens.output, usageTotal(d.tokens)].map((n, i) => <td key={i}>{i === 2 ? usageCacheWrites(n, d.cacheWriteReporting) : usageNumber(n)}</td>)}<td>{partial ? 'Unavailable' : usagePercent(usageShare(d.tokens))}</td><td>{usageNumber(d.sessions)}</td><td>{usageNumber(d.records)}</td><td>{usageNumber(d.requests)}</td></tr>)}</tbody></table></div>
    <div className="usage-table-scroll"><table><caption>Daily tokens by model</caption><thead><tr><th scope="col">Date</th>{summary.models.map(m => <th scope="col" key={m.id}>{m.label}</th>)}</tr></thead><tbody>{summary.days.map(d => <tr key={d.date}><th scope="row">{d.date}</th>{summary.models.map(m => <td key={m.id}>{usageNumber(d.models.find(v => v.id === m.id)?.total ?? 0)}</td>)}</tr>)}</tbody></table></div>
    <table><caption>Recorded tool requests</caption><thead><tr><th scope="col">Tool</th><th scope="col">Requests</th></tr></thead><tbody>{summary.tools.map(t => <tr key={t.id}><th scope="row">{t.label}</th><td>{usageNumber(t.requests)}</td></tr>)}</tbody></table>
   </details>
  </>}
 </div></main>;
}
