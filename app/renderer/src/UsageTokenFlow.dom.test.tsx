import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { act } from 'react';
import { collectRetainedUsage } from '../../../src/utils/statsUsage.js';
import { UsageTokenFlow } from './UsageDashboardCharts.js';
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js';
import { usageGraphColors } from './usageGraphState.js';

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
        colors={usageGraphColors(['model-a'])}
        selected=""
        onSelect={date => selected.push(date)}
        partial={false}
    />);
    const button = (text: string) => Array.from(tree.container.querySelectorAll('button')).find(item => item.textContent === text)!;
    const total = () => tree.container.querySelector('.usage-flow-heading strong')?.textContent;

    expect(total()).toBe('105');
    expect(tree.container.querySelectorAll('.usage-flow-area')).toHaveLength(3);
    expect(tree.container.querySelectorAll('.usage-flow-grid-line')).toHaveLength(4);
    expect(tree.container.querySelector('.usage-flow-chart')?.nextElementSibling?.classList.contains('usage-flow-legend')).toBe(true);
    expect(tree.container.querySelectorAll('.usage-flow-legend circle')).toHaveLength(3);
    expect(tree.container.querySelector('.usage-flow-area')?.getAttribute('d')).toContain(' C');

    const hits = tree.container.querySelectorAll<SVGGElement>('.usage-flow-hit');
    await act(async () => hits[0]!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
    expect(tree.container.querySelector('.usage-chart-tooltip')?.textContent).toContain(summary.days[0]!.date);
    await act(async () => hits[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(selected).toEqual([summary.days[0]!.date]);

    await act(async () => hits[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
    expect(selected.at(-1)).toBe(summary.days[1]!.date);
    expect(document.activeElement).toBe(hits[1]);

    await act(async () => button('Hide cache reads').click());
    expect(total()).toBe('15');
    expect(tree.container.textContent).toContain('Excluding cache reads');
    expect(tree.container.querySelectorAll('.usage-flow-area')).toHaveLength(2);

    await act(async () => button('By model').click());
    expect(total()).toBe('105');
    expect(button('Hide cache reads').disabled).toBe(true);
    expect(tree.container.querySelectorAll('.usage-flow-area')).toHaveLength(1);
});
