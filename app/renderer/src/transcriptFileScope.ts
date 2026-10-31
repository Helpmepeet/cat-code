import { createContext } from 'react'
import type { SessionDescriptor } from '../../shared/hostApi.js'
import type { NestedTranscriptRow } from './transcriptProjector.js'
import { resolveFilePathParts } from './filePathActions.js'

export const TranscriptFileScopeContext = createContext<ReadonlyMap<string, string> | null>(null)

/** Only persisted seams with a loaded anchor establish a reply's workspace. */
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
  let cwd = boundaries.get(-1)
  rows.forEach((row, index) => {
    if (cwd) scopes.set(row.id, cwd)
    cwd = boundaries.get(index) ?? cwd
  })
  return scopes
}

export function scopedTranscriptFilePath(path: string, cwd: string | undefined): string {
  return cwd ? resolveFilePathParts({ rawPath: path, cwd }).absolutePath ?? path : path
}
