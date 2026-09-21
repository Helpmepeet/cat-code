import type { UsageDay, UsageRangeSummary } from '../../shared/usageDashboard.js';
import { usageBucketDays } from './usageTrendState.js';

const DAY_MS = 86400000;

export type UsageFlowSample = {
    date: string;
    values: number[];
};

export type UsageStackedSample = {
    x: number;
    values: readonly number[];
};

export type UsageStackedPoint = {
    x: number;
    y: number;
};

export type UsageStackedAreaGeometry = {
    boundaries: UsageStackedPoint[][];
    paths: string[];
};

type UsageFlowValue = {
    value: (day: UsageDay) => number;
};

const coordinate = (value: number): string => Number(value.toFixed(3)).toString();
const dateAt = (time: number): string => new Date(time).toISOString().slice(0, 10);

export function usageFlowSamples(summary: UsageRangeSummary, series: readonly UsageFlowValue[]): UsageFlowSample[] {
    const values = new Map(summary.days.map(day => [
        day.date,
        series.map(item => {
            const value = item.value(day);
            return Number.isFinite(value) ? Math.max(0, value) : 0;
        }),
    ]));
    const empty = () => series.map(() => 0);
    const step = usageBucketDays(summary) * DAY_MS;
    const first = Date.parse(summary.startInclusive);
    const last = Date.parse(summary.endExclusive) - DAY_MS;
    let previous = first - step;

    for (const day of [...summary.days].sort((a, b) => a.date.localeCompare(b.date))) {
        const time = Date.parse(`${day.date}T00:00:00.000Z`);
        if (time - previous > step) {
            for (const boundary of [previous + step, time - step]) values.set(dateAt(boundary), empty());
        }
        previous = time;
    }

    const finalBucket = first + Math.floor(Math.max(0, last - first) / step) * step;
    if (previous < finalBucket) {
        for (const boundary of [previous + step, finalBucket]) values.set(dateAt(boundary), empty());
    }
    if (!values.size) {
        values.set(dateAt(first), empty());
        if (finalBucket > first) values.set(dateAt(finalBucket), empty());
    }

    return [...values]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, sampleValues]) => ({ date, values: sampleValues }));
}

export function usageSmoothCurve(points: readonly UsageStackedPoint[]): string {
    const first = points[0];
    if (!first) return '';
    let path = `M${coordinate(first.x)},${coordinate(first.y)}`;
    for (let index = 1; index < points.length; index++) {
        const from = points[index - 1]!;
        const to = points[index]!;
        const distance = to.x - from.x;
        if (distance <= 0) {
            path += ` L${coordinate(to.x)},${coordinate(to.y)}`;
            continue;
        }
        const handle = distance * 0.36;
        path += ` C${coordinate(from.x + handle)},${coordinate(from.y)} ${coordinate(to.x - handle)},${coordinate(to.y)} ${coordinate(to.x)},${coordinate(to.y)}`;
    }
    return path;
}

export function usageStackedAreaGeometry(
    samples: readonly UsageStackedSample[],
    ceiling: number,
    top: number,
    bottom: number,
): UsageStackedAreaGeometry {
    const layerCount = samples.reduce((count, sample) => Math.max(count, sample.values.length), 0);
    const safeCeiling = Number.isFinite(ceiling) && ceiling > 0 ? ceiling : 1;
    const boundaries = Array.from({ length: layerCount + 1 }, () => [] as UsageStackedPoint[]);

    for (const sample of samples) {
        let total = 0;
        boundaries[0]!.push({ x: sample.x, y: bottom });
        for (let layer = 0; layer < layerCount; layer++) {
            const value = sample.values[layer] ?? 0;
            total += Number.isFinite(value) ? Math.max(0, value) : 0;
            boundaries[layer + 1]!.push({
                x: sample.x,
                y: bottom - total / safeCeiling * (bottom - top),
            });
        }
    }

    const paths = Array.from({ length: layerCount }, (_, layer) => {
        const upper = boundaries[layer + 1]!;
        const lower = [...boundaries[layer]!].reverse();
        if (!upper.length) return '';
        return `${usageSmoothCurve(upper)} ${usageSmoothCurve(lower).replace(/^M/, 'L')} Z`;
    });
    return { boundaries, paths };
}
