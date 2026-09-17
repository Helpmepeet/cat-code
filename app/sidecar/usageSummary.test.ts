import { expect, test } from 'bun:test';
import { emptyTokens, groupUsageSummary, usageCategory } from './usageSummary.js';
import type { UsageRangeSummary } from '../shared/usageDashboard.js';
test('grouping preserves exact daily/model/tool totals and distinguishes reserved names', () => {
    const models = Array.from({ length: 100 }, (_, i) => ({ ...usageCategory(i === 0 ? 'Other' : `模型${i}`), tokens: { ...emptyTokens(), fresh: i + 1 } }));
    const summary: UsageRangeSummary = { range: '7d', startInclusive: '', endExclusive: '', tokens: { ...emptyTokens(), fresh: 5050 }, sessions: 1, records: 1, requests: 100, identifiedRequests: 100, fallbackRequests: 0, activeDays: 1, cachedInputShare: 0, cacheWriteReporting: 'reported', models, tools: models.map(m => ({ id: m.id, kind: m.kind, label: m.label, requests: 1, results: 1, errors: 1 })), days: [{ date: '2026-09-13', results: 100, errors: 100, hourlyTokens: [5050, ...Array(23).fill(0)], hourlyRequests: [100, ...Array(23).fill(0)], tokens: { ...emptyTokens(), fresh: 5050 }, cacheWriteReporting: 'reported', models: models.map(m => ({ id: m.id, total: m.tokens.fresh })), sessions: 1, records: 1, requests: 100, contributors: { state: 'full', omitted: 0, items: [] } }], detail: { state: 'full', omittedModels: 0, omittedTools: 0 } };
    const grouped = groupUsageSummary(summary);
    expect(grouped.models).toHaveLength(9);
    expect(grouped.models.reduce((n, m) => n + m.tokens.fresh, 0)).toBe(5050);
    expect(grouped.days[0]!.models.reduce((n, m) => n + m.total, 0)).toBe(5050);
    expect(grouped.tools.reduce((n, t) => n + t.requests, 0)).toBe(100);
    expect(grouped.tools.reduce((n, t) => n + t.errors, 0)).toBe(100);
    expect(grouped.tools.reduce((n, t) => n + t.results, 0)).toBe(100);
    expect(grouped.detail).toEqual({ state: 'grouped', omittedModels: 92, omittedTools: 90 });
    expect(usageCategory('Other').id).not.toBe('other');
    expect(usageCategory('Unknown').id).not.toBe('unknown');
    expect(usageCategory('模型'.repeat(500)).label.length).toBeGreaterThan(0);
    expect(Buffer.byteLength(usageCategory('模型'.repeat(500)).label)).toBeLessThanOrEqual(160);
    expect(usageCategory('x'.repeat(200) + 'a').id).not.toBe(usageCategory('x'.repeat(200) + 'b').id);
});

test('contributors are ranked and truncated with explicit omitted counts', () => {
    const base = { id: '', engineSessionId: null, project: null, tokens: emptyTokens(), requests: 0, results: 0, errors: 0, models: [], modelDetail: { state: 'full' as const, omitted: 0 } };
    const items = Array.from({ length: 25 }, (_, i) => ({ ...base, id: `session-${i}`, tokens: { ...emptyTokens(), fresh: i }, requests: i === 0 ? 100 : i === 1 ? 10 : 0, results: i === 1 ? 10 : 0, errors: i === 1 ? 10 : 0 }));
    const summary: UsageRangeSummary = { range: '7d', startInclusive: '', endExclusive: '', tokens: { ...emptyTokens(), fresh: 300 }, sessions: 25, records: 25, requests: 110, identifiedRequests: 110, fallbackRequests: 0, activeDays: 1, cachedInputShare: 0, cacheWriteReporting: 'reported', models: [], tools: [], days: [{ date: '2026-09-13', results: 10, errors: 10, hourlyTokens: [300, ...Array(23).fill(0)], hourlyRequests: [110, ...Array(23).fill(0)], tokens: { ...emptyTokens(), fresh: 300 }, cacheWriteReporting: 'reported', models: [], sessions: 25, records: 25, requests: 110, contributors: { state: 'full', omitted: 0, items } }], detail: { state: 'full', omittedModels: 0, omittedTools: 0 } };
    const grouped = groupUsageSummary(summary);
    expect(grouped.days[0]!.contributors).toMatchObject({ state: 'truncated', omitted: 5 });
    expect(grouped.days[0]!.contributors.items.map(item => item.id)).toContain('session-0');
    expect(grouped.days[0]!.contributors.items.map(item => item.id)).toContain('session-1');
    for (const metric of ['tokens', 'requests', 'errors'] as const) {
        const ranks = new Set(grouped.days[0]!.contributors.items.map(item => item.rank![metric]));
        for (let rank = 1; rank <= 6; rank++) expect(ranks.has(rank)).toBe(true);
    }
    expect(groupUsageSummary(grouped).days[0]!.contributors).toMatchObject({ state: 'truncated', omitted: 5 });
    const fallback = groupUsageSummary(grouped, 8, 10, 5).days[0]!.contributors;
    expect(fallback.items.map(item => item.id)).toEqual(expect.arrayContaining(['session-24', 'session-0', 'session-1']));
    expect(fallback.items.find(item => item.id === 'session-0')!.rank!.requests).toBe(1);
    expect(fallback.items.find(item => item.id === 'session-1')!.rank!.errors).toBe(1);
});

test('model grouping preserves priced subtotal and token pricing coverage', () => {
    const models = Array.from({ length: 6 }, (_, i) => ({ ...usageCategory(`model-${i}`), tokens: { ...emptyTokens(), fresh: i + 1 }, tokenCost: { usd: i === 4 ? 0 : (i + 1) / 1_000_000, pricedTokens: i === 4 ? 0 : i + 1 } }));
    const summary: UsageRangeSummary = { range: '7d', startInclusive: '', endExclusive: '', tokens: { ...emptyTokens(), fresh: 21 }, sessions: 1, records: 1, requests: 0, identifiedRequests: 0, fallbackRequests: 0, activeDays: 1, cachedInputShare: 0, cacheWriteReporting: 'reported', models, tools: [], days: [{ date: '2026-09-13', results: 0, errors: 0, hourlyTokens: [21, ...Array(23).fill(0)], hourlyRequests: Array(24).fill(0), tokens: { ...emptyTokens(), fresh: 21 }, cacheWriteReporting: 'reported', models: models.map(model => ({ id: model.id, total: model.tokens.fresh })), sessions: 1, records: 1, requests: 0, contributors: { state: 'full', omitted: 0, items: [] } }], detail: { state: 'full', omittedModels: 0, omittedTools: 0 } };
    const grouped = groupUsageSummary(summary, 1);
    const other = grouped.models.find(model => model.kind === 'other')!;
    expect(other.tokens.fresh).toBe(15);
    expect(other.tokenCost).toEqual({ usd: 10 / 1_000_000, pricedTokens: 10 });
});
