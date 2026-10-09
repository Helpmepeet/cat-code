import { MAX_HISTORY_REPLAY_FRAMES, MAX_TEXT_FIELD_CHARS } from './limits.js'

/** Display metadata shares the replay's parent-count and text bounds. */
export function isUnavailableParentToolUseIds(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= MAX_HISTORY_REPLAY_FRAMES &&
    value.every(id => typeof id === 'string' && id.length > 0 && id.length <= MAX_TEXT_FIELD_CHARS)
}
