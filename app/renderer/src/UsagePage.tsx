import { useEffect, useRef, useState } from 'react';
import type { UsageWindow } from '../../shared/usageDashboard.js';
import { type UsageDashboardState, type UsageSelection, usageFailureMessage, usageTotal } from './usageDashboardState.js';
import type { MergedSessionRow } from './sessionsCatalogState.js';
import { UsageMetrics } from './UsageMetrics.js';
import { UsageDailyChart, UsageDailyDetail } from './UsageDailyChart.js';
import { usageDailySeries, usageModelRequestCount, usagePinnedBucket, usageSelectedToolId, type UsageDailyMetric, type UsageTokenGrouping } from './usageDailyChartState.js';
import { UsageAnalyticsCache, UsageAnalyticsActivity, UsageAnalyticsModels, UsageAnalyticsReliability } from './UsageAnalyticsDetails.js';
import { analyticsFamilyLabels } from './usageAnalyticsDetailsState.js';
import { UsageAnalyticsSessions, UsageAnalyticsIntegrations } from './UsageAnalyticsSessions.js';
import './usageDashboard.css';
import './usageDailyChart.css';
function usageDayText(date: string, weekday = false, year = false): string {
    return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', ...(weekday ? { weekday: 'short' as const } : {}), ...(year ? { year: 'numeric' as const } : {}) }).format(new Date(`${date}T12:00:00.000Z`));
}
function usageLastDate(exclusive: string): string {
    return new Date(Date.parse(`${exclusive}T00:00:00.000Z`) - 86400000).toISOString().slice(0, 10);
}
function usageInstantDayText(instant: string, timezone: string): string {
    return new Intl.DateTimeFormat('en-US', { timeZone: timezone, month: 'short', day: 'numeric' }).format(new Date(instant));
}
function usageScrollTo(element: Element | null | undefined, block: ScrollLogicalPosition) {
    element?.scrollIntoView?.({ block, behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
}
function usageUpdated(asOf: string, timezone: string): string {
    const date = new Date(asOf), now = new Date();
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
    const time = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', minute: '2-digit' }).format(date);
    return `Updated ${day.format(date) === day.format(now) ? '' : `${new Intl.DateTimeFormat('en-US', { timeZone: timezone, month: 'short', day: 'numeric' }).format(date)} `}${time}`;
}
export function UsagePage({ state, selection, onSelectionChange, sessionRows = [], onOpenSession, onRefresh }: {
    state: UsageDashboardState;
    selection: UsageSelection;
    onSelectionChange: (selection: UsageSelection) => void;
    sessionRows?: readonly MergedSessionRow[];
    onOpenSession?: (row: MergedSessionRow) => void;
    onRefresh?: () => void;
}) {
    const [scrolled, setScrolled] = useState(false);
    const [metric, setMetric] = useState<UsageDailyMetric>('tokens');
    const [grouping, setGrouping] = useState<UsageTokenGrouping>('family');
    const [hidden, setHidden] = useState<Partial<Record<UsageDailyMetric, string[]>>>({});
    const [modelFamilies, setModelFamilies] = useState<string[]>([]);
    const cacheRef = useRef<HTMLDivElement>(null);
    const buildRef = useRef<HTMLDivElement>(null);
    const scrollToBuildChart = () => usageScrollTo(buildRef.current?.querySelector('.uad-build-card'), 'center');
    const dailyRef = useRef<HTMLDivElement>(null);
    const selectMetric = (next: UsageDailyMetric) => {
        setMetric(next);
        usageScrollTo(dailyRef.current, 'center');
    };
    const changeGrouping = (next: UsageTokenGrouping) => {
        if (next === grouping) return;
        setGrouping(next);
        setModelFamilies([]);
        setHidden(current => ({ ...current, tokens: [] }));
    };
    const { range, date: selectedDate } = selection;
    const setRange = (next: UsageWindow) => onSelectionChange({ range: next, date: state.snapshot ? usagePinnedBucket(state.snapshot.ranges[next], selectedDate) : '' });
    const setSelectedDate = (date: string) => {
        onSelectionChange({ range, date });
    };
    const snapshot = state.snapshot, summary = snapshot?.ranges[range];
    const selectedToolId = usageSelectedToolId(summary, metric, hidden.toolErrors ?? []);
    useEffect(() => {
        if (selectedDate && summary) {
            const date = usagePinnedBucket(summary, selectedDate);
            if (date !== selectedDate) onSelectionChange({ range, date });
        }
    }, [summary, selectedDate, range, onSelectionChange]);
    const unavailable = state.status === 'unavailable';
    const partial = snapshot?.coverage.state === 'partial';
    const selected = summary?.days.find(day => day.date === selectedDate);
    const empty = summary && usageTotal(summary.tokens) === 0 && summary.records === 0 && summary.requests === 0 && usageModelRequestCount(summary) === 0 && summary.timing.models.outcomes.started === 0 && summary.timing.tools.outcomes.started === 0 && Object.values(summary.autoMode.allTools.outcomes).every(count => count === 0);
    const refreshing = state.status === 'loading';
    const refreshFailed = state.status === 'error' && !!snapshot;
    const refreshLabel = refreshing ? 'Refreshing analytics' : refreshFailed ? 'Refresh failed. Try again' : 'Refresh analytics';
    return <main className="usage-page" data-range={range} aria-labelledby="usage-title" onScroll={event => setScrolled(event.currentTarget.scrollTop > 8)}><div className="usage-content">
        <div className={`usage-sticky-top${scrolled ? ' usage-sticky-scrolled' : ''}`}><header className="usage-header"><div><h1 id="usage-title">Analytics</h1>{snapshot && summary && !unavailable && <p className="usage-freshness"><span>{usageDayText(summary.startDate, false, summary.startDate.slice(0, 4) !== usageLastDate(summary.endDateExclusive).slice(0, 4))} to {usageDayText(usageLastDate(summary.endDateExclusive), false, summary.startDate.slice(0, 4) !== usageLastDate(summary.endDateExclusive).slice(0, 4))}</span>{summary.previousPeriod && <span>vs {usageInstantDayText(summary.previousPeriod.startInclusive, snapshot.timezone)} to {usageInstantDayText(summary.previousPeriod.endInclusive, snapshot.timezone)}</span>}<span>{usageUpdated(snapshot.asOf, snapshot.timezone)}</span></p>}</div><div className="usage-header-actions">{onRefresh && <button className={`usage-refresh${refreshFailed ? ' usage-refresh-failed' : ''}`} type="button" onClick={onRefresh} disabled={refreshing || unavailable} aria-label={refreshLabel} title={refreshLabel}><svg className={`usage-refresh-icon${refreshing ? ' animate-spin' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 0 0-15.2-6.5L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 15.2 6.5L21 16"/><path d="M16 16h5v5"/></svg></button>}<div className="usage-range usage-segmented" data-range={range} role="group" aria-label="Analytics period">{(['7d', '30d', 'all'] as const).map(value => <button key={value} type="button" aria-pressed={value === range} onClick={() => setRange(value)}>{value === 'all' ? 'All' : value === '7d' ? '7 days' : '30 days'}</button>)}</div></div></header></div>
        {(unavailable || !snapshot || empty) && <div className="usage-status" role="status">{unavailable ? 'Analytics is unavailable.' : !snapshot ? (state.status === 'loading' ? 'Loading analytics…' : usageFailureMessage(state.errorCode)) : partial ? 'Activity for this period is incomplete.' : 'No recorded activity in this period.'}</div>}
        {partial && !empty && <p className="usage-status" role="status">Activity for this period is incomplete.</p>}
        {refreshFailed && <p className="usage-status" role="status">{usageFailureMessage(state.errorCode)} Showing the last available update.</p>}
        {summary && snapshot && !unavailable && !empty && <>
            <UsageMetrics summary={summary} unknown="–" partial={!!partial} metric={metric} onMetricChange={selectMetric} onCacheSelect={() => usageScrollTo(cacheRef.current, 'start')} onBuildSelect={scrollToBuildChart}/>
            <div ref={dailyRef} className="usage-daily-grid">
                <UsageDailyChart partial={!!partial} summary={summary} metric={metric} grouping={grouping} hidden={hidden[metric] ?? []} modelFamily={modelFamilies.map(id => analyticsFamilyLabels[id] ?? id)} selected={selected?.date ?? ''} onMetricChange={setMetric} onGroupingChange={changeGrouping} onHiddenChange={ids => setHidden(current => ({ ...current, [metric]: ids }))} onModelFamilyChange={families => setModelFamilies(families.map(label => Object.keys(analyticsFamilyLabels).find(id => analyticsFamilyLabels[id] === label) ?? label))} onSelect={setSelectedDate}/>
                <UsageDailyDetail summary={summary} selected={selected?.date ?? ''} onClear={() => setSelectedDate('')}/>
            </div>
            <div ref={cacheRef}><UsageAnalyticsCache summary={summary} partial={!!partial} selectedDate={selected?.date ?? ''} onSelectDate={setSelectedDate}/></div>
            <UsageAnalyticsActivity summary={summary} timezone={snapshot.timezone} partial={!!partial} selectedDate={selected?.date ?? ''} onSelectDate={setSelectedDate}/>
            <UsageAnalyticsModels summary={summary} partial={!!partial} modelFamilies={modelFamilies} onModelFamiliesChange={families => { setModelFamilies(families); setGrouping('family'); setHidden(current => ({ ...current, tokens: [] })); }}/>
            <UsageAnalyticsSessions summary={summary} timezone={snapshot.timezone} partial={!!partial} sessionRows={sessionRows} onOpenSession={onOpenSession}/>
            <UsageAnalyticsIntegrations summary={summary} partial={!!partial}/>
            <div ref={buildRef}><UsageAnalyticsReliability summary={summary} partial={!!partial} selectedToolId={selectedToolId} onSelectTool={id => { selectMetric('toolErrors'); setHidden(current => ({ ...current, toolErrors: usageDailySeries(summary, 'toolErrors', grouping).filter(item => item.id !== id).map(item => item.id) })); }} onSelectRoute={() => { selectMetric('auto'); setHidden(current => ({ ...current, auto: ['allowed'] })); }} onSelectBuild={scrollToBuildChart}/></div>
        </>}
    </div></main>;
}
