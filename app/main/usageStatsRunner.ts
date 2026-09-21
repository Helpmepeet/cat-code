import type { spawn } from 'node:child_process';
import { MAX_USAGE_RECORD_BYTES, type UsageCollectionResult, type UsageDashboardSnapshot } from '../shared/usageDashboard.js';
import { parseUsageCollectionLine } from '../shared/usageStatsWorker.js';
import { scanForSecrets } from '../shared/secretGuard.js';
import { runNdjsonWorker, type WorkerProcessLifecycle } from './ndjsonWorker.js';
export const USAGE_REFRESH_INTERVAL_MS = 5 * 60000;
export const USAGE_WORKER_TIMEOUT_MS = 125000;

/**
 * The retained-history dashboard is production-ready and enabled by default.
 * Keep one explicit off switch so an operator can stop the independent worker
 * without changing account or transcript state.
 */
export function isUsageDashboardEnabled(value = process.env.CATCODE_USAGE_DASHBOARD): boolean {
    return value !== '0';
}

export type UsageRunOptions = {
    command: string;
    args: string[];
    cwd: string;
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    timeoutMs?: number;
    spawnWorker?: typeof spawn;
    onWorkerLifecycle?: (event: WorkerProcessLifecycle) => void;
};
/** Exactly one bounded record, accepted only after a clean process exit. */
export async function runUsageStatsWorker(options: UsageRunOptions): Promise<UsageCollectionResult> {
    let accepted: UsageCollectionResult | null = null, seen = false, invalid = false;
    try {
        const outcome = await runNdjsonWorker({ ...options, timeoutMs: options.timeoutMs ?? USAGE_WORKER_TIMEOUT_MS, maxRecordBytes: MAX_USAGE_RECORD_BYTES, forceKillOnAbort: true, escalateKillAfterMs: 2000,
            onOversizeRecord: () => { invalid = true; },
            onRecord: line => {
                if (seen) {
                    invalid = true;
                    return 'stop';
                }
                seen = true;
                const parsed = parseUsageCollectionLine(line.toString('utf8'));
                if (!parsed || !scanForSecrets(parsed).ok) {
                    invalid = true;
                    return 'stop';
                }
                accepted = parsed;
                return 'continue';
            },
        });
        if (outcome.timedOut)
            return { type: 'error', version: 1, code: 'timeout' };
        if (outcome.aborted || outcome.code !== 0 || outcome.stdinError || outcome.trailingBytes || !seen || invalid || !accepted)
            return { type: 'error', version: 1, code: 'invalid-output' };
        return accepted;
    }
    catch {
        return { type: 'error', version: 1, code: 'collection' };
    }
}
/** Independent generation and retained result; account operations cannot invalidate it. */
export function createUsagePublication() {
    let generation = 0;
    let lastGood: UsageDashboardSnapshot | null = null;
    let latest: UsageCollectionResult = { type: 'error', version: 1, code: 'unavailable' };
    return {
        begin: () => ++generation,
        invalidate: () => { generation++; },
        accept(candidate: number, result: UsageCollectionResult): boolean {
            if (candidate !== generation)
                return false;
            if (result.type === 'usage') {
                if (lastGood && Date.parse(result.snapshot.asOf) < Date.parse(lastGood.asOf))
                    return false;
                lastGood = result.snapshot;
            }
            latest = result;
            return true;
        },
        replay: (): UsageCollectionResult[] => lastGood && latest.type === 'error' ? [{ type: 'usage', version: 1, snapshot: lastGood }, latest] : [latest],
    };
}
