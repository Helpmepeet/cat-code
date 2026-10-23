import type { UsageDayTool, UsageRangeSummary, UsageToolBuildObservation } from './usageDashboard.js';

export const MAX_USAGE_RANGE_BUILDS = 30;
export const MIN_USAGE_BUILD_RESULTS = 200;

/** Period totals must be captured before daily tool/build detail is fitted away. */
export function usageRangeBuilds(summary: UsageRangeSummary): NonNullable<UsageDayTool['builds']> {
    if (summary.builds) return summary.builds;
    const rows = new Map<string, UsageToolBuildObservation>();
    const omitted = { count: 0, requests: 0, results: 0, errors: 0 };
    for (const day of summary.days) for (const tool of day.tools) {
        if (tool.builds?.omitted) for (const key of ['count', 'requests', 'results', 'errors'] as const) omitted[key] += tool.builds.omitted[key];
        for (const build of tool.builds?.items ?? []) {
            const key = `${build.sha}:${build.dirty}`;
            const old = rows.get(key);
            if (!old) rows.set(key, { ...build });
            else {
                old.requests += build.requests;
                old.results += build.results;
                old.errors += build.errors;
                if (build.firstObservedAt < old.firstObservedAt) old.firstObservedAt = build.firstObservedAt;
            }
        }
    }
    const ranked = [...rows.values()].sort((a, b) => Number(b.results >= MIN_USAGE_BUILD_RESULTS) - Number(a.results >= MIN_USAGE_BUILD_RESULTS)
        || b.firstObservedAt.localeCompare(a.firstObservedAt) || a.sha.localeCompare(b.sha) || Number(a.dirty) - Number(b.dirty));
    for (const build of ranked.slice(MAX_USAGE_RANGE_BUILDS)) {
        omitted.count++;
        omitted.requests += build.requests;
        omitted.results += build.results;
        omitted.errors += build.errors;
    }
    return {
        items: ranked.slice(0, MAX_USAGE_RANGE_BUILDS).sort((a, b) => a.firstObservedAt.localeCompare(b.firstObservedAt) || a.sha.localeCompare(b.sha) || Number(a.dirty) - Number(b.dirty)),
        ...(omitted.count ? { omitted } : {}),
    };
}
