import type { UsageDay, UsageRangeSummary } from '../../shared/usageDashboard.js';
import { usageHasCacheWrites } from './usageTrendState.js';
import { usageTotal } from './usageDashboardState.js';
export type UsageFlowMode = 'type' | 'model';
export function usageGraphColors(ids: readonly string[]): Record<string, string> {
    const palette = ['var(--usage-pink)', 'var(--usage-wine)', 'var(--usage-pale)', 'var(--usage-graphite)', 'var(--usage-other)', 'color-mix(in srgb,var(--usage-pink) 65%,var(--usage-graphite))', 'color-mix(in srgb,var(--usage-wine) 65%,var(--usage-graphite))', 'color-mix(in srgb,var(--usage-pale) 50%,var(--usage-other))', 'color-mix(in srgb,var(--usage-pink) 35%,var(--usage-graphite))', 'color-mix(in srgb,var(--usage-wine) 35%,var(--usage-other))'];
    return Object.fromEntries([...ids].sort().map((id, i) => [id, palette[i % palette.length]!]));
}
export function usageFlowSeries(summary: UsageRangeSummary, colors: Record<string, string>, mode: UsageFlowMode, hideReads: boolean) {
    if (mode === 'model') return summary.models.map(model => ({ id: model.id, label: model.label, color: colors[model.id]!, total: usageTotal(model.tokens), value: (day: UsageDay) => day.models.find(m => m.id === model.id)?.total ?? 0 }));
    return ([['output', 'Output', 'var(--usage-graphite)'], ['fresh', 'Fresh input', 'var(--usage-wine)'], ['read', 'Cache reads', 'var(--usage-pink)'], ['write', 'Cache writes', 'var(--usage-pale)']] as const)
        .filter(([key]) => !(key === 'read' && hideReads) && !(key === 'write' && !usageHasCacheWrites(summary)))
        .map(([id, label, color]) => ({ id, label, color, total: summary.tokens[id], value: (day: UsageDay) => day.tokens[id] }));
}
