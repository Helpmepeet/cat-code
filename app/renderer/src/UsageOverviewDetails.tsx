import { useState } from 'react';
import type { UsageRangeSummary } from '../../shared/usageDashboard.js';
import { UsageAreaTrend } from './UsageAreaTrend.js';
import { usageBucketDays, usageHasCacheWrites } from './usageTrendState.js';
import { UsageCacheChart } from './UsageDashboardCharts.js';
import { UsageToolErrors } from './UsageActivityCharts.js';
import { usageCacheWrites, usageCompact, usageNumber, usagePercent, usageTotal } from './usageDashboardState.js';

export function UsageModelDonut({ summary, colors }: { summary: UsageRangeSummary; colors: Record<string, string> }) {
    const [highlighted, setHighlighted] = useState('');
    const total = usageTotal(summary.tokens);
    const active = summary.models.find(model => model.id === highlighted);
    let offset = 0;
    return <div className="usage-model-mix">
        <svg className="usage-model-donut" viewBox="0 0 160 160" role="img" aria-label={`Model usage: ${usageNumber(total)} tokens`}>
            <circle cx="80" cy="80" r="60" fill="none" strokeWidth="18" className="usage-donut-track"/>
            {summary.models.map(model => {
                const share = total ? usageTotal(model.tokens) / total * 100 : 0, start = offset;
                offset += share;
                return share > 0 && <circle key={model.id} className={active && active.id !== model.id ? 'usage-model-muted' : ''} cx="80" cy="80" r="60" fill="none" stroke={colors[model.id]} strokeWidth="18" pathLength="100" strokeDasharray={`${share} ${100 - share}`} strokeDashoffset={-start} transform="rotate(-90 80 80)"><title>{`${model.label}: ${usageNumber(usageTotal(model.tokens))} tokens, ${share.toFixed(1)}%`}</title></circle>;
            })}
            <text x="80" y="79" textAnchor="middle" className="usage-donut-total">{usageCompact(active ? usageTotal(active.tokens) : total)}</text>
            <text x="80" y="96" textAnchor="middle" className="usage-donut-label">tokens</text>
        </svg>
        <ul className="usage-model-key">{summary.models.map(model => <li key={model.id}><button type="button" aria-pressed={active?.id === model.id} className={active && active.id !== model.id ? 'usage-model-muted' : ''} onClick={() => setHighlighted(highlighted === model.id ? '' : model.id)}>
            <svg width="8" height="8" aria-hidden="true"><rect width="8" height="8" rx="2" fill={colors[model.id]}/></svg>
            <span>{model.label}<small title={`${usageNumber(usageTotal(model.tokens))} tokens`}>{usageCompact(usageTotal(model.tokens))} · {usagePercent(total ? usageTotal(model.tokens) / total * 100 : 0)}</small></span>
        </button></li>)}</ul>
    </div>;
}

export function UsageCacheSummary({ summary, partial }: { summary: UsageRangeSummary; partial: boolean }) {
    const [selected, setSelected] = useState('');
    const showWrites = usageHasCacheWrites(summary);
    const input = summary.tokens.fresh + summary.tokens.read + summary.tokens.write;
    const readShare = input ? summary.tokens.read / input * 100 : 0;
    const freshShare = input ? summary.tokens.fresh / input * 100 : 0;
    return <>
        <h3 className="usage-trend-heading">{usageBucketDays(summary) > 1 ? 'Cache trend' : 'Daily cache trend'}</h3>
        <UsageCacheChart summary={summary} partial={partial} selected={summary.days.some(day => day.date === selected) ? selected : ''} onSelect={setSelected}/>
        <div className="usage-cache-summary-line"><span>Input served from cache</span><strong>{partial ? 'Unavailable' : usagePercent(summary.cachedInputShare)}</strong></div>
        {!partial && input > 0 && <svg className="usage-cache-composition" viewBox="0 0 100 6" preserveAspectRatio="none" role="img" aria-label={`${usagePercent(readShare)} of recorded input served from cache`}>
            <rect width="100" height="6" className="usage-track"/>
            <rect width={readShare} height="6" fill="#8970ff"/>
            <rect x={readShare} width={freshShare} height="6" fill="#727982"/>
            {summary.tokens.write > 0 && <rect x={readShare + freshShare} width={summary.tokens.write / input * 100} height="6" fill="#d69b47"/>}
        </svg>}
        <dl className={`usage-cache-values${showWrites ? ' usage-cache-with-writes' : ''}`}>
            <div><dt>Cache reads</dt><dd title={usageNumber(summary.tokens.read)}>{usageCompact(summary.tokens.read)}</dd></div>
            <div><dt>Fresh input</dt><dd title={usageNumber(summary.tokens.fresh)}>{usageCompact(summary.tokens.fresh)}</dd></div>
            {showWrites && <div><dt>Cache writes</dt><dd>{usageCacheWrites(summary.tokens.write, summary.cacheWriteReporting)}</dd></div>}
        </dl>

    </>;
}

export function UsageToolActivity({ summary, partial = false, selected = '', onSelect }: { summary: UsageRangeSummary; partial?: boolean; selected?: string; onSelect?: (date: string) => void }) {
    return <>
        <h3 className="usage-trend-heading">{usageBucketDays(summary) > 1 ? 'Tool requests trend' : 'Daily tool requests'}</h3>
        <UsageAreaTrend summary={summary} metric="requests" partial={partial} selected={selected} onSelect={onSelect}/>
        <table className="usage-tool-table"><thead><tr><th scope="col">Tool</th><th scope="col">Requests</th><th scope="col">Errors / results</th></tr></thead>
            <tbody>{summary.tools.slice(0, 4).map(tool => <tr key={tool.id}><th scope="row">{tool.label}</th><td>{usageNumber(tool.requests)}</td><td title={`${usageNumber(tool.errors)} errors / ${usageNumber(tool.results)} matched results`}>{tool.results ? usagePercent(tool.errors / tool.results * 100) : 'Not available'}</td></tr>)}</tbody>
        </table>
        <details className="usage-disclosure"><summary>All tools and result breakdown</summary><UsageToolErrors summary={summary}/></details>
        {summary.detail.omittedTools > 0 && <p className="usage-note">Other includes {usageNumber(summary.detail.omittedTools)} tool names.</p>}
    </>;
}
