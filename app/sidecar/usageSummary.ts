import { MAX_USAGE_CONTRIBUTOR_MODELS, MAX_USAGE_DAY_CONTRIBUTORS, MAX_USAGE_MODELS, MAX_USAGE_TOOLS, type UsageTokens, type UsageCategory, type UsageRangeSummary, } from '../shared/usageDashboard.js';
export { usageCategory } from '../../src/utils/usageCategory.js';
export const tokenTotal = (t: UsageTokens): number => t.fresh + t.read + t.write + t.output;
export const emptyTokens = (): UsageTokens => ({ fresh: 0, read: 0, write: 0, output: 0 });
/** Group only after complete accounting. The same model selection applies to every day. */
export function groupUsageSummary(summary: UsageRangeSummary, modelLimit = MAX_USAGE_MODELS, toolLimit = MAX_USAGE_TOOLS, contributorLimit = MAX_USAGE_DAY_CONTRIBUTORS): UsageRangeSummary {
    const models = [...summary.models].sort((a, b) => tokenTotal(b.tokens) - tokenTotal(a.tokens) || a.id.localeCompare(b.id));
    const tools = [...summary.tools].sort((a, b) => b.requests - a.requests || a.id.localeCompare(b.id));
    const selectedModels = new Set(models.filter(m => m.kind === 'named').slice(0, modelLimit).map(m => m.id));
    const selectedTools = new Set(tools.filter(t => t.kind === 'named').slice(0, toolLimit).map(t => t.id));
    const keepModel = (m: UsageCategory) => m.kind === 'unknown' || selectedModels.has(m.id);
    const keepTool = (t: UsageCategory) => t.kind === 'unknown' || selectedTools.has(t.id);
    const omittedModels = models.filter(m => !keepModel(m));
    const omittedTools = tools.filter(t => !keepTool(t));
    const otherTokens = emptyTokens();
    for (const m of omittedModels)
        for (const key of Object.keys(otherTokens) as (keyof UsageTokens)[])
            otherTokens[key] += m.tokens[key];
    const keptModelIds = new Set(models.filter(keepModel).map(m => m.id));
    return {
        ...summary,
        models: [...models.filter(keepModel), ...(omittedModels.length ? [{ id: 'other', kind: 'other' as const, label: 'Other', tokens: otherTokens }] : [])].sort((a, b) => tokenTotal(b.tokens) - tokenTotal(a.tokens) || a.id.localeCompare(b.id)),
        tools: [...tools.filter(keepTool), ...(omittedTools.length ? [{ id: 'other', kind: 'other' as const, label: 'Other', requests: omittedTools.reduce((n, t) => n + t.requests, 0), results: omittedTools.reduce((n, t) => n + t.results, 0), errors: omittedTools.reduce((n, t) => n + t.errors, 0) }] : [])].sort((a, b) => b.requests - a.requests || a.id.localeCompare(b.id)),
        days: summary.days.map(day => {
            const kept = day.models.filter(m => keptModelIds.has(m.id));
            const other = day.models.filter(m => !keptModelIds.has(m.id)).reduce((n, m) => n + m.total, 0);
            if (day.contributors.state === 'unavailable') return { ...day, models: [...kept, ...(other ? [{ id: 'other', total: other }] : [])] };
            const ranked = [...day.contributors.items].sort((a, b) => tokenTotal(b.tokens) - tokenTotal(a.tokens) || b.requests - a.requests || b.errors - a.errors || a.id.localeCompare(b.id));
            const contributors = ranked.slice(0, contributorLimit).map(contributor => {
                const models = [...contributor.models].sort((a, b) => tokenTotal(b.tokens) - tokenTotal(a.tokens) || a.id.localeCompare(b.id));
                const named = models.filter(model => model.kind === 'named');
                const selected = new Set(named.slice(0, MAX_USAGE_CONTRIBUTOR_MODELS).map(model => model.id));
                const retained = models.filter(model => model.kind !== 'named' || selected.has(model.id));
                const omittedModels = models.filter(model => !retained.includes(model));
                const otherTokens = emptyTokens();
                for (const model of omittedModels) for (const key of Object.keys(otherTokens) as (keyof UsageTokens)[]) otherTokens[key] += model.tokens[key];
                const existingOther = retained.find(model => model.kind === 'other');
                const outputModels = retained.filter(model => model.kind !== 'other');
                if (existingOther) for (const key of Object.keys(otherTokens) as (keyof UsageTokens)[]) otherTokens[key] += existingOther.tokens[key];
                const omitted = contributor.modelDetail.omitted + omittedModels.length;
                return { ...contributor, models: [...outputModels, ...(omitted ? [{ id: 'other', kind: 'other' as const, label: 'Other', tokens: otherTokens }] : [])], modelDetail: { state: omitted ? 'grouped' as const : 'full' as const, omitted } };
            });
            const omitted = day.contributors.omitted + ranked.length - contributors.length;
            return { ...day, models: [...kept, ...(other ? [{ id: 'other', total: other }] : [])], contributors: { state: omitted ? 'truncated' as const : 'full' as const, omitted, items: contributors } };
        }),
        detail: { state: omittedModels.length || omittedTools.length ? (modelLimit || toolLimit ? 'grouped' : 'summary-only') : 'full', omittedModels: omittedModels.length, omittedTools: omittedTools.length },
    };
}
