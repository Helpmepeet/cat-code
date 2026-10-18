import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { act, useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { collectRetainedUsage } from '../../../src/utils/statsUsage.js';
import { createDomTestHarness, type DomTestHarness } from './domTestHarness.js';
import { UsageAnalyticsActivity, UsageAnalyticsCache, UsageAnalyticsModels, UsageAnalyticsReliability } from './UsageAnalyticsDetails.js';
import type { UsageRangeSummary } from '../../shared/usageDashboard.js';

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
    return <UsageAnalyticsCache summary={summary} partial={false} selectedDate={selectedDate} onSelectDate={onSelectDate} />;
}
function ModelsOwner({ summary }: { summary: UsageRangeSummary }) {
    const [modelFamilies, onModelFamiliesChange] = useState<string[]>([]);
    return <UsageAnalyticsModels summary={summary} partial={false} modelFamilies={modelFamilies} onModelFamiliesChange={onModelFamiliesChange} />;
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
    const tree = await harness.mount(<UsageAnalyticsActivity summary={summary} timezone={snapshot.timezone} partial={false} selectedDate="" onSelectDate={() => {}} />);
    expect(tree.container.querySelector('.uad-heatmap')).not.toBeNull();
    const toggle = [...tree.container.querySelectorAll('button')].find(b => b.textContent === 'Sessions at once')!;
    await act(async () => toggle.click());
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(tree.container.textContent).toContain('Time by sessions at once');
    const longer = await harness.mount(<UsageAnalyticsActivity summary={snapshot.ranges['30d']} timezone={snapshot.timezone} partial={false} selectedDate="" onSelectDate={() => {}} />);
    expect(longer.container.textContent).toContain('Hourly tool request detail is unavailable for this range.');
    expect(longer.container.querySelector('.uad-heatmap')).toBeNull();
});
test('hourly activity labels canonical counts as tool requests', async () => {
    const { summary } = await fixture();
    summary.days[0]!.hours![0]!.requests = 7;
    summary.days[0]!.requests = 7;
    const tree = await harness.mount(<UsageAnalyticsActivity summary={summary} timezone="UTC" partial={false} selectedDate="" onSelectDate={() => {}} />);
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
    expect(tree.container.textContent).toContain('Reported cache hit rate');
    expect(tree.container.textContent).toContain('Reported range rate 60.0%');
    expect(tree.container.textContent).toContain('not a complete measured rate');
    expect(tree.container.textContent).toContain('Reported hit rate by model');
});
test('30-day supplied ten-minute concurrency is available without hourly requests', async () => {
    const { snapshot } = await fixture();
    const summary = snapshot.ranges['30d'];
    for (const day of summary.days) day.parallel = { state: 'available', minutes: [0, 0, 0], peak: 0, tenMinutePeaks: [] };
    summary.days[0]!.parallel.peak = 4;
    summary.days[0]!.parallel.tenMinutePeaks = [[6, 4]];
    const dates: string[] = [];
    const tree = await harness.mount(<UsageAnalyticsActivity summary={summary} timezone="UTC" partial={false} selectedDate="" onSelectDate={date => dates.push(date)} />);
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
    const tree = await harness.mount(<UsageAnalyticsActivity summary={summary} timezone="UTC" partial={false} selectedDate="" onSelectDate={() => {}} />);
    await act(async () => [...tree.container.querySelectorAll('button')].find(b => b.textContent === 'Sessions at once')!.click());
    expect(tree.container.querySelector('.uad-heatmap')).toBeNull();
    expect(tree.container.textContent).toContain('Each retained bucket spans up to 4 days.');
    expect(tree.container.textContent).toContain('Ten-minute concurrency detail is unavailable for this range.');
});
test('single-day sparse all-history slots display only supplied days', async () => {
    const { snapshot } = await fixture();
    const summary = snapshot.ranges.all;
    summary.bucketDays = 1;
    summary.days = [snapshot.ranges['7d'].days[0]!, snapshot.ranges['7d'].days[6]!];
    for (const day of summary.days) day.parallel = { state: 'available', minutes: [0, 0, 0], peak: 0, tenMinutePeaks: [] };
    const tree = await harness.mount(<UsageAnalyticsActivity summary={summary} timezone="UTC" partial={false} selectedDate="" onSelectDate={() => {}} />);
    await act(async () => [...tree.container.querySelectorAll('button')].find(b => b.textContent === 'Sessions at once')!.click());
    expect(tree.container.querySelectorAll('.uad-heatmap [role=button]')).toHaveLength(2);
    expect(tree.container.textContent).toContain('Only retained days are shown; gaps are not filled.');
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
    const tree = await harness.mount(<UsageAnalyticsReliability summary={summary} partial onSelectTool={id => calls.push(`tool:${id}`)} onSelectRoute={route => calls.push(`route:${route}`)} onSelectBuild={sha => calls.push(`build:${sha}`)} />);
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
    const tree = await harness.mount(<UsageAnalyticsReliability summary={summary} partial={false} onSelectTool={() => {}} onSelectRoute={() => {}} onSelectBuild={() => {}} />);
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
    const tree = await harness.mount(<UsageAnalyticsReliability summary={summary} partial={false} onSelectTool={() => {}} onSelectRoute={() => {}} onSelectBuild={sha => calls.push(sha)} />);
    const article = tree.container.querySelector('article#usage-build-chart')!;
    expect(article.querySelector('h3')?.textContent).toBe('Error rate by build');
    expect(article.textContent).toContain('Builds with at least 200 tool results.');
    expect(article.querySelectorAll('.uad-builds [role=button]')).toHaveLength(2);
    expect(article.querySelector('.uad-builds')?.textContent).toContain('Median 5.5%');
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
    const tree = await harness.mount(<UsageAnalyticsReliability summary={summary} partial={false} onSelectTool={() => {}} onSelectRoute={() => {}} onSelectBuild={() => {}} />);
    expect(tree.container.querySelector('#usage-build-chart')?.textContent).toContain('No builds with at least 200 tool results.');
    expect(tree.container.querySelector('.uad-builds')).toBeNull();
});
test('supporting SVG tooltips render complete single text strings', async () => {
    const { summary } = await fixture();
    const cache = renderToStaticMarkup(<CacheOwner summary={summary} />);
    expect(cache).toContain('<title>Sol: 60.0%, 100 input tokens</title>');
    expect(cache).toContain(`<title>${summary.days[0]!.date}: 20 fresh input; 20 reported cache writes</title>`);
    const reliability = renderToStaticMarkup(<UsageAnalyticsReliability summary={summary} partial={false} onSelectTool={() => {}} onSelectRoute={() => {}} onSelectBuild={() => {}} />);
    expect(reliability).toContain('<title>abc123: 2 errors / 208 results; first retained request 2026-10-12T12:00:00Z</title>');
    summary.parallel = { state: 'available', minutes: [2, 3, 4], peak: 3 };
    const tree = await harness.mount(<UsageAnalyticsActivity summary={summary} timezone="UTC" partial={false} selectedDate="" onSelectDate={() => {}} />);
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
    const props = { summary, partial: true, onSelectTool: () => {}, onSelectRoute: () => {}, onSelectBuild: () => {} };
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
    const tree = await harness.mount(<UsageAnalyticsReliability summary={summary} partial={false} onSelectTool={() => {}} onSelectRoute={() => {}} onSelectBuild={() => {}} />);
    expect(tree.container.querySelector('.uad-latency-p50')?.getAttribute('cx')).toBe('150');
    expect(tree.container.querySelector('.uad-latency-p95')?.getAttribute('cx')).toBe('150');
    expect(tree.container.querySelectorAll('.uad-latency-p50')).toHaveLength(1);
    expect(tree.container.querySelector('.uad-latency-chart')?.textContent).toContain('Unavailable');
    expect(tree.container.querySelector('.uad-latency-chart')?.outerHTML).not.toContain('NaN');
});
