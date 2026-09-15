import { useEffect, useRef, useState } from 'react';
import type { UsageCollectionResult, UsageDashboardSnapshot, UsageRangeSummary, UsageTokens, UsageWindow } from '../../shared/usageDashboard.js';
export type UsageSelection = { range: UsageWindow; date: string };
export const initialUsageSelection: UsageSelection = { range: '7d', date: '' };
export const usageCompact = (n: number): string => new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: n >= 1e9 ? 2 : 1 }).format(n);
export type UsageDashboardState = {
    snapshot: UsageDashboardSnapshot | null;
    status: 'loading' | 'ready' | 'error' | 'unavailable';
    errorCode?: Extract<UsageCollectionResult, { type: 'error' }>['code'];
};
export const initialUsageDashboardState: UsageDashboardState = { snapshot: null, status: 'loading' };
export function reduceUsageDashboard(state: UsageDashboardState, result: UsageCollectionResult | { type: 'loading' }): UsageDashboardState {
    if (result.type === 'loading') return { ...state, status: 'loading' };
    if (result.type === 'error')
        return { ...state, status: result.code === 'unavailable' ? 'unavailable' : 'error', errorCode: result.code };
    if (state.snapshot && Date.parse(result.snapshot.asOf) < Date.parse(state.snapshot.asOf))
        return state;
    return { snapshot: result.snapshot, status: 'ready' };
}
export function usageFailureMessage(code: UsageDashboardState['errorCode']): string {
    if (code === 'resource-limit') return 'Usage history exceeded the processing limit. Another attempt will run automatically.';
    if (code === 'timeout') return 'Updating usage took too long. Another attempt will run automatically.';
    if (code === 'invalid-output') return 'The usage update could not be verified. Another attempt will run automatically.';
    return 'Usage could not be loaded. Another attempt will run automatically.';
}
export const usageTotal = (t: UsageTokens): number => t.fresh + t.read + t.write + t.output;
export const usageShare = (t: UsageTokens): number | null => t.fresh + t.read + t.write > 0 ? t.read / (t.fresh + t.read + t.write) * 100 : null;
export const usageNumber = (n: number): string => n.toLocaleString('en-US');
export const usagePercent = (n: number | null): string => n === null ? 'Not applicable' : `${n.toFixed(1)}%`;
export function usageColors(ids: readonly string[]): Record<string, string> {
    const palette = ['#F5B942', '#4C9AFF', '#2DD4BF', '#F4729A', '#A78BFA', '#38BDF8', '#14B8A6', '#FBBF24', '#E9A83B', '#22C3A6', '#84CC16', '#F97316', '#818CF8', '#ED6D91', '#06B6D4', '#D4A6FF', '#A3D977', '#FB923C', '#E879C2', '#60A5FA'];
    const result: Record<string, string> = {}, taken = new Set<number>();
    for (const id of [...ids].sort()) {
        let hash = 2166136261;
        for (const char of id)
            hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
        let index = (hash >>> 0) % palette.length;
        while (taken.has(index) && taken.size < palette.length)
            index = (index + 1) % palette.length;
        taken.add(index);
        result[id] = palette[index]!;
    }
    return result;
}

export function usageCacheBounds(shares: readonly (number | null)[]): { min: number; max: number } {
    const values = shares.filter((value): value is number => value !== null && Number.isFinite(value));
    if (!values.length) return { min: 0, max: 100 };
    const low = Math.min(...values), high = Math.max(...values);
    const padding = Math.max(2, (high - low) * 0.15);
    return { min: Math.max(0, Math.floor(low - padding)), max: Math.min(100, Math.ceil(high + padding)) };
}

export function useUsageChartWidth() {
    const ref = useRef<SVGSVGElement>(null);
    const [width, setWidth] = useState(640);
    useEffect(() => {
        const element = ref.current;
        if (!element) return;
        const measure = () => { const next = element.getBoundingClientRect().width; if (next > 0) setWidth(Math.max(240, next)); };
        measure();
        if (typeof ResizeObserver === 'undefined') return;
        const observer = new ResizeObserver(measure);
        observer.observe(element);
        return () => observer.disconnect();
    }, []);
    return { ref, width };
}

export function usageCacheWrites(value: number, reporting: UsageRangeSummary['cacheWriteReporting']): string {
    switch (reporting) {
        case 'reported': return usageNumber(value);
        case 'partial': return `${usageNumber(value)} reported`;
        case 'unreported': return 'Not reported';
        case 'unavailable': return 'Not applicable';
    }
}
