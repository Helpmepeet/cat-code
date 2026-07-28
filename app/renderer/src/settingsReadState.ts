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

/**
 * The unread case WITH a session attached — a genuinely different fact, and the
 * one the note above got wrong.
 *
 * A null snapshot is not proof that no session exists: the spawn-time read can
 * throw (no frame is ever sent, so a running session stays unread forever), the
 * attach window has not delivered one yet, and a process reset clears the one
 * already held. Saying "No session is open" in any of those denies a session the
 * operator is looking at.
 *
 * No follow-on directive, on purpose: those three cases want different actions
 * and this surface cannot tell them apart, so it states the fact rather than
 * guessing at the remedy.
 */
export const SETTINGS_UNREAD_WITH_SESSION_NOTE =
  'Your settings files have not been read for this session yet.'

/**
 * Which of the two sentences applies. `sessionOpen` is the SHELL's knowledge (it
 * holds the focused session's cwd) and is deliberately independent of whether a
 * snapshot arrived — that independence is the whole point.
 *
 * `noSessionDirective` is appended only to the no-session sentence, because a
 * pane's "Open a session to …" advice is true there and false the moment one is
 * already open.
 */
export function settingsUnreadNote(
  sessionOpen: boolean,
  noSessionDirective?: string,
): string {
  if (sessionOpen) return SETTINGS_UNREAD_WITH_SESSION_NOTE
  return noSessionDirective
    ? `${SETTINGS_UNREAD_NOTE} ${noSessionDirective}`
    : SETTINGS_UNREAD_NOTE
}

/** The value shown where a read value would go — never an empty or zero-ish
 * placeholder, which reads as a real answer. */
export const SETTINGS_UNKNOWN_VALUE = 'unknown'
