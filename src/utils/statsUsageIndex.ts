import { Database } from 'bun:sqlite';
import { mkdir, stat, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { getClaudeConfigHomeDir } from './envUtils.js';
import { readStatsRecords, type StatsReadQuality } from './statsReader.js';
import { collectRetainedUsage, UsageResourceError, type UsageIdentityStore } from './statsUsage.js';
import { classifyHistoricalAutoModeToolResult, projectAutoModeDiagnosticPayload } from './autoModeUsage.js';
import type { UsageDashboardSnapshot } from '../../app/shared/usageDashboard.js';
import { parseUsageCollectionResult } from '../../app/shared/usageStatsWorker.js';

// Rebuildable derived state, separate from the engine's legacy statistics cache.
export const usageIndexPath = () => join(getClaudeConfigHomeDir(), 'usage-dashboard', 'index-v7.sqlite');
const fingerprint = (s: Awaited<ReturnType<typeof stat>>) => JSON.stringify([s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs, s.birthtimeMs]);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
/** Persist only fields needed for accounting, never prompts, responses or tool inputs. */
function projectRecord(v: unknown): unknown {
    if (!object(v) || !['assistant', 'user', 'system', 'attachment'].includes(String(v.type))) return null;
    const row: Record<string, unknown> = {};
    for (const key of ['type', 'sessionId', 'uuid', 'timestamp', 'cwd', 'version']) row[key] = typeof v[key] === 'string' ? v[key] : undefined;
    row.isSidechain = v.isSidechain === true;
    if (v.type === 'assistant' && object(v.message)) {
        const m = v.message, message: Record<string, unknown> = { id: typeof m.id === 'string' ? m.id : undefined, model: typeof m.model === 'string' ? m.model : undefined };
        if (object(m.usage)) {
            const u = m.usage;
            const scalar = (value: unknown) => value !== null && typeof value === 'object' ? 'invalid' : value;
            message.usage = Object.fromEntries(['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'].map(k => [k, scalar(u[k])]));
            if (object(u.input_tokens_details)) (message.usage as Record<string, unknown>).input_tokens_details = { cached_tokens: scalar(u.input_tokens_details.cached_tokens) };
        }
        // Keep original block indexes for missing-ID fallback identities.
        if (Array.isArray(m.content)) message.content = m.content.map(b => object(b) && b.type === 'tool_use' ? { type: b.type, id: typeof b.id === 'string' ? b.id : undefined, name: typeof b.name === 'string' ? b.name : undefined } : null);
        row.message = message;
    }
    if (v.type === 'user' && typeof v.permissionMode === 'string')
        row.permissionMode = v.permissionMode === 'auto' ? 'auto' : 'other';
    if (v.type === 'user' && object(v.message) && Array.isArray(v.message.content)) {
        row.message = { content: v.message.content.map(b => object(b) && b.type === 'tool_result'
            ? { type: b.type, tool_use_id: typeof b.tool_use_id === 'string' ? b.tool_use_id : undefined,
                is_error: b.is_error === undefined || typeof b.is_error === 'boolean' ? b.is_error : 'invalid',
                historical_auto_mode_outcome: b.is_error === true
                    ? classifyHistoricalAutoModeToolResult(b.content) ?? undefined
                    : undefined }
            : null) };
    }
    if (v.type === 'system' && typeof v.subtype === 'string') {
        const autoMode = projectAutoModeDiagnosticPayload(v);
        if (autoMode !== null) {
            row.subtype = 'auto_mode_observation';
            row.auto_mode = autoMode;
            return row;
        }
        if (v.subtype === 'run_facts' && typeof v.permissionMode === 'string') {
            row.subtype = 'run_facts';
            row.permissionMode = v.permissionMode === 'auto' ? 'auto' : 'other';
            return row;
        }
        const fields: Record<string, readonly string[]> = {
            model_attempt_start: ['schema_version', 'call_id', 'attempt_id', 'attempt_index', 'provider', 'model', 'mode'],
            model_attempt_first_text: ['schema_version', 'call_id', 'attempt_id', 'duration_ms'],
            model_attempt_end: ['schema_version', 'call_id', 'attempt_id', 'outcome', 'duration_ms'],
            tool_execution_start: ['schema_version', 'tool_use_id'],
            tool_execution_end: ['schema_version', 'tool_use_id', 'outcome', 'duration_ms'],
        };
        const allowed = fields[v.subtype];
        if (allowed) {
            row.subtype = v.subtype;
            for (const key of allowed) {
                const value = v[key];
                if (typeof value === 'string' || typeof value === 'number') row[key] = value;
            }
        }
    }
    return row;
}

export function readSavedUsage(path = usageIndexPath()): UsageDashboardSnapshot | null {
    let db: Database | undefined;
    try {
        db = new Database(path, { readonly: true });
        const row = db.query<{ value: string }, []>('SELECT value FROM snapshot WHERE id=1 AND length(CAST(value AS BLOB)) <= 262144').get();
        const parsed = row ? parseUsageCollectionResult({ type: 'usage', version: 1, snapshot: JSON.parse(row.value) }) : null;
        return parsed?.type === 'usage' ? parsed.snapshot : null;
    } catch { return null; }
    finally { db?.close(); }
}

type UsageIndexOptions = {
    path?: string;
    deadline: number;
    finalize?: (snapshot: UsageDashboardSnapshot) => UsageDashboardSnapshot;
    onReadSource?: (path: string) => void;
};
export async function collectIndexedUsage(files: readonly string[], asOf: string, options: UsageIndexOptions): Promise<UsageDashboardSnapshot> {
    const path = options.path ?? usageIndexPath();
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const { lock } = await import('./lockfile.js');
    const release = await lock(path, { realpath: false, stale: 180000, update: 30000, retries: 0 });
    try {
        try { return await collectIndexedUsageLocked(files, asOf, options); }
        catch (error) {
            const code = object(error) ? error.code : undefined;
            if (code !== 'SQLITE_CORRUPT' && code !== 'SQLITE_NOTADB') throw error;
            // Derived state only. The external writer lock also covers repair;
            // retain the damaged files and rebuild without touching transcripts.
            const suffix = `.corrupt-${randomUUID()}`;
            for (const part of ['', '-wal', '-shm']) {
                try { await rename(path + part, path + suffix + part); }
                catch (e) { if (!object(e) || e.code !== 'ENOENT') throw e; }
            }
            return await collectIndexedUsageLocked(files, asOf, options);
        }
    } finally { await release(); }
}

async function collectIndexedUsageLocked(files: readonly string[], asOf: string, options: UsageIndexOptions): Promise<UsageDashboardSnapshot> {
    const path = options.path ?? usageIndexPath();
    const db = new Database(path, { create: true });
    const check = () => { if (Date.now() > options.deadline) throw new Error('Usage collection timeout'); };
    try {
        // SQLite serializes writers, atomically publishes the index and snapshot,
        // and rolls back an interrupted refresh. Readers retain the last commit.
        db.exec('PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL; PRAGMA cache_size=-4096; PRAGMA max_page_count=262144;');
        db.exec('BEGIN IMMEDIATE');
        db.exec(`CREATE TABLE IF NOT EXISTS sources(path TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, quality TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS records(path TEXT NOT NULL, offset INTEGER NOT NULL, generation TEXT NOT NULL, timestamp REAL, value TEXT NOT NULL, PRIMARY KEY(path,offset)) WITHOUT ROWID;
          CREATE INDEX IF NOT EXISTS record_timestamps ON records(timestamp);
          CREATE TABLE IF NOT EXISTS snapshot(id INTEGER PRIMARY KEY, value TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS identities(kind TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(kind,key)) WITHOUT ROWID;
          DELETE FROM identities;`);
        const saved = readSavedUsage(path);
        let changed = false;
        const paths = new Set(files);
        for (const source of db.query<{ path: string }, []>('SELECT path FROM sources').all()) {
            if (!paths.has(source.path)) {
                db.query('DELETE FROM records WHERE path=?').run(source.path);
                db.query('DELETE FROM sources WHERE path=?').run(source.path);
                changed = true;
            }
        }
        const insert = db.query('INSERT INTO records VALUES (?,?,?,?,?)');
        for (const file of files) {
            check();
            const cached = db.query<{ fingerprint: string }, [string]>('SELECT fingerprint FROM sources WHERE path=?').get(file);
            let before;
            try { before = await stat(file); } catch { before = null; }
            if (before && cached?.fingerprint === fingerprint(before)) continue;
            changed = true;
            db.query('DELETE FROM records WHERE path=?').run(file);
            db.query('DELETE FROM sources WHERE path=?').run(file);
            try {
                options.onReadSource?.(file);
                const quality = await readStatsRecords(file, item => {
                    check();
                    const value = projectRecord(item.value);
                    if (value === null) return;
                    const timestamp = object(value) && typeof value.timestamp === 'string' ? Date.parse(value.timestamp) : NaN;
                    try { insert.run(file, item.offset, item.generation, Number.isFinite(timestamp) ? timestamp : null, JSON.stringify(value)); }
                    catch { throw new UsageResourceError('Usage index storage limit or write failure'); }
                }, { deadline: options.deadline });
                const after = await stat(file);
                // Retry changing files next time. The current bounded read remains
                // usable with its explicit coverage diagnostics.
                const stable = before && fingerprint(before) === fingerprint(after) && !quality.changedSources && !quality.shortReads && !quality.pendingTailBytes;
                db.query('INSERT INTO sources VALUES (?,?,?)').run(file, stable ? fingerprint(after) : '', JSON.stringify(quality));
            } catch (error) {
                check();
                if (error instanceof UsageResourceError) throw error;
                db.query('DELETE FROM records WHERE path=?').run(file);
                // Missing/unreadable sources are retried and counted by aggregation.
            }
        }
        const hasRecordBetween = (start: number, end: number) => db.query('SELECT 1 FROM records WHERE timestamp > ? AND timestamp <= ? LIMIT 1').get(start, end);
        const newlyEligible = saved && hasRecordBetween(Date.parse(saved.asOf), Date.parse(asOf));
        const newlyEligibleComparison = saved && ([7, 30] as const).some(days => hasRecordBetween(Date.parse(saved.asOf) - days * 86400000, Date.parse(asOf) - days * 86400000));
        let snapshot: UsageDashboardSnapshot;
        // Within one UTC day, totals remain valid until a record crosses either
        // the current or shifted prior cutoff. Preserve the warm path otherwise.
        if (!changed && saved && asOf >= saved.asOf && asOf.slice(0, 10) === saved.asOf.slice(0, 10) && !newlyEligible && !newlyEligibleComparison) {
            snapshot = structuredClone(saved);
            snapshot.asOf = asOf;
            snapshot.computedAt = new Date().toISOString();
            snapshot.snapshotId = randomUUID();
            for (const [days, range] of [[7, '7d'], [30, '30d']] as const) {
                const previous = snapshot.ranges[range].previousPeriod;
                if (previous) previous.endInclusive = new Date(Date.parse(asOf) - days * 86400000).toISOString();
            }
        } else {
            const get = db.query<{ value: string }, [string, string]>('SELECT value FROM identities WHERE kind=? AND key=?');
            const put = db.query('INSERT OR REPLACE INTO identities VALUES (?,?,?)');
            const digest = (key: string) => createHash('sha256').update(key).digest('hex');
            const identities: UsageIdentityStore = {
                map<T>(name: string) { return {
                    get(key: string): T | undefined { const row = get.get(name, digest(key)); return row ? JSON.parse(row.value) as T : undefined; },
                    set(key: string, value: T) { try { put.run(name, digest(key), JSON.stringify(value)); } catch { throw new UsageResourceError('Usage identity storage limit or write failure'); } },
                }; },
                set(name: string) { const map = this.map<boolean>(name); return { has: key => map.get(key) === true, add: key => map.set(key, true) }; },
            };
            snapshot = await collectRetainedUsage(files, asOf, { deadline: options.deadline, identities,
                readRecords: async (file, consume) => {
                    const source = db.query<{ quality: string }, [string]>('SELECT quality FROM sources WHERE path=?').get(file);
                    if (!source) throw new Error('Usage source unavailable');
                    for (const row of db.query<{ value: string; offset: number; generation: string }, [string]>('SELECT value,offset,generation FROM records WHERE path=? ORDER BY offset').iterate(file)) {
                        check();
                        await consume({ value: JSON.parse(row.value), offset: row.offset, generation: row.generation });
                    }
                    return JSON.parse(source.quality) as StatsReadQuality;
                },
            });
            snapshot = options.finalize?.(snapshot) ?? snapshot;
        }
        check();
        db.query('INSERT OR REPLACE INTO snapshot VALUES (1,?)').run(JSON.stringify(snapshot));
        db.exec('DELETE FROM identities; COMMIT;');
        return snapshot;
    } catch (error) {
        try { db.exec('ROLLBACK'); } catch { /* Opening/schema failures have no transaction. */ }
        if (object(error) && error.code === 'SQLITE_FULL') throw new UsageResourceError('Usage index storage limit');
        throw error;
    } finally { db.close(); }
}
