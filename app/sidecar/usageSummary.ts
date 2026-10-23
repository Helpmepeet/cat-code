import { MAX_USAGE_CONTRIBUTOR_MODELS, MAX_USAGE_DAY_CONTRIBUTORS, MAX_USAGE_MODELS, MAX_USAGE_TOOLS, MAX_USAGE_TOOL_BUILDS_PER_DAY, MAX_USAGE_TIMELINE_EVENTS, type UsageTokens, type UsageCategory, type UsageDashboardSnapshot, type UsageRangeSummary, type UsageSessionContributor, type UsageTokenCostEstimate, type UsageDayTool, type UsageSessionTimeline, } from '../shared/usageDashboard.js';
import { parseUsageCollectionResult } from '../shared/usageStatsWorker.js';
import { isCurrentSolLunaUsageModel, isCurrentUsageModel, isRetiredUsageModel } from '../shared/usageModelStatus.js';
import { MAX_USAGE_SKILLS, type UsageCallCount, type UsageRankedSession } from '../shared/usageDashboard.js';
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
export function groupUsageSummary(summary: UsageRangeSummary, modelLimit = MAX_USAGE_MODELS, toolLimit = MAX_USAGE_TOOLS, contributorLimit = MAX_USAGE_DAY_CONTRIBUTORS, buildLimit = toolLimit >= MAX_USAGE_TOOLS ? MAX_USAGE_TOOL_BUILDS_PER_DAY : toolLimit >= 4 ? 4 : 0, timelineLimit = contributorLimit <= 5
        ? Math.min(1, contributorLimit)
        : Math.min(MAX_USAGE_TIMELINE_EVENTS, Math.ceil(contributorLimit * 0.6)), sessionLimit = 45, skillLimit = MAX_USAGE_SKILLS): UsageRangeSummary {
    const boundedTimeline = (timeline: UsageSessionTimeline): UsageSessionTimeline => {
        if (timeline.state === 'unavailable') return { ...timeline, items: [] };
        const omitted = timeline.omitted + Math.max(0, timeline.items.length - timelineLimit);
        const items = timelineLimit > 0 ? timeline.items.slice(-timelineLimit) : [];
        return { state: omitted > 0 ? 'truncated' : items.length > 0 ? 'available' : 'unavailable', omitted, items };
    };
    const models = [...summary.models].sort((a, b) => tokenTotal(b.tokens) - tokenTotal(a.tokens) || a.id.localeCompare(b.id));
    const tools = [...summary.tools].sort((a, b) => b.requests - a.requests || a.id.localeCompare(b.id));
    const namedModels = models.filter(m => m.kind === 'named');
    const priorityModels = namedModels.filter(isCurrentUsageModel);
    const legacySolLunaModels = namedModels.filter(isCurrentSolLunaUsageModel);
    const historicalModels = modelLimit >= 4 ? namedModels.filter(isRetiredUsageModel) : [];
    const selectedModels = new Set([...new Map([...priorityModels, ...legacySolLunaModels, ...historicalModels, ...namedModels].map(model => [model.id, model])).values()].slice(0, modelLimit).map(model => model.id));
    const errorLeaders = tools.filter(t => t.kind === 'named' && t.errors > 0)
        .sort((a, b) => b.errors - a.errors || b.results - a.results || b.requests - a.requests || a.id.localeCompare(b.id));
    const selectedTools = new Set([...new Map([...errorLeaders, ...tools.filter(t => t.kind === 'named')].map(tool => [tool.id, tool])).values()].slice(0, toolLimit).map(t => t.id));
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
    const skillIds = new Set([...summary.skills].filter(item => item.kind === 'named')
        .sort((a, b) => b.requests - a.requests || a.id.localeCompare(b.id)).slice(0, skillLimit).map(item => item.id));
    const groupSkills = (items: UsageCallCount[]) => {
        const kept = items.filter(item => item.kind === 'unknown' || skillIds.has(item.id));
        const other = items.filter(item => !kept.includes(item)).reduce((sum, item) => sum + item.requests, 0);
        return [...kept, ...(other ? [{ id: 'other', kind: 'other' as const, label: 'Other', requests: other }] : [])];
    };
    const groupSession = (item: UsageRankedSession): UsageRankedSession => {
        const ordered = [...item.models].sort((a, b) => tokenTotal(b.tokens) - tokenTotal(a.tokens) || a.id.localeCompare(b.id));
        const chosen = new Set(ordered.filter(model => model.kind === 'named').slice(0, MAX_USAGE_CONTRIBUTOR_MODELS).map(model => model.id));
        const retained = ordered.filter(model => model.kind === 'unknown' || chosen.has(model.id));
        const omitted = ordered.filter(model => !retained.includes(model));
        const tokens = emptyTokens(), tokenCost = emptyCost();
        for (const model of omitted) {
            for (const key of Object.keys(tokens) as (keyof UsageTokens)[]) tokens[key] += model.tokens[key];
            addCost(tokenCost, model.tokenCost);
        }
        const omittedCount = item.modelDetail.omitted + omitted.filter(model => model.kind !== 'other').length;
        const named = [...item.tools].filter(tool => tool.kind === 'named').sort((a, b) => b.errors - a.errors || b.requests - a.requests || a.id.localeCompare(b.id)).slice(0, MAX_USAGE_TOOLS);
        const toolIds = new Set(named.map(tool => tool.id));
        const kept = item.tools.filter(tool => tool.kind === 'unknown' || toolIds.has(tool.id));
        const other = item.tools.filter(tool => !kept.includes(tool));
        return { ...item, models: [...retained, ...(omitted.length ? [{ id: 'other', kind: 'other' as const, label: 'Other', tokens, tokenCost }] : [])],
            modelDetail: { state: omittedCount ? 'grouped' : 'full', omitted: omittedCount },
            tools: [...kept, ...(other.length ? [{ id: 'other', kind: 'other' as const, label: 'Other', requests: other.reduce((sum, tool) => sum + tool.requests, 0), results: other.reduce((sum, tool) => sum + tool.results, 0), errors: other.reduce((sum, tool) => sum + tool.errors, 0) }] : [])] };
    };
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
            const ranked = [...tool.builds.items].sort((a, b) => b.errors - a.errors || b.requests - a.requests || a.firstObservedAt.localeCompare(b.firstObservedAt) || a.sha.localeCompare(b.sha));
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
        skills: groupSkills(summary.skills),
        rankedSessions: {
            medianTokens: summary.rankedSessions.medianTokens,
            top10Tokens: summary.rankedSessions.top10Tokens,
            state: summary.rankedSessions.omitted + Math.max(0, summary.rankedSessions.items.length - sessionLimit) ? 'truncated' : 'full',
            omitted: summary.rankedSessions.omitted + Math.max(0, summary.rankedSessions.items.length - sessionLimit),
            items: [...new Set([
                ...[...summary.rankedSessions.items].sort((a, b) => a.rank!.tokens - b.rank!.tokens).slice(0, Math.ceil(sessionLimit * 2 / 3)),
                ...[...summary.rankedSessions.items].sort((a, b) => a.rank!.errors - b.rank!.errors).slice(0, Math.floor(sessionLimit / 3)),
                ...summary.rankedSessions.items,
            ])].slice(0, sessionLimit).map(groupSession),
        },
        models: [...models.filter(keepModel), ...(omittedModels.length ? [{ id: 'other', kind: 'other' as const, label: 'Other', tokens: otherTokens, tokenCost: otherCost }] : [])].sort((a, b) => tokenTotal(b.tokens) - tokenTotal(a.tokens) || a.id.localeCompare(b.id)),
        tools: [...tools.filter(keepTool), ...(omittedTools.length ? [{ id: 'other', kind: 'other' as const, label: 'Other', requests: omittedTools.reduce((n, t) => n + t.requests, 0), results: omittedTools.reduce((n, t) => n + t.results, 0), errors: omittedTools.reduce((n, t) => n + t.errors, 0) }] : [])].sort((a, b) => b.requests - a.requests || a.id.localeCompare(b.id)),
        days: summary.days.map(day => {
            day = { ...day, skills: groupSkills(day.skills) };
            const kept = day.models.filter(m => keptModelIds.has(m.id));
            const other = day.models.filter(m => !keptModelIds.has(m.id)).reduce((n, m) => n + m.total, 0);
            const tools = groupDayTools(day.tools);
            if (day.contributors.state === 'unavailable') return { ...day, tools, models: [...kept, ...(other ? [{ id: 'other', total: other }] : [])] };
            const ranked = withDayRanks([...day.contributors.items]);
            const perMetric = Math.floor(contributorLimit / 3);
            const selected = new Set((['tokens', 'requests', 'errors'] as const).flatMap(metric =>
                [...ranked].sort((a, b) => a.rank![metric] - b.rank![metric]).slice(0, perMetric)));
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

/** Reserve ranked leaders across all ranges before exhausting other detail tiers. */
export function fitUsageDashboardSnapshot(snapshot: UsageDashboardSnapshot): UsageDashboardSnapshot {
    const raw = snapshot.ranges;
    const detailTiers = [
        { models: 8, tools: 10, contributors: 20, builds: 8, timeline: 12 },
        { models: 8, tools: 10, contributors: 10, builds: 4, timeline: 3 },
        { models: 8, tools: 10, contributors: 5, builds: 2, timeline: 1 },
    ] as const;
    type Tier = { models: number; tools: number; contributors: number; builds: number; timeline: number };
    const fit = (recent: Tier, all: Pick<Tier, 'models' | 'tools' | 'builds'>, skills = MAX_USAGE_SKILLS, sessionFloor = 5) => {
        const limit = recent.contributors >= 20 ? 45 : recent.contributors * 2;
        for (const sessions of [...new Set([Math.max(limit, sessionFloor), sessionFloor])]) {
            snapshot.ranges = {
                '7d': groupUsageSummary(raw['7d'], recent.models, recent.tools, recent.contributors, recent.builds, recent.timeline, sessions, skills),
                '30d': groupUsageSummary(raw['30d'], recent.models, recent.tools, recent.contributors, recent.builds, recent.timeline, sessions, skills),
                all: groupUsageSummary(raw.all, all.models, all.tools, 0, all.builds, 0, sessions, skills),
            };
            if (parseUsageCollectionResult({ type: 'usage', version: 1, snapshot })?.type === 'usage') return true;
        }
        return false;
    };
    for (const tier of detailTiers) if (fit(tier, tier)) return snapshot;
    // Spend optional contributor and build detail before named tool identities.
    for (const [recentBuilds, allBuilds] of [[1, 1], [1, 0], [0, 1], [0, 0]] as const) {
        const recent = { models: 8, tools: 10, contributors: 0, builds: recentBuilds, timeline: 0 };
        if (fit(recent, { models: 8, tools: 10, builds: allBuilds })) return snapshot;
    }
    const allTiers = [
        { models: 8, tools: 10, builds: 1 },
        { models: 8, tools: 10, builds: 0 },
        { models: 8, tools: 4, builds: 1 },
        { models: 8, tools: 4, builds: 0 },
        { models: 8, tools: 2, builds: 1 },
        { models: 8, tools: 2, builds: 0 },
        { models: 8, tools: 1, builds: 1 },
        { models: 8, tools: 1, builds: 0 },
        { models: 4, tools: 4, builds: 1 },
        { models: 4, tools: 2, builds: 1 },
        { models: 4, tools: 1, builds: 0 },
        { models: 0, tools: 4, builds: 1 },
        { models: 0, tools: 4, builds: 0 },
        { models: 0, tools: 3, builds: 0 },
        { models: 0, tools: 2, builds: 0 },
        { models: 0, tools: 1, builds: 0 },
        { models: 0, tools: 0, builds: 0 },
    ] as const;
    for (const builds of [2, 1]) for (const contributors of [5, 0]) {
        const recent = { models: 8, tools: 10, contributors, builds, timeline: contributors ? 1 : 0 };
        for (const all of allTiers.filter(tier => tier.models === 8 && tier.tools >= 4)) if (fit(recent, all)) return snapshot;
    }
    const allBuildTiers = [...allTiers.filter(tier => tier.builds === 1), ...allTiers.filter(tier => tier.builds === 0)];
    const allToolFloor = Math.max(2, Math.min(4, raw.all.tools.filter(tool => tool.kind === 'named' && tool.errors > 0).length));
    for (const tools of [10, 8, 6]) for (const builds of [2, 1]) for (const contributors of [5, 0]) {
        const recent = { models: 8, tools, contributors, builds, timeline: contributors ? 1 : 0 };
        for (const all of allBuildTiers.filter(tier => tier.tools >= allToolFloor)) if (fit(recent, all)) return snapshot;
    }
    for (const models of [8, 4]) {
        const recent = { models, tools: 4, contributors: 0, builds: 1, timeline: 0 };
        for (const all of allTiers.filter(tier => tier.tools >= 4)) if (fit(recent, all)) return snapshot;
    }
    // Pathological histories still fit through explicit, reconciled omissions.
    for (const models of [8, 4, 0]) for (const tools of [10, 4, 2, 1, 0]) {
        const recent = { models, tools, contributors: 0, builds: tools ? 1 : 0, timeline: 0 };
        for (const all of allTiers) if (fit(recent, all)) return snapshot;
    }
    for (const skills of [2, 0]) {
        const minimal = { models: 0, tools: 0, contributors: 0, builds: 0, timeline: 0 };
        if (fit(minimal, minimal, skills)) return snapshot;
    }
    // Only after five leaders per populated range cannot fit with minimal
    // detail may the common allowance shrink. Omitted counts still reconcile.
    const minimal = { models: 0, tools: 0, contributors: 0, builds: 0, timeline: 0 };
    for (const sessions of [3, 1, 0]) if (fit(minimal, minimal, 0, sessions)) return snapshot;
    throw new Error('Invalid usage summary');
}
