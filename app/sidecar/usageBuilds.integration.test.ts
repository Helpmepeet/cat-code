import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { collectIndexedUsage, emptyUsageIndexMetrics, readSavedUsage } from '../../src/utils/statsUsageIndex.js';
import { fitUsageDashboardSnapshot, groupUsageSummary } from './usageSummary.js';
import { MAX_USAGE_RECORD_BYTES } from '../shared/usageDashboard.js';
import { parseUsageCollectionResult } from '../shared/usageStatsWorker.js';
import { analyticsBuildGeometry } from '../renderer/src/usageAnalyticsChartState.js';
import { usageLatestBuild } from '../renderer/src/usageDailyChartState.js';

test('indexed history preserves exact build rates through envelope fitting, zero daily detail, and stale-cache replay', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'usage-build-regression-'));
    try {
        const file = join(dir, 'synthetic.jsonl'), path = join(dir, 'index.sqlite');
        const rows = [];
        for (let day = 0; day < 35; day++) for (let session = 0; session < 20; session++) {
            const id = `${day}-${session}`, timestamp = new Date(Date.UTC(2026, 7, 10 + day, 10)).toISOString();
            rows.push({ type: 'assistant', sessionId: `session-${session}`, uuid: id, timestamp,
                version: `2.1.87-desktop.sha${day % 2 ? 'aaaaaaa' : 'bbbbbbb-dirty'}`,
                message: { id, model: `model-${session % 8}`, usage: { input_tokens: session + 1 }, content: Array.from({ length: 24 }, (_, i) => ({ type: 'tool_use', id: `${id}-${i}`, name: `Tool-${i}` })) },
            });
            rows.push({ type: 'user', sessionId: `session-${session}`, uuid: `${id}-result`, timestamp,
                message: { content: Array.from({ length: 24 }, (_, i) => ({ type: 'tool_result', tool_use_id: `${id}-${i}`, is_error: i === 0 && session % 2 === 0 })) },
            });
        }
        await writeFile(file, rows.map(row => JSON.stringify(row)).join('\n'));
        const options = { path, timezone: 'UTC', deadline: Date.now() + 60000, finalize: fitUsageDashboardSnapshot };
        const snapshot = await collectIndexedUsage([file], '2026-09-13T12:00:00.000Z', options);
        const result = { type: 'usage', version: 1, snapshot };
        expect(parseUsageCollectionResult(result)?.type).toBe('usage');
        expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(MAX_USAGE_RECORD_BYTES);
        for (const range of Object.values(snapshot.ranges)) {
            expect(range.builds?.items).toHaveLength(2);
            expect(range.builds!.items.reduce((sum, build) => sum + build.results, 0)).toBe(range.requests);
            const minimal = groupUsageSummary(range, 0, 0, 0, 0, 0, 0, 0);
            expect(minimal.days.every(day => day.tools.every(tool => !tool.builds?.items.length))).toBe(true);
            const points = analyticsBuildGeometry(minimal, 600).points;
            expect(points).toHaveLength(2);
            expect(points.every(point => Math.abs(point.rate - 10 / 480 * 100) < 1e-9)).toBe(true);
            // Reused commits keep their first observation, not their last request.
            expect(usageLatestBuild(minimal).latest?.sha).toBe(range.range === '30d' ? 'bbbbbbb' : 'aaaaaaa');
        }
        const db = new Database(path);
        try {
            const saved = JSON.parse(db.query<{ value: string }, []>('SELECT value FROM snapshot WHERE id=1').get()!.value);
            saved.fittingVersion = 4;
            for (const range of Object.values(saved.snapshot.ranges) as any[]) delete range.builds;
            db.query('UPDATE snapshot SET value=? WHERE id=1').run(JSON.stringify(saved));
        } finally { db.close(); }
        expect(readSavedUsage(path)).toBeNull();
        const metrics = emptyUsageIndexMetrics();
        const replayOptions = { ...options, metrics, onReadSource() { throw new Error('Unchanged transcripts must reuse indexed events'); } };
        const rebuilt = await collectIndexedUsage([file], snapshot.asOf, replayOptions);
        expect(metrics.reusedAggregate).toBe(false);
        expect(metrics.rowsReplayed).toBeGreaterThan(0);
        expect(Object.values(rebuilt.ranges).map(range => range.builds)).toEqual(Object.values(snapshot.ranges).map(range => range.builds));
        const warm = await collectIndexedUsage([file], snapshot.asOf, replayOptions);
        expect(metrics.reusedAggregate).toBe(true);
        expect(warm.ranges).toEqual(rebuilt.ranges);
    } finally { await rm(dir, { recursive: true, force: true }); }
}, 30000);
