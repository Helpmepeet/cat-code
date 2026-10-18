import { expect, test } from 'bun:test';
import { MAX_USAGE_DIAGNOSTIC_LINE_BYTES, USAGE_DIAGNOSTIC_TAG, formatUsageDiagnostic, parseUsageDiagnostic, usageDiagnosticFromError } from './usageDiagnostic.js';
import { UsageFailure } from '../../src/utils/statsFailure.js';

const line = (value: Record<string, unknown>) => `${USAGE_DIAGNOSTIC_TAG} ${JSON.stringify({ v: 1, reason: 'state-budget', phase: 'replay', elapsedMs: 12, ...value })}`;

test('a typed failure round-trips through exactly one tagged line', () => {
    const diagnostic = usageDiagnosticFromError(new UsageFailure('Usage state budget exceeded /Users/me/secret', 'state-budget', 'replay', { guard: 'state-bytes', observed: 70_000_000, limit: 67_108_864, sources: 3200, rows: 16_000 }), 1234.6);
    expect(diagnostic).toEqual({ reason: 'state-budget', phase: 'replay', elapsedMs: 1235, guard: 'state-bytes', observed: 70_000_000, limit: 67_108_864, sources: 3200, rows: 16_000 });
    const formatted = formatUsageDiagnostic(diagnostic);
    expect(formatted).not.toContain('\n');
    expect(formatted).not.toContain('/Users');
    expect(Buffer.byteLength(formatted)).toBeLessThan(MAX_USAGE_DIAGNOSTIC_LINE_BYTES);
    expect(parseUsageDiagnostic(`noise\n${formatted}\nmore noise\n`)).toEqual(diagnostic);
});

test('untyped errors become unexpected and never carry message text', () => {
    expect(usageDiagnosticFromError(new Error('ENOENT /Users/me/.claude/projects/x'), 5)).toEqual({ reason: 'unexpected', phase: 'unknown', elapsedMs: 5 });
    expect(usageDiagnosticFromError(Object.assign(new Error('x'), { code: 'SQLITE_BUSY' }), 5)).toEqual({ reason: 'unexpected', phase: 'unknown', elapsedMs: 5, sqliteCode: 'SQLITE_BUSY' });
    expect(usageDiagnosticFromError('string', Number.NaN)).toEqual({ reason: 'unexpected', phase: 'unknown', elapsedMs: 0 });
});

test('malformed, unrelated, widened or oversized stderr is ignored', () => {
    const bad: string[] = [
        '', 'plain engine warning', `${USAGE_DIAGNOSTIC_TAG} not json`, `${USAGE_DIAGNOSTIC_TAG}{"v":1}`,
        line({ v: 2 }), line({ reason: 'oom' }), line({ phase: '/etc' }), line({ elapsedMs: -1 }), line({ elapsedMs: 1.5 }),
        line({ guard: 'bytes' }), line({ observed: 'many' }), line({ sources: -1 }), line({ rows: '3' }), line({ limit: Number.MAX_SAFE_INTEGER + 2 }),
        line({ sqliteCode: 'SQLITE_/etc/passwd' }), line({ sqliteCode: 'ENOENT' }),
        line({ path: '/Users/me/history.jsonl' }), line({ message: 'raw error text' }),
        `${USAGE_DIAGNOSTIC_TAG} ${'x'.repeat(MAX_USAGE_DIAGNOSTIC_LINE_BYTES)}`,
        line({ sqliteCode: `SQLITE_${'A'.repeat(MAX_USAGE_DIAGNOSTIC_LINE_BYTES)}` }),
        ` ${line({})}`, `[usage-worker] ${line({})}`,
    ];
    for (const stderr of bad) expect(parseUsageDiagnostic(stderr)).toBeNull();
});

test('the first valid line wins and invalid neighbours do not hide it', () => {
    const stderr = [line({ reason: 'oom' }), line({ reason: 'deadline', phase: 'index' }), line({ reason: 'state-budget' })].join('\n');
    expect(parseUsageDiagnostic(stderr)).toMatchObject({ reason: 'deadline', phase: 'index' });
});
