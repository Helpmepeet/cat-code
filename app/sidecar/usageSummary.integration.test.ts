import { expect, test } from 'bun:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { collectRetainedUsage } from '../../src/utils/statsUsage.js';
import { collectIndexedUsage } from '../../src/utils/statsUsageIndex.js';
import { groupUsageSummary } from './usageSummary.js';
import { parseUsageCollectionLine, parseUsageCollectionResult } from '../shared/usageStatsWorker.js';
import { MAX_USAGE_RECORD_BYTES } from '../shared/usageDashboard.js';
test('B1-B3/V1: populated three-range grouping retains exact totals and fits the byte envelope', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'usage-size-'));
    try {
        const path = join(dir, 's.jsonl'), rows = [];
        for (let day = 0; day < 30; day++)
            for (let model = 0; model < 24; model++) {
                const timestamp = new Date(Date.UTC(2026, 7, 15 + day, 10)).toISOString();
                rows.push({ type: 'assistant', sessionId: 's', uuid: `${day}-${model}`, timestamp, message: { id: `${day}-${model}`, model: '模型'.repeat(100) + model, usage: { input_tokens: 100, cache_read_input_tokens: 50, cache_creation_input_tokens: 25, output_tokens: 25 }, content: [{ type: 'tool_use', id: `${day}-${model}`, name: '工具'.repeat(100) + model }] } });
            }
        await writeFile(path, rows.map(r => JSON.stringify(r)).join('\n'));
        const snapshot = await collectRetainedUsage([path], '2026-09-13T10:30:00.000Z');
        const raw = structuredClone(snapshot.ranges);
        for (const range of ['7d', '30d', 'all'] as const)
            snapshot.ranges[range] = groupUsageSummary(raw[range]);
        const result = { type: 'usage' as const, version: 1 as const, snapshot };
        expect(parseUsageCollectionResult(result)).toEqual(result);
        const line = JSON.stringify(result), size = Buffer.byteLength(line);
        console.info(`bounded three-range fixture: ${size} UTF-8 bytes; source categories 24 models / 24 tools`);
        expect(size).toBeLessThan(MAX_USAGE_RECORD_BYTES);
        expect(snapshot.ranges['30d'].tokens).toEqual({ fresh: 72000, read: 36000, write: 18000, output: 18000 });
        expect(snapshot.ranges['30d'].models).toHaveLength(9);
        expect(snapshot.ranges['30d'].tools).toHaveLength(11);
        expect(parseUsageCollectionLine(line + ' '.repeat(MAX_USAGE_RECORD_BYTES - size))).not.toBeNull();
        expect(parseUsageCollectionLine(line + ' '.repeat(MAX_USAGE_RECORD_BYTES - size + 1))).toBeNull();
        for (const range of ['7d', '30d', 'all'] as const)
            snapshot.ranges[range] = groupUsageSummary(raw[range], 0, 0);
        expect(snapshot.ranges['30d'].detail.state).toBe('summary-only');
        expect(parseUsageCollectionResult(result)).not.toBeNull();
        const bad = structuredClone(result);
        bad.snapshot.ranges['7d'].models[0]!.tokens.fresh++;
        bad.snapshot.ranges['7d'].models[0]!.tokens.output--;
        expect(parseUsageCollectionResult(bad)).toBeNull();
    }
    finally {
        await rm(dir, { recursive: true, force: true });
    }
});


test('multi-year history fits the snapshot limit through truthful detail fallback with exact totals', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'usage-long-'));
    try {
        const path = join(dir, 's.jsonl');
        const rows = [];
        for (let index = 0; index < 1100; index++) {
            const timestamp = new Date(Date.UTC(2023, 8, 10 + index, 10)).toISOString();
            for (let session = 0; session < 6; session++) for (let model = 0; model < 5; model++) rows.push({ type: 'assistant', sessionId: `session${session}`, uuid: `${index}-${model}`, timestamp, message: { id: `${index}-${model}`, model: 'model' + String(model) + 'x'.repeat(150), usage: { input_tokens: 1 }, content: [{ type: 'tool_use', id: `${index}-${model}`, name: 'Bash' }] } });
        }
        await writeFile(path, rows.map(row => JSON.stringify(row)).join('\n'));
        const snapshot = await collectIndexedUsage([path], '2026-09-13T12:00:00.000Z', { path: join(dir, 'index.sqlite'), deadline: Date.now() + 60000 });
        const raw = snapshot.ranges;
        let output = null;
        for (const [limit, contributors] of [[8, 20], [4, 10], [0, 5], [0, 0]] as const) {
            snapshot.ranges = {
                '7d': groupUsageSummary(raw['7d'], limit, limit === 8 ? 10 : limit, contributors),
                '30d': groupUsageSummary(raw['30d'], limit, limit === 8 ? 10 : limit, contributors),
                all: groupUsageSummary(raw.all, limit, limit === 8 ? 10 : limit, 0),
            };
            output = parseUsageCollectionResult({ type: 'usage', version: 1, snapshot });
            if (output) break;
        }
        expect(output?.type).toBe('usage');
        expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThan(MAX_USAGE_RECORD_BYTES);
        expect(snapshot.ranges.all.tokens.fresh).toBe(33000);
        expect(snapshot.ranges.all.requests).toBe(33000);
        expect(snapshot.ranges.all.activeDays).toBe(1100);
        expect(snapshot.ranges.all.days.length).toBeLessThanOrEqual(180);
        expect(snapshot.ranges.all.days.every(day => day.sessions === 6)).toBe(true);
    } finally { await rm(dir, { recursive: true, force: true }); }
});

test('multi-metric contributor leaders fit through the existing detail fallback tiers', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'usage-contributors-'));
    try {
        const path = join(dir, 'sessions.jsonl');
        const rows = [];
        for (let day = 0; day < 30; day++) for (let session = 0; session < 25; session++) {
            const timestamp = new Date(Date.UTC(2026, 7, 15 + day, 10)).toISOString();
            rows.push({ type: 'assistant', sessionId: `session-${session}`, uuid: `${day}-${session}`, timestamp, message: { id: `${day}-${session}`, model: 'claude-sonnet-4-5-20250929', usage: { input_tokens: session + 1, output_tokens: 1, cache_read_input_tokens: 1, cache_creation_input_tokens: 1 }, content: [{ type: 'tool_use', id: `${day}-${session}`, name: 'Bash' }] } });
        }
        await writeFile(path, rows.map(row => JSON.stringify(row)).join('\n'));
        const snapshot = await collectRetainedUsage([path], '2026-09-13T12:00:00.000Z');
        const raw = snapshot.ranges;
        snapshot.ranges = { '7d': groupUsageSummary(raw['7d']), '30d': groupUsageSummary(raw['30d']), all: groupUsageSummary(raw.all, 8, 10, 0) };
        expect(parseUsageCollectionResult({ type: 'usage', version: 1, snapshot })).toBeNull();
        let output = null;
        for (const [limit, contributors] of [[4, 10], [0, 5], [0, 0]] as const) {
            snapshot.ranges = {
                '7d': groupUsageSummary(raw['7d'], limit, limit, contributors),
                '30d': groupUsageSummary(raw['30d'], limit, limit, contributors),
                all: groupUsageSummary(raw.all, limit, limit, 0),
            };
            output = parseUsageCollectionResult({ type: 'usage', version: 1, snapshot });
            if (output) break;
        }
        expect(output?.type).toBe('usage');
        expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThan(MAX_USAGE_RECORD_BYTES);
        expect(snapshot.ranges['30d'].days.every(day => day.contributors.state === 'truncated')).toBe(true);
        for (const day of snapshot.ranges['30d'].days) for (const metric of ['tokens', 'requests', 'errors'] as const)
            expect(day.contributors.items.some(item => item.rank?.[metric] === 1)).toBe(true);
    } finally { await rm(dir, { recursive: true, force: true }); }
});
