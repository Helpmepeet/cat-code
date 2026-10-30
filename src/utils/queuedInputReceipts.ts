import { isHandoffUuid } from '../../app/shared/workspaceHandoff.js'

export const MAX_INPUT_BATCH_SIZE = 32

/** A receipt is bound to the actual combined input, not a free-standing UUID list. */
export function isAcceptedInputBatch(value: unknown, inputUuid: unknown): value is string[] {
  return Array.isArray(value) && value.length > 1 && value.length <= MAX_INPUT_BATCH_SIZE &&
    value.every(isHandoffUuid) && new Set(value).size === value.length && value.includes(inputUuid)
}
