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
    expect(tree.container.textContent).toContain('Spent by');
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
test('session metadata, error cues, compact tools and source shares survive expansion', async () => {
    const summary = await fixture();
    const a = summary.rankedSessions.items[0]!;
    a.firstActiveAt = '2026-10-17T10:00:00.000Z';
    a.models = [{ id: 'sol', kind: 'named', label: 'Sol', tokens: a.tokens }];
    a.days = [{ date: '2026-10-17', tokens: a.tokens, requests: 2, results: 2, errors: 0 }];
    summary.rankedSessions.items[1]!.errors = 1;
    summary.rankedSessions.items[1]!.results = 20;
    summary.rankedSessions.items.push({ ...a, id: 'hot', engineSessionId: 'hot', errors: 20, results: 20 });
    const tree = await harness.mount(<UsageAnalyticsSessions summary={summary} sessionRows={[row]} partial={false} />);
    expect(tree.container.querySelector('.uas-title')?.getAttribute('title')).toBe('Catalog title');
    expect(tree.container.querySelector('.uas-meta')?.textContent).toContain('Sol');
    expect(tree.container.querySelector('time')?.textContent).toBe('Oct 17');
    expect(tree.container.textContent).toContain('2.0 h');
    expect(tree.container.querySelectorAll('.uas-error-meter')).toHaveLength(3);
    expect(tree.container.querySelectorAll('.uas-flag')).toHaveLength(1);
    await act(async () => tree.container.querySelector<HTMLTableRowElement>('.uas-session-row')!.click());
    expect(tree.container.querySelector('.uas-single')?.textContent).toBe('100 on Oct 17');
    expect(tree.container.querySelector('.uas-tools')?.textContent).toContain('Bash2—');
    expect(tree.container.querySelectorAll('.uas-composition-list .uas-key')).toHaveLength(2);
    expect(tree.container.querySelector('.uas-composition-list')?.textContent).toContain('100.0%');
    const source = tree.container.querySelector('.uas-composition rect')!;
    await act(async () => source.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
    expect(tree.container.querySelector('.uas-source-tip')?.textContent).toBe('Chat · 100 · 100.0%');
});
test('multi-day session chart is 120px high and spans only its retained daily dates', async () => {
    const summary = await fixture();
    const a = summary.rankedSessions.items[0]!;
    a.days = ['2026-10-15', '2026-10-17'].map(date => ({ date, tokens: a.tokens, requests: 2, results: 2, errors: 0 }));
    const tree = await harness.mount(<UsageAnalyticsSessions summary={summary} partial={false} />);
    await act(async () => tree.container.querySelector<HTMLTableRowElement>('.uas-session-row')!.click());
    const chart = tree.container.querySelector('.uas-chart svg')!;
    expect(chart.getAttribute('height')).toBe('120');
    expect(chart.textContent).toContain('Oct 15');
    expect(chart.textContent).toContain('Oct 17');
    expect(chart.textContent).not.toContain('Oct 12');
});
test('integration plot has fixed height, smooth paths and full-plot nearest hover with sorted transient tooltip', async () => {
    const summary = await fixture();
    summary.skills = [{ id: 'a', kind: 'named', label: 'Alpha', requests: 10 }, { id: 'b', kind: 'named', label: 'Beta', requests: 8 }];
    summary.days[3]!.skills = [{ ...summary.skills[0]!, requests: 2 }, { ...summary.skills[1]!, requests: 8 }];
    const tree = await harness.mount(<UsageAnalyticsIntegrations summary={summary} partial={false} />);
    const svg = tree.container.querySelector('.uas-chart svg')!;
    expect(svg.getAttribute('height')).toBe('220');
    expect(svg.querySelector('path')?.getAttribute('d')).toContain(' C');
    expect(svg.querySelectorAll('.uas-grid').length).toBeGreaterThan(1);
    expect(svg.querySelectorAll('circle')).toHaveLength(0);
    const pick = svg.querySelector('.uas-pick')!;
    await act(async () => pick.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 265 })));
    expect(svg.querySelectorAll('.uas-crosshair circle')).toHaveLength(2);
    expect(svg.querySelector('.uas-tip')?.textContent).toContain('Beta8Alpha2');
    expect(tree.container.querySelector('.uas-legend')?.textContent).toBe('AlphaBeta');
    await act(async () => pick.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })));
    expect(svg.querySelector('.uas-tip')).toBeNull();
});
test('All integration date labels thin by physical bounds without removing clustered data points', async () => {
    const summary = await fixture();
    summary.range = 'all'; summary.bucketDays = 1; summary.startDate = '2026-08-15';
    const dates = ['2026-08-15', '2026-09-28', '2026-10-11', '2026-10-12', '2026-10-14', '2026-10-15', '2026-10-17', '2026-10-18'];
    const skill = { id: 'review', kind: 'named' as const, label: 'Review', requests: 1 };
    summary.skills = [{ ...skill, requests: dates.length }];
    summary.days = dates.map(date => ({ ...summary.days[0]!, date, skills: [skill] }));
    const tree = await harness.mount(<UsageAnalyticsIntegrations summary={summary} partial={false} />);
    const svg = tree.container.querySelector('.uas-chart svg')!;
    expect([...svg.querySelectorAll('.uas-x-axis-label')].map(node => node.textContent)).toEqual(['Aug 15', 'Sep 28', 'Oct 18']);
    expect(svg.querySelector('.uas-line')?.getAttribute('d')?.split(' C')).toHaveLength(dates.length);
});
test('only token and error numbers carry the session numeric emphasis', async () => {
    const summary = await fixture();
    const tree = await harness.mount(<UsageAnalyticsSessions summary={summary} partial={false} />);
    const rows = [...tree.container.querySelectorAll('.uas-session-row')];
    for (const row of rows) {
        expect([...row.querySelectorAll('.uas-session-number')].map(number => [...row.children].indexOf(number.parentElement!))).toEqual([1, 4]);
        expect(row.querySelectorAll('.uas-session-number')).toHaveLength(2);
    }
});
test('integration headings include every qualification before the chart separation', async () => {
    const summary = await fixture();
    summary.range = '30d';
    summary.skills = [{ id: 'review', kind: 'named', label: 'Review', requests: 3 }];
    summary.days[0]!.skills = summary.skills;
    const tree = await harness.mount(<UsageAnalyticsIntegrations summary={summary} partial />);
    const card = tree.container.querySelector<HTMLDivElement>('.uas-integrations .uas-card')!;
    const header = card.querySelector('.uas-integration-header')!;
    expect(header.textContent).toContain('Skills used3Partial retained history.Weekly totals');
    expect(header.querySelectorAll('.uas-note')).toHaveLength(2);
    expect(header.nextElementSibling?.classList.contains('uas-chart')).toBe(true);
    expect(header.parentElement).toBe(card);
});
