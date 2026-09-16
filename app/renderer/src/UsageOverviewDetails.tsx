import { useState } from 'react';
import type { UsageRangeSummary } from '../../shared/usageDashboard.js';
import { UsageCacheChart } from './UsageDashboardCharts.js';
import { UsageToolErrors } from './UsageActivityCharts.js';
import { usageCacheWrites, usageCompact, usageNumber, usagePercent, usageTotal } from './usageDashboardState.js';

export function UsageModelBars({ summary, colors }: { summary: UsageRangeSummary; colors: Record<string, string> }) {
    const total = usageTotal(summary.tokens);
    return <ul className="usage-model-bars">{summary.models.map(model => {
        const count = usageTotal(model.tokens), share = total ? count / total * 100 : 0;
        return <li key={model.id}>
            <span className="usage-model-name"><svg width="8" height="8" aria-hidden="true"><rect width="8" height="8" rx="2" fill={colors[model.id]}/></svg>{model.label}</span>
            <span className="usage-model-amount" title={`${usageNumber(count)} tokens`}>{usageCompact(count)} <small>{usagePercent(share)}</small></span>
            <svg className="usage-bar" viewBox="0 0 100 5" preserveAspectRatio="none" aria-hidden="true"><rect width="100" height="5" className="usage-track"/><rect width={share} height="5" fill={colors[model.id]}/></svg>
        </li>;
    })}</ul>;
}

export function UsageCacheSummary({ summary, partial }: { summary: UsageRangeSummary; partial: boolean }) {
    const [selected, setSelected] = useState('');
    const input = summary.tokens.fresh + summary.tokens.read + summary.tokens.write;
    const readShare = input ? summary.tokens.read / input * 100 : 0;
    const freshShare = input ? summary.tokens.fresh / input * 100 : 0;
    return <>
        <strong className="usage-cache-share">{partial ? 'Unavailable' : usagePercent(summary.cachedInputShare)}</strong>
        <p className="usage-note">Input served from cache</p>
        {partial ? <p className="usage-note">Cache share is unavailable while history is partial.</p> : input > 0 && <svg className="usage-cache-composition" viewBox="0 0 100 6" preserveAspectRatio="none" role="img" aria-label={`${usagePercent(readShare)} of recorded input served from cache`}>
            <rect width="100" height="6" className="usage-track"/>
            <rect width={readShare} height="6" fill="#8970ff"/>
            <rect x={readShare} width={freshShare} height="6" fill="#727982"/>
            {summary.tokens.write > 0 && <rect x={readShare + freshShare} width={summary.tokens.write / input * 100} height="6" fill="#d69b47"/>}
        </svg>}
        <dl className="usage-cache-values">
            <div><dt>Cache reads</dt><dd title={usageNumber(summary.tokens.read)}>{usageCompact(summary.tokens.read)}</dd></div>
            <div><dt>Fresh input</dt><dd title={usageNumber(summary.tokens.fresh)}>{usageCompact(summary.tokens.fresh)}</dd></div>
            <div><dt>Cache writes</dt><dd>{usageCacheWrites(summary.tokens.write, summary.cacheWriteReporting)}</dd></div>
        </dl>
        <details className="usage-disclosure"><summary>Daily cache trend</summary><UsageCacheChart summary={summary} partial={partial} selected={summary.days.some(day => day.date === selected) ? selected : ''} onSelect={setSelected}/></details>
    </>;
}

export function UsageToolActivity({ summary }: { summary: UsageRangeSummary }) {
    return <>
        <table className="usage-tool-table"><thead><tr><th scope="col">Tool</th><th scope="col">Requests</th><th scope="col">Errors / results</th></tr></thead>
            <tbody>{summary.tools.slice(0, 4).map(tool => <tr key={tool.id}><th scope="row">{tool.label}</th><td>{usageNumber(tool.requests)}</td><td title={`${usageNumber(tool.errors)} errors / ${usageNumber(tool.results)} matched results`}>{tool.results ? usagePercent(tool.errors / tool.results * 100) : 'Not available'}</td></tr>)}</tbody>
        </table>
        <details className="usage-disclosure"><summary>All tools and result breakdown</summary><UsageToolErrors summary={summary}/></details>
        {summary.detail.omittedTools > 0 && <p className="usage-note">Other includes {usageNumber(summary.detail.omittedTools)} tool names.</p>}
    </>;
}
