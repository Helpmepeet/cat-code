import { useState } from 'react';
import type { UsageRangeSummary } from '../../shared/usageDashboard.js';
import { UsageAreaTrend } from './UsageAreaTrend.js';
import { usageHasCacheWrites } from './usageTrendState.js';
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

export function UsageCacheSummary({ summary, partial, selected = '', onSelect }: { summary: UsageRangeSummary; partial: boolean; selected?: string; onSelect?: (date: string) => void }) {
    const showWrites = usageHasCacheWrites(summary);
    return <>
        <div className="usage-chart-summary"><span>Share of input tokens served from cache</span><strong>{partial ? 'Unavailable' : usagePercent(summary.cachedInputShare)}</strong></div>
        <UsageCacheChart summary={summary} partial={partial} selected={selected} onSelect={onSelect}/>
        <dl className={`usage-cache-values${showWrites ? ' usage-cache-with-writes' : ''}`}>
            <div><dt>Cache reads</dt><dd title={usageNumber(summary.tokens.read)}>{usageCompact(summary.tokens.read)}</dd></div>
            <div><dt>Fresh input</dt><dd title={usageNumber(summary.tokens.fresh)}>{usageCompact(summary.tokens.fresh)}</dd></div>
            {showWrites && <div><dt>Cache writes</dt><dd>{usageCacheWrites(summary.tokens.write, summary.cacheWriteReporting)}</dd></div>}
        </dl>
    </>;
}

export function UsageToolActivity({ summary, partial = false, selected = '', onSelect }: { summary: UsageRangeSummary; partial?: boolean; selected?: string; onSelect?: (date: string) => void }) {
    const [metric, setMetric] = useState<'errors' | 'requests'>('errors');
    const results = summary.tools.reduce((sum, tool) => sum + tool.results, 0);
    const errors = summary.tools.reduce((sum, tool) => sum + tool.errors, 0);
    return <>
        <div className="usage-chart-summary"><div className="usage-range" role="group" aria-label="Tool trend measure"><button type="button" aria-pressed={metric === 'errors'} onClick={() => setMetric('errors')}>Error rate</button><button type="button" aria-pressed={metric === 'requests'} onClick={() => setMetric('requests')}>Requests</button></div><strong>{metric === 'errors' ? results ? usagePercent(errors / results * 100) : 'Not available' : usageCompact(summary.requests)}</strong></div>
        <UsageAreaTrend key={metric} summary={summary} metric={metric} partial={partial} selected={selected} onSelect={onSelect}/>
        <dl className="usage-outcome-values"><div><dt>Successful</dt><dd>{usageNumber(results - errors)}</dd></div><div><dt>Errors / results</dt><dd>{usageNumber(errors)} / {usageNumber(results)}</dd></div><div><dt>No matched result</dt><dd>{usageNumber(summary.requests - results)}</dd></div></dl>
    </>;
}

export function UsageToolBreakdown({ summary }: { summary: UsageRangeSummary }) {
    const [selected, setSelected] = useState('');
    const max = Math.max(1, ...summary.tools.map(tool => tool.requests));
    const detail = summary.tools.find(tool => tool.id === selected);
    return <>
        <div className="usage-legend usage-tool-legend"><span><i className="usage-tool-ok"/>Successful</span><span><i className="usage-tool-error"/>Error</span><span><i className="usage-tool-unmatched"/>Unmatched</span></div>
        <div className="usage-tool-bars">{summary.tools.map(tool => <button key={tool.id} type="button" aria-pressed={selected === tool.id} onClick={() => setSelected(selected === tool.id ? '' : tool.id)} aria-label={`${tool.label}: ${usageNumber(tool.requests)} requests, ${usageNumber(tool.errors)} errors, ${usageNumber(tool.requests - tool.results)} unmatched`}>
            <span>{tool.label}</span><svg viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true"><rect width={(tool.results - tool.errors) / max * 100} height="10" rx="1" className="usage-tool-ok"/><rect x={(tool.results - tool.errors) / max * 100} width={tool.errors / max * 100} height="10" rx="1" className="usage-tool-error"/><rect x={tool.results / max * 100} width={(tool.requests - tool.results) / max * 100} height="10" rx="1" className="usage-tool-unmatched"/></svg><b>{usageCompact(tool.requests)}</b>
        </button>)}</div>
        {detail && <p className="usage-note" role="status">{detail.label}: {usageNumber(detail.results - detail.errors)} successful · {usageNumber(detail.errors)} errors · {usageNumber(detail.requests - detail.results)} without a matched result</p>}
        <details className="usage-disclosure"><summary>All tools and result breakdown</summary><UsageToolErrors summary={summary}/></details>
        {summary.detail.omittedTools > 0 && <p className="usage-note">Other includes {usageNumber(summary.detail.omittedTools)} tool names.</p>}
    </>;
}
