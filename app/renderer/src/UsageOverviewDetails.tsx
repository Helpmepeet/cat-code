import { useState } from 'react';
import type { UsageRangeSummary } from '../../shared/usageDashboard.js';
import { UsageAreaTrend } from './UsageAreaTrend.js';
import { usageHasCacheWrites } from './usageTrendState.js';
import { UsageCacheChart } from './UsageDashboardCharts.js';
import { UsageToolErrors } from './UsageActivityCharts.js';
import { usageCacheWrites, usageCompact, usageNumber, usagePercent, usageTotal } from './usageDashboardState.js';
import './usageOverviewDetails.css';

function donutArcs(summary: UsageRangeSummary, total: number) {
    const center = 92, inner = 58, outer = 88, gap = 0.035;
    const point = (radius: number, angle: number) => [center + radius * Math.cos(angle), center + radius * Math.sin(angle)];
    let angle = -Math.PI / 2;
    return summary.models.flatMap(model => {
        const share = total ? usageTotal(model.tokens) / total : 0;
        const sweep = share * Math.PI * 2, arcGap = Math.min(gap, sweep * 0.25);
        const start = angle + arcGap / 2, end = angle + sweep - arcGap / 2;
        angle += sweep;
        if (share <= 0 || end <= start) return [];
        const [x0, y0] = point(outer, start), [x1, y1] = point(outer, end);
        const [x2, y2] = point(inner, end), [x3, y3] = point(inner, start);
        const large = end - start > Math.PI ? 1 : 0;
        return [{ model, share, path: `M${x0} ${y0} A${outer} ${outer} 0 ${large} 1 ${x1} ${y1} L${x2} ${y2} A${inner} ${inner} 0 ${large} 0 ${x3} ${y3} Z` }];
    });
}

function share(value: number, total: number) { return usagePercent(total ? value / total * 100 : 0); }

export function UsageModelDonut({ summary, colors }: { summary: UsageRangeSummary; colors: Record<string, string> }) {
    const [selected, setSelected] = useState('');
    const [hovered, setHovered] = useState('');
    const total = usageTotal(summary.tokens), active = summary.models.find(model => model.id === (hovered || selected));
    const select = (id: string) => setSelected(current => current === id ? '' : id);
    return <div className="usage-model-mix usage-details-model-mix">
        <div className={`usage-details-donut${active ? ' is-active' : ''}`}>
            <svg className="usage-model-donut" viewBox="-6 -6 196 196" role="group" aria-label={`Model usage: ${usageNumber(total)} tokens`}>
                {donutArcs(summary, total).map(({ model, share: modelShare, path }) => <path key={model.id} d={path} fill={colors[model.id]} className={`${active && active.id !== model.id ? 'usage-model-muted' : ''}${selected === model.id ? ' usage-model-selected' : ''}`} tabIndex={0} role="button" aria-label={`${model.label}: ${usageNumber(usageTotal(model.tokens))} tokens, ${usagePercent(modelShare * 100)}`} aria-pressed={selected === model.id} onMouseEnter={() => setHovered(model.id)} onMouseLeave={() => setHovered('')} onFocus={() => setHovered(model.id)} onBlur={() => setHovered('')} onClick={() => select(model.id)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(model.id); } else if (event.key === 'Escape') { setSelected(''); setHovered(''); } }}/>)}
            </svg>
            <div className="usage-details-donut-center" aria-hidden="true"><span>{active?.label ?? 'All models'}</span><strong>{active ? share(usageTotal(active.tokens), total) : usageCompact(total)}</strong><small>{active ? `${usageCompact(usageTotal(active.tokens))} tokens` : `${summary.models.length} tracked`}</small></div>
        </div>
        <ul className="usage-model-key usage-details-model-key">{summary.models.map(model => { const value = usageTotal(model.tokens); return <li key={model.id}><button type="button" aria-pressed={selected === model.id} className={active && active.id !== model.id ? 'usage-model-muted' : ''} onMouseEnter={() => setHovered(model.id)} onMouseLeave={() => setHovered('')} onFocus={() => setHovered(model.id)} onBlur={() => setHovered('')} onClick={() => select(model.id)}><svg width="9" height="9" aria-hidden="true"><rect width="9" height="9" rx="2.5" fill={colors[model.id]}/></svg><span>{model.label}</span><b title={`${usageNumber(value)} tokens`}>{usageCompact(value)}</b><small>{share(value, total)}</small></button></li>; })}</ul>
    </div>;
}

function DetailValue({ color, label, value, total, title }: { color: string; label: string; value: string; total?: string; title?: string }) {
    return <div><dt><i className={color}/>{label}</dt><dd title={title}>{value}{total && <small>{total}</small>}</dd></div>;
}

export function UsageCacheSummary({ summary, partial, selected = '', onSelect }: { summary: UsageRangeSummary; partial: boolean; selected?: string; onSelect?: (date: string) => void }) {
    const showWrites = usageHasCacheWrites(summary);
    const total = summary.tokens.read + summary.tokens.fresh + (showWrites ? summary.tokens.write : 0);
    return <div className="usage-details-summary"><header className="usage-details-card-header"><div><h2 className="usage-panel-heading">Prompt cache</h2><p>Share of input tokens served from cache</p></div><strong>{partial ? 'Unavailable' : usagePercent(summary.cachedInputShare)}</strong></header><UsageCacheChart summary={summary} partial={partial} selected={selected} onSelect={onSelect}/><dl className="usage-cache-values usage-details-values"><DetailValue color="usage-details-cache-read" label="Cache reads" value={usageCompact(summary.tokens.read)} total={partial ? undefined : share(summary.tokens.read, total)} title={usageNumber(summary.tokens.read)}/><DetailValue color="usage-details-fresh" label="Fresh input" value={usageCompact(summary.tokens.fresh)} total={partial ? undefined : share(summary.tokens.fresh, total)} title={usageNumber(summary.tokens.fresh)}/>{showWrites && <DetailValue color="usage-details-cache-write" label="Cache writes" value={usageCacheWrites(summary.tokens.write, summary.cacheWriteReporting)} total={partial ? undefined : share(summary.tokens.write, total)}/>}</dl></div>;
}

export function UsageToolActivity({ summary, partial = false, selected = '', onSelect }: { summary: UsageRangeSummary; partial?: boolean; selected?: string; onSelect?: (date: string) => void }) {
    const [metric, setMetric] = useState<'errors' | 'requests'>('errors');
    const results = summary.tools.reduce((sum, tool) => sum + tool.results, 0), errors = summary.tools.reduce((sum, tool) => sum + tool.errors, 0);
    const successful = results - errors, unmatched = summary.requests - results;
    return <div className="usage-details-summary"><header className="usage-details-card-header"><div><h2 className="usage-panel-heading">Tool activity</h2><p>{metric === 'errors' ? 'Errors / results' : 'Daily tool requests'}</p></div><div className="usage-details-tool-metric"><div className="usage-range" role="group" aria-label="Tool trend measure"><button type="button" aria-pressed={metric === 'errors'} onClick={() => setMetric('errors')}>Error rate</button><button type="button" aria-pressed={metric === 'requests'} onClick={() => setMetric('requests')}>Requests</button></div><strong>{metric === 'errors' ? results ? usagePercent(errors / results * 100) : 'Not available' : usageCompact(summary.requests)}</strong></div></header><UsageAreaTrend key={metric} summary={summary} metric={metric} partial={partial} selected={selected} onSelect={onSelect}/><dl className="usage-outcome-values usage-details-values"><DetailValue color="usage-tool-ok" label="Successful" value={usageNumber(successful)} total={share(successful, summary.requests)}/><DetailValue color="usage-tool-error" label="Errors" value={usageNumber(errors)} total={share(errors, summary.requests)}/><DetailValue color="usage-tool-unmatched" label="No matched result" value={usageNumber(unmatched)} total={share(unmatched, summary.requests)}/></dl></div>;
}

export function UsageToolBreakdown({ summary }: { summary: UsageRangeSummary }) {
    const [selected, setSelected] = useState('');
    const tools = [...summary.tools].sort((a, b) => b.requests - a.requests), max = Math.max(1, ...tools.map(tool => tool.requests));
    const detail = tools.find(tool => tool.id === selected);
    const hasUnmatched = tools.some(tool => tool.requests > tool.results);
    return <><div className="usage-legend usage-tool-legend usage-details-tool-legend"><span><i className="usage-tool-ok"/>Successful</span><span><i className="usage-tool-error"/>Error</span>{hasUnmatched && <span><i className="usage-tool-unmatched"/>Unmatched</span>}</div><div className="usage-tool-bars usage-details-tool-bars">{tools.map(tool => { const ok = (tool.results - tool.errors) / max * 100, error = tool.errors / max * 100, unmatched = (tool.requests - tool.results) / max * 100; return <button key={tool.id} type="button" aria-pressed={selected === tool.id} onClick={() => setSelected(selected === tool.id ? '' : tool.id)} aria-label={`${tool.label}: ${usageNumber(tool.requests)} requests, ${usageNumber(tool.errors)} errors, ${usageNumber(tool.requests - tool.results)} unmatched`}><span>{tool.label}</span><svg className="usage-details-tool-track" viewBox="0 0 100 11" preserveAspectRatio="none" aria-hidden="true"><rect width={ok} height="11" rx="1.5" className="usage-tool-ok"/>{error > 0 && <rect x={ok} width={error} height="11" rx="1.5" className="usage-tool-error"/>}{unmatched > 0 && <rect x={ok + error} width={unmatched} height="11" rx="1.5" className="usage-tool-unmatched"/>}</svg><b>{usageNumber(tool.requests)}</b></button>; })}</div>{detail && <p className="usage-note" role="status">{detail.label}: {usageNumber(detail.results - detail.errors)} successful · {usageNumber(detail.errors)} errors · {usageNumber(detail.requests - detail.results)} without a matched result</p>}<details className="usage-disclosure"><summary>All tools and result breakdown</summary><UsageToolErrors summary={summary}/></details>{summary.detail.omittedTools > 0 && <p className="usage-note">Other includes {usageNumber(summary.detail.omittedTools)} tool names.</p>}</>;
}
