import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { UsageRangeSummary } from '../../shared/usageDashboard.js';
import { UsageToolErrorTrend } from './UsageToolErrorTrend.js';

const summary = {
    range: '7d', startInclusive: '2026-09-07T00:00:00.000Z', endExclusive: '2026-09-14T00:00:00.000Z', startDate: '2026-09-07', endDateExclusive: '2026-09-14',
    tools: [
        { id: 'read', kind: 'named', label: 'Read', requests: 3, results: 2, errors: 1 },
        { id: 'bash', kind: 'named', label: 'Bash', requests: 2, results: 0, errors: 0 },
    ],
    days: Array.from({ length: 7 }, (_, index) => {
        const date = `2026-09-${String(index + 7).padStart(2, '0')}`;
        if (index === 0) return { date, tools: [{ id: 'read', requests: 3, results: 2, errors: 1, builds: { items: [{ sha: '12345678', dirty: false, requests: 2, results: 2, errors: 1, firstObservedAt: '2026-09-07T08:00:00.000Z' }] } }] };
        if (index === 1) return { date, tools: [{ id: 'bash', requests: 2, results: 0, errors: 0 }] };
        return { date, tools: [] };
    }),
} as unknown as UsageRangeSummary;

test('renders an always-visible multi-tool graph with exact values and observed build counts', () => {
    const html = renderToStaticMarkup(<UsageToolErrorTrend summary={summary}/>);
    expect(html).toContain('Error rate over time');
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(3);
    expect(html).toContain('Days without matched results are gaps');
    expect(html).toContain('Observed Cat Code build 12345678');
    expect(html).toContain('Read: 1 error / 2 matched results');
    expect(html).not.toContain('NaN');
    expect(html).not.toContain('2026-09-07T08:00:00.000Z');
    expect(html).toContain('0%');
    expect(html).not.toContain('All tools and result breakdown');
});

test('keeps omitted marker details out of the compact chart', () => {
    const truncated = structuredClone(summary) as UsageRangeSummary;
    truncated.days[0]!.tools[0]!.builds!.omitted = { count: 2, requests: 1, results: 0, errors: 0 };
    const html = renderToStaticMarkup(<UsageToolErrorTrend summary={truncated}/>);
    expect(html).toContain('Observed Cat Code build 12345678');
    expect(html).not.toContain('2 build markers are omitted.');
    expect(html).not.toContain('less active build');
});
