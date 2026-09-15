/** UTC calendar windows share a caller-captured observation cutoff. */
export function usageWindow(days: 7 | 30, asOf: string): {
    startInclusive: string;
    endExclusive: string;
    dates: string[];
} {
    const now = new Date(asOf);
    if (!Number.isFinite(now.getTime()))
        throw new Error('Invalid usage cutoff');
    const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - days + 1);
    return {
        startInclusive: new Date(start).toISOString(),
        endExclusive: new Date(start + days * 86400000).toISOString(),
        dates: Array.from({ length: days }, (_, i) => new Date(start + i * 86400000).toISOString().slice(0, 10)),
    };
}
export function usageTimestampEligible(timestamp: number, start: number, end: number, cutoff: number): boolean {
    return Number.isFinite(timestamp) && timestamp >= start && timestamp < end && timestamp <= cutoff;
}
