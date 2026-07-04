import { expect, test } from 'bun:test'
import type { SDKMessage } from '@cat-code/engine/session-events'
import { FrameReplayBuffer } from '../../main/replayBuffer.js'
import type { ServerFrame } from '../../shared/protocol.js'
import {
  createConnectionState,
  reduceConnectionState,
  selectConnection,
} from './connectionState.js'
import {
  createPermissionState,
  reducePermissionState,
  selectPermissionQueue,
} from './permissionState.js'
import {
  createRawMessageLogState,
  reduceServerFrame,
} from './rawMessageLog.js'
import { SDK_MESSAGE_FIXTURE } from './sdkMessageFixtures.js'
import {
  createTranscriptState,
  projectServerFrame,
  selectTranscriptRows,
} from './transcriptProjector.js'

const SESSION_A = 'session-a'
const SESSION_B = 'session-b'

const REQUEST_B = {
  requestId: 'permission-b',
  request: {
    subtype: 'can_use_tool' as const,
    tool_name: 'Bash',
    input: { command: 'printf B' },
    tool_use_id: 'tool-b',
  },
}

function ready(
  sessionId: string,
  pendingPermissionRequests = sessionId === SESSION_B ? [REQUEST_B] : [],
): ServerFrame {
  return {
    kind: 'ready',
    protocolVersion: 1,
    sessionId,
    engineSessionId: `engine-${sessionId}`,
    payload: {
      type: 'app.ready',
      protocolVersion: 1,
      inputEnabled: true,
      activeTurn: false,
      abort: { status: 'idle' },
      goalSnapshot: null,
      pendingPermissionRequests,
    },
  }
}

function messageFrame(sessionId: string, message: SDKMessage): ServerFrame {
  return {
    kind: 'event',
    protocolVersion: 1,
    sessionId,
    event: { type: 'message', message },
  }
}

test('interleaved fixture streams project into independent session transcripts', () => {
  const text = SDK_MESSAGE_FIXTURE.assistant.find(
    sample => sample.name === 'assistant: text block (streamed per-block frame)',
  )
  const tool = SDK_MESSAGE_FIXTURE.assistant.find(
    sample => sample.name === 'assistant: tool_use block',
  )
  const thinking = SDK_MESSAGE_FIXTURE.assistant.find(
    sample => sample.name === 'assistant: thinking block',
  )
  const redacted = SDK_MESSAGE_FIXTURE.assistant.find(
    sample => sample.name === 'assistant: redacted_thinking block',
  )
  if (!text || !tool || !thinking || !redacted) {
    throw new Error('required P2 fixture samples are missing')
  }

  let state = createTranscriptState()
  for (const frame of [
    ready(SESSION_A),
    ready(SESSION_B),
    messageFrame(SESSION_A, text.message),
    messageFrame(SESSION_B, thinking.message),
    messageFrame(SESSION_A, tool.message),
    messageFrame(SESSION_B, redacted.message),
  ]) {
    state = projectServerFrame(state, frame)
  }

  expect(selectTranscriptRows(state, SESSION_A).map(row => row.kind)).toEqual([
    'assistant-text',
    'tool-use',
  ])
  expect(selectTranscriptRows(state, SESSION_B).map(row => row.kind)).toEqual([
    'thinking',
    'redacted-thinking',
  ])
  expect(
    selectTranscriptRows(state, SESSION_A).every(
      row => row.sessionId === SESSION_A,
    ),
  ).toBe(true)
  expect(
    selectTranscriptRows(state, SESSION_B).every(
      row => row.sessionId === SESSION_B,
    ),
  ).toBe(true)
})

test('one replay stream rebuilds every keyed store without changing active selection', () => {
  const text = SDK_MESSAGE_FIXTURE.assistant[0]
  const tool = SDK_MESSAGE_FIXTURE.assistant[1]
  if (!text || !tool) throw new Error('required P2 fixture samples are missing')

  const buffer = new FrameReplayBuffer()
  buffer.record(SESSION_A, ready(SESSION_A))
  buffer.record(SESSION_B, ready(SESSION_B))
  buffer.record(SESSION_B, messageFrame(SESSION_B, tool.message))
  buffer.record(SESSION_A, messageFrame(SESSION_A, text.message))

  let connection = createConnectionState()
  let permissions = createPermissionState()
  let raw = createRawMessageLogState()
  let transcript = createTranscriptState()
  const activeSessionId = SESSION_A

  for (const frame of buffer.snapshot()) {
    connection = reduceConnectionState(connection, frame)
    permissions = reducePermissionState(permissions, { type: 'frame', frame })
    raw = reduceServerFrame(raw, frame)
    transcript = projectServerFrame(transcript, frame)
  }

  expect(activeSessionId).toBe(SESSION_A)
  expect(selectConnection(connection, SESSION_A).status).toBe('ready')
  expect(selectConnection(connection, SESSION_B).status).toBe('ready')
  expect(selectPermissionQueue(permissions, SESSION_A)).toEqual([])
  expect(
    selectPermissionQueue(permissions, SESSION_B).map(
      item => item.request.requestId,
    ),
  ).toEqual(['permission-b'])
  expect(raw.sessions[SESSION_A]?.messages).toEqual([text.message])
  expect(raw.sessions[SESSION_B]?.messages).toEqual([tool.message])
  expect(selectTranscriptRows(transcript, SESSION_A)).toHaveLength(1)
  expect(selectTranscriptRows(transcript, SESSION_B)).toHaveLength(1)

  expect('activeSessionId' in connection).toBe(false)
  expect('activeSessionId' in permissions).toBe(false)
  expect('activeSessionId' in raw).toBe(false)
  expect('activeSessionId' in transcript).toBe(false)
})

test('a permission request for B while A is active queues under B only', () => {
  let state = createPermissionState()
  state = reducePermissionState(state, {
    type: 'frame',
    frame: ready(SESSION_A),
  })
  state = reducePermissionState(state, {
    type: 'frame',
    frame: ready(SESSION_B, []),
  })

  const activeSessionId = SESSION_A
  state = reducePermissionState(state, {
    type: 'frame',
    frame: {
      kind: 'event',
      protocolVersion: 1,
      sessionId: SESSION_B,
      event: { type: 'permission.requested', request: REQUEST_B },
    },
  })

  expect(selectPermissionQueue(state, activeSessionId)).toEqual([])
  expect(selectPermissionQueue(state, SESSION_B)[0]?.request).toEqual(REQUEST_B)
})
