import type { NestedTranscriptRow, ToolCardStatus, ToolResultProjection } from './transcriptProjector.js'
import { deriveTarget } from './transcriptToolTarget.js'

export type ComputerStep = {
  id: string
  title: string
  status: ToolCardStatus
  observation: string
  image: NonNullable<ToolResultProjection['images']>[number] | null
  nested?: boolean
}

export function selectComputerScreen(steps: readonly ComputerStep[], selected: ComputerStep | null): { step: ComputerStep; index: number } | null {
  for (let index = selected ? steps.indexOf(selected) : -1; index >= 0; index--) {
    if (steps[index]!.image) return { step: steps[index]!, index }
  }
  return null
}

export function selectComputerSteps(rows: readonly NestedTranscriptRow[]): ComputerStep[] {
  const steps: ComputerStep[] = []
  const seen = new Set<string>()
  function visit(branch: readonly NestedTranscriptRow[], nested = false) {
    for (const row of branch) {
      if (row.kind === 'tool-use' && row.toolFamily === 'computer' && !seen.has(row.id)) {
        seen.add(row.id)
        steps.push({ id: row.id, title: deriveTarget(row), status: row.status, observation: row.result?.content ?? '', image: row.result?.images?.at(-1) ?? null, nested })
      }
      visit(row.children, true)
    }
  }
  visit(rows)
  return steps
}

/** Interrupted calls can stay pending in history. Only this operator turn can be live. */
export function selectCurrentComputerStepId(rows: readonly NestedTranscriptRow[]): string | null {
  let start = 0
  for (let index = rows.length - 1; index >= 0; index--) {
    if (['user-text', 'user-image', 'command-echo'].includes(rows[index]!.kind)) {
      start = index
      break
    }
  }
  const steps = selectComputerSteps(rows.slice(start))
  return steps.reverse().find(step => step.status === 'pending')?.id ?? null
}

/** Follow received output, keeping the last observation while another call is pending. */
export function selectComputerStep(steps: readonly ComputerStep[], selectedId: string | null): ComputerStep | null {
  if (selectedId !== null) {
    const selected = steps.find(step => step.id === selectedId)
    if (selected) return selected
  }
  for (let index = steps.length - 1; index >= 0; index--) {
    if (steps[index]!.observation.trim() || steps[index]!.image !== null) return steps[index]!
  }
  return steps.at(-1) ?? null
}
