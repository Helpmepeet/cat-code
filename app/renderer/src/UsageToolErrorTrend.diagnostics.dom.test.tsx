import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { act } from 'react';
import type { UsageRangeSummary } from '../../shared/usageDashboard.js';
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js';
import { UsageToolErrorTrend } from './UsageToolErrorTrend.js';

let harness: DomTestHarness;
beforeAll(async () => { harness = await createDomTestHarness(); });
afterEach(async () => { await harness.unmountAll(); });
afterAll(async () => { await harness.teardown(); });

const summary = {
    range: '7d', startDate: '2026-09-07', endDateExclusive: '2026-09-14', startInclusive: '2026-09-07T00:00:00.000Z', endExclusive: '2026-09-14T00:00:00.000Z',
    tools: [
        { id: 'read', kind: 'named', label: 'Read', requests: 1_000, results: 1_000, errors: 1 },
        { id: 'bash', kind: 'named', label: 'Bash', requests: 800, results: 800, errors: 4 },
        { id: 'edit', kind: 'named', label: 'Edit', requests: 20, results: 20, errors: 12 },
        { id: 'patch', kind: 'named', label: 'apply_patch', requests: 15, results: 15, errors: 8 },
        { id: 'other', kind: 'other', label: 'Other', requests: 2_000, results: 2_000, errors: 900 },
        { id: 'unknown', kind: 'unknown', label: 'Unknown', requests: 1_000, results: 1_000, errors: 400 },
    ],
    days: [
        { date: '2026-09-07', tools: [{ id: 'edit', requests: 10, results: 10, errors: 8 }] },
        { date: '2026-09-08', tools: [{ id: 'edit', requests: 10, results: 10, errors: 4 }] },
    ],
} as unknown as UsageRangeSummary;

function selectedNames(container: HTMLElement): string[] {
    return Array.from(container.querySelectorAll('.usage-tool-picker button[aria-pressed="true"] .usage-tool-picker-name')).map(item => item.textContent!);
}

function toolButton(container: HTMLElement, name: string): HTMLButtonElement {
    return Array.from(container.querySelectorAll<HTMLButtonElement>('.usage-tool-picker button')).find(button => button.querySelector('.usage-tool-picker-name')?.textContent === name)!;
}

test('automatic defaults update on refresh and period change without selecting aggregates', async () => {
    const tree = await harness.mount(<UsageToolErrorTrend summary={summary}/>);
    expect(selectedNames(tree.container)).toEqual(['Bash', 'Edit', 'apply_patch']);

    const refreshed = structuredClone(summary);
    refreshed.tools[0]!.errors = 40;
    await tree.render(<UsageToolErrorTrend summary={refreshed}/>);
    expect(selectedNames(tree.container)).toEqual(['Read', 'Edit', 'apply_patch']);

    const nextPeriod = structuredClone(refreshed);
    nextPeriod.range = '30d';
    nextPeriod.startDate = '2026-08-15';
    nextPeriod.startInclusive = '2026-08-15T00:00:00.000Z';
    nextPeriod.tools[1]!.errors = 60;
    await tree.render(<UsageToolErrorTrend summary={nextPeriod}/>);
    expect(selectedNames(tree.container)).toEqual(['Read', 'Bash', 'Edit']);
});

test('manual choices stop automatic reselection on new summaries', async () => {
    const tree = await harness.mount(<UsageToolErrorTrend summary={summary}/>);
    await act(async () => toolButton(tree.container, 'Edit').click());
    expect(selectedNames(tree.container)).toEqual(['Bash', 'apply_patch']);
    const refreshed = structuredClone(summary);
    refreshed.tools[0]!.errors = 40;
    await tree.render(<UsageToolErrorTrend summary={refreshed}/>);
    expect(selectedNames(tree.container)).toEqual(['Bash', 'apply_patch']);
});

test('deliberate manual empty selection survives refresh and period changes', async () => {
    const tree = await harness.mount(<UsageToolErrorTrend summary={summary}/>);
    for (const name of ['Bash', 'Edit', 'apply_patch']) await act(async () => toolButton(tree.container, name).click());
    expect(selectedNames(tree.container)).toEqual([]);
    const refreshed = structuredClone(summary);
    refreshed.tools[0]!.errors = 40;
    await tree.render(<UsageToolErrorTrend summary={refreshed}/>);
    expect(selectedNames(tree.container)).toEqual([]);
    await tree.render(<UsageToolErrorTrend summary={{ ...refreshed, range: 'all' }}/>);
    expect(selectedNames(tree.container)).toEqual([]);
    expect(tree.container.querySelector('.usage-note')?.textContent).toBe('Select a tool to plot its recorded error rate.');
    expect(tree.container.querySelector('.usage-tool-error-series')).toBeNull();
});

test('a vanished manual selection falls back to current error leaders without undoing deliberate deselection', async () => {
    const tree = await harness.mount(<UsageToolErrorTrend summary={summary}/>);
    for (const name of ['Bash', 'apply_patch']) await act(async () => toolButton(tree.container, name).click());
    expect(selectedNames(tree.container)).toEqual(['Edit']);
    const nextPeriod = structuredClone(summary);
    nextPeriod.range = '30d';
    nextPeriod.tools = [{ id: 'legacy-patch', kind: 'named', label: 'Apply_patch', requests: 10, results: 10, errors: 5 }];
    nextPeriod.days = [{ ...nextPeriod.days[0]!, tools: [{ id: 'legacy-patch', requests: 10, results: 10, errors: 5 }] }];
    await tree.render(<UsageToolErrorTrend summary={nextPeriod}/>);
    expect(selectedNames(tree.container)).toEqual(['Apply_patch']);
    await act(async () => toolButton(tree.container, 'Apply_patch').click());
    expect(selectedNames(tree.container)).toEqual([]);
    await tree.render(<UsageToolErrorTrend summary={summary}/>);
    expect(selectedNames(tree.container)).toEqual([]);
});

test('selected tool names show period-wide rates and exact error/result counts', async () => {
    const tree = await harness.mount(<UsageToolErrorTrend summary={summary}/>);
    expect(toolButton(tree.container, 'Edit').textContent).toBe('Edit 60.0%, 12 errors / 20 matched results');
    expect(toolButton(tree.container, 'Bash').textContent).toBe('Bash 0.5%, 4 errors / 800 matched results');
    expect(toolButton(tree.container, 'Read').querySelector('.usage-tool-picker-counts')).toBeNull();
    await act(async () => toolButton(tree.container, 'Read').click());
    expect(toolButton(tree.container, 'Read').textContent).toBe('Read 0.1%, 1 error / 1,000 matched results');

    const noResults = structuredClone(summary);
    noResults.tools[2]!.results = 0;
    noResults.tools[2]!.errors = 0;
    for (const day of noResults.days) { day.tools[0]!.results = 0; day.tools[0]!.errors = 0; }
    await tree.render(<UsageToolErrorTrend summary={noResults}/>);
    expect(toolButton(tree.container, 'Edit').textContent).toBe('Edit No matched results, 0 errors / 0 matched results');
});

for (const retained of [true, false]) test(`omitted build observations show incomplete version history with ${retained ? 'retained' : 'no retained'} markers`, async () => {
    const omitted = structuredClone(summary);
    omitted.days[0]!.tools[0]!.builds = {
        items: retained ? [{ sha: '12345678', dirty: false, requests: 2, results: 2, errors: 1, firstObservedAt: '2026-09-07T08:00:00.000Z' }] : [],
        omitted: { count: 2, requests: retained ? 8 : 10, results: retained ? 8 : 10, errors: retained ? 7 : 8 },
    };
    omitted.days[1]!.tools[0]!.builds = { items: [], omitted: { count: 3, requests: 10, results: 10, errors: 4 } };
    omitted.days[0]!.tools.push({ id: 'read', requests: 100, results: 100, errors: 1, builds: { items: [], omitted: { count: 100, requests: 100, results: 100, errors: 1 } } });
    const tree = await harness.mount(<UsageToolErrorTrend summary={omitted} timezone="UTC"/>);
    expect(tree.container.querySelector('.usage-tool-version-notice')?.textContent).toBe('Incomplete version history: 5 build observations omitted for selected tools.');
    expect(tree.container.querySelectorAll('.usage-tool-build-marker')).toHaveLength(retained ? 1 : 0);
    const commits = tree.container.querySelector<HTMLButtonElement>('.usage-tool-build-toggle');
    if (retained) {
        await act(async () => commits!.click());
        expect(tree.container.querySelector('.usage-tool-version-notice')?.textContent).toContain('5 build observations');
    } else expect(commits).toBeNull();
    await act(async () => toolButton(tree.container, 'Edit').click());
    expect(tree.container.querySelector('.usage-tool-version-notice')).toBeNull();
});
