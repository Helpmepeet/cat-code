import { expect, test } from 'bun:test';
import { collectRetainedUsage } from '../../../src/utils/statsUsage.js';
import { usageActivityStats, usageBucketLabel, usageDailyActivity, usageDatePosition, usageTrendPoints } from './usageTrendState.js';
const snapshot = await collectRetainedUsage([], '2026-09-13T12:00:00.000Z');

test('sparse dates keep calendar spacing, empty requests are zero, empty cache rates break the line', () => {
    const summary = structuredClone(snapshot.ranges.all);
    summary.startDate = '2026-09-01';
    summary.days = ['2026-09-01', '2026-09-10'].map(date => ({ ...structuredClone(snapshot.ranges['7d'].days[0]!), date, requests: 4, cacheWriteReporting: 'reported' as const, tokens: { fresh: 1, read: 9, write: 0, output: 0 } }));
    expect(usageDatePosition(summary, '2026-09-10')).toBe(0.75);
    expect(usageTrendPoints(summary, 'requests')).toEqual([
        { date: '2026-09-01', value: 4 }, { date: '2026-09-02', value: 0 }, { date: '2026-09-09', value: 0 },
        { date: '2026-09-10', value: 4 }, { date: '2026-09-11', value: 0 }, { date: '2026-09-13', value: 0 },
    ]);
    expect(usageTrendPoints(summary, 'cache').map(point => point.value)).toEqual([90, null, null, 90, null, null]);
    summary.startDate = '0001-01-01';
    summary.days[0]!.date = '0001-01-01';
    expect(usageTrendPoints(summary, 'requests')).toHaveLength(6);
});

test('grouped dates label the actual final interval and fill only aligned empty buckets', () => {
    const summary = structuredClone(snapshot.ranges.all);
    summary.startDate = '2026-09-01';
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

test('daily activity extends the 30-day window with daily All history and drops bucketed All', () => {
    const ranges = structuredClone(snapshot.ranges);
    ranges.all.startDate = '2026-06-01';
    ranges.all.days = [{ ...structuredClone(ranges['7d'].days[0]!), date: '2026-06-03', requests: 2 }];
    const daily = usageDailyActivity(ranges);
    expect([daily.firstDate, daily.lastDate]).toEqual(['2026-06-01', '2026-09-13']);
    expect(daily.days.get('2026-06-03')?.requests).toBe(2);
    expect(daily.days.has(ranges['30d'].startDate)).toBe(true);
    expect(daily.earlierDaysUnavailable).toBe(false);
    ranges.all.bucketDays = 5;
    const bucketed = usageDailyActivity(ranges);
    expect(bucketed.firstDate).toBe(ranges['30d'].startDate);
    expect(bucketed.days.has('2026-06-03')).toBe(false);
    expect(bucketed.earlierDaysUnavailable).toBe(true);
});

test('each recorded activity dimension counts toward days and streaks without changing token intensity', () => {
    const ranges = structuredClone(snapshot.ranges);
    ranges.all.startDate = '2026-09-09';
    ranges.all.days = [];
    for (const [index, dimension] of (['tokens', 'requests', 'records', 'sessions'] as const).entries()) {
        const day = ranges['30d'].days.find(day => day.date === `2026-09-${String(9 + index).padStart(2, '0')}`)!;
        if (dimension === 'tokens') day.tokens.fresh = 1;
        else day[dimension] = 1;
    }
    expect(usageActivityStats(usageDailyActivity(ranges))).toEqual({ active: 4, longest: 4, current: 0, currentAtLeast: false });
    ranges['30d'].days.at(-1)!.records = 1;
    expect(usageActivityStats(usageDailyActivity(ranges))).toEqual({ active: 5, longest: 5, current: 5, currentAtLeast: false });
});

test('only a current streak touching unavailable history is a lower bound', () => {
    const ranges = structuredClone(snapshot.ranges);
    ranges.all.startDate = '2026-06-01';
    ranges.all.bucketDays = 5;
    ranges.all.days = [{ ...structuredClone(ranges['7d'].days[0]!), date: '2026-06-01', records: 90 }];
    for (const day of ranges['30d'].days) day.records = 1;
    expect(usageActivityStats(usageDailyActivity(ranges))).toEqual({ active: 30, longest: 30, current: 30, currentAtLeast: true });
    ranges['30d'].days[0]!.records = 0;
    expect(usageActivityStats(usageDailyActivity(ranges))).toEqual({ active: 29, longest: 29, current: 29, currentAtLeast: false });
    ranges['30d'].days.at(-1)!.records = 0;
    expect(usageActivityStats(usageDailyActivity(ranges))).toEqual({ active: 28, longest: 28, current: 0, currentAtLeast: false });
    for (const day of ranges['30d'].days) day.records = 0;
    expect(usageActivityStats(usageDailyActivity(ranges))).toEqual({ active: 0, longest: 0, current: 0, currentAtLeast: false });
});
