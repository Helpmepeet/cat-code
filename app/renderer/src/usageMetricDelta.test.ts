import { expect, test } from 'bun:test';
import { usageMetricDelta } from './usageMetricDelta.js';

test('count deltas compare against the baseline, including a fall to zero', () => {
    expect(usageMetricDelta(1200, 1000)?.text).toBe('▲ 20%');
    expect(usageMetricDelta(750, 1000)?.text).toBe('▼ 25%');
    expect(usageMetricDelta(0, 1000)?.text).toBe('▼ 100%');
    expect(usageMetricDelta(1000, 1000)?.text).toBe('0%');
    expect(usageMetricDelta(1000.01, 1000)?.direction).toBe('flat');
});
test('cache shares use percentage points, including a measured zero baseline', () => {
    expect(usageMetricDelta(95, 90, 'points')?.text).toBe('▲ 5 pp');
    expect(usageMetricDelta(90, 95, 'points')?.description).toBe('5 percentage points decrease');
    expect(usageMetricDelta(5, 0, 'points')?.text).toBe('▲ 5 pp');
    expect(usageMetricDelta(null, 90, 'points')).toBeNull();
});
test('unknown, zero and invalid count baselines never fabricate a percentage', () => {
    for (const baseline of [0, null, NaN, Infinity, -1]) expect(usageMetricDelta(100, baseline)).toBeNull();
    for (const current of [null, NaN, Infinity, -1]) expect(usageMetricDelta(current, 100)).toBeNull();
    expect(usageMetricDelta(0, 0)).toBeNull();
});
