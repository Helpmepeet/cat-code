import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { UsageDayContributors } from '../../shared/usageDashboard.js';
import { UsageSessionContributors } from './UsageSessionContributors.js';

test('zero-detail fallback reports omission instead of claiming the day had no sessions', () => {
    const contributors: UsageDayContributors = { state: 'truncated', omitted: 12, items: [] };
    const html = renderToStaticMarkup(<UsageSessionContributors contributors={contributors} rows={[]}/>);
    expect(html).toContain('Details for 12 contributing sessions are unavailable');
    expect(html).not.toContain('No contributing sessions were recorded');
});

test('partial estimates stay priced subtotals and distinguish tiny positive values', () => {
    const contributors: UsageDayContributors = { state: 'truncated', omitted: 1, items: [{
        id: 'session-a', engineSessionId: null, project: null,
        tokens: { fresh: 9996, read: 0, write: 4, output: 0 }, requests: 0, results: 0, errors: 0,
        rank: { tokens: 1, requests: 1, errors: 1 }, tokenCost: { usd: 0.000004, pricedTokens: 9996 },
        models: [{ id: 'model-a', kind: 'named', label: 'Model A', tokens: { fresh: 9996, read: 0, write: 4, output: 0 }, tokenCost: { usd: 0.000004, pricedTokens: 9996 } }],
        modelDetail: { state: 'full', omitted: 0 },
    }] };
    const html = renderToStaticMarkup(<UsageSessionContributors contributors={contributors} rows={[]}/>);
    expect(html).toContain('&lt;$0.00001');
    expect(html).toContain('priced subtotal');
    expect(html).toContain('&lt;100% token coverage');
    expect(html).toContain('including the top 1 by tokens, tool requests, and recorded errors');
    expect(html).toContain('estimates are not actual spend');
});
