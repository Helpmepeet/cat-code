import { expect, test } from 'bun:test';
import { collectRetainedUsage } from '../../src/utils/statsUsage.js';
import { groupUsageSummary } from '../sidecar/usageSummary.js';
import { MAX_USAGE_RANGE_BUILDS, usageRangeBuilds } from './usageBuilds.js';
import { usageLatestBuild } from '../renderer/src/usageDailyChartState.js';
import { analyticsBuildGeometry } from '../renderer/src/usageAnalyticsChartState.js';

const build = (sha: string, results: number, errors = 0, dirty = false, firstObservedAt = '2026-09-07T10:00:00.000Z') => ({ sha, dirty, requests: results, results, errors, firstObservedAt });

test('period build counts combine tools and days before thresholding and survive complete daily detail removal', async () => {
    const summary = (await collectRetainedUsage([], '2026-09-13T12:00:00.000Z', { timezone: 'UTC' })).ranges['7d'];
    summary.days[0]!.tools = [
        { id: 'read', requests: 100, results: 100, errors: 2, builds: { items: [build('aaaaaaa', 100, 2)] } },
        { id: 'edit', requests: 80, results: 80, errors: 4, builds: { items: [build('aaaaaaa', 80, 4)] } },
    ];
    summary.days[1]!.tools = [{ id: 'read', requests: 219, results: 219, errors: 11, builds: { items: [
        build('aaaaaaa', 20, 1, false, '2026-09-08T10:00:00.000Z'), build('aaaaaaa', 199, 10, true, '2026-09-08T11:00:00.000Z'),
    ] } }];
    const grouped = groupUsageSummary(summary, 0, 0, 0, 0, 0, 0);
    expect(grouped.days.every(day => day.tools.every(tool => !tool.builds?.items.length))).toBe(true);
    expect(grouped.builds?.items).toEqual([build('aaaaaaa', 200, 7), build('aaaaaaa', 199, 10, true, '2026-09-08T11:00:00.000Z')]);
    const again = groupUsageSummary(grouped, 0, 0, 0, 0, 0, 0);
    expect(again.builds).toEqual(grouped.builds);
    const latest = usageLatestBuild(again);
    expect(latest.items).toHaveLength(1);
    expect(latest.latest?.results).toBe(200);
    expect(latest.median).toBeCloseTo(3.5);
    const scatter = analyticsBuildGeometry(again, 600);
    expect(scatter.points).toHaveLength(1);
    expect(scatter.points[0]).toMatchObject({ sha: 'aaaaaaa', dirty: false, results: 200, errors: 7 });
    expect(scatter.points[0]!.rate).toBeCloseTo(3.5);
    expect(scatter.median).toBe(latest.median);
});

test('bounded overview keeps recent qualifying builds ahead of new small samples and reconciles omissions', async () => {
    const summary = (await collectRetainedUsage([], '2026-09-13T12:00:00.000Z')).ranges['7d'];
    const items = Array.from({ length: MAX_USAGE_RANGE_BUILDS + 3 }, (_, i) => build(i.toString(16).padStart(7, '0'), i === 32 ? 199 : 200, i, false, new Date(Date.UTC(2026, 8, 7, 10, i)).toISOString()));
    summary.days[0]!.tools = [{ id: 'read', requests: 0, results: 0, errors: 0, builds: { items, omitted: { count: 1, requests: 9, results: 8, errors: 1 } } }];
    const result = usageRangeBuilds(summary);
    expect(result.items).toHaveLength(MAX_USAGE_RANGE_BUILDS);
    expect(result.items.every(item => item.results >= 200)).toBe(true);
    expect(result.items[0]!.sha).toBe('0000002');
    expect(result.items.at(-1)!.sha).toBe('000001f');
    expect(result.omitted?.count).toBe(4);
    for (const key of ['requests', 'results', 'errors'] as const) {
        expect(result.items.reduce((sum, item) => sum + item[key], result.omitted![key])).toBe(items.reduce((sum, item) => sum + item[key], summary.days[0]!.tools[0]!.builds!.omitted![key]));
    }
});
