import type { UsageRangeSummary, UsageRankedSession } from '../../shared/usageDashboard.js';
import type { MergedSessionRow } from './sessionsCatalogState.js';
import { usageTotal } from './usageDashboardState.js';
import { findUsageSessionRow } from './usageSessionNavigation.js';

const DAY = 86400000;
const epoch = (date: string) => Date.parse(`${date}T00:00:00Z`);
const dateKey = (time: number) => new Date(time).toISOString().slice(0, 10);
export type AnalyticsPoint = { date: string; endDate: string; values: number[] };
export function sessionLabel(item: UsageRankedSession, rows: readonly MergedSessionRow[]) {
    const row = findUsageSessionRow(item, rows);
    return { row, label: row?.displayLabel ?? (item.engineSessionId ? `Session ${item.engineSessionId.slice(0, 8)}` : 'Unidentified session') };
}
export type SessionSortKey = 'session' | 'tokens' | 'subagents' | 'requests' | 'errors' | 'errorRate' | 'lastActive';
export const sessionColumns: { key: SessionSortKey; label: string; secondary?: boolean }[] = [
    { key: 'session', label: 'Session' }, { key: 'tokens', label: 'Tokens' },
    { key: 'subagents', label: 'Subagents', secondary: true }, { key: 'requests', label: 'Tool requests', secondary: true },
    { key: 'errors', label: 'Tool errors' }, { key: 'errorRate', label: 'Error rate' },
    { key: 'lastActive', label: 'Last active', secondary: true },
];
export function rankedSessions(summary: UsageRangeSummary, key: SessionSortKey, ascending = false, rows: readonly MergedSessionRow[] = []) {
    const value = (item: UsageRankedSession): number | string | null => {
        switch (key) {
            case 'session': return sessionLabel(item, rows).label;
            case 'tokens': return usageTotal(item.tokens);
            case 'subagents': return usageTotal(item.tokens) ? usageTotal(item.tokenSources.subagents) / usageTotal(item.tokens) : null;
            case 'requests': return item.requests;
            case 'errors': return item.errors;
            case 'errorRate': return item.results ? item.errors / item.results : null;
            case 'lastActive': return Date.parse(item.lastActiveAt);
        }
    };
    return [...summary.rankedSessions.items].sort((a, b) => {
        const av = value(a), bv = value(b);
        if (av === null || bv === null) return av === bv ? a.id.localeCompare(b.id) : av === null ? 1 : -1;
        const comparison = typeof av === 'string' && typeof bv === 'string' ? av.localeCompare(bv) : Number(av) - Number(bv);
        return (ascending ? 1 : -1) * comparison || a.id.localeCompare(b.id);
    });
}
export function sessionFigures(summary: UsageRangeSummary) {
    const total = usageTotal(summary.tokens);
    const sources = summary.days.reduce((sum, day) => ({ subagents: sum.subagents + usageTotal(day.tokenSources.subagents), compaction: sum.compaction + usageTotal(day.tokenSources.compaction) }), { subagents: 0, compaction: 0 });
    return { top10: total ? summary.rankedSessions.top10Tokens / total * 100 : null,
        subagents: total ? sources.subagents / total * 100 : null, compaction: total ? sources.compaction / total * 100 : null,
        median: summary.rankedSessions.medianTokens };
}
export function sessionLastActive(timestamp: string): string {
    return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(timestamp));
}
export function sessionSpan(item: UsageRankedSession): string | null {
    if (!item.firstActiveAt) return null;
    const hours = (Date.parse(item.lastActiveAt) - Date.parse(item.firstActiveAt)) / 3600000;
    return hours < 1 ? `${Math.max(1, Math.round(hours * 60))} min` : hours < 48 ? `${hours.toFixed(1)} h` : `${Math.round(hours / 24)} days`;
}
export function sessionErrorMedian(items: readonly UsageRankedSession[]) {
    const rates = items.filter(item => item.results > 0).map(item => item.errors / item.results).sort((a, b) => a - b);
    const middle = Math.floor(rates.length / 2);
    return rates.length ? (rates[middle]! + rates[Math.max(0, middle - (rates.length % 2 === 0 ? 1 : 0))]!) / 2 : null;
}
export function sessionDailySeries(item: UsageRankedSession, summary: UsageRangeSummary): AnalyticsPoint[] {
    if (item.dailyDetail === 'unavailable') return [];
    const map = new Map(item.days.map(day => [day.date, usageTotal(day.tokens)]));
    const points: AnalyticsPoint[] = [];
    const dates = [...map.keys()].filter(date => date >= summary.startDate && date < summary.endDateExclusive).sort();
    if (!dates.length) return [];
    for (let t = epoch(dates[0]!); t <= epoch(dates.at(-1)!); t += DAY) {
        const date = dateKey(t);
        points.push({ date, endDate: dateKey(t + DAY), values: [map.get(date) ?? 0] });
    }
    return points;
}
export function integrationSeries(summary: UsageRangeSummary, kind: 'skills' | 'integrations') {
    const totals = summary[kind];
    const named = [...totals].filter(item => item.kind !== 'other').sort((a, b) => b.requests - a.requests || a.id.localeCompare(b.id)).slice(0, 4);
    const ids = new Set(named.map(item => item.id));
    const other = totals.filter(item => !ids.has(item.id));
    const series = [...named.map(item => ({ id: item.id, label: item.label, total: item.requests })), ...(other.length ? [{ id: '__other', label: 'Other', total: other.reduce((n, item) => n + item.requests, 0) }] : [])];
    const start = epoch(summary.startDate), end = epoch(summary.endDateExclusive);
    const bucket = summary.range === '30d' ? 7 : summary.bucketDays ?? 1;
    const points = new Map<string, AnalyticsPoint>();
    const pointFor = (time: number) => {
        // Weekly boundaries are anchored to the exclusive range end, as in the prototype.
        const begin = summary.range === '30d' ? Math.max(start, end - Math.ceil((end - time) / (7 * DAY)) * 7 * DAY) : start + Math.floor((time - start) / (bucket * DAY)) * bucket * DAY;
        const date = dateKey(begin);
        if (!points.has(date)) points.set(date, { date, endDate: dateKey(Math.min(end, summary.range === '30d' ? end - Math.floor((end - time - 1) / (7 * DAY)) * 7 * DAY : begin + bucket * DAY)), values: series.map(() => 0) });
        return points.get(date)!;
    };
    if (summary.range !== 'all') for (let t = start; t < end; t += DAY) pointFor(t);
    for (const day of summary.days) {
        const t = epoch(day.date);
        if (t < start || t >= end) continue;
        const point = pointFor(t);
        for (const item of day[kind]) {
            const index = ids.has(item.id) ? series.findIndex(s => s.id === item.id) : series.findIndex(s => s.id === '__other');
            if (index >= 0) point.values[index]! += item.requests;
        }
    }
    return { series, points: [...points.values()].sort((a, b) => a.date.localeCompare(b.date)), total: totals.reduce((n, item) => n + item.requests, 0) };
}
export function analyticsLine(points: AnalyticsPoint[], index: number, startDate: string, endDate: string, max: number) {
    const start = epoch(startDate), span = Math.max(DAY, epoch(endDate) - start - DAY);
    return points.map((point, i) => `${i ? 'L' : 'M'}${(32 + (epoch(point.date) - start) / span * 544).toFixed(2)},${(150 - (point.values[index] ?? 0) / Math.max(1, max) * 130).toFixed(2)}`).join(' ');
}
export function sessionSpend(item: UsageRankedSession): string {
    const cost = item.tokenCost;
    if (!cost || !cost.pricedTokens) return 'Unpriced';
    return `${cost.usd > 0 && cost.usd < 0.01 ? '<$0.01' : `$${cost.usd.toFixed(2)}`}${cost.pricedTokens < usageTotal(item.tokens) ? ' partial' : ''}`;
}
export function analyticsDateLabel(date: string) {
    return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(epoch(date)));
}
export function analyticsScale(max: number) {
    const raw = Math.max(1, max) / 4;
    const magnitude = 10 ** Math.floor(Math.log10(raw));
    const error = raw / magnitude;
    const step = (error >= Math.sqrt(50) ? 10 : error >= Math.sqrt(10) ? 5 : error >= Math.sqrt(2) ? 2 : 1) * magnitude;
    const top = Math.ceil(Math.max(1, max) / step) * step;
    return { top, ticks: Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step) };
}
/** Monotone cubic Hermite interpolation with bounded endpoint tangents. */
export function analyticsMonotone(points: readonly { x: number; y: number }[]): string {
    if (!points.length) return '';
    if (points.length === 1) return `M${points[0]!.x},${points[0]!.y}`;
    const slopes = points.slice(1).map((p, i) => (p.y - points[i]!.y) / (p.x - points[i]!.x));
    const tangents = points.map((_, i) => {
        if (!i) return slopes[0]!;
        if (i === points.length - 1) return slopes.at(-1)!;
        const a = slopes[i - 1]!, b = slopes[i]!;
        const h0 = points[i]!.x - points[i - 1]!.x, h1 = points[i + 1]!.x - points[i]!.x;
        const weighted = (a * h1 + b * h0) / (h0 + h1);
        return (Math.sign(a) + Math.sign(b)) * Math.min(Math.abs(a), Math.abs(b), Math.abs(weighted) / 2);
    });
    if (points.length > 2) {
        tangents[0] = (3 * slopes[0]! - tangents[1]!) / 2;
        tangents[tangents.length - 1] = (3 * slopes.at(-1)! - tangents.at(-2)!) / 2;
    }
    return points.reduce((path, p, i) => {
        if (!i) return `M${p.x},${p.y}`;
        const before = points[i - 1]!, third = (p.x - before.x) / 3;
        return `${path} C${before.x + third},${before.y + third * tangents[i - 1]!} ${p.x - third},${p.y - third * tangents[i]!} ${p.x},${p.y}`;
    }, '');
}
export function analyticsNearestIndex(x: number, left: number, right: number, count: number) {
    return count <= 1 ? 0 : Math.max(0, Math.min(count - 1, Math.round((x - left) / (right - left) * (count - 1))));
}
export function analyticsCalendarTickIndices(positions: readonly number[], widths: readonly number[], gap = 12): Set<number> {
    if (!positions.length) return new Set();
    const last = positions.length - 1, selected = new Set([0]);
    let edge = positions[0]! + widths[0]!;
    const lastLeft = positions[last]! - widths[last]!;
    for (let i = 1; i < last; i++) {
        const left = positions[i]! - widths[i]! / 2, right = positions[i]! + widths[i]! / 2;
        if (left >= edge + gap && right + gap <= lastLeft) { selected.add(i); edge = right; }
    }
    if (last > 0 && lastLeft >= edge + gap) selected.add(last);
    return selected;
}
export function sessionSourceSegments(item: UsageRankedSession, width: number) {
    const sources = (['chat', 'subagents', 'compaction'] as const).filter(source => usageTotal(item.tokenSources[source]) > 0);
    const total = sources.reduce((sum, source) => sum + usageTotal(item.tokenSources[source]), 0);
    const available = Math.max(0, width - Math.max(0, sources.length - 1) * 2);
    let x = 0;
    return sources.map(source => {
        const segment = { source, x, width: total ? usageTotal(item.tokenSources[source]) / total * available : 0 };
        x += segment.width + 2;
        return segment;
    });
}
