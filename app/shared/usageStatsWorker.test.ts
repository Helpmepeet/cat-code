import { expect, test } from 'bun:test';
import { MAX_USAGE_LABEL_BYTES, MAX_USAGE_RECORD_BYTES } from './usageDashboard.js';
import { parseUsageCollectionLine, parseUsageCollectionResult } from './usageStatsWorker.js';
const tokens = { fresh: 4, read: 2, write: 1, output: 3 };
const tokenCost = { usd: 0.00006, pricedTokens: 10 };
const timing = { models: { state: 'unavailable', logicalCalls: 0, retriedCalls: 0, streamingAttempts: 0, outcomes: { started: 0, succeeded: 0, failed: 0, cancelled: 0, incomplete: 0 }, responseDuration: { samples: 0, p50Ms: null, p95Ms: null }, firstText: { samples: 0, p50Ms: null, p95Ms: null } }, tools: { state: 'unavailable', outcomes: { started: 0, succeeded: 0, failed: 0, cancelled: 0, incomplete: 0 }, duration: { samples: 0, p50Ms: null, p95Ms: null } } };
function snapshot(label = 'Model'): Record<string, unknown> {
    const usageTokens = { ...tokens };
    const days = Array.from({ length: 30 }, (_, i) => {
        const d = new Date('2026-08-15T00:00:00.000Z');
        d.setUTCDate(d.getUTCDate() + i);
        return { date: d.toISOString().slice(0, 10), results: i === 29 ? 2 : 0, errors: i === 29 ? 1 : 0, tools: i === 29 ? [{ id: 'tool-a', requests: 3, results: 2, errors: 1 }] : [], hourlyRequests: Array.from({ length: 24 }, (_, hour) => i === 29 && hour === 12 ? 3 : 0), tokens: i === 29 ? { ...usageTokens } : { fresh: 0, read: 0, write: 0, output: 0 }, cacheWriteReporting: i === 29 ? 'reported' : 'unavailable', models: i === 29 ? [{ id: 'model-a', total: 10 }] : [], sessions: i === 29 ? 1 : 0, records: i === 29 ? 1 : 0, requests: i === 29 ? 3 : 0, contributors: { state: 'full', omitted: 0, items: i === 29 ? [{ id: 'session-a', engineSessionId: null, project: null, tokens: { ...usageTokens }, requests: 3, results: 2, errors: 1, rank: { tokens: 1, requests: 1, errors: 1 }, tokenCost: { ...tokenCost }, models: [{ id: 'model-a', kind: 'named', label, tokens: { ...usageTokens }, tokenCost: { ...tokenCost } }], modelDetail: { state: 'full', omitted: 0 }, timeline: { state: 'unavailable', omitted: 0, items: [] } }] : [] } };
    });
    const makeRange = (range: '7d' | '30d' | 'all', start: string, ds: unknown[]) => ({ range, startInclusive: `${start}T00:00:00.000Z`, endExclusive: '2026-09-14T00:00:00.000Z', tokens: { ...usageTokens }, sessions: 1, records: 1, requests: 3, identifiedRequests: 2, fallbackRequests: 1, activeDays: 1, cachedInputShare: 2 / 7 * 100, cacheWriteReporting: 'reported', days: ds, models: [{ id: 'model-a', kind: 'named', label, tokens: { ...usageTokens }, tokenCost: { ...tokenCost } }], tools: [{ id: 'tool-a', kind: 'named', label: 'Tool', requests: 3, results: 2, errors: 1 }], timing: structuredClone(timing), detail: { state: 'full', omittedModels: 0, omittedTools: 0 } });
    return { version: 1, metricVersion: 1, countingVersion: 9, pricingVersion: 1, snapshotId: 'a'.repeat(64), scope: 'retained-transcripts', timezone: 'UTC', asOf: '2026-09-13T12:00:00.000Z', computedAt: '2026-09-13T12:00:01.000Z', coverage: { state: 'complete', sourcesDiscovered: 1, sourcesRead: 1, parseErrors: 0, oversizedRecords: 0, pendingTailBytes: 0, shortReads: 0, changedSources: 0, readErrors: 0, invalidTimestamps: 0, invalidUsage: 0, invalidTimings: 0, identityConflicts: 0 }, ranges: { '7d': makeRange('7d', '2026-09-07', days.slice(23).map((day, index) => ({ ...day, hourlyTokens: Array.from({ length: 24 }, (_, hour) => index === 6 && hour === 12 ? 10 : 0) }))), '30d': makeRange('30d', '2026-08-15', days), all: makeRange('all', '2026-09-13', [{ ...days.at(-1), contributors: { state: 'unavailable', omitted: 0, items: [] } }]) } };
}
function usage(over: Record<string, unknown> = {}) { return { type: 'usage', version: 1, snapshot: { ...snapshot(), ...over } }; }
test('accepts a valid three-range snapshot and JSON line', () => {
    const value = usage();
    expect(parseUsageCollectionResult(value)?.type).toBe('usage');
    expect(parseUsageCollectionLine(JSON.stringify(value))?.type).toBe('usage');
});
test('accepts excluded timing records without marking token and tool coverage partial', () => {
    const value = usage();
    (value.snapshot as any).coverage.invalidTimings = 2;
    expect(parseUsageCollectionResult(value)?.type).toBe('usage');
});
test('rejects unknown keys, versions, counts, ratios, and grouping collisions', () => {
    const base = usage();
    expect(parseUsageCollectionResult({ ...base, extra: true })).toBeNull();
    expect(parseUsageCollectionResult({ ...base, version: 2 })).toBeNull();
    const badReporting = structuredClone(base) as any;
    badReporting.snapshot.ranges['7d'].cacheWriteReporting = 'guessed';
    expect(parseUsageCollectionResult(badReporting)).toBeNull();
    const contradictoryReporting = structuredClone(base) as any;
    contradictoryReporting.snapshot.ranges['7d'].cacheWriteReporting = 'unreported';
    expect(parseUsageCollectionResult(contradictoryReporting)).toBeNull();
    const badCount = structuredClone(base) as any;
    badCount.snapshot.ranges['7d'].tokens.fresh = -1;
    expect(parseUsageCollectionResult(badCount)).toBeNull();
    const badRatio = structuredClone(base) as any;
    badRatio.snapshot.ranges['30d'].cachedInputShare = 49;
    expect(parseUsageCollectionResult(badRatio)).toBeNull();
    const collision = structuredClone(base) as any;
    collision.snapshot.ranges['7d'].tools.push({ id: 'tool-a', kind: 'other', label: 'Other', requests: 0, results: 0, errors: 0 });
    expect(parseUsageCollectionResult(collision)).toBeNull();
});
test('previous periods require complete coverage and bounded truthful accounting', () => {
    const base = snapshot() as any;
    base.ranges['7d'].previousPeriod = {
        startInclusive: '2026-08-31T00:00:00.000Z', endInclusive: '2026-09-06T12:00:00.000Z',
        tokens: { fresh: 0, read: 0, write: 0, output: 0 }, sessions: 0, records: 0, requests: 0, activeDays: 0, cachedInputShare: null,
    };
    expect(parseUsageCollectionResult({ type: 'usage', version: 1, snapshot: base })?.type).toBe('usage');
    const partial = structuredClone(base);
    partial.coverage.state = 'partial'; partial.coverage.parseErrors = 1;
    expect(parseUsageCollectionResult({ type: 'usage', version: 1, snapshot: partial })).toBeNull();
    const inactive = structuredClone(base);
    inactive.ranges['7d'].previousPeriod.requests = 1;
    expect(parseUsageCollectionResult({ type: 'usage', version: 1, snapshot: inactive })).toBeNull();
    const overAll = structuredClone(base);
    overAll.ranges['7d'].previousPeriod.tokens.fresh = 5;
    overAll.ranges['7d'].previousPeriod.activeDays = 1;
    expect(parseUsageCollectionResult({ type: 'usage', version: 1, snapshot: overAll })).toBeNull();
});
test('enforces multibyte label and encoded envelope boundaries', () => {
    const exact = '界'.repeat(Math.floor(MAX_USAGE_RECORD_BYTES / 3));
    expect(new TextEncoder().encode('界'.repeat(53)).byteLength).toBeLessThanOrEqual(MAX_USAGE_LABEL_BYTES);
    const ranges = snapshot().ranges as any;
    expect(parseUsageCollectionResult(usage({ ranges: { ...ranges, '7d': { ...ranges['7d'], models: [{ id: 'model-a', kind: 'named', label: '界'.repeat(53), tokens, tokenCost }], detail: { state: 'full', omittedModels: 0, omittedTools: 0 } } } }))).not.toBeNull();
    const oversized = usage({ snapshotId: 'x'.repeat(64), ranges: { ...ranges, '30d': { ...ranges['30d'], models: [{ id: 'model-a', kind: 'named', label: exact, tokens, tokenCost }] } } });
    expect(parseUsageCollectionResult(oversized)).toBeNull();
});
test('rejects malformed JSON lines and noncanonical dates', () => {
    expect(parseUsageCollectionLine('{')).toBeNull();
    const bad = usage();
    (bad.snapshot as any).asOf = '2026-09-13T12:00:00Z';
    expect(parseUsageCollectionResult(bad)).toBeNull();
    const invalidCalendar = usage();
    (invalidCalendar.snapshot as any).ranges['7d'].days[0].date = '2026-02-31';
    expect(parseUsageCollectionResult(invalidCalendar)).toBeNull();
    const incomplete = usage();
    (incomplete.snapshot as any).coverage.sourcesRead = 0;
    (incomplete.snapshot as any).coverage.state = 'complete';
    expect(parseUsageCollectionResult(incomplete)).toBeNull();
    const wrongRange = usage();
    (wrongRange.snapshot as any).ranges['7d'].range = '30d';
    expect(parseUsageCollectionResult(wrongRange)).toBeNull();
});


test('count policy rejects fractions, nonfinite and unsafe integers', () => {
  for (const count of [-1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    const value = usage();
    (value.snapshot as any).coverage.parseErrors = count;
    expect(parseUsageCollectionResult(value)).toBeNull();
  }
});

test('rejects inconsistent hourly cells and impossible tool outcomes', () => {
    for (const mutate of [
        (s: any) => s.ranges['7d'].days.at(-1).hourlyRequests.pop(),
        (s: any) => s.ranges['7d'].days.at(-1).hourlyRequests[0] = 1,
        (s: any) => { s.ranges['7d'].days.at(-1).hourlyRequests[12] = 0; s.ranges['7d'].days.at(-1).hourlyRequests[13] = 3; },
        (s: any) => s.ranges['7d'].tools[0].errors = 3,
        (s: any) => s.ranges['7d'].tools[0].results = 4,
        (s: any) => s.countingVersion = 2,
        (s: any) => s.pricingVersion = 0,
    ]) {
        const value = snapshot();
        mutate(value);
        expect(parseUsageCollectionResult({ type: 'usage', version: 1, snapshot: value })).toBeNull();
    }
});

test('rejects impossible residual outcomes after build attribution', () => {
    const value = snapshot() as any;
    value.ranges['7d'].days.at(-1).tools[0].builds = { items: [{
        sha: 'abcdef1', dirty: false, requests: 2, results: 2, errors: 0,
        firstObservedAt: '2026-09-13T12:00:00.000Z',
    }] };
    expect(parseUsageCollectionResult({ type: 'usage', version: 1, snapshot: value })).toBeNull();
});

test('accepts bounded timing data and rejects contradictory timeline measurements', () => {
    const value = snapshot() as any;
    value.ranges['7d'].timing.models = {
        state: 'available', logicalCalls: 1, retriedCalls: 0, streamingAttempts: 1,
        outcomes: { started: 1, succeeded: 1, failed: 0, cancelled: 0, incomplete: 0 },
        responseDuration: { samples: 1, p50Ms: 300, p95Ms: 300 },
        firstText: { samples: 1, p50Ms: 50, p95Ms: 50 },
    };
    value.ranges['7d'].days.at(-1).contributors.items[0].timeline = {
        state: 'available', omitted: 0, items: [{
            id: 'attempt-a', kind: 'model', callId: 'call-a',
            startedAt: '2026-09-13T12:00:00.000Z', label: 'Model',
            provider: 'firstParty', mode: 'streaming', attempt: 1,
            outcome: 'succeeded', durationMs: 300, firstTextMs: 50,
        }],
    };
    expect(parseUsageCollectionResult({ type: 'usage', version: 1, snapshot: value })?.type).toBe('usage');
    const impossibleAggregate = structuredClone(value);
    impossibleAggregate.ranges['7d'].timing.models.logicalCalls = 0;
    expect(parseUsageCollectionResult({ type: 'usage', version: 1, snapshot: impossibleAggregate })).toBeNull();
    const misplaced = structuredClone(value);
    misplaced.ranges['7d'].days.at(-1).contributors.items[0].timeline.items[0].startedAt = '2026-09-12T12:00:00.000Z';
    expect(parseUsageCollectionResult({ type: 'usage', version: 1, snapshot: misplaced })).toBeNull();
    value.ranges['7d'].days.at(-1).contributors.items[0].timeline.items[0].mode = 'non_streaming';
    expect(parseUsageCollectionResult({ type: 'usage', version: 1, snapshot: value })).toBeNull();
});

test('validates contributor bounds, reconciliation, and truthful truncation metadata', () => {
    for (const mutate of [
        (s: any) => s.ranges['7d'].days.at(-1).contributors.items[0].errors = 3,
        (s: any) => s.ranges['7d'].days.at(-1).contributors.items[0].tokens.fresh = 5,
        (s: any) => s.ranges['7d'].days.at(-1).contributors.omitted = 1,
        (s: any) => s.ranges['7d'].days.at(-1).contributors.items.push(structuredClone(s.ranges['7d'].days.at(-1).contributors.items[0])),
        (s: any) => s.ranges['7d'].days.at(-1).contributors.items[0].project = { id: 'project', label: '界'.repeat(54) },
        (s: any) => delete s.ranges['7d'].days.at(-1).contributors.items[0].rank,
        (s: any) => s.ranges['7d'].days.at(-1).contributors.items[0].rank.tokens = 2,
        (s: any) => s.ranges['7d'].days.at(-1).contributors.items[0].tokenCost.pricedTokens = 11,
        (s: any) => s.ranges['7d'].days.at(-1).contributors.items[0].models[0].tokenCost.usd = -1,
    ]) {
        const value = snapshot();
        mutate(value);
        expect(parseUsageCollectionResult({ type: 'usage', version: 1, snapshot: value })).toBeNull();
    }
    const unavailable = snapshot() as any;
    unavailable.ranges['7d'].days[0].contributors.state = 'unavailable';
    expect(parseUsageCollectionResult({ type: 'usage', version: 1, snapshot: unavailable })?.type).toBe('usage');
});


test('All rejects missing history, unordered buckets, illegal bucket sizes, and contributor payloads', () => {
    for (const mutate of [
        (s: any) => { delete s.ranges.all; },
        (s: any) => { s.ranges.all.bucketDays = 0; },
        (s: any) => { s.ranges.all.bucketDays = 1.5; },
        (s: any) => { s.ranges.all.bucketDays = Number.MAX_SAFE_INTEGER; },
        (s: any) => { s.ranges['7d'].bucketDays = 1; },
        (s: any) => { s.ranges.all.days.push(structuredClone(s.ranges.all.days[0])); },
        (s: any) => { s.ranges.all.days[0].date = '2026-09-14'; },
        (s: any) => { s.ranges.all.startInclusive = '2026-09-12T00:00:00.000Z'; },
        (s: any) => { s.ranges.all.days[0].contributors = structuredClone(s.ranges['7d'].days.at(-1).contributors); },
    ]) {
        const value = snapshot();
        mutate(value);
        expect(parseUsageCollectionResult({ type: 'usage', version: 1, snapshot: value })).toBeNull();
    }
});


test('validates hourly token and daily outcome reconciliation at the boundary', () => {
    for (const mutate of [
        (s: any) => { delete s.ranges['7d'].days[0].hourlyTokens; },
        (s: any) => { s.ranges['7d'].days.at(-1).hourlyTokens[12]++; },
        (s: any) => { s.ranges['7d'].days.at(-1).hourlyTokens.pop(); },
        (s: any) => { s.ranges['7d'].days.at(-1).hourlyTokens[12] = -1; },
        (s: any) => { s.ranges['7d'].days.at(-1).hourlyTokens[12] = 0; s.ranges['7d'].days.at(-1).hourlyTokens[13] = 10; },
        (s: any) => { s.ranges['30d'].days.at(-1).hourlyTokens = s.ranges['7d'].days.at(-1).hourlyTokens; },
        (s: any) => { delete s.ranges.all.days[0].results; },
        (s: any) => { s.ranges.all.days[0].errors = 3; },
        (s: any) => { s.ranges.all.days[0].results = 3; },
        (s: any) => { s.ranges['7d'].days.at(-1).errors = 0; },
    ]) {
        const value = snapshot();
        mutate(value);
        expect(parseUsageCollectionResult({ type: 'usage', version: 1, snapshot: value })).toBeNull();
    }
});
