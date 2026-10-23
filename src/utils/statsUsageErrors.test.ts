import { expect, test } from 'bun:test';
import { usageToolErrorCategory, usagePatchMechanisms } from './statsUsageErrors.js';

const envelope = (codes: string[]) => `<tool_use_error>${JSON.stringify({ type: 'file_patch_error', failures: codes.map(code => ({ code, path: 'PRIVATE_PATH', message: 'PRIVATE_CONTENT' })) })}</tool_use_error>`;
test('patch mechanisms are closed call-level flags with no retained prefixes', () => {
    const placement = { forwardMatchCount: 3, reordered: true, indentationAdjustment: { from: '\t', to: '  ' } };
    expect(usagePatchMechanisms({}, { files: [{ placements: [placement, placement] }, { placements: [placement] }] })).toEqual(['forward-match', 'hunk-reorder', 'indentation-adjustment']);
    expect(usagePatchMechanisms({}, { files: [{ placements: [{ forwardMatchCount: 1, reordered: 'true', indentationAdjustment: { from: 'PRIVATE_TEXT', to: '' } }] }] })).toEqual([]);
});
test('patch categories use the primary retained failure exactly once', () => {
    for (const [code, category] of Object.entries({ PATCH_ANCHOR_AMBIGUOUS: 'ambiguity', PATCH_ANCHOR_NOT_FOUND: 'text-not-found', PATCH_ANCHOR_NONCONSECUTIVE: 'nonconsecutive-context', PATCH_ORDER_CONFLICT: 'order-conflict', PATCH_PLANNER_LIMIT: 'planner-limit', INVALID_PATCH_FORMAT: 'malformed-patch', UNKNOWN: 'other' } as const)) {
        expect(usageToolErrorCategory({ content: envelope([code, 'PATCH_ANCHOR_AMBIGUOUS']) })).toBe(category);
        expect(usageToolErrorCategory({}, { type: 'file_patch_error', code: 'PATCH_PREFLIGHT_FAILED', details: [{ code }, { code: 'PATCH_ANCHOR_AMBIGUOUS' }] })).toBe(category);
    }
    expect(usageToolErrorCategory({ content: envelope(['PATCH_ANCHOR_AMBIGUOUS']) }, { type: 'validation_error', meta: { type: 'file_patch_error', code: 'INVALID_PATCH_FORMAT', details: [] } })).toBe('malformed-patch');
    expect(usageToolErrorCategory({ content: envelope(['constructor', 'PATCH_ANCHOR_AMBIGUOUS']) })).toBe('other');
});
test('only bounded known envelopes and exact owned denial/cancellation messages classify', () => {
    for (const content of ['grep exited with code 1', 'PATCH_ANCHOR_AMBIGUOUS', 'Permission denied', `<tool_use_error>{broken}</tool_use_error>`, `prefix${envelope(['PATCH_ANCHOR_AMBIGUOUS'])}`, envelope(['PATCH_ANCHOR_AMBIGUOUS']) + 'x'.repeat(17000), '<tool_use_error>{"type":"other","code":"PATCH_ANCHOR_AMBIGUOUS"}</tool_use_error>']) {
        expect(usageToolErrorCategory({ content })).toBe('other');
    }
    expect(usageToolErrorCategory({ content: 'Permission for this action has been denied. Reason: private' })).toBe('permission-denied');
    expect(usageToolErrorCategory({ content: '[Request interrupted by user]' })).toBe('interrupted');
    expect(usageToolErrorCategory({ content: [{ type: 'text', text: envelope(['PATCH_PLANNER_LIMIT']) }] })).toBe('planner-limit');
    expect(usageToolErrorCategory({
        content: '<tool_use_error>Tool input preparation failed: Patch must end with "*** End Patch": wrap the entire patch in "*** Begin Patch" ... "*** End Patch".</tool_use_error>',
    })).toBe('malformed-patch');
});
