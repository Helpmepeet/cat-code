/**
 * Shared renderer path helpers. `basename` was copied inline across the shell
 * surfaces (Sidebar / TabBar / WorkspacePanels / debugStateReport); this is the
 * single source of truth. Handles POSIX and Windows separators and trims any
 * trailing slashes ('/a/b/' → 'b'); returns '' for a root/empty path.
 */
export function basename(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, '')
  const parts = trimmed.split(/[/\\]/)
  return parts[parts.length - 1] ?? ''
}

/**
 * The leading directory of a path, separator included ('/a/b/c.ts' → '/a/b/'),
 * or '' when there is none.
 *
 * For a path that NAMES A FILE, `dirname(p) + basename(p)` reconstructs `p`,
 * which is what the tool-run rows rely on to dim the directory while leaving the
 * filename at full strength. That identity does NOT hold for a path with a
 * trailing separator ('/a/b/' → '/a/b'): both helpers trim trailing separators
 * first, so the trailing one is lost.
 */
export function dirname(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, '')
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return cut === -1 ? '' : trimmed.slice(0, cut + 1)
}

/**
 * The deepest directory every path shares, separator included, or '' when they
 * share nothing worth hoisting.
 *
 * A grouped run of file paths repeats the same leading directory on every row,
 * which is the width pressure the run exists to relieve — so the head states the
 * shared part once and the rows carry only what differs.
 *
 * Deliberately conservative, because a wrong hoist silently rewrites what a row
 * says its path is. Nothing is hoisted unless there are at least two paths, they
 * all share at least one FULL directory segment, and the result is more than a
 * bare root: '/a.ts' + '/b.ts' share only '/', which is not worth a badge and
 * would make both rows look relative when they are absolute. Comparison is by
 * whole segments, never by characters, so '/app/renderer' and '/app/render' share
 * '/app/' rather than '/app/render'.
 */
export function commonDirPrefix(paths: readonly string[]): string {
  if (paths.length < 2) return ''
  // Strip the trailing separator before splitting, or a path whose whole dirname
  // is shared contributes an empty tail segment and the result gains a second
  // separator ('/a/b/' + '/' → '/a/b//').
  const segments = (path: string): string[] =>
    dirname(path)
      .replace(/[/\\]+$/, '')
      .split(/[/\\]/)

  const first = segments(paths[0] ?? '')
  let shared = first.length
  for (const path of paths.slice(1)) {
    const parts = segments(path)
    let i = 0
    while (i < shared && i < parts.length && first[i] === parts[i]) i += 1
    shared = i
    if (shared === 0) return ''
  }
  // All-empty segments mean a bare root ('/a.ts') or no directory ('a.ts').
  if (first.slice(0, shared).every(segment => segment.length === 0)) return ''

  // Cut the prefix out of the ORIGINAL string rather than rejoining segments, so
  // the path's own separators survive — rejoining with '/' would turn a Windows
  // 'C:\x\y.ts' into 'C:/x/', which then matches nothing downstream.
  const source = paths[0] ?? ''
  let cut = 0
  for (let seen = 0; seen < shared; seen += 1) {
    const next = source.slice(cut).search(/[/\\]/)
    if (next === -1) return ''
    cut += next + 1
  }
  const prefix = source.slice(0, cut)
  // Segments compare separator-agnostically, but the prefix is cut from ONE path,
  // so a run mixing '/' and '\\' could yield a prefix that matches only some of
  // them. Callers strip this prefix off each path; one that does not start with it
  // would keep its whole path while the head claimed otherwise. Total invariant:
  // the answer prefixes every input, or there is no answer.
  return paths.every(path => path.startsWith(prefix)) ? prefix : ''
}
