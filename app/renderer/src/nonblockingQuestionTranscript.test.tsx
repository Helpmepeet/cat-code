import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { PROTOCOL_VERSION, type ServerFrame } from '../../shared/protocol.js'
import { createTranscriptState, projectServerFrames, selectNestedTranscriptRows } from './transcriptProjector.js'
import { TranscriptRowsView } from './TranscriptView.js'
import { projectQuestionLifecycles } from './pendingQuestionsState.js'

const ready: ServerFrame = { kind: 'ready', protocolVersion: PROTOCOL_VERSION, sessionId: 'a', engineSessionId: 'engine-a', payload: { type: 'app.ready', protocolVersion: 1, inputEnabled: true, activeTurn: false, abort: { status: 'idle' }, goalSnapshot: null, pendingPermissionRequests: [] } }
const project = (messages: unknown[]) => selectNestedTranscriptRows(projectServerFrames(createTranscriptState(), [ready, ...messages.map(message => ({ kind: 'event' as const, protocolVersion: PROTOCOL_VERSION, sessionId: 'a', event: { type: 'message' as const, message: message as never } }))]), 'a')
const records = [{ toolUseId: 'old', questionIndex: 0, question: 'Same question?', answer: 'Old answer', notes: 'User note' }, { toolUseId: 'current', questionIndex: 0, question: 'Same question?', answer: 'Current answer' }]
const refs = records.map(({ toolUseId, questionIndex }) => ({ toolUseId, questionIndex }))
function reply(content: string, displayQuestions?: typeof refs) { return { type: 'user', session_id: 'a', parent_tool_use_id: null, uuid: 'reply', isReplay: true, origin: { kind: 'question-reply', batchId: 'close', questions: refs, ...(displayQuestions !== undefined ? { displayQuestions } : {}) }, message: { role: 'user', content } } }

test('idle answer batches render every attached question, including duplicate text from different calls', () => {
  for (const content of [JSON.stringify(records), 'The user answered questions you asked earlier (AskUserQuestion). Each quoted record identifies its question and answer:\n' + JSON.stringify(records)]) {
    const rows = project([reply(content)])
    expect(rows[0]?.kind).toBe('question-reply')
    const html = renderToStaticMarkup(<TranscriptRowsView rows={rows} />)
    expect(html.split('Same question?')).toHaveLength(3)
    expect(html).toContain('Old answer')
    expect(html).toContain('Current answer')
    expect(html).toContain('User note')
    const visible = html.replace(/<[^>]*>/g, '')
    expect(visible).not.toContain('question-reply')
    expect(visible).not.toContain('toolUseId')
  }
})

test('same-turn replies fill original rows without an extra row; earlier-turn answers remain visible in the current turn', () => {
  expect(project([reply(JSON.stringify(records), [])])).toHaveLength(0)
  const rows = project([reply(JSON.stringify(records), [refs[0]!])])
  const html = renderToStaticMarkup(<TranscriptRowsView rows={rows} />)
  expect(html).toContain('Old answer')
  expect(html).not.toContain('Current answer')
})

test('headerless free-text saved answers keep rendering, and per-question dismissal is Dismissed', () => {
  const question = { question: 'What name?', options: [], multiSelect: false }
  const messages = [
    { type: 'assistant', uuid: 'ask-source', session_id: 'a', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'ask', name: 'AskUserQuestion', input: { questions: [question] } }] } },
    { type: 'user', uuid: 'result', session_id: 'a', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'ask', content: 'User has answered your questions.' }] }, tool_use_result: { questions: [question], answers: { 'What name?': 'New name' }, annotations: { 'What name?': { notes: 'User note' } } } },
  ]
  const rows = project(messages)
  const html = renderToStaticMarkup(<TranscriptRowsView rows={rows} />)
  expect(html).toContain('What name?')
  expect(html).toContain('New name')
  expect(html).toContain('User note')
  const dismissed = projectQuestionLifecycles(rows, { pending: [], resolved: [{ ...question, toolUseId: 'ask', sourceMessageUuid: 'ask-source', questionIndex: 0, state: 'dismissed' }] })
  const after = renderToStaticMarkup(<TranscriptRowsView rows={dismissed} />)
  expect(after).toContain('Dismissed')
  expect(after).not.toContain('New name')
  const legacy = project([{ ...messages[0]!, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'ask', name: 'AskUserQuestion', input: { questions: [{ ...question, header: 'Legacy' }] } }] } }, messages[1]])
  expect(renderToStaticMarkup(<TranscriptRowsView rows={legacy} />)).toContain('New name')
})
