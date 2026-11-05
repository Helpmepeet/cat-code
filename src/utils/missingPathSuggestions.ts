import { lstat, realpath } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { openContainedFs, type ContainedFs } from './containedFs'

const SKIP = new Set(['node_modules', 'vendor', 'dist', 'build', 'coverage', 'out', 'target', '__pycache__'])
const MAX_DIRECTORIES = 160
const MAX_ENTRIES = 6000
const MAX_ENTRIES_PER_DIRECTORY = 512
const MAX_DEPTH = 5
const isUNC = (path: string) => /^[\\/]{2}/.test(path)
const within = (root: string, path: string) => {
  const rel = relative(root, path)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

type SuggestionOptions = {
  cwd: string
  canInspect: (absolutePath: string) => boolean
  signal?: AbortSignal
}

/** Filename hints only. Never reads candidate contents or substitutes a requested path. */
export async function suggestMissingPath(
  requestedPath: string,
  options: SuggestionOptions,
): Promise<string[]> {
  options.signal?.throwIfAborted()
  if (isUNC(requestedPath) || isUNC(options.cwd)) return []
  const correction = await suggestCwdPrefixCorrection(requestedPath, options)
  const nearby = await suggestNearbyPaths(requestedPath, options)
  return [...new Set([...(correction ? [correction] : []), ...nearby])].slice(0, 5)
}

async function suggestCwdPrefixCorrection(
  requestedPath: string,
  { cwd: workingDirectory, canInspect, signal }: SuggestionOptions,
): Promise<string | undefined> {
  const cwd = resolve(workingDirectory)
  const requested = resolve(cwd, requestedPath)
  const parent = dirname(cwd)
  if (!within(parent, requested) || within(cwd, requested) || requested === parent) return
  const corrected = join(cwd, relative(parent, requested))
  let contained: ContainedFs | undefined
  try {
    if (!canInspect(cwd) || !canInspect(corrected)) return
    let directory = dirname(corrected)
    while (within(cwd, directory)) {
      signal?.throwIfAborted()
      if (!canInspect(directory)) return
      if (directory === cwd) break
      directory = dirname(directory)
    }
    // A correction inside cwd never inherits approval of the missing outside path.
    contained = await openContainedFs(cwd)
    signal?.throwIfAborted()
    if (contained.canonicalRoot !== cwd || !canInspect(contained.canonicalRoot)) return
    const entry = await contained.lstat(relative(cwd, corrected).split(sep).join('/'))
    signal?.throwIfAborted()
    if (!entry.isSymbolicLink() && (entry.isFile() || entry.isDirectory()) && canInspect(corrected)) {
      return corrected
    }
  } catch {
    signal?.throwIfAborted()
  } finally {
    if (contained) await contained.close()
  }
}

async function suggestNearbyPaths(
  requestedPath: string,
  options: SuggestionOptions,
): Promise<string[]> {
  const { canInspect, signal } = options
  const checkAbort = () => signal?.throwIfAborted()
  checkAbort()
  if (isUNC(requestedPath) || isUNC(options.cwd)) return []
  const cwd = resolve(options.cwd)
  const requested = resolve(cwd, requestedPath)
  const requestedDir = dirname(requested)
  const name = basename(requested)
  const stem = basename(name, extname(name))
  const exact: string[] = []
  const sameStem: string[] = []
  let directories = 0
  let entries = 0
  let contained: ContainedFs | undefined

  // Reject symlinks in every component, not just the final directory entry.
  const canonical = async (path: string): Promise<string | undefined> => {
    checkAbort()
    if (!canInspect(path)) return undefined
    let cursor = path
    while (true) {
      checkAbort()
      if ((await lstat(cursor)).isSymbolicLink()) return undefined
      const parent = dirname(cursor)
      if (parent === cursor) break
      cursor = parent
    }
    const actual = await realpath(path)
    checkAbort()
    return canInspect(actual) ? actual : undefined
  }
  try {
    const canonicalCwd = await canonical(cwd)
    const inWorkspace = within(cwd, requested)
    let canonicalRequestedDir: string | undefined
    try {
      canonicalRequestedDir = await canonical(requestedDir)
      if (!canonicalRequestedDir) return []
    } catch (error) {
      checkAbort()
      if (!inWorkspace || (error as NodeJS.ErrnoException).code !== 'ENOENT') return []
    }
    if (inWorkspace && (!canonicalCwd ||
        (canonicalRequestedDir && !within(canonicalCwd, canonicalRequestedDir)))) return []
    const root = inWorkspace ? canonicalCwd! : canonicalRequestedDir!
    if (!canInspect(root)) return []
    contained = await openContainedFs(root)
    checkAbort()
    if (contained.canonicalRoot !== root || !canInspect(contained.canonicalRoot)) return []
    const rootRelative = (path: string) => relative(root, path).split(sep).join('/')

    const queue: { directory: string; depth: number }[] = []
    const queued = new Set<string>()
    const enqueue = (directory: string, depth = 0) => {
      if (queued.size >= MAX_DIRECTORIES || queued.has(directory)) return
      queued.add(directory)
      queue.push({ directory, depth })
    }
    // Seed nearby ancestors first, then process their children breadth-first.
    // A large unrelated subtree must not hide a sibling such as app/shared.
    if (canonicalRequestedDir) enqueue(requestedDir)
    if (inWorkspace) {
      let ancestor = dirname(requestedDir)
      while (within(cwd, ancestor)) {
        enqueue(ancestor)
        if (ancestor === cwd) break
        ancestor = dirname(ancestor)
      }
      enqueue(cwd)
    }
    const scan = async (directory: string, depth: number): Promise<void> => {
      checkAbort()
      if (directories >= MAX_DIRECTORIES || entries >= MAX_ENTRIES || exact.length >= 5) return
      try {
        const rel = rootRelative(directory)
        const actual = join(contained!.canonicalRoot, rel)
        if (!within(root, directory) || !canInspect(directory) || !canInspect(actual)) return
        directories++
        const names = await contained!.readdir(rel, Math.min(MAX_ENTRIES_PER_DIRECTORY, MAX_ENTRIES - entries))
        for (const entryName of names) {
          checkAbort()
          if (entries >= MAX_ENTRIES || exact.length >= 5) break
          entries++
          const path = join(directory, entryName)
          const candidate = join(contained!.canonicalRoot, rootRelative(path))
          if (!canInspect(path) || !canInspect(candidate)) continue
          let entry
          try {
            entry = await contained!.lstat(rootRelative(path))
          } catch {
            checkAbort()
            continue
          }
          if (entry.isSymbolicLink()) continue
          if (entry.isFile() && (entryName === name ||
              (directory === requestedDir && basename(entryName, extname(entryName)) === stem))) {
            if (canInspect(path) && canInspect(candidate)) {
              const results = entryName === name ? exact : sameStem
              if (results.length < 5 && !results.includes(path)) results.push(path)
            }
          } else if (inWorkspace && entry.isDirectory() && depth < MAX_DEPTH &&
              !entryName.startsWith('.') && !SKIP.has(entryName)) {
            enqueue(path, depth + 1)
          }
        }
      } catch {
        checkAbort()
        // Unreadable or concurrently removed directories are ordinary best-effort misses.
      }
    }
    for (let index = 0; index < queue.length; index++) {
      if (entries >= MAX_ENTRIES || exact.length >= 5) break
      const next = queue[index]!
      await scan(next.directory, next.depth)
    }
    checkAbort()
    return [...exact, ...sameStem].slice(0, 5)
  } catch {
    checkAbort()
    return []
  } finally {
    if (contained) await contained.close()
  }
}

export function formatMissingPathResult(
  requestedPath: string,
  suggestions: readonly string[],
  operation: 'read' | 'search',
): string {
  const status = operation === 'read' ? 'No file was read.' : 'No search was performed.'
  const hints = suggestions.length
    ? `\nPossible paths (suggestions only, not substitutions):\n${suggestions.map(path => `- ${JSON.stringify(path)}`).join('\n')}`
    : ''
  return `Requested path ${JSON.stringify(requestedPath)} was not found. ${status}${hints}`
}
