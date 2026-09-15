// Must precede dynamic engine imports: observation never initializes account refresh.
process.env.CLAUDE_CODE_SIMPLE = '1';
import { MAX_USAGE_RECORD_BYTES, type UsageCollectionResult } from '../shared/usageDashboard.js';
import { scanForSecrets } from '../shared/secretGuard.js';
import { bootstrapWorkerEngine, emitWorkerRecord, runDisposableWorker } from './workerRuntime.js';
runDisposableWorker('usage-worker', async () => {
    let result: UsageCollectionResult;
    try {
        if (process.argv.includes('--cached')) {
            const { readSavedUsage } = await import('../../src/utils/statsUsageIndex.js');
            const { parseUsageCollectionResult } = await import('../shared/usageStatsWorker.js');
            const snapshot = readSavedUsage();
            result = parseUsageCollectionResult({ type: 'usage', version: 1, snapshot }) ?? { type: 'error', version: 1, code: 'unavailable' };
        } else {
            await bootstrapWorkerEngine();
            const { collectUsageDashboard } = await import('./statsDomain.js');
            result = await collectUsageDashboard();
        }
    }
    catch {
        result = { type: 'error', version: 1, code: 'collection' };
    }
    if (!scanForSecrets(result).ok)
        result = { type: 'error', version: 1, code: 'invalid-output' };
    await emitWorkerRecord(result, MAX_USAGE_RECORD_BYTES, 'usage result');
    process.exit(0);
});
