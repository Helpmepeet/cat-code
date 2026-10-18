import { collectRetainedUsage } from './statsUsage.js';
import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, writeFile, rm, open, appendFile, rename, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { oversizedToolResultPrefix, readStatsRecords, STATS_RECORD_BYTES, type StatsCheckpoint } from './statsReader.js';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true }); });
async function file(text: string) { const dir = await mkdtemp(join(tmpdir(), 'usage-reader-')); roots.push(dir); const path = join(dir, 's.jsonl'); await writeFile(path, text); return path; }
test('validated continuation projects only the appended region with original byte offsets and generation', async () => {
    const prefix = '{"name":"模型"}\n{"ok":1}\n';
    const path = await file(prefix);
    let checkpoint: StatsCheckpoint | null = null;
    await readStatsRecords(path, () => {}, { onCheckpoint: value => { checkpoint = value; } });
    expect(checkpoint).not.toBeNull();
    await appendFile(path, '{"ok":2}\n');
    const rows: { value: unknown; offset: number; generation: string }[] = [];
    let reset = false, continued = false;
    await readStatsRecords(path, row => { rows.push(row); }, { chunkBytes: 3, continuation: checkpoint!,
        onReset: () => { reset = true; }, onCheckpoint: (_value, used) => { continued = used; } });
    expect(reset).toBe(false);
    expect(continued).toBe(true);
    expect(rows).toEqual([{ value: { ok: 2 }, offset: Buffer.byteLength(prefix), generation: checkpoint!.generation }]);
});
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
test('oversized user tool-result line is classified apart from unknown oversized loss', async () => {
    const image = 'A'.repeat(STATS_RECORD_BYTES + 1024);
    const toolResult = { parentUuid: 'p', isSidechain: false, type: 'user', message: { role: 'user', content: [{ tool_use_id: 'toolu_1', type: 'tool_result', content: [{ type: 'image', source: { data: image } }] }] }, uuid: 'u', timestamp: '2026-10-16T18:14:51.107Z', sessionId: 's' };
    const assistant = { type: 'assistant', message: { id: 'm', content: [{ type: 'text', text: image }], usage: { input_tokens: 1, output_tokens: 1 } } };
    const path = await file(`${JSON.stringify(toolResult)}\n${JSON.stringify(assistant)}\n{"ok":1}\n`);
    const rows: unknown[] = [];
    const q = await readStatsRecords(path, r => { rows.push(r.value); });
    expect(q.oversizedToolResults).toBe(1);
    expect(q.oversizedRecords).toBe(1);
    expect(rows).toEqual([{ ok: 1 }]);
});
test('oversized prefix classification proves a user record of only tool results', () => {
    const user = (content: string, before = '"type":"user",', after = '') => `{"parentUuid":"p",${before}"message":{"role":"user","content":${content}}${after}`;
    expect(oversizedToolResultPrefix(user('[{"tool_use_id":"t","type":"tool_result","content":[{"type":"image","source":{"data":"AAAA'))).toBe(true);
    expect(oversizedToolResultPrefix(user('[{"type":"tool_result","tool_use_id":"a","content":"x"},{"type":"tool_result","tool_use_id":"b","content":"y'))).toBe(true);
    expect(oversizedToolResultPrefix(user('[{"type":"tool_result","content":"x"},{"type":"text","text":"y'))).toBe(false);
    expect(oversizedToolResultPrefix(user('[{"type":"text","text":"hello'))).toBe(false);
    expect(oversizedToolResultPrefix(user('"plain prompt text'))).toBe(false);
    expect(oversizedToolResultPrefix(user('[{"content":"x'))).toBe(false);
    expect(oversizedToolResultPrefix(user('[{"type":"tool_result","content":"x', ''))).toBe(false);
    expect(oversizedToolResultPrefix(user('[{"type":"tool_result","content":"x', '"type":"assistant",'))).toBe(false);
    expect(oversizedToolResultPrefix('{"message":{"content":[{"type":"tool_result","content":"x"}]},"type":"user","uuid":"u')).toBe(true);
    expect(oversizedToolResultPrefix('{"message":{"content":[{"type":"tool_result","content":"x')).toBe(false);
    expect(oversizedToolResultPrefix('{"type":"user","nested":{"message":{"content":[{"type":"tool_result","content":"x')).toBe(false);
    expect(oversizedToolResultPrefix('{"type":"us')).toBe(false);
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
