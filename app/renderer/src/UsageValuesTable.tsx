import { useState } from 'react';
import type { AutoModeUsageOutcome, AutoModeUsagePopulation } from '../../shared/usageAutoMode.js';
import type { UsageRangeSummary } from '../../shared/usageDashboard.js';
import { autoModeCommandRatePoints } from './usageAutoModeState.js';
import { usageNumber, usagePercent, usageShare, usageTotal } from './usageDashboardState.js';
import { usageBucketLabel } from './usageTrendState.js';
import { usageHourLabel } from './usageGraphState.js';

const outcomes: readonly { key: AutoModeUsageOutcome; label: string }[] = [
    { key: 'allowed', label: 'Allowed' },
    { key: 'policy_blocked', label: 'Blocked' },
    { key: 'review_required', label: 'Needs review' },
    { key: 'operational_error', label: 'Operational error' },
    { key: 'cancelled', label: 'Cancelled' },
    { key: 'unknown_outcome', label: 'Unknown' },
    { key: 'incomplete', label: 'Incomplete' },
];
const routeLabels: Record<string, string> = {
    base: 'Base checks', forced: 'Forced', guard: 'Safety check', accept_edits: 'Accept edits',
    allowlist: 'Allow rules', stage1: 'First review', stage2: 'Second review', unknown: 'Unknown',
};

function Cell({ value, available = true }: { value: number; available?: boolean }) {
    return <td aria-label={available ? undefined : 'Unavailable'}>{available ? usageNumber(value) : '–'}</td>;
}

function outcomeCells(population: AutoModeUsagePopulation) {
    return outcomes.map(({ key }) => <Cell key={key} value={population.outcomes[key]} available={population.coverage.state !== 'unavailable'}/>);
}

export function UsageValuesTable({ summary, hourlySummary, asOf, timezone, partial }: { summary: UsageRangeSummary; hourlySummary: UsageRangeSummary; asOf: string; timezone: string; partial: boolean }) {
    const [open, setOpen] = useState(false);
    const toolDays = summary.days.flatMap(day => day.tools.map(tool => ({ date: day.date, tool })));
    const builds = summary.days.flatMap(day => day.tools.flatMap(tool => (tool.builds?.items ?? []).map(build => ({ date: day.date, tool, build }))));
    const commandRates = autoModeCommandRatePoints(summary.autoMode);
    return <details className="usage-values" onToggle={event => setOpen(event.currentTarget.open)}>
        <summary>View as table</summary>
        {open && <div className="usage-values-sections">
            <section><h2>Tokens and prompt cache</h2><div className="usage-table-scroll"><table>
                <caption>Recorded tokens by local period, full counts</caption>
                <thead><tr><th scope="col">Period</th><th scope="col">Input</th><th scope="col">Cache reads</th><th scope="col">Cache writes</th><th scope="col">Output</th><th scope="col">Total</th><th scope="col">Cache share</th><th scope="col">Sessions</th><th scope="col">Tool requests</th></tr></thead>
                <tbody>{summary.days.map(day => <tr key={day.date}><th scope="row">{usageBucketLabel(summary, day.date)}</th><Cell value={day.tokens.fresh}/><Cell value={day.tokens.read}/><Cell value={day.tokens.write} available={day.cacheWriteReporting === 'reported'}/><Cell value={day.tokens.output}/><Cell value={usageTotal(day.tokens)}/><td>{!partial && day.cacheWriteReporting === 'reported' && usageShare(day.tokens) !== null ? usagePercent(usageShare(day.tokens)) : '–'}</td><Cell value={day.sessions}/><Cell value={day.requests}/></tr>)}</tbody>
            </table></div><p className="usage-values-definition">Cache share = cache reads / (input + cache reads + cache writes). Cache in the Tokens chart combines reads and writes.</p></section>
            <section><h2>Models</h2><div className="usage-table-scroll"><table>
                <caption>Recorded tokens by model and local period</caption><thead><tr><th scope="col">Period</th>{summary.models.map(model => <th scope="col" key={model.id}>{model.label}</th>)}</tr></thead>
                <tbody>{summary.days.map(day => <tr key={day.date}><th scope="row">{usageBucketLabel(summary, day.date)}</th>{summary.models.map(model => <Cell key={model.id} value={day.models.find(item => item.id === model.id)?.total ?? 0}/>)}</tr>)}</tbody>
            </table></div>{summary.detail.omittedModels > 0 && <p className="usage-values-definition">Other groups {usageNumber(summary.detail.omittedModels)} models.</p>}</section>
            <section><h2>Tools</h2><div className="usage-table-scroll"><table>
                <caption>Recorded tool outcomes</caption><thead><tr><th scope="col">Tool</th><th scope="col">Requests</th><th scope="col">Successful</th><th scope="col">Errors</th><th scope="col">No result</th></tr></thead>
                <tbody>{summary.tools.map(tool => <tr key={tool.id}><th scope="row">{tool.label}</th><Cell value={tool.requests}/><Cell value={tool.results - tool.errors}/><Cell value={tool.errors}/><Cell value={tool.requests - tool.results}/></tr>)}</tbody>
            </table></div><div className="usage-table-scroll"><table>
                <caption>Tool error rate by local period</caption><thead><tr><th scope="col">Period</th><th scope="col">Tool</th><th scope="col">Requests</th><th scope="col">Matched results</th><th scope="col">Errors</th><th scope="col">Error rate</th></tr></thead>
                <tbody>{toolDays.map(({ date, tool }) => <tr key={`${date}:${tool.id}`}><th scope="row">{usageBucketLabel(summary, date)}</th><td>{summary.tools.find(item => item.id === tool.id)?.label ?? tool.id}</td><Cell value={tool.requests}/><Cell value={tool.results}/><Cell value={tool.errors}/><td>{tool.results ? usagePercent(tool.errors / tool.results * 100) : '–'}</td></tr>)}</tbody>
            </table></div>{builds.length > 0 && <div className="usage-table-scroll"><table>
                <caption>Observed Cat Code builds</caption><thead><tr><th scope="col">Period</th><th scope="col">Tool</th><th scope="col">Commit</th><th scope="col">First observed</th><th scope="col">Requests</th><th scope="col">Matched results</th><th scope="col">Errors</th></tr></thead>
                <tbody>{builds.map(({ date, tool, build }, index) => <tr key={`${date}:${tool.id}:${build.sha}:${index}`}><th scope="row">{usageBucketLabel(summary, date)}</th><td>{summary.tools.find(item => item.id === tool.id)?.label ?? tool.id}</td><td>{build.sha.slice(0, 8)}{build.dirty ? ' dirty' : ''}</td><td>{new Intl.DateTimeFormat('en-US', { timeZone: timezone, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(build.firstObservedAt))}</td><Cell value={build.requests}/><Cell value={build.results}/><Cell value={build.errors}/></tr>)}</tbody>
            </table></div>}</section>
            {hourlySummary.days.some(day => day.hours?.length) && <section><h2>Activity by hour</h2><div className="usage-table-scroll"><table>
                <caption>Recorded activity by local hour</caption><thead><tr><th scope="col">Day</th><th scope="col">Hour</th><th scope="col">UTC offset</th><th scope="col">Tokens</th><th scope="col">Tool requests</th></tr></thead>
                <tbody>{hourlySummary.days.flatMap(day => (day.hours ?? []).map((hour, index) => { const future = !!hour.startAt && Date.parse(hour.startAt) > Date.parse(asOf); return <tr key={`${day.date}:${index}`}><th scope="row">{day.date}</th><td>{usageHourLabel(hour)}</td><td>{hour.offsetMinutes >= 0 ? '+' : '−'}{String(Math.floor(Math.abs(hour.offsetMinutes) / 60)).padStart(2, '0')}:{String(Math.abs(hour.offsetMinutes) % 60).padStart(2, '0')}</td><Cell value={hour.tokens ?? 0} available={!future && hour.tokens !== undefined}/><Cell value={hour.requests} available={!future}/></tr>; }))}</tbody>
            </table></div></section>}
            <section><h2>Auto mode</h2><div className="usage-table-scroll"><table>
                <caption>Raw decision outcomes by local period</caption><thead><tr><th scope="col">Period</th><th scope="col">Coverage</th>{outcomes.map(outcome => <th scope="col" key={outcome.key}>{outcome.label}</th>)}</tr></thead>
                <tbody>{summary.autoMode.buckets.map(bucket => <tr key={bucket.date}><th scope="row">{usageBucketLabel(summary, bucket.date)}</th><td>{bucket.allTools.coverage.state}</td>{outcomeCells(bucket.allTools)}</tr>)}</tbody>
            </table></div><div className="usage-table-scroll"><table>
                <caption>Command block rate by local period</caption><thead><tr><th scope="col">Period</th><th scope="col">Blocked</th><th scope="col">All command attempts</th><th scope="col">Rate</th></tr></thead>
                <tbody>{commandRates.map(point => <tr key={point.date}><th scope="row">{usageBucketLabel(summary, point.date)}</th><Cell value={point.numerator} available={point.state !== 'unavailable'}/><Cell value={point.denominator} available={point.state !== 'unavailable'}/><td>{point.rate === null ? '–' : usagePercent(point.rate * 100)}</td></tr>)}</tbody>
            </table></div><div className="usage-table-scroll"><table>
                <caption>Decision routes and raw outcomes</caption><thead><tr><th scope="col">Route</th><th scope="col">Outcome</th><th scope="col">Attempts</th></tr></thead>
                <tbody>{summary.autoMode.routes.map((route, index) => <tr key={`${route.route}:${route.outcome}:${index}`}><th scope="row">{routeLabels[route.route] ?? 'Unknown'}</th><td>{outcomes.find(item => item.key === route.outcome)?.label ?? 'Unknown'}</td><Cell value={route.count}/></tr>)}</tbody>
            </table></div><div className="usage-table-scroll"><table>
                <caption>Block reasons</caption><thead><tr><th scope="col">Reason</th><th scope="col">Attempts</th></tr></thead>
                <tbody>{summary.autoMode.categories.map(category => <tr key={category.key}><th scope="row">{category.label}</th><Cell value={category.count}/></tr>)}</tbody>
            </table></div></section>
        </div>}
    </details>;
}
