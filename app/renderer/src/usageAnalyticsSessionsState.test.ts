import { expect, test } from 'bun:test';
import { collectRetainedUsage } from '../../../src/utils/statsUsage.js';
import { usageProjectId, type UsageRankedSession } from '../../shared/usageDashboard.js';
import type { MergedSessionRow } from './sessionsCatalogState.js';
import { analyticsLine, integrationSeries, rankedSessions, sessionDailySeries, sessionFigures, sessionLabel, sessionSpend } from './usageAnalyticsSessionsState.js';

const zero = { fresh: 0, read: 0, write: 0, output: 0 };
function item(id = 'a'): UsageRankedSession {
    return { id, rank: { tokens: 1, requests: 1, errors: 1 }, lastActiveAt: '2026-10-17T12:00:00Z', engineSessionId: id, project: { id: usageProjectId('/work'), label: 'work' }, tokens: { ...zero, fresh: 10 }, tokenSources: { chat: { ...zero, fresh: 10 }, subagents: zero, compaction: zero }, requests: 2, results: 2, errors: 1, models: [], modelDetail: { state: 'full', omitted: 0 }, timeline: { state: 'unavailable', omitted: 0, items: [] }, tools: [], days: [{ date: '2026-10-17', tokens: { ...zero, fresh: 10 }, requests: 2, results: 2, errors: 1 }], dailyDetail: 'full' };
}
async function summary() { return (await collectRetainedUsage([], '2026-10-18T12:00:00Z')).ranges['7d']; }
test('catalog join requires an unambiguous project match and preserves title', () => {
    const row = { sessionId: 'a', cwd: '/work', displayLabel: 'Catalog title' } as MergedSessionRow;
    const other = { ...row, cwd: '/other' };
    expect(sessionLabel(item(), [other, row])).toEqual({ row, label: 'Catalog title' });
    expect(sessionLabel(item(), [row, { ...row }]).row).toBeNull();
    expect(sessionLabel(item(), [other]).label).toBe('Session a');
});
test('range figures preserve exact collector statistics even when all ranked rows are omitted', async () => {
    const s = await summary(); const a = item(), b = { ...item('b'), errors: 9, tokens: { ...zero, fresh: 2 } };
    s.tokens = { ...zero, fresh: 1000 };
    s.rankedSessions = { state: 'truncated', omitted: 50, items: [a, b], medianTokens: 17, top10Tokens: 800 };
    expect(rankedSessions(s, 'tokens').map(value => value.id)).toEqual(['a', 'b']);
    expect(rankedSessions(s, 'errors').map(value => value.id)).toEqual(['b', 'a']);
    expect(sessionFigures(s).median).toBe(17);
    expect(sessionFigures(s).top10).toBe(80);
    s.rankedSessions.items = [];
    expect(sessionFigures(s).median).toBe(17);
    expect(sessionFigures(s).top10).toBe(80);
});
test('every session column sorts its own values rather than inherited token order', async () => {
    const s = await summary();
    const a = { ...item('a'), tokens: { ...zero, fresh: 100 }, requests: 10, errors: 4, results: 20, lastActiveAt: '2026-10-17T10:00:00Z' };
    const b = { ...item('b'), tokens: { ...zero, fresh: 20 }, tokenSources: { chat: zero, subagents: { ...zero, fresh: 18 }, compaction: zero }, requests: 30, errors: 3, results: 3, lastActiveAt: '2026-10-16T10:00:00Z' };
    const c = { ...item('c'), tokens: { ...zero, fresh: 50 }, tokenSources: { chat: zero, subagents: { ...zero, fresh: 10 }, compaction: zero }, requests: 20, errors: 8, results: 16, lastActiveAt: '2026-10-18T10:00:00Z' };
    s.rankedSessions.items = [c, a, b];
    const rows = [{ sessionId: 'a', cwd: '/work', displayLabel: 'Zulu' }, { sessionId: 'b', cwd: '/work', displayLabel: 'Alpha' }, { sessionId: 'c', cwd: '/work', displayLabel: 'Middle' }] as MergedSessionRow[];
    for (const [key, expected] of [
        ['session', ['a', 'c', 'b']], ['tokens', ['a', 'c', 'b']], ['subagents', ['b', 'c', 'a']],
        ['requests', ['b', 'c', 'a']], ['errors', ['c', 'a', 'b']], ['errorRate', ['b', 'c', 'a']], ['lastActive', ['c', 'a', 'b']],
    ] as const) {
        expect(rankedSessions(s, key, false, rows).map(value => value.id)).toEqual([...expected]);
        expect(rankedSessions(s, key, true, rows).map(value => value.id)).toEqual([...expected].reverse());
    }
    s.rankedSessions.items = [{ ...a, results: 0 }, b];
    expect(rankedSessions(s, 'errorRate', true).map(value => value.id)).toEqual(['b', 'a']);
});
test('sparse recent session detail fills local calendar keys and all-history stays unavailable', async () => {
    const s = await summary(); const a = item();
    const points = sessionDailySeries(a, s);
    expect(points).toHaveLength(7);
    expect(points.find(point => point.date === '2026-10-17')?.values).toEqual([10]);
    expect(points.filter(point => point.values[0] === 0)).toHaveLength(6);
    expect(sessionDailySeries({ ...a, days: [], dailyDetail: 'unavailable' }, s)).toEqual([]);
    expect(sessionSpend(a)).toBe('Unpriced');
    expect(sessionSpend({ ...a, tokenCost: { usd: 0.5, pricedTokens: 5 } })).toBe('$0.50 partial');
});
test('30 day top four plus Other groups exact counts in end-anchored weeks', async () => {
    const s = (await collectRetainedUsage([], '2026-10-18T12:00:00Z')).ranges['30d'];
    s.skills = Array.from({ length: 6 }, (_, i) => ({ id: `s${i}`, label: `Skill ${i}`, kind: 'named' as const, requests: 6 - i }));
    s.days[0]!.skills = s.skills;
    s.days[29]!.skills = [{ ...s.skills[0]!, requests: 2 }];
    const data = integrationSeries(s, 'skills');
    expect(data.series.map(value => value.label)).toEqual(['Skill 0', 'Skill 1', 'Skill 2', 'Skill 3', 'Other']);
    expect(data.points).toHaveLength(5);
    expect(data.points[0]!.values).toEqual([6, 5, 4, 3, 3]);
    expect(data.points[4]!.values).toEqual([2, 0, 0, 0, 0]);
    expect(data.points[0]!.endDate).toBe(s.days[2]!.date);
});
test('all-history sparse buckets retain calendar spacing without fabricated zero buckets', async () => {
    const s = await summary(); s.range = 'all'; s.bucketDays = 2;
    const call = { id: 'web', label: 'Web', kind: 'named' as const, requests: 3 };
    s.integrations = [call]; s.days = [s.days[0]!, s.days[6]!];
    for (const day of s.days) day.integrations = [call];
    const data = integrationSeries(s, 'integrations');
    expect(data.points).toHaveLength(2);
    expect(data.points.map(point => point.date)).toEqual(s.days.map(day => day.date));
    expect(data.points[1]!.endDate).toBe(s.endDateExclusive);
    expect(analyticsLine(data.points, 0, s.startDate, s.endDateExclusive, 3)).toBe('M32.00,20.00 L576.00,20.00');
});
