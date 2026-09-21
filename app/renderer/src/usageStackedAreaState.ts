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
    curves: UsageStackedCurve[][];
    paths: string[];
};

export type UsageStackedCurve = {
    from: UsageStackedPoint;
    control1: UsageStackedPoint;
    control2: UsageStackedPoint;
    to: UsageStackedPoint;
};

type UsageFlowValue = {
    value: (day: UsageDay) => number;
};

const coordinate = (value: number): string => Number(value.toFixed(3)).toString();
const dateAt = (time: number): string => new Date(time).toISOString().slice(0, 10);
const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

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

function usageCurveSegments(points: readonly UsageStackedPoint[], tension = 1.2): UsageStackedCurve[] {
    return points.slice(0, -1).map((from, index) => {
        const before = points[index - 1] ?? from;
        const to = points[index + 1]!;
        const after = points[index + 2] ?? to;
        return {
            from,
            control1: {
                x: clamp(from.x + (to.x - before.x) * tension / 6, from.x, to.x),
                y: from.y + (to.y - before.y) * tension / 6,
            },
            control2: {
                x: clamp(to.x - (after.x - from.x) * tension / 6, from.x, to.x),
                y: to.y - (after.y - from.y) * tension / 6,
            },
            to,
        };
    });
}

function usageCurvePath(points: readonly UsageStackedPoint[], curves: readonly UsageStackedCurve[], reverse = false): string {
    const first = reverse ? points.at(-1) : points[0];
    if (!first) return '';
    let path = `M${coordinate(first.x)},${coordinate(first.y)}`;
    const ordered = reverse ? [...curves].reverse() : curves;
    for (const curve of ordered) {
        const control1 = reverse ? curve.control2 : curve.control1;
        const control2 = reverse ? curve.control1 : curve.control2;
        const to = reverse ? curve.from : curve.to;
        path += ` C${coordinate(control1.x)},${coordinate(control1.y)} ${coordinate(control2.x)},${coordinate(control2.y)} ${coordinate(to.x)},${coordinate(to.y)}`;
    }
    return path;
}

export function usageSmoothCurve(points: readonly UsageStackedPoint[], tension = 1.2): string {
    return usageCurvePath(points, usageCurveSegments(points, tension));
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

    const curves = boundaries.map(boundary => usageCurveSegments(boundary));
    for (let layer = 0; layer < curves.length; layer++) {
        for (let index = 0; index < curves[layer]!.length; index++) {
            const curve = curves[layer]![index]!;
            const lower = curves[layer - 1]?.[index];
            curve.control1.y = clamp(curve.control1.y, top, lower?.control1.y ?? bottom);
            curve.control2.y = clamp(curve.control2.y, top, lower?.control2.y ?? bottom);
        }
    }

    const paths = Array.from({ length: layerCount }, (_, layer) => {
        const upper = boundaries[layer + 1]!;
        const lower = boundaries[layer]!;
        if (!upper.length) return '';
        return `${usageCurvePath(upper, curves[layer + 1]!)} ${usageCurvePath(lower, curves[layer]!, true).replace(/^M/, 'L')} Z`;
    });
    return { boundaries, curves, paths };
}
