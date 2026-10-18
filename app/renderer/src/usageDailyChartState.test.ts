import { expect, test } from 'bun:test';
import { collectRetainedUsage } from '../../../src/utils/statsUsage.js';
import { usageAnalyticsFamily, usageAnalyticsFamilyColor, usageCalendarAverage, usageDailyCalendar, usageDailySeries, usageDailyTotal, usageLatestBuild, usageToolRate } from './usageDailyChartState.js';
const snapshot = await collectRetainedUsage([], '2026-09-13T12:00:00.000Z');
test('sparse All buckets retain real calendar spacing and include empty days in the average', () => {
    const summary = structuredClone(snapshot.ranges.all);
    summary.startDate = '2026-09-01'; summary.endDateExclusive = '2026-09-11'; summary.bucketDays = 1;
    const template = snapshot.ranges['7d'].days[0]!;
    summary.days = ['2026-09-01', '2026-09-03', '2026-09-10'].map(date => ({ ...structuredClone(template), date }));
    const calendar = usageDailyCalendar(summary);
    expect(calendar.slots.map(slot => slot.center)).toEqual([.05, .25, .95]);
    expect(calendar.groups).toEqual([[0], [1], [2]]);
    expect(usageCalendarAverage(summary, [10, 20, 30])).toBe(6);
});
test('multi-day All buckets clamp the partial final bucket to the range end', () => {
    const summary = structuredClone(snapshot.ranges.all);
    summary.startDate = '2026-09-01'; summary.endDateExclusive = '2026-09-11'; summary.bucketDays = 4;
    const template = snapshot.ranges['7d'].days[0]!;
    summary.days = ['2026-09-01', '2026-09-05', '2026-09-09'].map(date => ({ ...structuredClone(template), date }));
    const calendar = usageDailyCalendar(summary);
    expect(calendar.slots.map(slot => slot.end - slot.start)).toEqual([.4, .4, 1 - .8]);
    expect(calendar.slots.at(-1)?.center).toBe(.9);
    expect(calendar.groups).toEqual([[0, 1, 2]]);
    expect(usageCalendarAverage(summary, [40, 40, 20])).toBe(40);
});
test('model families retain prototype order and Claude provider token', () => {
    expect(['gpt-6.1-sol', 'claude-opus-4-6', 'gpt-6-luna', 'gpt-5.6-terra', 'gpt-6-astra', 'gpt-5.5', 'claude-sonnet-4-6', 'unknown'].map(usageAnalyticsFamily)).toEqual(['Sol', 'Claude Opus', 'Luna', 'Terra', 'Astra', 'GPT 5.5', 'Claude Sonnet', 'Other']);
    expect(usageAnalyticsFamilyColor('Claude Opus')).toBe('var(--provider-claude)');
});
test('tokens by source use exclusive token totals and request efforts reconcile the model request total', () => {
    const summary = structuredClone(snapshot.ranges['7d']), day = summary.days[0]!;
    day.tokenSources.chat = { fresh: 10, read: 20, write: 2, output: 3 }; day.tokenSources.subagents.output = 7;
    const sources = usageDailySeries(summary, 'tokens', 'source');
    expect(sources.map(item => item.value(day))).toEqual([35, 7, 0]);
    day.requests = 99; day.effort.requests.high = 4; day.effort.unattributedRequests = 7; summary.effort.requests.high = 4;
    expect(usageDailySeries(summary, 'requests', 'family').map(item => item.value(day))).toEqual([4, 7]);
});
test('tool error rate divides errors by matched results and does not turn missing samples into zero', () => {
    expect(usageToolRate({ results: 0, errors: 0 })).toBeNull(); expect(usageToolRate({ results: 20, errors: 1 })).toBe(5);
    const summary = structuredClone(snapshot.ranges['7d']); summary.days[0]!.results = 20; summary.days[0]!.errors = 1;
    expect(usageDailyTotal(summary, 'toolErrors')).toBe(1); expect(usageDailyTotal(summary, 'errorRate')).toBe(5);
});
test('latest build merges all tools and days and median uses builds with enough results', () => {
    const summary = structuredClone(snapshot.ranges['7d']);
    summary.days[0]!.tools = [{ id: 'bash', requests: 200, results: 200, errors: 2, builds: { items: [{ sha: 'abc', dirty: false, requests: 200, results: 200, errors: 2, firstObservedAt: '2026-09-07T00:00:00Z' }] } }];
    summary.days[1]!.tools = [{ id: 'read', requests: 200, results: 200, errors: 4, builds: { items: [{ sha: 'def', dirty: true, requests: 200, results: 200, errors: 4, firstObservedAt: '2026-09-08T00:00:00Z' }] } }];
    const builds = usageLatestBuild(summary); expect(builds.latest?.sha).toBe('def'); expect(builds.latest?.dirty).toBe(true); expect(builds.median).toBe(1.5);
});
