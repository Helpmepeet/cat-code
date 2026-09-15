/**
 * The two storage stand-ins every view-preference suite needs, written once.
 *
 * Each preference module reads and writes through the one codec in
 * `viewPreference.ts`, whose storage surface is narrowed to `getItem`/`setItem`
 * so a test can drive the real path with a `Map` and no DOM. Roughly twenty
 * suites had hand-rolled that `Map` and the throwing counterpart that proves the
 * codec swallows a locked-down renderer; these are those two objects.
 *
 * `removeItem` is present on both because `workspaceLayout.ts` clears its key
 * when the layout empties. No other preference calls it, so for every other
 * suite it is an unreached method rather than a behaviour change.
 *
 * Import this from a test file only.
 */

import type { ViewPreferenceStorage } from './viewPreference.js'

/** A `Map`-backed storage whose backing map is readable as `map`. */
export type MemoryViewPreferenceStorage = ViewPreferenceStorage &
  Pick<Storage, 'removeItem'> & { map: Map<string, string> }

export function memoryStorage(
  seed: Record<string, string> = {},
): MemoryViewPreferenceStorage {
  const map = new Map(Object.entries(seed))
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  }
}

/**
 * A storage whose every accessor throws — the private-window / thumbnail-capture
 * case, where reading `localStorage` at all raises. `message` is never observed
 * by a caller (the codec catches and discards), and exists so a suite can keep
 * naming the failure it had in mind.
 */
export function throwingStorage(
  message = 'denied',
): ViewPreferenceStorage & Pick<Storage, 'removeItem'> {
  const fail = (): never => {
    throw new Error(message)
  }
  return { getItem: fail, setItem: fail, removeItem: fail }
}
