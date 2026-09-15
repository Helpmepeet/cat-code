import { useState } from 'react';
import type { UsageDayContributors } from '../../shared/usageDashboard.js';
import { resolveSessionOpenRoute, type MergedSessionRow } from './sessionsCatalogState.js';
import { usageCompact, usageNumber, usageTotal } from './usageDashboardState.js';
import { findUsageSessionRow } from './usageSessionNavigation.js';

export function UsageSessionContributors({ contributors, rows, onOpenRow }: {
    contributors: UsageDayContributors;
    rows: readonly MergedSessionRow[];
    onOpenRow?: (row: MergedSessionRow) => void;
}) {
    const [sort, setSort] = useState<'tokens' | 'requests' | 'errors'>('tokens');
    if (contributors.state === 'unavailable') return <p className="usage-note">Session details are unavailable for this day.</p>;
    if (!contributors.items.length) return <p className="usage-note">No contributing sessions were recorded for this day.</p>;
    const items = [...contributors.items].sort((a, b) => (sort === 'tokens' ? usageTotal(b.tokens) - usageTotal(a.tokens) : b[sort] - a[sort]) || a.id.localeCompare(b.id));
    return <>
        <div className="usage-contributors-toolbar"><p className="usage-note">Usage on this day, including delegated work.</p><label>Sort shown sessions <select value={sort} onChange={event => setSort(event.target.value as typeof sort)}><option value="tokens">Tokens</option><option value="requests">Tool requests</option><option value="errors">Recorded errors</option></select></label></div>
        <div className="usage-table-scroll"><table className="usage-session-table"><thead><tr><th scope="col">Session</th><th scope="col">Models</th><th scope="col">Tokens</th><th scope="col">Tool requests</th><th scope="col">Errors</th><th scope="col"><span className="sr-only">Open session</span></th></tr></thead>
            <tbody>{items.map(item => {
                const row = findUsageSessionRow(item, rows);
                const openable = row && onOpenRow && resolveSessionOpenRoute(row).kind !== 'none';
                return <tr key={item.id}>
                    <th scope="row"><span className="usage-session-title">{row?.displayLabel ?? (item.engineSessionId ? `Session ${item.engineSessionId.slice(0, 8)}` : 'Unidentified session')}</span><small className="usage-session-project">{item.project?.label ?? 'Project unavailable'}</small></th>
                    <td>{item.models.length ? <details className="usage-session-models"><summary>{item.models.length === 1 ? item.models[0]!.label : `${item.models.length} model groups`}</summary>{item.models.map(model => <p key={model.id}>{model.label}: {usageCompact(usageTotal(model.tokens))}</p>)}{item.modelDetail.omitted > 0 && <p>Other includes {item.modelDetail.omitted} model names.</p>}</details> : <span className="usage-note">No model tokens</span>}</td>
                    <td title={`${usageNumber(usageTotal(item.tokens))} tokens`}>{usageCompact(usageTotal(item.tokens))}</td>
                    <td>{usageNumber(item.requests)}</td>
                    <td title={`${usageNumber(item.results)} matched results`}>{usageNumber(item.errors)}</td>
                    <td>{openable ? <button className="usage-session-open" type="button" aria-label={`Open ${row.displayLabel}`} onClick={() => onOpenRow(row)}>Open</button> : <span className="usage-note" title="This session could not be matched to an available conversation.">Unavailable</span>}</td>
                </tr>;
            })}</tbody></table></div>
        {contributors.state === 'truncated' && <p className="usage-note">Showing the top {items.length} sessions by tokens. {usageNumber(contributors.omitted)} more are not shown; day totals include all recorded usage.</p>}
    </>;
}
