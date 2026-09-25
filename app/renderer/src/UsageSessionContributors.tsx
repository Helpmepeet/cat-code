import type { UsageDayContributors } from '../../shared/usageDashboard.js';
import { resolveSessionOpenRoute, type MergedSessionRow } from './sessionsCatalogState.js';
import { usageCompact, usageNumber, usageTotal } from './usageDashboardState.js';
import { findUsageSessionRow } from './usageSessionNavigation.js';

function costText(usd: number, pricedTokens: number, totalTokens: number): string {
    if (!totalTokens || !pricedTokens) return '–';
    return usd < 0.01 && usd > 0 ? '<$0.01' : `$${usd.toFixed(2)}`;
}

export function UsageSessionContributors({ contributors, rows, onOpenRow }: {
    contributors: UsageDayContributors;
    rows: readonly MergedSessionRow[];
    onOpenRow?: (row: MergedSessionRow) => void;
}) {
    if (contributors.state === 'unavailable') return <p className="usage-note">Session details are unavailable for this day.</p>;
    if (!contributors.items.length) return <p className="usage-note">{contributors.omitted ? `Details for ${usageNumber(contributors.omitted)} contributing sessions are unavailable.` : 'No contributing sessions were recorded for this day.'}</p>;
    const items = [...contributors.items].sort((a, b) => usageTotal(b.tokens) - usageTotal(a.tokens) || a.id.localeCompare(b.id)).slice(0, 10);
    const total = contributors.items.length + contributors.omitted;
    const rankedTop = items.every((item, index) => item.rank?.tokens === index + 1);
    return <>
        <div className="usage-table-scroll"><table className="usage-session-table"><thead><tr><th scope="col">Session</th><th scope="col">Tokens</th><th scope="col"><span title="API list prices for priced tokens; excludes cache writes">Est. cost</span></th></tr></thead>
            <tbody>{items.map(item => {
                const row = findUsageSessionRow(item, rows);
                const openable = row && onOpenRow && resolveSessionOpenRoute(row).kind !== 'none';
                const label = row?.displayLabel ?? (item.engineSessionId ? `Session ${item.engineSessionId.slice(0, 8)}` : 'Unidentified session');
                const totalTokens = usageTotal(item.tokens);
                const pricedTokens = item.tokenCost?.pricedTokens ?? 0;
                return <tr key={item.id}>
                    <th scope="row">{openable ? <button className="usage-session-name" type="button" onClick={() => onOpenRow(row)}>{label}</button> : <span className="usage-session-title">{label}</span>}{item.project?.label && <small className="usage-session-project">{item.project.label}</small>}</th>
                    <td title={`${usageNumber(totalTokens)} tokens`}>{usageCompact(totalTokens)}</td>
                    <td aria-label={pricedTokens ? `${costText(item.tokenCost?.usd ?? 0, pricedTokens, totalTokens)}, based on ${usageNumber(pricedTokens)} of ${usageNumber(totalTokens)} tokens` : 'Cost unavailable'}>{costText(item.tokenCost?.usd ?? 0, pricedTokens, totalTokens)}</td>
                </tr>;
            })}</tbody></table></div>
        {total > items.length && <p className="usage-note">{rankedTop ? 'Top' : 'Showing'} {usageNumber(items.length)} of {usageNumber(total)} sessions. Day totals include all.</p>}
    </>;
}
