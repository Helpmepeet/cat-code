import type { NestedTranscriptRow, ToolCardStatus, ToolResultProjection } from './transcriptProjector.js'
import { deriveTarget } from './transcriptToolTarget.js'

export type ComputerStep = {
  id: string
  title: string
  status: ToolCardStatus
  image: NonNullable<ToolResultProjection['images']>[number] | null
}

export function selectComputerSteps(rows: readonly NestedTranscriptRow[]): ComputerStep[] {
  const steps: ComputerStep[] = []
  const seen = new Set<string>()
  function visit(branch: readonly NestedTranscriptRow[]) {
    for (const row of branch) {
      if (row.kind === 'tool-use' && row.toolFamily === 'computer' && !seen.has(row.id)) {
        seen.add(row.id)
        steps.push({ id: row.id, title: deriveTarget(row), status: row.status, image: row.result?.images?.at(-1) ?? null })
      }
      visit(row.children)
    }
  }
  visit(rows)
  return steps
}

/** Follow captures, not unfinished calls. A removed selection rejoins the latest capture. */
export function selectComputerStep(steps: readonly ComputerStep[], selectedId: string | null): ComputerStep | null {
  if (selectedId !== null) {
    const selected = steps.find(step => step.id === selectedId)
    if (selected) return selected
  }
  for (let index = steps.length - 1; index >= 0; index--) {
    if (steps[index]!.image !== null) return steps[index]!
  }
  return steps.at(-1) ?? null
}
