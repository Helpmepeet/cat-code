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
    if (code === 'resource-limit') return 'Usage history exceeded the processing limit.';
    if (code === 'timeout') return 'Usage update timed out.';
    if (code === 'invalid-output') return 'Usage data could not be verified.';
    return 'Usage could not be loaded.';
}
export const usageTotal = (t: UsageTokens): number => t.fresh + t.read + t.write + t.output;
export const usageShare = (t: UsageTokens): number | null => t.fresh + t.read + t.write > 0 ? t.read / (t.fresh + t.read + t.write) * 100 : null;
export const usageCacheReadRate = (t: UsageTokens): number | null => t.fresh + t.read > 0 ? t.read / (t.fresh + t.read) * 100 : null;
export const usageNumber = (n: number): string => n.toLocaleString('en-US');
export const usagePercent = (n: number | null): string => n === null ? 'Not applicable' : `${n.toFixed(1)}%`;
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
