import { expect, test } from 'bun:test';
import { usageProjectId, type UsageSessionContributor } from '../../shared/usageDashboard.js';
import { findUsageSessionRow } from './usageSessionNavigation.js';
import { usageCompact } from './usageDashboardState.js';

const contributor: UsageSessionContributor = {
    id: 'a', engineSessionId: 'session', project: { id: usageProjectId('/work/project'), label: 'project' },
    tokens: { fresh: 1, read: 0, write: 0, output: 0 }, requests: 0, results: 0, errors: 0,
    models: [], modelDetail: { state: 'full', omitted: 0 },
    timeline: { state: 'unavailable', omitted: 0, items: [] },
};
test('session attribution joins project and session, never the first imported copy', () => {
    const correct = { sessionId: 'session', cwd: '/work/project' };
    const other = { sessionId: 'session', cwd: '/work/other' };
    expect(findUsageSessionRow(contributor, [other, correct])).toBe(correct);
    expect(findUsageSessionRow(contributor, [other])).toBeNull();
    expect(findUsageSessionRow(contributor, [correct, { ...correct }])).toBeNull();
    expect(findUsageSessionRow({ ...contributor, project: null }, [correct, other])).toBeNull();
    expect(findUsageSessionRow({ ...contributor, engineSessionId: null }, [correct])).toBeNull();
});
test('large usage totals have readable units without losing exact small values', () => {
    expect(usageCompact(1671100000)).toBe('1.67B');
    expect(usageCompact(42429909)).toBe('42.4M');
    expect(usageCompact(999)).toBe('999');
});
