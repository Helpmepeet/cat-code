import { expect, test } from 'bun:test';
import type { UsageCategory } from './usageDashboard.js';
import { isCurrentUsageModel, isRetiredUsageModel } from './usageModelStatus.js';

function named(label: string): UsageCategory {
    return { id: label, kind: 'named', label };
}

test('current Terra replaces historical Terra in usage status', () => {
    for (const label of ['gpt-6.1-terra', 'GPT-6.1-Terra', 'gpt-6.1-terra-20261027']) {
        expect(isCurrentUsageModel(named(label))).toBe(true);
        expect(isRetiredUsageModel(named(label))).toBe(false);
    }
    for (const label of ['gpt-5.6-terra', 'gpt-5.6-terra-20261027']) {
        expect(isCurrentUsageModel(named(label))).toBe(false);
        expect(isRetiredUsageModel(named(label))).toBe(true);
    }
});

test('usage status keeps other current and retired models', () => {
    for (const label of ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-luna']) {
        expect(isCurrentUsageModel(named(label))).toBe(true);
        expect(isRetiredUsageModel(named(label))).toBe(false);
    }
    for (const label of ['gpt-5.6-sol', 'gpt-5.6-luna']) {
        expect(isCurrentUsageModel(named(label))).toBe(false);
        expect(isRetiredUsageModel(named(label))).toBe(true);
    }
});

test('usage status rejects non-named categories and model prefix collisions', () => {
    for (const kind of ['unknown', 'other'] as const) {
        expect(isCurrentUsageModel({ ...named('gpt-6.1-terra'), kind })).toBe(false);
        expect(isRetiredUsageModel({ ...named('gpt-5.6-terra'), kind })).toBe(false);
    }
    expect(isCurrentUsageModel(named('gpt-6.1-terrain'))).toBe(false);
    expect(isRetiredUsageModel(named('gpt-5.6-terrain'))).toBe(false);
});
