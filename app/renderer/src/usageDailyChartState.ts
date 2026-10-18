import type { UsageDay, UsageRangeSummary } from '../../shared/usageDashboard.js';
import { usageTotal } from './usageDashboardState.js';
import { usageMetricDelta } from './usageMetricDelta.js';
import { usageAnalyticsToolColor } from './usageAnalyticsDetailsState.js';

export type UsageDailyMetric = 'tokens' | 'requests' | 'sessions' | 'toolErrors' | 'errorRate' | 'auto';
export type UsageTokenGrouping = 'family' | 'source' | 'type';
export function usageCacheCoverageLabel(reporting: UsageRangeSummary['cacheWriteReporting']): string {
    switch (reporting) {
        case 'reported': return '';
        case 'partial': return 'Writes partly reported';
        case 'unreported': return 'Writes not reported';
        case 'unavailable': return 'Write coverage unavailable';
    }
}
export function usagePinnedBucket(summary: UsageRangeSummary, date: string): string {
    if (!date) return '';
    const timestamp = Date.parse(`${date}T00:00:00Z`);
    if (date < summary.startDate || date >= summary.endDateExclusive) return '';
    return summary.days.find(day => {
        const offset = (timestamp - Date.parse(`${day.date}T00:00:00Z`)) / 86400000;
        return offset >= 0 && offset < (summary.bucketDays ?? 1);
    })?.date ?? '';
}
export const usageDailyMetrics: { id: UsageDailyMetric; label: string; title: string }[] = [
    { id: 'tokens', label: 'Tokens', title: 'Tokens processed' },
    { id: 'requests', label: 'Requests', title: 'Model requests by effort' },
    { id: 'sessions', label: 'Sessions', title: 'Sessions' },
    { id: 'toolErrors', label: 'Tool errors', title: 'Tool errors by tool' },
    { id: 'errorRate', label: 'Error rate', title: 'Tool error rate' },
    { id: 'auto', label: 'Auto mode', title: 'Auto-mode decisions' },
];
export const usageAnalyticsFamilies = ['Sol', 'Claude Opus', 'Luna', 'Terra', 'Astra', 'GPT 5.5', 'Claude Sonnet', 'Other'] as const;
export function usageAnalyticsFamily(label: string): string {
    const lower = label.toLowerCase();
    if (lower.includes('opus')) return 'Claude Opus';
    if (lower.includes('sonnet')) return 'Claude Sonnet';
    for (const family of ['Sol', 'Luna', 'Terra', 'Astra']) if (lower.split(/[^a-z0-9]+/).includes(family.toLowerCase())) return family;
    if (/gpt[- ]?5[.-]5/.test(lower)) return 'GPT 5.5';
    return 'Other';
}
export function usageAnalyticsFamilyColor(family: string): string {
    const index = usageAnalyticsFamilies.indexOf(family as typeof usageAnalyticsFamilies[number]);
    return family === 'Claude Opus' ? 'var(--provider-claude)' : index < 0 || family === 'Other' ? 'var(--usage-other)' : `var(--usage-category-${index})`;
}
export function usageDailyCalendar(summary: UsageRangeSummary) {
    const start = Date.parse(`${summary.startDate}T00:00:00Z`);
    const span = Math.max(1, (Date.parse(`${summary.endDateExclusive}T00:00:00Z`) - start) / 86400000);
    const bucketDays = summary.bucketDays ?? 1;
    const slots = summary.days.map(day => {
        const offset = (Date.parse(`${day.date}T00:00:00Z`) - start) / 86400000;
        const end = Math.min(span, offset + bucketDays);
        return { start: offset / span, end: end / span, center: (offset + end) / 2 / span };
    });
    const groups: number[][] = [];
    slots.forEach((slot, index) => {
        if (index === 0 || slot.start > slots[index - 1]!.end + 1e-9) groups.push([]);
        groups.at(-1)!.push(index);
    });
    return { slots, groups, bucketCount: span / bucketDays };
}
export function usageCalendarAverage(summary: UsageRangeSummary, totals: readonly number[]): number {
    return totals.reduce((sum, value) => sum + value, 0) / usageDailyCalendar(summary).bucketCount;
}
export function usageToolRate(value: { results: number; errors: number }): number | null { return value.results ? value.errors / value.results * 100 : null; }
export function usageModelRequestCount(value: Pick<UsageRangeSummary, 'effort'>): number {
    return Object.values(value.effort.requests).reduce((sum, count) => sum + count, 0) + value.effort.unattributedRequests;
}
export function usageRangeOutcomes(summary: UsageRangeSummary) { return summary.days.reduce((sum, day) => ({ results: sum.results + day.results, errors: sum.errors + day.errors }), { results: 0, errors: 0 }); }
export type UsageDailySeries = { id: string; label: string; color: string; value: (day: UsageDay) => number | null };
export function usageDailySeries(summary: UsageRangeSummary, metric: UsageDailyMetric, grouping: UsageTokenGrouping): UsageDailySeries[] {
    if (metric === 'tokens') {
        if (grouping === 'type') return [
            { id: 'read', label: 'Cache reads', color: 'var(--usage-category-0)', value: (day: UsageDay) => day.tokens.read },
            { id: 'fresh', label: 'Fresh input', color: 'var(--usage-category-1)', value: (day: UsageDay) => day.tokens.fresh },
            { id: 'output', label: 'Output', color: 'var(--usage-category-2)', value: (day: UsageDay) => day.tokens.output },
            { id: 'write', label: 'Cache writes', color: 'var(--usage-category-3)', value: (day: UsageDay) => day.tokens.write },
        ];
        if (grouping === 'source') return (['chat', 'subagents', 'compaction'] as const).map((source, index) => ({ id: source, label: source === 'chat' ? 'Chat' : source === 'subagents' ? 'Subagents' : 'Compaction', color: `var(--usage-category-${index * 2})`, value: (day: UsageDay) => day.tokenSources ? usageTotal(day.tokenSources[source]) : 0 }));
        const families = new Map(summary.models.map(model => [model.id, usageAnalyticsFamily(model.label)]));
        return usageAnalyticsFamilies.filter(family => [...families.values()].includes(family)).map(family => ({ id: family, label: family, color: usageAnalyticsFamilyColor(family), value: (day: UsageDay) => day.models.reduce((sum, model) => sum + (families.get(model.id) === family ? model.total : 0), 0) }));
    }
    if (metric === 'requests') return [...(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const).filter(level => summary.effort.requests[level] > 0).map((level, index) => ({ id: level, label: ({ low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max', ultra: 'Ultra' })[level], color: `var(--usage-sequential-${Math.min(5, index + 1)})`, value: (day: UsageDay) => day.effort.requests[level] })), { id: 'unrecorded', label: 'Not recorded', color: 'var(--usage-other)', value: (day: UsageDay) => day.effort.unattributedRequests }];
    if (metric === 'toolErrors') return summary.tools.map(tool => ({ id: tool.id, label: tool.label, color: usageAnalyticsToolColor(tool.label), value: (day: UsageDay) => day.tools.find(item => item.id === tool.id)?.errors ?? 0 }));
    if (metric === 'auto') return [
        { id: 'allowed', label: 'Allowed', color: 'var(--usage-category-3)', outcomes: ['allowed'] },
        { id: 'review', label: 'Held for review', color: 'var(--usage-amber)', outcomes: ['review_required'] },
        { id: 'blocked', label: 'Blocked', color: 'var(--usage-errors)', outcomes: ['policy_blocked'] },
        { id: 'other', label: 'Failed or cancelled', color: 'var(--usage-other)', outcomes: ['operational_error', 'cancelled', 'unknown_outcome', 'incomplete'] },
    ].map(item => ({ ...item, value: (day: UsageDay) => { const bucket = summary.autoMode.buckets.find(bucket => bucket.date === day.date); return bucket ? item.outcomes.reduce((sum, outcome) => sum + (bucket.allTools.outcomes[outcome as keyof typeof bucket.allTools.outcomes] ?? 0), 0) : 0; } }));
    return [{ id: metric, label: metric === 'sessions' ? 'Sessions' : 'Tool error rate', color: metric === 'sessions' ? 'var(--usage-category-2)' : 'var(--usage-errors)', value: (day: UsageDay) => metric === 'sessions' ? day.sessions : usageToolRate(day) }];
}
export function usageDailyTotal(summary: UsageRangeSummary, metric: UsageDailyMetric): number | null {
    if (metric === 'tokens') return usageTotal(summary.tokens);
    if (metric === 'requests') return usageModelRequestCount(summary);
    if (metric === 'sessions') return summary.sessions;
    if (metric === 'toolErrors') return usageRangeOutcomes(summary).errors;
    if (metric === 'errorRate') return usageToolRate(usageRangeOutcomes(summary));
    return summary.autoMode.allTools.coverage.state === 'unavailable' ? null : Object.values(summary.autoMode.allTools.outcomes).reduce((a, b) => a + b, 0);
}
export function usageDailyDelta(summary: UsageRangeSummary, metric: UsageDailyMetric, partial: boolean) {
    const previous = !partial && summary.range !== 'all' ? summary.previousPeriod : undefined;
    if (!previous || metric === 'auto') return null;
    const baseline = metric === 'tokens' ? usageTotal(previous.tokens) : metric === 'requests' ? previous.modelRequests : metric === 'toolErrors' ? previous.errors : metric === 'errorRate' ? usageToolRate(previous) : previous.sessions;
    return usageMetricDelta(usageDailyTotal(summary, metric), baseline, metric === 'errorRate' ? 'points' : 'percent');
}
export function usageLatestBuild(summary: UsageRangeSummary) {
    const builds = new Map<string, { sha: string; dirty: boolean; results: number; errors: number; firstObservedAt: string }>();
    for (const day of summary.days) for (const tool of day.tools) for (const build of tool.builds?.items ?? []) {
        const key = `${build.sha}:${build.dirty}`, previous = builds.get(key);
        builds.set(key, { ...build, results: (previous?.results ?? 0) + build.results, errors: (previous?.errors ?? 0) + build.errors, firstObservedAt: previous && previous.firstObservedAt < build.firstObservedAt ? previous.firstObservedAt : build.firstObservedAt });
    }
    const items = [...builds.values()].filter(build => build.results >= 200).sort((a, b) => a.firstObservedAt.localeCompare(b.firstObservedAt));
    const rates = items.filter(item => item.results >= 200).map(item => usageToolRate(item)!).sort((a, b) => a - b);
    const middle = Math.floor(rates.length / 2);
    const median = rates.length ? rates.length % 2 ? rates[middle]! : (rates[middle - 1]! + rates[middle]!) / 2 : null;
    return { latest: items.at(-1), items, median };
}
