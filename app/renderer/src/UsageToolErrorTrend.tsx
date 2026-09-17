import { useState } from 'react';
import type { UsageRangeSummary, UsageToolBuildObservation } from '../../shared/usageDashboard.js';
import { usageAxisCeiling, usageChartDate, usageChartTicks, usageGraphColors } from './usageGraphState.js';
import { useUsageChartWidth, usageNumber, usagePercent } from './usageDashboardState.js';
import { usageBucketLabel, usageDatePosition } from './usageTrendState.js';
import { defaultUsageToolSelection, usageBuildCoverage, usageToolErrorSegments, usageToolErrorSeries, type UsageToolErrorPoint } from './usageToolErrorTrendState.js';
import './usageToolErrorTrend.css';

type BuildMarker = { date: string; sha: string; dirty: boolean; firstObservedAt: string; requests: number; results: number; errors: number; tools: { id: string; label: string; build: UsageToolBuildObservation }[] };
type Active = { kind: 'point'; toolId: string; point: UsageToolErrorPoint } | { kind: 'build'; marker: BuildMarker } | null;

const exactRate = (errors: number, results: number) => results ? usagePercent(errors / results * 100) : 'No matched results';
const buildLabel = (build: UsageToolBuildObservation) => `${build.sha.slice(0, 8)}${build.dirty ? ' dirty' : ''}`;
const countLabel = (value: number, singular: string) => `${usageNumber(value)} ${singular}${value === 1 ? '' : 's'}`;

export function UsageToolErrorTrend({ summary }: { summary: UsageRangeSummary }) {
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
    const coverage = usageBuildCoverage(series);
    const chart = useUsageChartWidth();
    const [active, setActive] = useState<Active>(null);
    const [showBuilds, setShowBuilds] = useState(true);
    const [focusedMarker, setFocusedMarker] = useState(0);
    const height = chart.width < 360 ? 156 : 176, top = 24, bottom = height - 25, left = 42, right = chart.width - 10;
    const x = (date: string) => left + usageDatePosition(summary, date) * (right - left);
    const peak = Math.max(0, ...series.flatMap(item => item.points.map(point => point.rate ?? 0)));
    const ceiling = Math.min(100, Math.max(5, usageAxisCeiling(peak * 1.15)));
    const y = (rate: number) => bottom - rate / ceiling * (bottom - top);
    const ticks = usageChartTicks(summary.startInclusive, summary.endExclusive, right - left);
    const includeYear = Date.parse(summary.endExclusive) - Date.parse(summary.startInclusive) > 365 * 86_400_000;
    const markerFocus = Math.min(focusedMarker, Math.max(0, buildMarkers.length - 1));
    const toggle = (id: string) => setChosen(current => {
        const base = current.filter(item => summary.tools.some(tool => tool.id === item));
        return base.includes(id) ? base.filter(item => item !== id) : [...base, id];
    });
    const activeTool = active?.kind === 'point' ? summary.tools.find(tool => tool.id === active.toolId) : null;

    return <section className="usage-tool-error-trend" aria-labelledby="usage-tool-error-title">
        <header><div><h3 id="usage-tool-error-title">Error rate over time</h3><p>Recorded errors / matched results</p></div>{buildMarkers.length > 0 && <button type="button" className="usage-tool-build-toggle" aria-pressed={showBuilds} onClick={() => setShowBuilds(value => !value)}><i aria-hidden="true"/>Commits</button>}</header>
        <div className="usage-tool-picker" role="group" aria-label="Tools shown in error rate graph">
            {summary.tools.map(tool => <button key={tool.id} type="button" aria-pressed={selected.includes(tool.id)} onClick={() => toggle(tool.id)}><svg width="7" height="7" aria-hidden="true"><circle cx="3.5" cy="3.5" r="3.5" fill={colors[tool.id]}/></svg>{tool.label}</button>)}
        </div>
        <svg ref={chart.ref} className="usage-tool-error-chart" viewBox={`0 0 ${chart.width} ${height}`} role="group" aria-label={`Recorded tool error rates from zero to ${ceiling} percent. Days without matched results are gaps. Exact daily values follow the graph.`}>
            {[0, 1 / 3, 2 / 3, 1].map(fraction => { const value = ceiling * fraction; return <g key={fraction}><text x={left - 7} y={y(value) + 4} textAnchor="end" className="usage-axis">{Number(value.toFixed(1))}%</text><line x1={left} x2={right} y1={y(value)} y2={y(value)} className="usage-tool-error-grid"/></g>; })}
            {series.map(item => <g key={item.id} className="usage-tool-error-series">
                {usageToolErrorSegments(item.points).map((segment, index) => <path key={index} d={segment.map((point, pointIndex) => `${pointIndex ? 'L' : 'M'}${x(point.date)},${y(point.rate!)}`).join(' ')} className="usage-tool-error-line" stroke={colors[item.id]}/>)}
                {item.points.filter(point => point.rate !== null).map(point => <g key={point.date} aria-hidden="true"
                    onMouseEnter={() => setActive({ kind: 'point', toolId: item.id, point })} onMouseLeave={() => setActive(null)}>
                    <title>{`${item.label}: ${usagePercent(point.rate!)} on ${usageBucketLabel(summary, point.date)}`}</title><circle cx={x(point.date)} cy={y(point.rate!)} r={active?.kind === 'point' && active.toolId === item.id && active.point.date === point.date ? 4.5 : 3} stroke={colors[item.id]}/>
                </g>)}
            </g>)}
            {showBuilds && buildMarkers.map((marker, index) => { const lane = buildMarkerLanes.get(marker)!; const toolSummary = marker.tools.map(tool => `${tool.label}: ${countLabel(tool.build.errors, 'error')} / ${countLabel(tool.build.results, 'matched result')}`).join(', '); return <g key={`${marker.date}:${marker.sha}:${marker.dirty}`} className="usage-tool-build-marker" tabIndex={index === markerFocus ? 0 : -1} aria-label={`Observed Cat Code build ${marker.sha.slice(0, 8)}${marker.dirty ? ' dirty' : ''}, first selected tool request recorded ${marker.firstObservedAt}, ${toolSummary}`}
                transform={`translate(${x(marker.date) + Math.floor(lane / 4) * 5},${top + 4 + lane % 4 * 6})`} onMouseEnter={() => setActive({ kind: 'build', marker })} onMouseLeave={() => setActive(null)} onFocus={() => { setFocusedMarker(index); setActive({ kind: 'build', marker }); }} onBlur={() => setActive(null)} onKeyDown={event => {
                    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); const next = Math.max(0, Math.min(buildMarkers.length - 1, index + (event.key === 'ArrowRight' ? 1 : -1))); setFocusedMarker(next); event.currentTarget.ownerSVGElement?.querySelectorAll<SVGGElement>('.usage-tool-build-marker')[next]?.focus(); }
                }}>
                <title>{`Observed Cat Code build ${marker.sha.slice(0, 8)}${marker.dirty ? ' dirty' : ''}`}</title><path d="M0 -3 L3 0 L0 3 L-3 0 Z" fill={colors[marker.tools[0]!.id]}/>
            </g>; })}
            {ticks.map((date, index) => <text key={date} x={x(date)} y={height - 3} textAnchor={index === 0 ? 'start' : index === ticks.length - 1 ? 'end' : 'middle'} className="usage-axis">{usageChartDate(date, includeYear)}</text>)}
        </svg>
        {!series.length ? <p className="usage-note">Select a tool to plot its recorded error rate.</p> : !series.some(item => item.points.some(point => point.results > 0)) ? <p className="usage-note">No matched results for the selected tools in this period.</p> : null}
        {active?.kind === 'point' && activeTool && <div className="usage-tool-error-readout" role="status"><strong>{activeTool.label}, {usageBucketLabel(summary, active.point.date)}</strong><span>{countLabel(active.point.errors, 'error')} / {countLabel(active.point.results, 'matched result')} ({exactRate(active.point.errors, active.point.results)}), {countLabel(active.point.requests, 'request')}</span></div>}
        {active?.kind === 'build' && <div className="usage-tool-error-readout" role="status"><strong>Cat Code build {active.marker.sha.slice(0, 8)}{active.marker.dirty ? ' dirty' : ''}, {usageBucketLabel(summary, active.marker.date)}</strong><span>First selected tool request recorded {active.marker.firstObservedAt}; {active.marker.tools.map(tool => `${tool.label}: ${usageNumber(tool.build.errors)} / ${usageNumber(tool.build.results)} (${exactRate(tool.build.errors, tool.build.results)})`).join(', ')}</span></div>}
        {coverage.requests > 0 && coverage.unattributed > 0 && <p className="usage-note">Cat Code build commit recorded for {usageNumber(coverage.attributed)} of {usageNumber(coverage.requests)} selected tool requests.</p>}
        {coverage.omittedBuilds > 0 && <p className="usage-note">{usageNumber(coverage.omittedBuilds)} build {coverage.omittedBuilds === 1 ? 'marker is' : 'markers are'} omitted.</p>}
        <details className="usage-tool-error-values"><summary>Exact selected tool values</summary><div className="usage-table-scroll"><table><caption>Recorded tool errors by UTC period</caption><thead><tr><th scope="col">Period</th><th scope="col">Tool</th><th scope="col">Requests</th><th scope="col">Matched results</th><th scope="col">Errors</th><th scope="col">Error rate</th><th scope="col">Observed builds</th></tr></thead><tbody>{series.flatMap(item => item.points.filter(point => point.requests > 0).map(point => <tr key={`${item.id}:${point.date}`}><th scope="row">{usageBucketLabel(summary, point.date)}</th><td>{item.label}</td><td>{usageNumber(point.requests)}</td><td>{usageNumber(point.results)}</td><td>{usageNumber(point.errors)}</td><td>{exactRate(point.errors, point.results)}</td><td>{point.builds.length ? point.builds.map(buildLabel).join(', ') : 'Unavailable'}</td></tr>))}</tbody></table></div></details>
    </section>;
}
