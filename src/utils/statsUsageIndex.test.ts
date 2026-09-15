import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, writeFile, appendFile, rm, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { collectIndexedUsage, readSavedUsage } from './statsUsageIndex.js';
import { collectRetainedUsage, UsageResourceError } from './statsUsage.js';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const cutoff = '2026-09-13T12:00:00.000Z';
const row = (id: string, timestamp = cutoff, tokens = 10) => ({ type: 'assistant', sessionId: 's', uuid: id, timestamp, message: { id, model: 'model', usage: { input_tokens: tokens }, content: [{ type: 'text', text: 'DO NOT INDEX PROMPT TEXT' }, { type: 'tool_use', id, name: 'Bash', input: { secret: 'DO NOT INDEX TOOL INPUT' } }] } });
async function fixture() { const root = await mkdtemp(join(tmpdir(), 'usage-index-')); roots.push(root); return { path: join(root, 'cache.sqlite'), file: join(root, 's.jsonl') }; }
const opts = (path: string) => ({ path, deadline: Date.now() + 60000 });
test('cold accounting matches direct scan; warm restart reads no transcripts; changed files and deletion reconcile', async () => {
    const { path, file } = await fixture();
    const rows = [row('a', '2026-08-01T00:00:00.000Z'), row('a', cutoff, 20), row('b')];
    await writeFile(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
    const copy = file + '.copy'; await copyFile(file, copy);
    const files = [file, copy];
    const first = await collectIndexedUsage(files, cutoff, opts(path));
    const direct = await collectRetainedUsage(files, cutoff);
    expect(first.ranges).toEqual(direct.ranges);
    expect(first.coverage).toEqual(direct.coverage);
    expect(readSavedUsage(path)).toEqual(first);
    let reads = 0;
    const warm = await collectIndexedUsage(files, '2026-09-13T12:01:00.000Z', { ...opts(path), onReadSource: () => { reads++; } });
    expect(reads).toBe(0); expect(warm.ranges).toEqual(first.ranges);
    await appendFile(file, JSON.stringify(row('c')) + '\n');
    const updated = await collectIndexedUsage(files, cutoff, { ...opts(path), onReadSource: () => { reads++; } });
    expect(reads).toBe(1); expect(updated.ranges).toEqual((await collectRetainedUsage(files, cutoff)).ranges);
    const removed = await collectIndexedUsage([copy], cutoff, opts(path));
    expect(removed.ranges).toEqual((await collectRetainedUsage([copy], cutoff)).ranges);
});
test('future records and UTC rollover recalculate from index without rereading sources', async () => {
    const { path, file } = await fixture();
    await writeFile(file, JSON.stringify(row('future', '2026-09-13T13:00:00.000Z')));
    expect((await collectIndexedUsage([file], cutoff, opts(path))).ranges['7d'].tokens.fresh).toBe(0);
    let reads = 0;
    const options = { ...opts(path), onReadSource: () => { reads++; } };
    const later = await collectIndexedUsage([file], '2026-09-13T14:00:00.000Z', options);
    expect(reads).toBe(0); expect(later.ranges['7d'].tokens.fresh).toBe(10);
    const next = await collectIndexedUsage([file], '2026-09-21T00:00:00.000Z', options);
    expect(reads).toBe(0); expect(next.ranges['7d'].tokens.fresh).toBe(0);
    expect(next.ranges['30d'].tokens.fresh).toBe(10);
});
test('failed refresh rolls back and preserves the last committed snapshot', async () => {
    const { path, file } = await fixture(); await writeFile(file, JSON.stringify(row('a')));
    const first = await collectIndexedUsage([file], cutoff, opts(path));
    await appendFile(file, '\n' + JSON.stringify(row('b')));
    await expect(collectIndexedUsage([file], cutoff, { ...opts(path), onReadSource() { throw new UsageResourceError('injected failure'); } })).rejects.toThrow('injected failure');
    expect(readSavedUsage(path)).toEqual(first);
    expect((await collectIndexedUsage([file], cutoff, opts(path))).ranges['7d'].requests).toBe(2);
});
test('history beyond the old heap identity budget builds and then opens warm', async () => {
    const { path, file } = await fixture();
    const rows = Array.from({ length: 70000 }, (_, i) => JSON.stringify({ type: 'user', sessionId: 's', uuid: String(i) + 'x'.repeat(200), timestamp: cutoff }));
    await writeFile(file, rows.join('\n'));
    await expect(collectRetainedUsage([file], cutoff)).rejects.toBeInstanceOf(UsageResourceError);
    const first = await collectIndexedUsage([file], cutoff, opts(path));
    expect(first.coverage.state).toBe('complete'); expect(first.ranges['7d'].records).toBe(70000);
    let reads = 0;
    expect((await collectIndexedUsage([file], cutoff, { ...opts(path), onReadSource() { reads++; } })).ranges).toEqual(first.ranges);
    expect(reads).toBe(0);
}, 60000);
test('corrupt derived database is rebuilt without changing transcripts', async () => {
    const { path, file } = await fixture();
    const text = JSON.stringify(row('a')); await writeFile(file, text);
    await writeFile(path, 'broken sqlite');
    const result = await collectIndexedUsage([file], cutoff, opts(path));
    expect(result.ranges['7d'].requests).toBe(1);
    expect(await Bun.file(file).text()).toBe(text);
});
test('index excludes text and tool input, retaining missing-ID block positions', async () => {
    const { path, file } = await fixture();
    const r = row('a'); delete (r.message.content[1] as { id?: string }).id;
    await writeFile(file, JSON.stringify(r));
    const result = await collectIndexedUsage([file], cutoff, opts(path));
    expect(result.ranges).toEqual((await collectRetainedUsage([file], cutoff)).ranges);
    const { Database } = await import('bun:sqlite'); const db = new Database(path, { readonly: true });
    try { expect(JSON.stringify(db.query('SELECT value FROM records').all())).not.toContain('DO NOT INDEX'); }
    finally { db.close(); }
});
test('replacement and incomplete tails invalidate cached file accounting', async () => {
    const { path, file } = await fixture();
    await writeFile(file, JSON.stringify(row('a')) + '\n{"type":"assistant"');
    const first = await collectIndexedUsage([file], cutoff, opts(path));
    expect(first.coverage.state).toBe('partial');
    await writeFile(file, JSON.stringify(row('b', cutoff, 30)) + '\n');
    const next = await collectIndexedUsage([file], cutoff, opts(path));
    expect(next.coverage.state).toBe('complete');
    expect(next.ranges['7d'].tokens.fresh).toBe(30);
    expect(next.ranges['7d'].requests).toBe(1);
});
test('a concurrent writer cannot replace the index; saved results remain readable', async () => {
    const { path, file } = await fixture(); await writeFile(file, JSON.stringify(row('a')));
    const first = await collectIndexedUsage([file], cutoff, opts(path));
    const { lock } = await import('./lockfile.js'); const release = await lock(path, { realpath: false });
    try {
        await expect(collectIndexedUsage([file], cutoff, opts(path))).rejects.toThrow();
        expect(readSavedUsage(path)).toEqual(first);
    } finally { await release(); }
});

test('indexed result flags match direct accounting without persisting result content', async () => {
    const { path, file } = await fixture();
    const result = { type: 'user', sessionId: 's', uuid: 'result', timestamp: cutoff, message: { content: [{ type: 'tool_result', tool_use_id: 'error', is_error: true, content: 'PRIVATE RESULT BODY' }] } };
    await writeFile(file, [result, row('error'), result].map(r => JSON.stringify(r)).join('\n') + '\n');
    const indexed = await collectIndexedUsage([file], cutoff, opts(path));
    expect(indexed.ranges).toEqual((await collectRetainedUsage([file], cutoff)).ranges);
    expect(indexed.ranges['7d'].tools[0]).toMatchObject({ results: 1, errors: 1 });
    expect(readSavedUsage(path)).toEqual(indexed);
    const { Database } = await import('bun:sqlite');
    const db = new Database(path, { readonly: true });
    try { expect(JSON.stringify(db.query('SELECT value FROM records').all())).not.toContain('PRIVATE RESULT BODY'); } finally { db.close(); }
});
