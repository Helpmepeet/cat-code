function reduceBookmarks(state: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(state)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}

export function createTranscriptOutlineBookmarks() {
  let bookmarks: ReadonlySet<string> = new Set()
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => bookmarks,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    toggle: (id: string) => {
      bookmarks = reduceBookmarks(bookmarks, id)
      for (const listener of listeners) listener()
    },
  }
}

// Panes unmount on tab switches. Keep only stable prompt IDs for this window,
// never prompt content, and deliberately do not write bookmarks to disk.
export const transcriptOutlineBookmarks = createTranscriptOutlineBookmarks()
