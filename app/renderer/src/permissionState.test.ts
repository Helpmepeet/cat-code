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
): ServerFrame {
  return {
    kind: 'ready',
    protocolVersion: 1,
    sessionId: 'session-1',
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

  expect(state.pending).toEqual([REQUEST])
  expect(selectVisiblePermission(state)).toEqual(REQUEST)
})

test('upserts requested permissions and removes them when resolved', () => {
  let state = reducePermissionState(createPermissionState(), {
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

  expect(state.pending).toEqual([])
})

test('a sent decision removes the prompt immediately without a resolving state', () => {
  const hydrated = reducePermissionState(createPermissionState(), {
    type: 'frame',
    frame: readyFrame(),
  })
  const state = reducePermissionState(hydrated, {
    type: 'decided',
    requestId: REQUEST.requestId,
  })

  expect(state.pending).toEqual([])
  expect(selectVisiblePermission(state)).toBeNull()
})

test('dismiss hides a request without resolving it', () => {
  const hydrated = reducePermissionState(createPermissionState(), {
    type: 'frame',
    frame: readyFrame(),
  })
  const state = reducePermissionState(hydrated, {
    type: 'dismissed',
    requestId: REQUEST.requestId,
  })

  expect(state.pending).toEqual([REQUEST])
  expect(selectVisiblePermission(state)).toBeNull()
})

test('allow echoes the exact gated input and cannot carry updatedPermissions', () => {
  const response = buildAllowResponse(REQUEST)

  expect(response).toEqual({
    behavior: 'allow',
    updatedInput: REQUEST.request.input,
  })
  expect('updatedPermissions' in response).toBe(false)
  expect(response.updatedInput).toBe(REQUEST.request.input)
})

test('deny carries the fixed user-decision reason', () => {
  expect(buildDenyResponse()).toEqual({
    behavior: 'deny',
    message: 'Denied by user',
  })
})
