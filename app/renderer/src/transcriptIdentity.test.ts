import { expect, test } from 'bun:test'
import { PROTOCOL_VERSION } from '../../shared/protocol.js'
import { createTranscriptState, projectServerFrame, selectNestedTranscriptRows, selectFocusedLiveState, type NestedTranscriptRow } from './transcriptProjector.js'
import { createTranscriptFileScopesSelector } from './transcriptFileScope.js'
import { createRecoveredResponseCopySelector } from './transcriptViewModel.js'

const prose = (id: string, content = id): Extract<NestedTranscriptRow, { kind: 'assistant-text' }> => ({ kind: 'assistant-text', id, frameId: id, sessionId: 's', messageId: id, blockIndex: 0, parentToolUseId: null, content, role: 'assistant', children: [] })
function initial() {
  return projectServerFrame(createTranscriptState(), { kind: 'ready', protocolVersion: PROTOCOL_VERSION, sessionId: 's', engineSessionId: 'engine', payload: { type: 'app.ready', protocolVersion: 1, inputEnabled: true, activeTurn: false, abort: { status: 'idle' }, goalSnapshot: null, pendingPermissionRequests: [] } })
}

test('activity-only slices reuse nested arrays in both views; every structural dependency invalidates', () => {
  const state = initial()
  state.sessions.s!.rows = [prose('a')]
  for (const reveal of [false, true]) {
    const rows = selectNestedTranscriptRows(state, 's', reveal)
    const session = state.sessions.s!
    const activity = { ...state, sessions: { s: { ...session, activities: { ...session.activities } } } }
    expect(selectNestedTranscriptRows(activity, 's', reveal)).toBe(rows)
    for (const change of [
      { rows: [...session.rows, prose('b')] },
      { hiddenFrameIds: { a: true as const } },
      { historyTruncated: true },
      { toolResultsByUseId: { ...session.toolResultsByUseId } },
      { autoModeReviews: { ...session.autoModeReviews } },
      { agentCompletionsByToolUseId: { ...session.agentCompletionsByToolUseId } },
      { unavailableParentToolUseIds: new Set(['worker']) },
    ]) {
      const next = { ...state, sessions: { s: { ...session, ...change } } }
      expect(selectNestedTranscriptRows(next, 's', reveal)).not.toBe(rows)
      selectNestedTranscriptRows(activity, 's', reveal)
    }
  }
})

test('live wrappers retain equal inputs but invalidate approval, preparation and visible-work changes', () => {
  const state = initial()
  const live = selectFocusedLiveState(state, 's')
  expect(selectFocusedLiveState(state, 's')).toBe(live)
  expect(selectFocusedLiveState({ ...state, sessions: { s: { ...state.sessions.s!, rows: [] } } }, 's')).toBe(live)
  for (const change of [{ awaitingApproval: { call: true as const } }, { preparing: { ...state.sessions.s!.preparing } }, { lastVisibleChangeAt: 123 }]) {
    expect(selectFocusedLiveState({ ...state, sessions: { s: { ...state.sessions.s!, ...change } } }, 's')).not.toBe(live)
    selectFocusedLiveState(state, 's')
  }
  expect(selectFocusedLiveState(state, 'missing')).toBeNull()
})

test('tool completion and hidden membership are not masked by activity-only reuse', () => {
  const state = initial()
  const tool = { ...prose('tool'), kind: 'tool-use' as const, toolUseId: 'call', toolName: 'Read', toolFamily: 'other' as const,
    input: {}, status: 'pending' as const, result: null, agentCompletion: null }
  state.sessions.s!.rows = [tool]
  const before = selectNestedTranscriptRows(state, 's')
  const completed = { ...state, sessions: { s: { ...state.sessions.s!,
    toolResultsByUseId: { call: { content: 'done', isError: false, diff: null } } } } }
  const after = selectNestedTranscriptRows(completed, 's')
  expect(after[0]?.kind === 'tool-use' && after[0].status).toBe('success')
  expect(after[0]).not.toBe(before[0])
  const hidden = { ...completed, sessions: { s: { ...completed.sessions.s, hiddenFrameIds: { tool: true as const } } } }
  expect(selectNestedTranscriptRows(hidden, 's')).toHaveLength(0)
  expect(selectNestedTranscriptRows(hidden, 's', true)[0]?.isHidden).toBe(true)
  expect(selectNestedTranscriptRows(completed, 's')[0]).toBe(after[0])
  expect(selectNestedTranscriptRows(completed, 'missing')).toHaveLength(0)
})

test('scope selectors retain equivalent nonempty maps, update moves, and clear on session switch', () => {
  const select = createTranscriptFileScopesSelector()
  const rows = [prose('a')]
  const transitions = [{ id: 'move', afterFrameId: null, cwd: '/one', binding: { kind: 'project' as const } }]
  const first = select(rows, transitions)
  expect(first.get('a')).toBe('/one')
  expect(select([prose('a', 'changed text')], [...transitions])).toBe(first)
  expect(select(rows, [{ ...transitions[0]!, cwd: '/two' }]).get('a')).toBe('/two')
  const empty = select([prose('other')])
  expect(empty.size).toBe(0)
  expect(select([])).toBe(empty)
  expect(select(rows, transitions)).not.toBe(empty)
})

test('recovered-copy selectors preserve equivalent maps and invalidate continued text or streaming', () => {
  const select = createRecoveredResponseCopySelector()
  const notice: NestedTranscriptRow = { kind: 'system-notice', id: 'retry', frameId: 'retry', sessionId: 's', noticeType: 'api_retry', content: 'retry', retry: { state: 'success', reason: 'network', attempt: 1, delayMs: 0, updateId: 'retry', replay: false }, children: [] }
  const rows = [prose('a', 'first'), notice, prose('b', 'second')]
  const first = select(rows)
  expect(first.get('b')).toBe('first\n\nsecond')
  expect(select([...rows, prose('c')])).not.toBe(first)
  expect(select([...rows])).toEqual(first)
  const stable = select(rows)
  expect(select([...rows, { ...prose('tool'), kind: 'user-text', role: 'user' } as NestedTranscriptRow])).toBe(stable)
  expect(select([rows[0]!, notice, prose('b', 'new')]).get('b')).toBe('first\n\nnew')
  expect(select([rows[0]!, notice, { ...prose('b'), isStreaming: true }]).size).toBe(0)
  const empty = select([])
  expect(select([prose('other')])).toBe(empty)
})
