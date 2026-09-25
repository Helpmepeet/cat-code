import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { UsagePage } from './UsagePage.js';
import { collectRetainedUsage } from '../../../src/utils/statsUsage.js';
import { initialUsageDashboardState, reduceUsageDashboard } from './usageDashboardState.js';
import { usageGraphColors } from './usageGraphState.js';
import { UsageCacheSummary, UsageModelDonut } from './UsageOverviewDetails.js';

const snapshot = await collectRetainedUsage([], '2026-09-13T12:00:00.000Z');
function populated() {
    const copy = structuredClone(snapshot);
    copy.ranges['7d'].tokens.fresh = 123;
    copy.ranges['7d'].records = 1;
    copy.ranges['7d'].days[0]!.tokens.fresh = 123;
    return copy;
}

test('loading, failure and confirmed empty history are distinct', () => {
    expect(renderToStaticMarkup(<UsagePage state={initialUsageDashboardState}/>)).toContain('Loading analytics');
    expect(renderToStaticMarkup(<UsagePage state={{ snapshot: null, status: 'error' }}/>)).toContain('Usage could not be loaded');
    const html = renderToStaticMarkup(<UsagePage state={{ snapshot, status: 'ready' }}/>);
    expect(html).toContain('No recorded activity in this period.');
    expect(html).not.toContain('usage-flow-chart');

    const incomplete = structuredClone(snapshot);
    incomplete.coverage.state = 'partial';
    incomplete.coverage.parseErrors = 1;
    const partialHtml = renderToStaticMarkup(<UsagePage state={{ snapshot: incomplete, status: 'ready' }}/>);
    expect(partialHtml).toContain('Activity for this period is incomplete.');
    expect(partialHtml).not.toContain('No recorded activity in this period.');
});

test('auto-mode attempts count as activity even without token records', () => {
    const copy = structuredClone(snapshot);
    copy.ranges['7d'].autoMode.allTools.outcomes.allowed = 1;
    const html = renderToStaticMarkup(<UsagePage state={{ snapshot: copy, status: 'ready' }}/>);
    expect(html).toContain('Auto mode');
    expect(html).not.toContain('No recorded activity in this period.');
});

test('populated page presents five metrics and the agreed panels without duplicate disclosures', () => {
    const html = renderToStaticMarkup(<UsagePage state={{ snapshot: populated(), status: 'ready' }}/>);
    for (const label of ['Analytics', 'Tokens', 'Prompt cache', 'Model usage', 'Tools', 'Activity by hour', 'Auto mode', 'View as table']) expect(html).toContain(label);
    expect(html.match(/class="usage-values"/g)).toHaveLength(1);
    for (const removed of ['Execution timing', 'Tool activity', 'Partial history', 'Token volume by hour']) expect(html).not.toContain(removed);
});

test('partial coverage retains visible counts without history banners or an unqualified cache ratio', () => {
    const copy = populated();
    copy.coverage.state = 'partial';
    copy.coverage.parseErrors = 1;
    const html = renderToStaticMarkup(<UsagePage state={{ snapshot: copy, status: 'ready' }}/>);
    expect(html).toContain('123');
    expect(html).not.toContain('Partial history');
    expect(html).toContain('Cache reads over time');
    expect(html).not.toContain('Cached input share,');
});

test('refresh failure retains saved values and exposes retry', () => {
    const copy = populated();
    const good = reduceUsageDashboard(initialUsageDashboardState, { type: 'usage', version: 1, snapshot: copy });
    const stale = reduceUsageDashboard(good, { type: 'error', version: 1, code: 'timeout' });
    expect(stale.snapshot).toBe(copy);
    const html = renderToStaticMarkup(<UsagePage state={stale} onRefresh={() => {}}/>);
    expect(html).toContain('Refresh failed. Try again');
    expect(html).toContain('usage-flow-chart');
});

test('tiny model geometry retains real fractional shares and distinct colors', () => {
    const range = structuredClone(snapshot.ranges['7d']);
    range.tokens.fresh = 10000;
    range.models = [{ id: 'a', kind: 'named', label: 'Tiny', tokens: { fresh: 1, read: 0, write: 0, output: 0 } }, { id: 'b', kind: 'named', label: 'Large', tokens: { fresh: 9999, read: 0, write: 0, output: 0 } }];
    const html = renderToStaticMarkup(<UsageModelDonut summary={range} colors={{ a: 'red', b: 'blue' }}/>);
    expect(html.match(/<path[^>]+role="button"/g)).toHaveLength(2);
    expect(html).toContain('Tiny: 1 tokens');
    expect(new Set(Object.values(usageGraphColors(Array.from({ length: 10 }, (_, i) => String(i))))).size).toBe(10);
});

test('cache writes distinguish unavailable, measured zero, and known partial counts', async () => {
    const { UsageCacheSummary } = await import('./UsageOverviewDetails.js');
    const range = structuredClone(snapshot.ranges['7d']);
    range.cacheWriteReporting = 'unreported';
    expect(renderToStaticMarkup(<UsageCacheSummary summary={range} partial={false}/>)).toContain('Cache writes</dt><dd title="Not reported">–');
    range.cacheWriteReporting = 'reported';
    range.tokens.fresh = 10;
    range.cachedInputShare = 0;
    const measuredHtml = renderToStaticMarkup(<UsageCacheSummary summary={range} partial={false}/>);
    expect(measuredHtml).toContain('Cache writes</dt><dd title="0">0');
    expect(measuredHtml).toContain('Cached input share, 0 to 100 percent');
    range.cacheWriteReporting = 'partial';
    range.tokens.write = 125;
    expect(renderToStaticMarkup(<UsageCacheSummary summary={range} partial={false}/>)).toContain('Cache writes</dt><dd title="125 reported">125 reported');
});

test('cache reads remain visible when cache-write reporting is mixed', () => {
    const range = structuredClone(snapshot.ranges['7d']);
    range.cacheWriteReporting = 'partial';
    range.cachedInputShare = null;
    range.days[0]!.cacheWriteReporting = 'reported';
    range.days[0]!.tokens = { fresh: 10, read: 90, write: 0, output: 0 };
    range.days[1]!.cacheWriteReporting = 'unreported';
    const html = renderToStaticMarkup(<UsageCacheSummary summary={range} partial={false}/>);
    expect(html).toContain('Cache reads over time');
    expect(html).toContain('usage-area-line');
    expect(html).toContain('Cache reads, 0 to');
});

test('cache-read history stays plotted when cache writes are unreported', () => {
    const range = structuredClone(snapshot.ranges['7d']);
    range.cacheWriteReporting = 'unreported';
    range.cachedInputShare = null;
    range.tokens.read = 3_000;
    range.days[0]!.tokens.read = 1_000;
    range.days[1]!.tokens.read = 2_000;
    const html = renderToStaticMarkup(<UsageCacheSummary summary={range} partial={false}/>);
    expect(html).toContain('Cache reads over time');
    expect(html).toContain('Cache reads, 0 to');
    expect(html).toContain('1,000 cache-read tokens');
    expect(html).toMatch(/<path d="[^"]+" class="usage-area-line"/);
    expect(html).not.toContain('Cached input share unavailable');
});

test('missing contributor details do not erase recorded daily totals', () => {
    const copy = populated();
    const day = copy.ranges['7d'].days[0]!;
    day.contributors = { state: 'unavailable', omitted: 0, items: [] };
    const render = () => renderToStaticMarkup(<UsagePage state={{ snapshot: copy, status: 'ready' }} selection={{ range: '7d', date: day.date }}/>);
    expect(render()).toContain('Session details are unavailable for this day.');
    expect(render()).toContain('123</strong> tokens');
});
