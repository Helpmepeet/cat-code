import { runAccountsPoolWorker, createAccountsPoolPublicationGate } from '../main/accountsPoolRunner.js';
import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runUsageStatsWorker } from '../main/usageStatsRunner.js';
test('D1/V1: cold usage worker reads retained history with broken account storage and no chat', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usage-worker-'));
    try {
        const project = join(root, 'config', 'projects', 'fixture');
        await mkdir(project, { recursive: true });
        await mkdir(join(root, 'home'), { recursive: true });
        // Deliberately unusable account state. This process must not load or refresh it.
        await writeFile(join(root, 'config', 'accounts.json'), '{invalid');
        await writeFile(join(project, 's.jsonl'), JSON.stringify({ type: 'assistant', sessionId: 's', uuid: 'r', timestamp: new Date().toISOString(), message: { id: 'a', model: 'fixture', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 20 }, content: [{ type: 'tool_use', id: 't', name: 'Bash' }] } }) + '\n');
        // Inject an account-worker import failure through its real runner. Its
        // result and generation cannot gate the independent usage process.
        const accountGate = createAccountsPoolPublicationGate();
        const accountFailure = runAccountsPoolWorker({
            command: process.execPath, args: ['-e', 'throw new Error("injected account import failure")'],
            cwd: root, onPool: () => { throw new Error('unexpected account callback') },
        }).catch(() => 'failed');
        accountGate.invalidate();
        const start = performance.now();
        const result = await runUsageStatsWorker({ command: process.execPath, args: ['run', join(import.meta.dir, 'usageStatsWorker.ts'), '--bare'], cwd: join(import.meta.dir, '../..'), env: { HOME: join(root, 'home'), CLAUDE_CONFIG_DIR: join(root, 'config'), CLAUDE_CODE_SIMPLE: '1', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', CODEX_HOME: join(root, 'home', 'codex') }, timeoutMs: 30000 });
        expect(await accountFailure).toBe('failed');
        expect(result.type).toBe('usage');
        if (result.type === 'usage') {
            expect(result.snapshot.ranges['7d'].tokens).toEqual({ fresh: 10, read: 20, write: 0, output: 5 });
            expect(result.snapshot.ranges['7d'].requests).toBe(1);
            expect(result.snapshot.coverage.state).toBe('complete');
        }
        console.info(`usage fixture cold worker: ${Math.round(performance.now() - start)} ms`);
        await rm(project, { recursive: true, force: true });
        const cachedStart = performance.now();
        const cached = await runUsageStatsWorker({ command: process.execPath, args: ['run', join(import.meta.dir, 'usageStatsWorker.ts'), '--bare', '--cached'], cwd: join(import.meta.dir, '../..'), env: { HOME: join(root, 'home'), CLAUDE_CONFIG_DIR: join(root, 'config'), CLAUDE_CODE_SIMPLE: '1' }, timeoutMs: 5000 });
        expect(cached).toEqual(result);
        console.info(`usage saved worker: ${Math.round(performance.now() - cachedStart)} ms`);
        const otherTimezone = result.type === 'usage' && result.snapshot.timezone === 'Pacific/Honolulu' ? 'UTC' : 'Pacific/Honolulu';
        const changedZone = await runUsageStatsWorker({ command: process.execPath, args: ['run', join(import.meta.dir, 'usageStatsWorker.ts'), '--bare', '--cached'], cwd: join(import.meta.dir, '../..'), env: { HOME: join(root, 'home'), CLAUDE_CONFIG_DIR: join(root, 'config'), CLAUDE_CODE_SIMPLE: '1', TZ: otherTimezone }, timeoutMs: 5000 });
        expect(changedZone).toEqual({ type: 'error', version: 1, code: 'unavailable' });
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
}, 40000);
