import { MAX_USAGE_CONTRIBUTOR_MODELS, MAX_USAGE_DAY_CONTRIBUTORS, MAX_USAGE_MODELS, MAX_USAGE_TOOLS, MAX_USAGE_TOOL_BUILDS_PER_DAY, MAX_USAGE_TIMELINE_EVENTS, type UsageTokens, type UsageCategory, type UsageRangeSummary, type UsageSessionContributor, type UsageTokenCostEstimate, type UsageDayTool, type UsageSessionTimeline, } from '../shared/usageDashboard.js';
export { usageCategory } from '../../src/utils/usageCategory.js';
export const tokenTotal = (t: UsageTokens): number => t.fresh + t.read + t.write + t.output;
export const emptyTokens = (): UsageTokens => ({ fresh: 0, read: 0, write: 0, output: 0 });
const emptyCost = (): UsageTokenCostEstimate => ({ usd: 0, pricedTokens: 0 });
const addCost = (target: UsageTokenCostEstimate, value: UsageTokenCostEstimate | undefined) => {
    target.usd += value?.usd ?? 0;
    target.pricedTokens += value?.pricedTokens ?? 0;
};
function withDayRanks(items: UsageSessionContributor[]): UsageSessionContributor[] {
    if (items.every(item => item.rank)) return items;
    const sort = (metric: 'tokens' | 'requests' | 'errors') => [...items].sort((a, b) => {
        const difference = metric === 'tokens' ? tokenTotal(b.tokens) - tokenTotal(a.tokens) : b[metric] - a[metric];
        return difference || tokenTotal(b.tokens) - tokenTotal(a.tokens) || b.requests - a.requests || b.errors - a.errors || a.id.localeCompare(b.id);
    });
    const ranked = { tokens: sort('tokens'), requests: sort('requests'), errors: sort('errors') };
    const ranks = {
        tokens: new Map(ranked.tokens.map((item, index) => [item.id, index + 1])),
        requests: new Map(ranked.requests.map((item, index) => [item.id, index + 1])),
        errors: new Map(ranked.errors.map((item, index) => [item.id, index + 1])),
    };
    return items.map(item => ({ ...item, rank: {
        tokens: ranks.tokens.get(item.id)!,
        requests: ranks.requests.get(item.id)!,
        errors: ranks.errors.get(item.id)!,
    } }));
}
/** Group only after complete accounting. The same model selection applies to every day. */
export function groupUsageSummary(summary: UsageRangeSummary, modelLimit = MAX_USAGE_MODELS, toolLimit = MAX_USAGE_TOOLS, contributorLimit = MAX_USAGE_DAY_CONTRIBUTORS): UsageRangeSummary {
    const buildLimit = toolLimit >= MAX_USAGE_TOOLS ? MAX_USAGE_TOOL_BUILDS_PER_DAY : toolLimit >= 4 ? 4 : 0;
    const timelineLimit = contributorLimit <= 5
        ? Math.min(1, contributorLimit)
        : Math.min(MAX_USAGE_TIMELINE_EVENTS, Math.ceil(contributorLimit * 0.6));
    const boundedTimeline = (timeline: UsageSessionTimeline): UsageSessionTimeline => {
        if (timeline.state === 'unavailable') return { ...timeline, items: [] };
        const omitted = timeline.omitted + Math.max(0, timeline.items.length - timelineLimit);
        const items = timelineLimit > 0 ? timeline.items.slice(-timelineLimit) : [];
        return { state: omitted > 0 ? 'truncated' : items.length > 0 ? 'available' : 'unavailable', omitted, items };
    };
    const models = [...summary.models].sort((a, b) => tokenTotal(b.tokens) - tokenTotal(a.tokens) || a.id.localeCompare(b.id));
    const tools = [...summary.tools].sort((a, b) => b.requests - a.requests || a.id.localeCompare(b.id));
    const selectedModels = new Set(models.filter(m => m.kind === 'named').slice(0, modelLimit).map(m => m.id));
    const selectedTools = new Set(tools.filter(t => t.kind === 'named').slice(0, toolLimit).map(t => t.id));
    const keepModel = (m: UsageCategory) => m.kind === 'unknown' || selectedModels.has(m.id);
    const keepTool = (t: UsageCategory) => t.kind === 'unknown' || selectedTools.has(t.id);
    const omittedModels = models.filter(m => !keepModel(m));
    const omittedTools = tools.filter(t => !keepTool(t));
    const otherTokens = emptyTokens();
    const otherCost = emptyCost();
    for (const m of omittedModels)
        { for (const key of Object.keys(otherTokens) as (keyof UsageTokens)[])
            otherTokens[key] += m.tokens[key];
          addCost(otherCost, m.tokenCost); }
    const keptModelIds = new Set(models.filter(keepModel).map(m => m.id));
    const keptToolIds = new Set(tools.filter(keepTool).map(tool => tool.id));
    const groupDayTools = (items: UsageDayTool[]): UsageDayTool[] => {
        const grouped = new Map<string, UsageDayTool>();
        for (const source of items) {
            const id = keptToolIds.has(source.id) ? source.id : 'other';
            let target = grouped.get(id);
            if (!target) {
                target = { id, requests: 0, results: 0, errors: 0 };
                grouped.set(id, target);
            }
            target.requests += source.requests;
            target.results += source.results;
            target.errors += source.errors;
            if (!source.builds) continue;
            target.builds ??= { items: [] };
            if (source.builds.omitted) {
                target.builds.omitted ??= { count: 0, requests: 0, results: 0, errors: 0 };
                target.builds.omitted.count += source.builds.omitted.count;
                target.builds.omitted.requests += source.builds.omitted.requests;
                target.builds.omitted.results += source.builds.omitted.results;
                target.builds.omitted.errors += source.builds.omitted.errors;
            }
            for (const build of source.builds.items) {
                const existing = target.builds.items.find(item => item.sha === build.sha && item.dirty === build.dirty);
                if (existing) {
                    existing.requests += build.requests;
                    existing.results += build.results;
                    existing.errors += build.errors;
                    if (build.firstObservedAt < existing.firstObservedAt) existing.firstObservedAt = build.firstObservedAt;
                } else target.builds.items.push({ ...build });
            }
        }
        for (const tool of grouped.values()) {
            if (!tool.builds) continue;
            const ranked = [...tool.builds.items].sort((a, b) => b.requests - a.requests || a.firstObservedAt.localeCompare(b.firstObservedAt) || a.sha.localeCompare(b.sha));
            const omitted = ranked.slice(buildLimit);
            tool.builds.items = ranked.slice(0, buildLimit).sort((a, b) => a.firstObservedAt.localeCompare(b.firstObservedAt) || a.sha.localeCompare(b.sha));
            if (omitted.length) {
                tool.builds.omitted ??= { count: 0, requests: 0, results: 0, errors: 0 };
                tool.builds.omitted.count += omitted.length;
                tool.builds.omitted.requests += omitted.reduce((sum, item) => sum + item.requests, 0);
                tool.builds.omitted.results += omitted.reduce((sum, item) => sum + item.results, 0);
                tool.builds.omitted.errors += omitted.reduce((sum, item) => sum + item.errors, 0);
            }
        }
        return [...grouped.values()].sort((a, b) => b.requests - a.requests || a.id.localeCompare(b.id));
    };
    return {
        ...summary,
        models: [...models.filter(keepModel), ...(omittedModels.length ? [{ id: 'other', kind: 'other' as const, label: 'Other', tokens: otherTokens, tokenCost: otherCost }] : [])].sort((a, b) => tokenTotal(b.tokens) - tokenTotal(a.tokens) || a.id.localeCompare(b.id)),
        tools: [...tools.filter(keepTool), ...(omittedTools.length ? [{ id: 'other', kind: 'other' as const, label: 'Other', requests: omittedTools.reduce((n, t) => n + t.requests, 0), results: omittedTools.reduce((n, t) => n + t.results, 0), errors: omittedTools.reduce((n, t) => n + t.errors, 0) }] : [])].sort((a, b) => b.requests - a.requests || a.id.localeCompare(b.id)),
        days: summary.days.map(day => {
            const kept = day.models.filter(m => keptModelIds.has(m.id));
            const other = day.models.filter(m => !keptModelIds.has(m.id)).reduce((n, m) => n + m.total, 0);
            const tools = groupDayTools(day.tools);
            if (day.contributors.state === 'unavailable') return { ...day, tools, models: [...kept, ...(other ? [{ id: 'other', total: other }] : [])] };
            const ranked = withDayRanks([...day.contributors.items]);
            const leadersPerMetric = Math.floor(contributorLimit / 3);
            const selected = new Set(ranked.filter(item => item.rank && (item.rank.tokens <= leadersPerMetric || item.rank.requests <= leadersPerMetric || item.rank.errors <= leadersPerMetric)));
            for (const item of [...ranked].filter(item => item.timeline.state !== 'unavailable').sort((a, b) => (b.timeline.items.at(-1)?.startedAt ?? '').localeCompare(a.timeline.items.at(-1)?.startedAt ?? '') || a.id.localeCompare(b.id))) {
                if (selected.size >= contributorLimit) break;
                selected.add(item);
            }
            for (const item of [...ranked].sort((a, b) => a.rank!.tokens - b.rank!.tokens)) {
                if (selected.size >= contributorLimit) break;
                selected.add(item);
            }
            const contributors = [...selected].sort((a, b) => a.rank!.tokens - b.rank!.tokens).map(contributor => {
                const models = [...contributor.models].sort((a, b) => tokenTotal(b.tokens) - tokenTotal(a.tokens) || a.id.localeCompare(b.id));
                const named = models.filter(model => model.kind === 'named');
                const selected = new Set(named.slice(0, MAX_USAGE_CONTRIBUTOR_MODELS).map(model => model.id));
                const retained = models.filter(model => model.kind !== 'named' || selected.has(model.id));
                const omittedModels = models.filter(model => !retained.includes(model));
                const otherTokens = emptyTokens();
                const otherCost = emptyCost();
                for (const model of omittedModels) { for (const key of Object.keys(otherTokens) as (keyof UsageTokens)[]) otherTokens[key] += model.tokens[key]; addCost(otherCost, model.tokenCost); }
                const existingOther = retained.find(model => model.kind === 'other');
                const outputModels = retained.filter(model => model.kind !== 'other');
                if (existingOther) { for (const key of Object.keys(otherTokens) as (keyof UsageTokens)[]) otherTokens[key] += existingOther.tokens[key]; addCost(otherCost, existingOther.tokenCost); }
                const omitted = contributor.modelDetail.omitted + omittedModels.length;
                return { ...contributor, models: [...outputModels, ...(omitted ? [{ id: 'other', kind: 'other' as const, label: 'Other', tokens: otherTokens, tokenCost: otherCost }] : [])], modelDetail: { state: omitted ? 'grouped' as const : 'full' as const, omitted }, timeline: boundedTimeline(contributor.timeline) };
            });
            const omitted = day.contributors.omitted + ranked.length - contributors.length;
            return { ...day, tools, models: [...kept, ...(other ? [{ id: 'other', total: other }] : [])], contributors: { state: omitted ? 'truncated' as const : 'full' as const, omitted, items: contributors } };
        }),
        detail: { state: omittedModels.length || omittedTools.length ? (modelLimit || toolLimit ? 'grouped' : 'summary-only') : 'full', omittedModels: omittedModels.length, omittedTools: omittedTools.length },
    };
}
