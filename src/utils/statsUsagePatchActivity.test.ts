import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { observedPatchFollowups, type PatchActivityCall } from './statsUsagePatchActivity.js';
import { collectRetainedUsage } from './statsUsage.js';
import { collectIndexedUsage, emptyUsageIndexMetrics, readSavedUsage } from './statsUsageIndex.js';
import { fitUsageDashboardSnapshot, groupUsageSummary } from '../../app/sidecar/usageSummary.js';
import { parseUsageCollectionResult } from '../../app/shared/usageStatsWorker.js';
import { MAX_USAGE_RECORD_BYTES } from '../../app/shared/usageDashboard.js';

const call = (key: string, timestamp: number, error?: boolean, scope = 'agent-a', kind: PatchActivityCall['kind'] = 'patch'): PatchActivityCall => ({ key, scope, timestamp, kind, ...(error === undefined ? {} : { result: { timestamp: timestamp + 1, error } }) });
test('failed-call sequences group repeat failures and separate actual agent scopes', () => {
    expect(observedPatchFollowups([
        call('a1', 10, true), call('a2', 20, true), call('a3', 30, false),
        call('b1', 11, true, 'agent-b'), call('b2', 21, false, 'agent-b', 'write'),
    ])).toEqual([
        { origin: 'a1', retryCalls: 2, repeatErrors: 1, state: 'retry-result-success' },
        { origin: 'b1', retryCalls: 0, repeatErrors: 0, state: 'write-switch' },
    ]);
});
test('switches and unavailable outcomes never imply that the intended edit succeeded', () => {
    for (const [kind, state] of [['edit', 'edit-switch'], ['write', 'write-switch'], ['shell', 'shell-switch-unknown']] as const) {
        expect(observedPatchFollowups([call('first', 10, true), call('next', 20, undefined, 'agent-a', kind)])[0]!.state).toBe(state);
    }
    expect(observedPatchFollowups([call('first', 10, true), call('next', 20)])[0]).toEqual({ origin: 'first', retryCalls: 1, repeatErrors: 0, state: 'retry-result-missing' });
    expect(observedPatchFollowups([call('first', 10, true), call('next', 20, true)])[0]).toEqual({ origin: 'first', retryCalls: 1, repeatErrors: 1, state: 'unresolved' });
    expect(observedPatchFollowups([call('first', 10, true), call('concurrent', 10, false)])[0]!.state).toBe('unknown');
    expect(observedPatchFollowups([call('missing', 10)])).toEqual([]);
    expect(observedPatchFollowups([call('first', 10, true), call('other-agent', 20, false, 'agent-b')])[0]!.state).toBe('unresolved');
    expect(observedPatchFollowups([call('first', 10, true), call('new-prompt', 20, undefined, 'agent-a', 'boundary'), call('new-task', 30, false)])[0]).toEqual({ origin: 'first', retryCalls: 0, repeatErrors: 0, state: 'unresolved' });
});

test.each([
    ['apply_patch', 'retry-result-success', 1],
    ['Edit', 'edit-switch', 0],
    ['Write', 'write-switch', 0],
    ['Bash', 'shell-switch-unknown', 0],
] as const)('copied compaction context preserves original-agent %s followups', async (name, state, retryCalls) => {
    const root = await mkdtemp(join(tmpdir(), 'usage-copied-followups-'));
    try {
        const agentDir = join(root, 'session', 'subagents');
        await mkdir(agentDir, { recursive: true });
        const pair = (id: string, second: number, tool: string, error: boolean) => [
            { type: 'assistant', sessionId: 'session', uuid: id, timestamp: `2026-09-12T10:00:0${second}.000Z`,
                message: { model: 'model', content: [{ type: 'tool_use', id, name: tool }] } },
            { type: 'user', sessionId: 'session', uuid: `${id}-result`, timestamp: `2026-09-12T10:00:0${second + 1}.000Z`,
                message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: error }] } },
        ];
        const failed = pair('failed', 1, 'apply_patch', true);
        const original = [...failed, ...pair('later', 3, name, false)];
        const compact = join(agentDir, 'agent-acompact-0123456789abcdef.jsonl');
        const fullCopy = join(agentDir, 'agent-acompact-fedcba9876543210.jsonl');
        await writeFile(compact, failed.map(row => JSON.stringify(row)).join('\n'));
        await writeFile(fullCopy, original.map(row => JSON.stringify(row)).join('\n'));
        // Exercise original-agent filenames on either side of compaction copies.
        for (const suffix of ['fedcba9876543210', '0123456789abcdef']) {
            const agent = join(agentDir, `agent-a${suffix}.jsonl`);
            await writeFile(agent, original.map(row => JSON.stringify(row)).join('\n'));
            const asOf = '2026-09-13T12:00:00.000Z';
            const baseline = await collectRetainedUsage([agent], asOf, { timezone: 'UTC' });
            const files = [compact, agent, fullCopy];
            const direct = await collectRetainedUsage(files, asOf, { timezone: 'UTC' });
            const index = join(root, `${suffix}.sqlite`);
            const indexed = await collectIndexedUsage(files, asOf, { path: index, timezone: 'UTC', deadline: Date.now() + 60000 });
            expect(indexed.ranges).toEqual(direct.ranges);
            for (const range of ['7d', '30d', 'all'] as const) {
                expect(direct.ranges[range].tools).toEqual(baseline.ranges[range].tools);
                const patch = direct.ranges[range].tools.find(tool => tool.label === 'apply_patch')!;
                expect(patch.patchFollowups).toEqual({ episodes: 1, retryCalls, repeatErrors: 0, states: { [state]: 1 } });
                expect(patch.patchModels![0]!.patchFollowups).toEqual(patch.patchFollowups);
                expect(direct.ranges[range].rankedSessions.items[0]!.tools.find(tool => tool.label === 'apply_patch')!.patchFollowups).toEqual(patch.patchFollowups);
            }
            const db = new (await import('bun:sqlite')).Database(index);
            try {
                const saved = JSON.parse((db.query('SELECT value FROM snapshot WHERE id=1').get() as { value: string }).value);
                saved.patchActivityVersion = 1;
                db.query('UPDATE snapshot SET value=? WHERE id=1').run(JSON.stringify(saved));
            } finally { db.close(); }
            expect(readSavedUsage(index)).toBeNull();
            const metrics = emptyUsageIndexMetrics();
            const replayed = await collectIndexedUsage(files, asOf, { path: index, timezone: 'UTC', deadline: Date.now() + 60000, metrics,
                onReadSource() { throw new Error('unchanged source read'); } });
            expect(metrics.rowsReplayed).toBeGreaterThan(0);
            expect(replayed.ranges).toEqual(direct.ranges);
            expect(readSavedUsage(index)).toEqual(replayed);
        }
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('many patch models and root sessions fit the bounded envelope with reconciled model totals', async () => {
    const rows: unknown[] = [];
    for (let session = 0; session < 150; session++) for (let attempt = 0; attempt < 4; attempt++) {
        const id = `${session}-${attempt}`, timestamp = new Date(Date.UTC(2026, 8, 12, 10, attempt * 2)).toISOString();
        rows.push({ type: 'assistant', sessionId: `s${session}`, uuid: id, timestamp, message: { model: `model-${session % 14}`, content: [{ type: 'tool_use', id, name: 'apply_patch' }] } });
        rows.push({ type: 'user', sessionId: `s${session}`, uuid: `${id}-result`, timestamp: new Date(Date.parse(timestamp) + 1000).toISOString(), message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: attempt < 3 }] } });
    }
    const snapshot = await collectRetainedUsage(['/isolated/history.jsonl'], '2026-09-13T12:00:00.000Z', {
        timezone: 'UTC', readRecords: async (_file, consume) => {
            for (const [offset, value] of rows.entries()) await consume({ value, offset, generation: 'test' });
            return { bytesRead: 0, parseErrors: 0, oversizedRecords: 0, oversizedToolResults: 0, pendingTailBytes: 0, shortReads: 0, changedSources: 0 };
        },
    });
    fitUsageDashboardSnapshot(snapshot);
    const result = { type: 'usage', version: 1, snapshot };
    expect(parseUsageCollectionResult(result)?.type).toBe('usage');
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(MAX_USAGE_RECORD_BYTES);
    for (const range of Object.values(snapshot.ranges)) {
        const tool = range.toolBreakdown!.items[0]!;
        expect(tool.patchModels!.filter(model => model.kind === 'named').length).toBeLessThanOrEqual(8);
        expect(tool.patchModels!.some(model => model.kind === 'other')).toBe(true);
        expect(tool.patchModels!.reduce((sum, model) => sum + model.requests, 0)).toBe(600);
        expect(tool.patchModels!.reduce((sum, model) => sum + model.errors, 0)).toBe(450);
        expect(tool.patchFollowups).toMatchObject({ episodes: 150, retryCalls: 450, repeatErrors: 300, states: { 'retry-result-success': 150 } });
        expect(range.rankedSessions.omitted).toBeGreaterThan(0);
        for (const session of range.rankedSessions.items) expect(session.tools[0]).toMatchObject({ requests: 4, results: 4, errors: 3, errorCategories: { other: 3 }, patchFollowups: { episodes: 1, retryCalls: 3 } });
    }
});
test('model and root-session patch dimensions survive indexed replay, grouping and agent-local followups', async () => {
    const root = await mkdtemp(join(tmpdir(), 'usage-patch-activity-'));
    try {
        const agentDir = join(root, 'root-session', 'subagents');
        await mkdir(agentDir, { recursive: true });
        const stamp = (second: number) => new Date(Date.UTC(2026, 8, 12, 10, 0, second)).toISOString();
        const pair = (id: string, second: number, model: string | undefined, error: boolean | undefined, name = 'apply_patch') => [
            { type: 'assistant', sessionId: 'root-session', uuid: id, timestamp: stamp(second), message: { model, content: [{ type: 'tool_use', id, name, input: { command: 'PRIVATE_COMMAND', patch: 'PRIVATE_PATCH' } }] } },
            ...(error === undefined ? [] : [{ type: 'user', sessionId: 'root-session', uuid: `${id}-result`, timestamp: stamp(second + 1),
                toolUseResult: error ? { type: 'file_patch_error', code: 'PATCH_ANCHOR_AMBIGUOUS', details: [] }
                    : { files: [{ path: 'PRIVATE_PATH', placements: [{ reordered: true }, { reordered: true }] }] },
                message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: error }] } }]),
        ];
        const main = join(root, 'root-session.jsonl'), agent = join(agentDir, 'agent-a.jsonl');
        await writeFile(main, [
            ...pair('first', 1, 'model-a', true),
            { type: 'user', sessionId: 'root-session', uuid: 'runtime-context', timestamp: stamp(4), isMeta: true, message: { content: 'PRIVATE_RUNTIME_CONTEXT' } },
            { type: 'user', sessionId: 'root-session', uuid: 'compact-summary', timestamp: stamp(7), isCompactSummary: true, message: { content: 'PRIVATE_COMPACT_SUMMARY' } },
            ...pair('retry', 10, 'model-b', true), ...pair('accepted', 20, 'model-b', false), ...pair('missing', 30, undefined, undefined),
        ].map(row => JSON.stringify(row)).join('\n'));
        await writeFile(agent, [...pair('agent-failed', 2, 'model-a', true), ...pair('agent-write', 5, 'model-b', false, 'Write')].map(row => JSON.stringify(row)).join('\n'));
        const files = [agent, main], asOf = '2026-09-13T12:00:00.000Z';
        const direct = await collectRetainedUsage(files, asOf, { timezone: 'UTC' });
        const index = join(root, 'index.sqlite');
        const indexed = await collectIndexedUsage(files, asOf, { path: index, timezone: 'UTC', deadline: Date.now() + 60000 });
        expect(indexed.ranges).toEqual(direct.ranges);
        const range = indexed.ranges['7d'], patch = range.tools.find(tool => tool.label === 'apply_patch')!;
        expect(patch).toMatchObject({ requests: 5, results: 4, errors: 3, errorCategories: { ambiguity: 3 }, patchMechanisms: { 'hunk-reorder': 1 }, patchFollowups: { episodes: 2, retryCalls: 2, repeatErrors: 1, states: { 'retry-result-success': 1, 'write-switch': 1 } } });
        expect(patch.patchModels!.find(model => model.label === 'model-a')).toMatchObject({ requests: 2, results: 2, errors: 2, patchFollowups: patch.patchFollowups });
        expect(patch.patchModels!.find(model => model.label === 'model-b')).toMatchObject({ requests: 2, results: 2, errors: 1, patchMechanisms: { 'hunk-reorder': 1 } });
        expect(patch.patchModels!.find(model => model.kind === 'unknown')).toMatchObject({ requests: 1, results: 0, errors: 0 });
        expect(range.rankedSessions.items).toHaveLength(1);
        expect(range.rankedSessions.items[0]!.tools.find(tool => tool.label === 'apply_patch')).toMatchObject({ requests: 5, results: 4, errors: 3, errorCategories: patch.errorCategories, patchMechanisms: patch.patchMechanisms, patchFollowups: patch.patchFollowups });
        const grouped = groupUsageSummary(range, 0, 0, 0, 0, 0, 5, 0, 0);
        expect(grouped.toolBreakdown!.items[0]!.patchModels!.reduce((sum, model) => sum + model.requests, 0)).toBe(5);
        expect(grouped.toolBreakdown!.items[0]!.patchFollowups).toEqual(patch.patchFollowups);
        fitUsageDashboardSnapshot(indexed);
        expect(parseUsageCollectionResult({ type: 'usage', version: 1, snapshot: indexed })?.type).toBe('usage');
        const warm = await collectIndexedUsage(files, asOf, { path: index, timezone: 'UTC', deadline: Date.now() + 60000, onReadSource() { throw new Error('unexpected source read'); } });
        expect(warm.ranges).toEqual(direct.ranges);
        const db = new (await import('bun:sqlite')).Database(index, { readonly: true });
        try {
            const projected = JSON.stringify(db.query('SELECT value FROM records').all());
            for (const secret of ['PRIVATE_COMMAND', 'PRIVATE_PATCH', 'PRIVATE_PATH', 'PRIVATE_RUNTIME_CONTEXT', 'PRIVATE_COMPACT_SUMMARY', 'placements']) expect(projected).not.toContain(secret);
        } finally { db.close(); }
    } finally { await rm(root, { recursive: true, force: true }); }
});
