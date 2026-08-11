/** One desktop-supervised debug-retention run; never started by each sidecar. */

import { open, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { cleanupOldDebugLogs } from '../../src/utils/cleanup.js'

const DAY_MS = 24 * 60 * 60 * 1000

async function main(): Promise<void> {
  const directory = process.env.CATCODE_DEBUG_CLEANUP_MARKER_DIR
  if (!directory) return
  const marker = join(directory, 'debug-cleanup.last-run')
  const lock = join(directory, 'debug-cleanup.lock')
  try {
    const previous = await stat(marker)
    if (Date.now() - previous.mtimeMs < DAY_MS) return
  } catch {
    // First desktop run has no marker.
  }
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(lock, 'wx', 0o600)
  } catch {
    // Another desktop instance/worker owns the shared directory scan.
    return
  }
  try {
    await cleanupOldDebugLogs()
    await writeFile(marker, '', { mode: 0o600 })
  } finally {
    await handle.close().catch(() => {})
    await unlink(lock).catch(() => {})
  }
}

void main()
