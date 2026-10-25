import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { UsagePage } from './UsagePage.js';
import { collectRetainedUsage } from '../../../src/utils/statsUsage.js';
import { initialUsageDashboardState, initialUsageSelection, reduceUsageDashboard } from './usageDashboardState.js';
const selectionProps = { selection: initialUsageSelection, onSelectionChange: () => {} };
const snapshot = await collectRetainedUsage([], '2026-09-13T12:00:00.000Z');
function populated() { const copy = structuredClone(snapshot); copy.ranges['7d'].tokens.fresh = 123; copy.ranges['7d'].records = 1; copy.ranges['7d'].days[0]!.tokens.fresh = 123; return copy; }

test('loading, failure, partial and confirmed empty history remain distinct', () => {
    const render = (state: Parameters<typeof UsagePage>[0]['state']) => renderToStaticMarkup(<UsagePage {...selectionProps} state={state}/>);
    expect(render(initialUsageDashboardState)).toContain('Loading analytics');
    expect(render({ snapshot: null, status: 'error' })).toContain('Usage could not be loaded');
    expect(render({ snapshot, status: 'ready' })).toContain('No recorded activity in this period.');
    expect(render({ snapshot, status: 'unavailable' })).toContain('Analytics is unavailable.');
    const partial = populated(); partial.coverage.state = 'partial';
    const html = render({ snapshot: partial, status: 'ready' });
    expect(html).toContain('Activity for this period is incomplete.'); expect(html).toContain('123');
});

test('prototype page has summary, daily explorer and inspector without duplicated legacy panels', () => {
    const html = renderToStaticMarkup(<UsagePage {...selectionProps} state={{ snapshot: populated(), status: 'ready' }}/>);
    for (const text of ['Model requests', 'Sessions', 'Input from cache', 'Tool error rate', 'Latest build errors', 'Tokens processed', 'Last 7 days', 'Model families', 'Where the tokens go', 'Cache', 'Activity', 'Models', 'Reliability']) expect(html).toContain(text);
    for (const removed of ['usage-token-flow-panel', 'usage-values', 'usage-tool-pair', 'Parallel sessions', 'Reasoning effort', 'Prompt cache']) expect(html).not.toContain(removed);
    expect(html).toContain('<h4>Latency</h4>');
    expect(html).toContain('Model latency is unavailable.');
    expect(html).not.toContain('style=');
});

test('auto-only activity stays visible and refresh failure retains last available values', () => {
    const copy = structuredClone(snapshot); copy.ranges['7d'].autoMode.allTools.outcomes.allowed = 1;
    expect(renderToStaticMarkup(<UsagePage {...selectionProps} state={{ snapshot: copy, status: 'ready' }}/>)).not.toContain('No recorded activity');
    const good = reduceUsageDashboard(initialUsageDashboardState, { type: 'usage', version: 1, snapshot: populated() });
    const stale = reduceUsageDashboard(good, { type: 'error', version: 1, code: 'timeout' });
    const html = renderToStaticMarkup(<UsagePage {...selectionProps} state={stale} onRefresh={() => {}}/>);
    expect(html).toContain('Refresh failed. Try again'); expect(html).toContain('Showing the last available update.'); expect(html).toContain('usage-daily-svg');
});

test('inspector remains present with no model attribution and uses reported cache input including writes', () => {
    const copy = populated(), summary = copy.ranges['7d'], day = summary.days[0]!;
    day.tokens = { fresh: 10, read: 80, write: 10, output: 23 };
    const html = renderToStaticMarkup(<UsagePage {...selectionProps} state={{ snapshot: copy, status: 'ready' }} selection={{ range: '7d', date: day.date }}/>);
    expect(html).toContain('usage-daily-detail usage-pinned'); expect(html).toContain('Tokens</dt><dd>123'); expect(html).toContain('80.0%');
});

test('frame has content-width breakpoints, reduced motion and page-owned surfaces', () => {
    const frame = readFileSync(new URL('./usageDashboard.css', import.meta.url), 'utf8');
    const daily = readFileSync(new URL('./usageDailyChart.css', import.meta.url), 'utf8');
    expect(frame.split('\n')[0]).not.toContain('background:');
    expect(frame).toContain('container:usage / inline-size');
    expect(daily).toContain('@container usage (max-width:999px)'); expect(daily).toContain('@container usage (max-width:759px)');
    expect(daily).toContain('prefers-reduced-motion'); expect(daily).toContain('var(--accent) 55%');
    expect(daily).toContain('border-radius:14px');
    expect(daily).toContain('gap:14px');
    expect(daily).toContain('top:-24px; margin:-24px -28px 18px');
    expect(daily).toContain('min-width:224px');
    expect(daily).toContain('@container usage (max-width:560px)');
    expect(daily).toContain('@container usage-inspector (min-width:620px)');
    expect(daily).toContain('grid-template-columns:repeat(6,minmax(0,1fr))');
    expect(daily).toContain(".usage-metric-delta { display:block; font:400 11px 'DM Sans',sans-serif");
    expect(daily).toContain('.usage-metric-foot { display:block');
    expect(daily).toContain('grid-template-rows:auto auto 1fr');
    expect(daily).toContain('stroke-dasharray:1; animation:usage-analytics-draw 700ms');
    expect(daily).toContain('transform-origin:0 calc(100% - 26px); animation:usage-analytics-grow 300ms');
    expect(daily).not.toContain('usage-daily-detail { transition:box-shadow');
    expect(daily).toContain('height:300px; min-height:300px; flex:1 1 300px');
    expect(daily).toContain('font-size:14px;\n  line-height:normal;');
    expect(daily).toContain('grid-template-columns:repeat(12,minmax(0,1fr))');
    expect(daily).toContain('.usage-daily-explorer { grid-column:span 8; }');
    expect(daily).toContain('.usage-daily-detail { grid-column:span 4; }');
    expect(daily).toContain('.usage-daily-grid > .usage-panel { grid-column:span 12; }');
    const track = (1092 - 11 * 14) / 12;
    expect(track * 8 + 7 * 14).toBeCloseTo(723.333333);
    expect(track * 4 + 3 * 14).toBeCloseTo(354.666667);
    const content = daily.match(/\.usage-content \{([\s\S]*?)\n\}/)![1]!;
    expect(content).not.toContain('background:');
    expect(daily).toContain('.usage-page { padding:24px 28px 52px; background:var(--app-bg); }');
    expect(frame).toContain("html[data-glass='on'] .usage-page { background:transparent; }");
    expect(frame).toContain("html[data-glass='on'] .usage-sticky-top { background:transparent; }");
});

test('analytics overrides the inherited Claude token for both palette modes without changing the global theme', () => {
    const frame = readFileSync(new URL('./usageDashboard.css', import.meta.url), 'utf8');
    const content = frame.match(/\.usage-content \{([\s\S]*?)\n\}/)![1]!;
    expect(content).toContain('--provider-claude:light-dark(#d97757,#ce6c4b)');
    const daily = readFileSync(new URL('./usageDailyChart.css', import.meta.url), 'utf8');
    expect(daily).toContain('--usage-category-1:var(--provider-claude)');
});
