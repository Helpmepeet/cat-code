import { usageProjectId, type UsageSessionContributor } from '../../shared/usageDashboard.js';
import type { MergedSessionRow } from './sessionsCatalogState.js';

/** Never pick the first copy of a session imported into multiple projects. */
export function findUsageSessionRow<T extends Pick<MergedSessionRow, 'sessionId' | 'cwd'>>(contributor: UsageSessionContributor, rows: readonly T[]): T | null {
    if (!contributor.engineSessionId) return null;
    const matches = rows.filter(row => row.sessionId === contributor.engineSessionId &&
        (!contributor.project || usageProjectId(row.cwd) === contributor.project.id));
    return matches.length === 1 ? matches[0]! : null;
}
