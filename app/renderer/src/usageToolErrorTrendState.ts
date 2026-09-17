import type { UsageDayTool, UsageRangeSummary, UsageToolBuildObservation } from '../../shared/usageDashboard.js';
import { usageBucketDays } from './usageTrendState.js';

const DAY_MS = 86_400_000;

export type UsageToolErrorPoint = {
    date: string;
    requests: number;
    results: number;
    errors: number;
    rate: number | null;
    builds: UsageToolBuildObservation[];
    omittedBuilds: number;
    attributedRequests: number;
};

export type UsageToolErrorSeries = {
    id: string;
    label: string;
    points: UsageToolErrorPoint[];
};

export function defaultUsageToolSelection(summary: UsageRangeSummary, limit = 3): string[] {
    return [...summary.tools]
        .sort((a, b) => b.errors - a.errors || b.results - a.results || b.requests - a.requests || a.id.localeCompare(b.id))
        .slice(0, limit)
        .map(tool => tool.id);
}

function point(date: string, tool: UsageDayTool | undefined): UsageToolErrorPoint {
    const builds = tool?.builds?.items ?? [];
    const omitted = tool?.builds?.omitted;
    return {
        date,
        requests: tool?.requests ?? 0,
        results: tool?.results ?? 0,
        errors: tool?.errors ?? 0,
        rate: tool?.results ? tool.errors / tool.results * 100 : null,
        builds,
        omittedBuilds: omitted?.count ?? 0,
        attributedRequests: builds.reduce((sum, build) => sum + build.requests, 0) + (omitted?.requests ?? 0),
    };
}

/** Sparse histories gain null boundary points so lines never bridge unknown spans. */
export function usageToolErrorSeries(summary: UsageRangeSummary, selected: readonly string[]): UsageToolErrorSeries[] {
    const step = usageBucketDays(summary) * DAY_MS;
    const first = Date.parse(summary.startInclusive);
    const last = Date.parse(summary.endExclusive) - DAY_MS;
    return selected.flatMap(id => {
        const tool = summary.tools.find(item => item.id === id);
        if (!tool) return [];
        const points = new Map(summary.days.map(day => [day.date, point(day.date, day.tools.find(item => item.id === id))]));
        let previous = first - step;
        for (const day of summary.days) {
            const time = Date.parse(`${day.date}T00:00:00.000Z`);
            if (time - previous > step) {
                for (const boundary of [previous + step, time - step]) {
                    const date = new Date(boundary).toISOString().slice(0, 10);
                    points.set(date, point(date, undefined));
                }
            }
            previous = time;
        }
        const finalBucket = first + Math.floor((last - first) / step) * step;
        if (previous < finalBucket) for (const boundary of [previous + step, finalBucket]) {
            const date = new Date(boundary).toISOString().slice(0, 10);
            points.set(date, point(date, undefined));
        }
        return [{ id, label: tool.label, points: [...points.values()].sort((a, b) => a.date.localeCompare(b.date)) }];
    });
}

export function usageToolErrorSegments(points: readonly UsageToolErrorPoint[]): UsageToolErrorPoint[][] {
    const segments: UsageToolErrorPoint[][] = [];
    let segment: UsageToolErrorPoint[] = [];
    for (const item of points) {
        if (item.rate === null) {
            if (segment.length) segments.push(segment);
            segment = [];
        } else segment.push(item);
    }
    if (segment.length) segments.push(segment);
    return segments;
}

export function usageBuildCoverage(series: readonly UsageToolErrorSeries[]) {
    let requests = 0, attributed = 0, omittedBuilds = 0;
    for (const item of series) for (const value of item.points) {
        requests += value.requests;
        attributed += value.attributedRequests;
        omittedBuilds += value.omittedBuilds;
    }
    return { requests, attributed, unattributed: requests - attributed, omittedBuilds };
}
