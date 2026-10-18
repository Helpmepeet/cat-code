// Must precede dynamic engine imports: observation never initializes account refresh.
process.env.CLAUDE_CODE_SIMPLE = '1';
import { MAX_USAGE_RECORD_BYTES, type UsageCollectionResult } from '../shared/usageDashboard.js';
import { scanForSecrets } from '../shared/secretGuard.js';
import { formatUsageDiagnostic, usageDiagnosticFromError, type UsageDiagnostic } from '../shared/usageDiagnostic.js';
import { bootstrapWorkerEngine, emitWorkerRecord, runDisposableWorker } from './workerRuntime.js';
// One tagged line per failed refresh; main parses it through the bounded stderr collector.
function reportDiagnostic(diagnostic: UsageDiagnostic): void {
    try {
        process.stderr.write(`${formatUsageDiagnostic(diagnostic)}\n`);
    }
    catch { /* A broken stderr must not alter the stdout result. */ }
}
runDisposableWorker('usage-worker', async () => {
    const startedAt = Date.now();
    let reported = false;
    const reportFailure = (diagnostic: UsageDiagnostic) => {
        if (reported) return;
        reported = true;
        reportDiagnostic(diagnostic);
    };
    let result: UsageCollectionResult;
    try {
        if (process.argv.includes('--cached')) {
            const { readSavedUsage } = await import('../../src/utils/statsUsageIndex.js');
            const { parseUsageCollectionResult } = await import('../shared/usageStatsWorker.js');
            const snapshot = readSavedUsage();
            result = snapshot?.timezone === Intl.DateTimeFormat().resolvedOptions().timeZone
                ? parseUsageCollectionResult({ type: 'usage', version: 1, snapshot }) ?? { type: 'error', version: 1, code: 'unavailable' }
                : { type: 'error', version: 1, code: 'unavailable' };
        } else {
            await bootstrapWorkerEngine();
            const { collectUsageDashboard } = await import('./statsDomain.js');
            result = await collectUsageDashboard({ onDiagnostic: reportFailure });
        }
    }
    catch (error) {
        reportFailure(usageDiagnosticFromError(error, Date.now() - startedAt));
        result = { type: 'error', version: 1, code: 'collection' };
    }
    if (!scanForSecrets(result).ok) {
        result = { type: 'error', version: 1, code: 'invalid-output' };
        reportFailure({ reason: 'unexpected', phase: 'finalize', elapsedMs: Date.now() - startedAt });
    }
    if (result.type === 'error')
        reportFailure({ reason: 'unexpected', phase: 'unknown', elapsedMs: Date.now() - startedAt });
    try { await emitWorkerRecord(result, MAX_USAGE_RECORD_BYTES, 'usage result'); }
    catch (error) {
        reportFailure(usageDiagnosticFromError(error, Date.now() - startedAt));
        throw error;
    }
    process.exit(0);
});
