import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { act } from 'react';
import { collectRetainedUsage } from '../../../src/utils/statsUsage.js';
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js';
import { UsagePage } from './UsagePage.js';

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
    const tree = await harness.mount(<UsagePage state={{ snapshot, status: 'ready' }}/>);
    const disclosure = tree.container.querySelector<HTMLDetailsElement>('.usage-values')!;
    expect(disclosure.querySelectorAll('table')).toHaveLength(0);
    await act(async () => { disclosure.open = true; disclosure.dispatchEvent(new Event('toggle')); });
    expect(disclosure.querySelectorAll('table').length).toBeGreaterThanOrEqual(5);
    expect(disclosure.textContent).toContain('Raw decision outcomes by local period');
    expect(disclosure.textContent).toContain('UTC offset');
    expect(disclosure.textContent).toContain('12,345');
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
