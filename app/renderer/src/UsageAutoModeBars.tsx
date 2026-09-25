import { useState } from 'react';
import type { AutoModeUsageSummary } from '../../shared/usageAutoMode.js';
import { usageAxisCeiling } from './usageGraphState.js';
import { usageNumber, usagePercent } from './usageDashboardState.js';
import { autoModeAttempts, autoModeDisplaySeries, sortedAutoModeCategories } from './usageAutoModeState.js';
import './usageAutoModeBars.css';

function outcomeSeries(summary: AutoModeUsageSummary) {
    return autoModeDisplaySeries(summary);
}

function percent(count: number, total: number): string {
    return total ? `${(count / total * 100).toFixed(1)}%` : 'Not applicable';
}

function DecisionBars({ summary }: { summary: AutoModeUsageSummary }) {
    const [activePoint, setActivePoint] = useState<string | null>(null);
    const series = outcomeSeries(summary);
    const buckets = [...summary.buckets].sort((left, right) => left.date.localeCompare(right.date));
    const plotWidth = Math.max(640, buckets.length * 64), height = 220, left = 42, right = 12, top = 18, bottom = 32;
    const innerWidth = plotWidth - left - right, innerHeight = height - top - bottom;
    const totals = buckets.map(bucket => series.reduce((total, item) => total + item.points.find(point => point.date === bucket.date)!.count, 0));
    const allAttempts = autoModeAttempts(summary);
    const maximum = usageAxisCeiling(Math.max(0, ...totals));
    const barWidth = Math.max(10, Math.min(38, innerWidth / Math.max(1, buckets.length) * .68));
    const first = Date.parse(`${buckets[0]?.date ?? '1970-01-01'}T00:00:00.000Z`);
    const last = Date.parse(`${buckets.at(-1)?.date ?? '1970-01-01'}T00:00:00.000Z`);
    const x = (index: number) => last === first ? left + innerWidth / 2 : left + innerWidth * (Date.parse(`${buckets[index]!.date}T00:00:00.000Z`) - first) / (last - first);
    const y = (value: number) => top + innerHeight - value / maximum * innerHeight;
    const allUnavailable = summary.allTools.coverage.state === 'unavailable';

    return <section className="usage-auto-bars-chart" aria-labelledby="usage-auto-decisions-title">
        <header>
            <h3 id="usage-auto-decisions-title">Decisions over time</h3>
        </header>
        {allUnavailable ? <p className="usage-auto-bars-empty">Decision history unavailable</p> :
            autoModeAttempts(summary) === 0 ? <p className="usage-auto-bars-empty">No decisions</p> :
                <>
                    <div className="usage-auto-bars-scroll">
                        <svg className="usage-auto-decision-chart" viewBox={`0 0 ${plotWidth} ${height}`} role="img" aria-label="Automatic permission decisions by period">
                            {[0, .5, 1].map(fraction => {
                                const value = maximum * fraction;
                                return <g key={fraction}>
                                    <line className="usage-auto-bars-grid" x1={left} x2={plotWidth - right} y1={y(value)} y2={y(value)}/>
                                    <text className="usage-axis" x={left - 7} y={y(value) + 4} textAnchor="end">{usageNumber(value)}</text>
                                </g>;
                            })}
                            {buckets.map((bucket, index) => {
                                const total = totals[index]!;
                                let cumulative = 0;
                                return <g key={bucket.date} className={bucket.allTools.coverage.state === 'partial' ? 'usage-auto-bars-partial' : ''}>
                                    {series.map(item => {
                                        const count = item.points.find(point => point.date === bucket.date)!.count;
                                        const start = cumulative;
                                        cumulative += count;
                                        const pointLabel = `${bucket.date}: ${item.label}, ${usageNumber(count)}, ${allAttempts ? usagePercent(count / allAttempts * 100) : '0%'} of ${usageNumber(allAttempts)} attempts`;
                                        const pointId = `${bucket.date}:${item.group}`;
                                        return count > 0 && <rect key={item.group} className={`usage-auto-outcome-${item.group}`} x={x(index) - barWidth / 2} y={y(start + count)} width={barWidth} height={count / maximum * innerHeight} tabIndex={0} role="button" aria-label={pointLabel} onFocus={() => setActivePoint(pointId)} onClick={() => setActivePoint(current => current === pointId ? null : pointId)} onKeyDown={event => {
                                            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setActivePoint(pointId); }
                                            else if (event.key === 'Escape') setActivePoint(null);
                                        }}>
                                            <title>{pointLabel}</title>
                                        </rect>;
                                    })}
                                    {total === 0 && bucket.allTools.coverage.state === 'complete' && <line className="usage-auto-zero-bar" x1={x(index) - barWidth / 2} x2={x(index) + barWidth / 2} y1={y(0)} y2={y(0)}/>}
                                    <text className="usage-axis" x={x(index)} y={height - 9} textAnchor="middle">{bucket.date}</text>
                                </g>;
                            })}
                        </svg>
                    </div>
                    {activePoint && (() => {
                        const [date, group] = activePoint.split(':');
                        const item = series.find(candidate => candidate.group === group);
                        const count = item?.points.find(point => point.date === date)?.count ?? 0;
                        return item ? <p className="usage-auto-bars-readout" role="status">{date}: {item.label}, {usageNumber(count)} of {usageNumber(allAttempts)} attempts, {allAttempts ? usagePercent(count / allAttempts * 100) : '0%'}</p> : null;
                    })()}
                    <ul className="usage-auto-outcome-legend" aria-label="Decision outcomes">
                        {series.map(item => <li key={item.group} aria-label={item.group === 'error' ? 'Error. Includes review required, operational error, unknown outcome, and incomplete' : item.label} title={item.group === 'error' ? 'Includes review required, operational error, unknown outcome, and incomplete' : undefined}><i className={`usage-auto-outcome-${item.group}`} aria-hidden="true"/><span>{item.label}</span><b>{usageNumber(item.points.reduce((total, point) => total + point.count, 0))}</b></li>)}
                    </ul>
                </>}
    </section>;
}

function BlockReasonBars({ summary }: { summary: AutoModeUsageSummary }) {
    const blocked = summary.allTools.outcomes.policy_blocked;
    const categories = sortedAutoModeCategories(summary).filter(category => category.count > 0);
    const maximum = Math.max(0, ...categories.map(category => category.count));

    return <section className="usage-auto-bars-chart" aria-labelledby="usage-auto-block-reasons-title">
        <header>
            <h3 id="usage-auto-block-reasons-title">Block reasons</h3>
        </header>
        {summary.allTools.coverage.state === 'unavailable' ? <p className="usage-auto-bars-empty">Decision history unavailable</p> :
            blocked === 0 ? <p className="usage-auto-bars-empty">No policy blocks</p> :
                <>
                    <ol className="usage-auto-category-bars" aria-label={`${usageNumber(blocked)} recorded policy-blocked tool attempts`}>
                        {categories.map(category => <li key={category.key}>
                            <div><span>{category.label}</span><b>{usageNumber(category.count)}</b><small>{percent(category.count, blocked)}</small></div>
                            <svg viewBox="0 0 100 8" preserveAspectRatio="none" aria-hidden="true"><rect className="usage-auto-category-track" width="100" height="8" rx="2"/><rect className="usage-auto-category-fill" width={maximum ? category.count / maximum * 100 : 0} height="8" rx="2"/></svg>
                        </li>)}
                    </ol>
                </>}
    </section>;
}

export function UsageAutoModeBars({ summary }: { summary: AutoModeUsageSummary }) {
    return <div className="usage-auto-bars">
        <DecisionBars summary={summary}/>
        <BlockReasonBars summary={summary}/>
    </div>;
}
