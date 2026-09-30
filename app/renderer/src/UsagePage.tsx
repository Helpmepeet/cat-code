import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { UsageWindow } from '../../shared/usageDashboard.js';
import { type UsageDashboardState, initialUsageSelection, type UsageSelection, usageCompact, usageFailureMessage, usageNumber, usageTotal } from './usageDashboardState.js';
import { UsageTokenFlow } from './UsageDashboardCharts.js';
import { UsageHeatmap } from './UsageActivityCharts.js';
import { UsageCacheSummary, UsageModelDonut, UsageToolBreakdown } from './UsageOverviewDetails.js';
import { UsageSessionContributors } from './UsageSessionContributors.js';
import type { MergedSessionRow } from './sessionsCatalogState.js';
import { usageBucketDays, usageBucketLabel, usageDailyActivity } from './usageTrendState.js';
import { UsageMetrics } from './UsageMetrics.js';
import { usageModelColors } from './usageGraphState.js';
import { UsageAutoMode } from './UsageAutoMode.js';
import { UsageValuesTable } from './UsageValuesTable.js';
import { UsageToolErrorTrend } from './UsageToolErrorTrend.js';
import { UsageParallelSessions, UsageReasoningEffort, UsageSessionsRunning } from './UsageWorkPatterns.js';
import { UsageChartHoverContext, UsageModelHoverContext } from './usageChartHover.js';
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
function activityStats(days: ReadonlyMap<string, { tokens: { fresh: number; read: number; write: number; output: number } }>, lastDate: string) {
    const active = [...days.entries()].filter(([, day]) => usageTotal(day.tokens) > 0).map(([date]) => date).sort();
    let longest = 0, streak = 0, previous = '';
    for (const date of active) {
        streak = previous && Date.parse(`${date}T00:00:00Z`) - Date.parse(`${previous}T00:00:00Z`) === 86400000 ? streak + 1 : 1;
        longest = Math.max(longest, streak);
        previous = date;
    }
    let current = 0;
    for (let at = Date.parse(`${lastDate}T00:00:00Z`); days.has(new Date(at).toISOString().slice(0, 10)) && usageTotal(days.get(new Date(at).toISOString().slice(0, 10))!.tokens) > 0; at -= 86400000) current++;
    return { active: active.length, longest, current };
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
    const [scrolled, setScrolled] = useState(false);
    const [hoverDate, setHoverDate] = useState('');
    const [hoverModel, setHoverModel] = useState('');
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
    const linkedDate = range === 'all' && hoverDate && summary ? summary.days.find(day => {
        const offset = (Date.parse(`${hoverDate}T00:00:00.000Z`) - Date.parse(`${day.date}T00:00:00.000Z`)) / 86400000;
        return offset >= 0 && offset < usageBucketDays(summary);
    })?.date ?? hoverDate : hoverDate;
    const unavailable = state.status === 'unavailable';
    const partial = snapshot?.coverage.state === 'partial';
    const selected = summary?.days.find(day => day.date === selectedDate);
    const activity = snapshot ? usageDailyActivity(snapshot.ranges) : null;
    const heatStats = activity ? activityStats(activity.days, activity.lastDate) : null;
    const colors = usageModelColors(snapshot ? [snapshot.ranges.all, snapshot.ranges['30d'], snapshot.ranges['7d']].flatMap(item => item.models) : []);
    const empty = summary && usageTotal(summary.tokens) === 0 && summary.records === 0 && summary.requests === 0 && Object.values(summary.autoMode.allTools.outcomes).every(count => count === 0);
    const refreshing = state.status === 'loading';
    const refreshFailed = state.status === 'error' && !!snapshot;
    const refreshLabel = refreshing ? 'Refreshing analytics' : refreshFailed ? 'Refresh failed. Try again' : 'Refresh analytics';
    return <main className="usage-page" data-range={range} aria-labelledby="usage-title" onScroll={event => setScrolled(event.currentTarget.scrollTop > 8)}><div className="usage-content">
        <div className={`usage-sticky-top${scrolled ? ' usage-sticky-scrolled' : ''}`}><header className="usage-header"><div><h1 id="usage-title">Analytics</h1>{snapshot && summary && !unavailable && <p className="usage-freshness"><span>{usageDayText(summary.startDate, false, summary.startDate.slice(0, 4) !== usageLastDate(summary.endDateExclusive).slice(0, 4))} to {usageDayText(usageLastDate(summary.endDateExclusive), false, summary.startDate.slice(0, 4) !== usageLastDate(summary.endDateExclusive).slice(0, 4))}</span>{summary.previousPeriod && <span>vs {usageDayText(summary.previousPeriod.startInclusive.slice(0, 10))} to {usageDayText(summary.previousPeriod.endInclusive.slice(0, 10))}</span>}<span>{usageUpdated(snapshot.asOf, snapshot.timezone)}</span></p>}</div><div className="usage-header-actions">{onRefresh && <button className={`usage-refresh${refreshFailed ? ' usage-refresh-failed' : ''}`} type="button" onClick={onRefresh} disabled={refreshing || unavailable} aria-label={refreshLabel} title={refreshLabel}><svg className={`usage-refresh-icon${refreshing ? ' animate-spin' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 0 0-15.2-6.5L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 15.2 6.5L21 16"/><path d="M16 16h5v5"/></svg></button>}<div className="usage-range usage-segmented" data-range={range} role="group" aria-label="Analytics period">{(['7d', '30d', 'all'] as const).map(value => <button key={value} type="button" aria-pressed={value === range} onClick={() => setRange(value)}>{value === 'all' ? 'All' : value === '7d' ? '7 days' : '30 days'}</button>)}</div></div></header></div>
        {(unavailable || !snapshot || empty) && <div className="usage-status" role="status">{unavailable ? 'Analytics is unavailable.' : !snapshot ? (state.status === 'loading' ? 'Loading analytics…' : usageFailureMessage(state.errorCode)) : partial ? 'Activity for this period is incomplete.' : 'No recorded activity in this period.'}</div>}
        {summary && snapshot && activity && !unavailable && !empty && <UsageChartHoverContext.Provider value={{ date: linkedDate, setDate: setHoverDate }}><UsageModelHoverContext.Provider value={{ id: hoverModel, setId: setHoverModel }}>
            <h2 className="usage-section-heading">Usage</h2>
            <UsageMetrics summary={summary} unknown="–" partial={!!partial}/>
            <div className="usage-panels">
                <UsagePanel wide className="usage-token-flow-panel">
                    <UsageTokenFlow summary={summary} colors={colors} selected={selected?.date ?? ''} onSelect={setSelectedDate} partial={!!partial}/>
                    {usageBucketDays(summary) > 1 && <p className="usage-note">{usageBucketDays(summary)}-day totals</p>}
                    {selected && <section className="usage-day-detail" aria-label={`Analytics for ${usageBucketLabel(summary, selected.date)}`}>
                        <header className="usage-detail-header"><h3 ref={detailHeading} tabIndex={-1}>{usageBucketDays(summary) === 1 ? usageDayText(selected.date, true) : usageBucketLabel(summary, selected.date)}</h3><button type="button" onClick={() => setSelectedDate('')}>Clear</button></header>
                        <div className="usage-day-readout usage-day-figures" aria-live="polite"><div><strong>{usageCompact(usageTotal(selected.tokens))}</strong> tokens</div><div><strong>{usageNumber(selected.sessions)}</strong> sessions</div><div><strong>{usageNumber(selected.requests)}</strong> tool requests</div><div><strong>{usageNumber(selected.errors)}</strong> errors</div></div>
                        <UsageSessionsRunning day={selected} timezone={snapshot.timezone}/>
                        {range === 'all' ? <p className="usage-note">Session lists cover the last 30 days. <button type="button" onClick={() => setRange('30d')}>Show in 30 days</button></p> : <UsageSessionContributors key={selected.date} contributors={selected.contributors ?? { state: 'unavailable', omitted: 0, items: [] }} rows={sessionRows} onOpenRow={onOpenSession}/>}
                    </section>}
                </UsagePanel>
                <div className="usage-secondary-panels usage-wide">
                    <UsagePanel title="Model usage"><UsageModelDonut summary={summary} colors={colors}/></UsagePanel>
                    <UsagePanel><UsageCacheSummary key={range} summary={summary} partial={!!partial} selected={selected?.date ?? ''} onSelect={setSelectedDate}/></UsagePanel>
                </div>
                <UsagePanel wide><div className="usage-activity-header"><h2 className="usage-panel-heading">Daily activity</h2>{heatStats && <div className="usage-activity-stats"><span><b>{heatStats.active}</b>active days</span><span><b>{heatStats.longest}</b>longest streak</span><span><b>{heatStats.current}</b>current streak</span></div>}</div><UsageHeatmap activity={activity} range={summary} selected={selectedDate} selectedBucketDays={range === 'all' ? usageBucketDays(summary) : 1} onSelect={setSelectedDate}/></UsagePanel>
                <UsageParallelSessions summary={summary} selected={selectedDate} onSelect={setSelectedDate}/>
                <UsageReasoningEffort summary={summary} selected={selectedDate} onSelect={setSelectedDate}/>
            </div>
            <h2 className="usage-section-heading">Tools</h2>
            <div className="usage-tool-pair"><UsagePanel title="Tools"><UsageToolBreakdown summary={summary} timezone={snapshot.timezone} showTrend={false}/></UsagePanel><UsagePanel><UsageToolErrorTrend summary={summary} timezone={snapshot.timezone}/></UsagePanel></div>
            <h2 className="usage-section-heading">Auto mode</h2>
            <div className="usage-panels"><UsagePanel wide><UsageAutoMode summary={summary}/></UsagePanel></div>
            <UsageValuesTable summary={summary} activity={activity} timezone={snapshot.timezone} partial={!!partial} selectedDate={selectedDate}/>
        </UsageModelHoverContext.Provider></UsageChartHoverContext.Provider>}
    </div></main>;
}
