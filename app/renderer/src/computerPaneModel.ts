import type { NestedTranscriptRow, ToolCardStatus, ToolResultProjection } from './transcriptProjector.js'
import { deriveTarget } from './transcriptToolTarget.js'
import { parseComputerWindowCaptureRequest, type ComputerWindowCapture } from '../../shared/computerWindowCapture.js'

export type ComputerStep = {
  id: string
  title: string
  status: ToolCardStatus
  observation: string
  image: NonNullable<ToolResultProjection['images']>[number] | null
  app?: string | null
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
  function appName(value: string | undefined): string | null {
    if (!value) return null
    const target = value.split('/').at(-1)?.replace(/\.app$/i, '')
    return parseComputerWindowCaptureRequest({ app: target })?.app ?? null
  }
  function visit(branch: readonly NestedTranscriptRow[], nested = false) {
    let app: string | null = null
    for (const row of branch) {
      if (row.kind === 'user-text' || row.kind === 'user-image' || row.kind === 'command-echo') app = null
      if (row.kind === 'tool-use' && row.toolFamily === 'computer' &&
        row.toolName !== 'mcp__codex-computer-use__computer_use_status' &&
        row.toolName !== 'mcp__codex-computer-use__js_reset' && !seen.has(row.id)) {
        seen.add(row.id)
        const observation = row.result?.content ?? ''
        const input = row.input as { code?: unknown } | null
        const code = typeof input?.code === 'string' ? input.code : ''
        const explicit = [...code.matchAll(/\bcua\.getApp\(\s*(["'])([^"'\n]+)\1\s*\)/g)]
        const observed = /^Window:[^\n]*?, App: ([^\n]+?)\.\s*(?:\n|$)/m.exec(observation)?.[1]
        if (/^Browser tab:/m.test(observation) || /\bcua\.(?:getBrowser|browser)\b/.test(code)) app = null
        else if (observed) app = appName(observed)
        else if (explicit.length || /\bcua\.getApp\(/.test(code)) app = appName(explicit.at(-1)?.[2])
        steps.push({ id: row.id, title: deriveTarget(row), status: row.status, observation, image: row.result?.images?.at(-1) ?? null, app, nested })
      }
      visit(row.children, true)
    }
  }
  visit(rows)
  return steps
}

export type ComputerPicture = {
  stepId: string
  app: string | null
  src: string
  fingerprint?: readonly number[]
}

export function computerPicture(step: ComputerStep, capture?: ComputerWindowCapture): ComputerPicture | null {
  if (capture?.status === 'captured') return { stepId: step.id, app: step.app ?? null, src: capture.dataUrl, fingerprint: capture.fingerprint }
  return step.image ? { stepId: step.id, app: step.app ?? null, src: `data:${step.image.mediaType};base64,${step.image.data}` } : null
}

function sameScreen(a: ComputerPicture, b: ComputerPicture): boolean {
  if (a.app !== b.app) return false
  if (a.fingerprint && b.fingerprint && a.fingerprint.length === b.fingerprint.length) {
    const next = b.fingerprint
    let total = 0
    let largeChanges = 0
    for (const [index, sample] of a.fingerprint.entries()) {
      const delta = Math.abs(sample - next[index]!)
      total += delta
      if (delta > 24) largeChanges++
    }
    // Allow a local loading indicator to change, but reject broad shifts
    // even if most of the window (such as a settings sidebar) stays fixed.
    return total <= next.length * 8 && largeChanges <= next.length / 8
  }
  return a.src === b.src
}

export function groupComputerSteps(steps: readonly ComputerStep[], captures?: ReadonlyMap<string, ComputerWindowCapture>) {
  const groups: { steps: ComputerStep[]; picture: ComputerPicture | null }[] = []
  for (const step of steps) {
    const picture = computerPicture(step, captures?.get(step.id))
    const previous = groups.at(-1)
    if (previous && (!picture || (previous.picture && sameScreen(previous.picture, picture)))) {
      previous.steps.push(step)
      if (picture) previous.picture = picture
    } else groups.push({ steps: [step], picture })
  }
  return groups
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
