import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, writeFile, rm, utimes, copyFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectRetainedUsage, UsageResourceError } from './statsUsage.js';
import { usageProjectId } from '../../app/shared/usageDashboard.js';
const roots: string[] = [];
afterEach(async () => { for (const path of roots.splice(0))
    await rm(path, { recursive: true, force: true }); });
const asOf = '2026-09-13T12:00:00.000Z';
const msg = (timestamp: string, id: string, input: number, tool = 't1', sessionId = 's') => ({ type: 'assistant', sessionId, uuid: id + timestamp, timestamp, message: { id, model: 'model', usage: { input_tokens: input, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 }, content: [{ type: 'tool_use', id: tool, name: 'Bash' }] } });
async function file(rows: unknown[]) { const dir = await mkdtemp(join(tmpdir(), 'usage-count-')); roots.push(dir); const path = join(dir, 's.jsonl'); await writeFile(path, rows.map(r => JSON.stringify(r)).join('\n')); return path; }
test('T2/T4/I3: seed before window, exclude future before identity and cumulative credit', async () => {
    const path = await file([msg('2026-09-06T23:59:59.000Z', 'a', 10), msg('2026-09-07T00:00:00.000Z', 'a', 20), msg('2026-09-13T13:00:00.000Z', 'b', 900, 'future'), msg(asOf, 'b', 5, 'future'), msg('invalid', 'c', 1000)]);
    const s = await collectRetainedUsage([path], asOf);
    const r = s.ranges['7d'];
    expect(r.tokens).toEqual({ fresh: 15, output: 2, read: 3, write: 4 });
    expect(r.requests).toBe(1);
    expect(r.sessions).toBe(1);
    expect(r.days).toHaveLength(7);
    expect(s.ranges['30d'].days).toHaveLength(30);
    expect(s.coverage.invalidTimestamps).toBe(1);
    expect(s.coverage.state).toBe('partial');
});
test('I1/I2/I4/M2/M3: replay, new retry, fallback, copied files, sessions vs days', async () => {
    const a = msg('2026-09-12T10:00:00.000Z', 'a', 10);
    const b = msg(asOf, 'b', 20, 't2');
    const fallback = { ...b, uuid: 'fallback', message: { ...b.message, content: [{ type: 'tool_use', name: 'Other' }] } };
    const path = await file([a, a, b, fallback, fallback]);
    const copy = join(roots[0]!, 'copy.jsonl');
    await copyFile(path, copy);
    const r = (await collectRetainedUsage([path, copy], asOf)).ranges['7d'];
    expect(r.requests).toBe(3);
    expect(r.identifiedRequests).toBe(2);
    expect(r.fallbackRequests).toBe(1);
    expect(r.sessions).toBe(1);
    expect(r.days.reduce((n, d) => n + d.sessions, 0)).toBe(2);
    expect(r.requests).toBe(r.days.reduce((n, d) => n + d.requests, 0));
    expect(r.requests).toBe(r.tools.reduce((n, t) => n + t.requests, 0));
    expect(r.tokens.fresh).toBe(30);
    const other = await file([a]);
    expect((await collectRetainedUsage([path, other], asOf)).ranges['7d'].sessions).toBe(2);
});
test('C4/C5/M1: old mtime still read, inclusive input normalized, malformed input makes partial', async () => {
    const row = msg(asOf, 'a', 10);
    const raw = { ...row, message: { ...row.message, usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 80 }, output_tokens: 5 } } };
    const path = await file([raw]);
    await utimes(path, new Date(0), new Date(0));
    const s = await collectRetainedUsage([path], asOf);
    expect(s.ranges['7d'].tokens).toEqual({ fresh: 20, read: 80, write: 0, output: 5 });
    expect(s.ranges['7d'].cachedInputShare).toBe(80);
    expect(s.coverage.state).toBe('complete');
    expect((await collectRetainedUsage([], asOf)).ranges['7d'].cachedInputShare).toBeNull();
    await writeFile(path, 'broken\n');
    const partial = await collectRetainedUsage([path], asOf);
    expect(partial.coverage.state).toBe('partial');
    expect(partial.ranges['7d'].tokens.fresh).toBe(0);
});
test('cache-write reporting distinguishes measured, unreported, mixed, and unknown records', async () => {
    const openai = msg(asOf, 'openai', 10);
    openai.message.model = 'gpt-5.6-sol';
    openai.message.usage.cache_creation_input_tokens = 0;
    const anthropic = msg(asOf, 'anthropic', 10, 't2');
    anthropic.message.model = 'claude-opus-4-6';
    const unknown = msg(asOf, 'unknown', 10, 't3');
    unknown.message.model = 'custom-model';
    unknown.message.usage.cache_creation_input_tokens = 0;
    const importedOpenaiWrite = msg(asOf, 'imported-openai', 10, 't4');
    importedOpenaiWrite.message.model = 'gpt-imported';
    const claudeWithoutWrite = msg(asOf, 'claude-missing', 10, 't5');
    claudeWithoutWrite.message.model = 'claude-opus-4-6';
    delete (claudeWithoutWrite.message.usage as Partial<typeof claudeWithoutWrite.message.usage>).cache_creation_input_tokens;
    expect((await collectRetainedUsage([await file([openai])], asOf)).ranges['7d'].cacheWriteReporting).toBe('unreported');
    expect((await collectRetainedUsage([await file([anthropic])], asOf)).ranges['7d'].cacheWriteReporting).toBe('reported');
    expect((await collectRetainedUsage([await file([openai, anthropic])], asOf)).ranges['7d'].cacheWriteReporting).toBe('partial');
    expect((await collectRetainedUsage([await file([unknown])], asOf)).ranges['7d'].cacheWriteReporting).toBe('partial');
    expect((await collectRetainedUsage([await file([importedOpenaiWrite])], asOf)).ranges['7d'].cacheWriteReporting).toBe('reported');
    expect((await collectRetainedUsage([await file([claudeWithoutWrite])], asOf)).ranges['7d'].cacheWriteReporting).toBe('partial');
    expect((await collectRetainedUsage([], asOf)).ranges['7d'].cacheWriteReporting).toBe('unavailable');
});
test('state and integer overflow are explicit collection errors', async () => {
    const path = await file([msg(asOf, 'a', 5)]);
    await expect(collectRetainedUsage([path], asOf, { maxIdentities: 1 })).rejects.toBeInstanceOf(UsageResourceError);
    await expect(collectRetainedUsage([path], asOf, { maxStateBytes: 1 })).rejects.toBeInstanceOf(UsageResourceError);
    const huge = msg(asOf, 'a', Number.MAX_SAFE_INTEGER);
    huge.message.usage.output_tokens = 0;
    huge.message.usage.cache_read_input_tokens = 0;
    huge.message.usage.cache_creation_input_tokens = 0;
    const second = msg(asOf, 'b', 1, 't2');
    await writeFile(path, [huge, second].map(row => JSON.stringify(row)).join('\n'));
    await expect(collectRetainedUsage([path], asOf)).rejects.toBeInstanceOf(UsageResourceError);
});

test('hourly requests and matched errors deduplicate and respect request windows and cutoff', async () => {
    const result = (id: string, error: unknown = undefined, time = asOf) => ({ type: 'user', sessionId: 's', uuid: `result-${id}-${String(error)}`, timestamp: time, message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: error, content: 'not inspected' }] } });
    const request = (id: string, time = '2026-09-13T10:00:00.000Z') => msg(time, id, 1, id);
    const path = await file([
        result('error', true), request('error'), request('error'), result('error', true),
        request('success'), result('success'), request('missing'), request('invalid'), result('invalid', 'true'),
        result('orphan', true), request('future-result'), result('future-result', true, '2026-09-13T13:00:00.000Z'),
        request('old', '2026-09-06T23:59:00.000Z'), result('old', true),
    ]);
    const summary = (await collectRetainedUsage([path], asOf)).ranges['7d'];
    expect(summary.requests).toBe(5);
    expect(summary.days.at(-1)!.hourlyRequests[10]).toBe(5);
    expect(summary.days.flatMap(d => d.hourlyRequests).reduce((a,b) => a+b,0)).toBe(5);
    expect(summary.tools[0]).toMatchObject({ requests: 5, results: 2, errors: 1 });
});

test('day contributors merge subagent work into its owning session and expose only reliable navigation metadata', async () => {
    const project = await mkdtemp(join(tmpdir(), 'usage-project-'));
    roots.push(project);
    const engineSessionId = '123e4567-e89b-42d3-a456-426614174000';
    const cwd = join(project, 'workspace');
    const main = join(project, `${engineSessionId}.jsonl`);
    const subagentDir = join(project, engineSessionId, 'subagents');
    await mkdir(subagentDir, { recursive: true });
    const mainRequest = { ...msg(asOf, 'main-api', 10, 'main-tool', engineSessionId), cwd };
    const mainResult = { type: 'user', sessionId: engineSessionId, cwd, uuid: 'main-result', timestamp: asOf, message: { content: [{ type: 'tool_result', tool_use_id: 'main-tool', is_error: true }] } };
    const subagent = { ...msg(asOf, 'sub-api', 20, 'sub-tool', engineSessionId), cwd };
    await writeFile(main, [mainRequest, mainRequest, mainResult].map(row => JSON.stringify(row)).join('\n'));
    await writeFile(join(subagentDir, 'agent-a.jsonl'), JSON.stringify(subagent));
    const day = (await collectRetainedUsage([main, join(subagentDir, 'agent-a.jsonl')], asOf)).ranges['7d'].days.at(-1)!;
    expect(day.contributors.state).toBe('full');
    expect(day.contributors.items).toHaveLength(1);
    expect(day.contributors.items[0]).toMatchObject({
        engineSessionId,
        project: { id: usageProjectId(cwd), label: 'workspace' },
        tokens: { fresh: 30, read: 6, write: 8, output: 4 },
        requests: 2,
        results: 1,
        errors: 1,
    });
    expect(day.sessions).toBe(1);
});


test('All includes old retained history, stays sparse across gaps, and excludes future records', async () => {
    const path = await file([
        msg('2020-01-01T10:00:00.000Z', 'old', 7, 'old'),
        msg(asOf, 'today', 11, 'today'),
        msg('2027-01-01T10:00:00.000Z', 'future', 999, 'future'),
    ]);
    const snapshot = await collectRetainedUsage([path], asOf);
    expect(snapshot.ranges.all.tokens.fresh).toBe(18);
    expect(snapshot.ranges['30d'].tokens.fresh).toBe(11);
    expect(snapshot.ranges.all.startInclusive).toBe('2020-01-01T00:00:00.000Z');
    expect(snapshot.ranges.all.days.map(day => day.date)).toEqual(['2020-01-01', '2026-09-13']);
    expect(snapshot.ranges.all.days.every(day => day.contributors.state === 'unavailable')).toBe(true);
    expect(snapshot.ranges.all.activeDays).toBe(2);
    expect(snapshot.ranges.all.sessions).toBe(1);
    const empty = await collectRetainedUsage([], asOf);
    expect(empty.ranges.all.startInclusive).toBe('2026-09-13T00:00:00.000Z');
    expect(empty.ranges.all.days).toEqual([]);
});

test('All buckets long history without truncating totals or double-counting bucket sessions', async () => {
    const rows = Array.from({ length: 400 }, (_, index) => msg(new Date(Date.UTC(2020, 0, index + 1, 10)).toISOString(), `m${index}`, 1, `t${index}`));
    const path = await file(rows);
    const snapshot = await collectRetainedUsage([path], asOf);
    const all = snapshot.ranges.all;
    expect(all.tokens.fresh).toBe(400);
    expect(all.records).toBe(400);
    expect(all.requests).toBe(400);
    expect(all.activeDays).toBe(400);
    expect(all.bucketDays).toBeGreaterThan(1);
    expect(all.days.length).toBeLessThanOrEqual(180);
    expect(all.days.every(day => day.sessions === 1)).toBe(true);
    expect(all.days.reduce((sum, day) => sum + day.requests, 0)).toBe(400);
    expect(all.days.reduce((sum, day) => sum + day.tokens.fresh, 0)).toBe(400);
    const { groupUsageSummary } = await import('../../app/sidecar/usageSummary.js');
    const { parseUsageCollectionResult } = await import('../../app/shared/usageStatsWorker.js');
    for (const range of ['7d', '30d', 'all'] as const) snapshot.ranges[range] = groupUsageSummary(snapshot.ranges[range]);
    expect(parseUsageCollectionResult({ type: 'usage', version: 1, snapshot })).not.toBeNull();
});

test('ancient timestamps do not allocate intervening calendar days and out-of-contract years are rejected', async () => {
    const path = await file([msg('0000-01-01T10:00:00.000Z', 'ancient', 1, 'ancient'), msg(asOf, 'current', 2, 'current'), msg('-000001-01-01T10:00:00.000Z', 'invalid', 100, 'invalid')]);
    const snapshot = await collectRetainedUsage([path], asOf);
    expect(snapshot.ranges.all.days).toHaveLength(2);
    expect(snapshot.ranges.all.tokens.fresh).toBe(3);
    expect(snapshot.coverage.invalidTimestamps).toBe(1);
});


test('seven-day hourly tokens credit normalized exclusive deltas once in the record hour', async () => {
    const before = msg('2026-09-06T23:00:00.000Z', 'cumulative', 10, 'seed');
    const first = msg('2026-09-07T01:00:00.000Z', 'cumulative', 20, 'seed');
    const later = msg('2026-09-07T04:00:00.000Z', 'cumulative', 30, 'seed');
    const native = { ...msg(asOf, 'native', 0, 'native'), message: { id: 'native', model: 'gpt-model', usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 80 }, output_tokens: 5 }, content: [] } };
    const future = msg('2026-09-13T13:00:00.000Z', 'future', 999, 'future');
    const path = await file([before, first, first, later, native, future]);
    const snapshot = await collectRetainedUsage([path], asOf);
    const seven = snapshot.ranges['7d'];
    expect(seven.days[0]!.hourlyTokens).toEqual(Array.from({ length: 24 }, (_, hour) => hour === 1 || hour === 4 ? 10 : 0));
    expect(seven.days.at(-1)!.hourlyTokens![12]).toBe(105);
    expect(seven.days.at(-1)!.hourlyTokens![13]).toBe(0);
    expect(seven.days.flatMap(day => day.hourlyTokens!).reduce((sum, value) => sum + value, 0)).toBe(125);
    expect(snapshot.ranges['30d'].days.every(day => day.hourlyTokens === undefined)).toBe(true);
    expect(snapshot.ranges.all.days.every(day => day.hourlyTokens === undefined)).toBe(true);
});

test('daily outcomes follow matched request dates across midnight and All bucket aggregation', async () => {
    const rows = Array.from({ length: 200 }, (_, index) => {
        const requestTime = new Date(Date.UTC(2020, 0, index + 1, 23)).toISOString();
        const resultTime = new Date(Date.UTC(2020, 0, index + 2, 1)).toISOString();
        return [
            { type: 'user', sessionId: 's', uuid: `r${index}`, timestamp: resultTime, message: { content: [{ type: 'tool_result', tool_use_id: `t${index}`, is_error: index % 2 === 0 }] } },
            msg(requestTime, `m${index}`, 1, `t${index}`),
        ];
    }).flat();
    const recent = msg('2026-09-12T23:00:00.000Z', 'recent', 1, 'recent');
    const recentResult = { type: 'user', sessionId: 's', uuid: 'recent-result', timestamp: asOf, message: { content: [{ type: 'tool_result', tool_use_id: 'recent', is_error: true }] } };
    const path = await file([...rows, recentResult, recent, recentResult]);
    const snapshot = await collectRetainedUsage([path], asOf);
    const yesterday = snapshot.ranges['7d'].days.find(day => day.date === '2026-09-12')!;
    expect(yesterday).toMatchObject({ requests: 1, results: 1, errors: 1 });
    expect(snapshot.ranges['7d'].days.at(-1)).toMatchObject({ requests: 0, results: 0, errors: 0 });
    expect(snapshot.ranges.all.bucketDays).toBeGreaterThan(1);
    expect(snapshot.ranges.all.days.reduce((sum, day) => sum + day.results, 0)).toBe(201);
    expect(snapshot.ranges.all.days.reduce((sum, day) => sum + day.errors, 0)).toBe(101);
    for (const range of Object.values(snapshot.ranges)) {
        expect(range.days.reduce((sum, day) => sum + day.results, 0)).toBe(range.tools.reduce((sum, tool) => sum + tool.results, 0));
        expect(range.days.reduce((sum, day) => sum + day.errors, 0)).toBe(range.tools.reduce((sum, tool) => sum + tool.errors, 0));
    }
});

test('previous periods use equal elapsed UTC bounds and canonical distinct-session accounting', async () => {
    const path = await file([
        { type: 'user', sessionId: 'thirty-anchor', uuid: 'thirty-anchor', timestamp: '2026-07-15T00:00:00.000Z' },
        msg('2026-07-16T00:00:00.000Z', 'thirty-open', 5, 'thirty-open', 'thirty'),
        msg('2026-08-14T12:00:00.000Z', 'thirty-cutoff', 6, 'thirty-close', 'thirty'),
        { type: 'user', sessionId: 'anchor', uuid: 'anchor', timestamp: '2026-08-30T00:00:00.000Z' },
        msg('2026-08-31T00:00:00.000Z', 'baseline-open', 10, 'open', 'same'),
        msg('2026-09-06T12:00:00.000Z', 'baseline-cutoff', 20, 'close', 'same'),
        msg('2026-09-06T12:00:00.001Z', 'baseline-after', 100, 'after', 'same'),
        msg('2026-09-07T00:00:00.000Z', 'current-open', 30, 'current-open', 'same'),
        msg(asOf, 'current-cutoff', 40, 'current-close', 'other'),
    ]);
    const previous = (await collectRetainedUsage([path], asOf)).ranges['7d'].previousPeriod!;
    expect(previous).toMatchObject({
        startInclusive: '2026-08-31T00:00:00.000Z', endInclusive: '2026-09-06T12:00:00.000Z',
        tokens: { fresh: 30, read: 6, write: 8, output: 4 }, sessions: 1, records: 2, requests: 2, activeDays: 2,
    });
    expect(previous.cachedInputShare).toBe(6 / 44 * 100);
    expect((await collectRetainedUsage([path], asOf)).ranges['30d'].previousPeriod).toMatchObject({
        startInclusive: '2026-07-16T00:00:00.000Z', endInclusive: '2026-08-14T12:00:00.000Z',
        tokens: { fresh: 11, read: 6, write: 8, output: 4 }, sessions: 1, requests: 2, activeDays: 2,
    });
    expect((await collectRetainedUsage([path], asOf)).ranges.all.previousPeriod).toBeUndefined();
});

test('previous-period active days include subagent-only request and token activity', async () => {
    const project = await mkdtemp(join(tmpdir(), 'usage-period-subagent-'));
    roots.push(project);
    const session = '123e4567-e89b-42d3-a456-426614174000';
    const main = join(project, `${session}.jsonl`), subagents = join(project, session, 'subagents');
    await mkdir(subagents, { recursive: true });
    await writeFile(main, JSON.stringify({ type: 'user', sessionId: session, uuid: 'anchor', timestamp: '2026-08-30T00:00:00.000Z' }));
    await writeFile(join(subagents, 'agent.jsonl'), JSON.stringify(msg('2026-09-02T08:00:00.000Z', 'subagent', 9, 'subagent-tool', session)));
    const previous = (await collectRetainedUsage([main, join(subagents, 'agent.jsonl')], asOf)).ranges['7d'].previousPeriod!;
    expect(previous).toMatchObject({ records: 0, sessions: 0, requests: 1, activeDays: 1, tokens: { fresh: 9, read: 3, write: 4, output: 2 } });
});

test('previous periods suppress unknown or partial history but retain a known zero baseline', async () => {
    const currentOnly = await file([msg(asOf, 'current', 10)]);
    expect((await collectRetainedUsage([currentOnly], asOf)).ranges['7d'].previousPeriod).toBeUndefined();
    const knownZero = await file([
        { type: 'user', sessionId: 'anchor', uuid: 'anchor', timestamp: '2026-08-30T00:00:00.000Z' },
        { type: 'user', sessionId: 'zero', uuid: 'zero', timestamp: '2026-09-02T12:00:00.000Z' },
        msg(asOf, 'current', 10),
    ]);
    const baseline = (await collectRetainedUsage([knownZero], asOf)).ranges['7d'].previousPeriod!;
    expect(baseline.tokens).toEqual({ fresh: 0, read: 0, write: 0, output: 0 });
    expect(baseline.cachedInputShare).toBeNull();
    const partial = await file([msg('2026-08-30T00:00:00.000Z', 'anchor', 1), msg(asOf, 'current', 10)]);
    await writeFile(partial, 'broken');
    expect((await collectRetainedUsage([partial], asOf)).ranges['7d'].previousPeriod).toBeUndefined();
});
