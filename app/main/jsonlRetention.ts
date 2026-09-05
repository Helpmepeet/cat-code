/**
 * Retention for main's private rotating-JSONL diagnostics lanes (the delivery
 * trace, its rollup, and the operational log). Each lane names its files
 * `<prefix><launchId>-<ms>.jsonl` and keeps a `latest-*` symlink beside them;
 * the rules for how many, how big and how old those files may get were written
 * out once per lane and are written out once here instead.
 *
 * The caps themselves are NOT here. Every lane owns its own numbers, for
 * reasons its own file records, and passes them in.
 */

import {
  chmodSync,
  mkdirSync,
  readdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs'
import { join } from 'node:path'

/** These files are private to the user; the directory is never group-readable. */
export function ensurePrivateDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  chmodSync(directory, 0o700)
}

/** Repoint `<directory>/<latestName>` at the lane's current file. */
export function updateLatestSymlink(
  directory: string,
  latestName: string,
  activeFile: string,
): void {
  const latest = join(directory, latestName)
  try {
    unlinkSync(latest)
  } catch {
    // First write has no previous target.
  }
  try {
    symlinkSync(activeFile, latest)
  } catch {
    // A support convenience, never a logging failure.
  }
}

/**
 * Retention is per lane: the pattern is anchored on the caller's own prefix, so
 * pressure on one lane's files can never reach another's. The active file is
 * repermissioned but never deleted.
 */
export function retainJsonlFiles(options: {
  directory: string
  prefix: string
  current: number
  maxTotalBytes: number
  maxFiles: number
  maxAgeMs: number
  activeFile: string
}): void {
  const pattern = new RegExp(`^${options.prefix}[A-Za-z0-9-]+-\\d+\\.jsonl$`)
  const files = readdirSync(options.directory)
    .filter(name => pattern.test(name))
    .map(name => ({
      path: join(options.directory, name),
      stat: statSync(join(options.directory, name)),
    }))
    .sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs)
  let total = files.reduce((sum, item) => sum + item.stat.size, 0)
  let count = files.length
  for (const item of files) {
    try {
      chmodSync(item.path, 0o600)
    } catch {
      // Retention and permission repair are best effort.
    }
    if (item.path === options.activeFile) continue
    if (
      item.stat.mtimeMs < options.current - options.maxAgeMs ||
      count > options.maxFiles ||
      total > options.maxTotalBytes
    ) {
      try {
        unlinkSync(item.path)
        count--
        total -= item.stat.size
      } catch {
        // Retention is best effort; it must never delete the active launch file.
      }
    }
  }
}
