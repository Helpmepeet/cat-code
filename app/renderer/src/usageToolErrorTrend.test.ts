import { expect, test } from 'bun:test';
import type { UsageRangeSummary } from '../../shared/usageDashboard.js';
import { defaultUsageToolSelection, usageBuildCoverage, usageToolErrorSegments, usageToolErrorSeries } from './usageToolErrorTrendState.js';

const summary = {
    range: 'all', bucketDays: 1, startDate: '2026-09-01', endDateExclusive: '2026-09-05', startInclusive: '2026-09-01T00:00:00.000Z', endExclusive: '2026-09-05T00:00:00.000Z',
    tools: [
        { id: 'a', kind: 'named', label: 'Read', requests: 4, results: 3, errors: 1 },
        { id: 'b', kind: 'named', label: 'Bash', requests: 2, results: 2, errors: 2 },
    ],
    days: [
        { date: '2026-09-01', tools: [{ id: 'a', requests: 2, results: 2, errors: 1, builds: { items: [{ sha: '12345678', dirty: false, requests: 2, results: 2, errors: 1, firstObservedAt: '2026-09-01T08:00:00.000Z' }] } }] },
        { date: '2026-09-02', tools: [{ id: 'a', requests: 2, results: 1, errors: 0 }] },
        { date: '2026-09-04', tools: [{ id: 'b', requests: 2, results: 2, errors: 2 }] },
    ],
} as unknown as UsageRangeSummary;

test('selects error leaders and uses matched results as the rate denominator', () => {
    expect(defaultUsageToolSelection(summary)).toEqual(['b', 'a']);
    const [series] = usageToolErrorSeries(summary, ['a']);
    expect(series!.points.map(item => [item.date, item.rate])).toEqual([
        ['2026-09-01', 50], ['2026-09-02', 0], ['2026-09-03', null], ['2026-09-04', null],
    ]);
    expect(usageToolErrorSegments(series!.points).map(segment => segment.map(item => item.date))).toEqual([['2026-09-01', '2026-09-02']]);
});

test('build coverage is exact and leaves requests without a SHA unattributed', () => {
    const series = usageToolErrorSeries(summary, ['a']);
    expect(usageBuildCoverage(series)).toEqual({ requests: 4, attributed: 2, unattributed: 2, omittedBuilds: 0 });
    expect(series[0]!.points[0]!.builds[0]).toMatchObject({ sha: '12345678', requests: 2, results: 2, errors: 1 });
});

test('missing-result days break lines instead of plotting zero', () => {
    const noResult = structuredClone(summary) as UsageRangeSummary;
    noResult.days[1]!.tools[0]!.results = 0;
    const [series] = usageToolErrorSeries(noResult, ['a']);
    expect(series!.points[1]!.rate).toBeNull();
    expect(usageToolErrorSegments(series!.points)).toHaveLength(1);
    expect(usageToolErrorSegments(series!.points)[0]).toHaveLength(1);
});

test('selects lower-volume edit error leaders and keeps tool implementations distinct', () => {
    const leaders = {
        ...summary,
        tools: [
            { id: 'read', kind: 'named', label: 'Read', requests: 10_000, results: 9_000, errors: 1 },
            { id: 'bash', kind: 'named', label: 'Bash', requests: 5_000, results: 4_000, errors: 2 },
            { id: 'edit', kind: 'named', label: 'Edit', requests: 20, results: 20, errors: 12 },
            { id: 'patch', kind: 'named', label: 'apply_patch', requests: 15, results: 15, errors: 10 },
            { id: 'capital-patch', kind: 'named', label: 'Apply_patch', requests: 10, results: 10, errors: 8 },
        ],
    } as UsageRangeSummary;
    expect(defaultUsageToolSelection(leaders)).toEqual(['edit', 'patch', 'capital-patch']);
});

test('aggregates cannot displace named tools, even when there are fewer than three', () => {
    const grouped = {
        ...summary,
        tools: [
            { id: 'other', kind: 'other', label: 'Other', requests: 1_000, results: 1_000, errors: 900 },
            { id: 'unknown', kind: 'unknown', label: 'Unknown', requests: 500, results: 500, errors: 400 },
            ...summary.tools,
        ],
    } as UsageRangeSummary;
    expect(defaultUsageToolSelection(grouped)).toEqual(['b', 'a']);
    grouped.tools = grouped.tools.filter(tool => tool.kind !== 'named');
    expect(defaultUsageToolSelection(grouped)).toEqual(['other', 'unknown']);
    grouped.tools = [];
    expect(defaultUsageToolSelection(grouped)).toEqual([]);
});

test('equal error counts retain results, requests, and ID tie-breaks', () => {
    const tied = {
        ...summary,
        tools: [
            { id: 'z', kind: 'named', label: 'Z', requests: 8, results: 4, errors: 2 },
            { id: 'b', kind: 'named', label: 'B', requests: 8, results: 4, errors: 2 },
            { id: 'a', kind: 'named', label: 'A', requests: 8, results: 4, errors: 2 },
            { id: 'requests', kind: 'named', label: 'Requests', requests: 9, results: 4, errors: 2 },
            { id: 'results', kind: 'named', label: 'Results', requests: 9, results: 5, errors: 2 },
        ],
    } as UsageRangeSummary;
    expect(defaultUsageToolSelection(tied)).toEqual(['results', 'requests', 'a']);
});

test('omitted build coverage sums exact observation counts only for selected tools', () => {
    const omitted = structuredClone(summary);
    omitted.tools[0]!.requests = 5;
    omitted.days[0]!.tools[0]!.requests = 3;
    omitted.days[0]!.tools[0]!.builds!.omitted = { count: 2, requests: 1, results: 0, errors: 0 };
    omitted.days[1]!.tools[0]!.builds = { items: [], omitted: { count: 3, requests: 2, results: 1, errors: 0 } };
    omitted.days[2]!.tools[0]!.builds = { items: [], omitted: { count: 100, requests: 2, results: 2, errors: 2 } };
    expect(usageBuildCoverage(usageToolErrorSeries(omitted, ['a']))).toEqual({ requests: 5, attributed: 5, unattributed: 0, omittedBuilds: 5 });
    expect(usageBuildCoverage(usageToolErrorSeries(omitted, []))).toEqual({ requests: 0, attributed: 0, unattributed: 0, omittedBuilds: 0 });
});
