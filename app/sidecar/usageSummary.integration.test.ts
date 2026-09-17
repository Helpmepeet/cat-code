import { expect, test } from 'bun:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { collectRetainedUsage } from '../../src/utils/statsUsage.js';
import { collectIndexedUsage } from '../../src/utils/statsUsageIndex.js';
import { fitUsageDashboardSnapshot, groupUsageSummary } from './usageSummary.js';
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
        fitUsageDashboardSnapshot(snapshot);
        const output = parseUsageCollectionResult({ type: 'usage', version: 1, snapshot });
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
        snapshot.ranges = raw;
        fitUsageDashboardSnapshot(snapshot);
        const output = parseUsageCollectionResult({ type: 'usage', version: 1, snapshot });
        expect(output?.type).toBe('usage');
        expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThan(MAX_USAGE_RECORD_BYTES);
        expect(snapshot.ranges['30d'].days.every(day => day.contributors.state === 'truncated')).toBe(true);
        for (const day of snapshot.ranges['30d'].days) for (const metric of ['tokens', 'requests', 'errors'] as const)
            expect(day.contributors.items.some(item => item.rank?.[metric] === 1)).toBe(true);
    } finally { await rm(dir, { recursive: true, force: true }); }
});

test('ordinary untimed history keeps named models and tools through the production envelope finalizer', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'usage-category-fallback-'));
    try {
        const path = join(dir, 'history.jsonl');
        const rows = [];
        for (let day = 0; day < 30; day++) for (let session = 0; session < 25; session++) {
            const timestamp = new Date(Date.UTC(2026, 7, 15 + day, 10)).toISOString();
            const key = `${day}-${session}`;
            rows.push({
                type: 'assistant', sessionId: `session-${session}`, uuid: key, timestamp,
                message: {
                    id: key, model: `model-${session % 4}`, usage: { input_tokens: session + 1, output_tokens: 1 },
                    content: Array.from({ length: 30 }, (_, tool) => ({ type: 'tool_use', id: `${key}-${tool}`, name: `Tool ${tool}` })),
                },
            });
        }
        await writeFile(path, rows.map(row => JSON.stringify(row)).join('\n'));
        const snapshot = await collectRetainedUsage([path], '2026-09-13T12:00:00.000Z');
        fitUsageDashboardSnapshot(snapshot);
        const output = parseUsageCollectionResult({ type: 'usage', version: 1, snapshot });
        expect(output?.type).toBe('usage');
        expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThan(MAX_USAGE_RECORD_BYTES);
        const range = snapshot.ranges['30d'];
        expect(range.models.filter(model => model.kind === 'named').map(model => model.label).sort()).toEqual(['model-0', 'model-1', 'model-2', 'model-3']);
        expect(range.models.some(model => model.kind === 'other')).toBe(false);
        expect(range.tools.filter(tool => tool.kind === 'named')).toHaveLength(10);
        expect(range.tools.find(tool => tool.kind === 'other')).toMatchObject({ requests: 15_000, results: 0, errors: 0 });
        expect(range.detail).toEqual({ state: 'grouped', omittedModels: 0, omittedTools: 20 });
        expect(range.requests).toBe(22_500);
        expect(range.tools.reduce((sum, tool) => sum + tool.requests, 0)).toBe(range.requests);
        const retainedIds = new Set(range.tools.map(tool => tool.id));
        expect(range.days.every(day => day.tools.every(tool => retainedIds.has(tool.id)))).toBe(true);
        expect(range.days.every(day => day.contributors.items.length <= 5)).toBe(true);
        expect(range.timing.models.state).toBe('unavailable');
        expect(range.timing.tools.state).toBe('unavailable');
    } finally { await rm(dir, { recursive: true, force: true }); }
});

test('many daily build markers fall back to exact omitted totals within the envelope', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'usage-build-fallback-'));
    try {
        const path = join(dir, 'builds.jsonl');
        const rows = [];
        for (let day = 0; day < 180; day++) for (let tool = 0; tool < 10; tool++) for (let build = 0; build < 10; build++) {
            const timestamp = new Date(Date.UTC(2026, 2, 18 + day, 10)).toISOString();
            const key = `${day}-${tool}-${build}`;
            rows.push({
                type: 'assistant', sessionId: 'session', uuid: key, timestamp,
                version: `2.1.87-desktop.sha${build.toString(16).padStart(7, 'a')}`,
                message: { id: key, model: 'model', usage: { input_tokens: 1 }, content: [{ type: 'tool_use', id: key, name: `Tool${tool}` }] },
            });
        }
        await writeFile(path, rows.map(row => JSON.stringify(row)).join('\n'));
        const snapshot = await collectRetainedUsage([path], '2026-09-13T12:00:00.000Z');
        const raw = snapshot.ranges;
        snapshot.ranges = {
            '7d': groupUsageSummary(raw['7d']),
            '30d': groupUsageSummary(raw['30d']),
            all: groupUsageSummary(raw.all, 8, 10, 0),
        };
        expect(parseUsageCollectionResult({ type: 'usage', version: 1, snapshot })).toBeNull();

        snapshot.ranges = raw;
        fitUsageDashboardSnapshot(snapshot);
        const output = parseUsageCollectionResult({ type: 'usage', version: 1, snapshot });
        expect(output?.type).toBe('usage');
        expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThan(MAX_USAGE_RECORD_BYTES);
        expect(snapshot.ranges.all.requests).toBe(18_000);
        for (const day of snapshot.ranges.all.days) {
            expect(day.tools).toHaveLength(1);
            expect(day.tools[0]!.builds!.items).toEqual([]);
            expect(day.tools[0]!.builds!.omitted).toMatchObject({ count: 10, requests: 100 });
        }
    } finally { await rm(dir, { recursive: true, force: true }); }
});

test('busy measured history keeps bounded session timelines after envelope fallback', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'usage-timeline-fallback-'));
    try {
        const path = join(dir, 'timelines.jsonl');
        const rows = [];
        for (let day = 0; day < 30; day++) for (let session = 0; session < 25; session++) {
            const date = new Date(Date.UTC(2026, 7, 15 + day, 10));
            const timestamp = date.toISOString();
            rows.push({ type: 'assistant', sessionId: `session-${session}`, uuid: `usage-${day}-${session}`, timestamp, message: { id: `usage-${day}-${session}`, model: 'model', usage: { input_tokens: session + 1 }, content: [] } });
            for (let attempt = 0; attempt < 12; attempt++) {
                date.setUTCSeconds(attempt + 1);
                rows.push({
                    type: 'system', subtype: 'model_attempt_start', sessionId: `session-${session}`,
                    uuid: `attempt-${day}-${session}-${attempt}`, timestamp: date.toISOString(),
                    schema_version: 1, call_id: `call-${day}-${session}-${attempt}`,
                    attempt_id: `attempt-${day}-${session}-${attempt}`, attempt_index: 1,
                    provider: 'firstParty', model: 'claude-sonnet-4-6', mode: 'streaming',
                });
            }
        }
        await writeFile(path, rows.map(row => JSON.stringify(row)).join('\n'));
        const snapshot = await collectRetainedUsage([path], '2026-09-13T12:00:00.000Z');
        fitUsageDashboardSnapshot(snapshot);
        const output = parseUsageCollectionResult({ type: 'usage', version: 1, snapshot });
        expect(output?.type).toBe('usage');
        expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThan(MAX_USAGE_RECORD_BYTES);
        const measuredDays = snapshot.ranges['30d'].days.filter(day => day.contributors.items.length > 0);
        expect(measuredDays).toHaveLength(30);
        expect(measuredDays.every(day => day.contributors.items.some(item => item.timeline.items.length > 0))).toBe(true);
        expect(measuredDays.every(day => day.contributors.items.every(item => item.timeline.state === 'truncated'))).toBe(true);
    } finally { await rm(dir, { recursive: true, force: true }); }
});
