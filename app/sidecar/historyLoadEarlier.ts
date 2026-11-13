/**
 * The deeper transcript read behind `history.loadEarlier`
 * (decisions/HISTORY-LOAD-EARLIER.md).
 *
 * This is NOT a second history loader (CLAUDE.md §8 rule 10). It calls the same
 * engine entry point the restore path already calls — `index.ts:271-299` reads
 * `loadDisplayTranscriptFromJsonlPath` under the `MAX_HISTORY_REPLAY_*` caps,
 * this one calls it under the load-earlier ceiling — and then reuses the same
 * `projectResumedHistory` projection and the same `withRestoredSubagentHistory`
 * splice. Everything the display loader already owns (the compaction seam, the
 * `logicalParentUuid` walk, the sidechain exclusion) is inherited rather than
 * reimplemented, and no engine change is required.
 *
 * WHAT IT DELIBERATELY DOES NOT TAKE: a path, an offset, a count, a session.
 * The transcript is resolved from the engine's OWN live session identity
 * (`getTranscriptPath()` / `getSessionId()`), so no byte of an inbound frame can
 * steer which file is read or how much of it. The verb that reaches the server
 * carries no read budget. The sidecar selects a bounded read tier and supplies
 * the view anchor only to avoid loading branches in the already-held tail.
 * Active-branch selection still runs over the whole bounded parent read.
 *
 * The seed merge that restore performs (`mergeDisplayHistoryWithSeed`) is
 * deliberately absent: that alignment exists to keep the VISIBLE TAIL identical
 * to the engine's compacted seed, and the tail is precisely the part this read
 * discards. What is wanted here is the archival prefix, which is what the
 * display projection alone produces.
 */

import type { SDKMessage } from '../../src/entrypoints/agentSdkTypes.js'
import { getSessionId } from '../../src/bootstrap/state.js'
import {
  getTranscriptPath,
  loadDisplayTranscriptFromJsonlPath,
} from '../../src/utils/sessionStorage.js'

import {
  MAX_HISTORY_LOAD_EARLIER_BYTES,
  MAX_HISTORY_LOAD_EARLIER_EXPANDED_BYTES,
  MAX_HISTORY_LOAD_EARLIER_MESSAGES,
  MAX_HISTORY_REPLAY_BYTES,
  MAX_HISTORY_REPLAY_FRAMES,
} from '../shared/limits.js'
import { projectResumedHistory } from './historyProjection.js'
import { withRestoredSubagentHistory } from './subagentHistory.js'

/** One deeper read of this session's display transcript. */
export type EarlierHistoryRead = {
  /** Oldest first, in display order, subagent branches already spliced in. */
  messages: SDKMessage[]
  /**
   * The loader's own `truncated`: true when the ceiling stopped the read short
   * of the transcript's head, so something still remains above this. Passed
   * through rather than re-derived, because the loader is the only party that
   * knows whether the root it returned had a predecessor it could not reach.
   */
  truncated: boolean
  /** Reachable worker cards whose saved steps could not fit or be read. */
  unavailableParentToolUseIds?: string[]
}

/** The seam the sidecar server calls. Defaulted to the real read below. */
export type HistoryLoadEarlierReader = (
  onError?: (message: string) => void,
  options?: { maxBytes: number; beforeUuid: string | null },
) => Promise<EarlierHistoryRead>

export const readEarlierDisplayHistory: HistoryLoadEarlierReader = async (
  onError?: (message: string) => void,
  options?: { maxBytes: number; beforeUuid: string | null },
): Promise<EarlierHistoryRead> => {
  const maxBytes = options?.maxBytes ?? MAX_HISTORY_LOAD_EARLIER_BYTES
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 ||
      maxBytes > MAX_HISTORY_LOAD_EARLIER_EXPANDED_BYTES) {
    throw new Error('Invalid display history read budget')
  }
  const display = await loadDisplayTranscriptFromJsonlPath(getTranscriptPath(), {
    // No count cap by decision: the measured corpus never comes near one, so a
    // count here could only truncate a session the byte budget already fits.
    maxMessages: MAX_HISTORY_LOAD_EARLIER_MESSAGES,
    maxBytes,
  })
  const history = projectResumedHistory(display.messages)
  const anchorIndex = options?.beforeUuid
    ? history.findIndex(message => message.uuid === options.beforeUuid)
    : history.length
  // An absent anchor cannot establish a missing prefix. Return parents only
  // so the server can widen the read without scanning unrelated worker files.
  if (anchorIndex < 0) return { messages: history, truncated: display.truncated }
  const restored = await withRestoredSubagentHistory(
    getSessionId(),
    history.slice(0, anchorIndex),
    onError,
    { frames: MAX_HISTORY_REPLAY_FRAMES, bytes: MAX_HISTORY_REPLAY_BYTES },
  )
  return {
    messages: [...restored.history, ...history.slice(anchorIndex)],
    truncated: display.truncated,
    unavailableParentToolUseIds: restored.unavailableParentToolUseIds,
  }
}
