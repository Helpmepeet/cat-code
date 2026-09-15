import { collectRetainedUsage } from './statsUsage.js';
import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, writeFile, rm, open, appendFile, rename, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readStatsRecords } from './statsReader.js';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true }); });
async function file(text: string) { const dir = await mkdtemp(join(tmpdir(), 'usage-reader-')); roots.push(dir); const path = join(dir, 's.jsonl'); await writeFile(path, text); return path; }
test('C2/C3: malformed middle/end, split UTF8, valid final record and pending tail are explicit', async () => {
    const path = await file('{"name":"模型"}\nbroken\n{"ok":2}');
    const rows: unknown[] = [];
    const quality = await readStatsRecords(path, record => { rows.push(record.value); }, { chunkBytes: 3 });
    expect(rows).toEqual([{ name: '模型' }, { ok: 2 }]);
    expect(quality.parseErrors).toBe(1);
    expect(quality.pendingTailBytes).toBe(0);
    await writeFile(path, '{"ok":1}\n{"unfinished":');
    const pending = await readStatsRecords(path, () => { });
    expect(pending.pendingTailBytes).toBeGreaterThan(0);
    await writeFile(path, '{"ok":1}\ninvalid\n');
    expect((await readStatsRecords(path, () => { })).parseErrors).toBe(1);
});
test('C3: oversized record is skipped with loss and reading resumes', async () => {
    const path = await file(JSON.stringify({ huge: 'x'.repeat(200) }) + '\n{"ok":1}\n');
    const rows: unknown[] = [];
    const q = await readStatsRecords(path, r => { rows.push(r.value); }, { maxRecordBytes: 64, chunkBytes: 16 });
    expect(q.oversizedRecords).toBe(1);
    expect(rows).toEqual([{ ok: 1 }]);
});
test('T3: captures boundary before appends; rescans from zero', async () => {
    const path = await file('{"ok":1}\n');
    const rows: unknown[] = [];
    await readStatsRecords(path, async (r) => { rows.push(r.value); await appendFile(path, '{"ok":2}\n'); });
    expect(rows).toEqual([{ ok: 1 }]);
    const next: unknown[] = [];
    await readStatsRecords(path, r => { next.push(r.value); });
    expect(next).toHaveLength(2);
});
test('C3: replacement and truncation are visible', async () => {
    const path = await file('{"ok":1}\n{"ok":2}\n');
    let changed = false;
    const q = await readStatsRecords(path, async () => { if (!changed) {
        changed = true;
        await rename(path, path + '.old');
        await writeFile(path, '{}\n');
    } }, { chunkBytes: 9 });
    expect(q.changedSources).toBe(1);
    await writeFile(path, '{"ok":1}\n{"ok":2}\n');
    const short = await readStatsRecords(path, async () => { await truncate(path, 0); }, { chunkBytes: 9 });
    expect(short.shortReads).toBe(1);
    expect(short.changedSources).toBe(1);
});
test('C1: reads from byte zero through a generated transcript larger than 100 MiB', async () => {
    const event = (id: string) => ({ type: 'assistant', sessionId: 's', uuid: id, timestamp: new Date().toISOString(), message: { id, model: 'fixture', usage: { input_tokens: 50 } } });
    const first = event('first'), last = event('last');
    const path = await file(JSON.stringify(first) + '\n');
    const handle = await open(path, 'a');
    const block = ' '.repeat(1024 * 1024 - 1) + '\n';
    try {
        for (let i = 0; i < 101; i++)
            await handle.write(block);
        await handle.write(JSON.stringify(last) + '\n');
    }
    finally {
        await handle.close();
    }
    const rows: unknown[] = [];
    const q = await readStatsRecords(path, r => { rows.push(r.value); });
    expect(rows).toEqual([first, last]);
    const snapshot = await collectRetainedUsage([path], new Date().toISOString());
    expect(snapshot.ranges['7d'].tokens.fresh).toBe(100);
    expect(snapshot.coverage.state).toBe('complete');
    expect(q.bytesRead).toBeGreaterThan(100 * 1024 * 1024);
    expect(q.parseErrors).toBe(0);
}, 30000);
