/**
 * Why a retained-history refresh failed, classified at the guard that failed.
 * Public result codes stay coarse; this vocabulary is for diagnostics only and
 * carries scalars, never paths, SQL, stacks, or session identifiers.
 */
export const USAGE_FAILURE_REASONS = ['discovery-limit', 'state-budget', 'storage-capacity', 'deadline', 'storage-failure', 'unexpected'] as const;
export const USAGE_FAILURE_PHASES = ['discovery', 'index', 'replay', 'finalize', 'unknown'] as const;
/** Which limit tripped, from a closed set. */
export const USAGE_FAILURE_GUARDS = [
    'sources', 'directory-entries', 'path-bytes',
    'state-entries', 'state-bytes', 'historical-results', 'historical-tools', 'counter-overflow',
    'index-pages', 'identity-pages',
] as const;
export type UsageFailureReason = (typeof USAGE_FAILURE_REASONS)[number];
export type UsageFailurePhase = (typeof USAGE_FAILURE_PHASES)[number];
export type UsageFailureGuard = (typeof USAGE_FAILURE_GUARDS)[number];
export type UsageFailureDetail = {
    guard?: UsageFailureGuard;
    observed?: number;
    limit?: number;
    sqliteCode?: string;
    /** Retained sources and indexed rows handled when it failed; sizes the history, not its content. */
    sources?: number;
    rows?: number;
};
export class UsageFailure extends Error {
    constructor(
        message: string,
        readonly reason: UsageFailureReason,
        readonly phase: UsageFailurePhase = 'unknown',
        readonly detail: UsageFailureDetail = {},
    ) {
        super(message);
    }
}
export const usageDeadlineFailure = (phase: UsageFailurePhase) => new UsageFailure('Usage collection timeout', 'deadline', phase);

const SQLITE_CODE = /^SQLITE_[A-Z0-9_]{1,40}$/;
/** The error's SQLite result name, only when it has the exact SQLITE_* shape. */
export function sqliteCodeOf(error: unknown): string | undefined {
    const code = error !== null && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
    return typeof code === 'string' && SQLITE_CODE.test(code) ? code : undefined;
}
/**
 * Capacity exhaustion is only SQLITE_FULL; every other SQLite code (I/O,
 * permission, busy, readonly) is a storage failure, not a full disk.
 */
export function classifyStorageError(error: unknown, phase: UsageFailurePhase, message: string, guard?: UsageFailureGuard): UsageFailure {
    if (error instanceof UsageFailure) return error;
    const sqliteCode = sqliteCodeOf(error);
    return sqliteCode === 'SQLITE_FULL'
        ? new UsageFailure(message, 'storage-capacity', phase, { sqliteCode, ...(guard ? { guard } : {}) })
        : new UsageFailure(message, 'storage-failure', phase, sqliteCode ? { sqliteCode } : {});
}
/** Wrap a raw SQLite error that escaped unclassified; leave everything else alone. */
export function classifyEscapedError(error: unknown, phase: UsageFailurePhase): unknown {
    if (error instanceof UsageFailure) return error;
    const sqliteCode = sqliteCodeOf(error);
    if (!sqliteCode) return error;
    return classifyStorageError(error, phase, sqliteCode === 'SQLITE_FULL' ? 'Usage index storage limit' : 'Usage index storage failure');
}
export function publicCodeForFailure(reason: UsageFailureReason): 'resource-limit' | 'timeout' | 'collection' {
    return reason === 'discovery-limit' || reason === 'state-budget' || reason === 'storage-capacity' ? 'resource-limit'
        : reason === 'deadline' ? 'timeout' : 'collection';
}
