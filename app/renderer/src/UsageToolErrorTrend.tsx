import { useState } from 'react';
import type { UsageRangeSummary, UsageToolBuildObservation } from '../../shared/usageDashboard.js';
import { usageAxisCeiling, usageChartDate, usageChartTicks, usageGraphColors } from './usageGraphState.js';
import { useUsageChartWidth, usageNumber, usagePercent } from './usageDashboardState.js';
import { usageBucketLabel, usageDatePosition } from './usageTrendState.js';
import { defaultUsageToolSelection, usageToolErrorSegments, usageToolErrorSeries, type UsageToolErrorPoint } from './usageToolErrorTrendState.js';
import './usageToolErrorTrend.css';

type BuildMarker = { date: string; sha: string; dirty: boolean; firstObservedAt: string; requests: number; results: number; errors: number; tools: { id: string; label: string; build: UsageToolBuildObservation }[] };
type Active = { kind: 'point'; toolId: string; point: UsageToolErrorPoint } | { kind: 'build'; marker: BuildMarker } | null;

const exactRate = (errors: number, results: number) => results ? usagePercent(errors / results * 100) : 'No matched results';
const countLabel = (value: number, singular: string) => `${usageNumber(value)} ${singular}${value === 1 ? '' : 's'}`;
const markerKey = (marker: BuildMarker) => `${marker.date}:${marker.sha}:${marker.dirty}`;

export function UsageToolErrorTrend({ summary, timezone }: { summary: UsageRangeSummary; timezone?: string }) {
    const observedTime = (at: string) => new Intl.DateTimeFormat('en-US', { timeZone: timezone, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(at));
    const defaults = defaultUsageToolSelection(summary);
    const [chosen, setChosen] = useState<string[]>(defaults);
    const valid = chosen.filter(id => summary.tools.some(tool => tool.id === id));
    const selected = valid.length || chosen.length === 0 ? valid : defaults;
    const series = usageToolErrorSeries(summary, selected);
    const markerMap = new Map<string, BuildMarker>();
    for (const item of series) for (const point of item.points) for (const build of point.builds) {
        const key = `${point.date}:${build.sha}:${build.dirty}`;
        let marker = markerMap.get(key);
        if (!marker) {
            marker = { date: point.date, sha: build.sha, dirty: build.dirty, firstObservedAt: build.firstObservedAt, requests: 0, results: 0, errors: 0, tools: [] };
            markerMap.set(key, marker);
        }
        marker.requests += build.requests;
        marker.results += build.results;
        marker.errors += build.errors;
        marker.tools.push({ id: item.id, label: item.label, build });
        if (build.firstObservedAt < marker.firstObservedAt) marker.firstObservedAt = build.firstObservedAt;
    }
    const buildMarkers = [...markerMap.values()].sort((a, b) => a.date.localeCompare(b.date) || a.firstObservedAt.localeCompare(b.firstObservedAt) || a.sha.localeCompare(b.sha));
    const buildMarkerLanes = new Map<BuildMarker, number>();
    const lanesByDate = new Map<string, number>();
    for (const marker of buildMarkers) { const lane = lanesByDate.get(marker.date) ?? 0; buildMarkerLanes.set(marker, lane); lanesByDate.set(marker.date, lane + 1); }
    const colors = usageGraphColors(summary.tools.map(tool => tool.id));
    const chart = useUsageChartWidth();
    const [active, setActive] = useState<Active>(null);
    const [pinned, setPinned] = useState<Active>(null);
    const [showBuilds, setShowBuilds] = useState(true);
    const [focusedMarker, setFocusedMarker] = useState(0);
    const height = chart.width < 360 ? 156 : 176, top = 24, bottom = height - 25, left = 42, right = chart.width - 10;
    const x = (date: string) => left + usageDatePosition(summary, date) * (right - left);
    const peak = Math.max(0, ...series.flatMap(item => item.points.map(point => point.rate ?? 0)));
    const ceiling = Math.min(100, Math.max(10, usageAxisCeiling(peak * 1.15)));
    const tickCount = Math.max(1, Math.round(ceiling / 25));
    const y = (rate: number) => bottom - rate / ceiling * (bottom - top);
    const ticks = usageChartTicks(summary.startDate, summary.endDateExclusive, right - left);
    const includeYear = Date.parse(`${summary.endDateExclusive}T00:00:00.000Z`) - Date.parse(`${summary.startDate}T00:00:00.000Z`) > 365 * 86_400_000;
    const markerFocus = Math.min(focusedMarker, Math.max(0, buildMarkers.length - 1));
    const toggle = (id: string) => setChosen(current => {
        const base = current.filter(item => summary.tools.some(tool => tool.id === item));
        return base.includes(id) ? base.filter(item => item !== id) : [...base, id];
    });
    const pinnedPoint = pinned?.kind === 'point' ? series.find(item => item.id === pinned.toolId)?.points.find(point => point.date === pinned.point.date) : null;
    const pinnedBuild = pinned?.kind === 'build' && showBuilds ? buildMarkers.find(marker => markerKey(marker) === markerKey(pinned.marker)) : null;
    const shown = active ?? (pinned?.kind === 'point' && pinnedPoint ? { kind: 'point' as const, toolId: pinned.toolId, point: pinnedPoint } : pinnedBuild ? { kind: 'build' as const, marker: pinnedBuild } : null);
    const activeTool = shown?.kind === 'point' ? summary.tools.find(tool => tool.id === shown.toolId) : null;
    const pin = (item: Exclude<Active, null>) => { setPinned(current => current?.kind === item.kind && (item.kind === 'point' && current.kind === 'point' ? current.toolId === item.toolId && current.point.date === item.point.date : item.kind === 'build' && current.kind === 'build' && markerKey(current.marker) === markerKey(item.marker)) ? null : item); setActive(null); };

    return <section className="usage-tool-error-trend" aria-labelledby="usage-tool-error-title">
        <header><div><h3 id="usage-tool-error-title">Error rate over time</h3><p>Recorded errors / matched results</p></div>{buildMarkers.length > 0 && <button type="button" className="usage-tool-build-toggle" aria-pressed={showBuilds} onClick={() => setShowBuilds(value => !value)}><i aria-hidden="true"/>Commits</button>}</header>
        <div className="usage-tool-picker" role="group" aria-label="Tools shown in error rate graph">
            {summary.tools.map(tool => <button key={tool.id} type="button" aria-pressed={selected.includes(tool.id)} onClick={() => toggle(tool.id)}><svg width="7" height="7" aria-hidden="true"><circle cx="3.5" cy="3.5" r="3.5" fill={colors[tool.id]}/></svg>{tool.label}</button>)}
        </div>
        <svg ref={chart.ref} className="usage-tool-error-chart" viewBox={`0 0 ${chart.width} ${height}`} role="group" aria-label={`Recorded tool error rates from zero to ${ceiling} percent. Days without matched results are gaps.`}>
            {Array.from({ length: tickCount + 1 }, (_, index) => ceiling * index / tickCount).map(value => <g key={value}><text x={left - 7} y={y(value) + 4} textAnchor="end" className="usage-axis">{value}%</text><line x1={left} x2={right} y1={y(value)} y2={y(value)} className="usage-tool-error-grid"/></g>)}
            {series.map(item => <g key={item.id} className="usage-tool-error-series">
                {usageToolErrorSegments(item.points).map((segment, index) => <path key={index} d={segment.map((point, pointIndex) => `${pointIndex ? 'L' : 'M'}${x(point.date)},${y(point.rate!)}`).join(' ')} className="usage-tool-error-line" stroke={colors[item.id]}/>)}
                {item.points.filter(point => point.rate !== null).map(point => <g key={point.date} role="button" tabIndex={0} aria-pressed={pinned?.kind === 'point' && pinned.toolId === item.id && pinned.point.date === point.date} aria-label={`${item.label}: ${usagePercent(point.rate!)} on ${usageBucketLabel(summary, point.date)}. ${countLabel(point.errors, 'error')} / ${countLabel(point.results, 'matched result')}.`}
                    onMouseEnter={() => setActive({ kind: 'point', toolId: item.id, point })} onMouseLeave={() => setActive(null)} onFocus={() => setActive({ kind: 'point', toolId: item.id, point })} onBlur={() => setActive(null)} onClick={() => pin({ kind: 'point', toolId: item.id, point })} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); pin({ kind: 'point', toolId: item.id, point }); } else if (event.key === 'Escape') { setActive(null); setPinned(null); } }}>
                    <title>{`${item.label}: ${usagePercent(point.rate!)} on ${usageBucketLabel(summary, point.date)}`}</title><circle cx={x(point.date)} cy={y(point.rate!)} r={active?.kind === 'point' && active.toolId === item.id && active.point.date === point.date ? 4.5 : 3} stroke={colors[item.id]}/>
                </g>)}
            </g>)}
            {showBuilds && buildMarkers.map((marker, index) => { const lane = buildMarkerLanes.get(marker)!; const toolSummary = marker.tools.map(tool => `${tool.label}: ${countLabel(tool.build.errors, 'error')} / ${countLabel(tool.build.results, 'matched result')}`).join(', '); return <g key={`${marker.date}:${marker.sha}:${marker.dirty}`} className="usage-tool-build-marker" tabIndex={index === markerFocus ? 0 : -1} aria-label={`Observed Cat Code build ${marker.sha.slice(0, 8)}${marker.dirty ? ' dirty' : ''}, first selected tool request recorded ${observedTime(marker.firstObservedAt)}, ${toolSummary}`}
                role="button" aria-pressed={pinned?.kind === 'build' && markerKey(pinned.marker) === markerKey(marker)} transform={`translate(${x(marker.date) + Math.floor(lane / 4) * 5},${top + 4 + lane % 4 * 6})`} onMouseEnter={() => setActive({ kind: 'build', marker })} onMouseLeave={() => setActive(null)} onFocus={() => { setFocusedMarker(index); setActive({ kind: 'build', marker }); }} onBlur={() => setActive(null)} onClick={() => pin({ kind: 'build', marker })} onKeyDown={event => {
                    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); const next = Math.max(0, Math.min(buildMarkers.length - 1, index + (event.key === 'ArrowRight' ? 1 : -1))); setFocusedMarker(next); event.currentTarget.ownerSVGElement?.querySelectorAll<SVGGElement>('.usage-tool-build-marker')[next]?.focus(); }
                    else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); pin({ kind: 'build', marker }); }
                    else if (event.key === 'Escape') { setActive(null); setPinned(null); }
                }}>
                <title>{`Observed Cat Code build ${marker.sha.slice(0, 8)}${marker.dirty ? ' dirty' : ''}`}</title><path d="M0 -3 L3 0 L0 3 L-3 0 Z" fill={colors[marker.tools[0]!.id]}/>
            </g>; })}
            {ticks.map((date, index) => <text key={date} x={x(date)} y={height - 3} textAnchor={index === 0 ? 'start' : index === ticks.length - 1 ? 'end' : 'middle'} className="usage-axis">{usageChartDate(date, includeYear)}</text>)}
        </svg>
        {!series.length ? <p className="usage-note">Select a tool to plot its recorded error rate.</p> : !series.some(item => item.points.some(point => point.results > 0)) ? <p className="usage-note">No matched results for the selected tools in this period.</p> : null}
        {shown?.kind === 'point' && activeTool && <div className="usage-tool-error-readout" role="status"><strong>{activeTool.label}, {usageBucketLabel(summary, shown.point.date)}</strong><span>{countLabel(shown.point.errors, 'error')} / {countLabel(shown.point.results, 'matched result')} ({exactRate(shown.point.errors, shown.point.results)}), {countLabel(shown.point.requests, 'request')}</span>{pinned && <button type="button" onClick={() => { setActive(null); setPinned(null); }}>Clear selection</button>}</div>}
        {shown?.kind === 'build' && <div className="usage-tool-error-readout" role="status"><strong>Cat Code build {shown.marker.sha.slice(0, 8)}{shown.marker.dirty ? ' dirty' : ''}, {usageBucketLabel(summary, shown.marker.date)}</strong><span>First selected tool request recorded {observedTime(shown.marker.firstObservedAt)}; {shown.marker.tools.map(tool => `${tool.label}: ${usageNumber(tool.build.errors)} / ${usageNumber(tool.build.results)} (${exactRate(tool.build.errors, tool.build.results)})`).join(', ')}</span>{pinned && <button type="button" onClick={() => { setActive(null); setPinned(null); }}>Clear selection</button>}</div>}
    </section>;
}
