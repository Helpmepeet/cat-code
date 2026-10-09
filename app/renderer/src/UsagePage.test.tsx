import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { UsagePage } from './UsagePage.js';
import { collectRetainedUsage } from '../../../src/utils/statsUsage.js';
import { initialUsageDashboardState, reduceUsageDashboard } from './usageDashboardState.js';
import { usageGraphColors } from './usageGraphState.js';
import { UsageCacheSummary, UsageModelDonut } from './UsageOverviewDetails.js';
import { UsageParallelSessions, UsageReasoningEffort } from './UsageWorkPatterns.js';

const snapshot = await collectRetainedUsage([], '2026-09-13T12:00:00.000Z');
const activityAsOf = '2026-10-08T12:00:00.000Z';
async function activitySnapshot(rows: unknown[], timezone = 'Asia/Bangkok', asOf = activityAsOf) {
    return collectRetainedUsage(['/isolated/analytics-display.jsonl'], asOf, {
        timezone,
        readRecords: async (_path, consume) => {
            for (const [offset, value] of rows.entries()) await consume({ value, offset, generation: 'display-test' });
            return { bytesRead: rows.length, parseErrors: 0, oversizedRecords: 0, pendingTailBytes: 0, shortReads: 0, changedSources: 0 };
        },
    });
}
function dailyRecords(count: number, omitted: readonly number[] = []) {
    return Array.from({ length: count }, (_, index) => ({
        type: 'assistant', sessionId: 'display-test', uuid: `record-${index}`,
        timestamp: new Date(Date.parse(activityAsOf) - (count - index - 1) * 86400000).toISOString(),
        message: { id: `message-${index}`, model: 'model', usage: { input_tokens: 1, output_tokens: 1 }, content: [] },
    })).filter((_, index) => !omitted.includes(index));
}
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
    for (const label of ['Analytics', 'Tokens', 'Prompt cache', 'Model usage', 'Tools', 'Daily activity', 'Parallel sessions', 'Reasoning effort', 'Auto mode', 'View as table']) expect(html).toContain(label);
    expect(html.match(/class="usage-values"/g)).toHaveLength(1);
    for (const removed of ['Execution timing', 'Tool activity', 'Partial history', 'Token volume by hour', 'Activity by hour']) expect(html).not.toContain(removed);
});

test('new panels distinguish unavailable history from recorded aggregates', () => {
    const summary = structuredClone(snapshot.ranges['7d']);
    const props = { summary, selected: '', onSelect: () => {} };
    expect(renderToStaticMarkup(<UsageParallelSessions {...props}/>)).toContain('0.0h');
    summary.parallel.state = 'unavailable';
    expect(renderToStaticMarkup(<UsageParallelSessions {...props}/>)).toContain('Not recorded in this period.');
    expect(renderToStaticMarkup(<UsageReasoningEffort {...props}/>)).toContain('Not recorded in this period.');
    summary.parallel = { state: 'available', minutes: [30, 10, 0], peak: 2 };
    summary.effort = { state: 'available', requests: { low: 0, medium: 0, high: 3, xhigh: 0, max: 0, ultra: 2 }, tokens: { low: 0, medium: 0, high: 120, xhigh: 0, max: 0, ultra: 80 }, unattributedRequests: 0 };
    expect(renderToStaticMarkup(<UsageParallelSessions {...props}/>)).toContain('25%');
    summary.days[0]!.effort = structuredClone(summary.effort);
    const effortHtml = renderToStaticMarkup(<UsageReasoningEffort {...props}/>);
    expect(effortHtml).toContain('High');
    expect(effortHtml).toContain('<span>Ultra</span><b>2</b>');
    expect(effortHtml).toContain('Ultra: 40.0%');
    expect(effortHtml).toContain('class="usage-pattern-e6"');
});

test('partial coverage retains visible counts and qualifies the recorded cache rate', () => {
    const copy = populated();
    copy.coverage.state = 'partial';
    copy.coverage.parseErrors = 1;
    const html = renderToStaticMarkup(<UsagePage state={{ snapshot: copy, status: 'ready' }}/>);
    expect(html).toContain('123');
    expect(html).not.toContain('Partial history');
    expect(html).toContain('Cache read rate, 0 to 100 percent');
    expect(html).toContain('partial history');
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
    expect(measuredHtml).toContain('Cache read rate, 0 to 100 percent');
    range.cacheWriteReporting = 'partial';
    range.tokens.write = 125;
    expect(renderToStaticMarkup(<UsageCacheSummary summary={range} partial={false}/>)).toContain('Cache writes</dt><dd title="125 reported">125 reported');
});

test('cache percentage remains visible when cache-write reporting is mixed', () => {
    const range = structuredClone(snapshot.ranges['7d']);
    range.cacheWriteReporting = 'partial';
    range.cachedInputShare = null;
    range.days[0]!.cacheWriteReporting = 'reported';
    range.days[0]!.tokens = { fresh: 10, read: 90, write: 0, output: 0 };
    range.days[1]!.cacheWriteReporting = 'unreported';
    const html = renderToStaticMarkup(<UsageCacheSummary summary={range} partial={false}/>);
    expect(html).toContain('Cache read rate, 0 to 100 percent');
    expect(html).toContain('usage-area-line');
    expect(html).toContain('90.0% cache read rate');
});

test('cache percentage stays plotted when cache writes are unreported', () => {
    const range = structuredClone(snapshot.ranges['7d']);
    range.cacheWriteReporting = 'unreported';
    range.cachedInputShare = null;
    range.tokens.read = 3_000;
    range.tokens.fresh = 300;
    range.days[0]!.tokens.read = 1_000;
    range.days[0]!.tokens.fresh = 100;
    range.days[1]!.tokens.read = 2_000;
    range.days[1]!.tokens.fresh = 200;
    const html = renderToStaticMarkup(<UsageCacheSummary summary={range} partial={false}/>);
    expect(html).toContain('Cache read rate, 0 to 100 percent');
    expect(html).toContain('90.9% cache read rate');
    expect(html).toMatch(/<path d="[^"]+" class="usage-area-line"/);
});

test('missing contributor details do not erase recorded daily totals', () => {
    const copy = populated();
    const day = copy.ranges['7d'].days[0]!;
    day.contributors = { state: 'unavailable', omitted: 0, items: [] };
    const render = () => renderToStaticMarkup(<UsagePage state={{ snapshot: copy, status: 'ready' }} selection={{ range: '7d', date: day.date }}/>);
    expect(render()).toContain('Session details are unavailable for this day.');
    expect(render()).toContain('123</strong> tokens');
});

test('comparison dates use the snapshot timezone on both sides of UTC midnight', async () => {
    for (const [timezone, asOf, current, previous] of [
        ['Asia/Bangkok', activityAsOf, 'Oct 2 to Oct 8', 'Sep 25 to Oct 1'],
        ['America/Los_Angeles', '2026-10-08T02:00:00.000Z', 'Oct 1 to Oct 7', 'Sep 24 to Sep 30'],
    ] as const) {
        const rows = ['2026-09-01T12:00:00.000Z', asOf].map((timestamp, index) => ({ type: 'user', sessionId: 'display-test', uuid: `user-${index}`, timestamp }));
        const copy = await activitySnapshot(rows, timezone, asOf);
        const html = renderToStaticMarkup(<UsagePage state={{ snapshot: copy, status: 'ready' }}/>);
        const freshness = html.match(/<p class="usage-freshness">(.*?)<\/p>/)?.[1];
        expect(freshness).toContain(current);
        expect(freshness).toContain(`vs ${previous}`);
    }
});

test('zero-token user activity counts toward active days and streaks', async () => {
    const copy = await activitySnapshot(['2026-09-01T12:00:00.000Z', activityAsOf].map((timestamp, index) => ({ type: 'user', sessionId: 'display-test', uuid: `user-${index}`, timestamp })));
    expect(copy.ranges['7d'].activeDays).toBe(1);
    expect(copy.ranges.all.activeDays).toBe(2);
    const html = renderToStaticMarkup(<UsagePage state={{ snapshot: copy, status: 'ready' }}/>);
    expect(html).toContain('1 active days');
    expect(html).toContain('<b>2</b>active days');
    expect(html).toContain('<b>1</b>longest streak');
    expect(html).toContain('<b>1</b>current streak');
});

for (const count of [60, 61, 70]) test(`daily activity discloses bounded detail at ${count} consecutive days`, async () => {
    const copy = await activitySnapshot(dailyRecords(count));
    expect(copy.ranges.all.activeDays).toBe(count);
    expect(copy.ranges.all.bucketDays ?? 1).toBe(count === 60 ? 1 : 2);
    const html = renderToStaticMarkup(<UsagePage state={{ snapshot: copy, status: 'ready' }} selection={{ range: 'all', date: '' }}/>);
    expect(html).toContain(`${count} active days`);
    expect(html).toContain(`<h2>Total tokens</h2><strong>${count * 2}</strong>`);
    if (count === 60) {
        expect(html).toContain('<b>60</b>active days');
        expect(html).toContain('<b>60</b>longest streak');
        expect(html).toContain('<b>60</b>current streak');
        expect(html).not.toContain('Earlier daily detail is unavailable.');
    } else {
        expect(html).toContain('Daily activity (last 30 days)');
        expect(html).toContain('Earlier daily detail is unavailable.');
        expect(html).toContain('<b>30</b>active days');
        expect(html).toContain('<b>30</b>longest streak');
        expect(html).toContain('<b>30+</b>current streak');
        expect(html).toContain('A + marks a current streak that may extend further.');
        expect(html).not.toContain('data-date="2026-09-08" class="usage-heat-cell"');
    }
});

test('a known inactive day ends a current streak without inferring older bucketed days', async () => {
    const copy = await activitySnapshot(dailyRecords(70, [64]));
    const html = renderToStaticMarkup(<UsagePage state={{ snapshot: copy, status: 'ready' }} selection={{ range: 'all', date: '' }}/>);
    expect(html).toContain('69 active days');
    expect(html).toContain('Daily activity (last 30 days)');
    expect(html).toContain('<b>29</b>active days');
    expect(html).toContain('<b>24</b>longest streak');
    expect(html).toContain('<b>5</b>current streak');
    expect(html).not.toContain('A + marks');
});
