import { expect, test } from 'bun:test';
import type { UsageRangeSummary } from '../../shared/usageDashboard.js';
import { defaultUsageToolSelection, usageBuildCoverage, usageToolErrorSegments, usageToolErrorSeries } from './usageToolErrorTrendState.js';

const summary = {
    range: 'all', bucketDays: 1, startInclusive: '2026-09-01T00:00:00.000Z', endExclusive: '2026-09-05T00:00:00.000Z',
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
