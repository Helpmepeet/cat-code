import { expect, test } from 'bun:test';
import { UsageFailure, classifyEscapedError, classifyStorageError, publicCodeForFailure, sqliteCodeOf, USAGE_FAILURE_REASONS } from './statsFailure.js';

const sqlite = (code: string) => Object.assign(new Error('injected'), { code });

test('only SQLITE_FULL is capacity; every other SQLite code is a storage failure carrying its code', () => {
    expect(classifyStorageError(sqlite('SQLITE_FULL'), 'index', 'm', 'index-pages')).toMatchObject({ reason: 'storage-capacity', phase: 'index', detail: { sqliteCode: 'SQLITE_FULL', guard: 'index-pages' } });
    for (const code of ['SQLITE_IOERR', 'SQLITE_BUSY', 'SQLITE_READONLY', 'SQLITE_PERM', 'SQLITE_CANTOPEN'])
        expect(classifyStorageError(sqlite(code), 'replay', 'm')).toMatchObject({ reason: 'storage-failure', detail: { sqliteCode: code } });
    expect(classifyStorageError(new Error('plain'), 'replay', 'm')).toMatchObject({ reason: 'storage-failure', detail: {} });
});

test('an unvalidated error code is never copied into a diagnostic', () => {
    expect(sqliteCodeOf(sqlite('SQLITE_IOERR_SHORT_READ'))).toBe('SQLITE_IOERR_SHORT_READ');
    for (const code of ['sqlite_full', 'ENOENT', 'SQLITE_/etc/passwd', `SQLITE_${'A'.repeat(60)}`, 'SQLITE_'])
        expect(sqliteCodeOf(sqlite(code))).toBeUndefined();
    expect(sqliteCodeOf(null)).toBeUndefined();
    expect(sqliteCodeOf({ code: 5 })).toBeUndefined();
});

test('already typed failures pass through; untyped non-SQLite errors stay untyped', () => {
    const typed = new UsageFailure('x', 'deadline', 'replay');
    expect(classifyStorageError(typed, 'index', 'm')).toBe(typed);
    expect(classifyEscapedError(typed, 'index')).toBe(typed);
    const plain = new Error('boom');
    expect(classifyEscapedError(plain, 'index')).toBe(plain);
    expect(classifyEscapedError(sqlite('SQLITE_FULL'), 'finalize')).toMatchObject({ reason: 'storage-capacity', phase: 'finalize', message: 'Usage index storage limit' });
    expect(classifyEscapedError(sqlite('SQLITE_BUSY'), 'index')).toMatchObject({ reason: 'storage-failure', detail: { sqliteCode: 'SQLITE_BUSY' } });
});

test('public codes keep their existing meaning', () => {
    expect(Object.fromEntries(USAGE_FAILURE_REASONS.map(reason => [reason, publicCodeForFailure(reason)]))).toEqual({
        'discovery-limit': 'resource-limit', 'state-budget': 'resource-limit', 'storage-capacity': 'resource-limit',
        deadline: 'timeout', 'storage-failure': 'collection', unexpected: 'collection',
    });
});
