import { expect, test } from 'bun:test';
import { collectRetainedUsage } from '../../../src/utils/statsUsage.js';
import { usageBucketLabel, usageDatePosition, usageTrendPoints } from './usageTrendState.js';
const snapshot = await collectRetainedUsage([], '2026-09-13T12:00:00.000Z');

test('sparse dates keep calendar spacing, empty requests are zero, empty cache share breaks the line', () => {
    const summary = structuredClone(snapshot.ranges.all);
    summary.startInclusive = '2026-09-01T00:00:00.000Z';
    summary.days = ['2026-09-01', '2026-09-10'].map(date => ({ ...structuredClone(snapshot.ranges['7d'].days[0]!), date, requests: 4, tokens: { fresh: 1, read: 9, write: 0, output: 0 } }));
    expect(usageDatePosition(summary, '2026-09-10')).toBe(0.75);
    expect(usageTrendPoints(summary, 'requests')).toEqual([
        { date: '2026-09-01', value: 4 }, { date: '2026-09-02', value: 0 }, { date: '2026-09-09', value: 0 },
        { date: '2026-09-10', value: 4 }, { date: '2026-09-11', value: 0 }, { date: '2026-09-13', value: 0 },
    ]);
    expect(usageTrendPoints(summary, 'cache').map(point => point.value)).toEqual([90, null, null, 90, null, null]);
    summary.startInclusive = '0001-01-01T00:00:00.000Z';
    summary.days[0]!.date = '0001-01-01';
    expect(usageTrendPoints(summary, 'requests')).toHaveLength(6);
});

test('grouped dates label the actual final interval and fill only aligned empty buckets', () => {
    const summary = structuredClone(snapshot.ranges.all);
    summary.startInclusive = '2026-09-01T00:00:00.000Z';
    summary.bucketDays = 5;
    summary.days = [{ ...structuredClone(snapshot.ranges['7d'].days[0]!), date: '2026-09-01', requests: 7 }];
    expect(usageBucketLabel(summary, '2026-09-01')).toBe('2026-09-01 to 2026-09-05');
    expect(usageBucketLabel(summary, '2026-09-11')).toBe('2026-09-11 to 2026-09-13');
    expect(usageTrendPoints(summary, 'requests')).toEqual([{ date: '2026-09-01', value: 7 }, { date: '2026-09-06', value: 0 }, { date: '2026-09-11', value: 0 }]);
});

test('error trend uses matched results, preserves measured zero, and gaps missing matches', () => {
    const summary = structuredClone(snapshot.ranges['7d']);
    summary.days[0]!.requests = 20;
    summary.days[0]!.results = 10;
    summary.days[0]!.errors = 2;
    summary.days[1]!.results = 5;
    expect(usageTrendPoints(summary, 'errors').map(point => point.value)).toEqual([20, 0, null, null, null, null, null]);
});
