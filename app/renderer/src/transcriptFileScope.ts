import { createContext } from 'react'
import type { SessionDescriptor } from '../../shared/hostApi.js'
import type { NestedTranscriptRow } from './transcriptProjector.js'
import { resolveFilePathParts } from './filePathActions.js'
import { localFileUrlPath } from '../../shared/localFileUrl.js'

export const TranscriptFileScopeContext = createContext<ReadonlyMap<string, string> | null>(null)

/** Own one selector per mounted transcript so unrelated panes cannot evict it. */
export function createTranscriptFileScopesSelector(): typeof transcriptFileScopes {
  let previousRows: readonly NestedTranscriptRow[] | undefined
  let previousTransitions: SessionDescriptor['contextTransitions']
  let previous: ReadonlyMap<string, string> | undefined
  return (rows, transitions) => {
    if (previous && rows === previousRows && transitions === previousTransitions) return previous
    const next = transcriptFileScopes(rows, transitions)
    previousRows = rows
    previousTransitions = transitions
    if (previous && previous.size === next.size &&
        [...next].every(([id, cwd]) => previous!.get(id) === cwd)) return previous
    return previous = next
  }
}

/** Parent replies use loaded move seams; workers use their recorded run folder. */
export function transcriptFileScopes(
  rows: readonly NestedTranscriptRow[],
  transitions: SessionDescriptor['contextTransitions'] = [],
): ReadonlyMap<string, string> {
  const lastRowByFrame = new Map<string, number>()
  rows.forEach((row, index) => lastRowByFrame.set(row.frameId, index))
  const boundaries = new Map<number, string>()
  for (const transition of transitions) {
    const index = transition.afterFrameId === null ? -1 : lastRowByFrame.get(transition.afterFrameId)
    if (index === undefined) {
      // An omitted later move makes every earlier scope uncertain until another
      // loaded anchor establishes where the conversation went next.
      boundaries.clear()
    } else {
      boundaries.set(index, transition.cwd)
    }
  }
  const scopes = new Map<string, string>()
  const workerScopes = (row: NestedTranscriptRow) => {
    // Worker runs can use a custom folder or outlive a parent move. Only their
    // engine-recorded working folder is provenance, never the parent's position.
    if ('agentCwd' in row && row.agentCwd) scopes.set(row.id, row.agentCwd)
    for (const child of row.children) workerScopes(child)
  }
  let cwd = boundaries.get(-1)
  rows.forEach((row, index) => {
    if (cwd && 'parentToolUseId' in row && row.parentToolUseId === null) scopes.set(row.id, cwd)
    workerScopes(row)
    cwd = boundaries.get(index) ?? cwd
  })
  return scopes
}

export function scopedTranscriptFilePath(path: string, cwd: string | undefined): string {
  const localPath = localFileUrlPath(path) ?? path
  return cwd ? resolveFilePathParts({ rawPath: localPath, cwd }).absolutePath ?? localPath : localPath
}
