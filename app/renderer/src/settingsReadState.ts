/**
 * One rule for the whole Settings surface: whether any settings file has been
 * read at all.
 *
 * A snapshot may come from the session-independent settings inventory or a
 * session-specific read. A null snapshot does NOT mean "read, and the answer
 * is nothing" — it means no settings values are available to that pane.
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
 * A neutral unread explanation. The caller knows whether a read is in flight;
 * this helper cannot infer that from a null snapshot.
 */
export const SETTINGS_UNREAD_NOTE =
  'Settings files have not been read for this configuration.'

/**
 * The unread case for a session-specific view.
 *
 * A null snapshot is not proof that no session exists: the spawn-time read can
 * throw, the attach window has not delivered one yet, or a process reset may
 * have cleared a previously held snapshot.
 *
 * No follow-on directive, on purpose: those three cases want different actions
 * and this surface cannot tell them apart, so it states the fact rather than
 * guessing at the remedy.
 */
export const SETTINGS_UNREAD_WITH_SESSION_NOTE =
  'Your settings files have not been read for this session yet.'

/**
 * Which of the two sentences applies. `sessionOpen` is the caller's knowledge
 * and is independent of whether a snapshot arrived.
 *
 * `noSessionDirective` is used only by session-specific views that genuinely
 * require a session. Durable settings panes do not pass one.
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
