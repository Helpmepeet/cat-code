import { createHash } from 'node:crypto'
import type { EvidenceCase } from './cases.js'
import type { EvidenceRecord } from './resume.js'

export type PayloadComponents = { instructionsChars: number; historyChars: number; instructionsDigest: string; historyDigest: string }

function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(strings)
  return value && typeof value === 'object' ? Object.values(value).flatMap(strings) : []
}

/** Measure only the instruction prefix and conversation, not policy/schema savings. */
export function payloadComponents(request: unknown): PayloadComponents {
  const messages = request && typeof request === 'object' && 'messages' in request && Array.isArray(request.messages) ? request.messages : []
  const instructions = JSON.stringify(messages.slice(0, -1).filter(message => strings(message).some(text => text.includes('<instruction_context>'))))
  const history = JSON.stringify(messages.at(-1) ?? null)
  const digest = (text: string) => createHash('sha256').update(text).digest('hex')
  return { instructionsChars: instructions.length, historyChars: history.length,
    instructionsDigest: digest(instructions), historyDigest: digest(history) }
}

export function inspectPayloadEvidence(testCase: EvidenceCase, variant: 'full' | 'reduced', captured: readonly unknown[]) {
  const missing: string[] = [], unexpected: string[] = []
  const required: { name: string; text: string; minOccurrences?: number }[] = [...testCase.evidence, ...(variant === 'full' ? testCase.reducedExcluded ?? [] : [])]
  const excluded = [...(testCase.excluded ?? []), ...(variant === 'reduced' ? testCase.reducedExcluded ?? [] : [])]
  for (const [stage, request] of captured.entries()) {
    const text = strings(request).join('\n')
    for (const marker of required) {
      if (!marker.text) throw new Error('Evidence markers must be nonempty')
      const occurrences = text.split(marker.text).length - 1
      if (occurrences < (marker.minOccurrences ?? 1)) missing.push(`${stage + 1}:${marker.name}`)
    }
    for (const marker of excluded) if (text.includes(marker.text)) unexpected.push(`${stage + 1}:${marker.name}`)
  }
  if (captured.length === 0) missing.push('no-review-request')
  return { missing, unexpected, components: captured.map(payloadComponents) }
}

/** Component-level requirements stop policy savings from masquerading as evidence selection. */
export function comparePayloadEvidence(cases: readonly EvidenceCase[], records: readonly EvidenceRecord[]) {
  const pairs = new Map<string, Partial<Record<'full' | 'reduced', EvidenceRecord>>>()
  for (const record of records) {
    const key = `${record.id}/${record.repeat}`
    const pair = pairs.get(key) ?? {}
    pair[record.variant] = record
    pairs.set(key, pair)
  }
  const componentFailures: string[] = []
  const componentReductions: { id: string; repeat: number; instructionsSaved: number; historySaved: number }[] = []
  for (const [key, pair] of pairs) {
    const testCase = cases.find(c => c.id === pair.full?.id || c.id === pair.reduced?.id)!
    if (!pair.full || !pair.reduced) continue
    const full = pair.full.components?.[0], reduced = pair.reduced.components
    const demandsComponents = testCase.requiredSavings !== undefined || Boolean(testCase.preserveComponents?.length)
    if (!full || !reduced?.length) {
      if (demandsComponents) componentFailures.push(`${key}:missing-component-measurements`)
      continue
    }
    const instructionsSaved = Math.min(...reduced.map(c => full.instructionsChars - c.instructionsChars))
    const historySaved = Math.min(...reduced.map(c => full.historyChars - c.historyChars))
    componentReductions.push({ id: testCase.id, repeat: pair.full.repeat, instructionsSaved, historySaved })
    for (const component of ['instructions', 'history'] as const) {
      const minimum = testCase.requiredSavings?.[component]
      const saved = component === 'instructions' ? instructionsSaved : historySaved
      if (minimum !== undefined && saved < minimum) componentFailures.push(`${key}:${component}-savings-below-${minimum}`)
      if (testCase.preserveComponents?.includes(component) && reduced.some(c => c[`${component}Digest`] !== full[`${component}Digest`])) {
        componentFailures.push(`${key}:${component}-changed-despite-ambiguity`)
      }
    }
  }
  return { componentFailures, componentReductions }
}
