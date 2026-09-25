import type { UsageCategory, UsageDay, UsageHour, UsageRangeSummary } from '../../shared/usageDashboard.js';
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
export function usageHourLabel(slot: UsageHour): string {
    const minute = slot.startAt ? new Date(Date.parse(slot.startAt) + slot.offsetMinutes * 60000).getUTCMinutes() : 0;
    return `${String(slot.hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}
export function usageChartTicks(start: string, endExclusive: string, width: number): string[] {
    // Date keys are local calendar days. UTC is used only for stable civil-day arithmetic.
    const first = Date.parse(`${start}T00:00:00.000Z`), days = Math.max(1, Math.round((Date.parse(`${endExclusive}T00:00:00.000Z`) - first) / 86400000));
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
type UsageModelIdentity = Pick<UsageCategory, 'id' | 'kind' | 'label'>;
type UsageModelFamily = 'luna' | 'sol' | 'terra' | 'astra';
function usageModelFamily(label: string): UsageModelFamily | null {
    const parts = label.toLowerCase().split(/[^a-z0-9]+/);
    return (['luna', 'sol', 'terra', 'astra'] as const).find(family => parts.includes(family)) ?? null;
}
export function usageModelColors(models: readonly UsageModelIdentity[]): Record<string, string> {
    const familyColors: Record<UsageModelFamily, string> = {
        luna: 'var(--usage-model-purple)',
        sol: 'var(--usage-model-blue)',
        terra: 'var(--usage-model-orange)',
        astra: 'var(--usage-model-yellow)',
    };
    const fallback = ['var(--usage-fresh)', 'light-dark(#94c5ad,#54d2a0)', 'light-dark(#a3b0dd,#818cf8)', 'var(--usage-output)', 'light-dark(#b9c99c,#bbca70)', 'light-dark(#d4abc4,#d897c5)', 'light-dark(#d8b39a,#cdaa8b)', 'var(--usage-model-blue)'];
    const unique = [...new Map(models.map(model => [model.id, model])).values()].sort((a, b) => a.id.localeCompare(b.id));
    let fallbackIndex = 0;
    return Object.fromEntries(unique.map(model => {
        if (model.kind === 'other') return [model.id, 'var(--usage-model-pink)'];
        if (model.kind === 'unknown') return [model.id, 'var(--usage-other)'];
        const family = usageModelFamily(model.label);
        return [model.id, family ? familyColors[family] : fallback[fallbackIndex++ % fallback.length]!];
    }));
}
function usageOutsideIn<T>(items: readonly T[], total: (item: T) => number): T[] {
    const ranked = items
        .map((item, index) => ({ item, index }))
        .sort((a, b) => total(b.item) - total(a.item) || a.index - b.index)
        .map(({ item }) => item);
    const lower: T[] = [], upper: T[] = [];
    ranked.forEach((item, index) => (index % 2 === 0 ? lower : upper).push(item));
    return [...lower, ...upper.reverse()];
}
export function usageFlowSeries(summary: UsageRangeSummary, colors: Record<string, string>, mode: UsageFlowMode, hidden = new Set<string>()) {
    if (mode === 'model') {
        return usageOutsideIn(summary.models.filter(model => !hidden.has(model.id)), model => usageTotal(model.tokens))
            .map(model => ({ id: model.id, label: model.label, color: colors[model.id]!, total: usageTotal(model.tokens), value: (day: UsageDay) => day.models.find(m => m.id === model.id)?.total ?? 0 }));
    }
    const types = [
        { id: 'output', label: 'Output', color: 'var(--usage-output)', total: summary.tokens.output, value: (day: UsageDay) => day.tokens.output },
        { id: 'fresh', label: 'Input', color: 'var(--usage-fresh)', total: summary.tokens.fresh, value: (day: UsageDay) => day.tokens.fresh },
        { id: 'cache', label: 'Cache', color: 'var(--usage-cache)', total: summary.tokens.read + summary.tokens.write, value: (day: UsageDay) => day.tokens.read + day.tokens.write },
    ].filter(item => !hidden.has(item.id));
    return usageOutsideIn(types, type => type.total);
}
