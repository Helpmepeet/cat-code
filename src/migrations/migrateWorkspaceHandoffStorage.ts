import { constants, closeSync, fsyncSync, lstatSync, mkdirSync, openSync } from 'node:fs'
import { join } from 'node:path'
import { getClaudeConfigHomeDir } from '../utils/envUtils.js'

/** Initialize only. Existing host ledgers and saved transcripts remain owned. */
export function migrateWorkspaceHandoffStorage(): Error | null {
  try {
    const directory = join(getClaudeConfigHomeDir(), 'workspace-handoff-executions')
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const info = lstatSync(directory)
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 ||
      (typeof process.getuid === 'function' && info.uid !== process.getuid())) throw new Error('Unsafe workspace handoff storage')
    for (const path of [directory, getClaudeConfigHomeDir()]) {
      const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
    }
    return null
  } catch (error) { return error instanceof Error ? error : new Error(String(error)) }
}
