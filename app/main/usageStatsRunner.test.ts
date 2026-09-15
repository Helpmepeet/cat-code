import { createAccountsPoolPublicationGate } from './accountsPoolRunner.js';
import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { spawn } from 'node:child_process';
import { runUsageStatsWorker, createUsagePublication } from './usageStatsRunner.js';
function fakeSpawn(config: {
    stdout?: string;
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
        if (config.autoClose !== false)
            setTimeout(() => { if (config.emitError)
                return c.emit('error', config.emitError); if (config.stdout !== undefined)
                c.stdout.emit('data', Buffer.from(config.stdout)); c.exitCode = config.exitCode ?? 0; c.emit('close', c.exitCode, null); }, 0);
        return c;
    }) as unknown) as typeof spawn;
}
const err = (code: 'collection' | 'timeout' | 'resource-limit' | 'invalid-output' | 'unavailable' = 'collection') => ({ type: 'error' as const, version: 1 as const, code });
const line = (x: unknown) => `${JSON.stringify(x)}\n`;
const run = (config: Parameters<typeof fakeSpawn>[0], extra: Record<string, unknown> = {}) => runUsageStatsWorker({ command: 'bun', args: [], cwd: process.cwd(), spawnWorker: fakeSpawn(config), ...(extra as any) });
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
