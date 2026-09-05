/**
 * The one storage codec every renderer-local view preference is written in, and
 * the one Provider body they all had.
 *
 * THE ENVELOPE IS FROZEN. A preference is `{"version": 1, "<field>": value}`
 * under a `catcode.`-prefixed key in this renderer's own `localStorage`. Those
 * records are the operator's live saved preferences; the key, the field name and
 * the shape are what already sits on disk, so a module may change its validator
 * or its default but never those three.
 *
 * Reading is total: no storage, no record, unparseable JSON, a non-object, a
 * version that is not 1, or a field the validator rejects all mean the same
 * thing — null, and the caller falls back to its default. Nothing here throws
 * and nothing guesses at a half-understood record.
 *
 * Writing is best-effort. A storage failure (quota, a private window, a
 * locked-down renderer) is swallowed: view persistence must never be able to
 * affect live session or control-plane state.
 *
 * Preferences with a MULTI-FIELD envelope keep their own codec:
 * `workspaceLayout.ts` writes three fields and clears the key when the layout
 * empties, which is a different contract, not this one with a longer argument
 * list.
 */

import { useCallback, useState } from 'react'

/**
 * The storage surface a preference needs, narrowed to two calls so a test can
 * drive the real read/write path with a `Map` and no DOM.
 */
export type ViewPreferenceStorage = Pick<Storage, 'getItem' | 'setItem'>

/**
 * The stored value of `field`, or null when there is nothing valid to read.
 * `accept` is the preference's own validator and is the only part that differs
 * between one preference and the next.
 */
export function readViewPreference<T>(
  storage: ViewPreferenceStorage | null,
  key: string,
  field: string,
  accept: (value: unknown) => T | null,
): T | null {
  if (!storage) return null
  try {
    const raw = storage.getItem(key)
    if (!raw) return null
    const value = JSON.parse(raw) as Record<string, unknown> | null
    if (typeof value !== 'object' || value === null) return null
    if (value.version !== 1) return null
    return accept(value[field])
  } catch {
    return null
  }
}

export function writeViewPreference(
  storage: ViewPreferenceStorage | null,
  key: string,
  field: string,
  value: unknown,
): void {
  if (!storage) return
  try {
    storage.setItem(key, JSON.stringify({ version: 1, [field]: value }))
  } catch {
    // Renderer-owned view persistence is best-effort; a storage failure must not
    // affect the live session/control-plane state.
  }
}

/** This renderer's own storage, or null under SSR or a renderer that refuses
 * `localStorage` (a private window, a thumbnail capture). */
export function defaultViewPreferenceStorage(): ViewPreferenceStorage | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

/**
 * The state half of every preference Provider: seed from storage once, and write
 * through on each set.
 *
 * `storage` is the Provider's own optional prop — `undefined` means "use the
 * renderer's", and an explicit `null` means "persist nothing", which is how a
 * test drives the path without touching globals.
 *
 * The setter is stable while the store is, so the Providers' memoized context
 * values change identity only when the preference itself does.
 */
export function useViewPreference<T>(
  storage: ViewPreferenceStorage | null | undefined,
  read: (storage: ViewPreferenceStorage | null) => T | null,
  write: (storage: ViewPreferenceStorage | null, value: T) => void,
  fallback: T,
): [T, (next: T) => void] {
  const store = storage === undefined ? defaultViewPreferenceStorage() : storage
  const [value, setValue] = useState<T>(() => read(store) ?? fallback)
  const set = useCallback(
    (next: T) => {
      setValue(next)
      write(store, next)
    },
    [store, write],
  )
  return [value, set]
}
