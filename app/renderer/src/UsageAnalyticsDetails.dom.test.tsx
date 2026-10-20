import { afterAll, afterEach, beforeAll, expect, spyOn, test } from 'bun:test';
import { act, useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { collectRetainedUsage } from '../../../src/utils/statsUsage.js';
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js';
import { UsageAnalyticsActivity, UsageAnalyticsCache, UsageAnalyticsModels, UsageAnalyticsReliability } from './UsageAnalyticsDetails.js';
import type { UsageRangeSummary } from '../../shared/usageDashboard.js';
import { readFileSync } from 'node:fs';

let harness: DomTestHarness;
beforeAll(async () => { harness = await createDomTestHarness(); });
afterEach(async () => { await harness.unmountAll(); });
afterAll(async () => { await harness.teardown(); });
async function fixture() {
    const snapshot = await collectRetainedUsage([], '2026-10-18T12:00:00.000Z');
    const summary = snapshot.ranges['7d'];
    summary.tokens = { fresh: 20, read: 60, write: 20, output: 10 };
    summary.cachedInputShare = 60;
    summary.cacheWriteReporting = 'reported';
    summary.models = [{ id: 'sol', kind: 'named', label: 'Sol', tokens: summary.tokens, tokenCost: { usd: 0.5, pricedTokens: 50 } }, { id: 'luna', kind: 'named', label: 'Luna', tokens: { fresh: 10, read: 0, write: 0, output: 30 }, tokenCost: { usd: 0, pricedTokens: 0 } }];
    summary.tools = [{ id: 'bash', label: 'Bash', kind: 'named', requests: 210, results: 208, errors: 2 }];
    summary.days[0]!.tokens = summary.tokens;
    summary.days[0]!.cacheWriteReporting = 'reported';
    summary.days[0]!.tools = [{ id: 'bash', requests: 210, results: 208, errors: 2, builds: { items: [{ sha: 'abc123', dirty: true, requests: 210, results: 208, errors: 2, firstObservedAt: '2026-10-12T12:00:00Z' }] } }];
    summary.days[0]!.parallel = { state: 'available', minutes: [2, 3, 4], peak: 3, tenMinutePeaks: [[0, 3]] };
    summary.autoMode.allTools.coverage.state = 'partial';
    summary.autoMode.routes = [{ route: 'guard', outcome: 'review_required', count: 3 }];
    return { summary, snapshot };
}
function CacheOwner({ summary }: { summary: UsageRangeSummary }) {
    const [selectedDate, onSelectDate] = useState('');
    return <UsageAnalyticsCache summary={summary} selectedDate={selectedDate} onSelectDate={onSelectDate} />;
}
function ModelsOwner({ summary }: { summary: UsageRangeSummary }) {
    const [modelFamilies, onModelFamiliesChange] = useState<string[]>([]);
    return <UsageAnalyticsModels summary={summary} modelFamilies={modelFamilies} onModelFamiliesChange={onModelFamiliesChange} />;
}
test('cache preserves percentage units and pins then unpins via keyboard', async () => {
    const { summary } = await fixture();
    const tree = await harness.mount(<CacheOwner summary={summary} />);
    expect(tree.container.textContent).toContain('Range rate 60.0%');
    const day = tree.container.querySelector<SVGGElement>('.uad-line [role=button]')!;
    await act(async () => day.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(day.getAttribute('aria-pressed')).toBe('true');
    await act(async () => day.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true })));
    expect(day.getAttribute('aria-pressed')).toBe('false');
    await act(async () => day.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
    expect(tree.container.querySelector('.uad-readout')?.textContent).toContain('60.0%');
    expect(tree.container.querySelector('.uad-area-write')).not.toBeNull();
});
test('activity toggles modes and does not borrow hourly detail for a longer range', async () => {
    const { summary, snapshot } = await fixture();
    const tree = await harness.mount(<UsageAnalyticsActivity summary={summary} timezone={snapshot.timezone} selectedDate="" onSelectDate={() => {}} />);
    expect(tree.container.querySelector('.uad-heatmap')).not.toBeNull();
    const toggle = [...tree.container.querySelectorAll('button')].find(b => b.textContent === 'Sessions at once')!;
    await act(async () => toggle.click());
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(tree.container.textContent).toContain('Time by sessions at once');
    const longer = await harness.mount(<UsageAnalyticsActivity summary={snapshot.ranges['30d']} timezone={snapshot.timezone} selectedDate="" onSelectDate={() => {}} />);
    expect(longer.container.textContent).toContain('Hourly tool request detail is unavailable for this range.');
    expect(longer.container.querySelector('.uad-heatmap')).toBeNull();
});
test('hourly activity labels canonical counts as tool requests', async () => {
    const { summary } = await fixture();
    summary.days[0]!.hours![0]!.requests = 7;
    summary.days[0]!.requests = 7;
    const tree = await harness.mount(<UsageAnalyticsActivity summary={summary} timezone="UTC" selectedDate="" onSelectDate={() => {}} />);
    expect(tree.container.querySelector('h3')?.textContent).toBe('Tool requests by hour');
    expect([...tree.container.querySelectorAll('button')].map(button => button.textContent)).toContain('Tool requests');
    expect(tree.container.querySelector('.uad-heatmap')?.getAttribute('aria-label')).toBe('Hourly tool request heatmap');
    expect(tree.container.querySelector('.uad-heatmap')?.textContent).toContain('7 tool requests');
    expect(tree.container.textContent).not.toContain('model requests');
});
test('incomplete cache-write coverage qualifies the reported cache rate without changing its denominator', async () => {
    const { summary } = await fixture();
    summary.cacheWriteReporting = 'partial';
    const tree = await harness.mount(<CacheOwner summary={summary} />);
    expect(tree.container.querySelectorAll('.uad-cache-caveat')).toHaveLength(1);
    expect(tree.container.querySelector('.uad-cache-caveat')?.textContent).toContain('only partly reported');
    expect(tree.container.textContent).toContain('Range rate 60.0%');
    expect(tree.container.textContent).not.toContain('Reported');
});
test('30-day supplied ten-minute concurrency is available without hourly requests', async () => {
    const { snapshot } = await fixture();
    const summary = snapshot.ranges['30d'];
    for (const day of summary.days) day.parallel = { state: 'available', minutes: [0, 0, 0], peak: 0, tenMinutePeaks: [] };
    summary.days[0]!.parallel.peak = 4;
    summary.days[0]!.parallel.tenMinutePeaks = [[6, 4]];
    const dates: string[] = [];
    const tree = await harness.mount(<UsageAnalyticsActivity summary={summary} timezone="UTC" selectedDate="" onSelectDate={date => dates.push(date)} />);
    expect(tree.container.textContent).toContain('Hourly tool request detail is unavailable for this range.');
    const toggle = [...tree.container.querySelectorAll('button')].find(b => b.textContent === 'Sessions at once')!;
    await act(async () => toggle.click());
    const heatmap = tree.container.querySelector('.uad-heatmap')!;
    expect(heatmap).not.toBeNull();
    expect(heatmap.textContent).toContain('01:00 (elapsed slot 6): 4 sessions at once');
    const day = heatmap.querySelector<SVGGElement>('[role=button]')!;
    await act(async () => day.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(dates).toEqual([summary.days[0]!.date]);
    const cell = day.querySelectorAll('rect')[6]!;
    await act(async () => cell.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
    expect(tree.container.querySelector('.uad-readout')?.textContent).toContain('4 sessions at once');
});
test('sparse all-history buckets never fabricate a daily concurrency timeline', async () => {
    const { snapshot } = await fixture();
    const summary = snapshot.ranges.all;
    summary.bucketDays = 4;
    summary.days = [snapshot.ranges['7d'].days[0]!];
    const tree = await harness.mount(<UsageAnalyticsActivity summary={summary} timezone="UTC" selectedDate="" onSelectDate={() => {}} />);
    await act(async () => [...tree.container.querySelectorAll('button')].find(b => b.textContent === 'Sessions at once')!.click());
    expect(tree.container.querySelector('.uad-heatmap')).toBeNull();
    expect(tree.container.textContent).toContain('Ten-minute concurrency detail is unavailable for this range.');
});
test('single-day sparse all-history slots display only supplied days', async () => {
    const { snapshot } = await fixture();
    const summary = snapshot.ranges.all;
    summary.bucketDays = 1;
    summary.days = [snapshot.ranges['7d'].days[0]!, snapshot.ranges['7d'].days[6]!];
    for (const day of summary.days) day.parallel = { state: 'available', minutes: [0, 0, 0], peak: 0, tenMinutePeaks: [] };
    const tree = await harness.mount(<UsageAnalyticsActivity summary={summary} timezone="UTC" selectedDate="" onSelectDate={() => {}} />);
    await act(async () => [...tree.container.querySelectorAll('button')].find(b => b.textContent === 'Sessions at once')!.click());
    expect(tree.container.querySelectorAll('.uad-heatmap [role=button]')).toHaveLength(2);
});
test('model chips are controlled and table headers sort without converting unpriced tokens to free spend', async () => {
    const { summary } = await fixture();
    const tree = await harness.mount(<ModelsOwner summary={summary} />);
    const sol = [...tree.container.querySelectorAll('button')].find(b => b.textContent === 'Sol')!;
    await act(async () => sol.click());
    expect(sol.getAttribute('aria-pressed')).toBe('false');
    expect(tree.container.querySelector('tbody tr.uad-family-sol')?.classList.contains('uad-dim')).toBe(true);
    expect(tree.container.textContent).toContain('$0.50 partial');
    expect(tree.container.textContent).toContain('Unpriced');
    const model = tree.container.querySelector<HTMLButtonElement>('thead button')!;
    await act(async () => model.click());
    expect(tree.container.querySelector('tbody th')?.textContent).toContain('Luna');
});
test('reliability routes tool, route and build selections through parent callbacks', async () => {
    const { summary } = await fixture();
    const calls: string[] = [];
    const tree = await harness.mount(<UsageAnalyticsReliability summary={summary} onSelectTool={id => calls.push(`tool:${id}`)} onSelectRoute={route => calls.push(`route:${route}`)} onSelectBuild={sha => calls.push(`build:${sha}`)} />);
    await act(async () => tree.container.querySelector<HTMLButtonElement>('.uad-tools button')!.click());
    await act(async () => tree.container.querySelector<SVGGElement>('.uad-routes [role=button]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    await act(async () => tree.container.querySelector<SVGGElement>('.uad-builds [role=button]')!.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true })));
    expect(calls).toEqual(['tool:bash', 'route:guard', 'build:abc123']);
    expect(tree.container.textContent).toContain('Partial auto-mode observations.');
    expect(tree.container.textContent).toContain('Model latency is unavailable.');
    expect(tree.container.querySelector('.uad-tools-head')?.textContent).toBe('ToolResultsErrors per dayError rate');
});
test('model outcomes show composition shares and route hover preserves unknown semantics', async () => {
    const { summary } = await fixture();
    summary.timing.models.state = 'available';
    summary.timing.models.outcomes = { started: 10, succeeded: 6, failed: 2, cancelled: 1, incomplete: 1 };
    summary.autoMode.routes = [{ route: 'unknown', outcome: 'unknown_outcome', count: 2 }];
    const tree = await harness.mount(<UsageAnalyticsReliability summary={summary} onSelectTool={() => {}} onSelectRoute={() => {}} onSelectBuild={() => {}} />);
    expect(tree.container.querySelector('.uad-outcome-succeeded')?.textContent).toContain('60.0%');
    expect(tree.container.querySelector('.uad-outcome-failed')?.textContent).toContain('20.0%');
    const route = tree.container.querySelector<SVGGElement>('.uad-routes [role=button]')!;
    await act(async () => route.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
    expect(tree.container.querySelector('.uad-routes + .uad-readout')?.textContent).toContain('Unknown route: 2 observations; 2 not recorded as allowed');
});
test('build chart applies the 200-result threshold to points and median and owns its scroll anchor', async () => {
    const { summary } = await fixture();
    summary.days[0]!.tools[0]!.builds!.items.push(
        { sha: 'small', dirty: false, requests: 199, results: 199, errors: 190, firstObservedAt: '2026-10-12T13:00:00Z' },
        { sha: 'eligible', dirty: false, requests: 200, results: 200, errors: 20, firstObservedAt: '2026-10-12T14:00:00Z' },
    );
    const calls: string[] = [];
    const tree = await harness.mount(<UsageAnalyticsReliability summary={summary} onSelectTool={() => {}} onSelectRoute={() => {}} onSelectBuild={sha => calls.push(sha)} />);
    const article = tree.container.querySelector('article#usage-build-chart')!;
    expect(article.querySelector('h3')?.textContent).toBe('Error rate by build');
    expect(article.textContent).toContain('Builds with at least 200 tool results.');
    expect(article.querySelectorAll('.uad-builds [role=button]')).toHaveLength(2);
    expect(article.querySelector('.uad-build-legend')?.textContent).toContain('Median 5.5%');
    const point = article.querySelector<SVGGElement>('.uad-builds [role=button]')!;
    await act(async () => point.dispatchEvent(new FocusEvent('focusin', { bubbles: true })));
    expect(article.querySelector('.uad-build-readout')?.textContent).toContain('abc123');
    expect(point.getAttribute('data-active')).toBe('true');
    await act(async () => point.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(point.getAttribute('aria-pressed')).toBe('true');
    expect(calls).toEqual(['abc123']);
    await act(async () => point.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
    expect(point.getAttribute('data-active')).toBe('true');
});
test('build chart states when no build meets the result threshold', async () => {
    const { summary } = await fixture();
    summary.days[0]!.tools[0]!.builds!.items[0]!.results = 199;
    const tree = await harness.mount(<UsageAnalyticsReliability summary={summary} onSelectTool={() => {}} onSelectRoute={() => {}} onSelectBuild={() => {}} />);
    expect(tree.container.querySelector('#usage-build-chart')?.textContent).toContain('No builds with at least 200 tool results.');
    expect(tree.container.querySelector('.uad-builds')).toBeNull();
});
test('supporting SVG tooltips render complete single text strings', async () => {
    const { summary } = await fixture();
    const cache = renderToStaticMarkup(<CacheOwner summary={summary} />);
    expect(cache).toContain('<title>Sol: 60.0%, 100 input tokens</title>');
    expect(cache).toContain(`<title>${summary.days[0]!.date}: 20 fresh input; 20 reported cache writes</title>`);
    const reliability = renderToStaticMarkup(<UsageAnalyticsReliability summary={summary} onSelectTool={() => {}} onSelectRoute={() => {}} onSelectBuild={() => {}} />);
    expect(reliability).toContain('<title>abc123: 2 errors / 208 results; first retained request 2026-10-12T12:00:00Z</title>');
    summary.parallel = { state: 'available', minutes: [2, 3, 4], peak: 3 };
    const tree = await harness.mount(<UsageAnalyticsActivity summary={summary} timezone="UTC" selectedDate="" onSelectDate={() => {}} />);
    expect(tree.container.querySelector('.uad-profile title')?.textContent).toBe('00:00: 0 tool requests across this range');
    await act(async () => [...tree.container.querySelectorAll('button')].find(button => button.textContent === 'Sessions at once')!.click());
    expect([...tree.container.querySelectorAll('.uad-composition title')].map(title => title.textContent)).toEqual(['1 session: 2 minutes', '2 sessions: 3 minutes', '3 or more sessions: 4 minutes']);
    for (const title of tree.container.querySelectorAll('svg title')) expect(title.childNodes).toHaveLength(1);
});
test('model latency renders retained median and p95 with independent sample counts', async () => {
    const { summary } = await fixture();
    summary.timing.models.state = 'available';
    summary.timing.models.outcomes = { started: 20, succeeded: 18, failed: 1, cancelled: 0, incomplete: 1 };
    summary.timing.models.responseDuration = { samples: 7, p50Ms: 1200, p95Ms: 9000 };
    summary.timing.models.firstText = { samples: 3, p50Ms: 250, p95Ms: 800 };
    const props = { summary, onSelectTool: () => {}, onSelectRoute: () => {}, onSelectBuild: () => {} };
    const tree = await harness.mount(<UsageAnalyticsReliability {...props} />);
    expect(tree.container.querySelectorAll('.uad-latency-p50')).toHaveLength(2);
    expect(tree.container.querySelectorAll('.uad-latency-p95')).toHaveLength(2);
    expect(tree.container.querySelector('.uad-latency')?.textContent).toContain('7 samples');
    expect(tree.container.querySelector('.uad-latency')?.textContent).toContain('3 samples');
    expect(tree.container.querySelector('.uad-outcome-succeeded')?.textContent).toContain('90.0%');
    const row = tree.container.querySelector<SVGGElement>('.uad-latency-chart [tabindex]')!;
    await act(async () => row.dispatchEvent(new FocusEvent('focusin', { bubbles: true })));
    expect(tree.container.querySelector('.uad-latency-readout')?.textContent).toBe('Model response: median 1.2 s, p95 9 s; 7 samples');
    expect(renderToStaticMarkup(<UsageAnalyticsReliability {...props} />)).toContain('<title>First text: p95 800 ms; 3 samples</title>');
});
test('latency zeros have their own rail and unavailable quantiles are never plotted', async () => {
    const { summary } = await fixture();
    summary.timing.models.state = 'available';
    summary.timing.models.responseDuration = { samples: 2, p50Ms: 0, p95Ms: 0 };
    summary.timing.models.firstText = { samples: 0, p50Ms: null, p95Ms: null };
    const tree = await harness.mount(<UsageAnalyticsReliability summary={summary} onSelectTool={() => {}} onSelectRoute={() => {}} onSelectBuild={() => {}} />);
    expect(tree.container.querySelector('.uad-latency-p50')?.getAttribute('cx')).toBe(tree.container.querySelector('.uad-zero-label')?.getAttribute('x'));
    expect(tree.container.querySelector('.uad-latency-p95')?.getAttribute('cx')).toBe(tree.container.querySelector('.uad-zero-label')?.getAttribute('x'));
    expect(tree.container.querySelectorAll('.uad-latency-p50')).toHaveLength(1);
    expect(tree.container.querySelector('.uad-latency-chart')?.textContent).toContain('Unavailable');
    expect(tree.container.querySelector('.uad-latency-chart')?.outerHTML).not.toContain('NaN');
});

test('cache charts use full bucket picking, focused axes, pinned markers and range-only motion identities', async () => {
    const { summary, snapshot } = await fixture();
    const tree = await harness.mount(<CacheOwner summary={summary} />);
    const chart = tree.container.querySelector('.uad-line')!;
    expect([...chart.querySelectorAll('text')].map(text => text.textContent)).not.toContain('0%');
    expect(chart.querySelector('.uad-rate-fill')?.getAttribute('d')).toContain('Z');
    expect(chart.querySelector('.uad-last-value')?.textContent).toBe('60.0%');
    const line = chart.querySelector('.uad-line-draw')!;
    const area = tree.container.querySelector('.uad-area-grow')!;
    const day = chart.querySelector<SVGGElement>('[role=button]')!;
    expect(Number(day.querySelector('rect')?.getAttribute('width'))).toBeGreaterThan(40);
    await act(async () => day.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
    expect(chart.querySelector('[role=tooltip]')?.textContent).toContain('60.0%');
    expect(chart.querySelector('.uad-hover-dot')).not.toBeNull();
    expect(chart.querySelector('.uad-rule')).not.toBeNull();
    await act(async () => day.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(chart.querySelector('.uad-pin-rule')).not.toBeNull();
    expect(tree.container.querySelector('.uad-selected-day')).not.toBeNull();
    expect(chart.querySelector('.uad-line-draw')).toBe(line);
    expect(tree.container.querySelector('.uad-area-grow')).toBe(area);
    await tree.render(<CacheOwner summary={snapshot.ranges['30d']} />);
    expect(tree.container.querySelector('.uad-line-draw')).not.toBe(line);
    expect(tree.container.querySelector('.uad-area-grow')).not.toBe(area);
});

test('uncached annotations locate the peak and retain calendar averages including empty days', async () => {
    const { summary } = await fixture();
    const tree = await harness.mount(<CacheOwner summary={summary} />);
    const chart = tree.container.querySelector('.uad-uncached')!;
    expect(chart.querySelector('.uad-peak')?.textContent).toBe('Oct 12 · 40');
    expect(chart.textContent).toContain('Average 5.7');
    expect(Number(chart.querySelector('.uad-reference')?.getAttribute('y1'))).toBeCloseTo(124 - (40 / 7) / 50 * 102);
    const weekend = chart.querySelectorAll('.uad-weekend');
    const days = chart.querySelectorAll('[role=button]');
    const lastBand = days[days.length - 1]!.querySelector('rect')!;
    const lastWeekend = weekend[weekend.length - 1]!;
    expect(lastWeekend.getAttribute('x')).toBe(lastBand.getAttribute('x'));
    expect(lastWeekend.getAttribute('width')).toBe(lastBand.getAttribute('width'));
    const pick = days[0]!;
    await act(async () => pick.dispatchEvent(new FocusEvent('focusin', { bubbles: true })));
    expect(chart.querySelectorAll('.uad-hover-fresh, .uad-hover-write')).toHaveLength(2);
    expect(chart.querySelectorAll('.uad-tooltip .uad-tip-marker')).toHaveLength(2);
    expect(chart.querySelector('[role=tooltip]')?.textContent).toContain('Cache writes20');
    expect(tree.container.querySelector('.uad-cache-legend .uad-write-key')).not.toBeNull();
});

test('cache dot rows show values and colored stems, isolate hover, and restore on leave', async () => {
    const { summary } = await fixture();
    const tree = await harness.mount(<CacheOwner summary={summary} />);
    const chart = tree.container.querySelector('.uad-dots')!;
    const rows = chart.querySelectorAll<SVGGElement>('[tabindex]');
    expect([...chart.querySelectorAll('.uad-dot-value')].map(text => text.textContent)).toEqual(['60.0%', '0.0%']);
    for (const row of rows) expect(row.querySelector('.uad-dot-stem')?.getAttribute('x2')).toBe(row.querySelector('circle')?.getAttribute('cx'));
    expect(Number(rows[0]!.querySelector('circle')?.getAttribute('r'))).toBe(10);
    expect(Number(rows[1]!.querySelector('circle')?.getAttribute('cy')) - Number(rows[0]!.querySelector('circle')?.getAttribute('cy'))).toBe(30);
    await act(async () => rows[0]!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
    expect(rows[1]!.getAttribute('opacity')).toBe('0.4');
    expect(chart.querySelector('[role=tooltip]')?.textContent).toContain('Input tokens100');
    await act(async () => chart.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })));
    expect(rows[1]!.getAttribute('opacity')).toBe('1');
});

test('activity draws a smooth profile and highlights the hovered row and hour with eight time ticks', async () => {
    const { summary } = await fixture();
    summary.days[0]!.hours![0]!.requests = 20;
    const tree = await harness.mount(<UsageAnalyticsActivity summary={summary} timezone="UTC" selectedDate="" onSelectDate={() => {}} />);
    const chart = tree.container.querySelector('.uad-heatmap')!;
    expect(chart.querySelector('.uad-profile-line')?.getAttribute('d')).toContain('C');
    expect(chart.querySelector('.uad-profile-fill')?.getAttribute('d')).toContain('Z');
    expect(chart.querySelectorAll('.uad-profile rect')).toHaveLength(0);
    const rows = chart.querySelectorAll<SVGGElement>('[role=button]');
    await act(async () => rows[0]!.querySelector('rect')!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
    expect(rows[0]!.querySelector('rect[data-slot="1"]')?.getAttribute('opacity')).toBe('1');
    expect(rows[1]!.querySelector('rect[data-slot="0"]')?.getAttribute('opacity')).toBe('1');
    expect(rows[1]!.querySelector('rect[data-slot="1"]')?.getAttribute('opacity')).toBe('0.4');
    expect(chart.querySelector('.uad-profile circle')).not.toBeNull();
    expect(chart.querySelector('[role=tooltip]')?.textContent).toContain('Tool requests20');
    expect([...chart.children].filter(node => node.tagName === 'text').map(node => node.textContent)).toEqual(['00', '03', '06', '09', '12', '15', '18', '21']);
    expect(tree.container.querySelector('.uad-head-right .uad-legend')?.textContent).toContain('More tool requests');
});

test('concurrency colors remain fixed across peak changes and duration legend reports shares', async () => {
    const { summary } = await fixture();
    for (const day of summary.days) day.parallel = { state: 'available', peak: 1, minutes: [0, 0, 0], tenMinutePeaks: [[0, 1]] };
    summary.parallel = { state: 'available', peak: 1, minutes: [60, 120, 60] };
    const props = { summary, timezone: 'UTC', selectedDate: '', onSelectDate: () => {} };
    const tree = await harness.mount(<UsageAnalyticsActivity {...props} />);
    await act(async () => [...tree.container.querySelectorAll('button')].find(button => button.textContent === 'Sessions at once')!.click());
    const first = tree.container.querySelector('.uad-heatmap [data-slot="0"]')!;
    expect(first.getAttribute('class')).toBe('uad-level-1');
    expect(Number(first.getAttribute('y'))).toBe(7);
    expect(tree.container.querySelector('.uad-heatmap .uad-profile')).toBeNull();
    summary.days[1]!.parallel.tenMinutePeaks = [[0, 10]];
    await tree.render(<UsageAnalyticsActivity {...props} />);
    expect(first.getAttribute('class')).toBe('uad-level-1');
    expect(tree.container.querySelectorAll('.uad-heatmap [data-slot="0"]')[1]!.getAttribute('class')).toBe('uad-level-5');
    expect(tree.container.querySelector('.uad-head-right .uad-legend')?.textContent).toBe('12345+');
    expect(tree.container.querySelector('.uad-composition-legend')?.textContent).toContain('2 sessions2.0 h50.0%');
});

test('model family chips sort by family total in the header and sort direction follows repeated clicks', async () => {
    const { summary } = await fixture();
    summary.models[1]!.tokens.read = 50;
    summary.models.push({ id: 'luna-other', kind: 'named', label: 'Luna second', tokens: { fresh: 0, read: 80, write: 0, output: 0 } });
    const tree = await harness.mount(<ModelsOwner summary={summary} />);
    expect([...tree.container.querySelectorAll('.uad-card > header .uad-model-chips button')].map(button => button.textContent)).toEqual(['Luna', 'Sol']);
    const headers = tree.container.querySelectorAll('thead th');
    expect(headers[1]!.getAttribute('aria-sort')).toBe('descending');
    await act(async () => headers[1]!.querySelector('button')!.click());
    expect(headers[1]!.getAttribute('aria-sort')).toBe('ascending');
    expect(tree.container.querySelector('tbody th')?.textContent).toBe('Luna second');
    expect(tree.container.querySelector('.uad-spark-area')?.getAttribute('d')).toContain('Z');
    expect(tree.container.querySelector('.uad-spark circle')).not.toBeNull();
});

test('tool duration remains plotted when model outcomes and model latency are unavailable', async () => {
    const { summary } = await fixture();
    summary.timing.tools.state = 'available';
    summary.timing.tools.duration = { samples: 7, p50Ms: 0, p95Ms: 300 };
    const tree = await harness.mount(<UsageAnalyticsReliability summary={summary} onSelectTool={() => {}} onSelectRoute={() => {}} onSelectBuild={() => {}} />);
    expect(tree.container.textContent).toContain('Model call outcomes are unavailable.');
    expect(tree.container.querySelectorAll('.uad-latency-chart [tabindex]')).toHaveLength(3);
    expect(tree.container.querySelectorAll('.uad-latency-p50')).toHaveLength(1);
    expect(tree.container.querySelector('.uad-latency-p50')?.getAttribute('cx')).toBe(tree.container.querySelector('.uad-zero-label')?.getAttribute('x'));
    const tool = tree.container.querySelectorAll<SVGGElement>('.uad-latency-chart [tabindex]')[2]!;
    await act(async () => tool.dispatchEvent(new FocusEvent('focusin', { bubbles: true })));
    expect(tree.container.querySelector('.uad-latency-readout')?.textContent).toBe('Tool run: median 0 ms, p95 300 ms; 7 samples');
    expect(tree.container.querySelector('.uad-latency-chart [role=tooltip]')?.textContent).toContain('Samples7');
});

test('outcome strip uses exact composition and selected tool rows reflect controlled cross-filter state', async () => {
    const { summary } = await fixture();
    summary.timing.models.state = 'available';
    summary.timing.models.outcomes = { started: 10, succeeded: 6, failed: 2, cancelled: 1, incomplete: 1 };
    const props = { summary, onSelectTool: () => {}, onSelectRoute: () => {}, onSelectBuild: () => {} };
    const tree = await harness.mount(<UsageAnalyticsReliability {...props} selectedToolId="bash" />);
    const strip = tree.container.querySelector('.uad-outcome-composition')!;
    const succeeded = strip.querySelector('.uad-outcome-succeeded')!, failed = strip.querySelector('.uad-outcome-failed')!;
    expect(Number(succeeded.getAttribute('width')) / Number(failed.getAttribute('width'))).toBeCloseTo(3);
    expect(Number(failed.getAttribute('x')) - Number(succeeded.getAttribute('width'))).toBe(2);
    expect(strip.nextElementSibling?.classList.contains('uad-outcomes')).toBe(true);
    expect(tree.container.querySelector('.uad-tools button')?.getAttribute('aria-pressed')).toBe('true');
    await tree.render(<UsageAnalyticsReliability {...props} />);
    expect(tree.container.querySelector('.uad-tools button')?.getAttribute('aria-pressed')).toBe('false');
});

test('build scatter provides grid, flagged labels, legends and nearest-point hover away from the dot', async () => {
    const { summary } = await fixture();
    summary.days[0]!.tools[0]!.builds!.items.push(
        { sha: 'high', dirty: false, requests: 200, results: 200, errors: 80, firstObservedAt: '2026-10-12T14:00:00Z' },
        { sha: 'low', dirty: false, requests: 200, results: 200, errors: 0, firstObservedAt: '2026-10-12T15:00:00Z' },
    );
    const selected: string[] = [];
    const tree = await harness.mount(<UsageAnalyticsReliability summary={summary} onSelectTool={() => {}} onSelectRoute={() => {}} onSelectBuild={sha => selected.push(sha)} />);
    const chart = tree.container.querySelector('.uad-builds')!;
    expect(chart.querySelectorAll('.uad-grid').length).toBeGreaterThan(2);
    expect(chart.querySelector('.uad-flagged-build')?.textContent).toBe('high');
    expect(tree.container.querySelector('.uad-build-legend')?.textContent).toContain('CommittedUncommittedOver 1.5× median');
    const high = [...chart.querySelectorAll<SVGGElement>('[role=button]')].find(node => node.getAttribute('aria-label')?.startsWith('high:'))!;
    const dot = high.querySelector('circle')!;
    const overlay = chart.querySelector('.uad-build-pick')!;
    await act(async () => overlay.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: Number(dot.getAttribute('cx')) + 24, clientY: Number(dot.getAttribute('cy')) + 8 })));
    expect(chart.querySelector('[role=tooltip]')?.textContent).toContain('high');
    expect(high.getAttribute('opacity')).toBe('1');
    await act(async () => overlay.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: Number(dot.getAttribute('cx')) + 24, clientY: Number(dot.getAttribute('cy')) + 8 })));
    expect(selected).toEqual(['high']);
});

test('routes reflow at measured widths, isolate hover and expose Decisions with unknown observations preserved', async () => {
    const { summary } = await fixture();
    summary.autoMode.allTools.outcomes = { allowed: 2, review_required: 2, policy_blocked: 1, operational_error: 0, cancelled: 0, unknown_outcome: 1, incomplete: 0 };
    summary.autoMode.routes = [{ route: 'base', outcome: 'allowed', count: 1 }, { route: 'guard', outcome: 'unknown_outcome', count: 1 }, { route: 'stage1', outcome: 'review_required', count: 1 }, { route: 'stage2', outcome: 'policy_blocked', count: 1 }, { route: 'forced', outcome: 'allowed', count: 1 }, { route: 'accept_edits', outcome: 'review_required', count: 1 }];
    let width = 320;
    const bounds = spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ width, height: 230, x: 0, y: 0, left: 0, top: 0, right: width, bottom: 230, toJSON() { return {}; } }));
    const previousObserver = globalThis.ResizeObserver;
    const callbacks: Array<() => void> = [];
    globalThis.ResizeObserver = class {
        constructor(callback: () => void) { callbacks.push(callback); }
        observe() {}
        unobserve() {}
        disconnect() {}
    } as unknown as typeof ResizeObserver;
    try {
        const tree = await harness.mount(<UsageAnalyticsReliability summary={summary} onSelectTool={() => {}} onSelectRoute={() => {}} onSelectBuild={() => {}} />);
        const chart = tree.container.querySelector('.uad-routes')!;
        expect(chart.getAttribute('viewBox')).toBe('0 0 320 230');
        expect(tree.container.querySelector('.uad-auto-card dt')?.textContent).toBe('Decisions');
        expect(tree.container.querySelector('.uad-auto-card dd')?.textContent).toBe('6');
        const guard = chart.querySelectorAll('[role=button]')[1]!;
        expect(guard.querySelector('svg')?.getAttribute('height')).toBe('76');
        expect(guard.querySelector('.uad-route-badge')?.textContent).toBe('1 not recorded as allowed');
        const before = [...chart.querySelectorAll('[role=button] > rect')].map(rect => rect.getAttribute('height'));
        width = 620;
        await act(async () => callbacks.forEach(callback => callback()));
        expect(chart.getAttribute('viewBox')).toBe('0 0 620 230');
        expect([...chart.querySelectorAll('[role=button] > rect')].map(rect => rect.getAttribute('height'))).not.toEqual(before);
        const tiles = chart.querySelectorAll<SVGGElement>('[role=button]');
        await act(async () => tiles[1]!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
        expect(tiles[0]!.getAttribute('opacity')).toBe('0.55');
        expect(chart.querySelector('[role=tooltip]')?.textContent).toContain('Not recorded as allowed1');
        expect(chart.querySelector('.uad-route-badge')?.textContent).toContain('not recorded as allowed');
    } finally {
        bounds.mockRestore();
        globalThis.ResizeObserver = previousObserver;
    }
});

test('fall-back concurrency keeps both repeated local hours and the final elapsed slot', async () => {
    const { summary } = await fixture();
    const day = summary.days[0]!;
    day.date = '2026-11-01';
    day.parallel = { state: 'available', peak: 3, minutes: [0, 0, 0], tenMinutePeaks: [[6, 1], [12, 2], [149, 3]] };
    summary.days = [day];
    const tree = await harness.mount(<UsageAnalyticsActivity summary={summary} timezone="America/New_York" selectedDate="" onSelectDate={() => {}} />);
    await act(async () => [...tree.container.querySelectorAll('button')].find(button => button.textContent === 'Sessions at once')!.click());
    const chart = tree.container.querySelector('.uad-heatmap')!;
    const cells = chart.querySelectorAll('rect[data-slot]');
    expect(cells).toHaveLength(150);
    expect(cells[6]!.textContent).toContain('01:00 (elapsed slot 6): 1 sessions at once');
    expect(cells[12]!.textContent).toContain('01:00 (elapsed slot 12): 2 sessions at once');
    expect(cells[149]!.textContent).toContain('23:50 (elapsed slot 149): 3 sessions at once');
    await act(async () => cells[12]!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
    expect(chart.querySelector('[role=tooltip]')?.textContent).toContain('Elapsed time2h 0m');
});

test('sparse cache rates and fills break at absent buckets rather than connecting invented observations', async () => {
    const { summary } = await fixture();
    summary.days[3]!.tokens = { fresh: 10, read: 90, write: 0, output: 0 };
    summary.days = [summary.days[0]!, summary.days[3]!];
    const tree = await harness.mount(<CacheOwner summary={summary} />);
    const chart = tree.container.querySelector('.uad-line')!;
    expect(chart.querySelector('.uad-rate-line')?.getAttribute('d')?.match(/M/g)).toHaveLength(2);
    expect(chart.querySelector('.uad-rate-line')?.getAttribute('d')).not.toContain('L');
    expect(chart.querySelector('.uad-rate-fill')?.getAttribute('d')?.match(/Z/g)).toHaveLength(2);
    const bands = chart.querySelectorAll('[role=button] rect');
    const firstX = Number(bands[0]!.getAttribute('x')), nextX = Number(bands[1]!.getAttribute('x')), band = Number(bands[0]!.getAttribute('width'));
    expect(nextX - firstX).toBeCloseTo(band * 3.5);
    expect(chart.querySelectorAll('[role=button]')).toHaveLength(2);
});

test('hourly tokens combine repeated hours only when every supplied interval reports tokens', async () => {
    const { summary } = await fixture();
    const first = summary.days[0]!.hours![0]!;
    first.requests = 2; first.tokens = 100;
    summary.days[0]!.hours!.push({ ...first, requests: 3, tokens: 200 });
    const props = { summary, timezone: 'UTC', selectedDate: '', onSelectDate: () => {} };
    const tree = await harness.mount(<UsageAnalyticsActivity {...props} />);
    let cell = tree.container.querySelector('.uad-heatmap [data-slot="0"]')!;
    await act(async () => cell.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
    expect(tree.container.querySelector('.uad-heatmap [role=tooltip]')?.textContent).toContain('Tool requests5Tokens300');
    delete summary.days[0]!.hours!.at(-1)!.tokens;
    await tree.render(<UsageAnalyticsActivity {...props} />);
    cell = tree.container.querySelector('.uad-heatmap [data-slot="0"]')!;
    await act(async () => cell.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
    expect(tree.container.querySelector('.uad-heatmap [role=tooltip]')?.textContent).toContain('TokensNot available');
});

test('partial-end uncached hit bands and selected wash stop at the calendar end and areas do not bridge absent bins', async () => {
    const { snapshot } = await fixture();
    const summary = snapshot.ranges.all;
    summary.startDate = '2026-10-01'; summary.endDateExclusive = '2026-10-10'; summary.bucketDays = 4;
    summary.days = [1, 9].map((date, i) => ({ ...snapshot.ranges['7d'].days[i]!, date: `2026-10-${String(date).padStart(2, '0')}`, tokens: { fresh: i ? 20 : 40, write: 0, read: 0, output: 0 } }));
    const tree = await harness.mount(<CacheOwner summary={summary} />);
    const chart = tree.container.querySelector('.uad-uncached')!;
    const days = chart.querySelectorAll<SVGGElement>('[role=button]');
    const first = days[0]!.querySelector('rect')!, last = days[1]!.querySelector('rect')!;
    expect(Number(last.getAttribute('width')) * 4).toBeCloseTo(Number(first.getAttribute('width')));
    const clip = chart.querySelector('clipPath rect')!;
    const right = Number(clip.getAttribute('x')) + Number(clip.getAttribute('width'));
    expect(Number(last.getAttribute('x')) + Number(last.getAttribute('width'))).toBeCloseTo(right);
    expect(chart.querySelector('.uad-area-fresh')?.getAttribute('d')?.match(/M/g)).toHaveLength(2);
    expect(chart.textContent).toContain('Average 26.7');
    await act(async () => days[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    const wash = chart.querySelector('.uad-selected-day')!;
    expect(wash.getAttribute('x')).toBe(last.getAttribute('x'));
    expect(wash.getAttribute('width')).toBe(last.getAttribute('width'));
    expect(chart.querySelector('.uad-pin-rule')).toBeNull();
});

test('section headings retain the final type scale when the common page stylesheet loads later', async () => {
    const { summary } = await fixture();
    const styles = document.createElement('style');
    styles.textContent = readFileSync(new URL('./usageAnalyticsDetails.css', import.meta.url), 'utf8') + '\n' + readFileSync(new URL('./usageDashboard.css', import.meta.url), 'utf8');
    document.head.append(styles);
    try {
        const tree = await harness.mount(<main className="usage-page"><UsageAnalyticsCache summary={summary} selectedDate="" onSelectDate={() => {}} /></main>);
        const heading = tree.container.querySelector('h2')!;
        expect(getComputedStyle(heading).fontSize).toBe('17.5px');
        expect(getComputedStyle(heading).fontWeight).toBe('680');
    } finally {
        styles.remove();
    }
});

test('cache row hover clears on entering its own chart axis rather than waiting to leave the SVG', async () => {
    const { summary } = await fixture();
    const tree = await harness.mount(<CacheOwner summary={summary} />);
    const chart = tree.container.querySelector('.uad-dots')!;
    const rows = chart.querySelectorAll<SVGGElement>('[tabindex]');
    const axis = chart.querySelector('text')!;
    await act(async () => rows[0]!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
    expect(chart.querySelector('[role=tooltip]')).not.toBeNull();
    expect(rows[1]!.getAttribute('opacity')).toBe('0.4');
    await act(async () => rows[0]!.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: axis })));
    expect(chart.querySelector('[role=tooltip]')).toBeNull();
    expect(rows[1]!.getAttribute('opacity')).toBe('1');
});

test('build plot hover clears at the axis while a selected build remains the readout fallback', async () => {
    const { summary } = await fixture();
    summary.days[0]!.tools[0]!.builds!.items.push({ sha: 'other', dirty: false, requests: 200, results: 200, errors: 80, firstObservedAt: '2026-10-12T14:00:00Z' });
    const props = { summary, onSelectTool: () => {}, onSelectRoute: () => {}, onSelectBuild: () => {} };
    const tree = await harness.mount(<UsageAnalyticsReliability {...props} />);
    const chart = tree.container.querySelector('.uad-builds')!, overlay = chart.querySelector('.uad-build-pick')!, axis = chart.querySelector('text')!;
    const points = chart.querySelectorAll<SVGGElement>('[role=button]');
    const hoverOther = async () => {
        const dot = points[1]!.querySelector('circle')!;
        await act(async () => overlay.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: Number(dot.getAttribute('cx')), clientY: Number(dot.getAttribute('cy')) })));
    };
    const leaveToAxis = async () => act(async () => overlay.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: axis })));
    await hoverOther();
    expect(chart.querySelector('[role=tooltip]')?.textContent).toContain('other');
    await leaveToAxis();
    expect(chart.querySelector('[role=tooltip]')).toBeNull();
    expect([...points].every(point => point.getAttribute('opacity') === '1')).toBe(true);
    await act(async () => points[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    await hoverOther();
    expect(chart.querySelector('[role=tooltip]')?.textContent).toContain('other');
    await leaveToAxis();
    expect(chart.querySelector('[role=tooltip]')?.textContent).toContain('abc123');
    expect(tree.container.querySelector('.uad-build-readout')?.textContent).toContain('abc123');
    expect(points[0]!.getAttribute('aria-pressed')).toBe('true');
    expect([...points].every(point => point.getAttribute('opacity') === '1')).toBe(true);
});

test('Details retains the prototype fourteen-pixel baseline under a sixteen-pixel app root without scaling physical charts', async () => {
    const { summary } = await fixture();
    summary.cacheWriteReporting = 'partial';
    const styles = document.createElement('style');
    // The DOM harness cannot resolve light-dark(); use a concrete seam color for border geometry.
    styles.textContent = 'html { font-size: 16px; line-height: 1.5; }\n' + readFileSync(new URL('./usageAnalyticsDetails.css', import.meta.url), 'utf8') + '\n.usage-analytics-details { --uad-hair: #ddd; }';
    document.head.append(styles);
    try {
        const tree = await harness.mount(<main className="usage-page"><CacheOwner summary={summary} /><ModelsOwner summary={summary} /><UsageAnalyticsReliability summary={summary} onSelectTool={() => {}} onSelectRoute={() => {}} onSelectBuild={() => {}} /></main>);
        const css = (selector: string) => getComputedStyle(tree.container.querySelector(selector)!);
        expect(getComputedStyle(document.documentElement).fontSize).toBe('16px');
        expect(css('.usage-analytics-details').fontSize).toBe('14px');
        expect(css('.usage-analytics-details').lineHeight).toBe('normal');
        for (const paragraph of tree.container.querySelectorAll('.uad-cache-grid .uad-card > header p, .uad-cache-grid .uad-card > p')) {
            const paragraphStyle = getComputedStyle(paragraph);
            const lineHeight = Number.parseFloat(paragraphStyle.lineHeight);
            expect(lineHeight > 3 ? lineHeight / Number.parseFloat(paragraphStyle.fontSize) : lineHeight).toBeCloseTo(1.45);
        }
        expect(css('h2').fontSize).toBe('17.5px');
        expect(css('.uad-trio dd').fontSize).toBe('21px');
        expect(css('.uad-cache-grid dd').fontSize).toBe('21px');
        expect(css('.uad-cache-grid dd').fontWeight).toBe('680');
        expect(css('.uad-duo').display).toBe('grid');
        expect(css('.uad-duo').gridTemplateColumns).toBe('repeat(2, minmax(0, 1fr))');
        for (const group of tree.container.querySelectorAll('.uad-trio')) {
            const groupStyle = getComputedStyle(group);
            expect(groupStyle.gap).toBe('12px');
            expect(groupStyle.paddingBottom).toBe('12px');
            expect(groupStyle.marginBottom).toBe('12px');
            expect(groupStyle.borderBottomWidth).toBe('1px');
        }
        const plainStats = document.createElement('dl');
        plainStats.className = 'uad-stats';
        const plainValue = document.createElement('dd');
        plainValue.textContent = '1';
        plainStats.append(plainValue);
        tree.container.querySelector('.usage-analytics-details')!.append(plainStats);
        expect(getComputedStyle(plainValue).fontSize).toBe('19px');
        expect(getComputedStyle(plainValue).fontWeight).toBe('650');
        expect(css('.uad-route-label').fontSize).toBe('12px');
        expect(css('.uad-route-value').fontSize).toBe('15px');
        expect(css('.uad-route-value').fontWeight).toBe('680');
        expect(css('.uad-route-badge').fontSize).toBe('10.5px');
        expect(css('.uad-line text').fontSize).toBe('11px');
        expect(css('.uad-dots text').fontSize).toBe('11px');
        expect(css('.uad-trend').width).toBe('126px');
        expect(css('.uad-tools button').fontSize).toBe('12.5px');
        expect(css('.uad-tools button').gridTemplateColumns).toBe('minmax(98px, 1.3fr) minmax(49px, .6fr) minmax(70px, 1.2fr) minmax(49px, .6fr)');
        const toolRow = css('.uad-tools button'), toolHeader = css('.uad-tools-head');
        expect(toolRow.paddingTop).toBe('7px');
        expect(toolRow.paddingBottom).toBe('7px');
        expect(toolRow.borderRadius).toBe('0px');
        for (const rowStyle of [toolRow, toolHeader]) {
            expect(rowStyle.paddingLeft).toBe('8px');
            expect(rowStyle.paddingRight).toBe('8px');
            expect(rowStyle.marginTop).toBe('0px');
            expect(rowStyle.marginBottom).toBe('0px');
            expect(rowStyle.marginLeft).toBe('-8px');
            expect(rowStyle.marginRight).toBe('-8px');
            expect(rowStyle.width).toBe('calc(100% + 16px)');
            expect(rowStyle.boxSizing).toBe('border-box');
            expect(rowStyle.gridTemplateColumns).toBe(toolRow.gridTemplateColumns);
        }
        expect(toolHeader.paddingTop).toBe('0px');
        expect(toolHeader.paddingBottom).toBe('7px');
        const trackMinima = [...toolRow.gridTemplateColumns.matchAll(/minmax\((\d+)px/g)].map(match => Number(match[1]));
        const minimumTracks = trackMinima.reduce((sum, value) => sum + value, 0) + (trackMinima.length - 1) * Number.parseFloat(toolRow.gap);
        const cardStyle = css('.uad-reliability-grid > .uad-card');
        const cardChrome = Number.parseFloat(cardStyle.paddingLeft) + Number.parseFloat(cardStyle.paddingRight) + Number.parseFloat(cardStyle.borderLeftWidth) + Number.parseFloat(cardStyle.borderRightWidth);
        // Even before the narrow three-column fallback, the row fits the smallest supported content width.
        expect(minimumTracks).toBeLessThanOrEqual(376 - cardChrome);
        expect(css('.uad-cache-grid').gridTemplateColumns).toBe('repeat(12, minmax(0, 1fr))');
        expect(css('.uad-cache-grid > .uad-card:first-child').gridColumn).toBe('span 8');
        expect(css('.uad-cache-grid > .uad-card:last-child').gridColumn).toBe('span 4');
        expect(tree.container.querySelector('.uad-line')?.getAttribute('viewBox')?.split(' ').at(-1)).toBe('210');
        expect(tree.container.querySelector('.uad-uncached')?.getAttribute('viewBox')?.split(' ').at(-1)).toBe('150');
        const model = tree.container.querySelector<SVGGElement>('.uad-dots [tabindex]')!;
        await act(async () => model.dispatchEvent(new FocusEvent('focusin', { bubbles: true })));
        expect(css('.uad-tooltip text').fontSize).toBe('12px');
    } finally {
        styles.remove();
    }
});

test('Activity profile gradient receives its accent color explicitly without changing cache or spark gradient colors', async () => {
    const { summary } = await fixture();
    const tree = await harness.mount(<><CacheOwner summary={summary} /><ModelsOwner summary={summary} /><UsageAnalyticsActivity summary={summary} timezone="UTC" selectedDate="" onSelectDate={() => {}} /></>);
    const profile = tree.container.querySelector('.uad-profile-fill')!;
    const profileGradient = tree.container.querySelector('.uad-heatmap linearGradient')!;
    expect(profile.getAttribute('fill')).toBe(`url(#${profileGradient.id})`);
    expect([...profileGradient.querySelectorAll('stop')].map(stop => stop.getAttribute('stop-color'))).toEqual(Array(5).fill('var(--uad-profile-color)'));
    for (const svg of tree.container.querySelectorAll('.uad-line, .uad-spark svg')) {
        expect([...svg.querySelectorAll('stop')].every(stop => stop.getAttribute('stop-color') === 'currentColor')).toBe(true);
    }
});

test('narrow concurrency axis has compact unique ticks and a separate shared elapsed qualifier', async () => {
    const { summary } = await fixture();
    const bounds = spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ width: 340, height: 230, x: 0, y: 0, left: 0, top: 0, right: 340, bottom: 230, toJSON() { return {}; } }));
    try {
        const tree = await harness.mount(<UsageAnalyticsActivity summary={summary} timezone="UTC" selectedDate="" onSelectDate={() => {}} />);
        await act(async () => [...tree.container.querySelectorAll('button')].find(button => button.textContent === 'Sessions at once')!.click());
        const chart = tree.container.querySelector('.uad-heatmap')!;
        const labels = chart.querySelectorAll('.uad-x-axis-label');
        expect(labels.length).toBeGreaterThan(1);
        expect(labels.length).toBeLessThan(8);
        expect([...labels].every(label => /^\d{2}$/.test(label.textContent!))).toBe(true);
        expect(new Set([...labels].map(label => label.textContent)).size).toBe(labels.length);
        const qualifier = chart.querySelector('.uad-axis-qualifier')!;
        expect(qualifier.textContent).toBe('Elapsed hours');
        expect(Number(qualifier.getAttribute('y')) - Number(labels[0]!.getAttribute('y'))).toBe(17);
        let previousRight = -Infinity;
        for (const label of labels) {
            const x = Number(label.getAttribute('x'));
            expect(x - previousRight).toBeGreaterThanOrEqual(12);
            previousRight = x + label.textContent!.length * 6.1;
        }
    } finally {
        bounds.mockRestore();
    }
});

test('single-build scatter renders unique minute-resolution labels without collisions at narrow and wide widths', async () => {
    const { summary } = await fixture();
    let width = 340;
    const bounds = spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ width, height: 230, x: 0, y: 0, left: 0, top: 0, right: width, bottom: 230, toJSON() { return {}; } }));
    try {
        for (width of [340, 640]) {
            const tree = await harness.mount(<UsageAnalyticsReliability summary={summary} onSelectTool={() => {}} onSelectRoute={() => {}} onSelectBuild={() => {}} />);
            const chart = tree.container.querySelector('.uad-builds')!;
            expect(chart.querySelectorAll('[role=button]')).toHaveLength(1);
            const labels = chart.querySelectorAll('.uad-x-axis-label');
            expect(labels.length).toBeGreaterThan(1);
            expect(new Set([...labels].map(label => label.textContent)).size).toBe(labels.length);
            let previousRight = -Infinity;
            for (const label of labels) {
                expect(label.textContent).toMatch(/\d{1,2}:\d{2}\s[AP]M/);
                const textWidth = label.textContent!.length * 6.1;
                const anchor = label.getAttribute('text-anchor');
                const left = Number(label.getAttribute('x')) - (anchor === 'start' ? 0 : anchor === 'end' ? textWidth : textWidth / 2);
                expect(left).toBeGreaterThanOrEqual(previousRight + 12);
                expect(left + textWidth).toBeLessThanOrEqual(width);
                previousRight = left + textWidth;
            }
        }
    } finally {
        bounds.mockRestore();
    }
});
