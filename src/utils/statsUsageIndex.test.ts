import { afterEach, expect, test, spyOn } from 'bun:test';
import { mkdtemp, writeFile, appendFile, rm, copyFile, mkdir, rename, readdir, stat, utimes } from 'node:fs/promises';
import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import * as fs from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { collectIndexedUsage, emptyUsageIndexMetrics, readSavedUsage, usageIndexPath } from './statsUsageIndex.js';
import { collectRetainedUsage, UsageResourceError } from './statsUsage.js';
import { projectAutoModeDiagnosticPayload, reduceAutoModeUsage, type RetainedAutoModeRecord } from './autoModeUsage.js';
import { UsageFailure } from './statsFailure.js';
import { usageProjectId } from '../../app/shared/usageDashboard.js';
import { fitUsageDashboardSnapshot, groupUsageSummary } from '../../app/sidecar/usageSummary.js';
import * as debug from './debug.js';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const cutoff = '2026-09-13T12:00:00.000Z';
const row = (id: string, timestamp = cutoff, tokens = 10) => ({ type: 'assistant', sessionId: 's', uuid: id, timestamp, message: { id, model: 'model', usage: { input_tokens: tokens }, content: [{ type: 'text', text: 'DO NOT INDEX PROMPT TEXT' }, { type: 'tool_use', id, name: 'Bash', input: { secret: 'DO NOT INDEX TOOL INPUT' } }] } });
async function fixture() { const root = await mkdtemp(join(tmpdir(), 'usage-index-')); roots.push(root); return { path: join(root, 'cache.sqlite'), file: join(root, 's.jsonl') }; }
const opts = (path: string) => ({ path, deadline: Date.now() + 60000 });
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function replaceSavedSnapshot(path: string, snapshot: unknown) {
    const db = new Database(path);
    try {
        const saved = JSON.parse(db.query<{ value: string }, []>('SELECT value FROM snapshot WHERE id=1').get()!.value);
        db.query('UPDATE snapshot SET value=? WHERE id=1').run(JSON.stringify({ ...saved, snapshot }));
    } finally { db.close(); }
}
test('max_page_count belongs to each connection and can be raised without rebuilding an existing file', async () => {
    const { path } = await fixture();
    const first = new Database(path, { create: true });
    try {
        first.exec('PRAGMA page_size=4096; PRAGMA max_page_count=262144; CREATE TABLE retained(value TEXT); INSERT INTO retained VALUES (\'keep\');');
        expect(first.query('PRAGMA max_page_count').get()).toEqual({ max_page_count: 262144 });
        const second = new Database(path);
        try {
            expect(second.query('PRAGMA max_page_count').get()).not.toEqual({ max_page_count: 262144 });
            second.exec('PRAGMA max_page_count=67108864');
            expect(second.query('PRAGMA max_page_count').get()).toEqual({ max_page_count: 67108864 });
            expect(first.query('PRAGMA max_page_count').get()).toEqual({ max_page_count: 262144 });
            expect(second.query('SELECT value FROM retained').get()).toEqual({ value: 'keep' });
        } finally { second.close(); }
    } finally { first.close(); }
    const reopened = new Database(path);
    try {
        expect(reopened.query('PRAGMA max_page_count').get()).not.toEqual({ max_page_count: 67108864 });
        expect(reopened.query('SELECT value FROM retained').get()).toEqual({ value: 'keep' });
    } finally { reopened.close(); }
});
test('refresh removes older indexes, orphaned sidecars and stale locks but retains current, future, corrupt and unrelated files', async () => {
    const fixtureFiles = await fixture();
    const root = dirname(fixtureFiles.path), path = join(root, 'index-v14.sqlite'), file = fixtureFiles.file;
    await writeFile(file, JSON.stringify(row('retained')));
    await collectIndexedUsage([file], cutoff, opts(path));
    const inode = (await stat(path)).ino;
    const marker = new Database(path);
    try { marker.exec('CREATE TABLE retained(value TEXT); INSERT INTO retained VALUES (\'no rebuild\');'); }
    finally { marker.close(); }
    const removed: string[] = [];
    for (let version = 1; version < 14; version++) {
        if (version === 3) continue;
        for (const part of ['', '-wal', '-shm']) {
            // Cover orphaned sidecars without the database itself as well.
            if (version === 2 && part === '') continue;
            const name = `index-v${version}.sqlite${part}`;
            await writeFile(join(root, name), 'obsolete');
            removed.push(name);
        }
    }
    const staleLock = join(root, 'index-v10.sqlite.lock');
    await mkdir(staleLock);
    const stale = new Date(Date.now() - 600000);
    await utimes(staleLock, stale, stale);
    removed.push('index-v10.sqlite.lock');
    // Also reclaim a lock with no database or sidecars.
    await mkdir(join(root, 'index-v3.sqlite.lock'));
    await utimes(join(root, 'index-v3.sqlite.lock'), stale, stale);
    removed.push('index-v3.sqlite.lock');
    const kept = [
        'index-v15.sqlite', 'index-v15.sqlite-wal', 'index-v15.sqlite-shm',
        'index-v1.sqlite.corrupt-backup', 'index-v1.sqlite.corrupt-backup-wal', 'index-v1.sqlite.corrupt-backup-shm',
        'index-v14.sqlite.corrupt-backup', 'notes.txt', 'other.sqlite', 'index-v10.sqlite.bak',
    ];
    for (const name of kept) await writeFile(join(root, name), 'keep');
    await mkdir(join(root, 'index-v15.sqlite.lock'));
    await mkdir(join(root, 'index-v1.sqlite.corrupt-backup.lock'));
    kept.push('index-v15.sqlite.lock', 'index-v1.sqlite.corrupt-backup.lock');
    let reads = 0;
    const caps: number[] = [];
    const exec = Database.prototype.exec;
    const observe = spyOn(Database.prototype, 'exec').mockImplementation(function (this: Database, sql: string) {
        if (this.filename === path && sql === 'BEGIN IMMEDIATE') {
            caps.push(this.query<{ max_page_count: number }, []>('PRAGMA max_page_count').get()!.max_page_count);
        }
        return exec.call(this, sql);
    });
    try {
        for (let refresh = 0; refresh < 2; refresh++) {
            await collectIndexedUsage([file], cutoff, { ...opts(path), onReadSource() { reads++; } });
        }
    } finally { observe.mockRestore(); }
    expect(caps).toEqual([67108864, 67108864]);
    expect(reads).toBe(0);
    expect((await stat(path)).ino).toBe(inode);
    const reader = new Database(path, { readonly: true });
    try { expect(reader.query('SELECT value FROM retained').get()).toEqual({ value: 'no rebuild' }); }
    finally { reader.close(); }
    const remaining = await readdir(root);
    for (const name of removed) expect(remaining).not.toContain(name);
    for (const name of [...kept, 'index-v14.sqlite']) expect(remaining).toContain(name);
});
test('cleanup skips an older process mid-refresh and retries after its writer lock is released', async () => {
    const { path: fixturePath } = await fixture();
    const root = dirname(fixturePath), older = join(root, 'index-v10.sqlite'), path = join(root, 'index-v14.sqlite');
    const seed = new Database(older, { create: true });
    try { seed.exec('CREATE TABLE retained(value TEXT)'); } finally { seed.close(); }
    const child = Bun.spawn([process.execPath, '-e', `
        import { Database } from 'bun:sqlite';
        import { lock } from ${JSON.stringify(new URL('./lockfile.ts', import.meta.url).href)};
        const path = ${JSON.stringify(older)};
        const release = await lock(path, { realpath: false, stale: 180000, update: 30000, retries: 0 });
        const db = new Database(path);
        try {
            db.exec("PRAGMA journal_mode=WAL; BEGIN IMMEDIATE; INSERT INTO retained VALUES ('committed')");
            console.log('ready');
            await Bun.stdin.text();
            db.exec('COMMIT');
        } finally { db.close(); await release(); }
    `], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
    try {
        const output = child.stdout.getReader();
        const ready = await output.read();
        output.releaseLock();
        expect(new TextDecoder().decode(ready.value)).toBe('ready\n');
        const lockInode = (await stat(older + '.lock')).ino;
        await collectIndexedUsage([], cutoff, opts(path));
        for (const part of ['', '-wal', '-shm', '.lock']) expect(existsSync(older + part)).toBe(true);
        expect((await stat(older + '.lock')).ino).toBe(lockInode);
    } finally { child.stdin.end(); await child.exited; }
    expect(await child.exited).toBe(0);
    expect(await new Response(child.stderr).text()).toBe('');
    const reader = new Database(older, { readonly: true });
    try { expect(reader.query('SELECT value FROM retained').get()).toEqual({ value: 'committed' }); }
    finally { reader.close(); }
    await collectIndexedUsage([], cutoff, opts(path));
    for (const part of ['', '-wal', '-shm', '.lock']) expect(existsSync(older + part)).toBe(false);
});
test('cleanup leaves the current database WAL and SHM in place', async () => {
    const { path: fixturePath } = await fixture();
    const root = dirname(fixturePath), path = join(root, 'index-v14.sqlite');
    const current = new Database(path, { create: true });
    try {
        current.exec('PRAGMA journal_mode=WAL; CREATE TABLE retained(value TEXT); INSERT INTO retained VALUES (\'in WAL\');');
        const inodes = await Promise.all(['', '-wal', '-shm'].map(part => stat(path + part).then(s => s.ino)));
        await writeFile(join(root, 'index-v10.sqlite'), 'obsolete');
        await collectIndexedUsage([], cutoff, opts(path));
        expect(await Promise.all(['', '-wal', '-shm'].map(part => stat(path + part).then(s => s.ino)))).toEqual(inodes);
        expect(current.query('SELECT value FROM retained').get()).toEqual({ value: 'in WAL' });
        expect(existsSync(join(root, 'index-v10.sqlite'))).toBe(false);
    } finally { current.close(); }
});
test('exhausted memory scratch spills in bounded persistent-journal batches without changing accounting or durable publication', async () => {
    const { path, file } = await fixture();
    await writeFile(file, Array.from({ length: 1000 }, (_, id) => JSON.stringify(row(String(id)))).join('\n') + '\n');
    const exec = Database.prototype.exec;
    const close = Database.prototype.close;
    let bounded = false;
    const batches: number[] = [];
    let committedChanges = 0;
    let diskChanges = 0;
    let diskRows = 0;
    let writerRows = 0;
    let diskPath = '';
    let journalRetained = false;
    let transactionAtClose = false;
    let memoryCap = 0;
    let diskCap = 0;
    const limit = spyOn(Database.prototype, 'exec').mockImplementation(function (this: Database, sql: string) {
        const wasInTransaction = this.inTransaction;
        const result = exec.call(this, sql);
        if (this.filename === ':memory:' && !bounded) {
            bounded = true;
            memoryCap = this.query<{ max_page_count: number }, []>('PRAGMA max_page_count').get()!.max_page_count;
            exec.call(this, 'PRAGMA max_page_count=32');
        }
        if (this.filename.endsWith('/scratch.sqlite') && wasInTransaction && !this.inTransaction) {
            const changes = this.query<{ count: number }, []>('SELECT total_changes() AS count').get()!.count;
            batches.push(changes - committedChanges);
            committedChanges = changes;
        }
        return result;
    });
    const observe = spyOn(Database.prototype, 'close').mockImplementation(function (this: Database, ...args: Parameters<Database['close']>) {
        if (this.filename.endsWith('/scratch.sqlite')) {
            diskPath = this.filename;
            diskCap = this.query<{ max_page_count: number }, []>('PRAGMA max_page_count').get()!.max_page_count;
            diskChanges = this.query<{ count: number }, []>('SELECT total_changes() AS count').get()!.count;
            writerRows = this.query<{ count: number }, []>('SELECT count(*) AS count FROM identities').get()!.count;
            journalRetained = existsSync(this.filename + '-journal');
            transactionAtClose = this.inTransaction;
            // A second connection only sees committed rows, including the final
            // partial batch. The keys remain digests after the spill.
            const reader = new Database(this.filename, { readonly: true });
            try {
                diskRows = reader.query<{ count: number }, []>('SELECT count(*) AS count FROM identities').get()!.count;
                expect(reader.query('SELECT 1 FROM identities WHERE length(key) != 64 OR key GLOB \'*[^0-9a-f]*\' LIMIT 1').get()).toBeNull();
            } finally { close.call(reader); }
        }
        return close.apply(this, args);
    });
    try {
        const indexed = await collectIndexedUsage([file], cutoff, opts(path));
        expect(bounded).toBe(true);
        expect(memoryCap).toBe(16384);
        expect(diskCap).toBe(67108864);
        expect(indexed.ranges).toEqual((await collectRetainedUsage([file], cutoff)).ranges);
        expect(readSavedUsage(path)).toEqual(indexed);
        expect(committedChanges).toBe(diskChanges);
        expect(journalRetained).toBe(true);
        expect(transactionAtClose).toBe(false);
        expect(writerRows).toBeGreaterThan(0);
        expect(diskRows).toBe(writerRows);
        expect(batches.length).toBeGreaterThan(1);
        expect(batches.every(count => count > 0 && count <= 256)).toBe(true);
        expect(batches.at(-1)).toBeLessThan(256);
        expect(existsSync(dirname(diskPath))).toBe(false);
    } finally { observe.mockRestore(); limit.mockRestore(); }
});
for (const failure of ['copy-full', 'write-full', 'final-commit', 'deadline'] as const) test(`scratch ${failure} failure removes temporary state and preserves the last durable snapshot`, async () => {
    const { path, file } = await fixture();
    await writeFile(file, JSON.stringify(row('saved')) + '\n');
    const saved = await collectIndexedUsage([file], cutoff, opts(path));
    await appendFile(file, Array.from({ length: 1000 }, (_, id) => JSON.stringify(row(String(id)))).join('\n') + '\n');
    const options = opts(path);
    const exec = Database.prototype.exec;
    const close = Database.prototype.close;
    let injected = false;
    let diskPath = '';
    let fullRolledBack = false;
    let pendingBatchAtClose = false;
    let copyComplete = false;
    let committedChanges = 0;
    const limit = spyOn(Database.prototype, 'exec').mockImplementation(function (this: Database, sql: string) {
        if (this.filename === ':memory:') {
            const result = exec.call(this, sql);
            exec.call(this, 'PRAGMA max_page_count=8');
            return result;
        }
        if (!this.filename.endsWith('/scratch.sqlite')) return exec.call(this, sql);
        diskPath = this.filename;
        const wasInTransaction = this.inTransaction;
        // Fail only the last partial batch, after completed batches have really
        // committed. Successful aggregation alone must not publish the snapshot.
        if (failure === 'final-commit' && sql === 'COMMIT' && copyComplete) {
            const changes = this.query<{ count: number }, []>('SELECT total_changes() AS count').get()!.count;
            const batchChanges = changes - committedChanges;
            if (batchChanges > 0 && batchChanges < 256) {
                injected = true;
                throw Object.assign(new Error('injected commit I/O error'), { code: 'SQLITE_IOERR' });
            }
        }
        const result = exec.call(this, sql);
        if (failure === 'copy-full' && !injected) {
            exec.call(this, 'PRAGMA max_page_count=2');
            injected = true;
        }
        if (wasInTransaction && !this.inTransaction) {
            committedChanges = this.query<{ count: number }, []>('SELECT total_changes() AS count').get()!.count;
            if (!injected && failure === 'write-full') {
                const pages = this.query<{ page_count: number }, []>('PRAGMA page_count').get()!.page_count;
                exec.call(this, `PRAGMA max_page_count=${pages}`);
                injected = true;
            }
        }
        if (!injected && failure === 'deadline' && copyComplete && !wasInTransaction && this.inTransaction) {
            options.deadline = Date.now() - 1;
            injected = true;
        }
        return result;
    });
    const observe = spyOn(Database.prototype, 'close').mockImplementation(function (this: Database, ...args: Parameters<Database['close']>) {
        if (this.filename === ':memory:' && diskPath) copyComplete = true;
        if (this.filename.endsWith('/scratch.sqlite')) {
            if (failure.endsWith('full')) fullRolledBack = !this.inTransaction;
            pendingBatchAtClose = this.inTransaction;
        }
        return close.apply(this, args);
    });
    try {
        const error = await collectIndexedUsage([file], cutoff, options).then(() => null, (caught: unknown) => caught);
        expect(error).toBeInstanceOf(UsageFailure);
        const failed = error as UsageFailure;
        expect(failed.message).toBe(failure === 'deadline' ? 'Usage collection timeout' : 'Usage identity storage limit or write failure');
        // Capacity is only SQLITE_FULL; an I/O fault on the final commit is a storage failure.
        expect({ reason: failed.reason, phase: failed.phase, sqliteCode: failed.detail.sqliteCode }).toEqual(
            failure === 'deadline' ? { reason: 'deadline', phase: 'replay', sqliteCode: undefined }
                : failure === 'final-commit' ? { reason: 'storage-failure', phase: 'replay', sqliteCode: 'SQLITE_IOERR' }
                    : { reason: 'storage-capacity', phase: 'replay', sqliteCode: 'SQLITE_FULL' });
        expect(injected).toBe(true);
        if (failure.endsWith('full')) expect(fullRolledBack).toBe(true);
        else expect(pendingBatchAtClose).toBe(true);
        expect(readSavedUsage(path)).toEqual(saved);
        const reader = new Database(path, { readonly: true });
        try { expect(reader.query<{ count: number }, []>('SELECT count(*) AS count FROM records').get()!.count).toBe(1); }
        finally { reader.close(); }
        expect(existsSync(dirname(diskPath))).toBe(false);
    } finally { observe.mockRestore(); limit.mockRestore(); }
    const recovered = await collectIndexedUsage([file], cutoff, opts(path));
    expect(recovered.ranges).toEqual((await collectRetainedUsage([file], cutoff)).ranges);
    expect(readSavedUsage(path)).toEqual(recovered);
});
test('append refresh retains existing rows, and interrupted tail publication rolls back atomically', async () => {
    const { path, file } = await fixture();
    await writeFile(file, Array.from({ length: 3000 }, (_, id) => JSON.stringify(row(String(id)))).join('\n') + '\n');
    await collectIndexedUsage([file], cutoff, opts(path));
    const db = new Database(path);
    try {
        db.exec(`CREATE TABLE mutations(kind TEXT PRIMARY KEY, count INTEGER);
            INSERT INTO mutations VALUES ('insert',0),('delete',0);
            CREATE TRIGGER record_insert AFTER INSERT ON records BEGIN UPDATE mutations SET count=count+1 WHERE kind='insert'; END;
            CREATE TRIGGER record_delete AFTER DELETE ON records BEGIN UPDATE mutations SET count=count+1 WHERE kind='delete'; END;`);
        for (const id of ['append-a', 'append-b']) {
            await appendFile(file, JSON.stringify(row(id)) + '\n');
            const updated = await collectIndexedUsage([file], cutoff, opts(path));
            expect(updated.ranges).toEqual((await collectRetainedUsage([file], cutoff)).ranges);
        }
        expect(db.query('SELECT kind,count FROM mutations ORDER BY kind').all()).toEqual([{ kind: 'delete', count: 0 }, { kind: 'insert', count: 2 }]);
        const saved = readSavedUsage(path);
        await appendFile(file, JSON.stringify(row('interrupted')) + '\n');
        await expect(collectIndexedUsage([file], cutoff, { ...opts(path), finalize() { throw new Error('interrupted after indexing'); } })).rejects.toThrow('interrupted after indexing');
        expect(readSavedUsage(path)).toEqual(saved);
        expect(db.query<{ count: number }, []>('SELECT count(*) AS count FROM records').get()!.count).toBe(3002);
        const recovered = await collectIndexedUsage([file], cutoff, opts(path));
        expect(recovered.ranges).toEqual((await collectRetainedUsage([file], cutoff)).ranges);
        expect(db.query('SELECT kind,count FROM mutations ORDER BY kind').all()).toEqual([{ kind: 'delete', count: 0 }, { kind: 'insert', count: 3 }]);
    } finally { db.close(); }
});

test('continuation falls back for prefix edits plus growth, truncation, replacement, and nonterminated tails', async () => {
    const { path, file } = await fixture();
    const text = (id: string, tokens = 10) => JSON.stringify(row(id, cutoff, tokens)) + '\n';
    await writeFile(file, text('a'));
    await collectIndexedUsage([file], cutoff, opts(path));
    // Same inode, larger size, and changed historical accounting: growth is
    // not sufficient evidence for retaining the previous prefix.
    for (const mutate of [
        async () => { await writeFile(file, text('a', 99) + text('b')); },
        async () => { await writeFile(file, text('truncated')); },
        async () => { await rename(file, file + '.old'); await writeFile(file, text('replacement') + text('extra')); },
        async () => { await writeFile(file, text('tail').trimEnd()); },
        async () => { await appendFile(file, '\n' + text('completed')); },
        async () => { await appendFile(file, '{"type":'); },
        async () => { await appendFile(file, '"user","uuid":"pending","sessionId":"s","timestamp":"' + cutoff + '"}\n'); },
    ]) {
        await mutate();
        const indexed = await collectIndexedUsage([file], cutoff, opts(path));
        const direct = await collectRetainedUsage([file], cutoff);
        expect(indexed.ranges).toEqual(direct.ranges);
        expect(indexed.coverage).toEqual(direct.coverage);
    }
});
function autoModeRecords(values: unknown[], sourceScope: string): RetainedAutoModeRecord[] {
    return values.flatMap((value, index) => {
        if (!object(value) || typeof value.timestamp !== 'string') return [];
        const payload = projectAutoModeDiagnosticPayload(value);
        if (payload === null) return [];
        return [{
            sourceScope,
            recordId: typeof value.uuid === 'string' ? value.uuid : `record-${index}`,
            observedAt: value.timestamp,
            diagnosticKind: 'auto_mode_observation',
            payload,
        }];
    });
}
function reducedAutoMode(records: RetainedAutoModeRecord[], sourceScope: string, state: 'complete' | 'partial' = 'complete') {
    return reduceAutoModeUsage({
        records,
        sources: [{ sourceScope, allTools: state, commands: state }],
        rangeStart: '2026-09-07T00:00:00.000Z',
        rangeEnd: cutoff,
        cutoff,
    });
}
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
    if (expectedWarm['7d'].previousPeriod) expectedWarm['7d'].previousPeriod.endInclusive = '2026-09-06T12:01:00.000Z';
    if (expectedWarm['30d'].previousPeriod) expectedWarm['30d'].previousPeriod.endInclusive = '2026-08-14T12:01:00.000Z';
    expect(warm.ranges).toEqual(expectedWarm);
    expect(readSavedUsage(path)).toEqual(warm);
    await appendFile(file, JSON.stringify(row('c')) + '\n');
    const updated = await collectIndexedUsage(files, cutoff, { ...opts(path), onReadSource: () => { reads++; } });
    expect(reads).toBe(1); expect(updated.ranges).toEqual((await collectRetainedUsage(files, cutoff)).ranges);
    const removed = await collectIndexedUsage([copy], cutoff, opts(path));
    expect(removed.ranges).toEqual((await collectRetainedUsage([copy], cutoff)).ranges);
});

test('timezone changes rebuild local buckets from the retained index without rereading transcripts', async () => {
    const { path, file } = await fixture();
    const observation = row('near-midnight', '2026-09-13T02:00:00.000Z', 7);
    await writeFile(file, JSON.stringify(observation));
    const utc = await collectIndexedUsage([file], cutoff, { ...opts(path), timezone: 'UTC' });
    let reads = 0;
    const local = await collectIndexedUsage([file], cutoff, { ...opts(path), timezone: 'America/New_York', onReadSource() { reads++; } });
    expect(reads).toBe(0);
    expect(utc.timezone).toBe('UTC');
    expect(local.timezone).toBe('America/New_York');
    expect(utc.ranges['7d'].days.find(day => day.tokens.fresh > 0)!.date).toBe('2026-09-13');
    expect(local.ranges['7d'].days.find(day => day.tokens.fresh > 0)!.date).toBe('2026-09-12');
    expect(readSavedUsage(path)).toEqual(local);
});
test('future records and local calendar rollover recalculate from index without rereading sources', async () => {
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
test('warm indexed collection preserves prior local calendar periods without rereading sources', async () => {
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
test('v14 comparison snapshots rebuild from indexed records without rereading sources', async () => {
    const { path, file } = await fixture();
    await writeFile(file, [
        row('anchor', '2026-08-30T00:00:00.000Z', 1),
        row('baseline', '2026-09-06T11:30:00.000Z', 9),
        row('current', cutoff, 3),
    ].map(value => JSON.stringify(value)).join('\n'));
    const original = await collectIndexedUsage([file], cutoff, opts(path));
    const legacy = structuredClone(original) as any;
    legacy.countingVersion = 14;
    legacy.ranges['7d'].previousPeriod.tokens.fresh = 999;
    replaceSavedSnapshot(path, legacy);
    expect(readSavedUsage(path)).toBeNull();
    let reads = 0;
    const rebuilt = await collectIndexedUsage([file], cutoff, { ...opts(path), onReadSource() { reads++; } });
    expect(reads).toBe(0);
    expect(rebuilt.countingVersion).toBe(23);
    expect(rebuilt.ranges['7d'].previousPeriod!.tokens.fresh).toBe(9);
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
for (const level of ['high', 'ultra'] as const) test(`effort projection retains ${level} in cold and warm collections without unrelated diagnostic fields`, async () => {
    const { path, file } = await fixture();
    const facts = { type: 'system', subtype: 'run_facts', sessionId: 's', uuid: 'facts', timestamp: '2026-09-13T11:59:59.000Z', effort: level, permissionMode: 'DO NOT INDEX MODE', model: 'DO NOT INDEX MODEL', contextWindow: 200000, ruleText: 'DO NOT INDEX RULE' };
    await writeFile(file, [facts, row('a')].map(value => JSON.stringify(value)).join('\n'));
    const indexed = await collectIndexedUsage([file], cutoff, opts(path));
    const direct = await collectRetainedUsage([file], cutoff);
    const warm = await collectIndexedUsage([file], cutoff, opts(path));
    for (const result of [direct, indexed, warm]) {
        for (const range of ['7d', '30d', 'all'] as const) {
            expect(result.ranges[range].effort.requests[level]).toBe(1);
            expect(result.ranges[range].effort.tokens[level]).toBe(10);
            expect(result.ranges[range].effort.state).toBe('available');
        }
    }
    const { Database } = await import('bun:sqlite');
    const db = new Database(path, { readonly: true });
    try {
        const projected = JSON.stringify(db.query('SELECT value FROM records').all());
        for (const excluded of ['DO NOT INDEX MODE', 'DO NOT INDEX MODEL', 'DO NOT INDEX RULE', 'contextWindow', 'ruleText', 'permissionMode']) expect(projected).not.toContain(excluded);
    } finally { db.close(); }
});
test('projects auto-mode diagnostics without ordinary accounting or raw payload retention', async () => {
    const { path, file } = await fixture();
    const start = { type: 'system', uuid: 'start', timestamp: '2026-09-12T10:00:00.000Z', subtype: 'auto_permission_start', schema_version: 1, attempt_id: 'attempt', tool_use_id: 'tool', tool_kind: 'bash', auto_mode: 'auto', initial: true };
    const end = { type: 'system', uuid: 'end', timestamp: '2026-09-12T10:01:00.000Z', subtype: 'auto_permission_end', schema_version: 1, attempt_id: 'attempt', raw_result: 'allow', disposition: 'allowed', route: 'stage1' };
    const malformedStart = { ...start, uuid: 'bad-start', attempt_id: 'bad-attempt', tool_use_id: 'bad-tool' };
    const malformedEnd = { type: 'system', uuid: 'bad-end', timestamp: '2026-09-12T10:03:00.000Z', subtype: 'auto_permission_end', attempt_id: 'bad-attempt', raw_result: 'deny', disposition: 'not-valid', route: 'base', command: 'DO NOT INDEX AUTO INPUT' };
    await writeFile(file, [row('ordinary'), start, end, start, malformedStart, malformedEnd].map(value => JSON.stringify(value)).join('\n') + '\n');

    const indexed = await collectIndexedUsage([file], cutoff, opts(path));
    const direct = await collectRetainedUsage([file], cutoff);
    expect(indexed.ranges).toEqual(direct.ranges);
    expect(indexed.coverage).toEqual(direct.coverage);
    const directValues = (await Bun.file(file).text()).trim().split('\n').map(line => JSON.parse(line));
    const { Database } = await import('bun:sqlite');
    const db = new Database(path, { readonly: true });
    let indexedValues: unknown[];
    try {
        indexedValues = db.query<{ value: string }, []>('SELECT value FROM records ORDER BY offset').all().map(row => JSON.parse(row.value));
        const projected = JSON.stringify(indexedValues);
        expect(projected).not.toContain('DO NOT INDEX AUTO INPUT');
        expect(projected).not.toContain('not-valid');
    } finally { db.close(); }
    expect(reducedAutoMode(autoModeRecords(indexedValues!, file), file)).toEqual(
        reducedAutoMode(autoModeRecords(directValues, file), file),
    );
    expect(reducedAutoMode(autoModeRecords(indexedValues!, file), file).allTools.outcomes).toMatchObject({
        allowed: 1,
        unknown_outcome: 1,
    });

    let reads = 0;
    await collectIndexedUsage([file], cutoff, { ...opts(path), onReadSource() { reads++; } });
    expect(reads).toBe(0);

    await appendFile(file, '{"type":"system"');
    const indexedPartial = await collectIndexedUsage([file], cutoff, opts(path));
    const directPartial = await collectRetainedUsage([file], cutoff);
    expect(indexedPartial.ranges).toEqual(directPartial.ranges);
    expect(indexedPartial.coverage).toEqual(directPartial.coverage);

    await writeFile(file, [malformedStart, malformedEnd].map(value => JSON.stringify(value)).join('\n'));
    await collectIndexedUsage([file], cutoff, opts(path));
    const replacement = new Database(path, { readonly: true });
    try {
        const values = replacement.query<{ value: string }, []>('SELECT value FROM records ORDER BY offset').all().map(row => JSON.parse(row.value));
        expect(reducedAutoMode(autoModeRecords(values, file), file).allTools.outcomes.unknown_outcome).toBe(1);
    } finally { replacement.close(); }

    await collectIndexedUsage([], cutoff, opts(path));
    const removed = new Database(path, { readonly: true });
    try { expect(removed.query('SELECT value FROM records').all()).toEqual([]); }
    finally { removed.close(); }
});
test('excludes historical Auto mode inference and tool-result content', async () => {
    const { path, file } = await fixture();
    const mode = { type: 'system', subtype: 'run_facts', uuid: 'mode', timestamp: '2026-09-12T09:00:00.000Z', permissionMode: 'auto' };
    const blocked = row('historical-blocked', '2026-09-12T09:01:00.000Z');
    const uncertain = row('historical-uncertain', '2026-09-12T09:02:00.000Z');
    const result = (id: string, timestamp: string, content: string, is_error: boolean) => ({
        type: 'user', uuid: `result-${id}`, timestamp,
        message: { content: [{ type: 'tool_result', tool_use_id: id, is_error, content }] },
    });
    await writeFile(file, [
        mode,
        blocked,
        result('historical-blocked', '2026-09-12T09:01:01.000Z', 'Permission for this action has been denied. Reason: PRIVATE POLICY DETAIL', true),
        uncertain,
        result('historical-uncertain', '2026-09-12T09:02:01.000Z', 'PRIVATE ORDINARY RESULT', false),
    ].map(value => JSON.stringify(value)).join('\n'));

    const indexed = await collectIndexedUsage([file], cutoff, opts(path));
    const direct = await collectRetainedUsage([file], cutoff);
    expect(indexed.ranges).toEqual(direct.ranges);
    expect(Object.values(indexed.ranges['7d'].autoMode.allTools.outcomes).every(count => count === 0)).toBe(true);
    expect(indexed.ranges['7d'].autoMode.allTools.coverage.state).toBe('unavailable');

    const { Database } = await import('bun:sqlite');
    const db = new Database(path, { readonly: true });
    try {
        const projected = JSON.stringify(db.query('SELECT value FROM records').all());
        expect(projected).not.toContain('PRIVATE POLICY DETAIL');
        expect(projected).not.toContain('PRIVATE ORDINARY RESULT');
        expect(projected).not.toContain('historical_auto_mode_outcome');
        expect(projected).not.toContain('policy_blocked');
    } finally { db.close(); }
});
test('uses a successor index path for allowlisted analytics skill identifiers', () => {
    expect(usageIndexPath()).toEndWith('usage-dashboard/index-v14.sqlite');
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
test('oversized tool-result lines keep coverage complete; sources indexed before classification re-read once', async () => {
    const { path, file } = await fixture();
    const screenshot = { type: 'user', sessionId: 's', message: { role: 'user', content: [{ tool_use_id: 'toolu_1', type: 'tool_result', content: [{ type: 'image', source: { data: 'A'.repeat(4 * 1024 * 1024 + 1024) } }] }] }, uuid: 'shot', timestamp: cutoff };
    await writeFile(file, [row('old', '2026-08-01T00:00:00.000Z'), row('a'), screenshot].map(r => JSON.stringify(r)).join('\n') + '\n');
    const first = await collectIndexedUsage([file], cutoff, opts(path));
    expect(first.coverage).toMatchObject({ state: 'complete', oversizedRecords: 0, oversizedToolResults: 1 });
    expect(first.ranges['7d'].previousPeriod).toBeDefined();
    const db = new Database(path);
    try {
        const quality = JSON.parse(db.query<{ quality: string }, [string]>('SELECT quality FROM sources WHERE path=?').get(file)!.quality);
        delete quality.oversizedToolResults;
        db.query('UPDATE sources SET quality=? WHERE path=?').run(JSON.stringify({ ...quality, oversizedRecords: 1 }), file);
    } finally { db.close(); }
    let reads = 0;
    const reclassified = await collectIndexedUsage([file], cutoff, { ...opts(path), onReadSource: () => { reads++; } });
    expect(reads).toBe(1);
    expect(reclassified.coverage).toMatchObject({ state: 'complete', oversizedRecords: 0, oversizedToolResults: 1 });
    await collectIndexedUsage([file], cutoff, { ...opts(path), onReadSource: () => { reads++; } });
    expect(reads).toBe(1);
    await appendFile(file, JSON.stringify({ type: 'assistant', sessionId: 's', uuid: 'big', timestamp: cutoff, message: { id: 'big', content: [{ type: 'text', text: 'x'.repeat(4 * 1024 * 1024 + 1024) }] } }) + '\n');
    const unknown = await collectIndexedUsage([file], cutoff, opts(path));
    expect(unknown.coverage).toMatchObject({ state: 'partial', oversizedRecords: 1, oversizedToolResults: 1 });
    expect(unknown.ranges['7d'].previousPeriod).toBeUndefined();
});
test('appending to a source indexed before classification continues without a classified count', async () => {
    const { path, file } = await fixture();
    await writeFile(file, JSON.stringify(row('a')) + '\n');
    await collectIndexedUsage([file], cutoff, opts(path));
    const db = new Database(path);
    try {
        const quality = JSON.parse(db.query<{ quality: string }, [string]>('SELECT quality FROM sources WHERE path=?').get(file)!.quality);
        delete quality.oversizedToolResults;
        db.query('UPDATE sources SET quality=? WHERE path=?').run(JSON.stringify(quality), file);
    } finally { db.close(); }
    await appendFile(file, JSON.stringify(row('b')) + '\n');
    const metrics = emptyUsageIndexMetrics();
    const next = await collectIndexedUsage([file], cutoff, { ...opts(path), metrics });
    expect(metrics.prefixVerifiedBytes).toBeGreaterThan(0);
    expect(next.coverage).toMatchObject({ state: 'complete', oversizedToolResults: 0 });
    expect(next.ranges['7d'].requests).toBe(2);
    const stored = new Database(path, { readonly: true });
    try { expect(JSON.parse(stored.query<{ quality: string }, [string]>('SELECT quality FROM sources WHERE path=?').get(file)!.quality).oversizedToolResults).toBe(0); }
    finally { stored.close(); }
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


test('pre-activity aggregates replay unchanged metadata while preserving index and fitting versions', async () => {
    const { path, file } = await fixture();
    const request = row('patch');
    request.message.content = [{ type: 'tool_use', id: 'patch', name: 'apply_patch' }] as any;
    await writeFile(file, JSON.stringify(request));
    const original = await collectIndexedUsage([file], cutoff, opts(path));
    const db = new Database(path);
    try {
        db.query('UPDATE snapshot SET value=? WHERE id=1').run(JSON.stringify({ fittingVersion: 4, snapshot: original }));
    } finally { db.close(); }
    expect(readSavedUsage(path)).toBeNull();
    const metrics = emptyUsageIndexMetrics();
    const rebuilt = await collectIndexedUsage([file], cutoff, { ...opts(path), metrics, onReadSource() { throw new Error('unchanged source read'); } });
    expect(metrics.rowsReplayed).toBeGreaterThan(0);
    expect(rebuilt.countingVersion).toBe(23);
    expect(rebuilt.ranges['7d'].tools[0]!.patchModels).toMatchObject([{ label: 'model', requests: 1, results: 0, errors: 0 }]);
    expect(readSavedUsage(path)).toEqual(rebuilt);
});
test('pre-fix session identities rebuild from unchanged indexed events and then stay warm', async () => {
    const { path, file } = await fixture();
    const engineSessionId = '123e4567-e89b-42d3-a456-426614174000';
    await writeFile(file, [
        { ...row('before'), sessionId: engineSessionId, cwd: '/work/original' },
        { ...row('after'), sessionId: engineSessionId, cwd: '/work/destination' },
    ].map(value => JSON.stringify(value)).join('\n'));
    const original = await collectIndexedUsage([file], cutoff, opts(path));
    const stale = structuredClone(original);
    for (const summary of Object.values(stale.ranges)) {
        for (const item of summary.rankedSessions.items) item.engineSessionId = null;
        for (const day of summary.days) for (const item of day.contributors.items) item.engineSessionId = null;
    }
    const db = new Database(path);
    try {
        db.query('UPDATE snapshot SET value=? WHERE id=1').run(JSON.stringify({ fittingVersion: 1, snapshot: stale }));
    } finally { db.close(); }
    expect(readSavedUsage(path)).toBeNull();
    const metrics = emptyUsageIndexMetrics();
    const options = { ...opts(path), metrics, onReadSource() { throw new Error('Unchanged sources must reuse indexed events'); } };
    const rebuilt = await collectIndexedUsage([file], cutoff, options);
    expect(metrics.reusedAggregate).toBe(false);
    expect(metrics.rowsReplayed).toBeGreaterThan(0);
    for (const range of ['7d', '30d', 'all'] as const) {
        expect(rebuilt.ranges[range].tokens).toEqual(original.ranges[range].tokens);
        expect(rebuilt.ranges[range].rankedSessions.items[0]).toMatchObject({ engineSessionId, project: null });
        for (const day of rebuilt.ranges[range].days) for (const item of day.contributors.items)
            expect(item).toMatchObject({ engineSessionId, project: null });
    }
    expect(readSavedUsage(path)).toEqual(rebuilt);
    await collectIndexedUsage([file], cutoff, options);
    expect(metrics.reusedAggregate).toBe(true);
});

test('pre-span saved aggregates rebuild from unchanged indexed events and then stay warm', async () => {
    const { path, file } = await fixture();
    await writeFile(file, [row('first', '2026-09-12T09:00:00.000Z'), row('last', cutoff)].map(value => JSON.stringify(value)).join('\n'));
    const original = await collectIndexedUsage([file], cutoff, opts(path));
    const legacy = structuredClone(original);
    delete legacy.ranges['30d'].rankedSessions.items[0]!.firstActiveAt;
    replaceSavedSnapshot(path, legacy);
    expect(readSavedUsage(path)).toBeNull();
    let reads = 0, aggregates = 0;
    const options = { ...opts(path), onReadSource() { reads++; }, finalize(snapshot: typeof original) { aggregates++; return snapshot; } };
    const rebuilt = await collectIndexedUsage([file], cutoff, options);
    expect(reads).toBe(0);
    expect(aggregates).toBe(1);
    expect(rebuilt.ranges).toEqual(original.ranges);
    expect(rebuilt.ranges['30d'].rankedSessions.items[0]!.firstActiveAt).toBe('2026-09-12T09:00:00.000Z');
    expect(rebuilt.countingVersion).toBe(original.countingVersion);
    expect(readSavedUsage(path)?.ranges).toEqual(rebuilt.ranges);
    const warm = await collectIndexedUsage([file], cutoff, options);
    expect(reads).toBe(0);
    expect(aggregates).toBe(1);
    expect(warm.ranges).toEqual(rebuilt.ranges);
});

test.each(['unversioned', 'outdated'] as const)('%s fitted aggregates rebuild omitted rows from unchanged indexed events, then stay warm', async format => {
    const { path, file } = await fixture();
    await writeFile(file, JSON.stringify(row('contributor')));
    const original = await collectIndexedUsage([file], cutoff, opts(path));
    const stale = structuredClone(original);
    for (const key of ['7d', '30d', 'all'] as const) stale.ranges[key] = groupUsageSummary(stale.ranges[key], 8, 10, 0, 0, 0, 0);
    const db = new Database(path);
    try {
        db.query('UPDATE snapshot SET value=? WHERE id=1').run(JSON.stringify(format === 'unversioned' ? stale : { fittingVersion: 0, snapshot: stale }));
    } finally { db.close(); }
    expect(readSavedUsage(path)).toBeNull();
    let aggregates = 0;
    const options = {
        ...opts(path),
        onReadSource() { throw new Error('Unchanged sources must reuse indexed events'); },
        finalize(snapshot: typeof original) { aggregates++; return fitUsageDashboardSnapshot(snapshot); },
    };
    const rebuilt = await collectIndexedUsage([file], cutoff, options);
    expect(aggregates).toBe(1);
    for (const key of ['7d', '30d', 'all'] as const) {
        expect(rebuilt.ranges[key].rankedSessions.items).toHaveLength(1);
        expect(rebuilt.ranges[key].rankedSessions.omitted).toBe(0);
        expect(rebuilt.ranges[key].tokens).toEqual(stale.ranges[key].tokens);
    }
    expect(readSavedUsage(path)?.ranges).toEqual(rebuilt.ranges);
    const warm = await collectIndexedUsage([file], cutoff, options);
    expect(aggregates).toBe(1);
    expect(warm.ranges).toEqual(rebuilt.ranges);
});

test('legacy two-window cache rebuilds All from indexed records without reading unchanged sources', async () => {
    const { path, file } = await fixture();
    await writeFile(file, [row('old', '2020-01-01T00:00:00.000Z', 7), row('recent', cutoff, 11)].map(item => JSON.stringify(item)).join('\n'));
    const original = await collectIndexedUsage([file], cutoff, opts(path));
    const legacy = structuredClone(original) as any;
    delete legacy.ranges.all;
    replaceSavedSnapshot(path, legacy);
    expect(readSavedUsage(path)).toBeNull();
    let reads = 0;
    const rebuilt = await collectIndexedUsage([file], cutoff, { ...opts(path), onReadSource() { reads++; } });
    expect(reads).toBe(0);
    expect(rebuilt.ranges.all.tokens.fresh).toBe(18);
    expect(rebuilt.ranges).toEqual(original.ranges);
});

test('v17 grouped snapshots rebuild named categories from indexed records without rereading sources', async () => {
    const { path, file } = await fixture();
    await writeFile(file, JSON.stringify(row('a', cutoff, 18)));
    const original = await collectIndexedUsage([file], cutoff, opts(path));
    const legacy = structuredClone(original) as any;
    legacy.countingVersion = 17;
    legacy.ranges = {
        '7d': groupUsageSummary(legacy.ranges['7d'], 0, 0, 0),
        '30d': groupUsageSummary(legacy.ranges['30d'], 0, 0, 0),
        all: groupUsageSummary(legacy.ranges.all, 0, 0, 0),
    };
    replaceSavedSnapshot(path, legacy);
    expect(readSavedUsage(path)).toBeNull();
    let reads = 0;
    const options = { ...opts(path), finalize: fitUsageDashboardSnapshot, onReadSource() { reads++; } };
    const rebuilt = await collectIndexedUsage([file], cutoff, options);
    expect(reads).toBe(0);
    expect(rebuilt.countingVersion).toBe(23);
    expect(rebuilt.ranges['30d'].models.map(model => model.label)).toContain('model');
    expect(rebuilt.ranges['30d'].tools.map(tool => tool.label)).toContain('Bash');
    const warm = await collectIndexedUsage([file], cutoff, options);
    expect(reads).toBe(0);
    expect(warm.ranges).toEqual(rebuilt.ranges);
});

test('v19 snapshots hiding edit tools rebuild diagnostics from unchanged indexed records', async () => {
    const { path, file } = await fixture();
    const rows = [];
    for (const [tool, count, errors] of [['Bash', 20, 0], ['Read', 15, 0], ['Edit', 4, 3]] as const) {
        for (let index = 0; index < count; index++) {
            const id = `${tool}-${index}`;
            rows.push({
                ...row(id), version: '2.1.87-desktop.sha12345678',
                message: { id, model: 'model', usage: { input_tokens: 1 }, content: [{ type: 'tool_use', id, name: tool }] },
            });
            rows.push({
                type: 'user', sessionId: 's', uuid: `${id}-result`, timestamp: cutoff,
                message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: index < errors }] },
            });
        }
    }
    await writeFile(file, rows.map(value => JSON.stringify(value)).join('\n'));
    const original = await collectIndexedUsage([file], cutoff, opts(path));
    const legacy = structuredClone(original) as any;
    legacy.countingVersion = 19;
    for (const range of ['7d', '30d', 'all'] as const) legacy.ranges[range] = groupUsageSummary(legacy.ranges[range], 8, 0, 0, 0);
    replaceSavedSnapshot(path, legacy);
    expect(readSavedUsage(path)).toBeNull();
    let reads = 0;
    const options = { ...opts(path), finalize: fitUsageDashboardSnapshot, onReadSource() { reads++; } };
    const rebuilt = await collectIndexedUsage([file], cutoff, options);
    expect(reads).toBe(0);
    expect(rebuilt.countingVersion).toBe(23);
    for (const range of ['7d', '30d', 'all'] as const) {
        const edit = rebuilt.ranges[range].tools.find(tool => tool.label === 'Edit')!;
        expect(edit).toMatchObject({ requests: 4, results: 4, errors: 3 });
        expect(rebuilt.ranges[range].days.some(day => day.tools.find(tool => tool.id === edit.id)?.builds?.items[0]?.sha === '12345678')).toBe(true);
    }
    const warm = await collectIndexedUsage([file], cutoff, options);
    expect(reads).toBe(0);
    expect(warm.ranges).toEqual(rebuilt.ranges);
});

test('v20 grouped snapshots restore recent tool identities from indexed records without rereading sources', async () => {
    const { path, file } = await fixture();
    const tools = Array.from({ length: 6 }, (_, index) => `Recent tool ${index}`);
    const models = Array.from({ length: 8 }, (_, index) => `model-${index}`);
    const rows = [];
    for (let day = 0; day < 60; day++) for (const [toolIndex, name] of tools.entries()) for (let build = 0; build < 3; build++) {
        const id = `${day}-${toolIndex}-${build}`;
        const timestamp = new Date(Date.UTC(2026, 6, 15 + day, 10, build)).toISOString();
        rows.push({
            type: 'assistant', sessionId: 's', uuid: id, timestamp,
            version: `2.1.87-desktop.sha${build.toString(16).padStart(7, 'a')}`,
            message: { id, model: models[(day + toolIndex + build) % models.length], usage: { input_tokens: 1 }, content: [{ type: 'tool_use', id, name }] },
        });
        rows.push({
            type: 'user', sessionId: 's', uuid: `${id}-result`, timestamp,
            message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: toolIndex < 2 && build === 0 }] },
        });
    }
    await writeFile(file, rows.map(value => JSON.stringify(value)).join('\n'));
    const original = await collectIndexedUsage([file], cutoff, opts(path));
    const stale = structuredClone(original) as any;
    stale.countingVersion = 20;
    stale.ranges['7d'] = groupUsageSummary(stale.ranges['7d'], 8, 4, 0, 1);
    stale.ranges['30d'] = groupUsageSummary(stale.ranges['30d'], 8, 4, 0, 1);
    stale.ranges.all = groupUsageSummary(stale.ranges.all, 8, 4, 0, 1);
    expect(stale.ranges['7d'].tools.filter((tool: { kind: string }) => tool.kind === 'named')).toHaveLength(4);
    replaceSavedSnapshot(path, stale);
    expect(readSavedUsage(path)).toBeNull();

    let reads = 0;
    const options = { ...opts(path), finalize: fitUsageDashboardSnapshot, onReadSource() { reads++; } };
    const rebuilt = await collectIndexedUsage([file], cutoff, options);
    expect(reads).toBe(0);
    expect(rebuilt.countingVersion).toBe(23);
    for (const range of ['7d', '30d'] as const) {
        expect(rebuilt.ranges[range].tools.filter(tool => tool.kind === 'named').map(tool => tool.label).sort()).toEqual([...tools].sort());
        expect(rebuilt.ranges[range].tools.reduce((sum, tool) => sum + tool.requests, 0)).toBe(rebuilt.ranges[range].requests);
        expect(rebuilt.ranges[range].tools.filter(tool => tool.kind === 'named' && tool.errors > 0).map(tool => tool.label).sort()).toEqual(tools.slice(0, 2).sort());
    }
    expect(rebuilt.ranges.all.requests).toBe(1080);
    expect(rebuilt.ranges.all.days.reduce((sum, day) => sum + day.errors, 0)).toBe(120);
    expect(rebuilt.ranges['7d'].days.some(day => day.tools.some(tool => (tool.builds?.items.length ?? 0) > 0))).toBe(true);
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
    replaceSavedSnapshot(path, staleRates);
    expect(readSavedUsage(path)).toBeNull();
    let reads = 0;
    const rebuilt = await collectIndexedUsage([file], cutoff, { ...opts(path), onReadSource() { reads++; } });
    expect(reads).toBe(0);
    expect(rebuilt.pricingVersion).toBe(4);
    expect(rebuilt.ranges).toEqual(original.ranges);
});


test('older snapshots rebuild hourly tokens and daily outcomes from the index, then reuse them warm', async () => {
    const { path, file } = await fixture();
    const result = { type: 'user', sessionId: 's', uuid: 'result', timestamp: cutoff, message: { content: [{ type: 'tool_result', tool_use_id: 'request', is_error: true }] } };
    await writeFile(file, [row('request', '2026-09-12T23:00:00.000Z', 25), result].map(item => JSON.stringify(item)).join('\n'));
    const original = await collectIndexedUsage([file], cutoff, opts(path));
    const legacy = structuredClone(original) as any;
    legacy.version = 1;
    legacy.countingVersion = 13;
    for (const range of Object.values(legacy.ranges)) for (const day of range.days) {
        delete range.startDate;
        delete range.endDateExclusive;
        delete day.hours;
        delete (day as Partial<typeof day>).results;
        delete (day as Partial<typeof day>).errors;
    }
    replaceSavedSnapshot(path, legacy);
    expect(readSavedUsage(path)).toBeNull();
    let reads = 0;
    const options = { ...opts(path), onReadSource() { reads++; } };
    const rebuilt = await collectIndexedUsage([file], cutoff, options);
    expect(reads).toBe(0);
    expect(rebuilt.ranges).toEqual(original.ranges);
    expect(rebuilt.ranges['7d'].days.at(-2)).toMatchObject({ results: 1, errors: 1 });
    expect(rebuilt.ranges['7d'].days.at(-2)!.hours!.find(hour => hour.hour === 23)!.tokens).toBe(25);
    const warm = await collectIndexedUsage([file], '2026-09-13T12:01:00.000Z', options);
    expect(reads).toBe(0);
    expect(warm.ranges).toEqual(rebuilt.ranges);
});

async function failedIndex(path: string, file: string, install: (restore: Array<() => void>) => void) {
    const restore: Array<() => void> = [];
    try {
        install(restore);
        return await collectIndexedUsage([file], cutoff, opts(path)).then(() => null, (caught: unknown) => caught as UsageFailure);
    } finally { for (const undo of restore) undo(); }
}
async function savedWithAppend() {
    const { path, file } = await fixture();
    await writeFile(file, JSON.stringify(row('saved')) + '\n');
    const saved = await collectIndexedUsage([file], cutoff, opts(path));
    await appendFile(file, Array.from({ length: 1000 }, (_, id) => JSON.stringify(row(String(id)))).join('\n') + '\n');
    return { path, file, saved };
}
async function expectLastGood(path: string, saved: unknown) {
    expect(readSavedUsage(path)).toEqual(saved as never);
    const reader = new Database(path, { readonly: true });
    try { expect(reader.query<{ count: number }, []>('SELECT count(*) AS count FROM records').get()!.count).toBe(1); }
    finally { reader.close(); }
}
test('a full index while inserting records is capacity; the snapshot and its timestamp survive', async () => {
    const { path, file, saved } = await savedWithAppend();
    const exec = Database.prototype.exec;
    const error = await failedIndex(path, file, restore => {
        const spy = spyOn(Database.prototype, 'exec').mockImplementation(function (this: Database, sql: string) {
            const result = exec.call(this, sql);
            if (sql.startsWith('CREATE TABLE IF NOT EXISTS sources') && this.filename === path) {
                const pages = this.query<{ page_count: number }, []>('PRAGMA page_count').get()!.page_count;
                exec.call(this, `PRAGMA max_page_count=${pages + 2}`);
            }
            return result;
        });
        restore.push(() => spy.mockRestore());
    });
    expect(error).toBeInstanceOf(UsageFailure);
    expect({ reason: error!.reason, phase: error!.phase, guard: error!.detail.guard, sqliteCode: error!.detail.sqliteCode })
        .toEqual({ reason: 'storage-capacity', phase: 'index', guard: 'index-pages', sqliteCode: 'SQLITE_FULL' });
    // Sizes the history without describing it.
    expect(error!.detail.sources).toBe(1);
    expect(error!.detail.rows).toBeGreaterThanOrEqual(0);
    await expectLastGood(path, saved);
    expect(readSavedUsage(path)!.computedAt).toBe(saved.computedAt);
});
for (const statement of ['INSERT INTO records', 'INSERT OR REPLACE INTO sources'] as const) test(`SQLite I/O failure at "${statement}" is a storage failure, not capacity, and is never swallowed as an unreadable source`, async () => {
    const { path, file, saved } = await savedWithAppend();
    const query = Database.prototype.query;
    const error = await failedIndex(path, file, restore => {
        const spy = spyOn(Database.prototype, 'query').mockImplementation(function (this: Database, sql: string) {
            const prepared = query.call(this, sql);
            return sql.startsWith(statement) && this.filename === path
                ? { run: () => { throw Object.assign(new Error('injected /private/path I/O failure'), { code: 'SQLITE_IOERR' }); } } as never
                : prepared;
        } as never);
        restore.push(() => spy.mockRestore());
    });
    expect(error).toBeInstanceOf(UsageFailure);
    expect({ reason: error!.reason, phase: error!.phase, sqliteCode: error!.detail.sqliteCode }).toEqual({ reason: 'storage-failure', phase: 'index', sqliteCode: 'SQLITE_IOERR' });
    await expectLastGood(path, saved);
});
test('a database open failure is classified as index storage failure and releases the writer lock', async () => {
    const { path } = await fixture();
    await mkdir(path);
    await expect(collectIndexedUsage([], cutoff, opts(path))).rejects.toMatchObject({
        reason: 'storage-failure', phase: 'index', detail: { sqliteCode: 'SQLITE_CANTOPEN' },
    });
    expect(existsSync(path + '.lock')).toBe(false);
});
for (const failure of ['close', 'remove'] as const) test(`scratch ${failure} failure rolls back before publication and still attempts every teardown`, async () => {
    const { path, file, saved } = await savedWithAppend();
    const exec = Database.prototype.exec, close = Database.prototype.close, remove = fs.rmSync;
    let injected = false, diskPath = '', writerClosed = false;
    const error = await failedIndex(path, file, restore => {
        const cap = spyOn(Database.prototype, 'exec').mockImplementation(function (this: Database, sql: string) {
            const result = exec.call(this, sql);
            if (this.filename === ':memory:') exec.call(this, 'PRAGMA max_page_count=8');
            return result;
        });
        const closing = spyOn(Database.prototype, 'close').mockImplementation(function (this: Database, ...args: Parameters<Database['close']>) {
            if (this.filename.endsWith('/scratch.sqlite')) {
                diskPath = this.filename;
                if (failure === 'close' && !injected) {
                    injected = true;
                    throw Object.assign(new Error('scratch close failed'), { code: 'SQLITE_IOERR' });
                }
            }
            if (this.filename === path && injected) writerClosed = true;
            return close.apply(this, args);
        });
        const removing = spyOn(fs, 'rmSync').mockImplementation((target, options) => {
            if (failure === 'remove' && diskPath && String(target) === dirname(diskPath) && !injected) {
                injected = true;
                throw Object.assign(new Error('scratch removal denied'), { code: 'EACCES' });
            }
            return remove(target, options);
        });
        restore.push(() => cap.mockRestore(), () => closing.mockRestore(), () => removing.mockRestore());
    });
    expect(injected).toBe(true);
    expect(error).toMatchObject({ reason: 'storage-failure', phase: 'finalize' });
    expect(writerClosed).toBe(true);
    expect(existsSync(dirname(diskPath))).toBe(false);
    await expectLastGood(path, saved);
});
test('cleanup failure cannot mask a collection failure or skip durable connection teardown', async () => {
    const { path, file, saved } = await savedWithAppend();
    const close = Database.prototype.close;
    const original = new UsageFailure('original failure', 'deadline', 'finalize');
    let injected = false, writerClosed = false;
    const closing = spyOn(Database.prototype, 'close').mockImplementation(function (this: Database, ...args: Parameters<Database['close']>) {
        if (this.filename === ':memory:') {
            injected = true;
            close.apply(this, args);
            throw new Error('secondary close failure');
        }
        if (this.filename === path && injected) writerClosed = true;
        return close.apply(this, args);
    });
    try {
        await expect(collectIndexedUsage([file], cutoff, { ...opts(path), finalize() { throw original; } })).rejects.toBe(original);
        expect(injected).toBe(true);
        expect(writerClosed).toBe(true);
    } finally { closing.mockRestore(); }
    await expectLastGood(path, saved);
});
test('a durable close error after commit cannot report the published refresh as failed', async () => {
    const { path, file } = await fixture();
    await writeFile(file, JSON.stringify(row('published')) + '\n');
    const exec = Database.prototype.exec, close = Database.prototype.close;
    let writer: Database | undefined, injected = false;
    const observe = spyOn(Database.prototype, 'exec').mockImplementation(function (this: Database, sql: string) {
        if (this.filename === path && sql === 'BEGIN IMMEDIATE') writer = this;
        return exec.call(this, sql);
    });
    const closing = spyOn(Database.prototype, 'close').mockImplementation(function (this: Database, ...args: Parameters<Database['close']>) {
        const result = close.apply(this, args);
        if (this === writer) { injected = true; throw new Error('post-commit close failure'); }
        return result;
    });
    const logging = spyOn(debug, 'logForDebugging').mockImplementation(() => { throw new Error('diagnostic sink failed'); });
    try {
        const snapshot = await collectIndexedUsage([file], cutoff, opts(path));
        expect(injected).toBe(true);
        expect(readSavedUsage(path)).toEqual(snapshot);
    } finally { observe.mockRestore(); closing.mockRestore(); logging.mockRestore(); }
});
test('a deadline during indexing or replay names the phase that was running', async () => {
    const { path, file } = await fixture();
    await writeFile(file, Array.from({ length: 50 }, (_, id) => JSON.stringify(row(String(id)))).join('\n') + '\n');
    const expired = await collectIndexedUsage([file], cutoff, { path, deadline: Date.now() - 1 }).then(() => null, (caught: unknown) => caught as UsageFailure);
    expect({ reason: expired!.reason, phase: expired!.phase }).toEqual({ reason: 'deadline', phase: 'index' });
    const options = { ...opts(path), finalize(snapshot: Parameters<NonNullable<Parameters<typeof collectIndexedUsage>[2]['finalize']>>[0]) { options.deadline = Date.now() - 1; return snapshot; } };
    const failure = await collectIndexedUsage([file], cutoff, options).then(() => null, (caught: unknown) => caught as UsageFailure);
    expect({ reason: failure!.reason, phase: failure!.phase }).toEqual({ reason: 'deadline', phase: 'finalize' });
});
test('index metrics separate inserted rows from replayed rows and prefix verification', async () => {
    const { path, file } = await fixture();
    await writeFile(file, Array.from({ length: 300 }, (_, id) => JSON.stringify(row(String(id)))).join('\n') + '\n');
    const cold = emptyUsageIndexMetrics();
    await collectIndexedUsage([file], cutoff, { ...opts(path), metrics: cold });
    expect(cold).toMatchObject({ sourcesChanged: 1, rowsInserted: 300, rowsReplayed: 300, prefixVerifiedBytes: 0, reusedAggregate: false });
    expect(cold.retained.retainedEntries).toBeGreaterThan(0);
    const unchanged = emptyUsageIndexMetrics();
    await collectIndexedUsage([file], cutoff, { ...opts(path), metrics: unchanged });
    expect(unchanged).toMatchObject({ sourcesChanged: 0, rowsInserted: 0, rowsReplayed: 0, reusedAggregate: true });
    const size = (await stat(file)).size;
    await appendFile(file, JSON.stringify(row('late')) + '\n');
    const append = emptyUsageIndexMetrics();
    await collectIndexedUsage([file], cutoff, { ...opts(path), metrics: append });
    // One new row still replays the whole index and re-reads the old prefix.
    expect(append).toMatchObject({ sourcesChanged: 1, rowsInserted: 1, rowsReplayed: 301, prefixVerifiedBytes: size });
});

// Timing state lives in per-run scratch storage, never on the heap.
const timingRows = (calls: number, options: { split?: boolean; session?: string; retryEvery?: number } = {}) => {
    const session = options.session ?? 's';
    const at = (index: number) => new Date(Date.parse(cutoff) - (calls + 10) * 1000 + index * 1000).toISOString();
    const system = (subtype: string, index: number, fields: Record<string, unknown>) => ({ type: 'system', subtype, sessionId: session, uuid: `${subtype}-${session}-${index}-${String(fields.attempt_id ?? fields.tool_use_id)}`, timestamp: at(index), schema_version: 1, ...fields });
    const starts: unknown[] = [], ends: unknown[] = [];
    for (let i = 0; i < calls; i++) {
        const attempts = options.retryEvery && i % options.retryEvery === 0 ? 2 : 1;
        for (let attempt = 1; attempt <= attempts; attempt++) {
            const ids = { call_id: `call-${i}`, attempt_id: `call-${i}-a${attempt}` };
            starts.push(system('model_attempt_start', i, { ...ids, attempt_index: attempt, provider: 'firstParty', model: 'claude-sonnet-4-6', mode: attempt === 1 ? 'streaming' : 'non_streaming' }));
            if (attempt === 1 && i % 3 === 0) ends.push(system('model_attempt_first_text', i, { ...ids, duration_ms: 10 + i % 40 }));
            if (i % 11 !== 0) ends.push(system('model_attempt_end', i, { ...ids, outcome: attempt === attempts ? (i % 7 === 0 ? 'failed' : 'succeeded') : 'failed', duration_ms: 100 + (i * 37) % 900 }));
        }
        starts.push(system('tool_execution_start', i, { tool_use_id: `tool-${i}` }));
        if (i % 13 !== 0) ends.push(system('tool_execution_end', i, { tool_use_id: `tool-${i}`, outcome: i % 5 === 0 ? 'failed' : 'succeeded', duration_ms: 5 + (i * 11) % 300 }));
    }
    // An end that precedes its start, and a first-text longer than its end, are counted invalid.
    ends.unshift(system('model_attempt_end', 0, { call_id: 'ghost', attempt_id: 'ghost-a1', outcome: 'succeeded', duration_ms: 5 }));
    return options.split === false ? interleave(starts, ends) : [...starts, ...ends];
};
const interleave = (a: unknown[], b: unknown[]) => { const out: unknown[] = []; for (let i = 0; i < Math.max(a.length, b.length); i++) { if (i < a.length) out.push(a[i]); if (i < b.length) out.push(b[i]); } return out; };
const writeRows = (file: string, rows: unknown[]) => writeFile(file, rows.map(item => JSON.stringify(item)).join('\n') + '\n');

for (const target of ['timings', 'identities', 'sources', 'records'] as const) test(`one-time ${target} read I/O failure during replay rolls back instead of publishing partial coverage`, async () => {
    const { path, file } = await fixture();
    await writeRows(file, [row('saved')]);
    const saved = await collectIndexedUsage([file], cutoff, opts(path));
    await appendFile(file, timingRows(400).map(item => JSON.stringify(item)).join('\n') + '\n');
    const exec = Database.prototype.exec, query = Database.prototype.query;
    let injected = false, spilled = false;
    const error = await failedIndex(path, file, restore => {
        const cap = spyOn(Database.prototype, 'exec').mockImplementation(function (this: Database, sql: string) {
            const result = exec.call(this, sql);
            if (this.filename === ':memory:') exec.call(this, 'PRAGMA max_page_count=16');
            if (this.filename.endsWith('/scratch.sqlite')) spilled = true;
            return result;
        });
        const read = spyOn(Database.prototype, 'query').mockImplementation(function (this: Database, sql: string) {
            const prepared = query.call(this, sql);
            const matches = target === 'timings' || target === 'identities'
                ? this.filename.endsWith('/scratch.sqlite') && sql === `SELECT value FROM ${target} WHERE kind=? AND key=?`
                : this.filename === path && (target === 'sources' ? sql.startsWith('SELECT quality FROM sources') : sql.startsWith('SELECT value,offset,generation FROM records'));
            if (!matches) return prepared;
            const failOnce = () => {
                if (injected) return;
                injected = true;
                throw Object.assign(new Error('one-time replay read failure'), { code: 'SQLITE_IOERR' });
            };
            return target === 'records'
                ? { *iterate(...args: never[]) { failOnce(); yield* prepared.iterate(...args); } } as never
                : { get(...args: never[]) { failOnce(); return prepared.get(...args); } } as never;
        } as never);
        restore.push(() => cap.mockRestore(), () => read.mockRestore());
    });
    expect(injected).toBe(true);
    if (target === 'timings' || target === 'identities') expect(spilled).toBe(true);
    expect(error).toMatchObject({ reason: 'storage-failure', phase: 'replay', detail: { sqliteCode: 'SQLITE_IOERR' } });
    await expectLastGood(path, saved);
    const recovered = await collectIndexedUsage([file], cutoff, opts(path));
    expect(recovered.ranges).toEqual((await collectRetainedUsage([file], cutoff)).ranges);
});

test('timings read through scratch storage match the heap collector exactly, with a bounded newest-events timeline', async () => {
    const { path, file } = await fixture();
    const rows = [row('anchor'), ...timingRows(70, { retryEvery: 4 })];
    await writeRows(file, rows);
    const indexed = await collectIndexedUsage([file], cutoff, opts(path));
    const heap = await collectRetainedUsage([file], cutoff);
    expect(indexed.ranges).toEqual(heap.ranges);
    for (const range of ['7d', '30d', 'all'] as const) expect(indexed.ranges[range].timing.models.state).toBe('available');
    // 70 calls, 18 of them retried once more: 88 model attempts plus 70 tools, 158 events in one contributor.
    const timeline = indexed.ranges['7d'].days.at(-1)!.contributors.items[0]!.timeline;
    expect(timeline).toMatchObject({ state: 'truncated', omitted: 158 - 12 });
    expect(timeline.items).toHaveLength(12);
    const starts = timeline.items.map(item => item.startedAt);
    expect([...starts].sort()).toEqual(starts);
    expect(starts.at(-1)).toBe(new Date(Date.parse(cutoff) - 11_000).toISOString());
    expect(indexed.ranges['7d'].timing.models).toMatchObject({ logicalCalls: 70, retriedCalls: 18, streamingAttempts: 70 });
    expect(indexed.coverage.invalidTimings).toBeGreaterThan(0);
});

test('a changed timing persists even though scratch storage returns copies, across a memory-to-disk spill', async () => {
    const { path, file } = await fixture();
    await writeRows(file, [row('anchor'), ...timingRows(400)]);
    const exec = Database.prototype.exec;
    const close = Database.prototype.close;
    let capped = false, spilled = false;
    const limit = spyOn(Database.prototype, 'exec').mockImplementation(function (this: Database, sql: string) {
        const result = exec.call(this, sql);
        if (this.filename === ':memory:' && !capped) { capped = true; exec.call(this, 'PRAGMA max_page_count=32'); }
        return result;
    });
    const observe = spyOn(Database.prototype, 'close').mockImplementation(function (this: Database, ...args: Parameters<Database['close']>) {
        if (this.filename.endsWith('/scratch.sqlite')) spilled = true;
        return close.apply(this, args);
    });
    try {
        const indexed = await collectIndexedUsage([file], cutoff, opts(path));
        // Starts and ends are separated by hundreds of rows, so the spill falls between them.
        expect(spilled).toBe(true);
        expect(indexed.ranges).toEqual((await collectRetainedUsage([file], cutoff)).ranges);
        expect(indexed.ranges['7d'].timing.models.outcomes.succeeded).toBeGreaterThan(250);
        expect(indexed.ranges['7d'].timing.tools.duration.samples).toBeGreaterThan(250);
    } finally { observe.mockRestore(); limit.mockRestore(); }
});

test('tens of thousands of distinct timed calls stay inside the state budget the heap collector exceeded', async () => {
    const { path, file } = await fixture();
    const calls = 45_000;
    await writeRows(file, timingRows(calls, { split: false }));
    // The previous heap-resident design needed ~1.6 KiB per call and exhausted the 64 MiB budget here.
    await expect(collectRetainedUsage([file], cutoff)).rejects.toMatchObject({ reason: 'state-budget', detail: { guard: 'state-bytes' } });
    const metrics = emptyUsageIndexMetrics();
    const indexed = await collectIndexedUsage([file], cutoff, { ...opts(path), metrics });
    expect(metrics.retained.retainedBytes).toBeLessThan(2 * 1024 * 1024);
    expect(indexed.ranges['7d'].timing.models.logicalCalls).toBe(calls);
    expect(indexed.ranges['7d'].timing.tools.outcomes.started).toBe(calls);
    expect(readSavedUsage(path)).toEqual(indexed);
}, 120000);
