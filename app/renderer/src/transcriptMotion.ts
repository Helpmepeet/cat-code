import { createContext, useLayoutEffect, useRef } from 'react'
import { useEntranceLatch } from './entranceLatch.js'
import { reasoningStepsForRow } from './reasoningLayout.js'
import { nestedRowsChange, type NestedTranscriptRow } from './transcriptProjector.js'

type EntranceLatch = ReturnType<typeof useEntranceLatch>

export type TranscriptMotion = {
  turnLive: boolean
  freshProse: ReadonlySet<string>
  results: EntranceLatch
  steps: EntranceLatch
  rows: EntranceLatch
}

const EMPTY = new Set<string>()
const EMPTY_LATCH: EntranceLatch = {
  active: EMPTY,
  refFor: () => () => {},
  onAnimationEnd: () => {},
}
function stableLatch(previous: EntranceLatch | undefined, next: EntranceLatch): EntranceLatch {
  if (previous && previous.active.size === next.active.size &&
      [...next.active].every(key => previous.active.has(key))) return previous
  return next
}

export const TranscriptMotionContext = createContext<TranscriptMotion>({
  turnLive: false,
  freshProse: EMPTY,
  results: EMPTY_LATCH,
  steps: EMPTY_LATCH,
  rows: EMPTY_LATCH,
})

/** Status, step, and arrival history is keyed by row id before display grouping. */
export function useTranscriptMotion(
  rows: readonly NestedTranscriptRow[],
  allowArrival: boolean,
  turnLive: boolean,
): TranscriptMotion {
  const committed = useRef(false)
  const statuses = useRef(new Map<string, string>())
  const seenSteps = useRef(new Set<string>())
  const seenRows = useRef(new Set<string>())
  const seenProse = useRef(new Set<string>())
  const visited = useRef(new WeakSet<NestedTranscriptRow>())
  const previousRows = useRef<readonly NestedTranscriptRow[] | null>(null)
  const previousMotion = useRef<TranscriptMotion | null>(null)
  const freshResults = new Set<string>()
  const freshSteps = new Set<string>()
  const freshRows = new Set<string>()
  const freshProse = new Set<string>()
  const changed: { row: NestedTranscriptRow; steps: readonly string[] }[] = []
  const changedRoots: NestedTranscriptRow[] = []

  const visit = (row: NestedTranscriptRow, allowNewProse: boolean): void => {
    if (visited.current.has(row)) return
    if (allowNewProse && row.kind === 'assistant-text' && row.isStreaming &&
        !seenProse.current.has(row.id)) {
      freshProse.add(row.id)
    }
    const steps = row.kind === 'thinking' || row.kind === 'redacted-thinking'
      ? reasoningStepsForRow(row).map(step => step.key)
      : []
    if (row.kind === 'tool-use' && committed.current && allowArrival &&
        statuses.current.get(row.id) === 'pending' && row.status !== 'pending') {
      freshResults.add(row.id)
    }
    if (steps.length) {
      const hadStep = steps.some(key => seenSteps.current.has(key))
      if (committed.current && allowArrival && hadStep) {
        for (const key of steps) {
          if (!seenSteps.current.has(key)) freshSteps.add(key)
        }
      }
    }
    changed.push({ row, steps })
    for (const child of row.children) visit(child, allowNewProse)
  }
  if (rows !== previousRows.current) {
    const hint = nestedRowsChange(rows)
    const start = hint?.previous === previousRows.current ? hint.start : 0
    const end = hint?.previous === previousRows.current ? hint.nextEnd : rows.length
    // When the projector cannot prove the unchanged prefix/suffix, inspect all
    // roots. A head insert or reorder can move the first previously visible row.
    let firstOldIndex = start > 0 ? 0 : -1
    if (firstOldIndex < 0) {
      for (let index = 0; index < end; index++) {
        if (seenRows.current.has(rows[index]!.id)) {
          firstOldIndex = index
          break
        }
      }
      if (firstOldIndex < 0 && end < rows.length) firstOldIndex = end
    }
    for (let index = start; index < end; index++) {
      const row = rows[index]!
      changedRoots.push(row)
      const canArrive = committed.current && allowArrival && turnLive &&
          !seenRows.current.has(row.id) &&
          (firstOldIndex < 0 || index >= firstOldIndex)
      if (canArrive && row.kind !== 'history-boundary' &&
          !(row.kind === 'assistant-text' && row.isStreaming)) {
        freshRows.add(row.id)
      }
      // Projected rows retain identity for unchanged subtrees. Only a new
      // wrapper and its changed descendants need motion-history work.
      visit(row, committed.current && allowArrival && turnLive &&
        (firstOldIndex < 0 || index >= firstOldIndex))
    }
  }

  const results = useEntranceLatch(freshResults)
  const steps = useEntranceLatch(freshSteps)
  const rowEntrances = useEntranceLatch(freshRows)

  useLayoutEffect(() => {
    if (rows !== previousRows.current) {
      for (const row of changedRoots) seenRows.current.add(row.id)
      for (const { row, steps } of changed) {
        visited.current.add(row)
        if (row.kind === 'tool-use') statuses.current.set(row.id, row.status)
        if (row.kind === 'assistant-text' && row.isStreaming) seenProse.current.add(row.id)
        for (const key of steps) seenSteps.current.add(key)
      }
      previousRows.current = rows
    }
    committed.current = true
  })

  const previous = previousMotion.current
  const stableResults = stableLatch(previous?.results, results)
  const stableSteps = stableLatch(previous?.steps, steps)
  const stableRows = stableLatch(previous?.rows, rowEntrances)
  const stableProse = freshProse.size === 0 ? EMPTY : freshProse
  if (previous && previous.turnLive === turnLive &&
      previous.freshProse === stableProse &&
      previous.results === stableResults &&
      previous.steps === stableSteps &&
      previous.rows === stableRows) return previous
  const motion = {
    turnLive, freshProse: stableProse,
    results: stableResults, steps: stableSteps, rows: stableRows,
  }
  previousMotion.current = motion
  return motion
}
