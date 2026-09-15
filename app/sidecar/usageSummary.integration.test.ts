import { expect, test } from 'bun:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { collectRetainedUsage } from '../../src/utils/statsUsage.js';
import { groupUsageSummary } from './usageSummary.js';
import { parseUsageCollectionLine, parseUsageCollectionResult } from '../shared/usageStatsWorker.js';
import { MAX_USAGE_RECORD_BYTES } from '../shared/usageDashboard.js';
test('B1-B3/V1: populated two-range grouping retains exact totals and fits the byte envelope', async () => {
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
        for (const range of ['7d', '30d'] as const)
            snapshot.ranges[range] = groupUsageSummary(raw[range]);
        const result = { type: 'usage' as const, version: 1 as const, snapshot };
        expect(parseUsageCollectionResult(result)).toEqual(result);
        const line = JSON.stringify(result), size = Buffer.byteLength(line);
        console.info(`bounded two-range fixture: ${size} UTF-8 bytes; source categories 24 models / 24 tools`);
        expect(size).toBeLessThan(MAX_USAGE_RECORD_BYTES);
        expect(snapshot.ranges['30d'].tokens).toEqual({ fresh: 72000, read: 36000, write: 18000, output: 18000 });
        expect(snapshot.ranges['30d'].models).toHaveLength(9);
        expect(snapshot.ranges['30d'].tools).toHaveLength(11);
        expect(parseUsageCollectionLine(line + ' '.repeat(MAX_USAGE_RECORD_BYTES - size))).not.toBeNull();
        expect(parseUsageCollectionLine(line + ' '.repeat(MAX_USAGE_RECORD_BYTES - size + 1))).toBeNull();
        for (const range of ['7d', '30d'] as const)
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
