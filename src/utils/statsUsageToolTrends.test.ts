import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { groupUsageSummary } from '../../app/sidecar/usageSummary.js';
import { parseUsageCollectionResult } from '../../app/shared/usageStatsWorker.js';
import { collectRetainedUsage } from './statsUsage.js';

const roots: string[] = [];
afterEach(async () => { while (roots.length) await rm(roots.pop()!, { recursive: true, force: true }); });

async function collect(rows: unknown[], asOf = '2026-09-13T12:00:00.000Z') {
    const root = await mkdtemp(join(tmpdir(), 'usage-tool-trends-'));
    roots.push(root);
    const file = join(root, 'session.jsonl');
    await writeFile(file, rows.map(row => JSON.stringify(row)).join('\n'));
    return collectRetainedUsage([file], asOf);
}

function request(id: string, name: string, timestamp: string, version: string) {
    return { type: 'assistant', sessionId: 'session', uuid: `request-${id}`, timestamp, version, message: { id: `message-${id}`, model: 'model', usage: { input_tokens: 1 }, content: [{ type: 'tool_use', id, name }] } };
}

function result(id: string, timestamp: string, is_error: boolean, version = '2.1.87-desktop.sha99999999') {
    return { type: 'user', sessionId: 'session', uuid: `result-${id}`, timestamp, version, message: { content: [{ type: 'tool_result', tool_use_id: id, is_error }] } };
}

test('tool outcomes stay on the request day and request build across midnight', async () => {
    const snapshot = await collect([
        request('old', 'Bash', '2026-09-07T23:59:00.000Z', '2.1.87-desktop.sha1a2b3c4-dirty'),
        request('new', 'Bash', '2026-09-08T00:01:00.000Z', '2.1.87-dev.20260917.t123456.shaabcdef12'),
        result('old', '2026-09-08T00:02:00.000Z', true),
    ]);
    const first = snapshot.ranges['7d'].days.find(day => day.date === '2026-09-07')!.tools[0]!;
    const second = snapshot.ranges['7d'].days.find(day => day.date === '2026-09-08')!.tools[0]!;
    expect(first).toMatchObject({ requests: 1, results: 1, errors: 1 });
    expect(first.builds!.items).toEqual([{ sha: '1a2b3c4', dirty: true, requests: 1, results: 1, errors: 1, firstObservedAt: '2026-09-07T23:59:00.000Z' }]);
    expect(second).toMatchObject({ requests: 1, results: 0, errors: 0 });
    expect(second.builds!.items[0]).toMatchObject({ sha: 'abcdef12', dirty: false, results: 0, errors: 0 });
});

test('generic versions remain unattributed while mixed SHA builds remain distinct', async () => {
    const snapshot = await collect([
        request('one', 'Read', '2026-09-12T08:00:00.000Z', '2.1.87-desktop.sha11111111'),
        request('two', 'Read', '2026-09-12T09:00:00.000Z', '2.1.87-dev.20260917.t123456.sha22222222-dirty'),
        request('three', 'Read', '2026-09-12T10:00:00.000Z', '2.1.87-dev'),
        result('one', '2026-09-12T11:00:00.000Z', false),
        result('two', '2026-09-12T12:00:00.000Z', true),
        result('three', '2026-09-12T13:00:00.000Z', true),
    ]);
    const tool = snapshot.ranges['7d'].days.find(day => day.date === '2026-09-12')!.tools[0]!;
    expect(tool.builds!.items.map(build => [build.sha, build.dirty, build.requests, build.results, build.errors])).toEqual([
        ['11111111', false, 1, 1, 0], ['22222222', true, 1, 1, 1],
    ]);
    expect(tool.requests - tool.builds!.items.reduce((sum, build) => sum + build.requests, 0)).toBe(1);
    expect(tool.results - tool.builds!.items.reduce((sum, build) => sum + build.results, 0)).toBe(1);
    expect(tool.errors - tool.builds!.items.reduce((sum, build) => sum + build.errors, 0)).toBe(1);
});

test('range grouping chooses tools once, groups every day consistently, and keeps All sparse', async () => {
    const rows: unknown[] = [];
    for (let index = 0; index < 12; index++) rows.push(request(`first-${index}`, `Tool ${index}`, '2026-09-01T08:00:00.000Z', index % 2 ? '2.1.87-desktop.sha11111111' : '2.1.87-desktop.sha22222222'));
    for (let index = 0; index < 4; index++) rows.push(request(`last-${index}`, 'Tool 11', '2026-09-12T08:00:00.000Z', '2.1.87-desktop.sha33333333'));
    const snapshot = await collect(rows);
    const grouped = groupUsageSummary(snapshot.ranges.all, 8, 2, 0);
    const ids = new Set(grouped.tools.map(tool => tool.id));
    expect(grouped.tools.some(tool => tool.label === 'Tool 11')).toBe(true);
    expect(grouped.tools.some(tool => tool.kind === 'other')).toBe(true);
    expect(grouped.days.map(day => day.date)).toEqual(['2026-09-01', '2026-09-12']);
    expect(grouped.days.every(day => day.tools.every(tool => ids.has(tool.id)))).toBe(true);
    expect(grouped.days[0]!.tools.find(tool => tool.id === 'other')!.requests).toBeGreaterThan(0);
});

test('strict validation rejects impossible unattributed build outcome remainders', async () => {
    const snapshot = await collect([
        request('known', 'Bash', '2026-09-12T08:00:00.000Z', '2.1.87-desktop.sha11111111'),
        request('unknown', 'Bash', '2026-09-12T09:00:00.000Z', 'unknown'),
        result('known', '2026-09-12T10:00:00.000Z', false),
        result('unknown', '2026-09-12T11:00:00.000Z', true),
    ]);
    for (const range of ['7d', '30d', 'all'] as const) snapshot.ranges[range] = groupUsageSummary(snapshot.ranges[range]);
    expect(parseUsageCollectionResult({ type: 'usage', version: 1, snapshot })).not.toBeNull();
    const invalid = structuredClone(snapshot);
    const day = invalid.ranges['7d'].days.find(value => value.date === '2026-09-12')!;
    const build = day.tools[0]!.builds!.items[0]!;
    build.requests = 2;
    build.results = 2;
    expect(parseUsageCollectionResult({ type: 'usage', version: 1, snapshot: invalid })).toBeNull();
});
