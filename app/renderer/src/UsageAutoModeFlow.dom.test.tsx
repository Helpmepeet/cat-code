import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { act } from 'react';
import { collectRetainedUsage } from '../../../src/utils/statsUsage.js';
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js';
import { UsageAutoModeFlow } from './UsageAutoModeFlow.js';

let harness: DomTestHarness;
beforeAll(async () => { harness = await createDomTestHarness(); });
afterEach(async () => { await harness.unmountAll(); });
afterAll(async () => { await harness.teardown(); });

test('flow links can be pinned by keyboard or click and cleared', async () => {
    const snapshot = await collectRetainedUsage([], '2026-09-13T12:00:00.000Z');
    const summary = snapshot.ranges['7d'].autoMode;
    summary.allTools.coverage.state = 'complete';
    summary.allTools.outcomes.allowed = 2;
    summary.routes = [{ route: 'base', outcome: 'allowed', count: 2 }];
    const tree = await harness.mount(<UsageAutoModeFlow summary={summary}/>);
    const link = tree.container.querySelector<SVGPathElement>('.usage-auto-flow-hit')!;
    expect(link.getAttribute('role')).toBe('button');
    await act(async () => link.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(link.getAttribute('aria-pressed')).toBe('true');
    expect(tree.container.querySelector('.usage-auto-flow-readout')?.textContent).toContain('2 of 2');
    await act(async () => tree.container.querySelector<HTMLButtonElement>('.usage-auto-flow-readout button')!.click());
    expect(link.getAttribute('aria-pressed')).toBe('false');
    await act(async () => link.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(link.getAttribute('aria-pressed')).toBe('true');
});
