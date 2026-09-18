import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { hundredAttemptAutoModeFixture } from '../../../src/utils/autoModeUsage.fixture.js';
import { reduceAutoModeUsage } from '../../../src/utils/autoModeUsage.js';
import { UsageAutoModeBars } from './UsageAutoModeBars.js';

const summary = reduceAutoModeUsage(hundredAttemptAutoModeFixture());

test('renders ordered all-tool decision bars and exact values for the hundred-attempt fixture', () => {
    const html = renderToStaticMarkup(<UsageAutoModeBars summary={summary}/>);
    expect(html).toContain('Decisions over time');
    expect(html).toContain('Initial automatic permission decisions for all recorded tools.');
    expect(html).toContain('Allowed</span><b>85</b>');
    expect(html).toContain('Policy blocked</span><b>7</b>');
    expect(html).toContain('Review required</span><b>4</b>');
    expect(html).toContain('Operational error</span><b>4</b>');
    expect(html).not.toContain('Cancelled</span>');
    expect(html).not.toContain('Unknown</span>');
    expect(html).toContain('Exact decision values');
    expect(html).toContain('100</td>');
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
    expect(html).toContain('Exact block-reason values');
    expect(html).toContain('Total policy blocks');
    expect(html).toContain('7</td><td>100.0%</td>');
});

test('shows an extra outcome only when it occurs in the selected range', () => {
    const withCancellation = structuredClone(summary);
    withCancellation.allTools.outcomes.allowed--;
    withCancellation.allTools.outcomes.cancelled++;
    withCancellation.buckets[0]!.allTools.outcomes.allowed--;
    withCancellation.buckets[0]!.allTools.outcomes.cancelled++;
    const html = renderToStaticMarkup(<UsageAutoModeBars summary={withCancellation}/>);
    expect(html).toContain('Cancelled</span><b>1</b>');
    expect(html).not.toContain('Unknown</span>');
    expect(html).not.toContain('Incomplete</span>');
});

test('reports unavailable history and a verified no-policy-block state without inventing values', () => {
    const unavailable = structuredClone(summary);
    unavailable.allTools.coverage.state = 'unavailable';
    const unavailableHtml = renderToStaticMarkup(<UsageAutoModeBars summary={unavailable}/>);
    expect(unavailableHtml.match(/Automatic permission decisions are unavailable for this period\./g)).toHaveLength(2);
    expect(unavailableHtml).not.toContain('Exact decision values');

    const noBlocks = structuredClone(summary);
    noBlocks.allTools.outcomes.policy_blocked = 0;
    noBlocks.categories = [];
    const noBlocksHtml = renderToStaticMarkup(<UsageAutoModeBars summary={noBlocks}/>);
    expect(noBlocksHtml).toContain('No recorded policy blocks in this period.');
    expect(noBlocksHtml).not.toContain('Exact block-reason values');
});
