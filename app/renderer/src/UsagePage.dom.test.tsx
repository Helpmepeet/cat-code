import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { act } from 'react';
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

test('local hourly heatmap exposes offset and recorded values without selecting on focus', async () => {
    const snapshot = await recordedSnapshot();
    const tree = await harness.mount(<UsagePage state={{ snapshot, status: 'ready' }}/>);
    const cells = tree.container.querySelectorAll<SVGGElement>('.usage-heat-cell');
    expect(cells).toHaveLength(168);
    expect(cells[1]!.getAttribute('aria-label')).toContain('123 tokens');
    expect(cells[1]!.getAttribute('aria-label')).toContain(`UTC${snapshot.ranges['7d'].days[0]!.hours![1]!.offsetMinutes >= 0 ? '+' : '−'}`);
    await act(async () => cells[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
    expect(document.activeElement).toBe(cells[1]);
    expect(tree.container.querySelector('.usage-day-detail')).toBeNull();
    await act(async () => cells[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(tree.container.querySelector('.usage-day-detail')).not.toBeNull();
});

test('exact values are mounted only after opening the single disclosure', async () => {
    const snapshot = await recordedSnapshot();
    snapshot.ranges['7d'].tokens.fresh = 12_345;
    snapshot.ranges['7d'].days[0]!.tokens.fresh = 12_345;
    snapshot.ranges['7d'].tokens.write = 125;
    snapshot.ranges['7d'].cacheWriteReporting = 'partial';
    snapshot.ranges['7d'].days[0]!.tokens.write = 125;
    snapshot.ranges['7d'].days[0]!.cacheWriteReporting = 'partial';
    const tree = await harness.mount(<UsagePage state={{ snapshot, status: 'ready' }}/>);
    const disclosure = tree.container.querySelector<HTMLDetailsElement>('.usage-values')!;
    expect(disclosure.querySelectorAll('table')).toHaveLength(0);
    await act(async () => { disclosure.open = true; disclosure.dispatchEvent(new Event('toggle')); });
    expect(disclosure.querySelectorAll('table').length).toBeGreaterThanOrEqual(5);
    expect(disclosure.textContent).toContain('Raw decision outcomes by local period');
    expect(disclosure.textContent).toContain('UTC offset');
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
    const cell = tree.container.querySelector<SVGGElement>('.usage-heat-cell')!;
    await act(async () => cell.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(tree.container.querySelector('.usage-day-detail')?.getAttribute('aria-label')).toContain('2026-09-06 to 2026-09-10');
    expect(cell.getAttribute('aria-pressed')).toBe('true');
    expect([...tree.container.querySelectorAll('button')].find(button => button.textContent === 'All')?.getAttribute('aria-pressed')).toBe('true');
});
