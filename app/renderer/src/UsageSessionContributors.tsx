import { useState } from 'react';
import type { UsageDayContributors } from '../../shared/usageDashboard.js';
import { resolveSessionOpenRoute, type MergedSessionRow } from './sessionsCatalogState.js';
import { usageCompact, usageNumber, usageTotal } from './usageDashboardState.js';
import { findUsageSessionRow } from './usageSessionNavigation.js';

type ContributorSort = 'tokens' | 'requests' | 'errors' | 'cost';

function costText(usd: number) {
    if (usd >= 1) return `$${usd.toFixed(2)}`;
    if (usd >= 0.01) return `$${usd.toFixed(3)}`;
    if (usd > 0 && usd < 0.000005) return '<$0.00001';
    return `$${usd.toFixed(5)}`;
}

function TokenCost({ usd = 0, pricedTokens = 0, totalTokens }: { usd?: number; pricedTokens?: number; totalTokens: number }) {
    if (totalTokens === 0) return <span className="usage-note">No token usage</span>;
    if (pricedTokens === 0) return <span className="usage-note">Unpriced</span>;
    const coverage = pricedTokens / totalTokens * 100;
    const coverageLabel = coverage >= 99.5 ? '<100%' : `${coverage.toFixed(coverage >= 10 ? 0 : 1)}%`;
    return <span title={`${usageNumber(pricedTokens)} of ${usageNumber(totalTokens)} tokens are in categories with configured rates`}>{costText(usd)}{pricedTokens < totalTokens && <small> priced subtotal · {coverageLabel} token coverage</small>}</span>;
}

function guaranteedLeaders(contributors: UsageDayContributors): number {
    if (contributors.state === 'unavailable' || !contributors.items.length) return 0;
    return Math.min(...(['tokens', 'requests', 'errors'] as const).map(metric => {
        const ranks = new Set(contributors.items.map(item => item.rank?.[metric]).filter((rank): rank is number => typeof rank === 'number'));
        let contiguous = 0;
        while (ranks.has(contiguous + 1)) contiguous++;
        return contiguous;
    }));
}

export function UsageSessionContributors({ contributors, rows, onOpenRow }: {
    contributors: UsageDayContributors;
    rows: readonly MergedSessionRow[];
    onOpenRow?: (row: MergedSessionRow) => void;
}) {
    const [sort, setSort] = useState<ContributorSort>('tokens');
    if (contributors.state === 'unavailable') return <p className="usage-note">Session details are unavailable for this day.</p>;
    if (contributors.state === 'truncated' && !contributors.items.length) return <p className="usage-note">Details for {usageNumber(contributors.omitted)} contributing sessions are unavailable. Day totals include their usage.</p>;
    if (!contributors.items.length) return <p className="usage-note">No contributing sessions were recorded for this day.</p>;
    const items = [...contributors.items].sort((a, b) => (sort === 'tokens' ? usageTotal(b.tokens) - usageTotal(a.tokens) : sort === 'cost' ? (b.tokenCost?.usd ?? 0) - (a.tokenCost?.usd ?? 0) : b[sort] - a[sort]) || a.id.localeCompare(b.id));
    const leaderCount = guaranteedLeaders(contributors);
    return <>
        <div className="usage-contributors-toolbar"><label>Sort shown sessions <select value={sort} onChange={event => setSort(event.target.value as ContributorSort)}><option value="tokens">Tokens</option><option value="requests">Tool requests</option><option value="errors">Recorded errors</option><option value="cost">Est. token cost</option></select></label></div>
        <div className="usage-table-scroll"><table className="usage-session-table"><thead><tr><th scope="col">Session</th><th scope="col">Models</th><th scope="col">Tokens</th><th scope="col">Est. token cost</th><th scope="col">Tool requests</th><th scope="col">Errors</th><th scope="col"><span className="sr-only">Open session</span></th></tr></thead>
            <tbody>{items.map(item => {
                const row = findUsageSessionRow(item, rows);
                const openable = row && onOpenRow && resolveSessionOpenRoute(row).kind !== 'none';
                return <tr key={item.id}>
                    <th scope="row"><span className="usage-session-title">{row?.displayLabel ?? (item.engineSessionId ? `Session ${item.engineSessionId.slice(0, 8)}` : 'Unidentified session')}</span><small className="usage-session-project">{item.project?.label ?? 'Project unavailable'}</small></th>
                    <td>{item.models.length ? <details className="usage-session-models"><summary>{item.models.length === 1 ? item.models[0]!.label : `${item.models.length} model groups`}</summary>{item.models.map(model => <p key={model.id}>{model.label}: {usageCompact(usageTotal(model.tokens))} · <TokenCost usd={model.tokenCost?.usd} pricedTokens={model.tokenCost?.pricedTokens} totalTokens={usageTotal(model.tokens)}/></p>)}{item.modelDetail.omitted > 0 && <p>Other includes {item.modelDetail.omitted} model names.</p>}</details> : <span className="usage-note">No model tokens</span>}</td>
                    <td title={`${usageNumber(usageTotal(item.tokens))} tokens`}>{usageCompact(usageTotal(item.tokens))}</td>
                    <td><TokenCost usd={item.tokenCost?.usd} pricedTokens={item.tokenCost?.pricedTokens} totalTokens={usageTotal(item.tokens)}/></td>
                    <td>{usageNumber(item.requests)}</td>
                    <td title={`${usageNumber(item.results)} matched results`}>{usageNumber(item.errors)}</td>
                    <td>{openable ? <button className="usage-session-open" type="button" aria-label={`Open ${row.displayLabel}`} onClick={() => onOpenRow(row)}>Open</button> : <span className="usage-note" title="This session could not be matched to an available conversation.">Unavailable</span>}</td>
                </tr>;
            })}</tbody></table></div>
        {contributors.state === 'truncated' && <p className="usage-note">Showing {items.length} sessions{leaderCount > 0 ? `, including the top ${leaderCount} by tokens, tool requests, and recorded errors` : ''}. Sorting applies to shown sessions. {usageNumber(contributors.omitted)} more are not shown; day totals include all recorded usage.</p>}
        <p className="usage-note">Estimated token costs use configured standard API rates for recorded fresh input, cache reads, and output. Cache writes, unknown models, speed premiums, and server search charges are excluded; estimates are not actual spend.</p>
    </>;
}
