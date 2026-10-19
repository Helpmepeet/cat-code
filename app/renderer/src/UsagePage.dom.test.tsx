import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { act, useState, type ComponentProps } from 'react';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectRetainedUsage } from '../../../src/utils/statsUsage.js';
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js';
import { UsagePage } from './UsagePage.js';
import { initialUsageSelection } from './usageDashboardState.js';
import { usageModelRequestCount } from './usageDailyChartState.js';

let harness: DomTestHarness;
beforeAll(async () => { harness = await createDomTestHarness(); });
afterEach(async () => { await harness.unmountAll(); });
afterAll(async () => { await harness.teardown(); });

for (const activity of ['zero-token response', 'model timing', 'tool timing'] as const) {
    test(`subagent-only ${activity} keeps meaningful analytics visible`, async () => {
        const root = await mkdtemp(join(tmpdir(), 'analytics-subagent-'));
        try {
            const directory = join(root, 'session', 'subagents');
            await mkdir(directory, { recursive: true });
            const path = join(directory, 'agent-a0123456789abcdef.jsonl');
            const timestamp = '2026-09-13T10:00:00.000Z';
            const system = (subtype: string, fields: Record<string, unknown>) => ({ type: 'system', subtype, uuid: subtype, sessionId: 'session', timestamp, schema_version: 1, ...fields });
            const rows = activity === 'zero-token response' ? [{
                type: 'assistant', uuid: 'zero-token', sessionId: 'session', timestamp,
                message: { id: 'canonical-zero-token-api', model: 'gpt-6.1-sol', content: [], usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
            }] : activity === 'model timing' ? [
                system('model_attempt_start', { call_id: 'call', attempt_id: 'attempt', attempt_index: 1, provider: 'openai', model: 'gpt-6.1-sol', mode: 'streaming' }),
                system('model_attempt_end', { call_id: 'call', attempt_id: 'attempt', outcome: 'succeeded', duration_ms: 10 }),
            ] : [
                system('tool_execution_start', { tool_use_id: 'tool' }),
                system('tool_execution_end', { tool_use_id: 'tool', outcome: 'succeeded', duration_ms: 10 }),
            ];
            await writeFile(path, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
            const snapshot = await collectRetainedUsage([path], '2026-09-13T12:00:00.000Z', { timezone: 'UTC' });
            const summary = snapshot.ranges['7d'];
            expect(summary.tokens).toEqual({ fresh: 0, read: 0, write: 0, output: 0 });
            expect(summary.records).toBe(0);
            expect(summary.sessions).toBe(0);
            expect(summary.requests).toBe(0);
            if (activity === 'zero-token response') expect(usageModelRequestCount(summary)).toBe(1);
            else expect(summary.timing[activity === 'model timing' ? 'models' : 'tools'].outcomes.started).toBe(1);
            const tree = await harness.mount(<AnalyticsOwner state={{ snapshot, status: 'ready' }}/>);
            expect(tree.container.textContent).not.toContain('No recorded activity in this period.');
            expect(tree.container.querySelector('[aria-label="Reliability"]')).not.toBeNull();
            if (activity === 'zero-token response') expect(tree.container.querySelector('.usage-metric-requests strong')?.textContent).toBe('1');
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
}

test('a genuinely empty collector result still shows the empty state', async () => {
    const snapshot = await collectRetainedUsage([], '2026-09-13T12:00:00.000Z', { timezone: 'UTC' });
    const tree = await harness.mount(<AnalyticsOwner state={{ snapshot, status: 'ready' }}/>);
    expect(tree.container.textContent).toContain('No recorded activity in this period.');
    expect(tree.container.querySelector('[aria-label="Reliability"]')).toBeNull();
});

test('analytics keeps its page spacing when the sidebar opens, resizes and closes', async () => {
    const styles = document.createElement('style');
    styles.textContent = 'main { margin:0; }'
        + readFileSync(new URL('./usageDashboard.css', import.meta.url), 'utf8')
        + readFileSync(new URL('./usageDailyChart.css', import.meta.url), 'utf8');
    document.head.append(styles);
    try {
        // Happy DOM does not resolve max()/calc(), so guard sidebar-dependent rules too.
        expect(styles.textContent).not.toMatch(/[^{}]*\.sidebar-expanded[^{}]*\.usage-page[^{}]*\{/);
        const snapshot = await collectRetainedUsage([], '2026-09-13T12:00:00.000Z');
        const tree = await harness.mount(<div className="analytics-shell-test"><div className="rail-spacer"/><aside/><div className="lid-content"><div><UsagePage state={{ snapshot, status: 'ready' }} selection={initialUsageSelection} onSelectionChange={() => {}}/></div></div></div>);
        const shell = tree.container.querySelector<HTMLElement>('.analytics-shell-test')!;
        const aside = shell.querySelector('aside')!, page = shell.querySelector<HTMLElement>('.usage-page')!;
        const spacing = () => {
            const computed = getComputedStyle(page);
            return { marginLeft: computed.marginLeft, marginRight: computed.marginRight, paddingLeft: computed.paddingLeft, paddingRight: computed.paddingRight };
        };
        const collapsed = spacing();
        expect(collapsed.marginLeft).toBe('0px');
        for (const sidebarWidth of [192, 288, 420]) {
            shell.style.setProperty('--sidebar-expanded-width', `${sidebarWidth}px`);
            aside.classList.add('sidebar-expanded');
            expect(spacing()).toEqual(collapsed);
            aside.classList.remove('sidebar-expanded');
            expect(spacing()).toEqual(collapsed);
        }
    } finally { styles.remove(); }
});

test('Analytics uses the computed 14px prototype scale without changing root typography or fixed-pixel text', async () => {
    const styles = document.createElement('style');
    styles.textContent = ':root { font-size:16px; line-height:24px; }'
        + readFileSync(new URL('./usageDashboard.css', import.meta.url), 'utf8')
        + readFileSync(new URL('./usageDailyChart.css', import.meta.url), 'utf8');
    document.head.append(styles);
    try {
        const tree = await harness.mount(<AnalyticsOwner state={{ snapshot: await recordedSnapshot(), status: 'ready' }}/>);
        const computed = (selector: string) => getComputedStyle(tree.container.querySelector(selector)!);
        expect(getComputedStyle(document.documentElement).fontSize).toBe('16px');
        expect(getComputedStyle(document.documentElement).lineHeight).toBe('24px');
        expect(computed('.usage-content').fontSize).toBe('14px');
        expect(computed('.usage-content').lineHeight).toBe('normal');
        expect(computed('#usage-title').fontSize).toBe('20px');
        expect(computed('#usage-title').lineHeight).toBe('normal');
        expect(computed('.usage-sticky-top').top).toBe('-24px');
        expect(computed('.usage-metric-requests strong').fontSize).toBe('22.75px');
        expect(computed('.usage-latest-build strong').fontSize).toBe('19.25px');
        expect(computed('.usage-hero-number').fontSize).toBe('38.5px');
        expect(computed('.usage-daily-detail h3').fontSize).toBe('19.25px');
        expect(computed('.usage-daily-stats dd').fontSize).toBe('16.625px');
        expect(computed('.usage-metric-row svg').width).toBe('63px');
        expect(computed('.usage-metric-row svg').height).toBe('28px');
        expect(computed('.usage-daily-head').gap).toBe('12px');
        expect(computed('.usage-daily-tools').marginTop).toBe('12px');
        expect(computed('.usage-detail-token-legend').display).toBe('flex');
        expect(computed('.usage-detail-token-legend').flexWrap).toBe('wrap');
        expect(computed('.usage-detail-token-legend .usage-detail-composition').display).toBe('inline-flex');
        expect(computed('.usage-detail-token-legend small').minWidth).toBe('0');
        expect(tree.container.querySelectorAll('.usage-detail-token-legend > .usage-detail-composition')).toHaveLength(4);
        for (const item of tree.container.querySelectorAll('.usage-detail-token-legend > .usage-detail-composition')) {
            expect(item.querySelector('circle')).not.toBeNull();
            expect(item.querySelector('span')?.textContent).not.toBe('');
            expect(item.querySelector('b')?.textContent).not.toBe('');
            expect(item.querySelector('small')?.textContent).toContain('%');
        }
    } finally { styles.remove(); }
});

test('all four metric rows use intrinsic grid-item sizing and an eight-pixel spark gap at wide and narrow widths', async () => {
    const styles = document.createElement('style');
    styles.textContent = readFileSync(new URL('./usageDashboard.css', import.meta.url), 'utf8')
        + readFileSync(new URL('./usageDailyChart.css', import.meta.url), 'utf8')
        + [1092, 932, 552].map(width => `.usage-content[data-probe-width="${width}"] { width:${width}px; }`).join('\n');
    document.head.append(styles);
    try {
        const snapshot = await recordedSnapshot(), summary = snapshot.ranges['7d'];
        summary.cacheWriteReporting = 'partial';
        summary.days[1]!.tokens.fresh = 1;
        summary.days[1]!.results = 1;
        const tree = await harness.mount(<AnalyticsOwner state={{ snapshot, status: 'ready' }}/>);
        const content = tree.container.querySelector('.usage-content')!;
        for (const value of [3, 123456789]) {
            summary.effort.requests.high = value;
            summary.days[0]!.effort.requests.high = value;
            summary.sessions = value;
            await tree.render(<AnalyticsOwner state={{ snapshot, status: 'ready' }}/>);
            for (const width of [1092, 932, 552]) {
                content.setAttribute('data-probe-width', String(width));
                expect(getComputedStyle(content).width).toBe(`${width}px`);
                const cards = tree.container.querySelectorAll<HTMLElement>('.usage-metric:not(.usage-latest-build)');
                expect(cards).toHaveLength(4);
                for (const card of cards) {
                    const row = card.querySelector('.usage-metric-row')!, computed = getComputedStyle(row);
                    expect(computed.display).toBe('flex');
                    expect(computed.justifySelf).toBe('start');
                    expect(computed.justifyContent).toBe('space-between');
                    expect(computed.gap).toBe('8px');
                    expect(getComputedStyle(row.querySelector('svg')!).width).toBe('63px');
                    expect(getComputedStyle(card).display).toBe('grid');
                    expect(getComputedStyle(card).gridTemplateRows).toBe('auto auto 1fr');
                    expect(getComputedStyle(card.querySelector('.usage-metric-foot')!).alignSelf).toBe('end');
                }
                expect(tree.container.querySelector('.usage-metric-cache .usage-cache-coverage')?.textContent).toBe('Writes partly reported');
                const buildRow = getComputedStyle(tree.container.querySelector('.usage-latest-build .usage-metric-row')!);
                expect(buildRow.justifySelf).not.toBe('start');
                expect(buildRow.justifyContent).toBe('flex-start');
                expect(buildRow.gap).toBe('6px');
            }
        }
    } finally { styles.remove(); }
});
function AnalyticsOwner(props: Omit<ComponentProps<typeof UsagePage>, 'selection' | 'onSelectionChange'>) {
    const [selection, setSelection] = useState(initialUsageSelection);
    return <UsagePage {...props} selection={selection} onSelectionChange={setSelection}/>;
}
async function recordedSnapshot() {
    const snapshot = await collectRetainedUsage([], '2026-09-13T12:00:00.000Z');
    snapshot.ranges.all.days = [structuredClone(snapshot.ranges['7d'].days[0]!)];
    snapshot.ranges.all.startDate = snapshot.ranges.all.days[0]!.date;
    for (const summary of Object.values(snapshot.ranges)) {
        summary.tokens.fresh = 123; summary.records = 1; summary.requests = 8;
        summary.models = [{ id: 'sol', label: 'gpt-6.1-sol', kind: 'named', tokens: { fresh: 100, read: 0, write: 0, output: 0 } }, { id: 'luna', label: 'gpt-6-luna', kind: 'named', tokens: { fresh: 23, read: 0, write: 0, output: 0 } }];
        const day = summary.days[0]!;
        day.tokens.fresh = 123; day.requests = 8; day.sessions = 1;
        day.models = [{ id: 'sol', total: 100 }, { id: 'luna', total: 23 }];
        summary.tools = [{ id: 'bash', label: 'Bash', kind: 'named', requests: 9, results: 8, errors: 2 }, { id: 'read', label: 'Read', kind: 'named', requests: 5, results: 5, errors: 1 }];
        day.results = 13; day.errors = 3; day.tools = [{ id: 'bash', requests: 9, results: 8, errors: 2 }, { id: 'read', requests: 5, results: 5, errors: 1 }];
    }
    return snapshot;
}
function button(container: HTMLElement, text: string, selector = 'button') { return [...container.querySelectorAll<HTMLButtonElement>(selector)].find(node => node.textContent === text)!; }
async function click(node: Element) { await act(async () => { node.dispatchEvent(new MouseEvent('click', { bubbles: true })); }); }

test('chart activation pins and toggles off without changing on focus; clear restores range detail', async () => {
    const snapshot = await recordedSnapshot(), tree = await harness.mount(<AnalyticsOwner state={{ snapshot, status: 'ready' }}/>);
    const hits = tree.container.querySelectorAll<SVGGElement>('.usage-daily-hit');
    await act(async () => hits[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
    expect(document.activeElement).toBe(hits[1]);
    expect(tree.container.querySelector('.usage-daily-detail')!.textContent).toContain('Selected range');
    await act(async () => hits[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(hits[0]!.getAttribute('aria-pressed')).toBe('true');
    expect(tree.container.querySelector('.usage-daily-detail')!.textContent).toContain('Pinned day');
    expect(tree.container.querySelector('.usage-daily-detail h3')!.textContent).toMatch(/^[A-Z][a-z]{2}, [A-Z][a-z]{2} \d/);
    expect(tree.container.querySelector('.usage-daily-stats')!.textContent).toContain('Tokens123');
    await click(hits[0]!);
    expect(hits[0]!.getAttribute('aria-pressed')).toBe('false');
    await click(hits[0]!);
    await click(button(tree.container, 'Whole range'));
    expect(tree.container.querySelector('.usage-pinned')).toBeNull();
});

test('metric and grouping switches retain hidden series per metric and reset tokens on grouping change', async () => {
    const tree = await harness.mount(<AnalyticsOwner state={{ snapshot: await recordedSnapshot(), status: 'ready' }}/>);
    const chips = () => tree.container.querySelector<HTMLElement>('.usage-daily-chips')!;
    await click(button(chips(), 'Sol'));
    expect(button(chips(), 'Sol').getAttribute('aria-pressed')).toBe('false');
    await click(button(tree.container, 'Tool errors', '.usage-daily-metrics button'));
    await click(button(chips(), 'Read'));
    await click(button(tree.container, 'Tokens', '.usage-daily-metrics button'));
    expect(button(chips(), 'Sol').getAttribute('aria-pressed')).toBe('false');
    expect(button(tree.container, 'By type')).toBeUndefined();
    await click(button(tree.container, 'By source'));
    expect([...chips().querySelectorAll('button')].find(node => node.textContent?.startsWith('Chat'))!.getAttribute('aria-pressed')).toBe('true');
    await click(button(tree.container, 'By model family'));
    expect(button(chips(), 'Sol').getAttribute('aria-pressed')).toBe('true');
    await click(button(tree.container, 'Tool errors', '.usage-daily-metrics button'));
    expect(button(chips(), 'Read').getAttribute('aria-pressed')).toBe('false');
    await click(button(chips(), 'Show all'));
    expect(button(chips(), 'Read').getAttribute('aria-pressed')).toBe('true');
});

test('double-click isolates a family and Models shares the same cross-filter', async () => {
    const tree = await harness.mount(<AnalyticsOwner state={{ snapshot: await recordedSnapshot(), status: 'ready' }}/>);
    const chips = tree.container.querySelector<HTMLElement>('.usage-daily-chips')!;
    await act(async () => button(chips, 'Sol').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    expect(button(chips, 'Luna').getAttribute('aria-pressed')).toBe('false');
    const models = tree.container.querySelector<HTMLElement>('[aria-label="Models"]')!;
    expect(models.textContent).toContain('gpt-6.1-sol');
    expect(models.querySelector('tr.uad-family-luna')!.classList.contains('uad-dim')).toBe(true);
    expect(models.querySelector('tr.uad-family-sol')!.classList.contains('uad-dim')).toBe(false);
    expect(button(models, 'Luna').getAttribute('aria-pressed')).toBe('false');
});

test('summary metric and tool rows change the shared daily chart', async () => {
    const tree = await harness.mount(<AnalyticsOwner state={{ snapshot: await recordedSnapshot(), status: 'ready' }}/>);
    await click(tree.container.querySelector('.usage-metric-requests')!);
    expect(button(tree.container, 'Requests', '.usage-daily-metrics button').getAttribute('aria-selected')).toBe('true');
    await click(tree.container.querySelector('.usage-metric-errorRate')!);
    expect(button(tree.container, 'Error rate', '.usage-daily-metrics button').getAttribute('aria-selected')).toBe('true');
    const tool = [...tree.container.querySelectorAll('button')].find(node => node.textContent?.includes('Bash') && !node.closest('.usage-daily-chips'))!;
    await click(tool);
    expect(button(tree.container, 'Tool errors', '.usage-daily-metrics button').getAttribute('aria-selected')).toBe('true');
    expect(button(tree.container.querySelector<HTMLElement>('.usage-daily-chips')!, 'Read').getAttribute('aria-pressed')).toBe('false');
    expect([...tree.container.querySelectorAll('.uad-tools button')].find(node => node.textContent?.includes('Bash'))?.getAttribute('aria-pressed')).toBe('true');
    await click(button(tree.container.querySelector<HTMLElement>('.usage-daily-chips')!, 'Show all'));
    expect(tree.container.querySelector('.uad-tools button[aria-pressed="true"]')).toBeNull();
});

test('daily source controls expose only approved groups and hidden swatches become hollow', async () => {
    const tree = await harness.mount(<AnalyticsOwner state={{ snapshot: await recordedSnapshot(), status: 'ready' }}/>);
    expect([...tree.container.querySelectorAll('.usage-daily-group button')].map(node => node.textContent)).toEqual(['By model family', 'By source']);
    const chips = tree.container.querySelector<HTMLElement>('.usage-daily-chips')!;
    await click(button(chips, 'Sol'));
    expect(button(chips, 'Sol').querySelector('circle')!.getAttribute('fill')).toBe('none');
    expect(button(chips, 'Show all').classList.contains('usage-daily-reset')).toBe(true);
    await click(button(tree.container, 'By source'));
    expect([...chips.querySelectorAll('circle')].map(node => node.getAttribute('fill'))).toEqual(['var(--usage-category-0)', 'var(--usage-category-3)', 'var(--usage-category-4)']);
});

test('area hover shows positive series in stack order with swatches and total without coaching', async () => {
    const tree = await harness.mount(<AnalyticsOwner state={{ snapshot: await recordedSnapshot(), status: 'ready' }}/>);
    const svg = tree.container.querySelector('.usage-daily-svg')!;
    expect(svg.getAttribute('height')).toBe('300');
    expect(svg.getAttribute('viewBox')).toBe('0 0 640 300');
    const hit = tree.container.querySelector('.usage-daily-hit')!;
    await act(async () => hit.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
    const rows = [...svg.querySelectorAll('.usage-daily-tooltip-row')];
    expect(rows.map(row => row.querySelector('span')?.textContent)).toEqual(['Luna', 'Sol', 'Total']);
    expect(rows.map(row => row.querySelector('b')?.textContent)).toEqual(['23', '100', '123']);
    expect(rows[0]!.querySelector('circle')).not.toBeNull();
    expect(svg.querySelector('.usage-daily-tooltip-head')!.textContent).toMatch(/^[A-Z][a-z]{2}, [A-Z][a-z]{2} \d/);
    expect(svg.querySelectorAll('g[pointer-events="none"] circle')).toHaveLength(2);
    expect(svg.textContent).not.toMatch(/Click to pin|Click to unpin/);
    await click(hit);
    expect(svg.querySelector('.usage-daily-selected-band')).not.toBeNull();
    expect(svg.querySelector('.usage-selection-underline')).toBeNull();
});

test('daily SVG follows physical card dimensions rather than scaling a fixed viewBox', async () => {
    const previousRect = SVGElement.prototype.getBoundingClientRect, previousObserver = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver');
    const observers: (() => void)[] = [];
    const watched: { element?: Element; disconnected: boolean }[] = [];
    let width = 560, height = 360;
    SVGElement.prototype.getBoundingClientRect = function () {
        return this.classList.contains('usage-daily-svg') ? new DOMRect(0, 0, width, height) : previousRect.call(this);
    };
    Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, writable: true, value: class {
        entry: { element?: Element; disconnected: boolean } = { disconnected: false };
        constructor(callback: () => void) { observers.push(callback); watched.push(this.entry); }
        observe(element: Element) { this.entry.element = element; }
        disconnect() { this.entry.disconnected = true; }
    } });
    try {
        const tree = await harness.mount(<AnalyticsOwner state={{ snapshot: await recordedSnapshot(), status: 'ready' }}/>);
        const svg = tree.container.querySelector('.usage-daily-svg')!;
        expect(svg.getAttribute('viewBox')).toBe('0 0 560 360');
        expect(svg.querySelector('.usage-daily-baseline')!.getAttribute('y1')).toBe('334');
        width = 820; height = 420;
        await act(async () => { observers.forEach(callback => callback()); });
        expect(svg.getAttribute('viewBox')).toBe('0 0 820 420');
        expect(svg.getAttribute('height')).toBe('420');
        expect(svg.querySelector('.usage-daily-baseline')!.getAttribute('y1')).toBe('394');
        const areas = svg.querySelector('.usage-daily-areas');
        width = 556; height = 300;
        await act(async () => { observers.forEach(callback => callback()); });
        expect(svg.getAttribute('viewBox')).toBe('0 0 556 300');
        expect(svg.querySelector('.usage-daily-baseline')!.getAttribute('y1')).toBe('274');
        expect(svg.querySelector('.usage-daily-areas')).toBe(areas);
        const mutations: MutationRecord[] = [];
        const mutationObserver = new MutationObserver(records => mutations.push(...records));
        mutationObserver.observe(svg, { subtree: true, attributes: true, childList: true });
        try {
            await act(async () => { for (let index = 0; index < 20; index++) observers.forEach(callback => callback()); });
            expect(mutations).toHaveLength(0);
        } finally { mutationObserver.disconnect(); }
        width = 0; height = 0;
        await act(async () => { observers.forEach(callback => callback()); });
        expect(svg.getAttribute('viewBox')).toBe('0 0 556 300');
        const dailyObservers = watched.filter(entry => entry.element === svg);
        expect(dailyObservers).toHaveLength(2);
        await tree.unmount();
        expect(dailyObservers.every(entry => entry.disconnected)).toBe(true);
    } finally {
        SVGElement.prototype.getBoundingClientRect = previousRect;
        if (previousObserver) Object.defineProperty(globalThis, 'ResizeObserver', previousObserver);
        else Reflect.deleteProperty(globalThis, 'ResizeObserver');
    }
});

test('single-series line views use last labels, pinned rules and missing-rate readouts', async () => {
    const snapshot = await recordedSnapshot(), tree = await harness.mount(<AnalyticsOwner state={{ snapshot, status: 'ready' }}/>);
    await click(button(tree.container, 'Sessions', '.usage-daily-metrics button'));
    expect(tree.container.querySelectorAll('.usage-daily-chips button')).toHaveLength(0);
    expect(tree.container.querySelector('.usage-daily-last-value')).not.toBeNull();
    expect(tree.container.querySelectorAll('.usage-daily-svg .usage-chart-annotation')).toHaveLength(1);
    await click(tree.container.querySelector('.usage-daily-hit')!);
    expect(tree.container.querySelector('.usage-daily-pin-rule')).not.toBeNull();
    expect(tree.container.querySelector('.usage-daily-lines circle')?.getAttribute('r')).toBe('5');
    expect(tree.container.querySelector('.usage-selection-underline')).toBeNull();
    await click(button(tree.container, 'Error rate', '.usage-daily-metrics button'));
    expect(tree.container.querySelectorAll('.usage-daily-chips button')).toHaveLength(0);
    expect(tree.container.querySelector('.usage-daily-reference')?.textContent).toContain('Range average');
    const hits = tree.container.querySelectorAll('.usage-daily-hit');
    await act(async () => hits[1]!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
    expect(hits[1]!.getAttribute('aria-label')).toContain('–');
    expect(tree.container.querySelector('.usage-daily-tooltip-row b')?.textContent).toBe('–');
});

test('tool-error daily deltas keep small percentage changes neutral and handle grouped magnitudes', async () => {
    const snapshot = await recordedSnapshot(), summary = snapshot.ranges['7d'];
    summary.days[0]!.errors = 203;
    summary.days[0]!.results = 5000;
    summary.previousPeriod = {
        startInclusive: '2026-08-31T00:00:00.000Z', endInclusive: '2026-09-06T12:30:00.000Z',
        tokens: { fresh: 100, read: 0, write: 0, output: 0 }, activeDays: 1, sessions: 1, records: 1,
        requests: 5000, modelRequests: 1, results: 5000, errors: 200, cachedInputShare: 0, cacheWriteReporting: 'reported',
    };
    const tree = await harness.mount(<AnalyticsOwner state={{ snapshot, status: 'ready' }}/>);
    await click(button(tree.container, 'Tool errors', '.usage-daily-metrics button'));
    const delta = () => tree.container.querySelector('.usage-daily-delta')!;
    expect(delta().textContent).toContain('1.5%');
    expect(delta().classList.contains('usage-change-bad')).toBe(false);
    expect(delta().classList.contains('usage-change-good')).toBe(false);
    summary.days[0]!.errors = 2200;
    await tree.render(<AnalyticsOwner state={{ snapshot, status: 'ready' }}/>);
    expect(delta().textContent).toContain('1,000%');
    expect(delta().classList.contains('usage-change-bad')).toBe(true);
});

test('bar hover and pins dim other columns without replaying the growth group', async () => {
    const snapshot = await recordedSnapshot(), summary = snapshot.ranges['7d'];
    summary.days[1]!.tools = structuredClone(summary.days[0]!.tools);
    const tree = await harness.mount(<AnalyticsOwner state={{ snapshot, status: 'ready' }}/>);
    await click(button(tree.container, 'Tool errors', '.usage-daily-metrics button'));
    const group = tree.container.querySelector('.usage-daily-bars')!;
    const hits = tree.container.querySelectorAll('.usage-daily-hit');
    await act(async () => hits[0]!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
    expect(tree.container.querySelector('.usage-daily-hover-band')).not.toBeNull();
    expect(tree.container.querySelector('.usage-daily-svg .usage-linked-crosshair')).toBeNull();
    expect(group.querySelector('path[opacity="0.32"]')).not.toBeNull();
    await click(hits[0]!);
    expect(tree.container.querySelector('.usage-daily-bars')).toBe(group);
    expect(tree.container.querySelector('.usage-selection-underline')).not.toBeNull();
});

test('day detail exposes rounded family sectors and token composition readouts to focus', async () => {
    const tree = await harness.mount(<AnalyticsOwner state={{ snapshot: await recordedSnapshot(), status: 'ready' }}/>);
    const arc = tree.container.querySelector<SVGElement>('.usage-daily-donut-arc')!;
    expect(arc.tagName.toLowerCase()).toBe('path');
    expect(arc.getAttribute('d')).toContain('A56,56');
    await act(async () => arc.focus());
    expect(tree.container.querySelector('.usage-daily-donut .usage-daily-tooltip-head')?.textContent).toBe('Sol');
    expect(tree.container.querySelector('.usage-daily-donut .usage-daily-tooltip-row b')?.textContent).toContain('%');
    const token = tree.container.querySelector<SVGElement>('.usage-token-composition rect[tabindex]')!;
    await act(async () => token.focus());
    expect(tree.container.querySelector('.usage-token-composition .usage-daily-tooltip-head')?.textContent).toBe('Fresh input');
});

test('donut tooltip follows the pointer and contains its measured body without scaling text in the donut viewBox', async () => {
    const previousHtmlRect = HTMLElement.prototype.getBoundingClientRect, previousSvgRect = SVGElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function () {
        if (this.classList.contains('usage-daily-donut')) return new DOMRect(100, 200, 286, 140);
        if (this.classList.contains('usage-daily-tooltip-body')) return new DOMRect(0, 0, 140, 80);
        return previousHtmlRect.call(this);
    };
    SVGElement.prototype.getBoundingClientRect = function () {
        return this.classList.contains('usage-token-composition') ? new DOMRect(0, 0, 286, 10) : previousSvgRect.call(this);
    };
    try {
        const tree = await harness.mount(<AnalyticsOwner state={{ snapshot: await recordedSnapshot(), status: 'ready' }}/>);
        const arc = tree.container.querySelector('.usage-daily-donut-arc')!;
        await act(async () => arc.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 360, clientY: 335 })));
        const tip = () => tree.container.querySelector<SVGForeignObjectElement>('.usage-daily-donut .usage-daily-tooltip')!;
        expect(tip().getAttribute('height')).toBe('80');
        expect(tip().getAttribute('width')).toBe('140');
        expect(tip().getAttribute('x')).toBe('106');
        expect(tip().getAttribute('y')).toBe('60');
        expect(Number(tip().getAttribute('x')) + Number(tip().getAttribute('width'))).toBeLessThanOrEqual(286);
        expect(Number(tip().getAttribute('y')) + Number(tip().getAttribute('height'))).toBeLessThanOrEqual(140);
        expect(tip().parentElement!.hasAttribute('viewBox')).toBe(false);
        expect(tip().closest('[aria-label="Tokens by model family"]')).toBeNull();
        await act(async () => arc.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 105, clientY: 205 })));
        expect(tip().getAttribute('x')).toBe('19');
        expect(tip().getAttribute('y')).toBe('0');
        const donut = tree.container.querySelector('[aria-label="Tokens by model family"]')!;
        await act(async () => arc.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: donut })));
        expect(tip()).toBeNull();
    } finally {
        HTMLElement.prototype.getBoundingClientRect = previousHtmlRect;
        SVGElement.prototype.getBoundingClientRect = previousSvgRect;
    }
});

test('period changes clear only pins outside the next range and preserve refresh behavior', async () => {
    const snapshot = await recordedSnapshot();
    let refreshes = 0;
    const tree = await harness.mount(<AnalyticsOwner state={{ snapshot, status: 'error' }} onRefresh={() => refreshes++}/>);
    const refresh = tree.container.querySelector<HTMLButtonElement>('.usage-refresh')!;
    expect(refresh.getAttribute('aria-label')).toBe('Refresh failed. Try again');
    await click(refresh); expect(refreshes).toBe(1);
    await click(tree.container.querySelector('.usage-daily-hit')!);
    await click(button(tree.container, '30 days'));
    expect(tree.container.querySelector('.usage-pinned')).not.toBeNull();
    expect(tree.container.querySelector('.usage-freshness')!.textContent).toContain('Aug 15 to Sep 13');
    await tree.render(<AnalyticsOwner state={{ snapshot, status: 'loading' }} onRefresh={() => refreshes++}/>);
    expect(tree.container.querySelector<HTMLButtonElement>('.usage-refresh')!.disabled).toBe(true);
});

test('route and latest-build cross-filters navigate without changing the pinned day', async () => {
    const snapshot = await recordedSnapshot(), summary = snapshot.ranges['7d'];
    summary.autoMode.routes = [{ route: 'guard', outcome: 'review_required', count: 3 }];
    summary.autoMode.allTools.coverage.state = 'complete';
    summary.autoMode.allTools.outcomes.review_required = 3;
    summary.days[0]!.tools[0]!.builds = { items: [{ sha: 'abcdef123', dirty: false, requests: 220, results: 200, errors: 2, firstObservedAt: '2026-09-07T00:00:00Z' }] };
    const tree = await harness.mount(<AnalyticsOwner state={{ snapshot, status: 'ready' }}/>);
    await click(tree.container.querySelector('.usage-daily-hit')!);
    const route = [...tree.container.querySelectorAll('[role="button"]')].find(node => node.getAttribute('aria-label')?.startsWith('Guard'))!;
    await click(route);
    expect(button(tree.container, 'Auto mode', '.usage-daily-metrics button').getAttribute('aria-selected')).toBe('true');
    expect(button(tree.container.querySelector<HTMLElement>('.usage-daily-chips')!, 'Allowed').getAttribute('aria-pressed')).toBe('false');
    expect(tree.container.querySelector('.usage-pinned')).not.toBeNull();
    const buildScrolls: unknown[] = [], cacheScrolls: unknown[] = [];
    const reliability = tree.container.querySelector<HTMLElement>('.uad-build-card')!;
    const cache = tree.container.querySelector('[aria-label="Cache"]')!.parentElement!;
    reliability.scrollIntoView = options => { buildScrolls.push(options); };
    cache.scrollIntoView = options => { cacheScrolls.push(options); };
    await click(tree.container.querySelector('.usage-latest-build')!);
    await click(tree.container.querySelector('.usage-metric-cache')!);
    expect(buildScrolls).toEqual([{ block: 'center', behavior: 'smooth' }]);
    expect(cacheScrolls).toEqual([{ block: 'start', behavior: 'smooth' }]);
    const matchMedia = window.matchMedia;
    window.matchMedia = (query => ({ matches: query === '(prefers-reduced-motion: reduce)' })) as typeof window.matchMedia;
    try {
        await click(tree.container.querySelector('.usage-metric-cache')!);
    } finally {
        window.matchMedia = matchMedia;
    }
    expect(cacheScrolls.at(-1)).toEqual({ block: 'start', behavior: 'instant' });
});

test('sparse All chart marks leave calendar gaps and clamp a partial final bucket', async () => {
    const snapshot = await recordedSnapshot(), summary = snapshot.ranges.all;
    summary.startDate = '2026-09-01'; summary.endDateExclusive = '2026-09-11'; summary.bucketDays = 4;
    const template = structuredClone(snapshot.ranges['7d'].days[0]!);
    summary.days = ['2026-09-01', '2026-09-09'].map(date => ({ ...structuredClone(template), date }));
    const tree = await harness.mount(<AnalyticsOwner state={{ snapshot, status: 'ready' }}/>);
    await click(button(tree.container, 'All'));
    const hits = [...tree.container.querySelectorAll<SVGRectElement>('.usage-daily-hit > rect:first-child')];
    const firstX = Number(hits[0]!.getAttribute('x')), firstWidth = Number(hits[0]!.getAttribute('width'));
    const lastX = Number(hits[1]!.getAttribute('x')), lastWidth = Number(hits[1]!.getAttribute('width'));
    expect(lastX).toBeGreaterThan(firstX + firstWidth);
    expect(lastWidth).toBeCloseTo(firstWidth / 2);
    expect(tree.container.querySelectorAll('.usage-daily-areas > path')).toHaveLength(4);
});

test('cache percentages retain counts and qualify the selected day or range write coverage', async () => {
    const snapshot = await recordedSnapshot(), summary = snapshot.ranges['7d'], day = summary.days[0]!;
    summary.tokens = { fresh: 20, read: 80, write: 0, output: 0 };
    day.tokens = { ...summary.tokens };
    summary.cachedInputShare = 80;
    const render = (date: string) => <UsagePage state={{ snapshot, status: 'ready' }} selection={{ range: '7d', date }} onSelectionChange={() => {}}/>;
    const tree = await harness.mount(render(''));
    const cacheStat = () => [...tree.container.querySelectorAll('.usage-daily-stats > div')].find(node => node.querySelector('dt')?.textContent === 'From cache')!;
    const summaryCard = () => tree.container.querySelector('.usage-metric-cache')!;
    for (const [reporting, qualification] of [
        ['unreported', 'Writes not reported'],
        ['partial', 'Writes partly reported'],
        ['unavailable', 'Write coverage unavailable'],
        ['reported', ''],
    ] as const) {
        summary.cacheWriteReporting = reporting;
        day.cacheWriteReporting = reporting;
        for (const date of ['', day.date]) {
            await tree.render(render(date));
            expect(cacheStat().querySelector('dd')!.textContent).toContain('80.0%');
            expect(summaryCard().querySelector('strong')!.textContent).toBe('80.0%');
            expect(cacheStat().querySelector('.usage-cache-coverage')?.textContent ?? '').toBe(qualification);
            expect(summaryCard().querySelector('.usage-cache-coverage')?.textContent ?? '').toBe(qualification);
        }
    }
    summary.cacheWriteReporting = 'unreported';
    day.cacheWriteReporting = 'reported';
    await tree.render(render(day.date));
    expect(cacheStat().querySelector('.usage-cache-coverage')).toBeNull();
    expect(summaryCard().querySelector('.usage-cache-coverage')!.textContent).toBe('Writes not reported');
    summary.cacheWriteReporting = 'reported';
    day.cacheWriteReporting = 'partial';
    await tree.render(render(day.date));
    expect(cacheStat().querySelector('.usage-cache-coverage')!.textContent).toBe('Writes partly reported');
    expect(summaryCard().querySelector('.usage-cache-coverage')).toBeNull();
    expect(summary.tokens.write).toBe(0);
    expect(day.tokens.write).toBe(0);
});
