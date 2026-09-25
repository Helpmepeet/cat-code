import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { UsageWindow } from '../../shared/usageDashboard.js';
import { type UsageDashboardState, initialUsageSelection, type UsageSelection, usageCompact, usageFailureMessage, usageNumber, usageTotal } from './usageDashboardState.js';
import { UsageTokenFlow } from './UsageDashboardCharts.js';
import { UsageHeatmap } from './UsageActivityCharts.js';
import { UsageCacheSummary, UsageModelDonut, UsageToolBreakdown } from './UsageOverviewDetails.js';
import { UsageSessionContributors } from './UsageSessionContributors.js';
import type { MergedSessionRow } from './sessionsCatalogState.js';
import { usageBucketDays, usageBucketLabel } from './usageTrendState.js';
import { UsageMetrics } from './UsageMetrics.js';
import { usageModelColors } from './usageGraphState.js';
import { UsageAutoMode } from './UsageAutoMode.js';
import { UsageValuesTable } from './UsageValuesTable.js';
import './usageDashboard.css';
function usageDayText(date: string, weekday = false, year = false): string {
    return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', ...(weekday ? { weekday: 'short' as const } : {}), ...(year ? { year: 'numeric' as const } : {}) }).format(new Date(`${date}T12:00:00.000Z`));
}
function usageLastDate(exclusive: string): string {
    return new Date(Date.parse(`${exclusive}T00:00:00.000Z`) - 86400000).toISOString().slice(0, 10);
}
function usageUpdated(asOf: string, timezone: string): string {
    const date = new Date(asOf), now = new Date();
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
    const time = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', minute: '2-digit' }).format(date);
    return `Updated ${day.format(date) === day.format(now) ? '' : `${new Intl.DateTimeFormat('en-US', { timeZone: timezone, month: 'short', day: 'numeric' }).format(date)} `}${time}`;
}
function UsagePanel({ title, children, wide = false, className = '' }: {
    title?: string;
    children: ReactNode;
    wide?: boolean;
    className?: string;
}) {
    return <section className={`usage-panel${wide ? ' usage-wide' : ''}${className ? ` ${className}` : ''}`}>{title && <h2 className="usage-panel-heading">{title}</h2>}{children}</section>;
}
export function UsagePage({ state, selection, onSelectionChange, sessionRows = [], onOpenSession, onRefresh }: {
    state: UsageDashboardState;
    selection?: UsageSelection;
    onSelectionChange?: (selection: UsageSelection) => void;
    sessionRows?: readonly MergedSessionRow[];
    onOpenSession?: (row: MergedSessionRow) => void;
    onRefresh?: () => void;
}) {
    const [localSelection, setLocalSelection] = useState(initialUsageSelection);
    const currentSelection = selection ?? localSelection;
    const { range, date: selectedDate } = currentSelection;
    const detailHeading = useRef<HTMLHeadingElement>(null);
    useEffect(() => { if (selectedDate) detailHeading.current?.focus(); }, [selectedDate]);
    const updateSelection = (next: UsageSelection) => { setLocalSelection(next); onSelectionChange?.(next); };
    const setRange = (next: UsageWindow) => updateSelection({ range: next, date: '' });
    const setSelectedDate = (date: string) => {
        const summary = state.snapshot?.ranges[range];
        const bucket = range === 'all' && date && summary ? summary.days.find(day => {
            const offset = (Date.parse(`${date}T00:00:00.000Z`) - Date.parse(`${day.date}T00:00:00.000Z`)) / 86400000;
            return offset >= 0 && offset < usageBucketDays(summary);
        }) : null;
        updateSelection({ range, date: bucket?.date ?? date });
    };
    const snapshot = state.snapshot, summary = snapshot?.ranges[range];
    const unavailable = state.status === 'unavailable';
    const partial = snapshot?.coverage.state === 'partial';
    const selected = summary?.days.find(day => day.date === selectedDate);
    const colors = usageModelColors(snapshot ? [snapshot.ranges.all, snapshot.ranges['30d'], snapshot.ranges['7d']].flatMap(item => item.models) : []);
    const empty = summary && usageTotal(summary.tokens) === 0 && summary.records === 0 && summary.requests === 0 && Object.values(summary.autoMode.allTools.outcomes).every(count => count === 0);
    const refreshing = state.status === 'loading';
    const refreshFailed = state.status === 'error' && !!snapshot;
    const refreshLabel = refreshing ? 'Refreshing analytics' : refreshFailed ? 'Refresh failed. Try again' : 'Refresh analytics';
    return <main className="usage-page" aria-labelledby="usage-title"><div className="usage-content">
        <header className="usage-header"><div><h1 id="usage-title">Analytics</h1>{snapshot && summary && !unavailable && <p className="usage-freshness"><span>{usageDayText(summary.startDate, false, summary.startDate.slice(0, 4) !== usageLastDate(summary.endDateExclusive).slice(0, 4))} to {usageDayText(usageLastDate(summary.endDateExclusive), false, summary.startDate.slice(0, 4) !== usageLastDate(summary.endDateExclusive).slice(0, 4))}</span><span>{usageUpdated(snapshot.asOf, snapshot.timezone)}</span></p>}</div><div className="usage-header-actions">{onRefresh && <button className={`usage-refresh${refreshFailed ? ' usage-refresh-failed' : ''}`} type="button" onClick={onRefresh} disabled={refreshing || unavailable} aria-label={refreshLabel} title={refreshLabel}><svg className={`usage-refresh-icon${refreshing ? ' animate-spin' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 0 0-15.2-6.5L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 15.2 6.5L21 16"/><path d="M16 16h5v5"/></svg></button>}<div className="usage-range" role="group" aria-label="Analytics period">{(['7d', '30d', 'all'] as const).map(value => <button key={value} type="button" aria-pressed={value === range} onClick={() => setRange(value)}>{value === 'all' ? 'All' : value === '7d' ? '7 days' : '30 days'}</button>)}</div></div></header>
        {(unavailable || !snapshot || empty) && <div className="usage-status" role="status">{unavailable ? 'Analytics is unavailable.' : !snapshot ? (state.status === 'loading' ? 'Loading analytics…' : usageFailureMessage(state.errorCode)) : partial ? 'Activity for this period is incomplete.' : 'No recorded activity in this period.'}</div>}
        {summary && snapshot && !unavailable && !empty && <>
            <UsageMetrics summary={summary} unknown="–" partial={!!partial}/>
            <div className="usage-panels">
                <UsagePanel wide className="usage-token-flow-panel">
                    <UsageTokenFlow summary={summary} colors={colors} selected={selected?.date ?? ''} onSelect={setSelectedDate} partial={!!partial}/>
                    {usageBucketDays(summary) > 1 && <p className="usage-note">{usageBucketDays(summary)}-day totals</p>}
                    {selected && <section className="usage-day-detail" aria-label={`Analytics for ${usageBucketLabel(summary, selected.date)}`}>
                        <header className="usage-detail-header"><h3 ref={detailHeading} tabIndex={-1}>{usageBucketDays(summary) === 1 ? usageDayText(selected.date, true) : usageBucketLabel(summary, selected.date)}</h3><button type="button" onClick={() => setSelectedDate('')}>Clear</button></header>
                        <div className="usage-day-readout usage-day-figures" aria-live="polite"><div><strong>{usageCompact(usageTotal(selected.tokens))}</strong> tokens</div><div><strong>{usageNumber(selected.sessions)}</strong> sessions</div><div><strong>{usageNumber(selected.requests)}</strong> tool requests</div><div><strong>{usageNumber(selected.errors)}</strong> errors</div></div>
                        {range === 'all' ? <p className="usage-note">Session lists cover the last 30 days. <button type="button" onClick={() => setRange('30d')}>Show in 30 days</button></p> : <UsageSessionContributors key={selected.date} contributors={selected.contributors ?? { state: 'unavailable', omitted: 0, items: [] }} rows={sessionRows} onOpenRow={onOpenSession}/>}
                    </section>}
                </UsagePanel>
                <div className="usage-secondary-panels usage-wide">
                    <UsagePanel><UsageCacheSummary key={range} summary={summary} partial={!!partial} selected={selected?.date ?? ''} onSelect={setSelectedDate}/></UsagePanel>
                    <UsagePanel title="Model usage"><UsageModelDonut summary={summary} colors={colors}/></UsagePanel>
                </div>
                <UsagePanel title="Tools" wide><UsageToolBreakdown summary={summary} timezone={snapshot.timezone}/></UsagePanel>
                <UsagePanel title="Activity by hour" wide><UsageHeatmap summary={snapshot.ranges['7d']} metric="tokens" asOf={snapshot.asOf} selected={selectedDate} selectedBucketDays={range === 'all' ? usageBucketDays(summary) : 1} onSelect={setSelectedDate}/></UsagePanel>
                <UsagePanel title="Auto mode" wide><UsageAutoMode summary={summary}/></UsagePanel>
            </div>
            <UsageValuesTable summary={summary} hourlySummary={snapshot.ranges['7d']} asOf={snapshot.asOf} timezone={snapshot.timezone} partial={!!partial}/>
        </>}
    </div></main>;
}
