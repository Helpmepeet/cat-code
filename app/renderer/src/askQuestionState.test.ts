import { expect, test } from 'bun:test'
import {
  createPermissionState,
  reducePermissionState,
  type PermissionRequest,
} from './permissionState.js'
import {
  ASK_USER_QUESTION_TOOL_NAME,
  isAskUserQuestionRequest,
  narrowAskQuestions,
  selectAskQuestion,
  selectGenericPermissionQueue,
} from './askQuestionState.js'
import { selectNonPlanPermissionQueue } from './planState.js'

const ASK_REQUEST: PermissionRequest = {
  requestId: 'perm-ask-1',
  request: {
    subtype: 'can_use_tool' as const,
    tool_name: ASK_USER_QUESTION_TOOL_NAME,
    input: {
      questions: [
        {
          question: 'Which library?',
          header: 'Library',
          multiSelect: false,
          options: [
            { label: 'date-fns', description: 'lightweight', preview: 'import x' },
            { label: 'luxon', description: 'rich' },
          ],
        },
      ],
      metadata: { source: 'test' },
    },
    tool_use_id: 'toolu-ask-1',
  },
}

const BASH_REQUEST: PermissionRequest = {
  requestId: 'perm-bash-1',
  request: {
    subtype: 'can_use_tool' as const,
    tool_name: 'Bash',
    input: { command: 'date' },
    tool_use_id: 'toolu-bash-1',
  },
}

function readyFrame(pendingPermissionRequests: PermissionRequest[], sessionId = 'session-1') {
  return {
    kind: 'ready' as const,
    protocolVersion: 2 as const,
    sessionId,
    engineSessionId: `engine-${sessionId}`,
    payload: {
      type: 'app.ready' as const,
      protocolVersion: 1 as const,
      inputEnabled: false,
      activeTurn: true,
      abort: { status: 'idle' as const },
      goalSnapshot: null,
      pendingPermissionRequests,
    },
  }
}

function withRequests(...requests: PermissionRequest[]) {
  // A `ready` frame seeds the session AND its pending queue (a bare
  // `permission.requested` event is dropped when the session doesn't exist yet).
  return reducePermissionState(createPermissionState(), {
    type: 'frame',
    frame: readyFrame(requests),
  })
}

test('isAskUserQuestionRequest matches only the AskUserQuestion tool', () => {
  expect(isAskUserQuestionRequest(ASK_REQUEST)).toBe(true)
  expect(isAskUserQuestionRequest(BASH_REQUEST)).toBe(false)
})

test('narrowAskQuestions reads well-formed questions with options + preview', () => {
  const questions = narrowAskQuestions(ASK_REQUEST.request.input)
  expect(questions).toHaveLength(1)
  expect(questions[0]!.header).toBe('Library')
  expect(questions[0]!.multiSelect).toBe(false)
  expect(questions[0]!.options).toEqual([
    { label: 'date-fns', description: 'lightweight', preview: 'import x' },
    { label: 'luxon', description: 'rich', preview: null },
  ])
})

test('narrowAskQuestions defensively drops malformed questions/options', () => {
  // Missing question text, non-array options, and a non-string label are all
  // dropped rather than trusted (display degrades gracefully).
  expect(narrowAskQuestions({})).toEqual([])
  expect(narrowAskQuestions({ questions: 'nope' })).toEqual([])
  expect(
    narrowAskQuestions({ questions: [{ header: 'x', options: [] }] }),
  ).toEqual([])
  expect(
    narrowAskQuestions({
      questions: [{ question: 'q', options: [{ description: 'no label' }] }],
    }),
  ).toEqual([])
})

test('selectAskQuestion returns the pending AskUserQuestion review', () => {
  const state = withRequests(BASH_REQUEST, ASK_REQUEST)
  const review = selectAskQuestion(state, 'session-1')
  expect(review).not.toBeNull()
  expect(review!.request.requestId).toBe('perm-ask-1')
  expect(review!.submitted).toBe(false)
  expect(review!.questions[0]!.question).toBe('Which library?')
})

test('selectAskQuestion is null when there is no AskUserQuestion pending', () => {
  const state = withRequests(BASH_REQUEST)
  expect(selectAskQuestion(state, 'session-1')).toBeNull()
})

test('selectAskQuestion is null when the request has zero readable questions', () => {
  const malformed: PermissionRequest = {
    requestId: 'perm-ask-bad',
    request: {
      subtype: 'can_use_tool',
      tool_name: ASK_USER_QUESTION_TOOL_NAME,
      input: { questions: [] },
      tool_use_id: 'toolu-ask-bad',
    },
  }
  const state = withRequests(malformed)
  expect(selectAskQuestion(state, 'session-1')).toBeNull()
})

test('selectAskQuestion reflects the in-flight submitted flag', () => {
  let state = withRequests(ASK_REQUEST)
  state = reducePermissionState(state, {
    type: 'submitted',
    sessionId: 'session-1',
    requestId: 'perm-ask-1',
  })
  expect(selectAskQuestion(state, 'session-1')!.submitted).toBe(true)
})

test('selectGenericPermissionQueue drops the ask flow but keeps other cards', () => {
  const state = withRequests(BASH_REQUEST, ASK_REQUEST)
  const generic = selectGenericPermissionQueue(
    selectNonPlanPermissionQueue(state, 'session-1'),
  )
  expect(generic.map(item => item.request.requestId)).toEqual(['perm-bash-1'])
})

// The dedicated flow declines a malformed request (selectAskQuestion → null), so
// the generic queue must KEEP it. Excluding it from both paths would leave the
// request invisible and permanently pending, with no way to answer or decline.
test('selectGenericPermissionQueue keeps a malformed ask request the dedicated flow cannot render', () => {
  const malformed: PermissionRequest = {
    requestId: 'perm-ask-bad',
    request: {
      subtype: 'can_use_tool',
      tool_name: ASK_USER_QUESTION_TOOL_NAME,
      input: { questions: [] },
      tool_use_id: 'toolu-ask-bad',
    },
  }
  const state = withRequests(malformed)
  expect(selectAskQuestion(state, 'session-1')).toBeNull()
  const generic = selectGenericPermissionQueue(
    selectNonPlanPermissionQueue(state, 'session-1'),
  )
  expect(generic.map(item => item.request.requestId)).toEqual(['perm-ask-bad'])
})
