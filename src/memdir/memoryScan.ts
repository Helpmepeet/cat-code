/**
 * Memory-directory scanning primitives. Split out of findRelevantMemories.ts
 * so extractMemories can import the scan without pulling in sideQuery and
 * the API-client chain (which closed a cycle through memdir.ts — #25372).
 */

import { readdir, stat } from 'fs/promises'
import { basename, join } from 'path'
import { parseFrontmatter } from '../utils/frontmatterParser.js'
import { readFileInRange } from '../utils/readFileInRange.js'
import { type MemoryType, parseMemoryType } from './memoryTypes.js'

export type MemoryHeader = {
  filename: string
  filePath: string
  mtimeMs: number
  description: string | null
  type: MemoryType | undefined
}

export const MAX_MEMORY_FILES = 200
export const MEMORY_SCAN_CONCURRENCY = 16
const FRONTMATTER_MAX_LINES = 30

/**
 * Scan a memory directory for .md files, read their frontmatter, and return
 * a header list sorted newest-first (capped at MAX_MEMORY_FILES). Shared by
 * findRelevantMemories (query-time recall) and extractMemories (pre-injects
 * the listing so the extraction agent doesn't spend a turn on `ls`).
 *
 * The metadata pass is deliberately separate from header reads. A large memory
 * tree still needs its mtimes examined to choose the real newest entries, but
 * only those survivors have their contents opened. Both phases are bounded so a
 * sidecar never creates an unbounded file-descriptor/read fan-out.
 */
export async function scanMemoryFiles(
  memoryDir: string,
  signal: AbortSignal,
): Promise<MemoryHeader[]> {
  try {
    const entries = await readdir(memoryDir, { recursive: true })
    const mdFiles = entries.filter(
      f => f.endsWith('.md') && basename(f) !== 'MEMORY.md',
    )

    const candidates = await mapWithConcurrency(
      mdFiles,
      MEMORY_SCAN_CONCURRENCY,
      signal,
      async relativePath => {
        const filePath = join(memoryDir, relativePath)
        const metadata = await stat(filePath)
        return { relativePath, filePath, mtimeMs: metadata.mtimeMs }
      },
    )
    if (signal.aborted) return []
    const newest = candidates
      .filter(
        (
          candidate,
        ): candidate is { relativePath: string; filePath: string; mtimeMs: number } =>
          candidate !== null,
      )
      .sort((a, b) => b.mtimeMs - a.mtimeMs || a.relativePath.localeCompare(b.relativePath))
      .slice(0, MAX_MEMORY_FILES)

    const headerResults = await mapWithConcurrency(
      newest,
      MEMORY_SCAN_CONCURRENCY,
      signal,
      async ({ relativePath, filePath }): Promise<MemoryHeader | null> => {
        const { content, mtimeMs } = await readFileInRange(
          filePath,
          0,
          FRONTMATTER_MAX_LINES,
          undefined,
          signal,
        )
        const { frontmatter } = parseFrontmatter(content, filePath)
        return {
          filename: relativePath,
          filePath,
          mtimeMs,
          description: frontmatter.description || null,
          type: parseMemoryType(frontmatter.type),
        }
      },
    )
    if (signal.aborted) return []

    return headerResults
      .filter((header): header is MemoryHeader => header !== null)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
  } catch {
    return []
  }
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  signal: AbortSignal,
  map: (value: T) => Promise<R>,
): Promise<Array<R | null>> {
  const results: Array<R | null> = Array(values.length).fill(null)
  let cursor = 0
  const worker = async (): Promise<void> => {
    while (true) {
      if (signal.aborted) return
      const index = cursor++
      if (index >= values.length) return
      try {
        results[index] = await map(values[index]!)
      } catch {
        // A deleted/unreadable memory is omitted, matching the former
        // all-settled behavior without aborting the complete scan.
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, () => worker()),
  )
  return results
}

/**
 * Format memory headers as a text manifest: one line per file with
 * [type] filename (timestamp): description. Used by both the recall
 * selector prompt and the extraction-agent prompt.
 */
export function formatMemoryManifest(memories: MemoryHeader[]): string {
  return memories
    .map(m => {
      const tag = m.type ? `[${m.type}] ` : ''
      const ts = new Date(m.mtimeMs).toISOString()
      return m.description
        ? `- ${tag}${m.filename} (${ts}): ${m.description}`
        : `- ${tag}${m.filename} (${ts})`
    })
    .join('\n')
}
