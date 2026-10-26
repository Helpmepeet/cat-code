import type { UsageCategory } from './usageDashboard.js';

export function isRetiredUsageModel(model: UsageCategory): boolean {
    return model.kind === 'named' && /^gpt-5\.6-(?:sol|luna|terra)(?:-|$)/i.test(model.label);
}

export function isCurrentSolLunaUsageModel(model: UsageCategory): boolean {
    return model.kind === 'named' && /^gpt-6-(?:sol|luna)(?:-|$)/i.test(model.label);
}

export function isCurrentUsageModel(model: UsageCategory): boolean {
    return model.kind === 'named' && /^gpt-(?:6-astra|6\.1-(?:sol|terra)|6-luna)(?:-|$)/i.test(model.label);
}
