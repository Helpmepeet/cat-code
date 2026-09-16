import type { UsageCollectionResult, UsageDashboardSnapshot, UsageDay, UsageModel, UsageRangeSummary, UsageTokens, UsageTool, } from './usageDashboard.js';
import { MAX_USAGE_ALL_BUCKETS, MAX_USAGE_CONTRIBUTOR_MODELS, MAX_USAGE_DAY_CONTRIBUTORS, MAX_USAGE_LABEL_BYTES, MAX_USAGE_MODELS, MAX_USAGE_RECORD_BYTES, MAX_USAGE_TOOLS, USAGE_DASHBOARD_VERSION, } from './usageDashboard.js';
const ERROR_CODES = new Set(['collection', 'timeout', 'resource-limit', 'invalid-output', 'unavailable']);
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const RESERVED = new Set(['unknown', 'other']);
const ownKeys = (v: object, keys: readonly string[]) => {
    const actual = Object.keys(v).sort();
    return actual.length === keys.length && actual.every((k, i) => k === [...keys].sort()[i]);
};
const obj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const safe = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const label = (v: unknown): v is string => typeof v === 'string' && new TextEncoder().encode(v).byteLength <= MAX_USAGE_LABEL_BYTES;
const id = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 64 && /^[a-zA-Z0-9_-]+$/.test(v);
function date(s: unknown): s is string {
    if (typeof s !== 'string' || !DAY.test(s))
        return false;
    const d = new Date(`${s}T00:00:00.000Z`);
    return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
function instant(s: unknown): s is string {
    if (typeof s !== 'string' || !INSTANT.test(s))
        return false;
    const d = new Date(s);
    return Number.isFinite(d.getTime()) && d.toISOString() === s;
}
function addDays(s: string, n: number): string {
    const d = new Date(`${s}T00:00:00.000Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
}
function tokens(v: unknown): v is UsageTokens {
    return obj(v) && ownKeys(v, ['fresh', 'read', 'write', 'output']) && safe(v.fresh) && safe(v.read) && safe(v.write) && safe(v.output) && sumsSafe(v.fresh, v.read, v.write, v.output);
}
const tokenSum = (v: UsageTokens) => v.fresh + v.read + v.write + v.output;
const sumsSafe = (...values: number[]) => values.every(Number.isSafeInteger) && values.reduce((n, v) => n + v, 0) <= Number.MAX_SAFE_INTEGER;
function category(v: unknown): v is {
    id: string;
    kind: 'named' | 'unknown' | 'other';
    label: string;
} {
    return obj(v) && id(v.id) && label(v.label) && (v.kind === 'named' || v.kind === 'unknown' || v.kind === 'other') && (v.kind === 'named' ? !RESERVED.has(v.id) : v.id === v.kind);
}
function uniqueCategories(items: unknown[], max: number): boolean {
    if (!Array.isArray(items) || items.length > max + 2)
        return false;
    const ids = new Set<string>();
    for (const item of items) {
        if (!category(item))
            return false;
        if (ids.has(item.id))
            return false;
        ids.add(item.id);
    }
    return items.filter(x => (x as {
        kind: string;
    }).kind === 'named').length <= max;
}
function model(v: unknown): v is UsageModel {
    return obj(v) && category(v) && ownKeys(v, ['id', 'kind', 'label', 'tokens']) && tokens((v as Record<string, unknown>).tokens);
}
function tool(v: unknown): v is UsageTool {
    return obj(v) && category(v) && ownKeys(v, ['id', 'kind', 'label', 'requests', 'results', 'errors']) && safe((v as Record<string, unknown>).requests) && safe((v as Record<string, unknown>).results) && safe((v as Record<string, unknown>).errors) && ((v as Record<string, unknown>).errors as number) <= ((v as Record<string, unknown>).results as number) && ((v as Record<string, unknown>).results as number) <= ((v as Record<string, unknown>).requests as number);
}
function contributor(v: unknown): boolean {
    if (!obj(v) || !ownKeys(v, ['id', 'engineSessionId', 'project', 'tokens', 'requests', 'results', 'errors', 'models', 'modelDetail']) || !id(v.id) || (v.engineSessionId !== null && (typeof v.engineSessionId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v.engineSessionId))) || !tokens(v.tokens) || !safe(v.requests) || !safe(v.results) || !safe(v.errors) || (v.errors as number) > (v.results as number) || (v.results as number) > (v.requests as number) || !Array.isArray(v.models) || !uniqueCategories(v.models, MAX_USAGE_CONTRIBUTOR_MODELS) || !v.models.every(model) || !obj(v.modelDetail) || !ownKeys(v.modelDetail, ['state', 'omitted']) || !['full', 'grouped'].includes(v.modelDetail.state as string) || !safe(v.modelDetail.omitted)) return false;
    if (v.project !== null && (!obj(v.project) || !ownKeys(v.project, ['id', 'label']) || !id(v.project.id) || !label(v.project.label))) return false;
    if ((v.modelDetail.state === 'full') !== (v.modelDetail.omitted === 0) || ((v.modelDetail.omitted as number) > 0) !== v.models.some(m => obj(m) && m.kind === 'other')) return false;
    const items = v.models as UsageModel[];
    return items.every((m) => tokenSum(m.tokens) <= tokenSum(v.tokens as UsageTokens)) && (['fresh', 'read', 'write', 'output'] as const).every(key => items.reduce((n, m) => n + m.tokens[key], 0) === (v.tokens as UsageTokens)[key]);
}
function day(v: unknown): v is UsageDay {
    if (!obj(v) || !ownKeys(v, ['date', 'hourlyRequests', ...(v.hourlyTokens === undefined ? [] : ['hourlyTokens']), 'results', 'errors', 'tokens', 'cacheWriteReporting', 'models', 'sessions', 'records', 'requests', 'contributors']) || !date(v.date) || !tokens(v.tokens) || !['reported', 'partial', 'unreported', 'unavailable'].includes(v.cacheWriteReporting as string) || !safe(v.sessions) || !safe(v.records) || !safe(v.requests) || !safe(v.results) || !safe(v.errors) || v.errors > v.results || v.results > v.requests || !Array.isArray(v.models) || v.models.length > MAX_USAGE_MODELS + 2 || !obj(v.contributors) || !ownKeys(v.contributors, ['state', 'omitted', 'items']) || !['full', 'truncated', 'unavailable'].includes(v.contributors.state as string) || !safe(v.contributors.omitted) || !Array.isArray(v.contributors.items) || v.contributors.items.length > MAX_USAGE_DAY_CONTRIBUTORS || !v.contributors.items.every(contributor))
        return false;
    if ((v.cacheWriteReporting === 'unreported' || v.cacheWriteReporting === 'unavailable') && (v.tokens as UsageTokens).write !== 0)
        return false;
    if (!Array.isArray(v.hourlyRequests) || v.hourlyRequests.length !== 24 || !v.hourlyRequests.every(safe) || !sumsSafe(...v.hourlyRequests) || v.hourlyRequests.reduce((n, x) => n + x, 0) !== v.requests) return false;
    if (v.hourlyTokens !== undefined && (!Array.isArray(v.hourlyTokens) || v.hourlyTokens.length !== 24 || !v.hourlyTokens.every(safe) || !sumsSafe(...v.hourlyTokens) || v.hourlyTokens.reduce((n, x) => n + x, 0) !== tokenSum(v.tokens))) return false;
    const contributorIds = new Set<string>();
    const contributors = v.contributors.items as Record<string, unknown>[];
    const contributorTokenBuckets = (['fresh', 'read', 'write', 'output'] as const).map(key => contributors.reduce((n, c) => n + (c.tokens as UsageTokens)[key], 0));
    const dayTokenBuckets = (['fresh', 'read', 'write', 'output'] as const).map(key => (v.tokens as UsageTokens)[key]);
    const contributorRequests = contributors.reduce((n, c) => n + (c.requests as number), 0);
    for (const key of ['results', 'errors'] as const) {
        const count = contributors.reduce((n, c) => n + (c[key] as number), 0);
        if (count > (v[key] as number) || v.contributors.state === 'full' && count !== v[key]) return false;
    }
    if (contributors.some(c => contributorIds.has(c.id as string) || !contributorIds.add(c.id as string)) || v.contributors.state === 'full' && v.contributors.omitted !== 0 || v.contributors.state === 'truncated' && v.contributors.omitted === 0 || v.contributors.state === 'unavailable' && (v.contributors.items.length !== 0 || v.contributors.omitted !== 0) || contributorTokenBuckets.some((value, index) => value > dayTokenBuckets[index]!) || contributorRequests > (v.requests as number) || v.contributors.state === 'full' && (contributorTokenBuckets.some((value, index) => value !== dayTokenBuckets[index]) || contributorRequests !== v.requests)) return false;
    const ids = new Set<string>();
    const models = v.models;
    return models.every(m => obj(m) && ownKeys(m, ['id', 'total']) && id(m.id) && !ids.has(m.id) && ids.add(m.id) && safe(m.total)) && sumsSafe(...models.map(m => (m as {
        total: number;
    }).total)) && models.reduce((n, m) => n + (m as {
        total: number;
    }).total, 0) === tokenSum(v.tokens);
}
function range(v: unknown, asOf: string): v is UsageRangeSummary {
    if (!obj(v) || !ownKeys(v, ['range', ...(v.bucketDays === undefined ? [] : ['bucketDays']), 'startInclusive', 'endExclusive', 'tokens', 'sessions', 'records', 'requests', 'identifiedRequests', 'fallbackRequests', 'activeDays', 'cachedInputShare', 'cacheWriteReporting', 'days', 'models', 'tools', 'detail']) || (v.range !== '7d' && v.range !== '30d' && v.range !== 'all') || !instant(v.startInclusive) || !instant(v.endExclusive) || !(v.startInclusive as string).endsWith('T00:00:00.000Z') || !(v.endExclusive as string).endsWith('T00:00:00.000Z') || !tokens(v.tokens) || !['reported', 'partial', 'unreported', 'unavailable'].includes(v.cacheWriteReporting as string) || !safe(v.sessions) || !safe(v.records) || !safe(v.requests) || !safe(v.identifiedRequests) || !safe(v.fallbackRequests) || !safe(v.activeDays) || !Array.isArray(v.days) || !Array.isArray(v.models) || !Array.isArray(v.tools) || !obj(v.detail) || !ownKeys(v.detail, ['state', 'omittedModels', 'omittedTools']) || !['full', 'grouped', 'summary-only'].includes(v.detail.state as string) || !safe(v.detail.omittedModels) || !safe(v.detail.omittedTools))
        return false;
    const all = v.range === 'all';
    const n = v.range === '7d' ? 7 : 30;
    const bucketDays = v.bucketDays ?? 1;
    if (!safe(bucketDays) || bucketDays < 1 || (!all && v.bucketDays !== undefined)) return false;
    const start = all ? v.startInclusive : `${addDays(asOf.slice(0, 10), -(n - 1))}T00:00:00.000Z`;
    const end = `${addDays(asOf.slice(0, 10), 1)}T00:00:00.000Z`;
    if (v.startInclusive !== start || v.endExclusive !== end || start >= end || bucketDays > Math.ceil((Date.parse(end) - Date.parse(start)) / 86400000) || (all ? v.days.length > MAX_USAGE_ALL_BUCKETS : v.days.length !== n) || !uniqueCategories(v.models, MAX_USAGE_MODELS) || !uniqueCategories(v.tools, MAX_USAGE_TOOLS) || !v.models.every(model) || !v.tools.every(tool) || !v.days.every(day))
        return false;
    for (let i = 0; i < v.days.length; i++) {
        const d = v.days[i] as UsageDay;
        if ((v.range === '7d') !== (d.hourlyTokens !== undefined)) return false;
        if (!all && d.date !== addDays(v.startInclusive.slice(0, 10), i)) return false;
        if (all && (d.date < start.slice(0, 10) || d.date >= end.slice(0, 10) || i > 0 && d.date <= (v.days[i - 1] as UsageDay).date || (Date.parse(`${d.date}T00:00:00.000Z`) - Date.parse(start)) / 86400000 % bucketDays !== 0 || d.contributors.state !== 'unavailable')) return false;
    }
    if (all && (v.days.length === 0 ? start !== `${asOf.slice(0, 10)}T00:00:00.000Z` : (v.days[0] as UsageDay).date !== start.slice(0, 10))) return false;
    const days = v.days as UsageDay[];
    const sum = (key: keyof UsageTokens): number => days.reduce((n: number, d: UsageDay) => n + d.tokens[key], 0);
    if (v.tokens.fresh !== sum('fresh') || v.tokens.read !== sum('read') || v.tokens.write !== sum('write') || v.tokens.output !== sum('output'))
        return false;
    if ((v.cacheWriteReporting === 'unreported' || v.cacheWriteReporting === 'unavailable') && v.tokens.write !== 0)
        return false;
    const dayStates = new Set(days.map(d => d.cacheWriteReporting).filter(s => s !== 'unavailable'));
    const reporting = dayStates.size === 0 ? 'unavailable'
        : dayStates.has('partial') || dayStates.size > 1 ? 'partial'
            : dayStates.has('reported') ? 'reported' : 'unreported';
    if (v.cacheWriteReporting !== reporting)
        return false;
    if (bucketDays === 1 && days.some(d => d.date === asOf.slice(0, 10) && d.hourlyRequests.some((count, hour) => hour > Number(asOf.slice(11, 13)) && count !== 0))) return false;
    if (days.some(d => d.date === asOf.slice(0, 10) && d.hourlyTokens?.some((count, hour) => hour > Number(asOf.slice(11, 13)) && count !== 0))) return false;
    for (const key of ['results', 'errors'] as const) {
        if (days.reduce((n, d) => n + d[key], 0) !== v.tools.reduce((n, t) => n + t[key], 0)) return false;
    }
    const dailyRecords = days.reduce((n, d) => n + d.records, 0);
    const dailySessions = days.reduce((n, d) => n + d.sessions, 0);
    if (v.requests !== v.identifiedRequests + v.fallbackRequests || v.requests !== days.reduce((n, d) => n + d.requests, 0) || v.records !== dailyRecords || v.sessions > v.records || v.sessions > dailySessions || v.sessions < Math.max(...days.map(d => d.sessions), 0) || days.some(d => d.sessions > d.records) || (bucketDays === 1 ? v.activeDays !== days.filter((d: UsageDay) => tokenSum(d.tokens) > 0 || d.requests > 0 || d.records > 0 || d.sessions > 0).length : v.activeDays < days.filter(d => tokenSum(d.tokens) > 0 || d.requests > 0 || d.records > 0 || d.sessions > 0).length || v.activeDays > Math.ceil((Date.parse(end) - Date.parse(start)) / 86400000)))
        return false;
    const modelTotals = v.models.map(m => tokenSum(m.tokens));
    const toolTotals = v.tools.map(t => t.requests);
    if (!sumsSafe(...modelTotals) || !sumsSafe(...toolTotals) || modelTotals.reduce((n, x) => n + x, 0) !== tokenSum(v.tokens) || toolTotals.reduce((n, x) => n + x, 0) !== v.requests)
        return false;
    for (const key of ['fresh', 'read', 'write', 'output'] as const)
        if (v.models.reduce((n, m) => n + m.tokens[key], 0) !== v.tokens[key])
            return false;
    if ((v.detail.state === 'full') !== (v.detail.omittedModels === 0 && v.detail.omittedTools === 0))
        return false;
    if (v.detail.omittedModels > 0 !== v.models.some(m => m.kind === 'other') || v.detail.omittedTools > 0 !== v.tools.some(t => t.kind === 'other'))
        return false;
    const prompt = v.tokens.fresh + v.tokens.read + v.tokens.write;
    if (v.cachedInputShare === null ? prompt !== 0 : !finite(v.cachedInputShare) || prompt === 0 || Math.abs(v.cachedInputShare - v.tokens.read / prompt * 100) > 1e-9)
        return false;
    const dailyTotals = new Map<string, number>();
    for (const d of days)
        for (const m of d.models)
            dailyTotals.set(m.id, (dailyTotals.get(m.id) ?? 0) + m.total);
    if (!sumsSafe(...dailyTotals.values()) || dailyTotals.size !== v.models.length || v.models.some(m => dailyTotals.get(m.id) !== tokenSum(m.tokens)))
        return false;
    return true;
}
function snapshot(v: unknown): v is UsageDashboardSnapshot {
    if (!obj(v) || !ownKeys(v, ['version', 'metricVersion', 'countingVersion', 'snapshotId', 'scope', 'timezone', 'asOf', 'computedAt', 'coverage', 'ranges']) || v.version !== 1 || v.metricVersion !== 1 || v.countingVersion !== 4 || !id(v.snapshotId) || v.scope !== 'retained-transcripts' || v.timezone !== 'UTC' || !instant(v.asOf) || !instant(v.computedAt) || new Date(v.computedAt).getTime() < new Date(v.asOf).getTime() || !obj(v.coverage) || !obj(v.ranges) || !ownKeys(v.ranges, ['7d', '30d', 'all']))
        return false;
    const c = v.coverage as Record<string, unknown>;
    const coverageKeys = ['state', 'sourcesDiscovered', 'sourcesRead', 'parseErrors', 'oversizedRecords', 'pendingTailBytes', 'shortReads', 'changedSources', 'readErrors', 'invalidTimestamps', 'invalidUsage', 'identityConflicts'];
    if (!ownKeys(c, coverageKeys) || (c.state !== 'complete' && c.state !== 'partial') || !coverageKeys.slice(1).every(k => safe(c[k])) || (c.sourcesRead as number) > (c.sourcesDiscovered as number))
        return false;
    const losses = ['parseErrors', 'oversizedRecords', 'pendingTailBytes', 'shortReads', 'changedSources', 'readErrors', 'invalidTimestamps', 'invalidUsage'];
    if (c.state === 'complete' && ((c.sourcesRead as number) !== (c.sourcesDiscovered as number) || losses.some(k => c[k] !== 0)))
        return false;
    const ranges = v.ranges as Record<string, unknown>;
    return range(ranges.all, v.asOf) && (ranges.all as UsageRangeSummary).range === 'all' && range(ranges['7d'], v.asOf) && range(ranges['30d'], v.asOf) && (ranges['7d'] as UsageRangeSummary).range === '7d' && (ranges['30d'] as UsageRangeSummary).range === '30d';
}
function parseUsageCollectionValue(value: unknown): UsageCollectionResult | null {
    if (!obj(value) || value.version !== USAGE_DASHBOARD_VERSION || typeof value.type !== 'string')
        return null;
    if (value.type === 'error')
        return ownKeys(value, ['type', 'version', 'code']) && typeof value.code === 'string' && ERROR_CODES.has(value.code) ? value as UsageCollectionResult : null;
    if (value.type === 'usage' && ownKeys(value, ['type', 'version', 'snapshot']) && snapshot(value.snapshot)) {
        const encoded = new TextEncoder().encode(JSON.stringify(value)).byteLength;
        return encoded <= MAX_USAGE_RECORD_BYTES ? value as UsageCollectionResult : null;
    }
    return null;
}
export function parseUsageCollectionLine(line: string): UsageCollectionResult | null {
    if (typeof line !== 'string' || new TextEncoder().encode(line).byteLength > MAX_USAGE_RECORD_BYTES)
        return null;
    try {
        return parseUsageCollectionResult(JSON.parse(line));
    }
    catch {
        return null;
    }
}
export function parseUsageCollectionResult(value: unknown): UsageCollectionResult | null {
    try {
        return parseUsageCollectionValue(value);
    }
    catch {
        return null;
    }
}
