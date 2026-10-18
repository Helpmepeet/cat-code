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
            result = await collectUsageDashboard({ onDiagnostic: reportDiagnostic });
        }
    }
    catch (error) {
        reportDiagnostic(usageDiagnosticFromError(error, Date.now() - startedAt));
        result = { type: 'error', version: 1, code: 'collection' };
    }
    if (!scanForSecrets(result).ok)
        result = { type: 'error', version: 1, code: 'invalid-output' };
    await emitWorkerRecord(result, MAX_USAGE_RECORD_BYTES, 'usage result');
    process.exit(0);
});
