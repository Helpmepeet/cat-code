export type UsageMetricDelta = { direction: 'up' | 'down' | 'flat'; text: string; description: string };

/** Percentages compare counts; percentage points compare two percentage shares. */
export function usageMetricDelta(current: number | null, previous: number | null, unit: 'percent' | 'points' = 'percent'): UsageMetricDelta | null {
    if (current === null || previous === null || !Number.isFinite(current) || !Number.isFinite(previous) || current < 0 || previous < 0 || unit === 'percent' && previous === 0) return null;
    const value = unit === 'points' ? current - previous : (current - previous) / previous * 100;
    if (!Number.isFinite(value)) return null;
    const rounded = Math.round(value * 10) / 10;
    const direction = rounded > 0 ? 'up' : rounded < 0 ? 'down' : 'flat';
    const magnitude = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(Math.abs(rounded));
    return {
        direction,
        text: `${direction === 'up' ? '▲ ' : direction === 'down' ? '▼ ' : ''}${magnitude}${unit === 'points' ? ' pp' : '%'}`,
        description: `${magnitude}${unit === 'points' ? ' percentage points' : '%'} ${direction === 'up' ? 'increase' : direction === 'down' ? 'decrease' : 'change'}`,
    };
}
