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
    for (const text of ['Model requests', 'Sessions', 'Input from cache', 'Tool error rate', 'Latest build errors', 'Tokens processed', 'Selected range', 'Model families', 'Where the tokens go', 'Cache', 'Activity', 'Models', 'Reliability']) expect(html).toContain(text);
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
    expect(html).toContain('Pinned day'); expect(html).toContain('Tokens</dt><dd>123'); expect(html).toContain('80.0%');
});

test('frame has content-width breakpoints, reduced motion and no dashboard-owned background', () => {
    const frame = readFileSync(new URL('./usageDashboard.css', import.meta.url), 'utf8');
    const daily = readFileSync(new URL('./usageDailyChart.css', import.meta.url), 'utf8');
    expect(frame.split('\n')[0]).not.toContain('background:');
    expect(frame).toContain('container:usage / inline-size');
    expect(daily).toContain('@container usage (max-width:999px)'); expect(daily).toContain('@container usage (max-width:759px)');
    expect(daily).toContain('prefers-reduced-motion'); expect(daily).toContain('var(--accent) 55%');
});

test('analytics overrides the inherited Claude token for both palette modes without changing the global theme', () => {
    const frame = readFileSync(new URL('./usageDashboard.css', import.meta.url), 'utf8');
    const content = frame.match(/\.usage-content \{([\s\S]*?)\n\}/)![1]!;
    expect(content).toContain('--provider-claude:light-dark(#d97757,#ce6c4b)');
    const daily = readFileSync(new URL('./usageDailyChart.css', import.meta.url), 'utf8');
    expect(daily).toContain('--usage-category-1:var(--provider-claude)');
});
