import { createHash } from 'node:crypto';
import type { UsageCategory } from '../../app/shared/usageDashboard.js';
/** Labels are bounded independently of identity; truncated names remain distinguishable. */
export function usageCategory(name: string | null): UsageCategory {
    if (name === null)
        return { id: 'unknown', kind: 'unknown', label: 'Unknown' };
    const id = createHash('sha256').update(name).digest('hex');
    const clean = name.replace(/[\u0000-\u001f\u007f]/g, ' ');
    const suffix = Buffer.byteLength(clean) > 160 ? `… ${id.slice(0, 8)}` : '';
    let label = '';
    for (const char of clean) {
        if (Buffer.byteLength(label + char + suffix) > 160)
            break;
        label += char;
    }
    return { id, kind: 'named', label: (label || 'Unnamed') + suffix };
}
