import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { act } from 'react';
import { collectRetainedUsage } from '../../../src/utils/statsUsage.js';
import { usageProjectId, type UsageRankedSession } from '../../shared/usageDashboard.js';
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js';
import { UsageAnalyticsIntegrations, UsageAnalyticsSessions } from './UsageAnalyticsSessions.js';

let harness: DomTestHarness;
beforeAll(async () => { harness = await createDomTestHarness(); });
afterEach(async () => { await harness.unmountAll(); });
afterAll(async () => { await harness.teardown(); });
const zero = { fresh: 0, read: 0, write: 0, output: 0 };
const row = { sessionId: 'a', appSessionId: null, cwd: '/work', cwdExists: true, title: 'Catalog title', displayLabel: 'Catalog title', name: null, live: false, restorable: true, parked: false, status: 'history' as const, inRegistry: false, modifiedAtMs: 0, createdAtMs: 0, lastMessageSentAt: null, transcriptActivityAtMs: null, gitBranch: null, tag: null, mode: null, agentSetting: null, prNumber: null, prRepository: null };
async function fixture() {
    const summary = (await collectRetainedUsage([], '2026-10-18T12:00:00Z')).ranges['7d'];
    const a: UsageRankedSession = { id: 'a', rank: { tokens: 1, requests: 1, errors: 2 }, lastActiveAt: '2026-10-17T12:00:00Z', engineSessionId: 'a', project: { id: usageProjectId('/work'), label: 'work' }, tokens: { ...zero, fresh: 100 }, tokenSources: { chat: { ...zero, fresh: 100 }, subagents: zero, compaction: zero }, requests: 2, results: 2, errors: 0, models: [], modelDetail: { state: 'full', omitted: 0 }, timeline: { state: 'unavailable', omitted: 0, items: [] }, tools: [{ id: 'bash', kind: 'named', label: 'Bash', requests: 2, results: 2, errors: 0 }], days: [], dailyDetail: 'full' };
    summary.rankedSessions = { state: 'truncated', omitted: 20, medianTokens: 37, top10Tokens: 900, items: [a, { ...a, id: 'b', engineSessionId: 'b', errors: 8, tokens: { ...zero, fresh: 10 } }] };
    return summary;
}
test('session rows expand with Enter, Space and click; catalog navigation remains a separate action', async () => {
    const summary = await fixture(); const opened: string[] = [];
    const tree = await harness.mount(<UsageAnalyticsSessions summary={summary} sessionRows={[row]} partial onOpenSession={value => opened.push(value.sessionId)} />);
    const session = tree.container.querySelector<HTMLTableRowElement>('.uas-session-row')!;
    expect(session.textContent).toContain('Catalog title');
    expect(session.getAttribute('aria-expanded')).toBe('false');
    await act(async () => session.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(session.getAttribute('aria-expanded')).toBe('true');
    expect(tree.container.textContent).toContain('Tokens by source');
    expect(tree.container.textContent).toContain('Bash');
    expect(tree.container.textContent).toContain('Unpriced');
    await act(async () => tree.container.querySelector<HTMLButtonElement>('.uas-open')!.click());
    expect(opened).toEqual(['a']);
    expect(session.getAttribute('aria-expanded')).toBe('true');
    await act(async () => session.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true })));
    expect(session.getAttribute('aria-expanded')).toBe('false');
    await act(async () => session.click());
    expect(session.getAttribute('aria-expanded')).toBe('true');
});
test('sort switch and sortable headers change ranking and aria-sort', async () => {
    const summary = await fixture();
    const tree = await harness.mount(<UsageAnalyticsSessions summary={summary} sessionRows={[row]} partial={false} />);
    const errors = [...tree.container.querySelectorAll('button')].find(button => button.textContent === 'By tool errors')!;
    await act(async () => errors.click());
    expect(tree.container.querySelector('.uas-session-row')?.textContent).toContain('Session b');
    expect(errors.getAttribute('aria-pressed')).toBe('true');
    const header = [...tree.container.querySelectorAll<HTMLButtonElement>('thead button')].find(button => button.textContent === 'Tool errors')!;
    expect(header.parentElement?.getAttribute('aria-sort')).toBe('descending');
    await act(async () => header.click());
    expect(header.parentElement?.getAttribute('aria-sort')).toBe('ascending');
    expect(tree.container.querySelector('.uas-session-row')?.textContent).toContain('Catalog title');
    expect(tree.container.textContent).toContain('20 omitted');
});
test('all-history does not fabricate session days and integrations use supplied categories', async () => {
    const summary = await fixture(); summary.range = 'all'; summary.bucketDays = 4;
    for (const item of summary.rankedSessions.items) item.dailyDetail = 'unavailable';
    summary.skills = [{ id: 'review', kind: 'named', label: 'Review', requests: 3 }];
    summary.days[0]!.skills = summary.skills;
    const sessions = await harness.mount(<UsageAnalyticsSessions summary={summary} partial={false} />);
    await act(async () => sessions.container.querySelector<HTMLTableRowElement>('.uas-session-row')!.click());
    expect(sessions.container.textContent).toContain('Daily session detail is unavailable');
    const integrations = await harness.mount(<UsageAnalyticsIntegrations summary={summary} partial />);
    expect(integrations.container.textContent).toContain('Review');
    expect(integrations.container.textContent).toContain('Each retained bucket spans up to 4 days.');
    expect(integrations.container.textContent).toContain('No integration calls recorded.');
});
test('all seven headers sort displayed values and expose direction with independently arranged items', async () => {
    const summary = await fixture();
    const base = summary.rankedSessions.items[0]!;
    summary.rankedSessions.items = [
        { ...base, id: 'c', engineSessionId: 'c', tokens: { ...zero, fresh: 50 }, requests: 20, errors: 8, results: 16, tokenSources: { chat: zero, subagents: { ...zero, fresh: 10 }, compaction: zero }, lastActiveAt: '2026-10-18T10:00:00Z' },
        { ...base, requests: 10, errors: 4, results: 20, lastActiveAt: '2026-10-17T10:00:00Z' },
        { ...base, id: 'b', engineSessionId: 'b', tokens: { ...zero, fresh: 20 }, requests: 30, errors: 3, results: 3, tokenSources: { chat: zero, subagents: { ...zero, fresh: 18 }, compaction: zero }, lastActiveAt: '2026-10-16T10:00:00Z' },
    ];
    const rows = [{ ...row, displayLabel: 'Zulu' }, { ...row, sessionId: 'b', displayLabel: 'Alpha' }, { ...row, sessionId: 'c', displayLabel: 'Middle' }];
    const tree = await harness.mount(<UsageAnalyticsSessions summary={summary} sessionRows={rows} partial={false} />);
    const names = () => [...tree.container.querySelectorAll('.uas-session-row .uas-title')].map(element => element.textContent);
    for (const [label, expected, direction] of [
        ['Session', ['Alpha', 'Middle', 'Zulu'], 'ascending'],
        ['Tokens', ['Zulu', 'Middle', 'Alpha'], 'descending'],
        ['Subagents', ['Alpha', 'Middle', 'Zulu'], 'descending'],
        ['Tool requests', ['Alpha', 'Middle', 'Zulu'], 'descending'],
        ['Tool errors', ['Middle', 'Zulu', 'Alpha'], 'descending'],
        ['Error rate', ['Alpha', 'Middle', 'Zulu'], 'descending'],
        ['Last active', ['Middle', 'Zulu', 'Alpha'], 'descending'],
    ] as const) {
        const header = [...tree.container.querySelectorAll<HTMLButtonElement>('.uas-sessions > thead button')].find(button => button.textContent === label)!;
        await act(async () => header.click());
        expect(names()).toEqual([...expected]);
        expect(header.parentElement?.getAttribute('aria-sort')).toBe(direction);
        await act(async () => header.click());
        expect(names()).toEqual([...expected].reverse());
        expect(header.parentElement?.getAttribute('aria-sort')).toBe(direction === 'ascending' ? 'descending' : 'ascending');
    }
    expect(tree.container.querySelector('time')?.dateTime).toBe('2026-10-16T10:00:00Z');
});
test('five range figures retain collector median and top ten share after envelope fallback drops rows', async () => {
    const summary = await fixture();
    summary.sessions = 22;
    summary.tokens = { ...zero, fresh: 1000 };
    summary.days[0]!.tokenSources.subagents = { ...zero, fresh: 200 };
    summary.days[0]!.tokenSources.compaction = { ...zero, fresh: 100 };
    summary.rankedSessions.items = [];
    summary.rankedSessions.omitted = 22;
    const tree = await harness.mount(<UsageAnalyticsSessions summary={summary} partial={false} />);
    expect([...tree.container.querySelectorAll('.uas-figures dd')].map(element => element.textContent)).toEqual(['22', '90.0%', '20.0%', '10.0%', '37']);
});
