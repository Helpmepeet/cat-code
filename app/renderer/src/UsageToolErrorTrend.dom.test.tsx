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
        { id: 'read', kind: 'named', label: 'Read', requests: 2, results: 2, errors: 1 },
        { id: 'bash', kind: 'named', label: 'Bash', requests: 2, results: 1, errors: 1 },
    ],
    days: Array.from({ length: 7 }, (_, index) => ({
        date: `2026-09-${String(index + 7).padStart(2, '0')}`,
        tools: index === 0 ? [
            { id: 'read', requests: 2, results: 2, errors: 1, builds: { items: [{ sha: '12345678', dirty: false, requests: 2, results: 2, errors: 1, firstObservedAt: '2026-09-07T08:00:00.000Z' }] } },
            { id: 'bash', requests: 2, results: 1, errors: 1, builds: { items: [
                { sha: '12345678', dirty: false, requests: 1, results: 1, errors: 1, firstObservedAt: '2026-09-07T08:30:00.000Z' },
                { sha: '87654321', dirty: true, requests: 1, results: 0, errors: 0, firstObservedAt: '2026-09-07T09:00:00.000Z' },
            ] } },
        ] : [],
    })),
} as unknown as UsageRangeSummary;

test('tool toggles are multi-select and commit markers use one roving keyboard stop', async () => {
    const tree = await harness.mount(<UsageToolErrorTrend summary={summary}/>);
    const toolButtons = Array.from(tree.container.querySelectorAll<HTMLButtonElement>('.usage-tool-picker button'));
    expect(toolButtons.map(button => button.getAttribute('aria-pressed'))).toEqual(['true', 'true']);
    await act(async () => toolButtons[0]!.click());
    expect(toolButtons.map(button => button.getAttribute('aria-pressed'))).toEqual(['false', 'true']);
    await act(async () => toolButtons[0]!.click());
    expect(toolButtons.map(button => button.getAttribute('aria-pressed'))).toEqual(['true', 'true']);

    const markers = tree.container.querySelectorAll<SVGGElement>('.usage-tool-build-marker');
    expect(markers).toHaveLength(2);
    expect(markers[0]!.getAttribute('aria-label')).toContain('Read: 1 error / 2 matched results');
    expect(markers[0]!.getAttribute('aria-label')).toContain('Bash: 1 error / 1 matched result');
    expect(tree.container.querySelectorAll('.usage-tool-build-marker[tabindex="0"]')).toHaveLength(1);
    await act(async () => markers[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
    expect(markers[1]!.getAttribute('tabindex')).toBe('0');
    await act(async () => toolButtons[1]!.click());
    expect(tree.container.querySelectorAll('.usage-tool-build-marker')).toHaveLength(1);
    expect(tree.container.querySelectorAll('.usage-tool-build-marker[tabindex="0"]')).toHaveLength(1);

    const commits = tree.container.querySelector<HTMLButtonElement>('.usage-tool-build-toggle')!;
    await act(async () => commits.click());
    expect(commits.getAttribute('aria-pressed')).toBe('false');
    expect(tree.container.querySelector('.usage-tool-build-marker')).toBeNull();
});
test('error points and commits can be pinned by keyboard or click and cleared', async () => {
    const tree = await harness.mount(<UsageToolErrorTrend summary={summary}/>);
    const point = tree.container.querySelector<SVGGElement>('.usage-tool-error-series g[role="button"]')!;
    expect(point.getAttribute('aria-label')).toContain('Read:');
    await act(async () => point.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(point.getAttribute('aria-pressed')).toBe('true');
    expect(tree.container.querySelector('.usage-tool-error-readout')?.textContent).toContain('Read');
    await act(async () => tree.container.querySelector<HTMLButtonElement>('.usage-tool-error-readout button')!.click());
    expect(point.getAttribute('aria-pressed')).toBe('false');
    const marker = tree.container.querySelector<SVGGElement>('.usage-tool-build-marker')!;
    await act(async () => marker.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(marker.getAttribute('aria-pressed')).toBe('true');
    expect(tree.container.querySelector('.usage-tool-error-readout')?.textContent).toContain('Cat Code build');
});
