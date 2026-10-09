import type { UsageDay, UsageRangeSummary, UsageWindow } from '../../shared/usageDashboard.js';
import { usageCacheReadRate, usageTotal } from './usageDashboardState.js';

const DAY_MS = 86400000;
const civilDay = (date: string): number => Date.parse(`${date}T00:00:00.000Z`);
const dayKey = (time: number): string => new Date(time).toISOString().slice(0, 10);
export type UsageTrendPoint = { date: string; value: number | null };
/** Per-day history from firstDate through lastDate; a date inside that span with no entry recorded nothing. */
export type UsageDailyActivity = { firstDate: string; lastDate: string; days: ReadonlyMap<string, UsageDay>; earlierDaysUnavailable: boolean };
export function usageDailyActivity(ranges: Record<UsageWindow, UsageRangeSummary>): UsageDailyActivity {
    const recent = ranges['30d'], all = ranges.all;
    // All is sparse daily until it outgrows its bucket budget; after that only the
    // dense 30-day range still resolves individual days.
    const allDaily = usageBucketDays(all) === 1;
    const days = new Map<string, UsageDay>();
    for (const day of [...(allDaily ? all.days : []), ...recent.days]) days.set(day.date, day);
    return { firstDate: allDaily && all.startDate < recent.startDate ? all.startDate : recent.startDate, lastDate: dayKey(civilDay(recent.endDateExclusive) - DAY_MS), days, earlierDaysUnavailable: !allDaily && all.startDate < recent.startDate };
}
export function usageActivityStats(activity: UsageDailyActivity) {
    const isActive = (day: UsageDay | undefined): boolean => !!day && (usageTotal(day.tokens) > 0 || day.requests > 0 || day.records > 0 || day.sessions > 0);
    const active = [...activity.days.entries()].filter(([, day]) => isActive(day)).map(([date]) => date).sort();
    let longest = 0, streak = 0, previous = '';
    for (const date of active) {
        streak = previous && civilDay(date) - civilDay(previous) === DAY_MS ? streak + 1 : 1;
        longest = Math.max(longest, streak);
        previous = date;
    }
    let current = 0;
    const first = civilDay(activity.firstDate), last = civilDay(activity.lastDate);
    for (let at = last; at >= first && isActive(activity.days.get(dayKey(at))); at -= DAY_MS) current++;
    // A streak reaching the daily-detail boundary may continue into unavailable history.
    const currentAtLeast = activity.earlierDaysUnavailable && current > 0 && last - current * DAY_MS < first;
    return { active: active.length, longest, current, currentAtLeast };
}
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
export function usageTrendPoints(summary: UsageRangeSummary, metric: 'cache' | 'requests' | 'errors'): UsageTrendPoint[] {
    const values = new Map(summary.days.map(day => [day.date, metric === 'cache' ? usageCacheReadRate(day.tokens) : metric === 'errors' ? day.results ? day.errors / day.results * 100 : null : day.requests]));
    const step = usageBucketDays(summary) * DAY_MS;
    const first = civilDay(summary.startDate), last = civilDay(summary.endDateExclusive) - DAY_MS;
    // Two boundary points describe even very long empty spans without allocating every day.
    let previous = first - step;
    for (const day of summary.days) {
        const time = civilDay(day.date);
        if (time - previous > step) {
            for (const boundary of [previous + step, time - step]) values.set(dayKey(boundary), metric === 'requests' ? 0 : null);
        }
        previous = time;
    }
    const finalBucket = first + Math.floor((last - first) / step) * step;
    if (previous < finalBucket) {
        for (const boundary of [previous + step, finalBucket]) values.set(dayKey(boundary), metric === 'requests' ? 0 : null);
    }
    return [...values].sort(([a], [b]) => a.localeCompare(b)).map(([date, value]) => ({ date, value }));
}

export function usageHasCacheWrites(summary: UsageRangeSummary): boolean {
    return summary.tokens.write > 0 || summary.cacheWriteReporting === 'reported' || summary.cacheWriteReporting === 'partial';
}
