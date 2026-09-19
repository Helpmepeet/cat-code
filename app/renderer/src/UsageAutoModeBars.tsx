import type { AutoModeUsageOutcome, AutoModeUsageSummary } from '../../shared/usageAutoMode.js';
import { usageAxisCeiling } from './usageGraphState.js';
import { usageNumber } from './usageDashboardState.js';
import { AUTO_MODE_OUTCOMES, autoModeAttempts, autoModeOutcomeSeries, sortedAutoModeCategories } from './usageAutoModeState.js';
import './usageAutoModeBars.css';

const OUTCOME_LABELS: Record<AutoModeUsageOutcome, string> = {
    allowed: 'Allowed',
    policy_blocked: 'Policy blocked',
    review_required: 'Review required',
    operational_error: 'Operational error',
    cancelled: 'Cancelled',
    unknown_outcome: 'Unknown',
    incomplete: 'Incomplete',
};

function outcomeSeries(summary: AutoModeUsageSummary) {
    return autoModeOutcomeSeries(summary).filter(series =>
        summary.allTools.outcomes[series.outcome] > 0,
    );
}

function coverageLabel(state: AutoModeUsageSummary['allTools']['coverage']['state']): string {
    return state === 'complete' ? 'Complete' : state === 'partial' ? 'Partial' : 'Unavailable';
}

function percent(count: number, total: number): string {
    return total ? `${(count / total * 100).toFixed(1)}%` : 'Not applicable';
}

function DecisionBars({ summary }: { summary: AutoModeUsageSummary }) {
    const series = outcomeSeries(summary);
    const buckets = [...summary.buckets].sort((left, right) => left.date.localeCompare(right.date));
    const plotWidth = Math.max(640, buckets.length * 64), height = 220, left = 42, right = 12, top = 18, bottom = 32;
    const innerWidth = plotWidth - left - right, innerHeight = height - top - bottom;
    const totals = buckets.map(bucket => AUTO_MODE_OUTCOMES.reduce((total, outcome) => total + bucket.allTools.outcomes[outcome], 0));
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
        {summary.allTools.coverage.state === 'partial' && <p className="usage-auto-bars-note">Partial history</p>}
        {allUnavailable ? <p className="usage-auto-bars-empty">Decision history unavailable</p> :
            autoModeAttempts(summary) === 0 ? <p className="usage-auto-bars-empty">No decisions</p> :
                <>
                    <div className="usage-auto-bars-scroll">
                        <svg className="usage-auto-decision-chart" viewBox={`0 0 ${plotWidth} ${height}`} role="img" aria-label="Recorded automatic permission decisions by UTC period. Exact values follow the graph.">
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
                                        const count = bucket.allTools.outcomes[item.outcome];
                                        const start = cumulative;
                                        cumulative += count;
                                        return count > 0 && <rect key={item.outcome} className={`usage-auto-outcome-${item.outcome}`} x={x(index) - barWidth / 2} y={y(start + count)} width={barWidth} height={count / maximum * innerHeight}>
                                            <title>{`${bucket.date}: ${OUTCOME_LABELS[item.outcome]}, ${usageNumber(count)}`}</title>
                                        </rect>;
                                    })}
                                    {total === 0 && bucket.allTools.coverage.state === 'complete' && <line className="usage-auto-zero-bar" x1={x(index) - barWidth / 2} x2={x(index) + barWidth / 2} y1={y(0)} y2={y(0)}/>}
                                    <text className="usage-axis" x={x(index)} y={height - 9} textAnchor="middle">{bucket.date}</text>
                                </g>;
                            })}
                        </svg>
                    </div>
                    <ul className="usage-auto-outcome-legend" aria-label="Decision outcomes">
                        {series.map(item => <li key={item.outcome}><i className={`usage-auto-outcome-${item.outcome}`} aria-hidden="true"/><span>{OUTCOME_LABELS[item.outcome]}</span><b>{usageNumber(summary.allTools.outcomes[item.outcome])}</b></li>)}
                    </ul>
                    <details className="usage-auto-bars-values">
                        <summary>Exact decision values</summary>
                        <div className="usage-table-scroll"><table>
                            <caption>Recorded automatic permission decisions by UTC period</caption>
                            <thead><tr><th scope="col">Period</th><th scope="col">Coverage</th>{series.map(item => <th scope="col" key={item.outcome}>{OUTCOME_LABELS[item.outcome]}</th>)}<th scope="col">Total</th></tr></thead>
                            <tbody>{buckets.map((bucket, index) => <tr key={bucket.date}><th scope="row">{bucket.date}</th><td>{coverageLabel(bucket.allTools.coverage.state)}</td>{series.map(item => <td key={item.outcome}>{usageNumber(bucket.allTools.outcomes[item.outcome])}</td>)}<td>{usageNumber(totals[index]!)}</td></tr>)}</tbody>
                        </table></div>
                    </details>
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
        {summary.allTools.coverage.state === 'partial' && <p className="usage-auto-bars-note">Partial history</p>}
        {summary.allTools.coverage.state === 'unavailable' ? <p className="usage-auto-bars-empty">Decision history unavailable</p> :
            blocked === 0 ? <p className="usage-auto-bars-empty">No policy blocks</p> :
                <>
                    <ol className="usage-auto-category-bars" aria-label={`${usageNumber(blocked)} recorded policy-blocked tool attempts`}>
                        {categories.map(category => <li key={category.key}>
                            <div><span>{category.label}</span><b>{usageNumber(category.count)}</b><small>{percent(category.count, blocked)}</small></div>
                            <svg viewBox="0 0 100 8" preserveAspectRatio="none" aria-hidden="true"><rect className="usage-auto-category-track" width="100" height="8" rx="2"/><rect className="usage-auto-category-fill" width={maximum ? category.count / maximum * 100 : 0} height="8" rx="2"/></svg>
                        </li>)}
                    </ol>
                    <details className="usage-auto-bars-values">
                        <summary>Exact block-reason values</summary>
                        <table>
                            <caption>Recorded policy-blocked tool attempts by category</caption>
                            <thead><tr><th scope="col">Category</th><th scope="col">Policy blocks</th><th scope="col">Share of policy blocks</th></tr></thead>
                            <tbody>{categories.map(category => <tr key={category.key}><th scope="row">{category.label}</th><td>{usageNumber(category.count)}</td><td>{percent(category.count, blocked)}</td></tr>)}</tbody>
                            <tfoot><tr><th scope="row">Total policy blocks</th><td>{usageNumber(blocked)}</td><td>100.0%</td></tr></tfoot>
                        </table>
                    </details>
                </>}
    </section>;
}

export function UsageAutoModeBars({ summary }: { summary: AutoModeUsageSummary }) {
    return <div className="usage-auto-bars">
        <DecisionBars summary={summary}/>
        <BlockReasonBars summary={summary}/>
    </div>;
}
