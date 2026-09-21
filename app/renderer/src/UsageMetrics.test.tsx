import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { collectRetainedUsage } from '../../../src/utils/statsUsage.js';
import { UsageMetrics } from './UsageMetrics.js';

const empty = await collectRetainedUsage([], '2026-09-13T12:30:00.000Z');
function comparable() {
    const summary = structuredClone(empty.ranges['7d']);
    Object.assign(summary, { tokens: { fresh: 60, read: 1140, write: 0, output: 0 }, activeDays: 3, sessions: 8, requests: 80, cachedInputShare: 95 });
    summary.previousPeriod = { startInclusive: '2026-08-31T00:00:00.000Z', endInclusive: '2026-09-06T12:30:00.000Z', tokens: { fresh: 100, read: 900, write: 0, output: 0 }, activeDays: 4, sessions: 10, records: 30, requests: 100, cachedInputShare: 90 };
    return summary;
}

test('each tile uses its matching prior metric and exposes the precise comparison period', () => {
    const html = renderToStaticMarkup(<UsageMetrics summary={comparable()} unknown="Loading" partial={false}/>);
    expect(html).toContain('Total tokens: 20% increase');
    expect(html).toContain('Per active day: 60% increase');
    expect(html).toContain('Sessions used: 20% decrease');
    expect(html).toContain('Tool requests: 20% decrease');
    expect(html).toContain('Cached input: 5 percentage points increase');
    expect(html).toContain('▲ 5 pp');
    expect(html).toContain('usage-delta-up');
    expect(html).toContain('usage-delta-down');
    expect(html).toContain('Compared with previous 7 days: 2026-08-31 00:00 to 2026-09-06 12:30 UTC');
});

test('All, incomplete history, absent baseline and zero count baseline omit deltas', () => {
    const summary = comparable();
    const render = (partial = false) => renderToStaticMarkup(<UsageMetrics summary={summary} unknown="Loading" partial={partial}/>);
    expect(render(true)).not.toContain('usage-metric-delta');
    summary.range = 'all';
    expect(render()).not.toContain('usage-metric-delta');
    summary.range = '7d';
    Object.assign(summary.previousPeriod!, { tokens: { fresh: 0, read: 0, write: 0, output: 0 }, activeDays: 0, sessions: 0, requests: 0, cachedInputShare: null });
    expect(render()).not.toContain('usage-metric-delta');
    Reflect.deleteProperty(summary, 'previousPeriod');
    expect(render()).not.toContain('usage-metric-delta');
    expect(renderToStaticMarkup(<UsageMetrics unknown="Loading" partial={false}/>)).not.toContain('usage-metric-delta');
});
