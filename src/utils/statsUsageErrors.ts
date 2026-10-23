import { USAGE_TOOL_ERROR_CATEGORIES, type UsageToolErrorCategory } from '../../app/shared/usageDashboard.js';
import { USAGE_PATCH_MECHANISMS, type UsagePatchMechanism } from '../../app/shared/usageDashboard.js';

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const codes: Readonly<Record<string, UsageToolErrorCategory>> = {
    PATCH_ANCHOR_AMBIGUOUS: 'ambiguity',
    PATCH_ANCHOR_NOT_FOUND: 'text-not-found',
    PATCH_HINT_NOT_FOUND: 'text-not-found',
    PATCH_ANCHOR_NONCONSECUTIVE: 'nonconsecutive-context',
    PATCH_ORDER_CONFLICT: 'order-conflict',
    PATCH_PLANNER_LIMIT: 'planner-limit',
    INVALID_PATCH_ENVELOPE: 'malformed-patch',
    INVALID_PATCH_FORMAT: 'malformed-patch',
    DUPLICATE_PATCH_PATH: 'malformed-patch',
    EMPTY_PATCH: 'malformed-patch',
};
export function isUsageToolErrorCategory(value: unknown): value is UsageToolErrorCategory {
    return typeof value === 'string' && (USAGE_TOOL_ERROR_CATEGORIES as readonly string[]).includes(value);
}
function patchCategory(value: unknown): UsageToolErrorCategory | null {
    if (!object(value) || value.type !== 'file_patch_error') return null;
    // One call, one primary cause: first retained per-file failure, then top-level
    // code. Unknown primary failures stay other rather than borrowing a later cause.
    const failures = Array.isArray(value.details) && value.details.length ? value.details : value.failures;
    const primary = Array.isArray(failures) && failures.length ? failures[0] : value;
    return object(primary) && typeof primary.code === 'string' && Object.hasOwn(codes, primary.code) ? codes[primary.code]! : 'other';
}
/** Count calls, not files or hunks. Prefixes and source coordinates never escape. */
export function usagePatchMechanisms(block: Record<string, unknown>, retained?: unknown): UsagePatchMechanism[] {
    const projected = block.usage_patch_mechanisms;
    if (Array.isArray(projected)) return USAGE_PATCH_MECHANISMS.filter(mechanism => projected.includes(mechanism));
    if (!object(retained) || !Array.isArray(retained.files)) return [];
    const found = new Set<UsagePatchMechanism>();
    for (const file of retained.files) {
        if (!object(file) || !Array.isArray(file.placements)) continue;
        for (const placement of file.placements) {
            if (!object(placement)) continue;
            if (typeof placement.forwardMatchCount === 'number' && Number.isSafeInteger(placement.forwardMatchCount) && placement.forwardMatchCount > 1) found.add('forward-match');
            if (placement.reordered === true) found.add('hunk-reorder');
            const indent = placement.indentationAdjustment;
            if (object(indent) && typeof indent.from === 'string' && typeof indent.to === 'string' && indent.from !== indent.to && /^[\t ]*$/.test(indent.from) && /^[\t ]*$/.test(indent.to)) found.add('indentation-adjustment');
        }
    }
    return USAGE_PATCH_MECHANISMS.filter(mechanism => found.has(mechanism));
}
/** Project only an enum. Never retain raw result bodies or diagnostic paths. */
export function usageToolErrorCategory(block: Record<string, unknown>, retained?: unknown): UsageToolErrorCategory {
    if (isUsageToolErrorCategory(block.usage_error_category)) return block.usage_error_category;
    const structured = patchCategory(retained) ?? (object(retained) && retained.type === 'validation_error' ? patchCategory(retained.meta) : null);
    if (structured) return structured;
    const content = typeof block.content === 'string' ? block.content
        : Array.isArray(block.content) && block.content.length === 1 && object(block.content[0]) && block.content[0].type === 'text' && typeof block.content[0].text === 'string' ? block.content[0].text : null;
    if (!content || content.length > 16_384) return 'other';
    if (content.startsWith('Permission for this action has been denied. Reason: ') ||
        content.startsWith('Permission for this tool use was denied. The tool use was rejected ') ||
        content.startsWith("The user doesn't want to proceed with this tool use. The tool use was rejected ")) return 'permission-denied';
    if (content === '[Request interrupted by user]' || content === '[Request interrupted by user for tool use]' ||
        content === "The user doesn't want to take this action right now. STOP what you are doing and wait for the user to tell you how to proceed.") return 'interrupted';
    if (content.startsWith('<tool_use_error>Tool input preparation failed: Patch must end with "*** End Patch"') &&
        content.endsWith('</tool_use_error>')) return 'malformed-patch';
    const match = /^<tool_use_error>(\{[\s\S]*\})<\/tool_use_error>$/.exec(content);
    if (!match) return 'other';
    try { return patchCategory(JSON.parse(match[1]!)) ?? 'other'; } catch { return 'other'; }
}
