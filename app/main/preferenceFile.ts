/**
 * The storage idiom the small main-owned preference files share
 * (`glassPreference.ts`, `windowBounds.ts`), written here once: one versioned
 * JSON object under the desktop config directory, written temp-then-rename so a
 * crash mid-write cannot leave a half file, and read FAIL-OPEN.
 *
 * Best-effort on write and fail-open on read are the DECISION, not an oversight
 * of durability. Neither a remembered window size nor a visual material is worth
 * blocking a launch for, and neither is worth an fsync on every window move. The
 * durable writers in this tree fsync and throw instead, because their callers
 * must know a write was lost: `registry.ts` (which also fsyncs the directory,
 * because other processes read that file) and `transcriptCache.ts`. Anything
 * that needs to know belongs there, not here.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The stored value, or null when there is none to apply. Null covers a first
 * launch, an unreadable directory, a truncated or hand-edited file, and a
 * version this build does not understand: every one of them means "use the
 * default", never "fail". `parse` is the file's own validator and returns null
 * for a shape it does not accept.
 */
export function readPreferenceFile<T>(
  userDataDir: string,
  fileName: string,
  parse: (raw: unknown) => T | null,
): T | null {
  try {
    return parse(JSON.parse(readFileSync(join(userDataDir, fileName), 'utf8')))
  } catch {
    return null
  }
}

export function writePreferenceFile(
  userDataDir: string,
  fileName: string,
  value: unknown,
): void {
  try {
    mkdirSync(userDataDir, { recursive: true })
    const target = join(userDataDir, fileName)
    const temporary = `${target}.${process.pid}.tmp`
    writeFileSync(temporary, `${JSON.stringify(value)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
    renameSync(temporary, target)
  } catch {
    // A stored preference must never make the window unusable when user-data
    // storage fails.
  }
}
