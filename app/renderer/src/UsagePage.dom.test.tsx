import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { act } from 'react';
import { readFileSync } from 'node:fs';
import { collectRetainedUsage } from '../../../src/utils/statsUsage.js';
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js';
import { UsagePage } from './UsagePage.js';
import type { UsageSelection } from './usageDashboardState.js';
import { usageProjectId } from '../../shared/usageDashboard.js';
import { useState } from 'react';

let harness: DomTestHarness;
beforeAll(async () => { harness = await createDomTestHarness(); });
afterEach(async () => { await harness.unmountAll(); });
afterAll(async () => { await harness.teardown(); });

async function recordedSnapshot() {
    const snapshot = await collectRetainedUsage([], '2026-09-13T12:00:00.000Z');
    const summary = snapshot.ranges['7d'];
    summary.tokens.fresh = 123;
    summary.records = 1;
    summary.days[0]!.tokens.fresh = 123;
    summary.days[0]!.sessions = 1;
    summary.days[0]!.hours![1]!.tokens = 123;
    summary.days[0]!.hours![1]!.requests = 4;
    return snapshot;
}

test('analytics layout keeps one bottom table and uses the selected range', async () => {
    const snapshot = await recordedSnapshot();
    snapshot.ranges['30d'].tokens.fresh = 123;
    snapshot.ranges['30d'].records = 1;
    const tree = await harness.mount(<UsagePage state={{ snapshot, status: 'ready' }}/>);
    expect(tree.container.querySelectorAll('.usage-metric')).toHaveLength(5);
    expect([...tree.container.querySelectorAll('.usage-panel-heading')].map(node => node.textContent)).toContain('Tokens');
    expect(tree.container.querySelector('.usage-heatmap')).not.toBeNull();
    expect(tree.container.querySelectorAll('.usage-values')).toHaveLength(1);
    expect(tree.container.querySelector('.usage-values summary')?.textContent).toBe('View as table');
    expect(tree.container.querySelector('.usage-values table')).toBeNull();
    const range = [...tree.container.querySelectorAll('button')].find(button => button.textContent === '30 days')!;
    await act(async () => range.click());
    expect(range.getAttribute('aria-pressed')).toBe('true');
    expect(tree.container.querySelector('.usage-freshness')?.textContent).toContain('Aug 15 to Sep 13');
    const heatmap = tree.container.querySelector('.usage-heatmap')!;
    expect(heatmap.querySelectorAll('.usage-heat-cell')).toHaveLength(30);
    expect(new Set([...heatmap.querySelectorAll<SVGGElement>('.usage-heat-cell')].map(cell => cell.querySelector('rect')?.getAttribute('x'))).size).toBe(5);
    expect(tree.container.querySelector('.usage-chart-toolbar > span')?.textContent).toBe('Aug 15 to Sep 13');
});

test('day focus does not select until activated; selection opens the session detail inline', async () => {
    const snapshot = await recordedSnapshot();
    const tree = await harness.mount(<UsagePage state={{ snapshot, status: 'ready' }}/>);
    const hits = tree.container.querySelectorAll<SVGGElement>('.usage-flow-hit');
    await act(async () => hits[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
    expect(document.activeElement).toBe(hits[1]);
    expect(tree.container.querySelector('.usage-day-detail')).toBeNull();
    await act(async () => hits[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(tree.container.querySelector('.usage-day-detail')?.textContent).toContain('123 tokens');
    expect(tree.container.querySelector('.usage-day-detail')?.textContent).toContain('No contributing sessions were recorded');
    await act(async () => tree.container.querySelector<HTMLButtonElement>('.usage-detail-header button')!.click());
    expect(tree.container.querySelector('.usage-day-detail')).toBeNull();
});

test('selected-day concurrency shows local time and exact zero-valued slots', async () => {
    const snapshot = await recordedSnapshot();
    const day = snapshot.ranges['7d'].days[0]!;
    day.sessions = 2;
    day.parallel = { state: 'available', minutes: [1, 1, 0], peak: 2, tenMinutePeaks: [[6, 2]] };
    const tree = await harness.mount(<UsagePage state={{ snapshot, status: 'ready' }}/>);
    await act(async () => tree.container.querySelector<SVGGElement>('.usage-flow-hit')!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    const running = tree.container.querySelector<SVGSVGElement>('.usage-running svg')!;
    expect(running.textContent).toContain('00:00');
    expect(running.textContent).toContain('24:00');
    expect(running.textContent).toContain('2');
    const disclosure = tree.container.querySelector<HTMLDetailsElement>('.usage-values')!;
    await act(async () => { disclosure.open = true; disclosure.dispatchEvent(new Event('toggle')); });
    const table = [...disclosure.querySelectorAll('table')].find(item => item.caption?.textContent === `Sessions running by elapsed ten-minute slot for ${day.date}`)!;
    const rows = table.querySelectorAll('tbody tr');
    expect(rows).toHaveLength(144);
    expect(rows[0]?.textContent).toBe('000:000');
    expect(rows[6]?.textContent).toBe('601:002');
});

test('daily heatmap exposes recorded values and selects only days in the current range', async () => {
    const snapshot = await recordedSnapshot();
    const recorded = snapshot.ranges['7d'].days[0]!.date;
    snapshot.ranges['30d'].days.find(day => day.date === recorded)!.tokens.fresh = 123;
    const tree = await harness.mount(<UsagePage state={{ snapshot, status: 'ready' }}/>);
    const cells = tree.container.querySelectorAll<SVGGElement>('.usage-heat-cell');
    expect(cells).toHaveLength(30);
    const boxes = [...tree.container.querySelectorAll<SVGRectElement>('.usage-heatmap rect')];
    expect(Math.min(...boxes.map(box => Number(box.getAttribute('x'))))).toBe(0);
    expect(Math.max(...boxes.map(box => Number(box.getAttribute('width'))))).toBe(44);
    const cell = tree.container.querySelector<SVGGElement>(`[data-date="${recorded}"]`)!;
    expect(cell.getAttribute('aria-label')).toBe(`${recorded}: 123 tokens`);
    const older = cells[0]!;
    expect(older.getAttribute('aria-disabled')).toBe('true');
    await act(async () => older.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(tree.container.querySelector('.usage-day-detail')).toBeNull();
    await act(async () => cell.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
    expect(document.activeElement?.getAttribute('data-date')).toBe(snapshot.ranges['7d'].days[1]!.date);
    expect(tree.container.querySelector('.usage-day-detail')).toBeNull();
    await act(async () => cell.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(tree.container.querySelector('.usage-day-detail')?.textContent).toContain('123 tokens');
});

test('exact values are mounted only after opening the single disclosure', async () => {
    const snapshot = await recordedSnapshot();
    snapshot.ranges['7d'].tokens.fresh = 12_345;
    snapshot.ranges['7d'].days[0]!.tokens.fresh = 12_345;
    snapshot.ranges['7d'].tokens.write = 125;
    snapshot.ranges['7d'].cacheWriteReporting = 'partial';
    snapshot.ranges['7d'].days[0]!.tokens.write = 125;
    snapshot.ranges['7d'].days[0]!.cacheWriteReporting = 'partial';
    snapshot.ranges['30d'].days.at(-1)!.tokens.fresh = 67_890;
    const tree = await harness.mount(<UsagePage state={{ snapshot, status: 'ready' }}/>);
    const disclosure = tree.container.querySelector<HTMLDetailsElement>('.usage-values')!;
    expect(disclosure.querySelectorAll('table')).toHaveLength(0);
    await act(async () => { disclosure.open = true; disclosure.dispatchEvent(new Event('toggle')); });
    expect(disclosure.querySelectorAll('table').length).toBeGreaterThanOrEqual(5);
    expect(disclosure.textContent).toContain('Raw decision outcomes by local period');
    const daily = [...disclosure.querySelectorAll('table')].find(table => table.caption?.textContent === 'Recorded activity by local day');
    expect(daily?.querySelector('tbody')?.textContent).toBe(`${snapshot.ranges['30d'].days.at(-1)!.date}67,8900`);
    expect(disclosure.textContent).toContain('12,345');
    expect(disclosure.querySelector('table tbody tr')?.textContent).toContain('125 reported');
    expect([...disclosure.querySelectorAll('table')].find(table => table.caption?.textContent === 'Raw decision outcomes by local period')?.querySelector('thead')?.textContent).toContain('Needs reviewOperational errorCancelledUnknownIncomplete');
});

test('refresh reports failure while retaining saved analytics', async () => {
    const snapshot = await recordedSnapshot();
    let refreshes = 0;
    const tree = await harness.mount(<UsagePage state={{ snapshot, status: 'error' }} onRefresh={() => refreshes++}/>);
    const button = tree.container.querySelector<HTMLButtonElement>('.usage-refresh')!;
    expect(button.getAttribute('aria-label')).toBe('Refresh failed. Try again');
    expect(tree.container.querySelector('.usage-flow-chart')).not.toBeNull();
    await act(async () => button.click());
    expect(refreshes).toBe(1);
});
test('refresh is disabled while analytics is loading', async () => {
    const snapshot = await recordedSnapshot();
    let refreshes = 0;
    const tree = await harness.mount(<UsagePage state={{ snapshot, status: 'loading' }} onRefresh={() => refreshes++}/>);
    const button = tree.container.querySelector<HTMLButtonElement>('.usage-refresh')!;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-label')).toBe('Refreshing analytics');
    await act(async () => button.click());
    expect(refreshes).toBe(0);
});

test('controlled period and day restore on remount and clear on period change', async () => {
    const snapshot = await recordedSnapshot();
    function Container() {
        const [shown, setShown] = useState(true);
        const [selection, setSelection] = useState<UsageSelection>({ range: '7d', date: snapshot.ranges['7d'].days[0]!.date });
        return <><button onClick={() => setShown(!shown)}>Toggle page</button>{shown && <UsagePage state={{ snapshot, status: 'ready' }} selection={selection} onSelectionChange={setSelection}/>}</>;
    }
    const tree = await harness.mount(<Container/>);
    const toggle = tree.container.querySelector<HTMLButtonElement>('button')!;
    await act(async () => toggle.click());
    await act(async () => toggle.click());
    expect(tree.container.querySelector('.usage-day-detail')?.textContent).toContain('123 tokens');
    await act(async () => [...tree.container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '30 days')!.click());
    expect(tree.container.querySelector('.usage-day-detail')).toBeNull();
});

test('selected contributor opens its matching catalog session', async () => {
    const snapshot = await recordedSnapshot();
    const day = snapshot.ranges['7d'].days[0]!;
    const sessionId = '78e4ba38-e439-4c21-aa04-8e1546fddfe2';
    const row = { sessionId, appSessionId: null, cwd: '/work/project', cwdExists: true, title: 'Investigate usage', displayLabel: 'Investigate usage', name: null, live: false, restorable: false, parked: false, status: 'history' as const, inRegistry: false, modifiedAtMs: 0, createdAtMs: 0, lastMessageSentAt: null, transcriptActivityAtMs: null, gitBranch: null, tag: null, mode: null, agentSetting: null, prNumber: null, prRepository: null };
    day.contributors = { state: 'truncated', omitted: 1, items: [{ id: 'session-a', engineSessionId: sessionId, project: { id: usageProjectId(row.cwd), label: 'project' }, tokens: { fresh: 123, read: 0, write: 0, output: 0 }, requests: 0, results: 0, errors: 0, rank: { tokens: 1, requests: 1, errors: 1 }, tokenCost: { usd: 0, pricedTokens: 0 }, models: [], modelDetail: { state: 'full', omitted: 0 }, timeline: { state: 'unavailable', omitted: 0, items: [] } }] };
    const opened: string[] = [];
    const tree = await harness.mount(<UsagePage state={{ snapshot, status: 'ready' }} sessionRows={[row]} onOpenSession={item => opened.push(item.sessionId)}/>);
    await act(async () => tree.container.querySelector<SVGGElement>('.usage-flow-hit')!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(tree.container.querySelector('.usage-day-detail')?.textContent).toContain('Investigate usage');
    await act(async () => tree.container.querySelector<HTMLButtonElement>('.usage-session-name')!.click());
    expect(opened).toEqual([sessionId]);
});

test('model slices remain keyboard operable', async () => {
    const snapshot = await recordedSnapshot();
    const summary = snapshot.ranges['7d'];
    summary.tokens.fresh = 10_000;
    summary.days[0]!.tokens.fresh = 10_000;
    summary.models = [
        { id: 'tiny', kind: 'named', label: 'Tiny', tokens: { fresh: 1, read: 0, write: 0, output: 0 }, tokenCost: { usd: 0, pricedTokens: 0 } },
        { id: 'large', kind: 'named', label: 'Large', tokens: { fresh: 9_999, read: 0, write: 0, output: 0 }, tokenCost: { usd: 0, pricedTokens: 0 } },
    ];
    const tree = await harness.mount(<UsagePage state={{ snapshot, status: 'ready' }}/>);
    const slice = [...tree.container.querySelectorAll<SVGElement>('.usage-model-donut [role="button"]')].find(item => item.getAttribute('aria-label')?.includes('Tiny'))!;
    await act(async () => slice.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(slice.getAttribute('aria-pressed')).toBe('true');
    expect(tree.container.querySelector('.usage-details-donut-center')?.textContent).toContain('Tiny');
    await act(async () => slice.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(slice.getAttribute('aria-pressed')).toBe('false');
});

test('model usage names current models and keeps retired Sol and Luna in All models', async () => {
    const snapshot = await recordedSnapshot();
    const summary = snapshot.ranges['7d'];
    const current = ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-luna', 'gpt-5.6-terra'];
    const names = ['gpt-5.6-sol', 'gpt-5.6-luna', ...current];
    summary.models = names.map((label, index) => ({ id: label, label, kind: 'named', tokens: { fresh: 1000 - index * 100, read: 0, write: 0, output: 0 } }));
    summary.tokens.fresh = 4500;
    summary.days[0]!.tokens.fresh = 4500;
    summary.days[0]!.models = summary.models.map(model => ({ id: model.id, total: model.tokens.fresh }));
    const tree = await harness.mount(<UsagePage state={{ snapshot, status: 'ready' }}/>);
    const key = () => tree.container.querySelector('.usage-model-key')!.textContent!;
    for (const name of current) expect(key()).toContain(name);
    expect(key()).not.toContain('gpt-5.6-sol');
    expect(key()).not.toContain('gpt-5.6-luna');
    expect(tree.container.querySelector('.usage-details-donut-center')?.textContent).toBe('4 models');
    const all = tree.container.querySelector<HTMLButtonElement>('.usage-model-scope button:last-child')!;
    await act(async () => all.click());
    expect(key()).toContain('gpt-5.6-sol');
    expect(key()).toContain('gpt-5.6-luna');
    expect(tree.container.querySelector('.usage-details-donut-center')?.textContent).toBe('6 models');
    expect(all.getAttribute('aria-pressed')).toBe('true');
});

test('heatmap selection in All resolves to its local aggregate bucket', async () => {
    const snapshot = await recordedSnapshot();
    const all = snapshot.ranges.all;
    all.startDate = '2026-09-01';
    all.bucketDays = 5;
    all.tokens.fresh = 123;
    all.records = 1;
    all.days = [{ ...structuredClone(snapshot.ranges['7d'].days[0]!), date: '2026-09-06', hours: undefined }];
    const tree = await harness.mount(<UsagePage state={{ snapshot, status: 'ready' }}/>);
    await act(async () => [...tree.container.querySelectorAll('button')].find(button => button.textContent === 'All')!.click());
    const cell = tree.container.querySelector<SVGGElement>('[data-date="2026-09-07"]')!;
    await act(async () => cell.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(tree.container.querySelector('.usage-day-detail')?.getAttribute('aria-label')).toContain('2026-09-06 to 2026-09-10');
    expect(cell.getAttribute('aria-pressed')).toBe('true');
    expect([...tree.container.querySelectorAll('button')].find(button => button.textContent === 'All')?.getAttribute('aria-pressed')).toBe('true');
});

test('volume comparisons stay neutral in both directions while cache rate keeps its directional colors', async () => {
    const style = document.createElement('style');
    style.textContent = readFileSync(new URL('./usageDashboard.css', import.meta.url), 'utf8') + `
        .usage-content {
            --usage-secondary: rgb(100, 100, 100);
            --usage-delta-up: rgb(0, 160, 0);
            --usage-delta-down: rgb(180, 0, 0);
        }
    `;
    document.head.appendChild(style);
    try {
        const snapshot = await recordedSnapshot();
        const summary = snapshot.ranges['7d'];
        summary.activeDays = 1;
        const tree = await harness.mount(<UsagePage state={{ snapshot, status: 'ready' }}/>);
        for (const increase of [true, false]) {
            const current = increase ? { fresh: 20, read: 80, write: 0, output: 0 } : { fresh: 40, read: 10, write: 0, output: 0 };
            const previous = increase ? { fresh: 30, read: 20, write: 0, output: 0 } : { fresh: 20, read: 80, write: 0, output: 0 };
            summary.tokens = current;
            summary.sessions = increase ? 2 : 1;
            summary.requests = increase ? 20 : 10;
            summary.previousPeriod = {
                startInclusive: '2026-08-31T00:00:00.000Z',
                endInclusive: '2026-09-06T12:00:00.000Z',
                tokens: previous, activeDays: 1, sessions: increase ? 1 : 2,
                records: 1, requests: increase ? 10 : 20,
                cachedInputShare: null, cacheWriteReporting: 'unreported',
            };
            await tree.render(<UsagePage state={{ snapshot, status: 'ready' }}/>);
            const tiles = [...tree.container.querySelectorAll('.usage-metric')];
            expect(tiles).toHaveLength(5);
            for (const tile of tiles) {
                const delta = tile.querySelector<HTMLElement>('.usage-metric-delta')!;
                expect(delta.getAttribute('aria-label')).toContain(increase ? 'increase' : 'decrease');
                expect(delta.textContent).toContain(increase ? '▲' : '▼');
                expect(getComputedStyle(delta).color).toBe(tile.classList.contains('usage-metric-cache')
                    ? increase ? 'rgb(0, 160, 0)' : 'rgb(180, 0, 0)'
                    : 'rgb(100, 100, 100)');
            }
        }
    } finally {
        style.remove();
    }
});
