import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { hundredAttemptAutoModeFixture } from '../../../src/utils/autoModeUsage.fixture.js';
import { reduceAutoModeUsage } from '../../../src/utils/autoModeUsage.js';
import { UsageAutoModeBars } from './UsageAutoModeBars.js';

const summary = reduceAutoModeUsage(hundredAttemptAutoModeFixture());

test('renders all four display groups using the all-attempt total', () => {
    const html = renderToStaticMarkup(<UsageAutoModeBars summary={summary}/>);
    expect(html).toContain('Decisions over time');
    expect(html).toContain('Allowed</span><b>85</b>');
    expect(html).toContain('Blocked</span><b>7</b>');
    expect(html).toContain('Error</span><b>8</b>');
    expect(html).toContain('Cancelled</span><b>0</b>');
    expect(html).toContain('85.0% of 100 attempts');
    expect(html).toContain('tabindex="0" role="button"');
    expect(html).not.toContain('Exact decision values');
    expect(html).toContain('Includes review required, operational error, unknown outcome, and incomplete');
});

test('keeps backend category ranking and exact policy-block totals', () => {
    const ranked = {
        ...summary,
        categories: [
            { key: 'z', kind: 'named' as const, label: 'Later key', count: 2 },
            { key: 'a', kind: 'named' as const, label: 'First key', count: 3 },
            { key: 'other', kind: 'other' as const, label: 'Other', count: 1 },
            { key: 'uncategorized', kind: 'uncategorized' as const, label: 'Uncategorized', count: 1 },
        ],
    };
    const html = renderToStaticMarkup(<UsageAutoModeBars summary={ranked}/>);
    expect(html.indexOf('First key')).toBeLessThan(html.indexOf('Later key'));
    expect(html.indexOf('Later key')).toBeLessThan(html.indexOf('Other'));
    expect(html.indexOf('Other')).toBeLessThan(html.indexOf('Uncategorized'));
    expect(html).not.toContain('Exact block-reason values');
});

test('retains the four group legend when one group has no events', () => {
    const withCancellation = structuredClone(summary);
    withCancellation.allTools.outcomes.allowed--;
    withCancellation.allTools.outcomes.cancelled++;
    withCancellation.buckets[0]!.allTools.outcomes.allowed--;
    withCancellation.buckets[0]!.allTools.outcomes.cancelled++;
    const html = renderToStaticMarkup(<UsageAutoModeBars summary={withCancellation}/>);
    expect(html).toContain('Cancelled</span><b>1</b>');
    expect(html).toContain('Error</span><b>8</b>');
});

test('reports unavailable history and a verified no-policy-block state without inventing values', () => {
    const unavailable = structuredClone(summary);
    unavailable.allTools.coverage.state = 'unavailable';
    const unavailableHtml = renderToStaticMarkup(<UsageAutoModeBars summary={unavailable}/>);
    expect(unavailableHtml.match(/Decision history unavailable/g)).toHaveLength(2);
    expect(unavailableHtml).not.toContain('Exact decision values');

    const noBlocks = structuredClone(summary);
    noBlocks.allTools.outcomes.policy_blocked = 0;
    noBlocks.categories = [];
    const noBlocksHtml = renderToStaticMarkup(<UsageAutoModeBars summary={noBlocks}/>);
    expect(noBlocksHtml).toContain('No policy blocks');
    expect(noBlocksHtml).not.toContain('Exact block-reason values');
});
