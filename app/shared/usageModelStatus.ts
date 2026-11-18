import { getCodexUsageStatus } from '../../src/utils/model/configs.js';
import type { UsageCategory } from './usageDashboard.js';

export function isRetiredUsageModel(model: UsageCategory): boolean {
    return model.kind === 'named' && getCodexUsageStatus(model.label).retired;
}

export function isCurrentSolLunaUsageModel(model: UsageCategory): boolean {
    return model.kind === 'named' && getCodexUsageStatus(model.label).legacySolLuna;
}

export function isCurrentUsageModel(model: UsageCategory): boolean {
    return model.kind === 'named' && getCodexUsageStatus(model.label).current;
}
