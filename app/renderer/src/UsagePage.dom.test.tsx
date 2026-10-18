import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { act, useState, type ComponentProps } from 'react';
import { readFileSync } from 'node:fs';
import { collectRetainedUsage } from '../../../src/utils/statsUsage.js';
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js';
import { UsagePage } from './UsagePage.js';
import { initialUsageSelection } from './usageDashboardState.js';

let harness: DomTestHarness;
beforeAll(async () => { harness = await createDomTestHarness(); });
afterEach(async () => { await harness.unmountAll(); });
afterAll(async () => { await harness.teardown(); });

test('only analytics clears the expanded overlay beyond the reserved rail at variable sidebar widths', async () => {
    const css = readFileSync(new URL('./usageDashboard.css', import.meta.url), 'utf8');
    const rule = css.match(/(aside\.sidebar-expanded \+ \.lid-content \.usage-page)\s*\{\s*margin-left:([^;]+);/)!;
    expect(rule).not.toBeNull();
    const [, selector, clearance] = rule;
    expect(clearance).toBe('max(0px,calc(var(--sidebar-expanded-width,18rem) - 48px))');
    const rail = Number(clearance!.match(/- (\d+)px/)![1]);
    const pagePadding = css.match(/\.usage-page \{[^}]*padding:(\d+)px (\d+)px (\d+)px;/)!;
    const horizontalPadding = Number(pagePadding[2]) * 2;
    const snapshot = await collectRetainedUsage([], '2026-09-13T12:00:00.000Z');
    const tree = await harness.mount(<div className="analytics-shell-test"><div className="rail-spacer"/><aside/><div className="lid-content"><div><UsagePage state={{ snapshot, status: 'ready' }} selection={initialUsageSelection} onSelectionChange={() => {}}/><main className="chat-test"/></div></div></div>);
    const shell = tree.container.querySelector<HTMLElement>('.analytics-shell-test')!;
    const aside = shell.querySelector('aside')!, page = shell.querySelector<HTMLElement>('.usage-page')!;
    expect(page.matches(selector!)).toBe(false);
    expect(shell.querySelector('.chat-test')!.matches(selector!)).toBe(false);
    for (const sidebarWidth of [48, 192, 288, 420]) {
        shell.style.setProperty('--sidebar-expanded-width', `${sidebarWidth}px`);
        aside.classList.add('sidebar-expanded');
        expect(page.matches(selector!)).toBe(true);
        expect(shell.style.getPropertyValue('--sidebar-expanded-width')).toBe(`${sidebarWidth}px`);
        const extraClearance = Math.max(0, sidebarWidth - rail);
        for (const windowWidth of [1440, 1280, 900]) {
            const contentWidth = windowWidth - rail - extraClearance - horizontalPadding;
            expect(contentWidth).toBe(windowWidth - sidebarWidth - 56);
            if (sidebarWidth === 288) expect(contentWidth).toBe(({ 1440: 1096, 1280: 936, 900: 556 } as Record<number, number>)[windowWidth]);
        }
        aside.classList.remove('sidebar-expanded');
        expect(page.matches(selector!)).toBe(false);
        expect(1440 - rail - horizontalPadding).toBe(1336);
    }
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
    await click(button(tree.container, 'By type'));
    expect(button(chips(), 'Fresh input').getAttribute('aria-pressed')).toBe('true');
    await click(button(tree.container, 'By source'));
    expect([...chips().querySelectorAll('button')].find(node => node.textContent?.startsWith('Chat'))!.getAttribute('aria-pressed')).toBe('true');
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
    let buildScrolls = 0, cacheScrolls = 0;
    const reliability = tree.container.querySelector<HTMLElement>('.uad-build-card')!;
    const cache = tree.container.querySelector('[aria-label="Cache"]')!.parentElement!;
    reliability.scrollIntoView = () => { buildScrolls++; };
    cache.scrollIntoView = () => { cacheScrolls++; };
    await click(tree.container.querySelector('.usage-latest-build')!);
    await click(tree.container.querySelector('.usage-metric-cache')!);
    expect(buildScrolls).toBe(1); expect(cacheScrolls).toBe(1);
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
