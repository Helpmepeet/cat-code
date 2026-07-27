/**
 * One rule for the whole Settings surface: whether any settings file has been
 * read at all.
 *
 * The settings snapshot is keyed by session (`settingsState.ts`
 * `selectSettingsSnapshot`) because settings resolve engine-side and there is
 * no engine without a session (N-process). So a null snapshot does NOT mean
 * "read, and the answer is nothing" — it means the app has opened no settings
 * file whatsoever and knows nothing.
 *
 * Collapsing those two into one empty state is a defect this surface has
 * produced repeatedly and independently: "Default mode: not set" (fixed,
 * `65ba210`), "No managed settings on this machine", "None added", and every
 * editable control rendering enabled and then silently discarding the click.
 * Each was a separate pane forgetting the same distinction, so the distinction
 * lives here once instead of being re-remembered per pane.
 *
 * A pane that reads `snapshot` MUST branch on this before stating any fact
 * about the operator's configuration.
 */

import type { SettingsSnapshot } from '../../shared/protocol.js'

/** `read` = a snapshot arrived, so an empty result is a real answer.
 *  `unread` = no snapshot, so nothing is known and nothing may be asserted. */
export type SettingsReadState = 'read' | 'unread'

export function selectSettingsReadState(
  snapshot: SettingsSnapshot | null,
): SettingsReadState {
  return snapshot ? 'read' : 'unread'
}

/** True when a pane may make a positive statement about the settings files. */
export function settingsWereRead(snapshot: SettingsSnapshot | null): boolean {
  return selectSettingsReadState(snapshot) === 'read'
}

/**
 * The shared explanation for the unread case. Deliberately NOT phrased as
 * "waiting…": with no session attached nothing is in flight and nothing will
 * arrive, so a waiting message would be a second false statement. Panes append
 * their own specific follow-on sentence.
 */
export const SETTINGS_UNREAD_NOTE =
  'No session is open, so your settings files have not been read yet.'

/** The value shown where a read value would go — never an empty or zero-ish
 * placeholder, which reads as a real answer. */
export const SETTINGS_UNKNOWN_VALUE = 'unknown'
