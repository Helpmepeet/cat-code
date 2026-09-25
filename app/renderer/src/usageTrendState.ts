import type { UsageRangeSummary } from '../../shared/usageDashboard.js';
import { usageShare } from './usageDashboardState.js';

const DAY_MS = 86400000;
const civilDay = (date: string): number => Date.parse(`${date}T00:00:00.000Z`);
const dayKey = (time: number): string => new Date(time).toISOString().slice(0, 10);
export type UsageTrendPoint = { date: string; value: number | null };
export function usageBucketDays(summary: UsageRangeSummary): number {
    return 'bucketDays' in summary && typeof summary.bucketDays === 'number' ? summary.bucketDays : 1;
}
export function usageBucketLabel(summary: UsageRangeSummary, date: string): string {
    const end = Math.min(civilDay(date) + usageBucketDays(summary) * DAY_MS, civilDay(summary.endDateExclusive)) - DAY_MS;
    return usageBucketDays(summary) === 1 ? date : `${date} to ${dayKey(end)}`;
}
export function usageDatePosition(summary: UsageRangeSummary, date: string): number {
    const first = civilDay(summary.startDate), last = civilDay(summary.endDateExclusive) - DAY_MS;
    return last === first ? 0.5 : (civilDay(date) - first) / (last - first);
}
export function usageTrendPoints(summary: UsageRangeSummary, metric: 'cache' | 'cacheReads' | 'requests' | 'errors'): UsageTrendPoint[] {
    const values = new Map(summary.days.map(day => [day.date, metric === 'cache' ? day.cacheWriteReporting === 'reported' ? usageShare(day.tokens) : null : metric === 'cacheReads' ? day.tokens.read : metric === 'errors' ? day.results ? day.errors / day.results * 100 : null : day.requests]));
    const step = usageBucketDays(summary) * DAY_MS;
    const first = civilDay(summary.startDate), last = civilDay(summary.endDateExclusive) - DAY_MS;
    // Two boundary points describe even very long empty spans without allocating every day.
    let previous = first - step;
    for (const day of summary.days) {
        const time = civilDay(day.date);
        if (time - previous > step) {
            for (const boundary of [previous + step, time - step]) values.set(dayKey(boundary), metric === 'requests' || metric === 'cacheReads' ? 0 : null);
        }
        previous = time;
    }
    const finalBucket = first + Math.floor((last - first) / step) * step;
    if (previous < finalBucket) {
        for (const boundary of [previous + step, finalBucket]) values.set(dayKey(boundary), metric === 'requests' || metric === 'cacheReads' ? 0 : null);
    }
    return [...values].sort(([a], [b]) => a.localeCompare(b)).map(([date, value]) => ({ date, value }));
}

export function usageHasCacheWrites(summary: UsageRangeSummary): boolean {
    return summary.tokens.write > 0 || summary.cacheWriteReporting === 'reported' || summary.cacheWriteReporting === 'partial';
}
