import type { QuestionSnapshot } from '../../shared/nonblockingQuestions.js'
import type { ServerFrame, SessionId } from '../../shared/protocol.js'
import type { NestedTranscriptRow } from './transcriptProjector.js'

export type PendingQuestionsState = { sessions: Record<SessionId, QuestionSnapshot> }
export type PendingQuestionsAction = { type: 'frame'; frame: ServerFrame } | { type: 'session-removed'; sessionId: SessionId }
export const createPendingQuestionsState = (): PendingQuestionsState => ({ sessions: {} })
export function reducePendingQuestionsState(state: PendingQuestionsState, action: PendingQuestionsAction): PendingQuestionsState {
  if (action.type === 'session-removed') {
    if (!state.sessions[action.sessionId]) return state
    const sessions = { ...state.sessions }
    delete sessions[action.sessionId]
    return { sessions }
  }
  const frame = action.frame
  if (frame.kind === 'event' && frame.event.type === 'question.snapshot') {
    return { sessions: { ...state.sessions, [frame.sessionId]: frame.event.snapshot } }
  }
  if ((frame.kind === 'transcript.reset' || frame.kind === 'ready') && state.sessions[frame.sessionId]) {
    const sessions = { ...state.sessions }
    delete sessions[frame.sessionId]
    return { sessions }
  }
  return state
}

/** Lifecycle state overlays are selectors, never mutations of transcript rows. */
const lifecycleRows = new WeakMap<QuestionSnapshot, WeakMap<NestedTranscriptRow, NestedTranscriptRow>>()
export function projectQuestionLifecycles(rows: NestedTranscriptRow[], snapshot: QuestionSnapshot | undefined): NestedTranscriptRow[] {
  if (!snapshot) return rows
  let cache = lifecycleRows.get(snapshot)
  if (!cache) lifecycleRows.set(snapshot, cache = new WeakMap())
  const states = new Map<string, { question: string; state: 'pending' | 'answered' | 'dismissed'; answer?: string; notes?: string }>([...snapshot.pending.map(q => [JSON.stringify([q.toolUseId, q.questionIndex]), { ...q, state: 'pending' as const }] as const), ...snapshot.resolved.map(q => [JSON.stringify([q.toolUseId, q.questionIndex]), q] as const)])
  const visit = (rows: NestedTranscriptRow[]): NestedTranscriptRow[] => {
    let projected: NestedTranscriptRow[] | undefined
    rows.forEach((row, index) => {
      let next = cache.get(row)
      if (!next) {
        next = project(row)
        cache.set(row, next)
      }
      if (next !== row && !projected) projected = rows.slice(0, index)
      projected?.push(next)
    })
    return projected ?? rows
  }
  const project = (row: NestedTranscriptRow): NestedTranscriptRow => {
    const children = visit(row.children)
    if (row.kind !== 'tool-use' || row.toolName !== 'AskUserQuestion' || !Array.isArray(row.input.questions)) return children === row.children ? row : { ...row, children }
    const answers: Record<string, string> = Object.create(null)
    const notesByQuestion: Record<string, string> = Object.create(null)
    const statesByQuestion: Record<string, 'pending' | 'answered' | 'dismissed'> = Object.create(null)
    row.input.questions.forEach((value, index) => {
      const state = states.get(JSON.stringify([row.toolUseId, index]))
      if (!state) return
      statesByQuestion[state.question] = state.state
      if (state.state === 'answered') {
        answers[state.question] = state.answer ?? ''
        if (state.notes) notesByQuestion[state.question] = state.notes
      }
    })
    if (!Object.keys(statesByQuestion).length) return children === row.children ? row : { ...row, children }
    const result = { ...(row.result ?? { isError: false, content: '', diff: null }), askUserQuestion: { answers, notesByQuestion, statesByQuestion } }
    return { ...row, children, status: 'success', result }
  }
  return visit(rows)
}
