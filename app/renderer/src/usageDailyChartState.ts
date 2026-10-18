import type { UsageDay, UsageRangeSummary } from '../../shared/usageDashboard.js';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { usageTotal, useUsageChartWidth } from './usageDashboardState.js';
import { usageMetricDelta } from './usageMetricDelta.js';
import { usageAnalyticsToolColor } from './usageAnalyticsDetailsState.js';
import { usageStackedAreaGeometry } from './usageStackedAreaState.js';

export type UsageDailyMetric = 'tokens' | 'requests' | 'sessions' | 'toolErrors' | 'errorRate' | 'auto';
export type UsageTokenGrouping = 'family' | 'source';
export const usageDailyGradientStops = [[0, .26], [.25, .16], [.5, .08], [.75, .03], [1, 0]] as const;
export function usageDailyDayLabel(summary: UsageRangeSummary, date: string): string {
    const count = Math.min(summary.bucketDays ?? 1, (Date.parse(`${summary.endDateExclusive}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 86400000);
    const day = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC', ...((summary.bucketDays ?? 1) === 1 ? { weekday: 'short' as const } : {}) }).format(new Date(`${date}T12:00:00Z`));
    return count <= 1 ? day : `${day} + ${count - 1} ${count === 2 ? 'day' : 'days'}`;
}
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
    return { slots, groups, bucketCount: span / bucketDays, firstCenter: Math.min(span, bucketDays) / 2 / span, lastCenter: (Math.floor((span - 1) / bucketDays) * bucketDays + span) / 2 / span };
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
        if (grouping === 'source') return (['chat', 'subagents', 'compaction'] as const).map((source, index) => ({ id: source, label: source === 'chat' ? 'Chat' : source === 'subagents' ? 'Subagents' : 'Compaction', color: `var(--usage-category-${[0, 3, 4][index]})`, value: (day: UsageDay) => day.tokenSources ? usageTotal(day.tokenSources[source]) : 0 }));
        const families = new Map(summary.models.map(model => [model.id, usageAnalyticsFamily(model.label)]));
        return usageAnalyticsFamilies.filter(family => [...families.values()].includes(family)).map(family => ({ id: family, label: family, color: usageAnalyticsFamilyColor(family), value: (day: UsageDay) => day.models.reduce((sum, model) => sum + (families.get(model.id) === family ? model.total : 0), 0) }));
    }
    if (metric === 'requests') return [...(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const).map((level, index) => ({ id: level, label: ({ low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max', ultra: 'Ultra' })[level], color: `var(--usage-sequential-${Math.max(1, index)})`, value: (day: UsageDay) => day.effort.requests[level] })).filter(item => summary.effort.requests[item.id] > 0), { id: 'unrecorded', label: 'Not recorded', color: 'var(--usage-other)', value: (day: UsageDay) => day.effort.unattributedRequests }];
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
    return usageDailyMetricDelta(usageDailyTotal(summary, metric), baseline, metric === 'errorRate' ? 'points' : 'percent');
}
export function usageDailyMetricDelta(current: number | null, previous: number | null, unit: 'percent' | 'points' = 'percent') {
    const delta = usageMetricDelta(current, previous, unit);
    return delta ? { ...delta, magnitude: Math.abs(unit === 'points' ? current! - previous! : (current! - previous!) / previous! * 100) } : null;
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

export function usageDailyTextWidth(text: string, bold = false, size = bold ? 11.5 : 11): number {
    if (typeof document !== 'undefined' && typeof SVGTextContentElement !== 'undefined' && 'getComputedTextLength' in SVGTextContentElement.prototype) {
        const canvas = document.createElement('canvas'), context = canvas.getContext('2d');
        if (context) {
            context.font = `${bold ? 650 : 400} ${size}px "DM Sans"`;
            return context.measureText(text).width;
        }
    }
    return text.length * (bold ? 6.4 : 6) * size / (bold ? 11.5 : 11);
}

export function usageSelectedToolId(summary: UsageRangeSummary | undefined, metric: UsageDailyMetric, hidden: readonly string[]): string | undefined {
    if (!summary || metric !== 'toolErrors') return undefined;
    const visible = summary.tools.filter(tool => !hidden.includes(tool.id));
    return visible.length === 1 && visible[0]!.kind === 'named' ? visible[0]!.id : undefined;
}

function dailyTickStep(peak: number, count: number): number {
    const raw = peak / count, power = 10 ** Math.floor(Math.log10(raw || 1)), error = raw / power;
    return power * (error >= Math.sqrt(50) ? 10 : error >= Math.sqrt(10) ? 5 : error >= Math.sqrt(2) ? 2 : 1);
}

export function useUsageDailyChartSize() {
    const chart = useUsageChartWidth(), [height, setHeight] = useState(300);
    useEffect(() => {
        const element = chart.ref.current;
        if (!element) return;
        const measure = () => { const next = element.getBoundingClientRect().height; if (next >= 300) setHeight(Math.floor(next)); };
        measure();
        if (typeof ResizeObserver === 'undefined') return;
        const observer = new ResizeObserver(measure);
        observer.observe(element);
        return () => observer.disconnect();
    }, [chart.ref]);
    return { ...chart, height };
}

export function usageDailyPlot(summary: UsageRangeSummary, metric: UsageDailyMetric, width: number, totals: readonly number[], format: (value: number) => string, last: number | null, height = 300, lastFormat = format) {
    const area = metric === 'tokens' || metric === 'requests', line = metric === 'sessions' || metric === 'errorRate';
    const count = area ? 4 : 5, peak = (Math.max(0, ...totals) || 1) * (area ? 1.04 : 1);
    let step = dailyTickStep(peak, count), max = Math.ceil(peak / step) * step;
    step = dailyTickStep(max, count); max = Math.ceil(max / step) * step;
    const ticks = Array.from({ length: Math.round(max / step) + 1 }, (_, index) => index * step);
    const left = Math.max(...ticks.map(value => usageDailyTextWidth(format(value))), 0) + 14;
    const right = Math.max(left + 1, width - (line ? (last === null ? 0 : usageDailyTextWidth(lastFormat(last), true)) + 18 : area ? 6 : 4));
    const top = area ? 22 : 16, bottom = height - 26, span = right - left, calendar = usageDailyCalendar(summary);
    const slotStart = (index: number) => left + calendar.slots[index]!.start * span;
    const slotWidth = (index: number) => (calendar.slots[index]!.end - calendar.slots[index]!.start) * span;
    const partialSlot = (index: number) => (calendar.slots[index]!.end - calendar.slots[index]!.start) * calendar.bucketCount < 1 - 1e-9;
    const barWidth = (index: number) => Math.min(24, slotWidth(index) * .76 * (partialSlot(index) ? 1 : calendar.bucketCount / Math.max(1, calendar.bucketCount - .08)));
    const x = (index: number) => {
        const slot = calendar.slots[index]!;
        if (area) return left + slot.center * span;
        // Band padding assumes full buckets; a clipped bucket must stay inside its own bounds.
        if (!line && partialSlot(index)) return slotStart(index) + slotWidth(index) / 2;
        if (!line) return left + (calendar.bucketCount <= 1 ? .5 : (slot.center * calendar.bucketCount - .04) / (calendar.bucketCount - .08)) * span;
        // Point padding matches the prototype without collapsing missing calendar buckets.
        const padding = .3 / Math.max(1, Math.ceil(calendar.bucketCount) - 1 + .6);
        return left + (calendar.bucketCount <= 1 ? .5 : padding + (slot.center - calendar.firstCenter) / (calendar.lastCenter - calendar.firstCenter) * (1 - padding * 2)) * span;
    };
    return { max, ticks, left, right, top, bottom, calendar, x, slotStart, slotWidth, barWidth, y: (value: number) => bottom - value / max * (bottom - top), labels: usageDailyDateLabels(summary.days.map(day => day.date), x) };
}

export function usageDailyDateLabels(dates: readonly string[], x: (index: number) => number, measure = usageDailyTextWidth): number[] {
    const labels: number[] = [];
    let nextLeft = Infinity;
    const format = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
    for (let index = dates.length - 1; index >= 0; index--) {
        const halfWidth = measure(format.format(new Date(`${dates[index]}T12:00:00Z`))) / 2;
        const center = x(index);
        if (center + halfWidth + 14 > nextLeft) continue;
        labels.push(index);
        nextLeft = center - halfWidth;
    }
    return labels.reverse();
}

export function usageDailyLine(values: readonly (number | null)[], plot: ReturnType<typeof usageDailyPlot>) {
    let path = '', wash = '', length = 0, previous: { x: number; y: number } | null = null;
    values.forEach((value, index) => {
        if (index && plot.calendar.slots[index]!.start > plot.calendar.slots[index - 1]!.end + 1e-9 || value === null) {
            if (previous) wash += `L${previous.x},${plot.bottom}Z `;
            previous = null;
        }
        if (value === null) return;
        const point = { x: plot.x(index), y: plot.y(value) };
        if (previous) length += Math.hypot(point.x - previous.x, point.y - previous.y);
        else wash += `M${point.x},${plot.bottom} `;
        path += `${previous ? 'L' : 'M'}${point.x},${point.y} `;
        wash += `L${point.x},${point.y} `;
        previous = point;
    });
    if (previous) { const end = previous as { x: number; y: number }; wash += `L${end.x},${plot.bottom}Z`; }
    return { path, wash, length };
}

export function usageDailyMarks(values: readonly (number | null)[][], plot: ReturnType<typeof usageDailyPlot>) {
    const areas = plot.calendar.groups.map(group => {
        const samples = group.map(index => ({ x: plot.x(index), values: values[index]!.map(value => value ?? 0) }));
        const first = group[0]!, last = group.at(-1)!;
        samples.unshift({ x: plot.slotStart(first), values: samples[0]!.values });
        samples.push({ x: plot.slotStart(last) + plot.slotWidth(last), values: samples.at(-1)!.values });
        return usageStackedAreaGeometry(samples, plot.max, plot.top, plot.bottom);
    });
    const bars = values.flatMap((row, index) => {
        let sum = 0;
        const last = row.reduce<number>((last, value, index) => value !== null && value > 0 ? index : last, -1);
        return row.flatMap((value, seriesIndex) => {
            if (!value) return [];
            const base = sum; sum += value;
            const width = plot.barWidth(index), rounded = seriesIndex === last;
            return [{ index, seriesIndex, path: usageDailyBar(plot.x(index) - width / 2, width, plot.y(sum) + (base > 0 || !rounded ? 1 : 0), plot.y(base) - (base > 0 ? 1 : 0), rounded) }];
        });
    });
    return { areas, bars };
}

export function usageDailyBar(x: number, width: number, top: number, bottom: number, rounded: boolean): string {
    const height = Math.max(0, bottom - top), radius = Math.min(4, width / 2, height);
    if (height <= .5) return '';
    return rounded ? `M${x},${bottom}V${top + radius}Q${x},${top} ${x + radius},${top}H${x + width - radius}Q${x + width},${top} ${x + width},${top + radius}V${bottom}Z` : `M${x},${top}h${width}v${height}h${-width}Z`;
}

export function usageDailyTooltip(x: number, y: number, width: number, height: number, head: string, rows: readonly { label: string; value: string }[], measuredHeight?: number) {
    const tipWidth = Math.max(140, usageDailyTextWidth(head, true, 12) + 20, ...rows.map(row => usageDailyTextWidth(row.label, false, 12) + usageDailyTextWidth(row.value, true, 12) + 52));
    const tipHeight = measuredHeight ?? 38 + rows.length * 20;
    return { x: Math.max(0, x + 14 + tipWidth > width ? x - tipWidth - 14 : x + 14), y: Math.max(0, Math.min(height - tipHeight, y - tipHeight / 2)), width: tipWidth, height: tipHeight };
}

export function useUsageDailyTooltip(x: number, y: number, width: number, height: number, head: string, rows: readonly { label: string; value: string }[]) {
    const ref = useRef<HTMLDivElement>(null), [measuredHeight, setMeasuredHeight] = useState<number>();
    useLayoutEffect(() => {
        const height = ref.current?.getBoundingClientRect().height, next = height ? Math.ceil(height) : 0;
        if (next && next !== measuredHeight) setMeasuredHeight(next);
    });
    useEffect(() => {
        const element = ref.current;
        if (!element || typeof ResizeObserver === 'undefined') return;
        const observer = new ResizeObserver(() => {
            const next = Math.ceil(element.getBoundingClientRect().height);
            if (next > 0) setMeasuredHeight(previous => previous === next ? previous : next);
        });
        observer.observe(element);
        return () => observer.disconnect();
    }, []);
    return { ref, box: usageDailyTooltip(x, y, width, height, head, rows, measuredHeight) };
}

export function usageDailyPointer(event: Pick<MouseEvent, 'clientX' | 'clientY'>, bounds: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>, fallbackWidth: number, fallbackHeight: number) {
    const width = bounds.width || fallbackWidth, height = bounds.height || fallbackHeight;
    return { x: Math.max(0, Math.min(width, event.clientX - bounds.left)), y: Math.max(0, Math.min(height, event.clientY - bounds.top)), height };
}

export function usageDailyDonut(values: readonly number[]) {
    const total = values.reduce((sum, value) => sum + value, 0), count = values.filter(value => value > 0).length;
    let offset = -Math.PI / 2;
    const polar = (radius: number, angle: number) => `${58 + radius * Math.cos(angle)},${58 + radius * Math.sin(angle)}`;
    return values.map(value => {
        if (value <= 0 || !total) return '';
        const angle = value / total * (Math.PI * 2 - count * .025) + .025, start = offset, end = offset + angle;
        offset = end;
        if (count === 1) return `M58,2A56,56 0 1 1 58,114A56,56 0 1 1 58,2M58,15A43,43 0 1 0 58,101A43,43 0 1 0 58,15Z`;
        const pad = Math.hypot(43, 56) * Math.sin(.025 / 2);
        const outerStart = start + Math.asin(Math.min(1, pad / 56)), outerEnd = end - Math.asin(Math.min(1, pad / 56));
        const innerStart = start + Math.asin(Math.min(1, pad / 43)), innerEnd = end - Math.asin(Math.min(1, pad / 43));
        if (outerEnd <= outerStart) return `M${polar(56, (start + end) / 2)}L${polar(43, (start + end) / 2)}Z`;
        if (innerEnd <= innerStart) {
            const middle = (start + end) / 2, inner = { x: 43 * Math.cos(middle), y: 43 * Math.sin(middle) };
            const first = { x: 56 * Math.cos(outerStart) - inner.x, y: 56 * Math.sin(outerStart) - inner.y };
            const last = { x: 56 * Math.cos(outerEnd) - inner.x, y: 56 * Math.sin(outerEnd) - inner.y };
            const cosine = Math.max(-1, Math.min(1, (first.x * last.x + first.y * last.y) / Math.hypot(first.x, first.y) / Math.hypot(last.x, last.y)));
            const corner = Math.min(3, 13 / (1 / Math.sin(Math.acos(cosine) / 2) + 1));
            const tangent = (direction: typeof first, side: number) => {
                const length = Math.hypot(direction.x, direction.y), dx = direction.x / length, dy = direction.y / length;
                const nx = -dy * side, ny = dx * side, ox = inner.x + corner * nx, oy = inner.y + corner * ny;
                const dot = ox * dx + oy * dy, distance = -dot + Math.sqrt(Math.max(0, dot * dot + (56 - corner) ** 2 - ox * ox - oy * oy));
                return `${58 + ox + distance * dx - corner * nx},${58 + oy + distance * dy - corner * ny}`;
            };
            // A collapsed inner edge meets at a point, so its outer fillets no longer follow parallel radial offsets.
            return `M${tangent(first, 1)}A${corner},${corner} 0 1 1 ${tangent(last, -1)}L${polar(43, middle)}Z`;
        }
        const sine = Math.sin(angle / 2);
        const outerCorner = angle >= Math.PI ? 3 : Math.max(0, Math.min(3, (56 * sine - pad) / (1 + sine)));
        const innerCorner = angle >= Math.PI ? 3 : Math.max(0, Math.min(3, (43 * sine - pad) / (1 - sine)));
        const outerDelta = Math.asin((pad + outerCorner) / (56 - outerCorner)), innerDelta = Math.asin(Math.min(1, (pad + innerCorner) / (43 + innerCorner)));
        // Padded edges are parallel offsets of the radial edges, not rays from the centre.
        const edge = (radius: number, corner: number, angle: number, side: number) => {
            const along = Math.sqrt(Math.max(0, radius * radius - (pad + corner) ** 2));
            return `${58 + along * Math.cos(angle) - side * pad * Math.sin(angle)},${58 + along * Math.sin(angle) + side * pad * Math.cos(angle)}`;
        };
        const outerEdgeStart = edge(56 - outerCorner, outerCorner, start, 1), outerEdgeEnd = edge(56 - outerCorner, outerCorner, end, -1);
        const outer = outerCorner < 3
            ? `M${outerEdgeStart}A${outerCorner},${outerCorner} 0 1 1 ${outerEdgeEnd}`
            : `M${outerEdgeStart}A3,3 0 0 1 ${polar(56, start + outerDelta)}A56,56 0 ${angle - 2 * outerDelta > Math.PI ? 1 : 0} 1 ${polar(56, end - outerDelta)}A3,3 0 0 1 ${outerEdgeEnd}`;
        const innerEdgeStart = edge(43 + innerCorner, innerCorner, start, 1), innerEdgeEnd = edge(43 + innerCorner, innerCorner, end, -1);
        return outer + (innerCorner < 3
            ? `L${innerEdgeEnd}A${innerCorner},${innerCorner} 0 0 1 ${innerEdgeStart}Z`
            : `L${innerEdgeEnd}A3,3 0 0 1 ${polar(43, end - innerDelta)}A43,43 0 ${angle - 2 * innerDelta > Math.PI ? 1 : 0} 0 ${polar(43, start + innerDelta)}A3,3 0 0 1 ${innerEdgeStart}Z`);
    });
}

export function usageDailyComposition(values: readonly number[], width: number) {
    const positive = values.filter(value => value > 0).length, total = values.reduce((sum, value) => sum + value, 0);
    const available = Math.max(0, width - Math.max(0, positive - 1) * 2);
    let offset = 0;
    return values.map(value => {
        const part = { x: offset, width: total ? value / total * available : 0 };
        if (value > 0) offset += part.width + 2;
        return part;
    });
}

export function usageDailyDeltaTone(metric: UsageDailyMetric | 'cache', delta: ReturnType<typeof usageDailyMetricDelta>) {
    if (!delta || metric !== 'cache' && metric !== 'errorRate' && metric !== 'toolErrors') return '';
    if (delta.magnitude < (metric === 'toolErrors' ? 2 : .2)) return '';
    return ` usage-change-${(delta.direction === 'up') === (metric === 'cache') ? 'good' : 'bad'}`;
}

export function usageMetricSpark(values: readonly (number | null)[]) {
    const points = values.flatMap((value, index) => value === null ? [] : [{ value, index }]);
    if (points.length < 2) return null;
    const low = Math.min(...points.map(point => point.value)), high = Math.max(...points.map(point => point.value));
    const pad = (high - low) * .1 || Math.abs(high) * .1 || 1;
    const x = (index: number) => 2 + index / Math.max(1, values.length - 1) * 56;
    const y = (value: number) => 25 - (value - low + pad) / (high - low + pad * 2) * 22;
    const line = points.map((point, index) => `${index ? 'L' : 'M'}${x(point.index)},${y(point.value)}`).join(' ');
    const last = points.at(-1)!;
    return { line, wash: `${line}L${x(last.index)},28L${x(points[0]!.index)},28Z`, last: { x: x(last.index), y: y(last.value) } };
}

export function useUsageBuildChartWidth() {
    const ref = useRef<SVGSVGElement>(null), [width, setWidth] = useState(180);
    useEffect(() => {
        const element = ref.current;
        if (!element) return;
        const measure = () => { const next = element.getBoundingClientRect().width; if (next > 0) setWidth(Math.max(120, next)); };
        measure();
        if (typeof ResizeObserver === 'undefined') return;
        const observer = new ResizeObserver(measure);
        observer.observe(element);
        return () => observer.disconnect();
    }, []);
    return { ref, width };
}

export function usageBuildSpark(builds: ReturnType<typeof usageLatestBuild>, width: number) {
    const recent = builds.items.slice(-10), ceiling = Math.max(builds.median ?? 0, ...recent.map(build => usageToolRate(build) ?? 0)) * 1.15 || .1;
    const x = (index: number) => recent.length === 1 ? (width - 2) / 2 : 6 + index / Math.max(1, recent.length - 1) * (width - 14);
    const y = (rate: number) => 35 - rate / ceiling * 29;
    const color = (build: typeof recent[number]) => builds.median !== null && (usageToolRate(build) ?? 0) > builds.median * 1.5 ? 'var(--usage-errors)' : build === builds.latest ? 'var(--accent)' : 'var(--usage-secondary)';
    return { recent, x, y, color, path: recent.map((build, index) => `${index ? 'L' : 'M'}${x(index)},${y(usageToolRate(build) ?? 0)}`).join(' ') };
}
