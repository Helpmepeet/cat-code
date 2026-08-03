import { describe, expect, test } from 'bun:test'

import type { SessionDescriptor } from '../shared/hostApi.js'
import { PROTOCOL_VERSION, type ServerFrame } from '../shared/protocol.js'
import type { SupervisorEvent } from '../supervisor/supervisor.js'
import {
  CWD_TOKEN_TTL_MS,
  SIDECAR_RUNTIME_ARGS,
  createCwdTokenStore,
  isTerminalLifecycleFrame,
  selectTranscriptBackfillCandidates,
  supervisorEventToServerFrame,
} from './mainDecisions.js'

const SID = 'app-session-1'

test('the production sidecar runtime enables the classifier feature', () => {
  expect(SIDECAR_RUNTIME_ARGS).toEqual([
    '--feature=TRANSCRIPT_CLASSIFIER',
    'run',
  ])
})

function pongFrame(sessionId = SID): ServerFrame {
  return {
    kind: 'pong',
    protocolVersion: PROTOCOL_VERSION,
    sessionId,
    nonce: 'n1',
  }
}

function errorFrame(): ServerFrame {
  return {
    kind: 'error',
    protocolVersion: PROTOCOL_VERSION,
    sessionId: SID,
    code: 'bad_request',
    message: 'nope',
    retryable: false,
  }
}

function lifecycle(status: 'disconnected' | 'failed' | 'exited'): ServerFrame {
  return {
    kind: 'lifecycle',
    protocolVersion: PROTOCOL_VERSION,
    sessionId: SID,
    status,
  }
}

describe('supervisorEventToServerFrame', () => {
  test('passes a sidecar frame through untouched', () => {
    const frame = pongFrame()
    expect(
      supervisorEventToServerFrame({ type: 'frame', sessionId: SID, frame }),
    ).toBe(frame)
  })

  test('turns a process exit into an exited lifecycle frame carrying code + signal', () => {
    expect(
      supervisorEventToServerFrame({
        type: 'exit',
        sessionId: SID,
        code: 137,
        signal: 'SIGKILL',
      }),
    ).toEqual({
      kind: 'lifecycle',
      protocolVersion: PROTOCOL_VERSION,
      sessionId: SID,
      status: 'exited',
      exit: { code: 137, signal: 'SIGKILL' },
    })
  })

  test('reports every terminal transport status as a lifecycle frame', () => {
    for (const status of ['disconnected', 'failed', 'exited'] as const) {
      expect(
        supervisorEventToServerFrame({ type: 'status', sessionId: SID, status }),
      ).toEqual({
        kind: 'lifecycle',
        protocolVersion: PROTOCOL_VERSION,
        sessionId: SID,
        status,
      })
    }
  })

  test('says nothing for a status that is still on its way up', () => {
    for (const status of ['spawning', 'connecting', 'ready'] as const) {
      expect(
        supervisorEventToServerFrame({ type: 'status', sessionId: SID, status }),
      ).toBeNull()
    }
  })
})

describe('isTerminalLifecycleFrame', () => {
  test('every lifecycle status ends a session, and no other frame kind does', () => {
    expect(isTerminalLifecycleFrame(lifecycle('disconnected'))).toBe(true)
    expect(isTerminalLifecycleFrame(lifecycle('failed'))).toBe(true)
    expect(isTerminalLifecycleFrame(lifecycle('exited'))).toBe(true)
    // A frame that merely reports an error keeps the session alive: treating it
    // as terminal would evict the replay buffer under a live conversation.
    expect(isTerminalLifecycleFrame(errorFrame())).toBe(false)
    expect(isTerminalLifecycleFrame(pongFrame())).toBe(false)
  })
})

describe('createCwdTokenStore (HC1)', () => {
  test('mints a token that resolves to the minted path exactly once', () => {
    const store = createCwdTokenStore()
    const token = store.mint('/repo/one')

    expect(token).not.toBe('/repo/one')
    expect(store.consume(token)).toBe('/repo/one')
    // Single use: a replayed token buys nothing.
    expect(store.consume(token)).toBeUndefined()
  })

  test('refuses a token it never minted', () => {
    const store = createCwdTokenStore()
    store.mint('/repo/one')
    expect(store.consume('not-a-token')).toBeUndefined()
  })

  test('keeps concurrent tokens independent', () => {
    const store = createCwdTokenStore()
    const first = store.mint('/repo/one')
    const second = store.mint('/repo/two')

    expect(first).not.toBe(second)
    expect(store.consume(second)).toBe('/repo/two')
    expect(store.consume(first)).toBe('/repo/one')
  })

  test('refuses an expired token, and spends it so a later clock cannot revive it', () => {
    let clock = 1_000
    const store = createCwdTokenStore({ now: () => clock })
    const token = store.mint('/repo/one')

    clock += CWD_TOKEN_TTL_MS + 1
    expect(store.consume(token)).toBeUndefined()
    clock = 1_000
    expect(store.consume(token)).toBeUndefined()
  })

  test('still resolves a token used at the last moment of its life', () => {
    let clock = 1_000
    const store = createCwdTokenStore({ now: () => clock })
    const token = store.mint('/repo/one')

    clock += CWD_TOKEN_TTL_MS
    expect(store.consume(token)).toBe('/repo/one')
  })

  test('default tokens are unguessable and unique across mints', () => {
    const store = createCwdTokenStore()
    const tokens = new Set(
      Array.from({ length: 200 }, () => store.mint('/repo/one')),
    )
    expect(tokens.size).toBe(200)
    for (const token of tokens) expect(token.length).toBeGreaterThanOrEqual(32)
  })
})

function row(overrides: Partial<SessionDescriptor> = {}): SessionDescriptor {
  return {
    appSessionId: 'a',
    engineSessionId: 'e-a',
    cwd: '/repo',
    title: null,
    titleUpdatedAt: null,
    status: 'exited',
    restorable: true,
    createdAt: 0,
    lastAttachedAt: 0,
    lastMessageSentAt: null,
    ...overrides,
  }
}

function select(
  sessions: SessionDescriptor[],
  overrides: {
    hasCache?: (id: string) => boolean
    cacheHasCurrentRunFacts?: (id: string) => boolean
    isTranscriptNewerThanCache?: (session: SessionDescriptor) => boolean
    limit?: number
  } = {},
) {
  return selectTranscriptBackfillCandidates({
    sessions,
    hasCache: overrides.hasCache ?? (() => false),
    cacheHasCurrentRunFacts: overrides.cacheHasCurrentRunFacts ?? (() => false),
    isTranscriptNewerThanCache: overrides.isTranscriptNewerThanCache ?? (() => false),
    transcriptPath: (session, engineSessionId) =>
      `${session.cwd}/${engineSessionId}.jsonl`,
    limit: overrides.limit ?? 32,
  })
}

describe('selectTranscriptBackfillCandidates (PL-B)', () => {
  test('takes an uncached restorable row and resolves its transcript path', () => {
    expect(select([row({ appSessionId: 'a', engineSessionId: 'e-a' })])).toEqual([
      {
        appSessionId: 'a',
        engineSessionId: 'e-a',
        transcriptPath: '/repo/e-a.jsonl',
      },
    ])
  })

  test('skips a row with no engine transcript and a non-restorable row', () => {
    expect(
      select([
        row({ appSessionId: 'a', engineSessionId: null }),
        row({ appSessionId: 'b', restorable: false }),
      ]),
    ).toEqual([])
  })

  test('skips a cached row that already carries current run facts', () => {
    expect(
      select([row({ appSessionId: 'a' })], {
        hasCache: () => true,
        cacheHasCurrentRunFacts: () => true,
      }),
    ).toEqual([])
  })

  test('re-reads a cached row whose cache predates the current run-facts derivation', () => {
    expect(
      select([row({ appSessionId: 'a' })], {
        hasCache: () => true,
        cacheHasCurrentRunFacts: () => false,
      }),
    ).toHaveLength(1)
  })

  test('re-reads a complete cache once the engine transcript has moved on', () => {
    expect(
      select([row({ appSessionId: 'a' })], {
        hasCache: () => true,
        cacheHasCurrentRunFacts: () => true,
        isTranscriptNewerThanCache: () => true,
      }),
    ).toHaveLength(1)
  })

  test('reads the most recently attached rows first and stops at the limit', () => {
    const sessions = [
      row({ appSessionId: 'old', engineSessionId: 'e-old', lastAttachedAt: 1 }),
      row({ appSessionId: 'new', engineSessionId: 'e-new', lastAttachedAt: 3 }),
      row({ appSessionId: 'mid', engineSessionId: 'e-mid', lastAttachedAt: 2 }),
    ]
    expect(select(sessions, { limit: 2 }).map(item => item.appSessionId)).toEqual([
      'new',
      'mid',
    ])
    // The caller's list is read, never reordered in place.
    expect(sessions.map(session => session.appSessionId)).toEqual([
      'old',
      'new',
      'mid',
    ])
  })

  test('asks the cache questions only for rows that could still qualify', () => {
    const asked: string[] = []
    select(
      [
        row({ appSessionId: 'a', restorable: false }),
        row({ appSessionId: 'b', engineSessionId: null }),
        row({ appSessionId: 'c' }),
      ],
      { hasCache: id => (asked.push(id), false) },
    )
    expect(asked).toEqual(['c'])
  })
})
