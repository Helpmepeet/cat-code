import { expect, test } from 'bun:test'
import type { ServerFrame } from '../../shared/protocol.js'
import {
  buildAllowResponse,
  buildDenyResponse,
  createPermissionState,
  reducePermissionState,
  selectAdditionalWorkingDirectories,
  selectPermissionContext,
  selectPermissionQueue,
  selectVisiblePermission,
  type PermissionRequest,
} from './permissionState.js'

const REQUEST = {
  requestId: 'perm-1',
  request: {
    subtype: 'can_use_tool' as const,
    tool_name: 'Bash',
    input: { command: 'date' },
    tool_use_id: 'toolu-1',
  },
}

function readyFrame(
  pendingPermissionRequests = [REQUEST],
  sessionId = 'session-1',
): ServerFrame {
  return {
    kind: 'ready',
    protocolVersion: 1,
    sessionId,
    engineSessionId: `engine-${sessionId}`,
    payload: {
      type: 'app.ready',
      protocolVersion: 1,
      inputEnabled: false,
      activeTurn: true,
      abort: { status: 'idle' },
      goalSnapshot: null,
      pendingPermissionRequests,
    },
  }
}

test('hydrates pending permission requests from the ready frame', () => {
  const state = reducePermissionState(createPermissionState(), {
    type: 'frame',
    frame: readyFrame(),
  })

  expect(state.sessions['session-1']?.pending).toEqual([REQUEST])
  expect(selectVisiblePermission(state, 'session-1')).toEqual(REQUEST)
})

test('upserts requested permissions and removes them when resolved', () => {
  let state = reducePermissionState(createPermissionState(), {
    type: 'frame',
    frame: readyFrame([], 'session-1'),
  })
  state = reducePermissionState(state, {
    type: 'frame',
    frame: {
      kind: 'event',
      protocolVersion: 1,
      sessionId: 'session-1',
      event: { type: 'permission.requested', request: REQUEST },
    },
  })
  state = reducePermissionState(state, {
    type: 'frame',
    frame: {
      kind: 'event',
      protocolVersion: 1,
      sessionId: 'session-1',
      event: {
        type: 'permission.resolved',
        request: REQUEST,
        response: {
          behavior: 'allow',
          updatedInput: REQUEST.request.input,
        },
      },
    },
  })

  expect(state.sessions['session-1']?.pending).toEqual([])
})

test('a submitted decision hides the prompt but retains it until resolved', () => {
  const hydrated = reducePermissionState(createPermissionState(), {
    type: 'frame',
    frame: readyFrame(),
  })
  const state = reducePermissionState(hydrated, {
    type: 'submitted',
    sessionId: 'session-1',
    requestId: REQUEST.requestId,
  })

  expect(state.sessions['session-1']?.pending).toEqual([REQUEST])
  expect(selectVisiblePermission(state, 'session-1')).toBeNull()
})

test('an addressed transport error restores a submitted permission for retry', () => {
  let state = reducePermissionState(createPermissionState(), {
    type: 'frame',
    frame: readyFrame(),
  })
  state = reducePermissionState(state, {
    type: 'submitted',
    sessionId: 'session-1',
    requestId: REQUEST.requestId,
  })
  state = reducePermissionState(state, {
    type: 'frame',
    frame: {
      kind: 'error',
      protocolVersion: 1,
      sessionId: 'session-1',
      requestId: REQUEST.requestId,
      code: 'internal_error',
      message: 'write failed',
      retryable: true,
    },
  })

  expect(selectVisiblePermission(state, 'session-1')).toEqual(REQUEST)
})

test('a synchronous bridge failure restores a submitted permission for retry', () => {
  let state = reducePermissionState(createPermissionState(), {
    type: 'frame',
    frame: readyFrame(),
  })
  state = reducePermissionState(state, {
    type: 'submitted',
    sessionId: 'session-1',
    requestId: REQUEST.requestId,
  })
  state = reducePermissionState(state, {
    type: 'submissionFailed',
    sessionId: 'session-1',
    requestId: REQUEST.requestId,
  })

  expect(selectVisiblePermission(state, 'session-1')).toEqual(REQUEST)
})

test('terminal lifecycle clears permissions owned by the dead sidecar', () => {
  const hydrated = reducePermissionState(createPermissionState(), {
    type: 'frame',
    frame: readyFrame(),
  })
  const state = reducePermissionState(hydrated, {
    type: 'frame',
    frame: {
      kind: 'lifecycle',
      protocolVersion: 1,
      sessionId: 'session-1',
      status: 'disconnected',
    },
  })

  expect(state.sessions['session-1']?.pending).toEqual([])
  expect(selectVisiblePermission(state, 'session-1')).toBeNull()
})

test('dismiss hides a request without resolving it', () => {
  const hydrated = reducePermissionState(createPermissionState(), {
    type: 'frame',
    frame: readyFrame(),
  })
  const state = reducePermissionState(hydrated, {
    type: 'dismissed',
    sessionId: 'session-1',
    requestId: REQUEST.requestId,
  })

  expect(state.sessions['session-1']?.pending).toEqual([REQUEST])
  expect(selectVisiblePermission(state, 'session-1')).toBeNull()
})

test('allow sends an empty confirmation and cannot echo oversized gated input', () => {
  const response = buildAllowResponse(REQUEST)

  expect(response).toEqual({
    behavior: 'allow',
    updatedInput: {},
  })
  expect('updatedPermissions' in response).toBe(false)
  expect(JSON.stringify(response)).not.toContain('"command"')
})

test('deny carries the fixed user-decision reason', () => {
  expect(buildDenyResponse()).toEqual({
    behavior: 'deny',
    message: 'Denied by user',
  })
})

test('permission and lifecycle frames cannot clear another session queue', () => {
  const request2 = {
    ...REQUEST,
    requestId: 'perm-2',
    request: { ...REQUEST.request, tool_use_id: 'toolu-2' },
  }
  let state = createPermissionState()
  state = reducePermissionState(state, {
    type: 'frame',
    frame: readyFrame([REQUEST], 'session-1'),
  })
  state = reducePermissionState(state, {
    type: 'frame',
    frame: readyFrame([request2], 'session-2'),
  })
  state = reducePermissionState(state, {
    type: 'frame',
    frame: {
      kind: 'lifecycle',
      protocolVersion: 1,
      sessionId: 'session-1',
      status: 'disconnected',
    },
  })

  expect(selectVisiblePermission(state, 'session-2')).toEqual(request2)
  expect(state.sessions['session-1']?.pending).toEqual([])
})

test('resolved and error frames are isolated even when sessions reuse a request id', () => {
  let state = createPermissionState()
  state = reducePermissionState(state, {
    type: 'frame',
    frame: readyFrame([REQUEST], 'session-1'),
  })
  state = reducePermissionState(state, {
    type: 'frame',
    frame: readyFrame([REQUEST], 'session-2'),
  })
  state = reducePermissionState(state, {
    type: 'submitted',
    sessionId: 'session-2',
    requestId: REQUEST.requestId,
  })
  state = reducePermissionState(state, {
    type: 'frame',
    frame: {
      kind: 'event',
      protocolVersion: 1,
      sessionId: 'session-1',
      event: {
        type: 'permission.resolved',
        request: REQUEST,
        response: { behavior: 'deny', message: 'no' },
      },
    },
  })
  state = reducePermissionState(state, {
    type: 'frame',
    frame: {
      kind: 'error',
      protocolVersion: 1,
      sessionId: 'session-1',
      requestId: REQUEST.requestId,
      code: 'bad_request',
      message: 'wrong session',
      retryable: false,
    },
  })

  expect(state.sessions['session-1']?.pending).toEqual([])
  expect(state.sessions['session-2']?.pending).toEqual([REQUEST])
  expect(selectVisiblePermission(state, 'session-2')).toBeNull()

  state = reducePermissionState(state, {
    type: 'frame',
    frame: {
      kind: 'error',
      protocolVersion: 1,
      sessionId: 'session-2',
      requestId: REQUEST.requestId,
      code: 'bad_request',
      message: 'retry',
      retryable: true,
    },
  })
  expect(selectVisiblePermission(state, 'session-2')).toEqual(REQUEST)
})

/* ------------------------------------------------------------------------- *
 * P2-4 — multi-pending queue, universal resolved dismiss, C3 context, C1
 * suggestion selection (S2 §1–§2, decisions/PERMISSION-BOUNDARY.md)
 * ------------------------------------------------------------------------- */

const REQUEST_2 = {
  requestId: 'perm-2',
  request: {
    subtype: 'can_use_tool' as const,
    tool_name: 'Read',
    input: { file_path: '/tmp/x' },
    tool_use_id: 'toolu-2',
  },
}

const CONTEXT_SNAPSHOT = {
  mode: 'acceptEdits',
  alwaysAllowRules: { userSettings: ['Bash(date:*)'] },
  alwaysDenyRules: {},
  alwaysAskRules: {},
  additionalWorkingDirectories: [],
  isBypassPermissionsModeAvailable: false,
}

function requestedFrame(
  request: PermissionRequest,
  sessionId = 'session-1',
): ServerFrame {
  return {
    kind: 'event',
    protocolVersion: 1,
    sessionId,
    event: { type: 'permission.requested', request },
  }
}

function resolvedFrame(
  request: PermissionRequest,
  sessionId = 'session-1',
  response: { behavior: 'allow'; updatedInput: Record<string, unknown> } | { behavior: 'deny'; message: string } = {
    behavior: 'deny',
    message: 'Session aborted',
  },
): ServerFrame {
  return {
    kind: 'event',
    protocolVersion: 1,
    sessionId,
    event: { type: 'permission.resolved', request, response },
  }
}

test('multiple pendings queue in arrival order with no timeout', () => {
  let state = reducePermissionState(createPermissionState(), {
    type: 'frame',
    frame: readyFrame([], 'session-1'),
  })
  state = reducePermissionState(state, { type: 'frame', frame: requestedFrame(REQUEST) })
  state = reducePermissionState(state, { type: 'frame', frame: requestedFrame(REQUEST_2) })

  const queue = selectPermissionQueue(state, 'session-1')
  expect(queue.map(item => item.request.requestId)).toEqual(['perm-1', 'perm-2'])
  expect(queue.every(item => !item.submitted && !item.dismissed)).toBe(true)
  // The keyboard target is the head of the queue.
  expect(selectVisiblePermission(state, 'session-1')).toEqual(REQUEST)
})

test('permission.resolved is the universal dismiss — only the resolved card leaves', () => {
  let state = reducePermissionState(createPermissionState(), {
    type: 'frame',
    frame: readyFrame([], 'session-1'),
  })
  state = reducePermissionState(state, { type: 'frame', frame: requestedFrame(REQUEST) })
  state = reducePermissionState(state, { type: 'frame', frame: requestedFrame(REQUEST_2) })

  // Resolved by ANOTHER surface (this window never submitted an answer).
  state = reducePermissionState(state, { type: 'frame', frame: resolvedFrame(REQUEST) })

  expect(selectPermissionQueue(state, 'session-1').map(i => i.request.requestId)).toEqual([
    'perm-2',
  ])
})

test('an abort mass-deny arrives as N resolved frames and empties the queue', () => {
  let state = reducePermissionState(createPermissionState(), {
    type: 'frame',
    frame: readyFrame([], 'session-1'),
  })
  state = reducePermissionState(state, { type: 'frame', frame: requestedFrame(REQUEST) })
  state = reducePermissionState(state, { type: 'frame', frame: requestedFrame(REQUEST_2) })

  state = reducePermissionState(state, { type: 'frame', frame: resolvedFrame(REQUEST) })
  state = reducePermissionState(state, { type: 'frame', frame: resolvedFrame(REQUEST_2) })

  expect(selectPermissionQueue(state, 'session-1')).toEqual([])
})

test('a snoozed card can be restored for answering', () => {
  let state = reducePermissionState(createPermissionState(), {
    type: 'frame',
    frame: readyFrame([REQUEST]),
  })
  state = reducePermissionState(state, {
    type: 'dismissed',
    sessionId: 'session-1',
    requestId: REQUEST.requestId,
  })
  expect(selectVisiblePermission(state, 'session-1')).toBeNull()
  expect(selectPermissionQueue(state, 'session-1')[0]?.dismissed).toBe(true)

  state = reducePermissionState(state, {
    type: 'restored',
    sessionId: 'session-1',
    requestId: REQUEST.requestId,
  })
  expect(selectVisiblePermission(state, 'session-1')).toEqual(REQUEST)
})

test('C3 — the permission.context frame is stored and selectable per session', () => {
  let state = reducePermissionState(createPermissionState(), {
    type: 'frame',
    frame: readyFrame([], 'session-1'),
  })
  expect(selectPermissionContext(state, 'session-1')).toBeNull()

  state = reducePermissionState(state, {
    type: 'frame',
    frame: {
      kind: 'permission.context',
      protocolVersion: 1,
      sessionId: 'session-1',
      context: CONTEXT_SNAPSHOT,
    },
  })

  expect(selectPermissionContext(state, 'session-1')).toEqual(CONTEXT_SNAPSHOT)
})

test('C3 — a reattach ready frame keeps the last snapshot until the next one lands', () => {
  let state = reducePermissionState(createPermissionState(), {
    type: 'frame',
    frame: readyFrame([], 'session-1'),
  })
  state = reducePermissionState(state, {
    type: 'frame',
    frame: {
      kind: 'permission.context',
      protocolVersion: 1,
      sessionId: 'session-1',
      context: CONTEXT_SNAPSHOT,
    },
  })
  state = reducePermissionState(state, {
    type: 'frame',
    frame: readyFrame([], 'session-1'),
  })

  expect(selectPermissionContext(state, 'session-1')).toEqual(CONTEXT_SNAPSHOT)
})

test('P4-14 — selectAdditionalWorkingDirectories reads the C3 context, [] before the first frame', () => {
  let state = reducePermissionState(createPermissionState(), {
    type: 'frame',
    frame: readyFrame([], 'session-1'),
  })
  expect(selectAdditionalWorkingDirectories(state, 'session-1')).toEqual([])
  expect(selectAdditionalWorkingDirectories(state, null)).toEqual([])

  const withDirs = {
    ...CONTEXT_SNAPSHOT,
    additionalWorkingDirectories: [{ path: '/repo/other', source: 'cliArg' }],
  }
  state = reducePermissionState(state, {
    type: 'frame',
    frame: {
      kind: 'permission.context',
      protocolVersion: 1,
      sessionId: 'session-1',
      context: withDirs,
    },
  })
  expect(selectAdditionalWorkingDirectories(state, 'session-1')).toEqual([
    { path: '/repo/other', source: 'cliArg' },
  ])
})

test('C1 — buildAllowResponse carries a suggestion SELECTION, never rule objects', () => {
  const always = buildAllowResponse(REQUEST, [0])
  expect(always).toEqual({
    behavior: 'allow',
    updatedInput: {},
    applySuggestions: [0],
  })
  // Indices only — no rule content can originate in the renderer.
  expect(JSON.stringify(always)).not.toContain('addRules')
  expect('updatedPermissions' in always).toBe(false)

  // Empty selection is allow-once and omits the key entirely.
  expect(buildAllowResponse(REQUEST, [])).toEqual({
    behavior: 'allow',
    updatedInput: {},
  })
})

test('deny uses the free-text feedback when provided, with a safe default', () => {
  expect(buildDenyResponse('Use pnpm, not npm')).toEqual({
    behavior: 'deny',
    message: 'Use pnpm, not npm',
  })
  expect(buildDenyResponse('   ')).toEqual({
    behavior: 'deny',
    message: 'Denied by user',
  })
})
