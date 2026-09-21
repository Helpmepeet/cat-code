import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { UsagePage } from './UsagePage.js';
import { collectRetainedUsage } from '../../../src/utils/statsUsage.js';
import { initialUsageDashboardState, reduceUsageDashboard, usageColors } from './usageDashboardState.js';
import { usageGraphColors } from './usageGraphState.js';
import { UsageModelDonut } from './UsageOverviewDetails.js';
const snapshot = await collectRetainedUsage([], '2026-09-13T12:00:00.000Z');
test('loading, failure and confirmed empty history are distinct; zero prompt is not applicable', () => {
    const loading = renderToStaticMarkup(<UsagePage state={initialUsageDashboardState}/>);
    expect(loading).toContain('Loading recorded usage');
    expect(loading).not.toContain('No recorded usage');
    const error = renderToStaticMarkup(<UsagePage state={{ snapshot: null, status: 'error' }}/>);
    expect(error).toContain('Usage could not be loaded');
    expect(error).not.toContain('No recorded usage');
    const html = renderToStaticMarkup(<UsagePage state={{ snapshot, status: 'ready' }}/>);
    expect(html).toContain('No recorded usage in available history.');
    expect(html).toContain('Not applicable');
    expect(html).toContain('Accessible values table');
    for (const panel of ['Token flow', 'Model usage', 'Prompt cache', 'Tool activity', 'Execution timing', 'Token volume by hour'])
        expect(html).toContain(panel);
    expect(html).not.toContain('Tokens per Session');
    expect(html).not.toContain('Daily Average');
});
test('normal usage omits redundant period labels, coaching and accounting diagnostics', () => {
    const copy = structuredClone(snapshot);
    copy.coverage.identityConflicts = 2;
    copy.ranges['7d'].fallbackRequests = 3;
    const html = renderToStaticMarkup(<UsagePage state={{ snapshot: copy, status: 'ready' }}/>);
    for (const text of [
        '7-day overview',
        '7-day totals',
        'Conflicting records found',
        'requests have uncertain identification',
        'Select a day to see its sessions',
        'Select a cell to show sessions',
        'Based on retained local sessions',
        'Zoomed to the recorded range',
        'Hover to inspect',
        'Click a tool for its result breakdown',
        'Error rates use matched tool results',
    ]) expect(html).not.toContain(text);
    expect(html).toContain('Errors / results');
});
test('partial zero history cannot be presented as confirmed inactivity or an unqualified ratio', () => {
    const partial = structuredClone(snapshot);
    partial.coverage.state = 'partial';
    partial.coverage.parseErrors = 1;
    const html = renderToStaticMarkup(<UsagePage state={{ snapshot: partial, status: 'ready' }}/>);
    expect(html).toContain('Partial history');
    expect(html).not.toContain('No recorded usage in available history');
    expect(html).toContain('Cache share is unavailable');
    expect(html).toContain('A zero does not establish inactivity');
});
test('invalid timing records are scoped to timing without making usage history partial', () => {
    const copy = structuredClone(snapshot);
    copy.coverage.invalidTimings = 2;
    const html = renderToStaticMarkup(<UsagePage state={{ snapshot: copy, status: 'ready' }}/>);
    expect(html).toContain('2 invalid timing records were excluded');
    expect(html).not.toContain('Partial history');
});
test('refresh failure keeps saved values without adding status prose', () => {
    const good = reduceUsageDashboard(initialUsageDashboardState, { type: 'usage', version: 1, snapshot });
    const stale = reduceUsageDashboard(good, { type: 'error', version: 1, code: 'timeout' });
    expect(stale.snapshot).toBe(snapshot);
    const html = renderToStaticMarkup(<UsagePage state={stale}/>);
    expect(html).not.toContain('Showing an older snapshot');
    expect(html).not.toContain('Usage update timed out');
    expect(html).not.toContain('Another attempt will run automatically');
    expect(renderToStaticMarkup(<UsagePage state={{ snapshot, status: 'loading' }}/>)).not.toContain('Refreshing recorded usage');
    expect(reduceUsageDashboard(stale, { type: 'usage', version: 1, snapshot }).status).toBe('ready');
});
test('tiny model geometry uses real fractional shares; palette has distinct colors', () => {
    const range = structuredClone(snapshot.ranges['7d']);
    range.tokens.fresh = 10000;
    range.models = [{ id: 'a', kind: 'named', label: 'Tiny', tokens: { fresh: 1, read: 0, write: 0, output: 0 } }, { id: 'b', kind: 'named', label: 'Large', tokens: { fresh: 9999, read: 0, write: 0, output: 0 } }];
    const html = renderToStaticMarkup(<UsageModelDonut summary={range} colors={usageColors(['a', 'b'])}/>);
    expect(html.match(/<path[^>]+role="button"/g)).toHaveLength(2);
    expect(html).toContain('Tiny: 1 tokens');
    expect(html).toContain('Large: 9,999 tokens');
    expect(new Set(Object.values(usageColors(Array.from({ length: 10 }, (_, i) => String(i))))).size).toBe(10);
    expect(new Set(Object.values(usageGraphColors(Array.from({ length: 10 }, (_, i) => String(i))))).size).toBe(10);
});
test('specific failure reason is shown only when there are no saved values', () => {
    const state = reduceUsageDashboard({ snapshot, status: 'ready' }, { type: 'error', version: 1, code: 'resource-limit' });
    expect(renderToStaticMarkup(<UsagePage state={state}/>)).not.toContain('Usage history exceeded the processing limit');
    expect(renderToStaticMarkup(<UsagePage state={{ snapshot: null, status: 'error', errorCode: 'resource-limit' }}/>)).toContain('Usage history exceeded the processing limit');
    expect(state.snapshot).toBe(snapshot);
});
test('cache trend fits observed percentages with padding and keeps valid endpoints', async () => {
    const { usageCacheBounds } = await import('./usageDashboardState.js');
    expect(usageCacheBounds([95, 96, 97, null])).toEqual({ min: 93, max: 99 });
    expect(usageCacheBounds([100, 100])).toEqual({ min: 98, max: 100 });
    expect(usageCacheBounds([0])).toEqual({ min: 0, max: 2 });
    expect(usageCacheBounds([null])).toEqual({ min: 0, max: 100 });
});
test('cache-write availability distinguishes unreported from a measured zero', async () => {
    const { usageCacheWrites } = await import('./usageDashboardState.js');
    const { UsageCacheSummary } = await import('./UsageOverviewDetails.js');
    const range = structuredClone(snapshot.ranges['7d']);
    range.cacheWriteReporting = 'unreported';
    const html = renderToStaticMarkup(<UsageCacheSummary summary={range} partial={false}/>);
    expect(html).not.toContain('<dt>Cache writes</dt>');
    expect(html).not.toContain('usage-cache-with-writes');
    range.cacheWriteReporting = 'reported';
    const measured = renderToStaticMarkup(<UsageCacheSummary summary={range} partial={false}/>);
    expect(measured).toContain('Cache writes</dt><dd>0<small>0.0%</small></dd>');
    expect(usageCacheWrites(0, 'reported')).toBe('0');
    expect(usageCacheWrites(1200, 'partial')).toBe('1,200 reported');
    expect(usageCacheWrites(0, 'unavailable')).toBe('Not applicable');
});

test('missing and unavailable contributor details do not erase recorded daily totals', () => {
    const copy = structuredClone(snapshot);
    const day = copy.ranges['7d'].days[0]!;
    day.tokens.fresh = 123;
    day.contributors = { state: 'unavailable', omitted: 0, items: [] };
    const render = () => renderToStaticMarkup(<UsagePage state={{ snapshot: copy, status: 'ready' }} selection={{ range: '7d', date: day.date }}/>);
    expect(render()).toContain('Session details are unavailable for this day.');
    expect(render().replace(/<[^>]+>/g, '')).toContain('123 tokens');
    // A renderer hot reload can temporarily retain an older host's snapshot.
    Reflect.deleteProperty(day, 'contributors');
    expect(render()).toContain('Session details are unavailable for this day.');
});
