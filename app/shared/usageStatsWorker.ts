import type { UsageCollectionResult, UsageDashboardSnapshot, UsageDay, UsageModel, UsagePreviousPeriod, UsageRangeSummary, UsageTokens, UsageTool, } from './usageDashboard.js';
import { MAX_USAGE_ALL_BUCKETS, MAX_USAGE_CONTRIBUTOR_MODELS, MAX_USAGE_DAY_CONTRIBUTORS, MAX_USAGE_LABEL_BYTES, MAX_USAGE_MODELS, MAX_USAGE_RECORD_BYTES, MAX_USAGE_TIMELINE_EVENTS, MAX_USAGE_TOOLS, MAX_USAGE_TOOL_BUILDS_PER_DAY, USAGE_DASHBOARD_VERSION, USAGE_PRICING_VERSION, type UsageDayTool, } from './usageDashboard.js';
const ERROR_CODES = new Set(['collection', 'timeout', 'resource-limit', 'invalid-output', 'unavailable']);
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const RESERVED = new Set(['unknown', 'other']);
const AUTO_OUTCOMES = ['allowed', 'policy_blocked', 'review_required', 'operational_error', 'cancelled', 'unknown_outcome', 'incomplete'];
const AUTO_ROUTES = ['base', 'forced', 'guard', 'accept_edits', 'allowlist', 'stage1', 'stage2', 'unknown'];
const ownKeys = (v: object, keys: readonly string[]) => {
    const actual = Object.keys(v).sort();
    return actual.length === keys.length && actual.every((k, i) => k === [...keys].sort()[i]);
};
const obj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const safe = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const positive = (v: unknown): v is number => safe(v) && v > 0;
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
function dateAt(timestamp: number, timezone: string): string {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: timezone, era: 'short', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(timestamp).map(part => [part.type, part.value]));
    const year = Number(p.year) + (p.era === 'BC' ? -1 : 0);
    return `${String(year).padStart(4, '0')}-${p.month}-${p.day}`;
}
function localMidnightAt(dateValue: string, timezone: string): number {
    const [year, month, day] = dateValue.split('-').map(Number);
    const base = new Date(0);
    base.setUTCHours(0, 0, 0, 0);
    base.setUTCFullYear(year!, month! - 1, day!);
    const desired = base.getTime();
    let guess = desired;
    const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, era: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    for (let i = 0; i < 6; i++) {
        const p = Object.fromEntries(formatter.formatToParts(guess).map(part => [part.type, part.value]));
        const representedDate = new Date(0);
        representedDate.setUTCHours(Number(p.hour), Number(p.minute), Number(p.second), 0);
        representedDate.setUTCFullYear(Number(p.year) + (p.era === 'BC' ? -1 : 0), Number(p.month) - 1, Number(p.day));
        const represented = representedDate.getTime();
        const next = guess + desired - represented;
        if (next === guess) break;
        guess = next;
    }
    const parts = Object.fromEntries(formatter.formatToParts(guess).map(part => [part.type, part.value]));
    if (dateAt(guess, timezone) === dateValue && parts.hour === '00' && parts.minute === '00') return guess;
    let low = desired - 36 * 3600000, high = desired + 36 * 3600000;
    while (low < high) {
        const middle = low + Math.floor((high - low) / 2);
        if (dateAt(middle, timezone) < dateValue) low = middle + 1;
        else high = middle;
    }
    if (dateAt(low, timezone) === dateValue) return low;
    throw new Error('Local date does not exist');
}
function zonedHour(timestamp: number, timezone: string): { hour: number; offsetMinutes: number } {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: timezone, hour: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset' }).formatToParts(timestamp).map(part => [part.type, part.value]));
    const offset = /^GMT([+-])(\d{2}):(\d{2})$/.exec(p.timeZoneName ?? 'GMT+00:00');
    const minutes = offset ? Number(offset[2]) * 60 + Number(offset[3]) : 0;
    return { hour: Number(p.hour), offsetMinutes: offset?.[1] === '-' ? -minutes : minutes };
}
function validTimezone(value: unknown): value is string {
    if (typeof value !== 'string' || value.length < 1 || value.length > 100) return false;
    try { new Intl.DateTimeFormat('en-US', { timeZone: value }); return true; } catch { return false; }
}
function autoCounts(value: unknown): boolean {
    return obj(value) && ownKeys(value, AUTO_OUTCOMES) && AUTO_OUTCOMES.every(key => safe(value[key]));
}
function autoPopulation(value: unknown): boolean {
    return obj(value) && ownKeys(value, ['outcomes', 'coverage']) && autoCounts(value.outcomes) &&
        obj(value.coverage) && ownKeys(value.coverage, ['state', 'invalidRecords', 'orphanRecords']) &&
        ['complete', 'partial', 'unavailable'].includes(value.coverage.state as string) &&
        safe(value.coverage.invalidRecords) && safe(value.coverage.orphanRecords);
}
function autoMode(
    value: unknown,
    startDate: string,
    endDateExclusive: string,
    maxBuckets: number,
    bucketDays: number,
): boolean {
    if (!obj(value) || !ownKeys(value, ['allTools', 'commands', 'buckets', 'routes', 'categories']) || !autoPopulation(value.allTools) || !autoPopulation(value.commands) || !Array.isArray(value.buckets) || !Array.isArray(value.routes) || !Array.isArray(value.categories) || value.buckets.length > maxBuckets || value.routes.length > AUTO_ROUTES.length * AUTO_OUTCOMES.length || value.categories.length > 10) return false;
    const allPopulation = value.allTools as Record<string, unknown>, commandPopulation = value.commands as Record<string, unknown>;
    const all = allPopulation.outcomes as Record<string, number>, commands = commandPopulation.outcomes as Record<string, number>;
    if (AUTO_OUTCOMES.some(key => commands[key]! > all[key]!)) return false;
    const bucketCounts = Object.fromEntries(AUTO_OUTCOMES.map(key => [key, 0])) as Record<string, number>;
    const bucketCommandCounts = Object.fromEntries(AUTO_OUTCOMES.map(key => [key, 0])) as Record<string, number>;
    const dates = new Set<string>();
    for (const bucket of value.buckets) {
        if (!obj(bucket) || !ownKeys(bucket, ['date', 'allTools', 'commands']) || !date(bucket.date) || bucket.date < startDate || bucket.date >= endDateExclusive || (Date.parse(`${bucket.date}T00:00:00.000Z`) - Date.parse(`${startDate}T00:00:00.000Z`)) / 86400000 % bucketDays !== 0 || dates.has(bucket.date) || !autoPopulation(bucket.allTools) || !autoPopulation(bucket.commands)) return false;
        dates.add(bucket.date);
        const bucketAll = bucket.allTools as Record<string, unknown>, bucketCommands = bucket.commands as Record<string, unknown>;
        const outcomes = bucketAll.outcomes as Record<string, number>, commandOutcomes = bucketCommands.outcomes as Record<string, number>;
        if (AUTO_OUTCOMES.some(key => commandOutcomes[key]! > outcomes[key]!)) return false;
        for (const key of AUTO_OUTCOMES) {
            bucketCounts[key]! += outcomes[key]!;
            bucketCommandCounts[key]! += commandOutcomes[key]!;
        }
    }
    if (AUTO_OUTCOMES.some(key => bucketCounts[key]! !== all[key]! || bucketCommandCounts[key]! !== commands[key]!)) return false;
    const routeCounts = Object.fromEntries(AUTO_OUTCOMES.map(key => [key, 0])) as Record<string, number>;
    for (const route of value.routes) {
        if (!obj(route) || !ownKeys(route, ['route', 'outcome', 'count']) || !AUTO_ROUTES.includes(route.route as string) || !AUTO_OUTCOMES.includes(route.outcome as string) || !positive(route.count)) return false;
        if (['forced', 'accept_edits', 'allowlist'].includes(route.route as string) && route.outcome === 'policy_blocked') return false;
        routeCounts[route.outcome as string]! += route.count as number;
    }
    if (AUTO_OUTCOMES.some(key => routeCounts[key]! !== all[key]!)) return false;
    let categories = 0;
    const categoryKeys = new Set<string>();
    for (const category of value.categories) {
        if (!obj(category) || !ownKeys(category, ['key', 'kind', 'label', 'count']) || typeof category.key !== 'string' || new TextEncoder().encode(category.key).byteLength > MAX_USAGE_LABEL_BYTES || categoryKeys.has(category.key) || !label(category.label) || !['named', 'other', 'uncategorized'].includes(category.kind as string) || !positive(category.count)) return false;
        categoryKeys.add(category.key);
        categories += category.count as number;
    }
    return categories === all.policy_blocked;
}
function tokens(v: unknown): v is UsageTokens {
    return obj(v) && ownKeys(v, ['fresh', 'read', 'write', 'output']) && safe(v.fresh) && safe(v.read) && safe(v.write) && safe(v.output) && sumsSafe(v.fresh, v.read, v.write, v.output);
}
const tokenSum = (v: UsageTokens) => v.fresh + v.read + v.write + v.output;
function tokenCost(v: unknown, totalTokens: number): boolean {
    return obj(v) && ownKeys(v, ['usd', 'pricedTokens']) && finite(v.usd) && (v.usd as number) >= 0 && safe(v.pricedTokens) && (v.pricedTokens as number) <= totalTokens && ((v.pricedTokens as number) > 0 || v.usd === 0);
}
const close = (a: number, b: number) => Math.abs(a - b) <= Math.max(1e-12, Math.abs(a) * 1e-12, Math.abs(b) * 1e-12);
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
    if (!obj(v) || !category(v)) return false;
    const value = v as Record<string, unknown>;
    return ownKeys(value, ['id', 'kind', 'label', 'tokens', 'tokenCost']) && tokens(value.tokens) && tokenCost(value.tokenCost, tokenSum(value.tokens as UsageTokens));
}
function tool(v: unknown): v is UsageTool {
    return obj(v) && category(v) && ownKeys(v, ['id', 'kind', 'label', 'requests', 'results', 'errors']) && safe((v as Record<string, unknown>).requests) && safe((v as Record<string, unknown>).results) && safe((v as Record<string, unknown>).errors) && ((v as Record<string, unknown>).errors as number) <= ((v as Record<string, unknown>).results as number) && ((v as Record<string, unknown>).results as number) <= ((v as Record<string, unknown>).requests as number);
}
function dayTool(v: unknown): v is UsageDayTool {
    if (!obj(v) || !ownKeys(v, ['id', 'requests', 'results', 'errors', ...(v.builds === undefined ? [] : ['builds'])]) || !id(v.id) || !safe(v.requests) || !safe(v.results) || !safe(v.errors) || v.errors > v.results || v.results > v.requests) return false;
    if (v.builds === undefined) return true;
    if (!obj(v.builds) || !ownKeys(v.builds, ['items', ...(v.builds.omitted === undefined ? [] : ['omitted'])]) || !Array.isArray(v.builds.items) || v.builds.items.length > MAX_USAGE_TOOL_BUILDS_PER_DAY || v.builds.items.length === 0 && v.builds.omitted === undefined) return false;
    if (v.builds.omitted !== undefined && (!obj(v.builds.omitted) || !ownKeys(v.builds.omitted, ['count', 'requests', 'results', 'errors']) || !positive(v.builds.omitted.count) || !positive(v.builds.omitted.requests) || !safe(v.builds.omitted.results) || !safe(v.builds.omitted.errors) || v.builds.omitted.errors > v.builds.omitted.results || v.builds.omitted.results > v.builds.omitted.requests)) return false;
    const seen = new Set<string>();
    let attributedRequests = 0, attributedResults = 0, attributedErrors = 0;
    for (const item of v.builds.items) {
        if (!obj(item) || !ownKeys(item, ['sha', 'dirty', 'requests', 'results', 'errors', 'firstObservedAt']) || typeof item.sha !== 'string' || !/^[0-9a-f]{7,40}$/.test(item.sha) || typeof item.dirty !== 'boolean' || !positive(item.requests) || !safe(item.results) || !safe(item.errors) || item.errors > item.results || item.results > item.requests || !instant(item.firstObservedAt)) return false;
        const key = `${item.sha}:${item.dirty}`;
        if (seen.has(key)) return false;
        seen.add(key);
        attributedRequests += item.requests;
        attributedResults += item.results;
        attributedErrors += item.errors;
        if (!safe(attributedRequests) || !safe(attributedResults) || !safe(attributedErrors)) return false;
    }
    const omitted = (v.builds.omitted ?? { requests: 0, results: 0, errors: 0 }) as { requests: number; results: number; errors: number };
    if (!sumsSafe(attributedRequests, omitted.requests) || !sumsSafe(attributedResults, omitted.results) || !sumsSafe(attributedErrors, omitted.errors)) return false;
    const unknownRequests = v.requests - attributedRequests - omitted.requests;
    const unknownResults = v.results - attributedResults - omitted.results;
    const unknownErrors = v.errors - attributedErrors - omitted.errors;
    return safe(unknownRequests) && safe(unknownResults) && safe(unknownErrors) && unknownErrors <= unknownResults && unknownResults <= unknownRequests;
}
function durationSummary(v: unknown): boolean {
    return obj(v) && ownKeys(v, ['samples', 'p50Ms', 'p95Ms']) && safe(v.samples) && (v.samples === 0
        ? v.p50Ms === null && v.p95Ms === null
        : safe(v.p50Ms) && safe(v.p95Ms) && v.p50Ms <= v.p95Ms);
}
function outcomes(v: unknown): boolean {
    return obj(v) && ownKeys(v, ['started', 'succeeded', 'failed', 'cancelled', 'incomplete']) && ['started', 'succeeded', 'failed', 'cancelled', 'incomplete'].every(key => safe(v[key])) && v.started === (v.succeeded as number) + (v.failed as number) + (v.cancelled as number) + (v.incomplete as number);
}
function timing(v: unknown): boolean {
    if (!obj(v) || !ownKeys(v, ['models', 'tools']) || !obj(v.models) || !obj(v.tools)) return false;
    if (!ownKeys(v.models, ['state', 'logicalCalls', 'retriedCalls', 'streamingAttempts', 'outcomes', 'responseDuration', 'firstText']) || !['available', 'unavailable'].includes(v.models.state as string) || !safe(v.models.logicalCalls) || !safe(v.models.retriedCalls) || !safe(v.models.streamingAttempts) || !outcomes(v.models.outcomes) || !durationSummary(v.models.responseDuration) || !durationSummary(v.models.firstText)) return false;
    const modelOutcomes = v.models.outcomes as Record<string, number>;
    const response = v.models.responseDuration as Record<string, number>;
    const firstText = v.models.firstText as Record<string, number>;
    if ((v.models.state === 'available') !== (modelOutcomes.started > 0) || (modelOutcomes.started === 0) !== (v.models.logicalCalls === 0) || !sumsSafe(v.models.logicalCalls as number, v.models.retriedCalls as number) || modelOutcomes.started < (v.models.logicalCalls as number) + (v.models.retriedCalls as number) || v.models.retriedCalls > v.models.logicalCalls || v.models.streamingAttempts > modelOutcomes.started || response.samples !== modelOutcomes.succeeded || firstText.samples > v.models.streamingAttempts) return false;
    if (!ownKeys(v.tools, ['state', 'outcomes', 'duration']) || !['available', 'unavailable'].includes(v.tools.state as string) || !outcomes(v.tools.outcomes) || !durationSummary(v.tools.duration)) return false;
    const toolOutcomes = v.tools.outcomes as Record<string, number>;
    const toolDuration = v.tools.duration as Record<string, number>;
    return (v.tools.state === 'available') === (toolOutcomes.started > 0) && toolDuration.samples === toolOutcomes.succeeded;
}
function timeline(v: unknown): boolean {
    if (!obj(v) || !ownKeys(v, ['state', 'omitted', 'items']) || !['available', 'truncated', 'unavailable'].includes(v.state as string) || !safe(v.omitted) || !Array.isArray(v.items) || v.items.length > MAX_USAGE_TIMELINE_EVENTS) return false;
    if (v.state === 'unavailable' ? v.omitted !== 0 || v.items.length !== 0 : v.state === 'available' ? v.omitted !== 0 || v.items.length === 0 : v.omitted === 0) return false;
    const ids = new Set<string>();
    let previous = '';
    for (const item of v.items) {
        if (!obj(item) || !id(item.id) || ids.has(item.id) || !ids.add(item.id) || !instant(item.startedAt) || !['succeeded', 'failed', 'cancelled', 'incomplete'].includes(item.outcome as string) || (item.outcome === 'incomplete' ? item.durationMs !== null : !safe(item.durationMs))) return false;
        const order = `${item.startedAt}:${item.id}`;
        if (order < previous) return false;
        previous = order;
        if (item.kind === 'model') {
            if (!ownKeys(item, ['id', 'kind', 'callId', 'startedAt', 'label', 'provider', 'mode', 'attempt', 'outcome', 'durationMs', 'firstTextMs']) || !id(item.callId) || !label(item.label) || !['firstParty', 'bedrock', 'vertex', 'foundry', 'openai'].includes(item.provider as string) || !['streaming', 'non_streaming'].includes(item.mode as string) || !positive(item.attempt) || (item.firstTextMs !== null && !safe(item.firstTextMs)) || item.mode === 'non_streaming' && item.firstTextMs !== null || item.durationMs !== null && item.firstTextMs !== null && (item.firstTextMs as number) > (item.durationMs as number)) return false;
        }
        else if (item.kind === 'tool') {
            if (!ownKeys(item, ['id', 'kind', 'startedAt', 'label', 'outcome', 'durationMs']) || !label(item.label)) return false;
        }
        else return false;
    }
    return true;
}
function contributor(v: unknown): boolean {
    if (!obj(v) || !ownKeys(v, ['id', 'engineSessionId', 'project', 'tokens', 'requests', 'results', 'errors', 'rank', 'tokenCost', 'models', 'modelDetail', 'timeline']) || !id(v.id) || (v.engineSessionId !== null && (typeof v.engineSessionId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v.engineSessionId))) || !tokens(v.tokens) || !safe(v.requests) || !safe(v.results) || !safe(v.errors) || (v.errors as number) > (v.results as number) || (v.results as number) > (v.requests as number) || !obj(v.rank) || !ownKeys(v.rank, ['tokens', 'requests', 'errors']) || !positive(v.rank.tokens) || !positive(v.rank.requests) || !positive(v.rank.errors) || !tokenCost(v.tokenCost, tokenSum(v.tokens as UsageTokens)) || !Array.isArray(v.models) || !uniqueCategories(v.models, MAX_USAGE_CONTRIBUTOR_MODELS) || !v.models.every(model) || !obj(v.modelDetail) || !ownKeys(v.modelDetail, ['state', 'omitted']) || !['full', 'grouped'].includes(v.modelDetail.state as string) || !safe(v.modelDetail.omitted) || !timeline(v.timeline)) return false;
    if (v.project !== null && (!obj(v.project) || !ownKeys(v.project, ['id', 'label']) || !id(v.project.id) || !label(v.project.label))) return false;
    if ((v.modelDetail.state === 'full') !== (v.modelDetail.omitted === 0) || ((v.modelDetail.omitted as number) > 0) !== v.models.some(m => obj(m) && m.kind === 'other')) return false;
    const items = v.models as UsageModel[];
    const contributorCost = v.tokenCost as { usd: number; pricedTokens: number };
    return items.every((m) => tokenSum(m.tokens) <= tokenSum(v.tokens as UsageTokens)) && (['fresh', 'read', 'write', 'output'] as const).every(key => items.reduce((n, m) => n + m.tokens[key], 0) === (v.tokens as UsageTokens)[key]) && items.reduce((n, m) => n + m.tokenCost!.pricedTokens, 0) === contributorCost.pricedTokens && close(items.reduce((n, m) => n + m.tokenCost!.usd, 0), contributorCost.usd);
}
function day(v: unknown): v is UsageDay {
    if (!obj(v) || !ownKeys(v, ['date', ...(v.hours === undefined ? [] : ['hours']), 'results', 'errors', 'tools', 'tokens', 'cacheWriteReporting', 'models', 'sessions', 'records', 'requests', 'contributors']) || !date(v.date) || !tokens(v.tokens) || !['reported', 'partial', 'unreported', 'unavailable'].includes(v.cacheWriteReporting as string) || !safe(v.sessions) || !safe(v.records) || !safe(v.requests) || !safe(v.results) || !safe(v.errors) || v.errors > v.results || v.results > v.requests || !Array.isArray(v.tools) || v.tools.length > MAX_USAGE_TOOLS + 2 || !v.tools.every(dayTool) || !Array.isArray(v.models) || v.models.length > MAX_USAGE_MODELS + 2 || !obj(v.contributors) || !ownKeys(v.contributors, ['state', 'omitted', 'items']) || !['full', 'truncated', 'unavailable'].includes(v.contributors.state as string) || !safe(v.contributors.omitted) || !Array.isArray(v.contributors.items) || v.contributors.items.length > MAX_USAGE_DAY_CONTRIBUTORS || !v.contributors.items.every(contributor))
        return false;
    const dayToolIds = new Set<string>();
    if (v.tools.some(item => dayToolIds.has(item.id) || !dayToolIds.add(item.id)) || v.tools.reduce((sum, item) => sum + item.requests, 0) !== v.requests || v.tools.reduce((sum, item) => sum + item.results, 0) !== v.results || v.tools.reduce((sum, item) => sum + item.errors, 0) !== v.errors) return false;
    if ((v.cacheWriteReporting === 'unreported' || v.cacheWriteReporting === 'unavailable') && (v.tokens as UsageTokens).write !== 0)
        return false;
    const contributorIds = new Set<string>();
    const contributors = v.contributors.items as Record<string, unknown>[];
    const contributorTokenBuckets = (['fresh', 'read', 'write', 'output'] as const).map(key => contributors.reduce((n, c) => n + (c.tokens as UsageTokens)[key], 0));
    const dayTokenBuckets = (['fresh', 'read', 'write', 'output'] as const).map(key => (v.tokens as UsageTokens)[key]);
    const contributorRequests = contributors.reduce((n, c) => n + (c.requests as number), 0);
    const contributorCount = contributors.length + (v.contributors.omitted as number);
    for (const metric of ['tokens', 'requests', 'errors'] as const) {
        const ranks = contributors.map(c => (c.rank as Record<string, number>)[metric]!);
        if (new Set(ranks).size !== ranks.length || ranks.some(rank => rank > contributorCount) || v.contributors.state === 'full' && ranks.some(rank => rank > contributors.length)) return false;
    }
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
function validHours(value: UsageDay, timezone: string, withTokens: boolean, asOf: string): boolean {
    const hours = value.hours;
    if (!Array.isArray(hours) || hours.length < 1 || hours.length > 48) return false;
    const expected: number[] = [];
    const end = localMidnightAt(addDays(value.date, 1), timezone);
    for (let at = localMidnightAt(value.date, timezone); at < end; at += 3600000) expected.push(at);
    if (hours.length !== expected.length) return false;
    let requests = 0, tokens = 0;
    for (let i = 0; i < hours.length; i++) {
        const item = hours[i] as unknown;
        if (!obj(item) || !ownKeys(item, ['hour', 'offsetMinutes', 'startAt', 'requests', ...(withTokens ? ['tokens'] : [])]) || !Number.isInteger(item.hour) || typeof item.hour !== 'number' || item.hour < 0 || item.hour > 23 || !Number.isInteger(item.offsetMinutes) || typeof item.offsetMinutes !== 'number' || item.offsetMinutes < -840 || item.offsetMinutes > 840 || !instant(item.startAt) || Date.parse(item.startAt) !== expected[i] || !safe(item.requests) || withTokens && !safe(item.tokens)) return false;
        const local = zonedHour(expected[i]!, timezone);
        if (item.hour !== local.hour || item.offsetMinutes !== local.offsetMinutes) return false;
        if (Date.parse(item.startAt) > Date.parse(asOf) && (item.requests !== 0 || (withTokens && item.tokens !== 0))) return false;
        requests += item.requests as number;
        if (withTokens) tokens += item.tokens as number;
    }
    return safe(requests) && requests === value.requests && (!withTokens || safe(tokens) && tokens === tokenSum(value.tokens));
}
function previousPeriod(v: unknown, range: '7d' | '30d', rangeStartDate: string, timezone: string): v is UsagePreviousPeriod {
    if (!obj(v) || !ownKeys(v, ['startInclusive', 'endInclusive', 'tokens', 'sessions', 'records', 'requests', 'activeDays', 'cachedInputShare', 'cacheWriteReporting']) || !instant(v.startInclusive) || !instant(v.endInclusive) || !tokens(v.tokens) || !['reported', 'partial', 'unreported', 'unavailable'].includes(v.cacheWriteReporting as string) || !safe(v.sessions) || !safe(v.records) || !safe(v.requests) || !safe(v.activeDays) || v.sessions > v.records || (v.cacheWriteReporting === 'unreported' || v.cacheWriteReporting === 'unavailable') && v.tokens.write !== 0)
        return false;
    const days = range === '7d' ? 7 : 30;
    const start = localMidnightAt(addDays(rangeStartDate, -days), timezone);
    const end = localMidnightAt(rangeStartDate, timezone) - 1;
    if (v.startInclusive !== new Date(start).toISOString() || v.endInclusive !== new Date(end).toISOString() || v.activeDays > days || (v.activeDays === 0 && (v.records !== 0 || v.requests !== 0 || tokenSum(v.tokens) !== 0)))
        return false;
    const prompt = v.tokens.fresh + v.tokens.read + v.tokens.write;
    return v.cachedInputShare === null ? prompt === 0 : finite(v.cachedInputShare) && prompt > 0 && Math.abs(v.cachedInputShare - v.tokens.read / prompt * 100) <= 1e-9;
}
function range(v: unknown, asOf: string, timezone: string): v is UsageRangeSummary {
    if (!obj(v) || !ownKeys(v, ['range', ...(v.bucketDays === undefined ? [] : ['bucketDays']), ...(v.previousPeriod === undefined ? [] : ['previousPeriod']), 'startDate', 'endDateExclusive', 'startInclusive', 'endExclusive', 'tokens', 'sessions', 'records', 'requests', 'identifiedRequests', 'fallbackRequests', 'activeDays', 'cachedInputShare', 'cacheWriteReporting', 'days', 'models', 'tools', 'timing', 'autoMode', 'detail']) || (v.range !== '7d' && v.range !== '30d' && v.range !== 'all') || !date(v.startDate) || !date(v.endDateExclusive) || !instant(v.startInclusive) || !instant(v.endExclusive) || !tokens(v.tokens) || !['reported', 'partial', 'unreported', 'unavailable'].includes(v.cacheWriteReporting as string) || !safe(v.sessions) || !safe(v.records) || !safe(v.requests) || !safe(v.identifiedRequests) || !safe(v.fallbackRequests) || !safe(v.activeDays) || !Array.isArray(v.days) || !Array.isArray(v.models) || !Array.isArray(v.tools) || !timing(v.timing) || !obj(v.detail) || !ownKeys(v.detail, ['state', 'omittedModels', 'omittedTools']) || !['full', 'grouped', 'summary-only'].includes(v.detail.state as string) || !safe(v.detail.omittedModels) || !safe(v.detail.omittedTools))
        return false;
    const all = v.range === 'all';
    if (all && v.previousPeriod !== undefined) return false;
    if (v.range !== 'all' && v.previousPeriod !== undefined && !previousPeriod(v.previousPeriod, v.range, v.startDate as string, timezone)) return false;
    const n = v.range === '7d' ? 7 : 30;
    const bucketDays = v.bucketDays ?? 1;
    if (!safe(bucketDays) || bucketDays < 1 || (!all && v.bucketDays !== undefined)) return false;
    const today = dateAt(Date.parse(asOf), timezone);
    const expectedEndDate = addDays(today, 1);
    const startDate = v.startDate as string, endDate = v.endDateExclusive as string;
    const expectedStartDate = all ? startDate : addDays(today, -(n - 1));
    const start = new Date(localMidnightAt(startDate, timezone)).toISOString();
    const end = new Date(localMidnightAt(endDate, timezone)).toISOString();
    const spanDays = (Date.parse(`${endDate}T00:00:00.000Z`) - Date.parse(`${startDate}T00:00:00.000Z`)) / 86400000;
    if (startDate !== expectedStartDate || endDate !== expectedEndDate || v.startInclusive !== start || v.endExclusive !== end || start >= end || spanDays < 1 || bucketDays > spanDays || (all ? v.days.length > MAX_USAGE_ALL_BUCKETS : v.days.length !== n) || !uniqueCategories(v.models, MAX_USAGE_MODELS) || !uniqueCategories(v.tools, MAX_USAGE_TOOLS) || !v.models.every(model) || !v.tools.every(tool) || !v.days.every(day))
        return false;
    if (!autoMode(v.autoMode, startDate, endDate, all ? MAX_USAGE_ALL_BUCKETS : n, bucketDays))
        return false;
    const rangeToolIds = new Set((v.tools as UsageTool[]).map(item => item.id));
    const rangeToolsById = new Map((v.tools as UsageTool[]).map(item => [item.id, item]));
    for (let i = 0; i < v.days.length; i++) {
        const d = v.days[i] as UsageDay;
        if ((v.range === '7d') !== (d.hours !== undefined)) return false;
        if (!all && d.date !== addDays(startDate, i)) return false;
        if (all && (d.date < startDate || d.date >= endDate || i > 0 && d.date <= (v.days[i - 1] as UsageDay).date || (Date.parse(`${d.date}T00:00:00.000Z`) - Date.parse(`${startDate}T00:00:00.000Z`)) / 86400000 % bucketDays !== 0 || d.contributors.state !== 'unavailable')) return false;
        const bucketStart = localMidnightAt(d.date, timezone);
        const bucketEnd = localMidnightAt(addDays(d.date, bucketDays), timezone);
        if (d.tools.some(tool => !rangeToolIds.has(tool.id) || tool.builds?.items.some(build => Date.parse(build.firstObservedAt) < bucketStart || Date.parse(build.firstObservedAt) >= bucketEnd || Date.parse(build.firstObservedAt) > Date.parse(asOf)))) return false;
        if (d.contributors.items.some(contributor => contributor.timeline.items.some(item => dateAt(Date.parse(item.startedAt), timezone) !== d.date || Date.parse(item.startedAt) > Date.parse(asOf)))) return false;
        if (d.hours && !validHours(d, timezone, v.range === '7d', asOf)) return false;
    }
    if (all && v.days.some(d => d.date < startDate)) return false;
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
    for (const key of ['results', 'errors'] as const) {
        if (days.reduce((n, d) => n + d[key], 0) !== v.tools.reduce((n, t) => n + t[key], 0)) return false;
    }
    for (const id of rangeToolIds) {
        const expected = rangeToolsById.get(id)!;
        for (const key of ['requests', 'results', 'errors'] as const)
            if (days.reduce((sum, item) => sum + (item.tools.find(tool => tool.id === id)?.[key] ?? 0), 0) !== expected[key]) return false;
    }
    const dailyRecords = days.reduce((n, d) => n + d.records, 0);
    const dailySessions = days.reduce((n, d) => n + d.sessions, 0);
    if (v.requests !== v.identifiedRequests + v.fallbackRequests || v.requests !== days.reduce((n, d) => n + d.requests, 0) || v.records !== dailyRecords || v.sessions > v.records || v.sessions > dailySessions || v.sessions < Math.max(...days.map(d => d.sessions), 0) || days.some(d => d.sessions > d.records) || (bucketDays === 1 ? v.activeDays !== days.filter((d: UsageDay) => tokenSum(d.tokens) > 0 || d.requests > 0 || d.records > 0 || d.sessions > 0).length : v.activeDays < days.filter(d => tokenSum(d.tokens) > 0 || d.requests > 0 || d.records > 0 || d.sessions > 0).length || v.activeDays > spanDays))
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
    if (!obj(v) || !ownKeys(v, ['version', 'metricVersion', 'countingVersion', 'pricingVersion', 'snapshotId', 'scope', 'timezone', 'asOf', 'computedAt', 'coverage', 'ranges']) || v.version !== 2 || v.metricVersion !== 1 || v.countingVersion !== 14 || v.pricingVersion !== USAGE_PRICING_VERSION || !id(v.snapshotId) || v.scope !== 'retained-transcripts' || !validTimezone(v.timezone) || !instant(v.asOf) || !instant(v.computedAt) || new Date(v.computedAt).getTime() < new Date(v.asOf).getTime() || !obj(v.coverage) || !obj(v.ranges) || !ownKeys(v.ranges, ['7d', '30d', 'all']))
        return false;
    const c = v.coverage as Record<string, unknown>;
    const coverageKeys = ['state', 'sourcesDiscovered', 'sourcesRead', 'parseErrors', 'oversizedRecords', 'pendingTailBytes', 'shortReads', 'changedSources', 'readErrors', 'invalidTimestamps', 'invalidUsage', 'invalidTimings', 'identityConflicts'];
    if (!ownKeys(c, coverageKeys) || (c.state !== 'complete' && c.state !== 'partial') || !coverageKeys.slice(1).every(k => safe(c[k])) || (c.sourcesRead as number) > (c.sourcesDiscovered as number))
        return false;
    const losses = ['parseErrors', 'oversizedRecords', 'pendingTailBytes', 'shortReads', 'changedSources', 'readErrors', 'invalidTimestamps', 'invalidUsage'];
    if (c.state === 'complete' && ((c.sourcesRead as number) !== (c.sourcesDiscovered as number) || losses.some(k => c[k] !== 0)))
        return false;
    const ranges = v.ranges as Record<string, unknown>;
    if (!range(ranges.all, v.asOf, v.timezone as string) || (ranges.all as UsageRangeSummary).range !== 'all' || !range(ranges['7d'], v.asOf, v.timezone as string) || !range(ranges['30d'], v.asOf, v.timezone as string) || (ranges['7d'] as UsageRangeSummary).range !== '7d' || (ranges['30d'] as UsageRangeSummary).range !== '30d') return false;
    const all = ranges.all as UsageRangeSummary;
    for (const range of [ranges['7d'], ranges['30d']] as UsageRangeSummary[]) {
        const previous = range.previousPeriod;
        if (!previous) continue;
        if (c.state !== 'complete' || previous.sessions > all.sessions || previous.records > all.records || previous.requests > all.requests || previous.activeDays > all.activeDays || (['fresh', 'read', 'write', 'output'] as const).some(key => previous.tokens[key] > all.tokens[key])) return false;
    }
    return true;
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
