import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { act } from 'react';
import { collectRetainedUsage } from '../../../src/utils/statsUsage.js';
import { UsageTokenFlow } from './UsageDashboardCharts.js';
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js';
import { usageFlowSeries, usageModelColors } from './usageGraphState.js';

let harness: DomTestHarness;
beforeAll(async () => { harness = await createDomTestHarness(); });
afterEach(async () => { await harness.unmountAll(); });
afterAll(async () => { await harness.teardown(); });

test('area renderer keeps totals, controls, tooltip and day interaction aligned', async () => {
    const snapshot = await collectRetainedUsage([], '2026-09-13T12:00:00.000Z');
    const summary = snapshot.ranges['7d'];
    summary.tokens = { fresh: 10, read: 90, write: 0, output: 5 };
    summary.cacheWriteReporting = 'unreported';
    summary.days[0]!.tokens = { ...summary.tokens };
    summary.models = [{ id: 'model-a', label: 'Model A', kind: 'named', tokens: { ...summary.tokens } }];
    summary.days[0]!.models = [{ id: 'model-a', total: 105 }];
    const selected: string[] = [];
    const tree = await harness.mount(<UsageTokenFlow
        summary={summary}
        colors={usageModelColors(summary.models)}
        selected=""
        onSelect={date => selected.push(date)}
        partial={false}
    />);
    const button = (text: string) => Array.from(tree.container.querySelectorAll('button')).find(item => item.textContent === text)!;
    const seriesButton = (label: string) => tree.container.querySelector<HTMLButtonElement>(`[aria-label="Hide ${label}"],[aria-label="Show ${label}"]`)!;
    const total = () => tree.container.querySelector('.usage-flow-heading strong')?.textContent;

    expect(total()).toBe('105');
    expect(tree.container.querySelectorAll('.usage-flow-area')).toHaveLength(3);
    expect(tree.container.querySelectorAll('.usage-flow-grid-line')).toHaveLength(4);
    expect(tree.container.querySelector('.usage-flow-chart')?.nextElementSibling?.classList.contains('usage-flow-legend')).toBe(true);
    expect(tree.container.querySelectorAll('.usage-flow-series-dot circle')).toHaveLength(3);
    expect(tree.container.querySelectorAll('.usage-flow-series-toggle')).toHaveLength(3);
    expect(tree.container.querySelector('.usage-flow-chart')?.getAttribute('shape-rendering')).toBe('geometricPrecision');
    const area = tree.container.querySelector('.usage-flow-area');
    expect(area?.getAttribute('d')).toContain(' C');
    expect(area?.hasAttribute('stroke')).toBe(false);

    const hits = tree.container.querySelectorAll<SVGGElement>('.usage-flow-hit');
    await act(async () => hits[0]!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
    expect(tree.container.querySelector('.usage-chart-tooltip')?.textContent).toContain(summary.days[0]!.date);
    await act(async () => hits[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(selected).toEqual([summary.days[0]!.date]);

    await act(async () => hits[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
    expect(selected.at(-1)).toBe(summary.days[1]!.date);
    expect(document.activeElement).toBe(hits[1]);

    await act(async () => seriesButton('Cache reads').click());
    expect(total()).toBe('15');
    expect(seriesButton('Cache reads').getAttribute('aria-label')).toBe('Show Cache reads');
    expect(seriesButton('Cache reads').getAttribute('aria-pressed')).toBe('false');
    expect(tree.container.querySelectorAll('.usage-flow-area')).toHaveLength(2);

    await act(async () => button('By model').click());
    expect(total()).toBe('105');
    expect(tree.container.querySelector('[aria-label="Hide Cache reads"]')).toBeNull();
    expect(tree.container.querySelectorAll('.usage-flow-area')).toHaveLength(1);
    await act(async () => seriesButton('Model A').click());
    expect(total()).toBe('0');
    expect(tree.container.querySelectorAll('.usage-flow-area')).toHaveLength(0);
    await act(async () => button('By type').click());
    expect(total()).toBe('15');
    expect(seriesButton('Cache reads').getAttribute('aria-pressed')).toBe('false');
});

test('selected day shows cumulative markers for each active stack', async () => {
    const snapshot = await collectRetainedUsage([], '2026-09-13T12:00:00.000Z');
    const summary = snapshot.ranges['7d'];
    summary.tokens = { fresh: 10, read: 90, write: 0, output: 5 };
    summary.cacheWriteReporting = 'unreported';
    summary.days[0]!.tokens = { ...summary.tokens };
    const tree = await harness.mount(<UsageTokenFlow summary={summary} colors={{}} selected={summary.days[0]!.date} onSelect={() => {}} partial={false}/>);

    const line = tree.container.querySelector('.usage-flow-selection-line');
    const points = [...tree.container.querySelectorAll('.usage-flow-selection-point')];
    expect(line).not.toBeNull();
    expect(points).toHaveLength(3);
    expect(points.map(point => point.getAttribute('fill'))).toEqual([
        'var(--usage-cache)',
        'var(--usage-output)',
        'var(--usage-fresh)',
    ]);
    expect(new Set(points.map(point => point.getAttribute('cx'))).size).toBe(1);
    expect(points.every(point => point.getAttribute('r') === '5.5')).toBe(true);
});

test('subpixel model areas use a stable centerline without inflating the fill', async () => {
    const snapshot = await collectRetainedUsage([], '2026-09-13T12:00:00.000Z');
    const summary = snapshot.ranges['7d'];
    const big = { fresh: 279_000_000, read: 0, write: 0, output: 0 };
    const tiny = { fresh: 467_000, read: 0, write: 0, output: 0 };
    summary.tokens = { fresh: big.fresh + tiny.fresh, read: 0, write: 0, output: 0 };
    summary.days[0]!.tokens = { ...summary.tokens };
    summary.models = [
        { id: 'luna', label: 'gpt-5.6-luna', kind: 'named', tokens: big },
        { id: 'astra', label: 'gpt-6-astra', kind: 'named', tokens: tiny },
    ];
    summary.days[0]!.models = [{ id: 'luna', total: big.fresh }, { id: 'astra', total: tiny.fresh }];
    const tree = await harness.mount(<UsageTokenFlow summary={summary} colors={usageModelColors(summary.models)} selected="" onSelect={() => {}} partial={false}/>);
    await act(async () => Array.from(tree.container.querySelectorAll('button')).find(button => button.textContent === 'By model')!.click());

    const indicator = tree.container.querySelector('.usage-flow-thin-series');
    expect(indicator?.getAttribute('stroke')).toBe('var(--usage-model-yellow)');
    expect(indicator?.getAttribute('stroke-width')).toBe('1');
    expect(indicator?.getAttribute('stroke-linecap')).toBe('round');
    expect(tree.container.querySelector('[fill="var(--usage-model-yellow)"]')?.hasAttribute('stroke')).toBe(false);
});

test('model families keep reference colors while range totals place small series inward', () => {
    const tokens = (fresh: number) => ({ fresh, read: 0, write: 0, output: 0 });
    const models = [
        { id: 'terra', label: 'gpt-5.6-terra', kind: 'named' as const, tokens: tokens(84_000_000) },
        { id: 'other', label: 'Other', kind: 'other' as const, tokens: tokens(1_000_000) },
        { id: 'astra', label: 'gpt-6-astra', kind: 'named' as const, tokens: tokens(3_800_000) },
        { id: 'unknown', label: 'Unknown', kind: 'unknown' as const, tokens: tokens(2_000_000) },
        { id: 'sol', label: 'gpt-5.6-sol', kind: 'named' as const, tokens: tokens(34_500_000) },
        { id: 'luna', label: 'gpt-5.6-luna', kind: 'named' as const, tokens: tokens(28_400_000) },
    ];
    const colors = usageModelColors(models);
    expect(colors).toMatchObject({
        luna: 'var(--usage-model-purple)',
        sol: 'var(--usage-model-blue)',
        terra: 'var(--usage-model-orange)',
        astra: 'var(--usage-model-yellow)',
        other: 'var(--usage-model-pink)',
        unknown: 'var(--usage-other)',
    });
    const summary = {
        models: models.filter(model => model.kind === 'named'),
        days: [],
    } as unknown as Parameters<typeof usageFlowSeries>[0];
    expect(usageFlowSeries(summary, colors, 'model').map(series => series.label)).toEqual([
        'gpt-5.6-terra',
        'gpt-5.6-luna',
        'gpt-6-astra',
        'gpt-5.6-sol',
    ]);
    expect(usageFlowSeries({ ...summary, models }, colors, 'model').map(series => series.label)).toEqual([
        'gpt-5.6-terra',
        'gpt-5.6-luna',
        'Unknown',
        'Other',
        'gpt-6-astra',
        'gpt-5.6-sol',
    ]);
});

test('token types use displayed range totals and reorder after cache reads are hidden', () => {
    const summary = {
        tokens: { fresh: 50, read: 100, write: 5, output: 10 },
        cacheWriteReporting: 'reported',
    } as unknown as Parameters<typeof usageFlowSeries>[0];
    expect(usageFlowSeries(summary, {}, 'type').map(series => series.id)).toEqual([
        'read',
        'output',
        'write',
        'fresh',
    ]);
    expect(usageFlowSeries(summary, {}, 'type', new Set(['read'])).map(series => series.id)).toEqual([
        'fresh',
        'write',
        'output',
    ]);
});
