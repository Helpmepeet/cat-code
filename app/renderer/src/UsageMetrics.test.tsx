import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { collectRetainedUsage } from '../../../src/utils/statsUsage.js';
import { UsageMetrics } from './UsageMetrics.js';
const empty = await collectRetainedUsage([], '2026-09-13T12:30:00.000Z');
function comparable() {
    const summary = structuredClone(empty.ranges['7d']);
    Object.assign(summary, { tokens: { fresh: 60, read: 1140, write: 0, output: 0 }, activeDays: 3, sessions: 8, requests: 80, cachedInputShare: 95, cacheWriteReporting: 'reported' });
    summary.days[0]!.results = 100; summary.days[0]!.errors = 5;
    summary.effort.requests.high = 64; summary.effort.unattributedRequests = 16;
    summary.previousPeriod = { startInclusive: '2026-08-31T00:00:00.000Z', endInclusive: '2026-09-06T12:30:00.000Z', tokens: { fresh: 100, read: 900, write: 0, output: 0 }, activeDays: 4, sessions: 10, records: 30, requests: 100, modelRequests: 100, results: 100, errors: 10, cachedInputShare: 90, cacheWriteReporting: 'reported' };
    return summary;
}
test('approved summary tiles use exact prior metrics and percentage-point rates', () => {
    const html = renderToStaticMarkup(<UsageMetrics summary={comparable()} unknown="Loading" partial={false}/>);
    for (const text of ['Model requests: 20% decrease', 'Sessions: 20% decrease', 'Input from cache: 5 percentage points increase', 'Tool error rate: 5 percentage points decrease', 'Latest build errors', 'vs prior 7 days']) expect(html).toContain(text);
    expect(html).not.toContain('Total tokens'); expect(html).not.toContain('Tool requests');
});
test('All, incomplete, absent and zero count baselines do not imply comparisons', () => {
    const summary = comparable(), render = (partial = false) => renderToStaticMarkup(<UsageMetrics summary={summary} unknown="Loading" partial={partial}/>);
    expect(render(true)).not.toContain('usage-metric-delta');
    summary.range = 'all'; expect(render()).not.toContain('usage-metric-delta');
    summary.range = '7d'; summary.previousPeriod = undefined; expect(render()).not.toContain('usage-metric-delta');
    expect(renderToStaticMarkup(<UsageMetrics unknown="Loading" partial={false}/>)).not.toContain('usage-metric-delta');
});
test('cache share preserves snapshot units and includes reported writes in the spark', () => {
    const summary = comparable(); summary.days[0]!.tokens = { fresh: 10, read: 80, write: 10, output: 0 };
    const html = renderToStaticMarkup(<UsageMetrics summary={summary} unknown="Loading" partial={false}/>);
    expect(html).toContain('95.0%'); expect(html).not.toContain('9500');
});
test('model requests never reuse the tool request count', () => {
    const summary = comparable();
    summary.requests = 999;
    const html = renderToStaticMarkup(<UsageMetrics summary={summary} unknown="Loading" partial={false}/>);
    expect(html).toContain('Model requests</span><span class="usage-metric-row"><strong>80</strong>');
    expect(html).not.toContain('999');
});
test('latest build is explicitly qualified and has a meaningful empty sample state', () => {
    const summary = comparable();
    const render = () => renderToStaticMarkup(<UsageMetrics summary={summary} unknown="–" partial={false}/>);
    expect(render()).toContain('No builds with ≥200 results');
    summary.days[0]!.tools = [{ id: 'bash', requests: 220, results: 200, errors: 2, builds: { items: [
        { sha: 'abcdef1', dirty: false, requests: 220, results: 200, errors: 2, firstObservedAt: '2026-09-07T00:00:00Z' },
        { sha: 'newest', dirty: false, requests: 10, results: 10, errors: 1, firstObservedAt: '2026-09-08T00:00:00Z' },
    ] } }];
    expect(render()).toContain('<code>abcdef1</code>');
    expect(render()).not.toContain('<code>newest</code>');
    expect(render()).toContain('newer builds below that threshold are excluded');
    expect(render()).toContain('Latest build with at least 200 tool results');
});

test('summary sparks and rate changes use prototype forms without cache-write qualifications', () => {
    const summary = comparable();
    summary.cacheWriteReporting = 'partial';
    const html = renderToStaticMarkup(<UsageMetrics summary={summary} unknown="–" partial={false}/>);
    expect(html).toContain('viewBox="0 0 63 28"');
    expect(html).toContain('offset="0.25"');
    expect(html).toContain('usage-metric-delta usage-change-good');
    expect(html).not.toContain('Writes partly reported');
    summary.previousPeriod!.errors = 1;
    const worse = renderToStaticMarkup(<UsageMetrics summary={summary} unknown="–" partial={false}/>);
    expect(worse).toContain('usage-metric-delta usage-change-bad');
    expect(worse).not.toContain('usage-delta-up');
});

test('latest build shares a baseline with its median and retains per-build hover values', () => {
    const summary = comparable();
    summary.days[0]!.tools = [{ id: 'bash', requests: 400, results: 400, errors: 22, builds: { items: [
        { sha: 'old-build', dirty: false, requests: 200, results: 200, errors: 2, firstObservedAt: '2026-09-07T00:00:00Z' },
        { sha: 'new-build', dirty: true, requests: 200, results: 200, errors: 20, firstObservedAt: '2026-09-08T00:00:00Z' },
    ] } }];
    const html = renderToStaticMarkup(<UsageMetrics summary={summary} unknown="–" partial={false}/>);
    expect(html).toContain('usage-build-rate-bad');
    expect(html).toContain('<span class="usage-build-median">median 5.5%</span>');
    expect(html).toContain('<title>new-build (uncommitted): 10.0% tool errors</title>');
    expect(html).toContain('usage-build-chart');
    summary.days[0]!.tools[0]!.builds!.items[0]!.firstObservedAt = '2026-09-09T00:00:00Z';
    expect(renderToStaticMarkup(<UsageMetrics summary={summary} unknown="–" partial={false}/>)).toContain('usage-build-rate-good');
});
