import { resolveFilePathParts } from './filePathActions.js'

/** Lexical identity retains the message's original folder and source suffix. */
export function paneFileKey(path: string, cwd: string | null = null): string {
  const parts = resolveFilePathParts({ rawPath: path, cwd })
  const resolved = (parts.absolutePath ?? parts.cleanPath).replace(/:\d+(?::\d+)?$/, '')
  if (resolved.startsWith('~/')) return resolved
  const windows = /^[A-Za-z]:[\\/]/.test(resolved)
  const rooted = windows || resolved.startsWith('/')
  const prefix = windows ? resolved.slice(0, 2) : rooted ? '/' : ''
  const normalized: string[] = []
  for (const part of resolved.slice(windows ? 2 : 0).split(windows ? /[\\/]+/ : /\/+/)) {
    if (!part || part === '.') continue
    if (part === '..' && normalized.length && normalized.at(-1) !== '..') normalized.pop()
    else if (part !== '..' || !rooted) normalized.push(part)
  }
  return `${prefix}${windows ? '/' : ''}${normalized.join('/')}`
}
