import { expect, test } from 'bun:test';
import { collectUsageDashboard } from './statsDomain.js';
import { UsageFailure, USAGE_FAILURE_REASONS } from '../../src/utils/statsFailure.js';
import { UsageResourceError } from '../../src/utils/statsUsage.js';
import type { UsageDiagnostic } from '../shared/usageDiagnostic.js';

const failing = (error: unknown) => (async () => { throw error; }) as never;
const collect = async (error: unknown, onDiagnostic?: (d: UsageDiagnostic) => void) => collectUsageDashboard({ aggregate: failing(error), onDiagnostic });

test('typed causes map to the public code, regardless of message text', async () => {
    const expected = { 'discovery-limit': 'resource-limit', 'state-budget': 'resource-limit', 'storage-capacity': 'resource-limit', deadline: 'timeout', 'storage-failure': 'collection', unexpected: 'collection' } as const;
    for (const reason of USAGE_FAILURE_REASONS) {
        const seen: UsageDiagnostic[] = [];
        // Misleading text proves classification no longer reads error messages.
        const result = await collect(new UsageFailure('totally unrelated words', reason, 'index'), d => seen.push(d));
        expect(result).toEqual({ type: 'error', version: 1, code: expected[reason] });
        expect(seen).toHaveLength(1);
        expect(seen[0]).toMatchObject({ reason, phase: 'index' });
    }
});

test('untyped errors are collection failures even when the message mentions a limit or timeout', async () => {
    for (const message of ['Usage discovery resource limit', 'Usage collection timeout', 'operation timeout']) {
        const seen: UsageDiagnostic[] = [];
        await expect(collect(new Error(message), d => seen.push(d))).resolves.toEqual({ type: 'error', version: 1, code: 'collection' });
        expect(seen[0]).toMatchObject({ reason: 'unexpected', phase: 'unknown' });
    }
});

test('collector guards report which budget and the observed value against its limit', async () => {
    const seen: UsageDiagnostic[] = [];
    await collect(new UsageResourceError('Usage state budget exceeded', { guard: 'state-entries', observed: 250_001, limit: 250_000 }), d => seen.push(d));
    expect(seen[0]).toMatchObject({ reason: 'state-budget', guard: 'state-entries', observed: 250_001, limit: 250_000 });
});

test('a throwing diagnostic sink never changes the result', async () => {
    await expect(collect(new UsageFailure('x', 'deadline', 'replay'), () => { throw new Error('sink down'); })).resolves.toEqual({ type: 'error', version: 1, code: 'timeout' });
});

test('an invalid aggregate emits one bounded diagnostic without including the invalid snapshot', async () => {
    const seen: UsageDiagnostic[] = [];
    const aggregate = (async () => ({ private: '/private/transcript/body' })) as never;
    await expect(collectUsageDashboard({ aggregate, onDiagnostic: d => seen.push(d) })).resolves.toEqual({ type: 'error', version: 1, code: 'invalid-output' });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ reason: 'unexpected', phase: 'finalize' });
    expect(JSON.stringify(seen)).not.toContain('/private');
    await expect(collectUsageDashboard({ aggregate, onDiagnostic() { throw new Error('sink down'); } })).resolves.toEqual({ type: 'error', version: 1, code: 'invalid-output' });
});
