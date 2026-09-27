import { createContext, useLayoutEffect, useRef } from 'react'
import { useEntranceLatch } from './entranceLatch.js'
import { reasoningStepsForRow } from './reasoningLayout.js'
import type { NestedTranscriptRow } from './transcriptProjector.js'

type EntranceLatch = ReturnType<typeof useEntranceLatch>

export type TranscriptMotion = {
  turnLive: boolean
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
export const TranscriptMotionContext = createContext<TranscriptMotion>({
  turnLive: false,
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
  const freshResults = new Set<string>()
  const freshSteps = new Set<string>()
  const freshRows = new Set<string>()

  // Load-earlier inserts land before the first row that was already on screen.
  const firstOldIndex = rows.findIndex(row => seenRows.current.has(row.id))
  rows.forEach((row, index) => {
    if (committed.current && allowArrival && turnLive &&
        !seenRows.current.has(row.id) &&
        (firstOldIndex < 0 || index >= firstOldIndex) &&
        row.kind !== 'history-boundary' &&
        !(row.kind === 'assistant-text' && row.isStreaming)) {
      freshRows.add(row.id)
    }
  })

  const visit = (row: NestedTranscriptRow): void => {
    if (row.kind === 'tool-use' && committed.current && allowArrival &&
        statuses.current.get(row.id) === 'pending' && row.status !== 'pending') {
      freshResults.add(row.id)
    }
    if (row.kind === 'thinking' || row.kind === 'redacted-thinking') {
      const steps = reasoningStepsForRow(row)
      const hadStep = steps.some(step => seenSteps.current.has(step.key))
      if (committed.current && allowArrival && hadStep) {
        for (const step of steps) {
          if (!seenSteps.current.has(step.key)) freshSteps.add(step.key)
        }
      }
    }
    for (const child of row.children) visit(child)
  }
  for (const row of rows) visit(row)

  const results = useEntranceLatch(freshResults)
  const steps = useEntranceLatch(freshSteps)
  const rowEntrances = useEntranceLatch(freshRows)

  useLayoutEffect(() => {
    const remember = (row: NestedTranscriptRow): void => {
      if (row.kind === 'tool-use') statuses.current.set(row.id, row.status)
      if (row.kind === 'thinking' || row.kind === 'redacted-thinking') {
        for (const step of reasoningStepsForRow(row)) seenSteps.current.add(step.key)
      }
      for (const child of row.children) remember(child)
    }
    for (const row of rows) {
      seenRows.current.add(row.id)
      remember(row)
    }
    committed.current = true
  })

  return { turnLive, results, steps, rows: rowEntrances }
}
