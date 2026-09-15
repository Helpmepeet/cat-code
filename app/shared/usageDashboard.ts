/** Read-only desktop usage contract. See docs/migration/decisions/USAGE-DASHBOARD.md. */
export const USAGE_DASHBOARD_VERSION = 1 as const;
export const MAX_USAGE_RECORD_BYTES = 256 * 1024;
export const MAX_USAGE_LABEL_BYTES = 160;
export const MAX_USAGE_MODELS = 8;
export const MAX_USAGE_TOOLS = 10;
export const MAX_USAGE_DAY_CONTRIBUTORS = 20;
export const MAX_USAGE_CONTRIBUTOR_MODELS = 4;
/** Stable join key for a canonical cwd already present in the session catalog. */
export function usageProjectId(cwd: string): string {
    const value = cwd.replace(/[\\/]+$/, '');
    let a = 0x9e3779b9, b = 0x85ebca6b, c = 0xc2b2ae35, d = 0x27d4eb2f;
    for (let i = 0; i < value.length; i++) {
        const n = value.charCodeAt(i);
        a = Math.imul(a ^ n, 0x85ebca6b);
        b = Math.imul(b ^ n, 0xc2b2ae35);
        c = Math.imul(c ^ n, 0x27d4eb2f);
        d = Math.imul(d ^ n, 0x165667b1);
    }
    return [a, b, c, d].map(n => (n >>> 0).toString(16).padStart(8, '0')).join('');
}
export type UsageWindow = '7d' | '30d';
export type UsageTokens = {
    fresh: number;
    read: number;
    write: number;
    output: number;
};
export type UsageCategory = {
    id: string;
    kind: 'named' | 'unknown' | 'other';
    label: string;
};
export type UsageModel = UsageCategory & {
    tokens: UsageTokens;
};
export type UsageTool = UsageCategory & {
    requests: number;
    results: number;
    errors: number;
};
export type UsageSessionContributor = {
    id: string;
    engineSessionId: string | null;
    project: { id: string; label: string } | null;
    tokens: UsageTokens;
    requests: number;
    results: number;
    errors: number;
    models: UsageModel[];
    modelDetail: { state: 'full' | 'grouped'; omitted: number };
};
export type UsageDayContributors = {
    state: 'full' | 'truncated' | 'unavailable';
    omitted: number;
    items: UsageSessionContributor[];
};
export type UsageDay = {
    hourlyRequests: number[];
    date: string;
    tokens: UsageTokens;
    cacheWriteReporting: 'reported' | 'partial' | 'unreported' | 'unavailable';
    models: {
        id: string;
        total: number;
    }[];
    sessions: number;
    records: number;
    requests: number;
    contributors: UsageDayContributors;
};
export type UsageRangeSummary = {
    range: UsageWindow;
    startInclusive: string;
    endExclusive: string;
    tokens: UsageTokens;
    sessions: number;
    records: number;
    requests: number;
    identifiedRequests: number;
    fallbackRequests: number;
    activeDays: number;
    cachedInputShare: number | null;
    cacheWriteReporting: 'reported' | 'partial' | 'unreported' | 'unavailable';
    days: UsageDay[];
    models: UsageModel[];
    tools: UsageTool[];
    detail: {
        state: 'full' | 'grouped' | 'summary-only';
        omittedModels: number;
        omittedTools: number;
    };
};
export type UsageCoverage = {
    state: 'complete' | 'partial';
    sourcesDiscovered: number;
    sourcesRead: number;
    parseErrors: number;
    oversizedRecords: number;
    pendingTailBytes: number;
    shortReads: number;
    changedSources: number;
    readErrors: number;
    invalidTimestamps: number;
    invalidUsage: number;
    identityConflicts: number;
};
export type UsageDashboardSnapshot = {
    version: 1;
    metricVersion: 1;
    countingVersion: 4;
    snapshotId: string;
    scope: 'retained-transcripts';
    timezone: 'UTC';
    asOf: string;
    computedAt: string;
    coverage: UsageCoverage;
    ranges: Record<UsageWindow, UsageRangeSummary>;
};
export type UsageCollectionResult = {
    type: 'usage';
    version: 1;
    snapshot: UsageDashboardSnapshot;
} | {
    type: 'error';
    version: 1;
    code: 'collection' | 'timeout' | 'resource-limit' | 'invalid-output' | 'unavailable';
};
