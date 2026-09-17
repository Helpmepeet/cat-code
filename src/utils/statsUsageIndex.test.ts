import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, writeFile, appendFile, rm, copyFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { collectIndexedUsage, readSavedUsage } from './statsUsageIndex.js';
import { collectRetainedUsage, UsageResourceError } from './statsUsage.js';
import { usageProjectId } from '../../app/shared/usageDashboard.js';
import { fitUsageDashboardSnapshot, groupUsageSummary } from '../../app/sidecar/usageSummary.js';
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
    expect(reads).toBe(0);
    const expectedWarm = structuredClone(first.ranges);
    expectedWarm['7d'].previousPeriod!.endInclusive = '2026-09-06T12:01:00.000Z';
    expect(warm.ranges).toEqual(expectedWarm);
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
    expect(next.ranges.all.tokens.fresh).toBe(10);
    expect(next.ranges.all.startInclusive).toBe('2026-09-13T00:00:00.000Z');
});
test('warm indexed collection advances previous-period cutoffs without rereading sources', async () => {
    const { path, file } = await fixture();
    await writeFile(file, [
        row('anchor', '2026-08-30T00:00:00.000Z', 1),
        row('baseline-early', '2026-09-06T11:30:00.000Z', 9),
        row('baseline-late', '2026-09-06T12:30:00.000Z', 9),
        row('current', cutoff, 3),
    ].map(value => JSON.stringify(value)).join('\n'));
    const first = await collectIndexedUsage([file], cutoff, opts(path));
    expect(first.ranges['7d'].previousPeriod!.tokens.fresh).toBe(9);
    let reads = 0;
    const advanced = await collectIndexedUsage([file], '2026-09-13T13:00:00.000Z', { ...opts(path), onReadSource() { reads++; } });
    expect(reads).toBe(0);
    expect(advanced.ranges['7d'].previousPeriod!.tokens.fresh).toBe(18);
    expect(advanced.ranges).toEqual((await collectRetainedUsage([file], '2026-09-13T13:00:00.000Z')).ranges);
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
test('cold and warm index snapshots retain owning-session attribution without retaining content', async () => {
    const { path, file } = await fixture();
    const engineSessionId = '123e4567-e89b-42d3-a456-426614174000';
    const cwd = join(dirname(file), 'workspace');
    const subagentDir = join(dirname(file), engineSessionId, 'subagents');
    const subagentFile = join(subagentDir, 'agent-worker.jsonl');
    await mkdir(subagentDir, { recursive: true });
    const main = { ...row('main', cutoff, 10), sessionId: engineSessionId, cwd };
    const prompt = { type: 'user', sessionId: engineSessionId, cwd, uuid: 'prompt', timestamp: cutoff, message: { content: 'PRIVATE PROMPT BODY' } };
    const subagent = { ...row('subagent', cutoff, 20), sessionId: engineSessionId, cwd };
    await writeFile(file, [prompt, main].map(value => JSON.stringify(value)).join('\n'));
    await writeFile(subagentFile, JSON.stringify(subagent));
    const files = [file, subagentFile];
    const cold = await collectIndexedUsage(files, cutoff, opts(path));
    const day = cold.ranges['7d'].days.at(-1)!;
    expect(day.contributors.items).toHaveLength(1);
    expect(day.contributors.items[0]).toMatchObject({
        engineSessionId,
        project: { id: usageProjectId(cwd), label: 'workspace' },
        tokens: { fresh: 30, read: 0, write: 0, output: 0 },
        requests: 2,
        results: 0,
        errors: 0,
    });
    expect(day.tokens).toEqual({ fresh: 30, read: 0, write: 0, output: 0 });
    expect(day.requests).toBe(2);
    expect(day.sessions).toBe(1);
    let reads = 0;
    const warm = await collectIndexedUsage(files, '2026-09-13T12:01:00.000Z', { ...opts(path), onReadSource() { reads++; } });
    expect(reads).toBe(0);
    expect(warm.ranges['7d'].days.at(-1)!.contributors).toEqual(day.contributors);
    expect(readSavedUsage(path)).toEqual(warm);
    const { Database } = await import('bun:sqlite');
    const db = new Database(path, { readonly: true });
    try {
        const projected = JSON.stringify(db.query('SELECT value FROM records').all());
        expect(projected).not.toContain('PRIVATE PROMPT BODY');
        expect(projected).not.toContain('DO NOT INDEX PROMPT TEXT');
        expect(projected).not.toContain('DO NOT INDEX TOOL INPUT');
    } finally { db.close(); }
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


test('legacy two-window cache rebuilds All from indexed records without reading unchanged sources', async () => {
    const { path, file } = await fixture();
    await writeFile(file, [row('old', '2020-01-01T00:00:00.000Z', 7), row('recent', cutoff, 11)].map(item => JSON.stringify(item)).join('\n'));
    const original = await collectIndexedUsage([file], cutoff, opts(path));
    const legacy = structuredClone(original) as any;
    delete legacy.ranges.all;
    const { Database } = await import('bun:sqlite');
    const db = new Database(path);
    try { db.query('UPDATE snapshot SET value=? WHERE id=1').run(JSON.stringify(legacy)); }
    finally { db.close(); }
    expect(readSavedUsage(path)).toBeNull();
    let reads = 0;
    const rebuilt = await collectIndexedUsage([file], cutoff, { ...opts(path), onReadSource() { reads++; } });
    expect(reads).toBe(0);
    expect(rebuilt.ranges.all.tokens.fresh).toBe(18);
    expect(rebuilt.ranges).toEqual(original.ranges);
});

test('v8 grouped snapshots rebuild named categories from indexed records without rereading sources', async () => {
    const { path, file } = await fixture();
    await writeFile(file, JSON.stringify(row('a', cutoff, 18)));
    const original = await collectIndexedUsage([file], cutoff, opts(path));
    const legacy = structuredClone(original) as any;
    legacy.countingVersion = 8;
    legacy.ranges = {
        '7d': groupUsageSummary(legacy.ranges['7d'], 0, 0, 0),
        '30d': groupUsageSummary(legacy.ranges['30d'], 0, 0, 0),
        all: groupUsageSummary(legacy.ranges.all, 0, 0, 0),
    };
    const { Database } = await import('bun:sqlite');
    const db = new Database(path);
    try { db.query('UPDATE snapshot SET value=? WHERE id=1').run(JSON.stringify(legacy)); }
    finally { db.close(); }
    expect(readSavedUsage(path)).toBeNull();
    let reads = 0;
    const options = { ...opts(path), finalize: fitUsageDashboardSnapshot, onReadSource() { reads++; } };
    const rebuilt = await collectIndexedUsage([file], cutoff, options);
    expect(reads).toBe(0);
    expect(rebuilt.countingVersion).toBe(9);
    expect(rebuilt.ranges['30d'].models.map(model => model.label)).toContain('model');
    expect(rebuilt.ranges['30d'].tools.map(tool => tool.label)).toContain('Bash');
    const warm = await collectIndexedUsage([file], cutoff, options);
    expect(reads).toBe(0);
    expect(warm.ranges).toEqual(rebuilt.ranges);
});

test('pricing-rate revisions invalidate saved summaries without rereading unchanged sources', async () => {
    const { path, file } = await fixture();
    await writeFile(file, JSON.stringify(row('a', cutoff, 18)));
    const original = await collectIndexedUsage([file], cutoff, opts(path));
    const staleRates = structuredClone(original) as any;
    staleRates.pricingVersion = 0;
    const { Database } = await import('bun:sqlite');
    const db = new Database(path);
    try { db.query('UPDATE snapshot SET value=? WHERE id=1').run(JSON.stringify(staleRates)); }
    finally { db.close(); }
    expect(readSavedUsage(path)).toBeNull();
    let reads = 0;
    const rebuilt = await collectIndexedUsage([file], cutoff, { ...opts(path), onReadSource() { reads++; } });
    expect(reads).toBe(0);
    expect(rebuilt.pricingVersion).toBe(1);
    expect(rebuilt.ranges).toEqual(original.ranges);
});


test('older snapshots rebuild hourly tokens and daily outcomes from the index, then reuse them warm', async () => {
    const { path, file } = await fixture();
    const result = { type: 'user', sessionId: 's', uuid: 'result', timestamp: cutoff, message: { content: [{ type: 'tool_result', tool_use_id: 'request', is_error: true }] } };
    await writeFile(file, [row('request', '2026-09-12T23:00:00.000Z', 25), result].map(item => JSON.stringify(item)).join('\n'));
    const original = await collectIndexedUsage([file], cutoff, opts(path));
    const legacy = structuredClone(original);
    for (const range of Object.values(legacy.ranges)) for (const day of range.days) {
        delete day.hourlyTokens;
        delete (day as Partial<typeof day>).results;
        delete (day as Partial<typeof day>).errors;
    }
    const { Database } = await import('bun:sqlite');
    const db = new Database(path);
    try { db.query('UPDATE snapshot SET value=? WHERE id=1').run(JSON.stringify(legacy)); }
    finally { db.close(); }
    expect(readSavedUsage(path)).toBeNull();
    let reads = 0;
    const options = { ...opts(path), onReadSource() { reads++; } };
    const rebuilt = await collectIndexedUsage([file], cutoff, options);
    expect(reads).toBe(0);
    expect(rebuilt.ranges).toEqual(original.ranges);
    expect(rebuilt.ranges['7d'].days.at(-2)).toMatchObject({ results: 1, errors: 1 });
    expect(rebuilt.ranges['7d'].days.at(-2)!.hourlyTokens![23]).toBe(25);
    const warm = await collectIndexedUsage([file], '2026-09-13T12:01:00.000Z', options);
    expect(reads).toBe(0);
    expect(warm.ranges).toEqual(rebuilt.ranges);
});
