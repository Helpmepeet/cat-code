import { usageCategory as category } from './usageCategory.js';
import { basename, dirname, isAbsolute, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { readStatsRecords, type StatsRecord } from './statsReader.js';
import { usageWindow, usageTimestampEligible } from './usageWindow.js';
import type { UsageCoverage, UsageDashboardSnapshot, UsageTokens, UsageRangeSummary, UsageSessionContributor, UsageDay, UsagePreviousPeriod } from '../../app/shared/usageDashboard.js';
import { getProviderForModel } from './model/providerForModel.js';
import { getConfiguredStandardModelCosts } from './modelCostRates.js';
import { MAX_USAGE_ALL_BUCKETS, USAGE_PRICING_VERSION, usageProjectId, type UsageTokenCostEstimate } from '../../app/shared/usageDashboard.js';
export const MAX_USAGE_IDENTITIES = 250000;
export const MAX_USAGE_STATE_BYTES = 64 * 1024 * 1024;
export const USAGE_COLLECTION_TIMEOUT_MS = 120000;
export class UsageResourceError extends Error {
}
export interface UsageIdentityStore {
    map<T>(name: string): { get(key: string): T | undefined; set(key: string, value: T): unknown };
    set(name: string): { has(key: string): boolean; add(key: string): unknown };
}
const zero = (): UsageTokens => ({ fresh: 0, read: 0, write: 0, output: 0 });
const zeroCost = (): UsageTokenCostEstimate => ({ usd: 0, pricedTokens: 0 });
const total = (t: UsageTokens) => t.fresh + t.read + t.write + t.output;
function standardTokenCost(model: string | null, tokens: UsageTokens): UsageTokenCostEstimate {
    if (!model) return zeroCost();
    const rates = getConfiguredStandardModelCosts(model);
    if (!rates) return zeroCost();
    return {
        usd: (tokens.fresh * rates.inputTokens + tokens.read * rates.promptCacheReadTokens + tokens.output * rates.outputTokens) / 1_000_000,
        // The index does not retain cache-write TTL, so writes cannot be priced.
        pricedTokens: tokens.fresh + tokens.read + tokens.output,
    };
}
function addCost(target: UsageTokenCostEstimate, value: UsageTokenCostEstimate) {
    target.usd += value.usd;
    target.pricedTokens = plus(target.pricedTokens, value.pricedTokens);
}
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const nonempty = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const safe = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
function plus(a: number, b: number): number { const n = a + b; if (!safe(n))
    throw new UsageResourceError('Usage count overflow'); return n; }
function addTokens(a: UsageTokens, b: UsageTokens) { for (const key of Object.keys(a) as (keyof UsageTokens)[])
    a[key] = plus(a[key], b[key]); if (!safe(total(a)))
    throw new UsageResourceError('Usage total overflow'); }
export const emptyUsageCoverage = (): UsageCoverage => ({ state: 'complete', sourcesDiscovered: 0, sourcesRead: 0, parseErrors: 0, oversizedRecords: 0, pendingTailBytes: 0, shortReads: 0, changedSources: 0, readErrors: 0, invalidTimestamps: 0, invalidUsage: 0, identityConflicts: 0 });
/** Desktop retained-history accounting; never reads or rewrites legacy aggregate caches. */
export async function collectRetainedUsage(files: readonly string[], asOf: string, options: {
    deadline?: number;
    maxIdentities?: number;
    maxStateBytes?: number;
    signal?: AbortSignal;
    identities?: UsageIdentityStore;
    readRecords?: typeof readStatsRecords;
} = {}): Promise<UsageDashboardSnapshot> {
    const cutoff = Date.parse(asOf), deadline = options.deadline ?? Date.now() + USAGE_COLLECTION_TIMEOUT_MS;
    if (!Number.isFinite(cutoff))
        throw new Error('Invalid cutoff');
    const coverage = emptyUsageCoverage();
    coverage.sourcesDiscovered = files.length;
    let identities = 0, stateBytes = 0;
    const reserve = (key: string, payloadBytes = 512) => {
        identities++;
        stateBytes += key.length * 2 + payloadBytes;
        if (identities > (options.maxIdentities ?? MAX_USAGE_IDENTITIES) || stateBytes > (options.maxStateBytes ?? MAX_USAGE_STATE_BYTES))
            throw new UsageResourceError('Usage state budget exceeded');
    };
    if (files.length > MAX_USAGE_IDENTITIES)
        throw new UsageResourceError('Usage source budget exceeded');
    type ComparisonState = {
        days: number;
        start: number;
        end: number;
        summary: UsagePreviousPeriod;
        sessions: Set<string>;
        activeDays: Set<string>;
    };
    const states = (['7d', '30d', 'all'] as const).map(range => {
        const bounds = usageWindow(range === '7d' ? 7 : 30, asOf);
        if (range === 'all') { bounds.startInclusive = `${asOf.slice(0, 10)}T00:00:00.000Z`; bounds.dates = []; }
        const summary: UsageRangeSummary = { range, startInclusive: bounds.startInclusive, endExclusive: bounds.endExclusive, tokens: zero(), sessions: 0, records: 0, requests: 0, identifiedRequests: 0, fallbackRequests: 0, activeDays: 0, cachedInputShare: null, cacheWriteReporting: 'unavailable', days: bounds.dates.map(date => ({ date, hourlyRequests: Array(24).fill(0), ...(range === '7d' ? { hourlyTokens: Array(24).fill(0) } : {}), results: 0, errors: 0, tokens: zero(), cacheWriteReporting: 'unavailable', models: [], sessions: 0, records: 0, requests: 0, contributors: { state: 'full', omitted: 0, items: [] } })), models: [], tools: [], detail: { state: 'full', omittedModels: 0, omittedTools: 0 } };
        return { summary, dayMap: new Map(summary.days.map(day => [day.date, day])), start: range === 'all' ? Date.parse('0000-01-01T00:00:00.000Z') : Date.parse(bounds.startInclusive), end: Date.parse(bounds.endExclusive), cacheWriteReported: false, cacheWriteUnreported: false, cacheWriteUnknown: false, dailyCacheWriteReporting: new Map<string, { reported: boolean; unreported: boolean; unknown: boolean }>(), sessions: new Set<string>(), sessionDays: new Set<string>(), models: new Map<string, typeof summary.models[number]>(), tools: new Map<string, typeof summary.tools[number]>(), dailyContributors: new Map<string, UsageSessionContributor>(), contributorModels: new Map<string, Map<string, typeof summary.models[number]>>(), dailyModels: new Map<string, {
                id: string;
                total: number;
            }>() };
    });
    const comparisons: ComparisonState[] = ([7, 30] as const).map(days => {
        const current = usageWindow(days, asOf);
        const start = Date.parse(current.startInclusive) - days * 86400000;
        const end = cutoff - days * 86400000;
        return { days, start, end, sessions: new Set(), activeDays: new Set(), summary: {
            startInclusive: new Date(start).toISOString(), endInclusive: new Date(end).toISOString(),
            tokens: zero(), sessions: 0, records: 0, requests: 0, activeDays: 0, cachedInputShare: null,
        } };
    });
    const eligibleComparisons = (timestamp: number) => comparisons.filter(s => timestamp >= s.start && timestamp <= s.end);
    let earliestUsableMainRecord = Number.POSITIVE_INFINITY;
    const ensureDay = (s: typeof states[number], date: string): UsageDay => {
        let day = s.dayMap.get(date);
        if (!day) {
            reserve(date, 1024);
            day = { date, hourlyRequests: Array(24).fill(0), results: 0, errors: 0, tokens: zero(), cacheWriteReporting: 'unavailable', models: [], sessions: 0, records: 0, requests: 0, contributors: { state: 'unavailable', omitted: 0, items: [] } };
            s.dayMap.set(date, day);
            s.summary.days.push(day);
            if (`${date}T00:00:00.000Z` < s.summary.startInclusive) s.summary.startInclusive = `${date}T00:00:00.000Z`;
        }
        return day;
    };
    type UsageValue = {
        tokens: UsageTokens;
        model: string;
    };
    type ToolValue = {
        name: string | null;
        timestamp: number;
        session: string;
        date: string;
    };
    const usage = options.identities?.map<UsageValue>('usage') ?? new Map<string, UsageValue>();
    const toolLedger = options.identities?.map<ToolValue>('tools') ?? new Map<string, ToolValue>();
    const results = options.identities?.map<{ timestamp: number; error: boolean; counted: boolean }>('results') ?? new Map<string, { timestamp: number; error: boolean; counted: boolean }>();
    const recordIds = options.identities?.set('records') ?? new Set<string>();
    const sessionMetadata = new Map<string, { projectId: string | null; label: string | null; conflicted: boolean; engineSessionId: string | null }>();
    const contributorSessions = new Map<string, string>();
    const opaqueId = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 32);
    const sessionUuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) ? value : null;
    const ensureContributor = (s: typeof states[number], session: string, date: string): UsageSessionContributor => {
        const key = JSON.stringify([date, session]);
        let contributor = s.dailyContributors.get(key);
        if (!contributor) {
            reserve(key, 768);
            const meta = sessionMetadata.get(session)!;
            contributor = { id: opaqueId(session), engineSessionId: meta.engineSessionId, project: null, tokens: zero(), requests: 0, results: 0, errors: 0, tokenCost: zeroCost(), models: [], modelDetail: { state: 'full', omitted: 0 } };
            contributorSessions.set(contributor.id, session);
            s.dailyContributors.set(key, contributor);
            ensureDay(s, date).contributors.items.push(contributor);
        }
        return contributor;
    };
    // Disk-backed identities have a separate storage cap; category/session maps
    // still use the original bounded heap budget.
    const reserveIdentity = (key: string, bytes?: number) => { if (!options.identities) reserve(key, bytes); };
    // Match results to the canonical request in the same session/subagent scope.
    // Either can appear first in retained file order; one result per request wins.
    const countResult = (key: string) => {
        const request = toolLedger.get(key), result = results.get(key);
        if (!request || !result || result.counted || result.timestamp < request.timestamp) return;
        result.counted = true;
        results.set(key, result);
        for (const s of states.filter(s => usageTimestampEligible(request.timestamp, s.start, s.end, cutoff))) {
            const tool = s.tools.get(category(request.name).id)!;
            tool.results = plus(tool.results, 1);
            if (result.error) tool.errors = plus(tool.errors, 1);
            const day = ensureDay(s, request.date);
            day.results = plus(day.results, 1);
            if (result.error) day.errors = plus(day.errors, 1);
            if (s.summary.range !== 'all') {
                const contributor = ensureContributor(s, request.session, request.date);
                contributor.results = plus(contributor.results, 1);
                if (result.error) contributor.errors = plus(contributor.errors, 1);
            }
        }
    };
    const readOne = async (file: string, item: StatsRecord) => {
        if (Date.now() > deadline)
            throw new Error('Usage collection timeout');
        const row = item.value;
        if (!record(row) || !['assistant', 'user', 'attachment', 'system'].includes(String(row.type)))
            return;
        const isSubagent = file.includes(`${sep}subagents${sep}`);
        if (!isSubagent && row.isSidechain === true)
            return;
        const timestamp = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : NaN;
        if (!Number.isFinite(timestamp) || timestamp < Date.parse('0000-01-01T00:00:00.000Z') || timestamp >= Date.parse('+010000-01-01T00:00:00.000Z')) {
            coverage.invalidTimestamps++;
            return;
        }
        if (timestamp > cutoff)
            return;
        const project = isSubagent ? dirname(dirname(dirname(file))) : dirname(file);
        const mainId = nonempty(row.sessionId) ? row.sessionId : isSubagent ? basename(dirname(dirname(file))) : basename(file, '.jsonl');
        const session = JSON.stringify([project, mainId]);
        if (!isSubagent)
            earliestUsableMainRecord = Math.min(earliestUsableMainRecord, timestamp);
        const rawCwd = nonempty(row.cwd) && isAbsolute(row.cwd) ? row.cwd : null;
        const candidateLabel = rawCwd ? basename(rawCwd) : null;
        const cwdLabel = candidateLabel && new TextEncoder().encode(candidateLabel).byteLength <= 160 ? candidateLabel : null;
        const candidateProjectId = rawCwd && cwdLabel ? usageProjectId(rawCwd) : null;
        const metadata = sessionMetadata.get(session);
        if (!metadata) { reserve(session, 384 + (rawCwd?.length ?? 0) * 2); sessionMetadata.set(session, { projectId: candidateProjectId, label: cwdLabel, conflicted: false, engineSessionId: sessionUuid(mainId) }); }
        else if (candidateProjectId && metadata.projectId && candidateProjectId !== metadata.projectId) { metadata.projectId = null; metadata.label = null; metadata.conflicted = true; metadata.engineSessionId = null; coverage.identityConflicts++; }
        else if (candidateProjectId && !metadata.projectId && !metadata.conflicted) { metadata.projectId = candidateProjectId; metadata.label = cwdLabel; }
        const scope = JSON.stringify([project, mainId, isSubagent ? basename(file, '.jsonl') : null]);
        const recordId = JSON.stringify([scope, nonempty(row.uuid) ? row.uuid : [item.generation, item.offset]]);
        const alreadyRecorded = recordIds.has(recordId);
        if (!alreadyRecorded) {
            reserveIdentity(recordId);
            recordIds.add(recordId);
        }
        const eligibleStates = states.filter(s => usageTimestampEligible(timestamp, s.start, s.end, cutoff));
        const date = new Date(timestamp).toISOString().slice(0, 10);
        for (const s of eligibleStates) {
            const day = ensureDay(s, date);
            if (!isSubagent && !alreadyRecorded) {
                s.summary.records = plus(s.summary.records, 1);
                day.records = plus(day.records, 1);
                if (!s.sessions.has(session)) {
                    reserve(session);
                    s.sessions.add(session);
                    s.summary.sessions++;
                }
                const sd = JSON.stringify([session, date]);
                if (!s.sessionDays.has(sd)) {
                    reserve(sd);
                    s.sessionDays.add(sd);
                    day.sessions++;
                }
            }
        }
        if (!isSubagent && !alreadyRecorded) for (const s of eligibleComparisons(timestamp)) {
            s.summary.records = plus(s.summary.records, 1);
            if (!s.sessions.has(session)) {
                reserve(session);
                s.sessions.add(session);
                s.summary.sessions = plus(s.summary.sessions, 1);
            }
            s.activeDays.add(date);
        }
        if (row.type === 'user' && record(row.message) && Array.isArray(row.message.content)) {
            for (const block of row.message.content) {
                if (!record(block) || block.type !== 'tool_result' || !nonempty(block.tool_use_id)) continue;
                // Anthropic tool_result omits is_error on success. Invalid flags
                // are not a known outcome and cannot enter the rate denominator.
                if (block.is_error !== undefined && typeof block.is_error !== 'boolean') continue;
                const key = JSON.stringify([scope, ['id', block.tool_use_id]]);
                const old = results.get(key);
                if (old) {
                    if (old.error !== (block.is_error === true)) coverage.identityConflicts++;
                    continue;
                }
                reserveIdentity(key);
                results.set(key, { timestamp, error: block.is_error === true, counted: false });
                countResult(key);
            }
        }
        if (row.type !== 'assistant' || !record(row.message))
            return;
        const message = row.message;
        if (Array.isArray(message.content))
            for (const [index, block] of message.content.entries()) {
                if (!record(block) || block.type !== 'tool_use')
                    continue;
                const identified = nonempty(block.id);
                const key = JSON.stringify([scope, identified ? ['id', block.id] : ['record', recordId, index]]);
                const name = nonempty(block.name) ? block.name : null;
                const old = toolLedger.get(key);
                if (old) {
                    if (old.name !== name || old.timestamp !== timestamp)
                        coverage.identityConflicts++;
                    continue;
                }
                reserveIdentity(key, 512 + (name?.length ?? 0) * 2 + session.length * 2);
                toolLedger.set(key, { name, timestamp, session, date });
                const cat = category(name);
                for (const s of eligibleStates) {
                    const day = ensureDay(s, date);
                    s.summary.requests = plus(s.summary.requests, 1);
                    day.requests = plus(day.requests, 1);
                    const hour = new Date(timestamp).getUTCHours();
                    day.hourlyRequests[hour] = plus(day.hourlyRequests[hour]!, 1);
                    if (identified)
                        s.summary.identifiedRequests++;
                    else
                        s.summary.fallbackRequests++;
                    let tool = s.tools.get(cat.id);
                    if (!tool) {
                        reserve(cat.id);
                        tool = { ...cat, requests: 0, results: 0, errors: 0 };
                        s.tools.set(cat.id, tool);
                    }
                    tool.requests = plus(tool.requests, 1);
                    if (s.summary.range !== 'all') {
                        const contributor = ensureContributor(s, session, date);
                        contributor.requests = plus(contributor.requests, 1);
                    }
                }
                for (const s of eligibleComparisons(timestamp)) {
                    s.summary.requests = plus(s.summary.requests, 1);
                    s.activeDays.add(date);
                }
                countResult(key);
            }
        if (!record(message.usage) || message.model === '<synthetic>')
            return;
        const u = message.usage;
        // Persisted adapter records already use exclusive Anthropic-style categories.
        // OpenAI-native imported records explicitly carrying input_tokens_details are inclusive.
        const raw: Record<keyof UsageTokens, unknown> = { fresh: u.input_tokens ?? 0, read: u.cache_read_input_tokens ?? 0, write: u.cache_creation_input_tokens ?? 0, output: u.output_tokens ?? 0 };
        if (record(u.input_tokens_details) && u.input_tokens_details.cached_tokens !== undefined && u.cache_read_input_tokens === undefined) {
            raw.read = u.input_tokens_details.cached_tokens;
            if (safe(raw.fresh) && safe(raw.read))
                raw.fresh -= raw.read;
        }
        if (!Object.values(raw).every(safe) || !safe(total(raw as UsageTokens))) {
            coverage.invalidUsage++;
            return;
        }
        const current = raw as UsageTokens;
        const modelName = nonempty(message.model) ? message.model : null;
        // GPT requests route through the OpenAI adapter, whose upstream usage
        // exposes cached reads but no cache-creation count. Its persisted zero
        // is a normalization placeholder, not a provider measurement.
        const hasCacheWrite = Object.prototype.hasOwnProperty.call(u, 'cache_creation_input_tokens');
        const writeReporting = current.write > 0
            ? 'reported'
            : getProviderForModel(modelName) === 'openai'
                ? 'unreported'
                : hasCacheWrite && modelName?.toLowerCase().startsWith('claude-')
                    ? 'reported'
                    : 'unknown';
        for (const s of eligibleStates) {
            if (writeReporting === 'reported') s.cacheWriteReported = true;
            else if (writeReporting === 'unreported') s.cacheWriteUnreported = true;
            else s.cacheWriteUnknown = true;
            const daily = s.dailyCacheWriteReporting.get(date) ?? { reported: false, unreported: false, unknown: false };
            daily[writeReporting] = true;
            s.dailyCacheWriteReporting.set(date, daily);
        }
        const cat = category(modelName);
        const key = JSON.stringify([scope, nonempty(message.id) ? ['api', message.id] : ['record', recordId]]);
        const prior = usage.get(key);
        if (prior && prior.model !== cat.id) {
            coverage.identityConflicts++;
            return;
        }
        const delta = zero(), maximum = zero();
        for (const k of Object.keys(delta) as (keyof UsageTokens)[]) {
            delta[k] = Math.max(0, current[k] - (prior?.tokens[k] ?? 0));
            maximum[k] = Math.max(current[k], prior?.tokens[k] ?? 0);
        }
        if (!prior)
            reserveIdentity(key);
        usage.set(key, { tokens: maximum, model: cat.id });
        if (total(delta) === 0)
            return;
        for (const s of eligibleComparisons(timestamp)) {
            addTokens(s.summary.tokens, delta);
            s.activeDays.add(date);
        }
        for (const s of eligibleStates) {
            const day = ensureDay(s, date);
            addTokens(s.summary.tokens, delta);
            addTokens(day.tokens, delta);
            if (day.hourlyTokens) {
                const hour = new Date(timestamp).getUTCHours();
                day.hourlyTokens[hour] = plus(day.hourlyTokens[hour]!, total(delta));
            }
            const contributor = s.summary.range === 'all' ? null : ensureContributor(s, session, date);
            if (contributor) addTokens(contributor.tokens, delta);
            let model = s.models.get(cat.id);
            if (!model) {
                reserve(cat.id);
                model = { ...cat, tokens: zero(), tokenCost: zeroCost() };
                s.models.set(cat.id, model);
            }
            addTokens(model.tokens, delta);
            const tokenCost = standardTokenCost(modelName, delta);
            addCost(model.tokenCost!, tokenCost);
            if (contributor) addCost(contributor.tokenCost!, tokenCost);
            if (contributor) {
                const contributorKey = JSON.stringify([date, session]);
                let contributorModelMap = s.contributorModels.get(contributorKey);
                if (!contributorModelMap) { reserve(contributorKey, 256); contributorModelMap = new Map(); s.contributorModels.set(contributorKey, contributorModelMap); }
                let contributorModel = contributorModelMap.get(cat.id);
                if (!contributorModel) { reserve(`${contributorKey}:${cat.id}`, 384); contributorModel = { ...cat, tokens: zero(), tokenCost: zeroCost() }; contributorModelMap.set(cat.id, contributorModel); contributor.models.push(contributorModel); }
                addTokens(contributorModel.tokens, delta);
                addCost(contributorModel.tokenCost!, tokenCost);
            }
            const dk = `${date}:${cat.id}`;
            let daily = s.dailyModels.get(dk);
            if (!daily) {
                reserve(dk);
                daily = { id: cat.id, total: 0 };
                s.dailyModels.set(dk, daily);
                day.models.push(daily);
            }
            daily.total = plus(daily.total, total(delta));
        }
    };
    for (const file of [...files].sort()) {
        options.signal?.throwIfAborted();
        try {
            const q = await (options.readRecords ?? readStatsRecords)(file, item => readOne(file, item), { signal: options.signal, deadline });
            coverage.sourcesRead++;
            for (const key of ['parseErrors', 'oversizedRecords', 'pendingTailBytes', 'shortReads', 'changedSources'] as const)
                coverage[key] = plus(coverage[key], q[key]);
        }
        catch (error) {
            if (error instanceof UsageResourceError || options.signal?.aborted || Date.now() > deadline)
                throw error;
            coverage.readErrors++;
        }
    }
    coverage.state = coverage.sourcesRead !== coverage.sourcesDiscovered || [coverage.parseErrors, coverage.oversizedRecords, coverage.pendingTailBytes, coverage.shortReads, coverage.changedSources, coverage.readErrors, coverage.invalidTimestamps, coverage.invalidUsage].some(Boolean) ? 'partial' : 'complete';
    for (const s of states) {
        s.summary.days.sort((a, b) => a.date.localeCompare(b.date));
        s.summary.models = [...s.models.values()];
        s.summary.tools = [...s.tools.values()];
        s.summary.activeDays = s.summary.days.filter(d => total(d.tokens) > 0 || d.requests > 0 || d.records > 0 || d.sessions > 0).length;
        const prompt = s.summary.tokens.fresh + s.summary.tokens.read + s.summary.tokens.write;
        s.summary.cachedInputShare = prompt > 0 ? s.summary.tokens.read / prompt * 100 : null;
        s.summary.cacheWriteReporting = s.cacheWriteUnknown || (s.cacheWriteReported && s.cacheWriteUnreported)
            ? 'partial'
            : s.cacheWriteReported ? 'reported'
                : s.cacheWriteUnreported ? 'unreported' : 'unavailable';
        for (const day of s.summary.days) {
            for (const contributor of day.contributors.items) {
                const session = contributorSessions.get(contributor.id);
                const meta = session ? sessionMetadata.get(session) : undefined;
                if (meta?.projectId && meta.label && !meta.conflicted) contributor.project = { id: meta.projectId, label: meta.label };
                if (meta?.conflicted) contributor.engineSessionId = null;
            }
            if (day.contributors.state !== 'unavailable') {
                const items = day.contributors.items;
                const ordered = {
                    tokens: [...items].sort((a, b) => total(b.tokens) - total(a.tokens) || b.requests - a.requests || b.errors - a.errors || a.id.localeCompare(b.id)),
                    requests: [...items].sort((a, b) => b.requests - a.requests || total(b.tokens) - total(a.tokens) || b.errors - a.errors || a.id.localeCompare(b.id)),
                    errors: [...items].sort((a, b) => b.errors - a.errors || total(b.tokens) - total(a.tokens) || b.requests - a.requests || a.id.localeCompare(b.id)),
                };
                const ranks = {
                    tokens: new Map(ordered.tokens.map((item, index) => [item.id, index + 1])),
                    requests: new Map(ordered.requests.map((item, index) => [item.id, index + 1])),
                    errors: new Map(ordered.errors.map((item, index) => [item.id, index + 1])),
                };
                for (const contributor of items) contributor.rank = {
                    tokens: ranks.tokens.get(contributor.id)!,
                    requests: ranks.requests.get(contributor.id)!,
                    errors: ranks.errors.get(contributor.id)!,
                };
            }
            const reporting = s.dailyCacheWriteReporting.get(day.date);
            day.cacheWriteReporting = !reporting ? 'unavailable'
                : reporting.unknown || (reporting.reported && reporting.unreported) ? 'partial'
                    : reporting.reported ? 'reported' : 'unreported';
        }
    }
    // A retained source starting after the prior interval gives no evidence that
    // the omitted time was zero. This is deliberately conservative and cannot
    // prove that deleted transcripts never existed.
    if (coverage.state === 'complete') for (const s of comparisons) {
        s.summary.activeDays = s.activeDays.size;
        const prompt = s.summary.tokens.fresh + s.summary.tokens.read + s.summary.tokens.write;
        s.summary.cachedInputShare = prompt > 0 ? s.summary.tokens.read / prompt * 100 : null;
        if (earliestUsableMainRecord <= s.start)
            states[s.days === 7 ? 0 : 1]!.summary.previousPeriod = s.summary;
    }
    // Keep the entire retained timeline within the outbound frame budget. Sparse
    // daily data avoids allocating empty history; larger histories use explicit
    // UTC buckets while activeDays remains the exact count of individual days.
    const all = states[2]!;
    if (all.summary.days.length > MAX_USAGE_ALL_BUCKETS) {
        const start = Date.parse(all.summary.startInclusive);
        const span = Math.ceil((Date.parse(all.summary.endExclusive) - start) / 86400000);
        const bucketDays = Math.ceil(span / MAX_USAGE_ALL_BUCKETS);
        const bucketDate = (date: string) => new Date(start + Math.floor((Date.parse(`${date}T00:00:00.000Z`) - start) / (bucketDays * 86400000)) * bucketDays * 86400000).toISOString().slice(0, 10);
        const buckets = new Map<string, UsageDay>();
        const bucketSessions = new Map<string, Set<string>>();
        for (const key of all.sessionDays) {
            const [session, date] = JSON.parse(key) as [string, string];
            const bucket = bucketDate(date);
            let sessions = bucketSessions.get(bucket);
            if (!sessions) { sessions = new Set(); bucketSessions.set(bucket, sessions); }
            sessions.add(session);
        }
        for (const day of all.summary.days) {
            const date = bucketDate(day.date);
            let bucket = buckets.get(date);
            if (!bucket) { bucket = { ...day, date, tokens: zero(), requests: 0, results: 0, errors: 0, records: 0, sessions: bucketSessions.get(date)?.size ?? 0, hourlyRequests: Array(24).fill(0), models: [], cacheWriteReporting: 'unavailable' }; buckets.set(date, bucket); }
            addTokens(bucket.tokens, day.tokens);
            bucket.requests = plus(bucket.requests, day.requests);
            bucket.results = plus(bucket.results, day.results);
            bucket.errors = plus(bucket.errors, day.errors);
            bucket.records = plus(bucket.records, day.records);
            for (let hour = 0; hour < 24; hour++) bucket.hourlyRequests[hour] = plus(bucket.hourlyRequests[hour]!, day.hourlyRequests[hour]!);
            for (const model of day.models) {
                const existing = bucket.models.find(item => item.id === model.id);
                if (existing) existing.total = plus(existing.total, model.total);
                else bucket.models.push({ ...model });
            }
            if (day.cacheWriteReporting !== 'unavailable') bucket.cacheWriteReporting = bucket.cacheWriteReporting === 'unavailable' ? day.cacheWriteReporting : bucket.cacheWriteReporting === day.cacheWriteReporting ? bucket.cacheWriteReporting : 'partial';
        }
        all.summary.days = [...buckets.values()];
        all.summary.bucketDays = bucketDays;
    }
    return { version: 1, metricVersion: 1, countingVersion: 6, pricingVersion: USAGE_PRICING_VERSION, snapshotId: randomUUID(), scope: 'retained-transcripts', timezone: 'UTC', asOf, computedAt: new Date().toISOString(), coverage, ranges: { '7d': states[0]!.summary, '30d': states[1]!.summary, all: states[2]!.summary } };
}
