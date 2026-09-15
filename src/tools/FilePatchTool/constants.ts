/** Canonical tool name emitted by current schemas and prompts. */
export const FILE_PATCH_TOOL_NAME = 'apply_patch'

/** Historical tool name retained for transcript and permission compatibility. */
export const LEGACY_FILE_PATCH_TOOL_NAME = 'Apply_patch'

/** True for both current and historical persisted patch tool names. */
export function isFilePatchToolName(
  name: unknown,
): name is typeof FILE_PATCH_TOOL_NAME | typeof LEGACY_FILE_PATCH_TOOL_NAME {
  return name === FILE_PATCH_TOOL_NAME || name === LEGACY_FILE_PATCH_TOOL_NAME
}

export const PATCH_BEGIN_MARKER = '*** Begin Patch'
export const PATCH_END_MARKER = '*** End Patch'
export const UPDATE_FILE_PREFIX = '*** Update File: '
export const ADD_FILE_PREFIX = '*** Add File: '
export const DELETE_FILE_PREFIX = '*** Delete File: '
export const MOVE_TO_PREFIX = '*** Move to: '
export const HUNK_HEADER_PREFIX = '@@'
export const END_OF_FILE_MARKER = '*** End of File'
export const NO_NEWLINE_MARKER = '\\ No newline at end of file'
