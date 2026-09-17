/** Read-only desktop usage contract. See docs/migration/decisions/USAGE-DASHBOARD.md. */
export const USAGE_DASHBOARD_VERSION = 1 as const;
/** Bump whenever configured rates or retained-history pricing semantics change. */
export const USAGE_PRICING_VERSION = 1 as const;
export const MAX_USAGE_RECORD_BYTES = 256 * 1024;
export const MAX_USAGE_LABEL_BYTES = 160;
export const MAX_USAGE_MODELS = 8;
export const MAX_USAGE_TOOLS = 10;
export const MAX_USAGE_TOOL_BUILDS_PER_DAY = 8;
export const MAX_USAGE_DAY_CONTRIBUTORS = 20;
export const MAX_USAGE_CONTRIBUTOR_MODELS = 4;
export const MAX_USAGE_TIMELINE_EVENTS = 12;
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
export type UsageWindow = '7d' | '30d' | 'all';
export const MAX_USAGE_ALL_BUCKETS = 180;
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
export type UsageTokenCostEstimate = {
    /** Configured standard-rate subtotal for the priced token categories. */
    usd: number;
    /** Token count matched to a configured model rate, not monetary coverage. */
    pricedTokens: number;
};
export type UsageModel = UsageCategory & {
    tokens: UsageTokens;
    /** Required on validated snapshots; optional only for pre-grouping callers. */
    tokenCost?: UsageTokenCostEstimate;
};
export type UsageTool = UsageCategory & {
    requests: number;
    results: number;
    errors: number;
};
export type UsageToolBuildObservation = {
    /** Commit recorded by the Cat Code build that wrote the tool request. */
    sha: string;
    dirty: boolean;
    requests: number;
    results: number;
    errors: number;
    /** First retained request observed for this build in the day or bucket. */
    firstObservedAt: string;
};
export type UsageDayTool = {
    id: string;
    requests: number;
    results: number;
    errors: number;
    /** Absent when no SHA-bearing build identity was retained. */
    builds?: {
        items: UsageToolBuildObservation[];
        omitted?: { count: number; requests: number; results: number; errors: number };
    };
};
export type UsageExecutionOutcome = 'succeeded' | 'failed' | 'cancelled' | 'incomplete';
export type UsageTimelineEvent = {
    id: string;
    startedAt: string;
    outcome: UsageExecutionOutcome;
    durationMs: number | null;
} & ({
    kind: 'model';
    /** Opaque per-session correlation key shared by replay attempts. */
    callId: string;
    label: string;
    provider: 'firstParty' | 'bedrock' | 'vertex' | 'foundry' | 'openai';
    mode: 'streaming' | 'non_streaming';
    attempt: number;
    firstTextMs: number | null;
} | {
    kind: 'tool';
    label: string;
});
export type UsageSessionTimeline = {
    state: 'available' | 'truncated' | 'unavailable';
    omitted: number;
    items: UsageTimelineEvent[];
};
export type UsageDurationSummary = {
    samples: number;
    p50Ms: number | null;
    p95Ms: number | null;
};
export type UsageTimingOutcomes = {
    started: number;
    succeeded: number;
    failed: number;
    cancelled: number;
    incomplete: number;
};
export type UsageTimingSummary = {
    models: {
        state: 'available' | 'unavailable';
        logicalCalls: number;
        retriedCalls: number;
        streamingAttempts: number;
        outcomes: UsageTimingOutcomes;
        responseDuration: UsageDurationSummary;
        firstText: UsageDurationSummary;
    };
    tools: {
        state: 'available' | 'unavailable';
        outcomes: UsageTimingOutcomes;
        duration: UsageDurationSummary;
    };
};
export type UsageSessionContributor = {
    id: string;
    engineSessionId: string | null;
    project: { id: string; label: string } | null;
    tokens: UsageTokens;
    requests: number;
    results: number;
    errors: number;
    /** Exact ranks across every contributor in the UTC day. */
    rank?: { tokens: number; requests: number; errors: number };
    /** Required on validated snapshots; optional only for pre-grouping callers. */
    tokenCost?: UsageTokenCostEstimate;
    models: UsageModel[];
    modelDetail: { state: 'full' | 'grouped'; omitted: number };
    timeline: UsageSessionTimeline;
};
export type UsageDayContributors = {
    state: 'full' | 'truncated' | 'unavailable';
    omitted: number;
    items: UsageSessionContributor[];
};
export type UsageDay = {
    hourlyRequests: number[];
    /** Exclusive token totals per UTC hour, supplied only for the seven-day window. */
    hourlyTokens?: number[];
    /** Recorded outcomes matched to requests in this day or bucket. */
    results: number;
    errors: number;
    /** Per-tool outcomes attributed to request time, after range-wide grouping. */
    tools: UsageDayTool[];
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
/** Bounded accounting for the equal elapsed UTC interval immediately before a recent range. */
export type UsagePreviousPeriod = {
    startInclusive: string;
    endInclusive: string;
    tokens: UsageTokens;
    sessions: number;
    records: number;
    requests: number;
    activeDays: number;
    cachedInputShare: number | null;
};
export type UsageRangeSummary = {
    range: UsageWindow;
    /** All uses sparse UTC buckets; absent means one calendar day. */
    bucketDays?: number;
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
    /** Omitted when retained history cannot establish a complete prior interval. */
    previousPeriod?: UsagePreviousPeriod;
    cacheWriteReporting: 'reported' | 'partial' | 'unreported' | 'unavailable';
    days: UsageDay[];
    models: UsageModel[];
    tools: UsageTool[];
    timing: UsageTimingSummary;
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
    invalidTimings: number;
    identityConflicts: number;
};
export type UsageDashboardSnapshot = {
    version: 1;
    metricVersion: 1;
    countingVersion: 8;
    pricingVersion: 1;
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
