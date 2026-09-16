import type { UsageDay, UsageRangeSummary } from '../../shared/usageDashboard.js';
import { usageHasCacheWrites } from './usageTrendState.js';
import { usageTotal } from './usageDashboardState.js';
export type UsageFlowMode = 'type' | 'model';
export function usageAxisCeiling(value: number): number {
    if (value <= 0) return 1;
    const unit = 10 ** Math.floor(Math.log10(value));
    return ([1, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10].find(step => step >= value / unit) ?? 10) * unit;
}
export function usageChartDate(date: string, includeYear = false): string {
    const parsed = new Date(`${date}T00:00:00.000Z`);
    return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][parsed.getUTCMonth()]} ${parsed.getUTCDate()}${includeYear ? ` '${String(parsed.getUTCFullYear()).slice(-2)}` : ''}`;
}
export function usageChartTicks(start: string, endExclusive: string, width: number): string[] {
    const first = Date.parse(start), days = Math.max(1, Math.round((Date.parse(endExclusive) - first) / 86400000));
    const count = Math.max(2, Math.floor(width / (days > 365 ? 90 : 64)));
    const interval = Math.max(1, Math.ceil(days / count));
    const dates: string[] = [];
    for (let day = 0; day < days; day += interval) dates.push(new Date(first + day * 86400000).toISOString().slice(0, 10));
    // End labels have their own space; avoid colliding with the preceding label.
    if (days > 1) {
        if ((days - 1) % interval < interval && dates.length > 1) dates.pop();
        dates.push(new Date(first + (days - 1) * 86400000).toISOString().slice(0, 10));
    }
    return dates;
}
export function usageGraphColors(ids: readonly string[]): Record<string, string> {
    const palette = ['var(--usage-blue)', 'var(--usage-amber)', 'var(--usage-teal)', 'var(--usage-violet)', 'var(--usage-cyan)', 'var(--usage-coral)', 'light-dark(#697c22,#bbca70)', 'light-dark(#a54e88,#d897c5)', 'light-dark(#956343,#cdaa8b)', 'var(--usage-other)'];
    return Object.fromEntries([...new Set(ids)].map((id, i) => [id, palette[i % palette.length]!]));
}
export function usageFlowSeries(summary: UsageRangeSummary, colors: Record<string, string>, mode: UsageFlowMode, hideReads: boolean) {
    if (mode === 'model') return summary.models.map(model => ({ id: model.id, label: model.label, color: colors[model.id]!, total: usageTotal(model.tokens), value: (day: UsageDay) => day.models.find(m => m.id === model.id)?.total ?? 0 }));
    return ([['output', 'Output', 'var(--usage-output)'], ['fresh', 'Fresh input', 'var(--usage-fresh)'], ['read', 'Cache reads', 'var(--usage-cache)'], ['write', 'Cache writes', 'var(--usage-writes)']] as const)
        .filter(([key]) => !(key === 'read' && hideReads) && !(key === 'write' && !usageHasCacheWrites(summary)))
        .map(([id, label, color]) => ({ id, label, color, total: summary.tokens[id], value: (day: UsageDay) => day.tokens[id] }));
}
