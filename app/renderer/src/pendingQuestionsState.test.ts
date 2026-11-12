import { expect, test } from 'bun:test'
import { PROTOCOL_VERSION } from '../../shared/protocol.js'
import { createPendingQuestionsState, projectQuestionLifecycles, reducePendingQuestionsState } from './pendingQuestionsState.js'
import type { NestedTranscriptRow } from './transcriptProjector.js'
import type { QuestionSnapshot } from '../../shared/nonblockingQuestions.js'

const question = (questionIndex: number) => ({ toolUseId: 'call', sourceMessageUuid: 'assistant', questionIndex, question: `Question ${questionIndex}?`, options: [], multiSelect: false })
const snapshot: QuestionSnapshot = { pending: [question(2)], resolved: [{ ...question(0), state: 'answered', answer: 'Answer', notes: 'Note' }, { ...question(1), state: 'dismissed' }] }
const row = (): Extract<NestedTranscriptRow, { kind: 'tool-use' }> => ({ kind: 'tool-use', id: 'row', sessionId: 'session', messageId: 'assistant', frameId: 'assistant', blockIndex: 0, parentToolUseId: null, children: [], toolUseId: 'call', toolName: 'AskUserQuestion', toolFamily: 'other', input: { questions: [question(0), question(1), question(2)] }, status: 'success', agentCompletion: null, result: { content: 'Question shown to the user. No answer yet; it will arrive as a separate message.', isError: false, diff: null } })

test('question snapshots are session-scoped and explicit reset removes stale lifecycle state', () => {
  const state = reducePendingQuestionsState(createPendingQuestionsState(), { type: 'frame', frame: { kind: 'event', protocolVersion: PROTOCOL_VERSION, sessionId: 'session', event: { type: 'question.snapshot', snapshot } } })
  expect(state.sessions.session).toEqual(snapshot)
  expect(state.sessions.other).toBeUndefined()
  expect(reducePendingQuestionsState(state, { type: 'session-removed', sessionId: 'session' }).sessions).toEqual({})
})

test('partial answers, silent dismissal and pending rows overlay without changing stored transcript rows', () => {
  const original = row()
  Object.freeze(original.result)
  Object.freeze(original.children)
  Object.freeze(original)
  const projected = projectQuestionLifecycles([original], snapshot)[0] as Extract<NestedTranscriptRow, { kind: 'tool-use' }>
  expect(projected.result?.askUserQuestion).toEqual({ answers: { 'Question 0?': 'Answer' }, notesByQuestion: { 'Question 0?': 'Note' }, statesByQuestion: { 'Question 0?': 'answered', 'Question 1?': 'dismissed', 'Question 2?': 'pending' } })
  expect(original.result?.askUserQuestion).toBeUndefined()
})

test('missing lifecycle state preserves legacy rows; another call cannot inherit an answer', () => {
  const original = row()
  expect(projectQuestionLifecycles([original], undefined)[0]).toBe(original)
  const other = { ...original, toolUseId: 'other-call' }
  const projected = projectQuestionLifecycles([other], snapshot)[0]
  expect(projected?.kind === 'tool-use' ? projected.result?.askUserQuestion : undefined).toBeUndefined()
})

test('overlays copy only the question ancestor path and keep unrelated subtree identity', () => {
  const unrelated = { ...row(), id: 'unrelated', toolUseId: 'different', children: [{ ...row(), toolUseId: 'also-different' }] }
  const questionRow = row()
  const parent = { ...row(), toolUseId: 'parent', children: [questionRow, unrelated] }
  const rows = [unrelated, parent]
  expect(projectQuestionLifecycles(rows, { pending: [], resolved: [] })).toBe(rows)
  const next = projectQuestionLifecycles(rows, snapshot)
  expect(next).not.toBe(rows)
  expect(next[0]).toBe(unrelated)
  expect(next[1]).not.toBe(parent)
  expect(next[1]!.children[1]).toBe(unrelated)
  expect(next[1]!.children[0]).not.toBe(questionRow)
  expect(next[1]!.children[0]!.children).toBe(questionRow.children)
  const later = projectQuestionLifecycles([...rows, { ...unrelated, id: 'tail' }], snapshot)
  expect(later[1]).toBe(next[1])
  const dismissed = projectQuestionLifecycles(rows, {
    pending: [], resolved: [{ ...question(0), state: 'dismissed' }],
  })
  expect(dismissed[1]!.children[0]).not.toBe(next[1]!.children[0])
  expect(projectQuestionLifecycles(rows, undefined)).toBe(rows)
})
