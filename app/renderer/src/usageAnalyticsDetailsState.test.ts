import { expect, test } from 'bun:test';
import { collectRetainedUsage } from '../../../src/utils/statsUsage.js';
import { analyticsActivityAvailable, analyticsBucketAxis, analyticsBuilds, analyticsModelFamily, analyticsRouteLabels, analyticsRouteTiles, detailCalendarLine, detailLine, detailRate, usageAnalyticsToolColor, analyticsModelLatency, analyticsDuration } from './usageAnalyticsDetailsState.js';

test('cache rate uses all reported input and zero input is unavailable', () => {
    expect(detailRate({ fresh: 20, read: 60, write: 20, output: 500 })).toBe(60);
    expect(detailRate({ fresh: 0, read: 0, write: 0, output: 5 })).toBeNull();
    expect(analyticsRouteLabels.allowlist).toBe('Allowed tools');
});
test('model families use word boundaries rather than incidental substrings', () => {
    expect(analyticsModelFamily('GPT-6.1 Sol')).toBe('sol');
    expect(analyticsModelFamily('claude-opus-4-6')).toBe('opus');
    expect(analyticsModelFamily('gpt-5.5')).toBe('gpt-5.5');
    expect(analyticsModelFamily('solution')).toBe('other');
});
test('shared tool colors follow transcript classification with analytics exceptions', () => {
    const groups: [string[], string][] = [
        [['Bash', 'PowerShell', 'bash_code_execution'], 'light-dark(#0f766e,#2dd4bf)'],
        [['WebFetch', 'GenerateImage'], 'light-dark(#a21caf,#e879f9)'],
        [['Read'], 'light-dark(#2563eb,#60a5fa)'],
        [['Grep', 'Glob', 'tool_search_tool_regex', 'tool_search_tool_bm25'], 'light-dark(#a35f00,#fbbf24)'],
        [['Skill', 'ToolSearch'], 'light-dark(#0f766e,#5eead4)'],
        [['Write'], 'light-dark(#c2410c,#fb923c)'],
        [['NotebookEdit'], 'light-dark(#c2410c,#f97316)'],
        [['LSP'], 'light-dark(#dc2626,#f87171)'],
        [['SendMessage'], 'light-dark(#6d28d9,#a78bfa)'],
        [['WebSearch', 'web_search', 'web_fetch'], 'light-dark(#0e7490,#22d3ee)'],
        [['mcp__example__call'], 'light-dark(#7c3aed,#c084fc)'],
        [['Edit', 'apply_patch', 'Apply_patch', 'text_editor_code_execution', 'Agent', 'Task', 'ResumeAgent'], 'var(--accent)'],
        [['code_execution', 'future_tool'], 'var(--color-text-muted)'],
    ];
    for (const [labels, color] of groups) for (const label of labels) expect(usageAnalyticsToolColor(label)).toBe(color);
});
test('line gaps do not connect unavailable rates', () => {
    expect(detailLine([10, null, 30], 100, 30, 30)).toBe('M0.00,20.00  M100.00,0.00');
});
test('latency geometry preserves samples, log spacing, zeros and null quantiles', async () => {
    const snapshot = await collectRetainedUsage([], '2026-10-18T12:00:00Z');
    const models = snapshot.ranges['7d'].timing.models;
    models.state = 'available';
    models.responseDuration = { samples: 3, p50Ms: 0, p95Ms: 1000 };
    models.firstText = { samples: 1, p50Ms: null, p95Ms: 10 };
    const data = analyticsModelLatency(models);
    expect(data.rows.map(row => row.samples)).toEqual([3, 1]);
    expect(data.rows[1]!.p50Ms).toBeNull();
    expect(data.x(0)).toBe(150);
    expect(data.x(1000) - data.x(100)).toBeCloseTo(data.x(100) - data.x(10));
    expect(analyticsDuration(0)).toBe('0 ms');
    expect(analyticsDuration(null)).toBe('Unavailable');
    models.state = 'unavailable';
    expect(analyticsModelLatency(models).rows.every(row => row.p50Ms === null && row.p95Ms === null)).toBe(true);
});
test('build grouping preserves dirty identity and sums only displayed attribution', async () => {
    const snapshot = await collectRetainedUsage([], '2026-10-18T12:00:00Z');
    const summary = snapshot.ranges['7d'];
    summary.days[0]!.tools = [{ id: 'bash', requests: 9, results: 7, errors: 2, builds: { items: [{ sha: 'abc', dirty: false, requests: 3, results: 2, errors: 1, firstObservedAt: '2026-10-12T12:00:00Z' }, { sha: 'abc', dirty: true, requests: 4, results: 3, errors: 1, firstObservedAt: '2026-10-12T13:00:00Z' }], omitted: { count: 1, requests: 2, results: 2, errors: 0 } } }];
    const builds = analyticsBuilds(summary);
    expect(builds.items).toHaveLength(2);
    expect(builds.attributed).toBe(5);
    expect(builds.omitted).toBe(1);
});
test('route tiles preserve total area and unknown outcomes are not treated as allowed', async () => {
    const snapshot = await collectRetainedUsage([], '2026-10-18T12:00:00Z');
    const summary = snapshot.ranges['7d'];
    summary.autoMode.routes = [{ route: 'base', outcome: 'allowed', count: 6 }, { route: 'guard', outcome: 'unknown_outcome', count: 2 }, { route: 'guard', outcome: 'policy_blocked', count: 2 }];
    const tiles = analyticsRouteTiles(summary);
    expect(tiles.reduce((sum, tile) => sum + tile.width * tile.height, 0)).toBeCloseTo(600 * 240);
    expect(tiles.find(tile => tile.route === 'guard')?.notAllowed).toBe(4);
});
test('bucket axis includes the final partial bucket without projecting beyond the chart', async () => {
    const snapshot = await collectRetainedUsage([], '2026-10-18T12:00:00Z');
    const summary = snapshot.ranges.all;
    summary.startDate = '2026-10-01';
    summary.endDateExclusive = '2026-10-10';
    summary.bucketDays = 4;
    expect(analyticsBucketAxis(summary)).toEqual({ first: Date.parse('2026-10-01T00:00:00Z'), last: Date.parse('2026-10-09T00:00:00Z'), count: 3 });
});
test('sparse rate lines do not bridge missing buckets, and missing concurrency slots stay unavailable', async () => {
    const snapshot = await collectRetainedUsage([], '2026-10-18T12:00:00Z');
    const summary = snapshot.ranges['30d'];
    summary.days = [summary.days[0]!, summary.days[3]!];
    const path = detailCalendarLine(summary, [10, 30], 100, 30, 30);
    expect(path.match(/M/g)).toHaveLength(2);
    expect(path).not.toContain('L');
    summary.days[0]!.parallel = { state: 'available', minutes: [0, 0, 0], peak: 0, tenMinutePeaks: [] };
    summary.days[1]!.parallel = { state: 'available', minutes: [0, 0, 0], peak: 0 };
    expect(analyticsActivityAvailable(summary, 'sessions')).toBe(false);
    summary.days[1]!.parallel.tenMinutePeaks = [];
    expect(analyticsActivityAvailable(summary, 'sessions')).toBe(true);
    expect(analyticsActivityAvailable(summary, 'requests')).toBe(false);
});
