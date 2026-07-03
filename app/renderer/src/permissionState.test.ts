import { expect, test } from 'bun:test'
import type { ServerFrame } from '../../shared/protocol.js'
import {
  buildAllowResponse,
  buildDenyResponse,
  createPermissionState,
  reducePermissionState,
  selectVisiblePermission,
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
  expect(selectVisiblePermission(state)).toEqual(REQUEST)
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
  expect(selectVisiblePermission(state)).toBeNull()
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
  expect(selectVisiblePermission(state)).toBeNull()
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
  expect(selectVisiblePermission(state)).toBeNull()
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

  expect(state.activeSessionId).toBe('session-2')
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
