import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectRetainedUsage } from './statsUsage.js';
const roots: string[] = [];
const asOf = '2026-09-13T12:00:00.000Z';
afterEach(async () => { for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true }); });
const row = (date: string, uuid: string, model: string, tool: string | undefined, input = 1, sessionId = 'main', extra: Record<string, unknown> = {}) => ({ type: 'assistant', sessionId, uuid, timestamp: `${date}T10:00:00.000Z`, ...extra, message: { id: uuid, model, usage: { input_tokens: input, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 }, content: [{ type: 'tool_use', ...(tool ? { id: tool } : {}), name: 'Bash' }] } });
async function fixture(main: unknown[], subagent: unknown[] = []) { const root = await mkdtemp(join(tmpdir(), 'usage-accept-')); roots.push(root); const project = join(root, 'project'); const sub = join(project, 'main', 'subagents'); await mkdir(sub, { recursive: true }); await Bun.write(join(project, 'main.jsonl'), main.map(value => JSON.stringify(value)).join('\n')); if (subagent.length)
    await Bun.write(join(sub, 'agent.jsonl'), subagent.map(value => JSON.stringify(value)).join('\n')); return [join(project, 'main.jsonl'), ...(subagent.length ? [join(sub, 'agent.jsonl')] : [])]; }
test('separate subagent namespace reuses tool IDs independently and contributes only tokens/tools', async () => {
    const files = await fixture([row('2026-09-12', 'm1', 'model-a', 'same')], [row('2026-09-12', 'a1', 'model-b', 'same', 2, 'agent')]);
    const r = (await collectRetainedUsage(files, asOf)).ranges['7d'];
    expect(r.requests).toBe(2);
    expect(r.tokens.fresh).toBe(3);
    expect(r.sessions).toBe(1);
    expect(r.records).toBe(1);
    expect(r.models).toHaveLength(2);
    expect(r.tools).toHaveLength(1);
});
test('fallback identity deduplicates same record but distinct offsets remain separate', async () => {
    const a = row('2026-09-12', 'x', 'model-a', undefined);
    delete (a.message.content[0] as any).id;
    const b = structuredClone(a);
    const c = structuredClone(a);
    delete (c as any).uuid;
    delete (c as any).message.id;
    const files = await fixture([a, b, c]);
    const r = (await collectRetainedUsage(files, asOf)).ranges['7d'];
    expect(r.requests).toBe(2);
    expect(r.tokens.fresh).toBe(2);
});
test('conflicting repeated tool identity keeps first occurrence and reports conflict', async () => {
    const a = row('2026-09-12', 'x', 'model-a', 'tool-id');
    const b = row('2026-09-13', 'y', 'model-a', 'tool-id');
    const files = await fixture([a, b]);
    const s = await collectRetainedUsage(files, asOf);
    expect(s.coverage.identityConflicts).toBe(1);
    expect(s.ranges['7d'].requests).toBe(1);
    expect(s.ranges['7d'].days.find(d => d.requests > 0)?.date).toBe('2026-09-12');
});
test('invalid usage is partial without token credit; zero prompt has null share and models reconcile', async () => {
    const bad = row('2026-09-12', 'bad', 'model-a', undefined, -1);
    const goodA = row('2026-09-12', 'good-a', 'model-a', undefined, 3);
    const good = row('2026-09-13', 'good', 'model-b', undefined, 2);
    const files = await fixture([bad, goodA, good]);
    const s = await collectRetainedUsage(files, asOf);
    const r = s.ranges['7d'];
    expect(s.coverage.invalidUsage).toBe(1);
    expect(s.coverage.state).toBe('partial');
    expect(r.tokens.fresh).toBe(5);
    expect(r.models).toHaveLength(2);
    expect(r.models.reduce((n, m) => n + m.tokens.fresh, 0)).toBe(r.tokens.fresh);
    expect(r.cachedInputShare).toBe(0);
    const empty = await collectRetainedUsage([], asOf);
    expect(empty.ranges['7d'].cachedInputShare).toBeNull();
});
