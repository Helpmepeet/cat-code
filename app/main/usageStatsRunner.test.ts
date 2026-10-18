import { createAccountsPoolPublicationGate } from './accountsPoolRunner.js';
import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { spawn } from 'node:child_process';
import { runUsageStatsWorker, createUsagePublication, isUsageDashboardEnabled } from './usageStatsRunner.js';
import { formatUsageDiagnostic, USAGE_DIAGNOSTIC_TAG, type UsageDiagnostic } from '../shared/usageDiagnostic.js';
function fakeSpawn(config: {
    stdout?: string;
    stderr?: string;
    /** Emitted at spawn, so a worker can explain itself and then hang. */
    earlyStderr?: string;
    exitCode?: number;
    emitError?: Error;
    autoClose?: boolean;
    onKill?: (s: NodeJS.Signals) => void;
}): typeof spawn {
    return ((() => {
        const c = new EventEmitter() as any;
        c.exitCode = null;
        c.signalCode = null;
        c.stdout = new EventEmitter();
        c.stderr = new EventEmitter();
        c.stdin = new EventEmitter();
        c.stdin.end = () => { };
        c.kill = (s: NodeJS.Signals = 'SIGTERM') => { config.onKill?.(s); c.signalCode = s; if (s === 'SIGKILL')
            c.emit('close', null, s); return true; };
        if (config.earlyStderr !== undefined)
            setTimeout(() => c.stderr.emit('data', Buffer.from(config.earlyStderr!)), 0);
        if (config.autoClose !== false)
            setTimeout(() => { if (config.emitError)
                return c.emit('error', config.emitError); if (config.stderr !== undefined)
                c.stderr.emit('data', Buffer.from(config.stderr)); if (config.stdout !== undefined)
                c.stdout.emit('data', Buffer.from(config.stdout)); c.exitCode = config.exitCode ?? 0; c.emit('close', c.exitCode, null); }, 0);
        return c;
    }) as unknown) as typeof spawn;
}
const err = (code: 'collection' | 'timeout' | 'resource-limit' | 'invalid-output' | 'unavailable' = 'collection') => ({ type: 'error' as const, version: 1 as const, code });
const line = (x: unknown) => `${JSON.stringify(x)}\n`;
const run = (config: Parameters<typeof fakeSpawn>[0], extra: Record<string, unknown> = {}) => runUsageStatsWorker({ command: 'bun', args: [], cwd: process.cwd(), spawnWorker: fakeSpawn(config), ...(extra as any) });

test('usage dashboard is enabled by default and retains an explicit rollback switch', () => {
    expect(isUsageDashboardEnabled(undefined)).toBe(true);
    expect(isUsageDashboardEnabled('1')).toBe(true);
    expect(isUsageDashboardEnabled('0')).toBe(false);
});

describe('runUsageStatsWorker boundary', () => {
    test('delivers one valid result only after clean exit', async () => {
        await expect(run({ stdout: line(err('unavailable')) })).resolves.toEqual(err('unavailable'));
        await expect(run({ stdout: line(err('unavailable')), exitCode: 1 })).resolves.toEqual(err('invalid-output'));
    });
    test('rejects malformed, secret, duplicate, trailing, and oversized output', async () => {
        await expect(run({ stdout: '{bad}\n' })).resolves.toEqual(err('invalid-output'));
        await expect(run({ stdout: line({ type: 'error', version: 1, code: 'collection', secret: 'token' }) })).resolves.toEqual(err('invalid-output'));
        await expect(run({ stdout: line(err()) + line(err()) })).resolves.toEqual(err('invalid-output'));
        await expect(run({ stdout: JSON.stringify(err()) })).resolves.toEqual(err('invalid-output'));
        await expect(run({ stdout: line({ type: 'error', version: 1, code: 'collection' }) + 'x'.repeat(256 * 1024) })).resolves.toEqual(err('invalid-output'));
    });
    test('timeout and abort terminate the worker; spawn errors are typed', async () => {
        const killed: NodeJS.Signals[] = [];
        await expect(run({ autoClose: false, onKill: s => killed.push(s) }, { timeoutMs: 5 })).resolves.toEqual(err('timeout'));
        expect(killed.length).toBeGreaterThan(0);
        const controller = new AbortController();
        const pending = run({ autoClose: false, onKill: s => killed.push(s) }, { signal: controller.signal });
        controller.abort();
        await expect(pending).resolves.toEqual(err('invalid-output'));
        await expect(run({ emitError: new Error('spawn failed') })).resolves.toEqual(err('collection'));
    });
});
describe('worker diagnostics', () => {
    const diagnostic: UsageDiagnostic = { reason: 'state-budget', phase: 'replay', elapsedMs: 900, guard: 'state-bytes', observed: 70_000_000, limit: 67_108_864 };
    const collect = async (config: Parameters<typeof fakeSpawn>[0], extra: Record<string, unknown> = {}) => {
        const seen: UsageDiagnostic[] = [];
        const result = await run(config, { onDiagnostic: (d: UsageDiagnostic) => seen.push(d), ...extra });
        return { result, seen };
    };
    test('a tagged stderr line is delivered once while the strict stdout result is unchanged', async () => {
        const { result, seen } = await collect({ stderr: `warming up\n${formatUsageDiagnostic(diagnostic)}\n`, stdout: line(err('resource-limit')) });
        expect(result).toEqual(err('resource-limit'));
        expect(seen).toEqual([diagnostic]);
    });
    test('only the first valid diagnostic is reported for one failed run', async () => {
        const second: UsageDiagnostic = { reason: 'deadline', phase: 'index', elapsedMs: 5 };
        const { seen } = await collect({ stderr: `${formatUsageDiagnostic(diagnostic)}\n${formatUsageDiagnostic(second)}\n`, stdout: line(err('resource-limit')) });
        expect(seen).toEqual([diagnostic]);
    });
    test('malformed, unrelated, widened and oversized stderr is ignored in favor of a safe fallback', async () => {
        for (const stderr of ['fatal: boom', `${USAGE_DIAGNOSTIC_TAG} {bad`, `${USAGE_DIAGNOSTIC_TAG} ${JSON.stringify({ v: 1, ...diagnostic, path: '/Users/me/x' })}`, `${USAGE_DIAGNOSTIC_TAG} ${'x'.repeat(100_000)}\n`]) {
            const { result, seen } = await collect({ stderr, stdout: line(err('collection')) });
            expect(result).toEqual(err('collection'));
            expect(seen).toHaveLength(1);
            expect(seen[0]).toMatchObject({ reason: 'unexpected', phase: 'unknown' });
            expect(JSON.stringify(seen)).not.toContain(stderr);
        }
    });
    test('every unexplained error gets one diagnostic, including nonzero exit and broken stdout', async () => {
        for (const config of [
            { stdout: line(err('collection')) },
            { stdout: line(err('invalid-output')) },
            { stdout: '{bad}\n' },
            { stdout: line(err()), exitCode: 1 },
            { exitCode: 1 },
            { emitError: new Error('spawn failed /private/path') },
        ]) {
            const { result, seen } = await collect(config);
            expect(result.type).toBe('error');
            expect(seen).toHaveLength(1);
            expect(seen[0]).toMatchObject({ reason: 'unexpected', phase: 'unknown' });
            expect(JSON.stringify(seen)).not.toContain('/private');
        }
    });
    test('a throwing sink cannot change any result', async () => {
        const throwing = { onDiagnostic: () => { throw new Error('operational log down'); } };
        await expect(run({ stderr: `${formatUsageDiagnostic(diagnostic)}\n`, stdout: line(err('resource-limit')) }, throwing)).resolves.toEqual(err('resource-limit'));
        await expect(run({ autoClose: false }, { ...throwing, timeoutMs: 5 })).resolves.toEqual(err('timeout'));
    });
    test('a parent kill reports a deadline with an unknown phase, unless the worker already explained itself', async () => {
        const killed = await collect({ autoClose: false }, { timeoutMs: 5 });
        expect(killed.result).toEqual(err('timeout'));
        expect(killed.seen).toHaveLength(1);
        expect(killed.seen[0]).toMatchObject({ reason: 'deadline', phase: 'unknown' });
        const explained = await collect({ autoClose: false, earlyStderr: `${formatUsageDiagnostic(diagnostic)}\n` }, { timeoutMs: 5 });
        expect(explained.result).toEqual(err('timeout'));
        expect(explained.seen).toEqual([diagnostic]);
    });
    test('a diagnostic is never reported for a successful result', async () => {
        const { result, seen } = await collect({ stdout: line({ type: 'usage', version: 1, snapshot: await (await import('../../src/utils/statsUsage.js')).collectRetainedUsage([], new Date().toISOString()) }), stderr: `${formatUsageDiagnostic(diagnostic)}\n` });
        expect(result.type).toBe('usage');
        expect(seen).toEqual([]);
    });
});
describe('createUsagePublication', () => {
    test('rejects superseded and older-asOf results, retaining last good through errors', () => {
        const p = createUsagePublication();
        const a = p.begin();
        const good: any = { type: 'usage', version: 1, snapshot: { asOf: '2026-09-13T00:00:00.000Z' } };
        const newer: any = { type: 'usage', version: 1, snapshot: { asOf: '2026-09-14T00:00:00.000Z' } };
        expect(p.accept(a, good)).toBe(true);
        expect(p.accept(p.begin(), err('collection') as any)).toBe(true);
        expect(p.replay()[0]).toEqual(good);
        expect(p.accept(a, newer)).toBe(false);
        expect(p.accept(p.begin(), newer)).toBe(true);
        expect(p.accept(p.begin(), good)).toBe(false);
    });
    test('account generation invalidation cannot invalidate usage', () => { const p = createUsagePublication(); const generation = p.begin(); const accounts = createAccountsPoolPublicationGate(); accounts.invalidate(); expect(p.accept(generation, { type: 'error', version: 1, code: 'collection' })).toBe(true); });
});

test('D2: a hung account driver and failed account callback do not consume usage delivery', async () => {
    const { createSingleFlightDriver } = await import('./singleFlightDriver.js');
    const { collectRetainedUsage } = await import('../../src/utils/statsUsage.js');
    const snapshot = await collectRetainedUsage([], new Date().toISOString());
    const delivered: string[] = [];
    const timer = () => ({ unref() {} }) as unknown as ReturnType<typeof setTimeout>;
    for (const accountRun of [() => new Promise<void>(() => {}), async () => { throw new Error('account callback failed'); }]) {
        const accounts = createSingleFlightDriver({ run: accountRun, intervalMs: 1000, logLabel: 'account-fixture', setTimer: timer, clearTimer() {} });
        const usage = createSingleFlightDriver({ run: async () => { const result = await run({ stdout: line({ type: 'usage', version: 1, snapshot }) }); delivered.push(result.type); }, intervalMs: 1000, logLabel: 'usage-fixture', setTimer: timer, clearTimer() {} });
        accounts.start(); usage.start();
        await new Promise(resolve => setTimeout(resolve, 20));
        accounts.stop(); usage.stop();
    }
    expect(delivered).toEqual(['usage', 'usage']);
});
