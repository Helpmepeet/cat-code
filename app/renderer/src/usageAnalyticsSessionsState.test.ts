import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { collectRetainedUsage } from '../../../src/utils/statsUsage.js';
import { usageProjectId, type UsageRankedSession } from '../../shared/usageDashboard.js';
import type { MergedSessionRow } from './sessionsCatalogState.js';
import { analyticsCalendarTickIndices, analyticsLine, analyticsMonotone, analyticsNearestIndex, analyticsScale, integrationSeries, rankedSessions, sessionDailySeries, sessionFigures, sessionLabel, sessionLastActive, sessionSourceSegments, sessionSpan, sessionSpend } from './usageAnalyticsSessionsState.js';

test('last active uses the reporting timezone across midnight', () => {
    expect(sessionLastActive('2026-10-17T23:30:00Z', 'Asia/Bangkok')).toBe('Oct 18');
    expect(sessionLastActive('2026-10-18T01:30:00Z', 'America/Los_Angeles')).toBe('Oct 17');
});

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
test('sessions with changing directories resolve current names only through a unique session identity', () => {
    const session = { ...item(), project: null };
    const row = { sessionId: 'a', cwd: '/destination', displayLabel: 'Current session name' } as MergedSessionRow;
    expect(sessionLabel(session, [row])).toEqual({ row, label: 'Current session name' });
    const renamed = { ...row, displayLabel: 'Renamed session' };
    expect(sessionLabel(session, [renamed])).toEqual({ row: renamed, label: 'Renamed session' });
    expect(sessionLabel(session, [row, { ...row, cwd: '/imported-copy' }])).toEqual({ row: null, label: 'Session a' });
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
test('session detail uses its active span and all-history stays unavailable', async () => {
    const s = await summary(); const a = item();
    const points = sessionDailySeries(a, s);
    expect(points).toHaveLength(1);
    expect(points.find(point => point.date === '2026-10-17')?.values).toEqual([10]);
    a.days.push({ ...a.days[0]!, date: '2026-10-15' });
    expect(sessionDailySeries(a, s).map(point => point.values[0])).toEqual([10, 0, 10]);
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
test('chart scale, monotone geometry, nearest picking and optional retained span', () => {
    expect(analyticsScale(83)).toEqual({ top: 100, ticks: [0, 20, 40, 60, 80, 100] });
    expect(analyticsNearestIndex(250, 30, 490, 7)).toBe(3);
    expect(analyticsNearestIndex(-1, 30, 490, 7)).toBe(0);
    expect(analyticsNearestIndex(999, 30, 490, 7)).toBe(6);
    const path = analyticsMonotone([{ x: 0, y: 0 }, { x: 30, y: 100 }, { x: 60, y: 0 }]);
    expect(path).toContain(' C');
    expect(path).not.toContain('NaN');
    expect(sessionSpan(item())).toBeNull();
    expect(sessionSpan({ ...item(), firstActiveAt: '2026-10-17T10:00:00Z' })).toBe('2.0 h');
});
test('source composition reserves two physical pixels per gap at every measured width', () => {
    const a = item();
    a.tokenSources = { chat: { ...zero, fresh: 50 }, subagents: { ...zero, fresh: 40 }, compaction: { ...zero, fresh: 10 } };
    for (const width of [100, 223, 400]) {
        const segments = sessionSourceSegments(a, width);
        expect(segments.map(value => value.source)).toEqual(['chat', 'subagents', 'compaction']);
        expect(segments[1]!.x - segments[0]!.x - segments[0]!.width).toBeCloseTo(2);
        expect(segments[2]!.x - segments[1]!.x - segments[1]!.width).toBeCloseTo(2);
        expect(segments[2]!.x + segments[2]!.width).toBeCloseTo(width);
        expect(segments[0]!.width / segments[1]!.width).toBeCloseTo(50 / 40);
    }
    a.tokenSources.subagents = zero;
    a.tokenSources.compaction = zero;
    expect(sessionSourceSegments(a, 223)).toEqual([{ source: 'chat', x: 0, width: 223 }]);
    a.tokenSources.chat = zero;
    expect(sessionSourceSegments(a, 223)).toEqual([]);
});
test('Sessions stylesheet uses final source ink, chart text and shared surfaces', () => {
    const css = readFileSync(new URL('./usageAnalyticsSessions.css', import.meta.url), 'utf8');
    expect(css).toContain('.uas-source-subagents { fill: var(--uas-c2); }');
    expect(css).toContain('.uas-source-key-subagents { color: var(--uas-c2); }');
    expect(css).toContain('.uas-family-luna { color: var(--uas-c1); }');
    expect(css).toContain('.uas-chart text { font-size: 11px;');
    expect(css).toContain('box-shadow: var(--usage-card-shadow);');
    expect(css).toContain('background: light-dark(var(--usage-panel), #1c1c1f);');
    expect(css).not.toContain('.uas-composition rect { stroke:');
    expect(css).toContain('.uas-session-number { font-weight: 600; }');
    expect(css).toContain('.uas-card > .uas-integration-header { display: flow-root; margin-bottom: 16px; }');
    expect(css).toContain('margin-bottom: 16px;');
    expect(css).toContain('.uas-integration-header > .uas-note:last-child { margin-bottom: 0; }');
});
test('Sessions physical sizes use the prototype 14px base without depending on the app root rem', () => {
    const css = readFileSync(new URL('./usageAnalyticsSessions.css', import.meta.url), 'utf8');
    for (const declaration of [
        'font-size: 17.5px;', 'font-size: 21px;', 'font-size: 28px;',
        'max-height: 420px;', 'max-width: 392px;', 'max-width: 364px;', 'max-width: 210px;',
        'grid-template-columns: minmax(0,1fr) 49px 63px;',
        'gap: 12px; padding: 0 0 12px; margin: 0 0 12px;',
        'min-height: 1.2em;', 'min-height: 1.1em;',
    ]) expect(css).toContain(declaration);
    expect(css).not.toMatch(/\d(?:\.\d+)?rem\b/);
    expect(css).toContain('.uas-figures dt { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }');
    expect(css).toContain('.uas-chart text { font-size: 11px;');
});
test('sparse All calendar ticks reserve physical label bounds at the clustered right edge', () => {
    const positions = [30, 340, 450, 457, 464, 472, 480], widths = positions.map(() => 39);
    const ticks = [...analyticsCalendarTickIndices(positions, widths)];
    expect(ticks).toEqual([0, 1, 6]);
    for (let i = 1; i < ticks.length; i++) {
        const before = ticks[i - 1]!, after = ticks[i]!;
        const right = positions[before]! + (before === 0 ? widths[before]! : widths[before]! / 2);
        const left = positions[after]! - (after === positions.length - 1 ? widths[after]! : widths[after]! / 2);
        expect(left - right).toBeGreaterThanOrEqual(12);
    }
    expect([...analyticsCalendarTickIndices([], [])]).toEqual([]);
    expect([...analyticsCalendarTickIndices([50], [39])]).toEqual([0]);
    expect([...analyticsCalendarTickIndices([30, 35], [39, 39])]).toEqual([0]);
});
