import { useLayoutEffect, useRef, useState } from 'react';
import type { UsageRangeSummary } from '../../shared/usageDashboard.js';
import { analyticsBucketAxis, analyticsBuilds, detailRate } from './usageAnalyticsDetailsState.js';

export const analyticsClamp = (n: number, low: number, high: number) => Math.max(low, Math.min(high, n));
const coord = (n: number) => Number(n.toFixed(3));
export type AnalyticsPoint = { x: number; y: number };

export function useAnalyticsChartWidth(fallback = 600) {
    const ref = useRef<HTMLDivElement>(null);
    const [width, setWidth] = useState(fallback);
    const [, setFontsReady] = useState(false);
    useLayoutEffect(() => {
        const node = ref.current;
        if (!node) return;
        let disposed = false;
        const update = () => {
            const next = node.getBoundingClientRect().width;
            if (next > 0) setWidth(next);
        };
        update();
        void document.fonts?.ready.then(() => { if (!disposed) { update(); setFontsReady(true); } });
        const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(update);
        observer?.observe(node);
        return () => { disposed = true; observer?.disconnect(); };
    }, []);
    return { ref, width };
}

export function analyticsTextWidth(text: string, font = '11px "DM Sans"'): number {
    if (typeof document !== 'undefined' && typeof CanvasRenderingContext2D !== 'undefined') {
        const context = document.createElement('canvas').getContext('2d');
        if (context) {
            context.font = font;
            return context.measureText(text).width;
        }
    }
    return text.length * 6.1;
}

export function analyticsTicks(low: number, high: number, count = 4): number[] {
    const raw = (high - low) / Math.max(1, count);
    if (!(raw > 0)) return [low];
    const power = 10 ** Math.floor(Math.log10(raw));
    const error = raw / power;
    const step = power * (error >= Math.sqrt(50) ? 10 : error >= Math.sqrt(10) ? 5 : error >= Math.sqrt(2) ? 2 : 1);
    const first = Math.ceil(low / step), last = Math.floor(high / step);
    return Array.from({ length: Math.max(0, last - first + 1) }, (_, i) => Number(((first + i) * step).toPrecision(12)));
}

export function analyticsNiceMax(max: number, count = 4): number {
    const ticks = analyticsTicks(0, max || 1, count);
    const step = ticks.length > 1 ? ticks[1]! - ticks[0]! : max || 1;
    return Math.ceil((max || 1) / step) * step;
}

export function analyticsRateDomain(values: readonly (number | null)[], reference?: number | null, dots = false): [number, number] {
    const valid = values.filter((v): v is number => v !== null);
    if (reference != null) valid.push(reference);
    const min = valid.length ? Math.min(...valid) : 80;
    const low = Math.max(0, Math.floor(min / (dots ? 2 : 5)) * (dots ? 2 : 5) - (dots ? 1 : 5));
    const ticks = analyticsTicks(low, 100, 10);
    const step = ticks.length > 1 ? ticks[1]! - ticks[0]! : 1;
    return [dots ? low : Math.floor(low / step) * step, 100];
}

export function analyticsCalendar(summary: UsageRangeSummary, left: number, right: number) {
    const { first } = analyticsBucketAxis(summary);
    const step = (summary.bucketDays ?? 1) * 86400000;
    const end = Date.parse(`${summary.endDateExclusive}T00:00:00Z`);
    const span = Math.max(86400000, end - first), count = span / step;
    const position = (time: number) => left + analyticsClamp((time - first) / span, 0, 1) * (right - left);
    const start = (date: string) => position(Date.parse(`${date}T00:00:00Z`));
    const bandWidth = (date: string) => position(Date.parse(`${date}T00:00:00Z`) + step) - start(date);
    return { count, step, start, bandWidth, center: (date: string) => start(date) + bandWidth(date) / 2 };
}

export function analyticsPointCalendar(summary: UsageRangeSummary, left: number, right: number) {
    const calendar = analyticsCalendar(summary, left, right);
    const { first } = analyticsBucketAxis(summary);
    const span = Math.max(86400000, Date.parse(`${summary.endDateExclusive}T00:00:00Z`) - first);
    const firstCenter = Math.min(span, calendar.step) / 2 / span;
    const lastCenter = (Math.floor((span - 86400000) / calendar.step) * calendar.step + span) / 2 / span;
    const center = (date: string) => {
        const midpoint = (calendar.center(date) - left) / (right - left);
        const padding = .3 / Math.max(1, Math.ceil(calendar.count) - 1 + .6);
        return left + (calendar.count <= 1 ? .5 : padding + (midpoint - firstCenter) / (lastCenter - firstCenter) * (1 - padding * 2)) * (right - left);
    };
    const end = first + span;
    const neighbor = (date: string, offset: number) => new Date(Date.parse(`${date}T00:00:00Z`) + offset * calendar.step).toISOString().slice(0, 10);
    // Include virtual omitted buckets in the Voronoi boundaries so sparse gaps remain unpickable.
    const start = (date: string) => Date.parse(`${date}T00:00:00Z`) <= first ? left : analyticsClamp((center(neighbor(date, -1)) + center(date)) / 2, left, right);
    const finish = (date: string) => Date.parse(`${date}T00:00:00Z`) + calendar.step >= end ? right : analyticsClamp((center(date) + center(neighbor(date, 1))) / 2, left, right);
    const bandWidth = (date: string) => finish(date) - start(date);
    return { ...calendar, center, start, bandWidth };
}

export function analyticsUncachedGroups(summary: UsageRangeSummary, left: number, right: number) {
    const calendar = analyticsCalendar(summary, left, right);
    const days = [...summary.days].sort((a, b) => a.date.localeCompare(b.date));
    const groups: typeof days[] = [];
    for (const day of days) {
        const previous = groups.at(-1)?.at(-1);
        if (!previous || Date.parse(`${day.date}T00:00:00Z`) - Date.parse(`${previous.date}T00:00:00Z`) > calendar.step) groups.push([]);
        if (calendar.bandWidth(day.date) > 0) groups.at(-1)!.push(day);
    }
    return groups.filter(group => group.length).map(group => {
        const values = (day: typeof days[number]) => [day.tokens.fresh, day.tokens.write];
        const first = group[0]!, last = group.at(-1)!;
        return [
            { x: calendar.start(first.date), values: values(first) },
            ...group.map(day => ({ x: calendar.center(day.date), values: values(day) })),
            { x: calendar.start(last.date) + calendar.bandWidth(last.date), values: values(last) },
        ];
    });
}

export function analyticsDateTicks(summary: UsageRangeSummary, width: number): string[] {
    const { first, count } = analyticsBucketAxis(summary);
    const step = (summary.bucketDays ?? 1) * 86400000;
    const dates = [summary.startDate, new Date(first + (count - 1) * step).toISOString().slice(0, 10)];
    const labelWidth = Math.max(...dates.map(date => analyticsTextWidth(analyticsDayLabel(date)))) + 14;
    const stride = Math.max(1, Math.ceil(count / Math.max(1, Math.floor(width / labelWidth))));
    const indices = Array.from({ length: Math.ceil(count / stride) }, (_, i) => count - 1 - i * stride).reverse();
    return indices.map(i => new Date(first + i * step).toISOString().slice(0, 10));
}

export function analyticsDayLabel(date: string, weekday = false): string {
    return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', ...(weekday ? { weekday: 'short' as const } : {}) }).format(new Date(`${date}T00:00:00Z`));
}

export function analyticsLinearPath(points: readonly (AnalyticsPoint | null)[]): string {
    let drawing = false;
    return points.map(p => {
        if (!p) { drawing = false; return ''; }
        const command = drawing ? 'L' : 'M'; drawing = true;
        return `${command}${coord(p.x)},${coord(p.y)}`;
    }).join(' ');
}

export function analyticsAreaPath(points: readonly (AnalyticsPoint | null)[], baseline: number): string {
    const segments: AnalyticsPoint[][] = [];
    for (const point of points) {
        if (!point) { segments.push([]); continue; }
        if (!segments.length) segments.push([]);
        segments.at(-1)!.push(point);
    }
    return segments.filter(s => s.length).map(s => `${analyticsLinearPath(s)} L${coord(s.at(-1)!.x)},${baseline} L${coord(s[0]!.x)},${baseline} Z`).join(' ');
}

// Steffen's monotone tangents, matching the prototype's curveMonotoneX profile.
export function analyticsMonotonePath(points: readonly AnalyticsPoint[]): string {
    if (points.length < 3) return analyticsLinearPath(points);
    const slopes = points.slice(1).map((p, i) => (p.y - points[i]!.y) / (p.x - points[i]!.x));
    const tangents = points.map((p, i) => {
        if (!i || i === points.length - 1) return 0;
        const h0 = p.x - points[i - 1]!.x, h1 = points[i + 1]!.x - p.x;
        const s0 = slopes[i - 1]!, s1 = slopes[i]!;
        const weighted = (s0 * h1 + s1 * h0) / (h0 + h1);
        return (Math.sign(s0) + Math.sign(s1)) * Math.min(Math.abs(s0), Math.abs(s1), Math.abs(weighted) / 2);
    });
    tangents[0] = (3 * slopes[0]! - tangents[1]!) / 2;
    tangents[tangents.length - 1] = (3 * slopes.at(-1)! - tangents.at(-2)!) / 2;
    return points.slice(1).reduce((path, p, i) => {
        const before = points[i]!, dx = (p.x - before.x) / 3;
        return `${path} C${coord(before.x + dx)},${coord(before.y + dx * tangents[i]!)} ${coord(p.x - dx)},${coord(p.y - dx * tangents[i + 1]!)} ${coord(p.x)},${coord(p.y)}`;
    }, `M${coord(points[0]!.x)},${coord(points[0]!.y)}`);
}

export function analyticsSparkGeometry(values: readonly (number | null)[], width: number, height: number) {
    const valid = values.filter((n): n is number => n !== null);
    const low = Math.min(...valid), high = Math.max(...valid);
    const pad = (high - low) * .1 || Math.abs(high) * .1 || 1;
    const points = values.map((n, i) => n === null ? null : ({ x: 2 + i / Math.max(1, values.length - 1) * (width - 7), y: height - 3 - (n - low + pad) / (high - low + pad * 2) * (height - 6) }));
    return { line: valid.length > 1 ? analyticsLinearPath(points) : '', area: valid.length > 1 ? analyticsAreaPath(points, height) : '', last: valid.length > 1 ? points.filter((p): p is AnalyticsPoint => p !== null).at(-1) : undefined };
}

export function analyticsCalendarValues(summary: UsageRangeSummary, value: (day: UsageRangeSummary['days'][number]) => number): (number | null)[] {
    const result: (number | null)[] = [];
    const step = (summary.bucketDays ?? 1) * 86400000;
    let previous = Date.parse(`${summary.startDate}T00:00:00Z`) - step;
    for (const day of summary.days) {
        const time = Date.parse(`${day.date}T00:00:00Z`);
        // Keep the calendar distance without inventing observations in omitted buckets.
        const gap = Math.round((time - previous) / step) - 1;
        for (let i = 0; i < gap; i++) result.push(null);
        result.push(value(day)); previous = time;
    }
    const { count } = analyticsBucketAxis(summary);
    while (result.length < count) result.push(null);
    return result;
}

export const analyticsConcurrencyLevel = (count: number) => Math.min(5, Math.max(0, Math.floor(count)));
export function analyticsRequestFill(count: number, max: number): string {
    const percent = count <= 0 ? 5 : 18 + Math.sqrt(analyticsClamp(count / Math.max(1, max), 0, 1)) * 82;
    return `color-mix(in srgb, var(--uad-accent) ${Number(percent.toFixed(3))}%, var(--uad-card))`;
}

export function analyticsCompositionSegments(values: readonly number[], width = 600, gap = 2) {
    const total = values.reduce((sum, n) => sum + n, 0);
    const available = width - Math.max(0, values.filter(n => n > 0).length - 1) * gap;
    let offset = 0;
    return values.map(value => {
        const segment = { x: offset, width: total ? value / total * available : 0 };
        if (value > 0) offset += segment.width + gap;
        return segment;
    });
}

export function analyticsCacheRows(summary: UsageRangeSummary, width: number) {
    const rows = [...summary.models].filter(m => detailRate(m.tokens) !== null).sort((a, b) => (b.tokens.fresh + b.tokens.read + b.tokens.write) - (a.tokens.fresh + a.tokens.read + a.tokens.write));
    const left = Math.min(width * .6, Math.max(0, ...rows.map(m => analyticsTextWidth(m.label))) + 16);
    const right = width - Math.max(36, ...rows.map(m => analyticsTextWidth(`${detailRate(m.tokens)!.toFixed(1)}%`))) - 18;
    const domain = analyticsRateDomain(rows.map(m => detailRate(m.tokens)), summary.cachedInputShare, true);
    const x = (n: number) => left + (n - domain[0]) / Math.max(1, domain[1] - domain[0]) * Math.max(20, right - left);
    return { rows, left, right: Math.max(left + 20, right), domain, x };
}

export function analyticsBuildGeometry(summary: UsageRangeSummary, width: number) {
    const builds = analyticsBuilds(summary);
    const eligible = builds.items.filter(b => b.results >= 200);
    const rates = eligible.map(b => b.errors / b.results * 100).sort((a, b) => a - b);
    const median = rates.length ? (rates[Math.floor((rates.length - 1) / 2)]! + rates[Math.floor(rates.length / 2)]!) / 2 : null;
    const maxRate = analyticsNiceMax(Math.max(...rates, 0) || 10);
    const left = Math.max(...analyticsTicks(0, maxRate).map(t => analyticsTextWidth(`${t}%`)), 20) + 12;
    const right = width - 16, top = 14, bottom = 254;
    const times = eligible.map(b => Date.parse(b.first));
    const first = times.length ? Math.min(...times) : 0, last = times.length ? Math.max(...times) : 0;
    const pad = Math.max(3600000, (last - first) * .03);
    const x = (time: number) => left + 8 + (time - first + pad) / (last - first + pad * 2) * (right - left - 8);
    const y = (rate: number) => bottom - rate / maxRate * (bottom - top);
    const maxResults = Math.max(1, ...eligible.map(b => b.results));
    const points = [...eligible].sort((a, b) => b.results - a.results).map(b => ({ ...b, key: `${b.sha}:${b.dirty}`, rate: b.errors / b.results * 100, x: x(Date.parse(b.first)), y: y(b.errors / b.results * 100), r: 3 + Math.sqrt(b.results / maxResults) * 12, hot: median !== null && b.errors / b.results * 100 > median * 1.5 }));
    const tickTimes = analyticsTimeTicks(first - pad, last + pad, Math.max(2, Math.floor((width - left) / 90)));
    return { builds, points, median, maxRate, left, right, top, bottom, x, y, tickTimes };
}

export function analyticsTimeTicks(first: number, last: number, count: number): number[] {
    const target = (last - first) / count;
    const intervals = [60000, 300000, 900000, 1800000, 3600000, 10800000, 21600000, 43200000, 86400000, 172800000, 604800000, 2592000000, 7776000000, 31536000000];
    const interval = intervals.reduce((best, n) => Math.abs(Math.log(n / target)) < Math.abs(Math.log(best / target)) ? n : best);
    if (interval >= 2592000000) {
        const months = interval === 2592000000 ? 1 : interval === 7776000000 ? 3 : 12;
        const date = new Date(first);
        let month = Math.floor((date.getUTCFullYear() * 12 + date.getUTCMonth()) / months) * months;
        const result: number[] = [];
        for (;;) {
            const time = Date.UTC(Math.floor(month / 12), month % 12, 1);
            if (time > last) break;
            if (time >= first) result.push(time);
            month += months;
        }
        return result;
    }
    const offset = interval === 604800000 ? 259200000 : 0;
    const start = Math.ceil((first - offset) / interval) * interval + offset;
    return Array.from({ length: Math.max(0, Math.floor((last - start) / interval) + 1) }, (_, i) => start + i * interval);
}

export type AnalyticsAxisLabel = { x: number; label: string; anchor: 'start' | 'middle' | 'end' };
export function analyticsAxisLabels(candidates: readonly AnalyticsAxisLabel[], left: number, right: number, measure = analyticsTextWidth, gap = 12) {
    let previousRight = left - gap;
    const seen = new Set<string>();
    return candidates.filter(candidate => {
        const width = measure(candidate.label);
        const start = candidate.x - (candidate.anchor === 'middle' ? width / 2 : candidate.anchor === 'end' ? width : 0);
        const end = start + width;
        if (seen.has(candidate.label) || start < previousRight + gap || start < left || end > right) return false;
        seen.add(candidate.label); previousRight = end;
        return true;
    });
}

export function analyticsBuildAxisLabels(ticks: readonly number[], x: (time: number) => number, left: number, right: number, measure = analyticsTextWidth) {
    if (!ticks.length) return [];
    const short = ticks.at(-1)! - ticks[0]! < 86400000;
    const formatter = new Intl.DateTimeFormat('en-US', {
        month: 'short', day: 'numeric', timeZone: 'UTC',
        ...(new Date(ticks[0]!).getUTCFullYear() !== new Date(ticks.at(-1)!).getUTCFullYear() ? { year: 'numeric' as const } : {}),
    });
    const clock = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' });
    return analyticsAxisLabels(ticks.map((time, i) => {
        const date = new Date(time);
        return { x: x(time), label: `${formatter.format(date)}${short ? `, ${clock.format(date)}` : ''}`, anchor: i === 0 ? 'start' : i === ticks.length - 1 ? 'end' : 'middle' };
    }), left, right, measure);
}

export function analyticsNearestPoint<T extends AnalyticsPoint>(points: readonly T[], x: number, y: number): T | undefined {
    return points.reduce<T | undefined>((best, point) => !best || (point.x - x) ** 2 + (point.y - y) ** 2 < (best.x - x) ** 2 + (best.y - y) ** 2 ? point : best, undefined);
}
