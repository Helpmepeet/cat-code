import type { FilePaneScroll } from './filePaneState.js'
import { paneFileKey } from './paneFileKey.js'

export type OpenedPaneFile = { path: string; scroll: FilePaneScroll; aliases: readonly string[] }
export type OpenedPaneFiles = ReadonlyMap<string, OpenedPaneFile>

export function findOpenedFile(opened: OpenedPaneFiles, path: string, cwd: string | null = null): OpenedPaneFile | undefined {
  const key = paneFileKey(path, cwd)
  return opened.get(key) ?? [...opened.values()].find(file => file.aliases.includes(key))
}

/** Insertion order is oldest first; a successful open is the only recency event. */
export function rememberOpenedFile(
  opened: OpenedPaneFiles,
  path: string,
  scroll: FilePaneScroll,
  requestedPath?: string,
  cwd: string | null = null,
): OpenedPaneFiles {
  const key = paneFileKey(path)
  const prior = findOpenedFile(opened, path) ?? (requestedPath ? findOpenedFile(opened, requestedPath, cwd) : undefined)
  const requestedKey = requestedPath ? paneFileKey(requestedPath, cwd) : undefined
  const aliases = [...new Set([...(prior?.aliases ?? []).filter(alias => alias !== key && alias !== requestedKey), key, ...(requestedKey ? [requestedKey] : [])])].slice(-50)
  const next = new Map(opened)
  for (const [oldKey, value] of next) if (oldKey === key || value === prior || value.aliases.some(alias => aliases.includes(alias))) next.delete(oldKey)
  next.set(key, { path, scroll, aliases })
  while (next.size > 50) next.delete(next.keys().next().value!)
  return next
}

export function updateOpenedFileScroll(opened: OpenedPaneFiles, path: string, scroll: FilePaneScroll): OpenedPaneFiles {
  const prior = findOpenedFile(opened, path)
  if (!prior) return opened
  const next = new Map(opened)
  for (const [key, file] of next) if (file === prior) { next.set(key, { ...file, scroll }); break }
  return next
}
