import { createContext, useLayoutEffect, useRef } from 'react'
import { reasoningStepsForRow } from './reasoningLayout.js'
import type { NestedTranscriptRow } from './transcriptProjector.js'

export type TranscriptMotion = {
  resolvingTools: ReadonlySet<string>
  arrivingSteps: ReadonlySet<string>
}

const EMPTY = new Set<string>()
export const TranscriptMotionContext = createContext<TranscriptMotion>({
  resolvingTools: EMPTY,
  arrivingSteps: EMPTY,
})

/** Status and step history is kept by row id before display grouping can re-key a card. */
export function useTranscriptMotion(
  rows: readonly NestedTranscriptRow[],
  live: boolean,
): TranscriptMotion {
  const committed = useRef(false)
  const statuses = useRef(new Map<string, string>())
  const seenSteps = useRef(new Set<string>())
  const resolvingTools = new Set<string>()
  const arrivingSteps = new Set<string>()

  const visit = (row: NestedTranscriptRow): void => {
    if (row.kind === 'tool-use' && committed.current && live &&
        statuses.current.get(row.id) === 'pending' && row.status !== 'pending') {
      resolvingTools.add(row.id)
    }
    if (row.kind === 'thinking' || row.kind === 'redacted-thinking') {
      const steps = reasoningStepsForRow(row)
      const hadStep = steps.some(step => seenSteps.current.has(step.key))
      if (committed.current && live && hadStep) {
        for (const step of steps) {
          if (!seenSteps.current.has(step.key)) arrivingSteps.add(step.key)
        }
      }
    }
    for (const child of row.children) visit(child)
  }
  for (const row of rows) visit(row)

  useLayoutEffect(() => {
    const remember = (row: NestedTranscriptRow): void => {
      if (row.kind === 'tool-use') statuses.current.set(row.id, row.status)
      if (row.kind === 'thinking' || row.kind === 'redacted-thinking') {
        for (const step of reasoningStepsForRow(row)) seenSteps.current.add(step.key)
      }
      for (const child of row.children) remember(child)
    }
    for (const row of rows) remember(row)
    committed.current = true
  })

  return { resolvingTools, arrivingSteps }
}
