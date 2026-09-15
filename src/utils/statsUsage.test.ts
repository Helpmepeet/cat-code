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
