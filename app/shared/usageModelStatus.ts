import type { UsageCategory } from './usageDashboard.js';

export function isRetiredUsageModel(model: UsageCategory): boolean {
    return model.kind === 'named' && /^gpt-5\.6-(?:sol|luna)(?:-|$)/i.test(model.label);
}

export function isCurrentSolLunaUsageModel(model: UsageCategory): boolean {
    return model.kind === 'named' && /^gpt-6-(?:sol|luna)(?:-|$)/i.test(model.label);
}
