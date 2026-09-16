import type { UsageRangeSummary } from '../../shared/usageDashboard.js';
import { usageShare } from './usageDashboardState.js';

const DAY_MS = 86400000;
export type UsageTrendPoint = { date: string; value: number | null };
export function usageBucketDays(summary: UsageRangeSummary): number {
    return 'bucketDays' in summary && typeof summary.bucketDays === 'number' ? summary.bucketDays : 1;
}
export function usageBucketLabel(summary: UsageRangeSummary, date: string): string {
    const end = Math.min(Date.parse(`${date}T00:00:00.000Z`) + usageBucketDays(summary) * DAY_MS, Date.parse(summary.endExclusive)) - DAY_MS;
    return usageBucketDays(summary) === 1 ? date : `${date} to ${new Date(end).toISOString().slice(0, 10)}`;
}
export function usageDatePosition(summary: UsageRangeSummary, date: string): number {
    const first = Date.parse(summary.startInclusive), last = Date.parse(summary.endExclusive) - DAY_MS;
    return last === first ? 0.5 : (Date.parse(`${date}T00:00:00.000Z`) - first) / (last - first);
}
export function usageTrendPoints(summary: UsageRangeSummary, metric: 'cache' | 'requests' | 'errors'): UsageTrendPoint[] {
    const values = new Map(summary.days.map(day => [day.date, metric === 'cache' ? usageShare(day.tokens) : metric === 'errors' ? day.results ? day.errors / day.results * 100 : null : day.requests]));
    const step = usageBucketDays(summary) * DAY_MS;
    const first = Date.parse(summary.startInclusive), last = Date.parse(summary.endExclusive) - DAY_MS;
    // Two boundary points describe even very long empty spans without allocating every day.
    let previous = first - step;
    for (const day of summary.days) {
        const time = Date.parse(`${day.date}T00:00:00.000Z`);
        if (time - previous > step) {
            for (const boundary of [previous + step, time - step]) values.set(new Date(boundary).toISOString().slice(0, 10), metric === 'requests' ? 0 : null);
        }
        previous = time;
    }
    const finalBucket = first + Math.floor((last - first) / step) * step;
    if (previous < finalBucket) {
        for (const boundary of [previous + step, finalBucket]) values.set(new Date(boundary).toISOString().slice(0, 10), metric === 'requests' ? 0 : null);
    }
    return [...values].sort(([a], [b]) => a.localeCompare(b)).map(([date, value]) => ({ date, value }));
}

export function usageHasCacheWrites(summary: UsageRangeSummary): boolean {
    return summary.tokens.write > 0 || summary.cacheWriteReporting === 'reported' || summary.cacheWriteReporting === 'partial';
}
