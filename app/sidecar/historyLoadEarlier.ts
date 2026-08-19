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
 * steer which file is read or how much of it. The verb that reaches here carries
 * only a correlation id, and that is the whole point of it being parameterless.
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
  MAX_HISTORY_LOAD_EARLIER_MESSAGES,
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
}

/** The seam the sidecar server calls. Defaulted to the real read below. */
export type HistoryLoadEarlierReader = (
  onError?: (message: string) => void,
) => Promise<EarlierHistoryRead>

export const readEarlierDisplayHistory: HistoryLoadEarlierReader = async (
  onError?: (message: string) => void,
): Promise<EarlierHistoryRead> => {
  const display = await loadDisplayTranscriptFromJsonlPath(getTranscriptPath(), {
    // No count cap by decision: the measured corpus never comes near one, so a
    // count here could only truncate a session the byte budget already fits.
    maxMessages: MAX_HISTORY_LOAD_EARLIER_MESSAGES,
    maxBytes: MAX_HISTORY_LOAD_EARLIER_BYTES,
  })
  const history = projectResumedHistory(display.messages)
  // Same splice restore performs, for the same reason: a recovered Agent card
  // with no child rows is a card the operator cannot read. Its own frame budget
  // is unchanged, so a transcript already at the replay cap recovers its parent
  // rows without their branches rather than growing an unbounded second read.
  const messages = await withRestoredSubagentHistory(
    getSessionId(),
    history,
    onError,
  )
  return { messages, truncated: display.truncated }
}
