import type { DraftAnswer } from './askQuestionFlowModel.js'

export type DockDraft = { open: boolean; current: string | null; answers: Record<string, DraftAnswer>; dismissIntents?: string[] }
const retained = new Map<string, DockDraft>()
const prefix = 'pending-question-drafts:'
function valid(value: unknown): value is DockDraft {
  if (!value || typeof value !== 'object') return false
  const draft = value as DockDraft
  return typeof draft.open === 'boolean' && (draft.current === null || typeof draft.current === 'string') &&
    (draft.dismissIntents === undefined || Array.isArray(draft.dismissIntents) && draft.dismissIntents.every(key => typeof key === 'string')) &&
    !!draft.answers && typeof draft.answers === 'object' && !Array.isArray(draft.answers) &&
    Object.values(draft.answers).every(answer => answer && Array.isArray(answer.optionIndices) &&
      answer.optionIndices.every(index => Number.isInteger(index) && index >= 0 && index < 4) && typeof answer.other === 'string' &&
      (answer.notes === undefined || !!answer.notes && typeof answer.notes === 'object' && Object.values(answer.notes).every(note => typeof note === 'string')))
}
export function restoreQuestionDraft(scope: string): DockDraft {
  const current = retained.get(scope)
  if (current) return current
  try {
    const value: unknown = JSON.parse(localStorage.getItem(prefix + scope) ?? 'null')
    if (valid(value)) { retained.set(scope, value); return value }
  } catch { /* Navigation retains the in-memory draft if browser storage is unavailable. */ }
  return { open: false, current: null, answers: {} }
}
export function retainQuestionDraft(scope: string, draft: DockDraft): void {
  retained.set(scope, draft)
  try { localStorage.setItem(prefix + scope, JSON.stringify(draft)) }
  catch (error) { console.warn('Question draft storage is unavailable; picks remain in memory', error) }
}
export function forgetQuestionDrafts(sessionId: string): void {
  for (const scope of retained.keys()) if (scope === sessionId || scope.startsWith(sessionId + ':')) retained.delete(scope)
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i)
      if (key === prefix + sessionId || key?.startsWith(prefix + sessionId + ':')) localStorage.removeItem(key)
    }
  } catch { /* No persisted browser draft can be removed while storage is unavailable. */ }
}
