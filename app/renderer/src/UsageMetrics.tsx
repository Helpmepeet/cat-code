import { useId } from 'react';
import { usageMetricDelta } from './usageMetricDelta.js';
import type { UsageRangeSummary } from '../../shared/usageDashboard.js';
import { usageCompact, usageNumber, usagePercent } from './usageDashboardState.js';
import { usageCacheCoverageLabel, usageLatestBuild, usageModelRequestCount, usageToolRate, usageRangeOutcomes, type UsageDailyMetric } from './usageDailyChartState.js';

function MetricSpark({ values, color }: { values: readonly (number | null)[]; color: string }) {
    const id = `usage-spark-${useId().replaceAll(':', '')}`;
    const points = values.flatMap((value, index) => value === null ? [] : [{ value, index }]);
    if (points.length < 2) return null;
    const low = Math.min(...points.map(point => point.value)), high = Math.max(...points.map(point => point.value));
    const pad = (high - low) * .1 || Math.abs(high) * .1 || 1;
    const x = (index: number) => 2 + index / Math.max(1, values.length - 1) * 61;
    const y = (value: number) => 27 - (value - low + pad) / (high - low + pad * 2) * 24;
    const line = points.map((point, index) => `${index ? 'L' : 'M'}${x(point.index)},${y(point.value)}`).join(' ');
    const last = points.at(-1)!;
    return <svg viewBox="0 0 68 32" aria-hidden="true"><defs><linearGradient id={id} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={color} stopOpacity=".26"/><stop offset="1" stopColor={color} stopOpacity="0"/></linearGradient></defs><path d={`${line}L${x(last.index)},32L${x(points[0]!.index)},32Z`} fill={`url(#${id})`}/><path d={line} stroke={color} strokeWidth="1.75" fill="none" strokeLinecap="round" strokeLinejoin="round"/><circle cx={x(last.index)} cy={y(last.value)} r="3" fill={color} stroke="var(--usage-panel)" strokeWidth="1.5"/></svg>;
}
function BuildSpark({ builds }: { builds: ReturnType<typeof usageLatestBuild> }) {
    const recent = builds.items.slice(-10), ceiling = Math.max(.1, builds.median ?? 0, ...recent.map(build => usageToolRate(build) ?? 0)) * 1.15;
    const x = (index: number) => 6 + index / Math.max(1, recent.length - 1) * 166;
    const y = (rate: number) => 35 - rate / ceiling * 29;
    const color = (build: typeof recent[number]) => builds.median !== null && (usageToolRate(build) ?? 0) > builds.median * 1.5 ? 'var(--usage-errors)' : build === builds.latest ? 'var(--accent)' : 'var(--usage-secondary)';
    return <svg className="usage-build-mini" viewBox="0 0 180 40" aria-hidden="true">{builds.median !== null && <line x1="0" x2="180" y1={y(builds.median)} y2={y(builds.median)} className="usage-average-line"/>}<path d={recent.map((build, index) => `${index ? 'L' : 'M'}${x(index)},${y(usageToolRate(build) ?? 0)}`).join(' ')} fill="none" stroke="var(--usage-grid)" strokeWidth="1.5"/>{recent.map((build, index) => <circle key={`${build.sha}:${build.dirty}`} cx={x(index)} cy={y(usageToolRate(build) ?? 0)} r={build === builds.latest ? 5 : 3.5} fill={build.dirty ? 'var(--usage-panel)' : color(build)} stroke={color(build)} strokeWidth={build.dirty ? 1.75 : 0}/>)}</svg>;
}
export function UsageMetrics({ summary, unknown, partial, metric = 'tokens', onMetricChange, onCacheSelect, onBuildSelect }: { summary?: UsageRangeSummary; unknown: string; partial: boolean; metric?: UsageDailyMetric; onMetricChange?: (metric: UsageDailyMetric) => void; onCacheSelect?: () => void; onBuildSelect?: () => void }) {
    const previous = !partial && summary?.range !== 'all' ? summary?.previousPeriod : undefined;
    const delta = (current: number | null, baseline: number | null | undefined, points = false) => previous ? usageMetricDelta(current, baseline ?? null, points ? 'points' : 'percent') : null;
    const comparison = `vs prior ${summary?.range === '7d' ? '7' : '30'} days`;
    const errorRate = summary ? usageToolRate(usageRangeOutcomes(summary)) : null;
    const items = [
        { id: 'requests' as const, label: 'Model requests', value: summary ? usageCompact(usageModelRequestCount(summary)) : unknown, color: 'var(--usage-category-0)', delta: delta(summary ? usageModelRequestCount(summary) : null, previous?.modelRequests), series: summary?.days.map(usageModelRequestCount) ?? [], action: () => onMetricChange?.('requests') },
        { id: 'sessions' as const, label: 'Sessions', value: summary ? usageNumber(summary.sessions) : unknown, color: 'var(--usage-category-2)', delta: delta(summary?.sessions ?? null, previous?.sessions), series: summary?.days.map(day => day.sessions) ?? [], action: () => onMetricChange?.('sessions') },
        { id: 'cache' as const, label: 'Input from cache', value: summary?.cachedInputShare == null ? unknown : usagePercent(summary.cachedInputShare), color: 'var(--accent)', delta: delta(summary?.cachedInputShare ?? null, previous?.cachedInputShare, true), series: summary?.days.map(day => { const input = day.tokens.fresh + day.tokens.read + day.tokens.write; return input ? day.tokens.read / input * 100 : null; }) ?? [], action: () => onCacheSelect?.() },
        { id: 'errorRate' as const, label: 'Tool error rate', value: errorRate === null ? unknown : usagePercent(errorRate), color: 'var(--usage-errors)', delta: delta(errorRate, previous ? usageToolRate(previous) : null, true), series: summary?.days.map(usageToolRate) ?? [], action: () => onMetricChange?.('errorRate') },
    ];
    const builds = summary ? usageLatestBuild(summary) : null;
    return <section className="usage-overview" aria-label="Analytics overview"><div className="usage-cards">{items.map(item => <button type="button" className={`usage-metric usage-metric-${item.id}`} key={item.label} aria-current={metric === item.id ? 'true' : undefined} onClick={item.action}><span className="usage-metric-label">{item.label}</span><span className="usage-metric-row"><strong>{item.value}</strong><MetricSpark values={item.series} color={item.color}/></span><span className="usage-metric-foot">{item.id === 'cache' && summary && usageCacheCoverageLabel(summary.cacheWriteReporting) && <span className="usage-cache-coverage">{usageCacheCoverageLabel(summary.cacheWriteReporting)}</span>}{item.delta && <span className={`usage-metric-delta usage-delta-${item.delta.direction}`} aria-label={`${item.label}: ${item.delta.description}, ${comparison}`}><b>{item.delta.text}</b> {comparison}</span>}</span></button>)}<button type="button" className="usage-metric usage-latest-build" title={builds?.latest ? "Latest build with at least 200 tool results; newer builds below that threshold are excluded." : "No builds have at least 200 tool results in this range."} onClick={onBuildSelect} disabled={!builds?.latest}><span className="usage-build-head"><span className="usage-metric-label">Latest build errors</span><code>{builds?.latest ? `${builds.latest.sha.slice(0, 7)}${builds.latest.dirty ? '*' : ''}` : ''}</code></span><span className="usage-metric-row"><strong>{builds?.latest && usageToolRate(builds.latest) !== null ? usagePercent(usageToolRate(builds.latest)!) : unknown}</strong></span><span className="usage-note">{builds?.median != null ? `≥200 results · median ${usagePercent(builds.median)}` : 'No builds with ≥200 results'}</span>{builds && <BuildSpark builds={builds}/>}</button></div></section>;
}
