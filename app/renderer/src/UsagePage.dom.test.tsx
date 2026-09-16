import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { act } from 'react';
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js';
import type { UsageSelection } from './usageDashboardState.js';
import { UsagePage } from './UsagePage.js';
import { collectRetainedUsage } from '../../../src/utils/statsUsage.js';
let harness: DomTestHarness;
beforeAll(async () => { harness = await createDomTestHarness(); });
afterEach(async () => { await harness.unmountAll(); });
afterAll(async () => { await harness.teardown(); });
test('range controls and chart keyboard selection expose matching UTC values without a session', async () => {
    const snapshot = await collectRetainedUsage([], '2026-09-13T12:00:00.000Z');
    const tree = await harness.mount(<UsagePage state={{ snapshot, status: 'ready' }}/>);
    const button = Array.from(tree.container.querySelectorAll('button')).find(b => b.textContent === '30 days')!;
    await act(async () => button.click());
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(tree.container.textContent).toContain('2026-08-15 to 2026-09-13');
    const day = tree.container.querySelector('g[role="button"]')!;
    await act(async () => day.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(tree.container.querySelector('.usage-day-detail')?.textContent).toContain('2026-08-15');
    expect(tree.container.querySelector('.usage-values summary')?.textContent).toBe('Accessible values table');
    expect(tree.container.querySelector('.usage-values table')?.querySelectorAll('tbody tr')).toHaveLength(30);
});

test('heatmap keyboard selection, error modes, and model donut expose recorded values', async () => {
    const snapshot = await collectRetainedUsage([], '2026-09-13T12:00:00.000Z');
    const summary = snapshot.ranges['7d'];
    summary.days[0]!.hourlyRequests[1] = 4;
    summary.tools = [{ id: 'bash', kind: 'named', label: 'Bash', requests: 10, results: 8, errors: 2 }, { id: 'read', kind: 'named', label: 'Read', requests: 2, results: 1, errors: 1 }];
    summary.models = [{ id: 'a', kind: 'named', label: 'Model A', tokens: { fresh: 10, read: 0, write: 0, output: 0 } }, { id: 'b', kind: 'named', label: 'Model B', tokens: { fresh: 20, read: 0, write: 0, output: 0 } }];
    summary.tokens.fresh = 30;
    const tree = await harness.mount(<UsagePage state={{ snapshot, status: 'ready' }}/>);
    const cells = tree.container.querySelectorAll('.usage-heatmap g[role="button"]');
    expect(cells).toHaveLength(168);
    expect(tree.container.querySelectorAll('.usage-heatmap [tabindex="0"]')).toHaveLength(1);
    await act(async () => cells[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
    expect(cells[7]!.getAttribute('tabindex')).toBe('0');
    await act(async () => cells[7]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(tree.container.querySelector('.usage-day-detail')?.textContent).toContain('2026-09-07');
    expect(tree.container.querySelector('.usage-heatmap')?.textContent).toContain('4 tool requests');
    const errorRows = () => Array.from(tree.container.querySelectorAll<HTMLButtonElement>('.usage-error-row'));
    expect(errorRows()[0]!.textContent).toContain('Bash');
    await act(async () => Array.from(tree.container.querySelectorAll('button')).find(b => b.textContent === 'Rate')!.click());
    expect(errorRows()[0]!.textContent).toContain('Read');
    await act(async () => errorRows()[1]!.click());
    expect(tree.container.textContent).toContain('6 successful · 2 errors · 2 without a matched result');
    expect(tree.container.querySelector('.usage-model-key')?.textContent).toContain('Model A');
    expect(tree.container.querySelector('.usage-model-key')?.textContent).toContain('33.3%');
});

test('day drilldown opens its matched catalog session and does not change on hover', async () => {
    const { usageProjectId } = await import('../../shared/usageDashboard.js');
    const snapshot = await collectRetainedUsage([], '2026-09-13T12:00:00.000Z');
    const day = snapshot.ranges['7d'].days[0]!;
    const sessionId = '78e4ba38-e439-4c21-aa04-8e1546fddfe2';
    const row = {
        sessionId, appSessionId: null, cwd: '/work/project', cwdExists: true,
        title: 'Investigate usage', displayLabel: 'Investigate usage', name: null,
        live: false, restorable: false, parked: false, status: 'history' as const, inRegistry: false,
        modifiedAtMs: 0, createdAtMs: 0, lastMessageSentAt: null, transcriptActivityAtMs: null,
        gitBranch: null, tag: null, mode: null, agentSetting: null, prNumber: null, prRepository: null,
    };
    day.tokens.fresh = 123;
    day.contributors = { state: 'truncated', omitted: 2, items: [{
        id: 'a', engineSessionId: sessionId, project: { id: usageProjectId(row.cwd), label: 'project' },
        tokens: { fresh: 100, read: 0, write: 0, output: 0 }, requests: 3, results: 2, errors: 1,
        models: [{ id: 'm', kind: 'named', label: 'Model A', tokens: { fresh: 100, read: 0, write: 0, output: 0 } }],
        modelDetail: { state: 'full', omitted: 0 },
    }] };
    const opened: string[] = [];
    const tree = await harness.mount(<UsagePage state={{ snapshot, status: 'ready' }} sessionRows={[row]} onOpenSession={r => opened.push(r.sessionId)}/>);
    const bars = tree.container.querySelectorAll('.usage-chart g[role="button"]');
    await act(async () => bars[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(tree.container.querySelector('.usage-day-detail')?.textContent).toContain('123 tokens');
    expect(tree.container.querySelector('.usage-day-detail')?.textContent).toContain('2 more are not shown');
    expect(tree.container.querySelector('.usage-day-detail')?.textContent).not.toContain('Selected day');
    expect(tree.container.querySelector('.usage-day-detail')?.textContent).not.toContain('Usage on this day');
    await act(async () => bars[1]!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
    expect(tree.container.querySelector('.usage-day-detail')?.textContent).toContain(day.date);
    await act(async () => tree.container.querySelector<HTMLButtonElement>('.usage-session-open')!.click());
    expect(opened).toEqual([sessionId]);
    await act(async () => Array.from(tree.container.querySelectorAll('button')).find(b => b.textContent === 'Clear selection')!.click());
    expect(tree.container.querySelector('.usage-day-detail')).toBeNull();
});

test('controlled period and day restore on remount and clear when the period changes', async () => {
    const { useState } = await import('react');
    const snapshot = await collectRetainedUsage([], '2026-09-13T12:00:00.000Z');
    function Container() {
        const [shown, setShown] = useState(true);
        const [selection, setSelection] = useState<UsageSelection>({ range: '30d', date: '2026-08-15' });
        return <><button onClick={() => setShown(!shown)}>Toggle page</button>{shown && <UsagePage state={{ snapshot, status: 'ready' }} selection={selection} onSelectionChange={setSelection}/>}</>;
    }
    const tree = await harness.mount(<Container/>);
    const toggle = tree.container.querySelector('button')!;
    await act(async () => toggle.click());
    await act(async () => toggle.click());
    expect(tree.container.querySelector('.usage-day-detail')?.textContent).toContain('2026-08-15');
    await act(async () => Array.from(tree.container.querySelectorAll('button')).find(b => b.textContent === '7 days')!.click());
    expect(tree.container.querySelector('.usage-day-detail')).toBeNull();
    expect(tree.container.querySelector('.usage-overview-title')).toBeNull();
});

test('All includes older retained history, keeps the cutoff date, and shows both trends without disclosures', async () => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const dir = await mkdtemp(`${tmpdir()}/usage-all-ui-`);
    try {
        const file = `${dir}/session.jsonl`;
        await writeFile(file, JSON.stringify({ type: 'assistant', uuid: 'old', timestamp: '2020-01-02T12:00:00.000Z', message: { id: 'old', model: 'gpt-test', usage: { input_tokens: 15, output_tokens: 2 }, content: [{ type: 'tool_use', id: 't', name: 'Read' }] } }) + '\n');
        const snapshot = await collectRetainedUsage([file], '2026-09-13T12:00:00.000Z');
        const tree = await harness.mount(<UsagePage state={{ snapshot, status: 'ready' }}/>);
        const all = Array.from(tree.container.querySelectorAll('button')).find(b => b.textContent === 'All')!;
        await act(async () => all.click());
        expect(all.getAttribute('aria-pressed')).toBe('true');
        expect(tree.container.querySelector('.usage-freshness')?.textContent).toContain('2020-01-02 to 2026-09-13');
        expect(tree.container.querySelector('.usage-metric.usage-tokens strong')?.textContent).toBe('17');
        expect(tree.container.querySelector('.usage-area-cache')?.closest('details')).toBeNull();
        expect(tree.container.querySelector('.usage-area-requests')?.closest('details')).toBeNull();
        expect(tree.container.querySelector('.usage-model-donut')).not.toBeNull();
        expect(tree.container.querySelector('.usage-activity-details')).toBeNull();
        expect(tree.container.querySelector('.usage-cache-values')?.children).toHaveLength(2);
        expect(tree.container.querySelector('.usage-values')?.textContent).not.toContain('Cache writes');
        await act(async () => tree.container.querySelector('.usage-chart g[role="button"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
        expect(tree.container.querySelector('.usage-day-detail')?.textContent).toContain('17 tokens');
        expect(tree.container.querySelector('.usage-session-table')).toBeNull();
        expect(tree.container.querySelectorAll('.usage-area-requests g[role="button"]')).toHaveLength(3);
    } finally { await rm(dir, { recursive: true, force: true }); }
});

test('tool trend hover previews counts; activation selects and clear removes selection', async () => {
    const snapshot = await collectRetainedUsage([], '2026-09-13T12:00:00.000Z');
    snapshot.ranges['7d'].days[0]!.requests = 17;
    const tree = await harness.mount(<UsagePage state={{ snapshot, status: 'ready' }}/>);
    const point = tree.container.querySelector('.usage-area-requests g[role="button"]')!;
    await act(async () => point.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
    expect(tree.container.querySelector('.usage-area-requests .usage-trend-readout')?.textContent).toContain('17 tool requests');
    expect(tree.container.querySelector('.usage-day-detail')).toBeNull();
    await act(async () => point.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(tree.container.querySelector('.usage-day-detail')?.textContent).toContain('17 tool requests');
    await act(async () => Array.from(tree.container.querySelectorAll('button')).find(b => b.textContent === 'Clear selection')!.click());
    expect(point.getAttribute('aria-pressed')).toBe('false');
    expect(tree.container.querySelector('.usage-day-detail')).toBeNull();
});
