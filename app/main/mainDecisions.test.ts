import { describe, expect, test } from 'bun:test'

import type { SessionDescriptor } from '../shared/hostApi.js'
import { PROTOCOL_VERSION, type ServerFrame } from '../shared/protocol.js'
import type { SupervisorEvent } from '../supervisor/supervisor.js'
import {
  MAX_FRAME_BYTES,
  MAX_OUTBOUND_FRAME_BYTES,
  MAX_SAVE_NAME_CHARS,
  MAX_SAVE_TEXT_BYTES,
  PARKED_EXIT_CODE,
} from '../shared/limits.js'
import { MAX_LIVE_SESSIONS } from '../shared/hostApi.js'
import {
  CWD_TOKEN_TTL_MS,
  SIDECAR_RUNTIME_ARGS,
  createCwdTokenStore,
  createStartupTimers,
  isTerminalLifecycleFrame,
  parseVisibleSessions,
  sanitizeSaveFileName,
  selectTranscriptBackfillCandidates,
  supervisorEventToServerFrame,
  validateSaveTextRequest,
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

  test('reports a terminal transport status as a lifecycle frame', () => {
    for (const status of ['disconnected', 'failed'] as const) {
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

  test('says nothing for the exited STATUS — the exit event already said it, with the code', () => {
    // The supervisor emits `exit` and then moves the record to `'exited'` inside
    // the same `child.on('exit')` handler, so this status can only ever restate a
    // death already reported — but without the `exit` payload. That code is the
    // only thing separating an intentional park from a crash (IDLE-PARK §2), and
    // this code-less copy always landed LAST into a last-write-wins reducer, so
    // it re-labelled every parked session a crash one frame after the exit frame
    // classified it correctly.
    expect(
      supervisorEventToServerFrame({
        type: 'status',
        sessionId: SID,
        status: 'exited',
      }),
    ).toBeNull()
  })

  test('the park exit code survives onto the frame the renderer classifies on', () => {
    expect(
      supervisorEventToServerFrame({
        type: 'exit',
        sessionId: SID,
        code: PARKED_EXIT_CODE,
        signal: null,
      }),
    ).toEqual({
      kind: 'lifecycle',
      protocolVersion: PROTOCOL_VERSION,
      sessionId: SID,
      status: 'exited',
      exit: { code: PARKED_EXIT_CODE, signal: null },
    })
  })

  test('says nothing for a status that is still on its way up', () => {
    for (const status of ['spawning', 'connecting', 'ready'] as const) {
      expect(
        supervisorEventToServerFrame({ type: 'status', sessionId: SID, status }),
      ).toBeNull()
    }
  })
})

describe('parseVisibleSessions — the IDLE-PARK visible-pane hint at the boundary', () => {
  test('keeps the reported ids', () => {
    expect([...parseVisibleSessions({ sessionIds: ['a', 'b'] })]).toEqual([
      'a',
      'b',
    ])
  })

  test('a malformed payload protects nothing instead of throwing', () => {
    // Degrading to "protect nothing" is the safe direction: this hint may only
    // ever SUPPRESS a park, so an empty set means the policy runs exactly as it
    // did before the hint existed.
    for (const payload of [null, undefined, 'x', 42, [], {}, { sessionIds: 'a' }]) {
      expect(parseVisibleSessions(payload).size).toBe(0)
    }
  })

  test('drops non-string, empty, and absurdly long entries but keeps the rest', () => {
    const ids = parseVisibleSessions({
      sessionIds: [1, null, '', 'x'.repeat(500), { evil: true }, 'good'],
    })
    expect([...ids]).toEqual(['good'])
  })

  test('cannot be used to retain an unbounded set', () => {
    const ids = parseVisibleSessions({
      sessionIds: Array.from({ length: MAX_LIVE_SESSIONS * 10 }, (_v, i) => `s${i}`),
    })
    expect(ids.size).toBe(MAX_LIVE_SESSIONS)
  })

  test('a duplicated id is one protection, not many', () => {
    expect(parseVisibleSessions({ sessionIds: ['a', 'a', 'a'] }).size).toBe(1)
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
    parked: false,
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

/* ------------------------------------------------------------------------- *
 * P4-35 — the file sink's HC1 validation.
 * ------------------------------------------------------------------------- */

describe('sanitizeSaveFileName', () => {
  test('a relative traversal reduces to its last segment, never a path', () => {
    // The attack this exists for: a compromised renderer suggesting a name that
    // main might join to a directory. There is no separator left to join with.
    for (const attempt of [
      '../../etc/passwd',
      '../../../../../../etc/passwd',
      'a/../../b/c.txt',
      './hidden/notes.txt',
    ]) {
      const name = sanitizeSaveFileName(attempt)
      expect(name).not.toBeNull()
      expect(name).not.toContain('/')
      expect(name).not.toContain('..')
    }
    expect(sanitizeSaveFileName('../../etc/passwd')).toBe('passwd')
    expect(sanitizeSaveFileName('a/../../b/c.txt')).toBe('c.txt')
  })

  test('an absolute path reduces to its basename (POSIX and Windows forms)', () => {
    expect(sanitizeSaveFileName('/etc/passwd')).toBe('passwd')
    expect(sanitizeSaveFileName('/Users/someone/.ssh/authorized_keys')).toBe(
      'authorized_keys',
    )
    // Backslash counts as a separator too, so a Windows-style path cannot smuggle
    // one through on a platform where node:path would not treat it as one.
    expect(sanitizeSaveFileName('C:\\Windows\\System32\\drivers\\etc\\hosts')).toBe(
      'hosts',
    )
    expect(sanitizeSaveFileName('..\\..\\secret.txt')).toBe('secret.txt')
  })

  test('a NUL byte and other control characters cannot survive', () => {
    // A NUL truncates the path in some syscalls, so `notes.txt\0.png` is a classic
    // extension-spoof. The whitelist removes it as an ordinary disallowed char.
    const nul = sanitizeSaveFileName('notes.txt\u0000.png')
    expect(nul).toBe('notes.txt-.png')
    expect(nul).not.toContain('\u0000')
    expect(sanitizeSaveFileName('a\nb\tc.txt')).toBe('a-b-c.txt')
    expect(sanitizeSaveFileName('x\u0000/../y.txt')).toBe('y.txt')
  })

  test('shell metacharacters and spaces become inert', () => {
    expect(sanitizeSaveFileName('$(whoami).txt')).toBe('--whoami-.txt')
    expect(sanitizeSaveFileName('my session; rm -rf ~.txt')).toBe(
      'my-session--rm--rf--.txt',
    )
  })

  test('a name with no usable stem is rejected outright', () => {
    // What the traversal reduction leaves behind when the input ends in a
    // separator, plus the hidden-file and empty cases.
    expect(sanitizeSaveFileName('')).toBeNull()
    expect(sanitizeSaveFileName('.')).toBeNull()
    expect(sanitizeSaveFileName('..')).toBeNull()
    expect(sanitizeSaveFileName('...')).toBeNull()
    expect(sanitizeSaveFileName('/some/dir/')).toBeNull()
    expect(sanitizeSaveFileName('..\\..\\')).toBeNull()
    expect(sanitizeSaveFileName('///')).toBeNull()
  })

  test('a non-string suggestion is rejected rather than coerced', () => {
    for (const bad of [undefined, null, 42, {}, [], { toString: () => 'x.txt' }]) {
      expect(sanitizeSaveFileName(bad)).toBeNull()
    }
  })

  test('an ordinary suggestion passes through unchanged, and is length-capped', () => {
    expect(sanitizeSaveFileName('refactor-auth.txt')).toBe('refactor-auth.txt')
    expect(sanitizeSaveFileName('10-sessions.txt')).toBe('10-sessions.txt')
    const long = sanitizeSaveFileName(`${'a'.repeat(500)}.txt`)
    expect(long).not.toBeNull()
    expect(long?.length).toBe(MAX_SAVE_NAME_CHARS)
  })
})

describe('validateSaveTextRequest', () => {
  test('accepts a well-formed request and returns the sanitized name', () => {
    const result = validateSaveTextRequest({
      text: 'User: hello\n',
      suggestedName: 'refactor-auth.txt',
    })
    expect(result).toEqual({
      ok: true,
      text: 'User: hello\n',
      fileName: 'refactor-auth.txt',
    })
  })

  test('sanitizes a traversal attempt instead of failing the whole save', () => {
    const result = validateSaveTextRequest({
      text: 'body',
      suggestedName: '../../etc/passwd',
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.fileName).toBe('passwd')
  })

  test('rejects a name that sanitizes to nothing', () => {
    const result = validateSaveTextRequest({ text: 'body', suggestedName: '..' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('invalid_name')
  })

  test('rejects absent, non-string and empty text', () => {
    for (const payload of [
      undefined,
      null,
      'a string, not an object',
      {},
      { suggestedName: 'x.txt' },
      { text: 42, suggestedName: 'x.txt' },
      { text: '', suggestedName: 'x.txt' },
    ]) {
      const result = validateSaveTextRequest(payload)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.code).toBe('invalid_text')
    }
  })

  test('rejects text past the cap, measured in BYTES not chars', () => {
    const underByChars = '\u00e9'.repeat(MAX_SAVE_TEXT_BYTES - 1)
    // Two bytes per char, so this is comfortably over the byte cap while being
    // under it by `length` — the same bytes-not-chars rule MAX_PROMPT_BYTES has.
    const over = validateSaveTextRequest({
      text: underByChars,
      suggestedName: 'x.txt',
    })
    expect(underByChars.length).toBeLessThan(MAX_SAVE_TEXT_BYTES)
    expect(over.ok).toBe(false)
    if (!over.ok) expect(over.code).toBe('invalid_text')

    const exactly = validateSaveTextRequest({
      text: 'a'.repeat(MAX_SAVE_TEXT_BYTES),
      suggestedName: 'x.txt',
    })
    expect(exactly.ok).toBe(true)
    const justOver = validateSaveTextRequest({
      text: 'a'.repeat(MAX_SAVE_TEXT_BYTES + 1),
      suggestedName: 'x.txt',
    })
    expect(justOver.ok).toBe(false)
  })

  test('the message a rejection carries is user-facing, not a constant name', () => {
    const tooBig = validateSaveTextRequest({
      text: 'a'.repeat(MAX_SAVE_TEXT_BYTES + 1),
      suggestedName: 'x.txt',
    })
    expect(tooBig.ok).toBe(false)
    if (!tooBig.ok) {
      expect(tooBig.message).not.toContain('MAX_')
      expect(tooBig.message).not.toContain('—')
      expect(tooBig.message).toContain('Save fewer sessions')
    }
  })

  test('the save cap sits strictly between the two directional frame caps', () => {
    // The invariant the doc comment in limits.ts claims: this is a THIRD bound,
    // not either existing one moved. A future edit that unified them would trip
    // here rather than silently changing what every other channel may send.
    expect(MAX_SAVE_TEXT_BYTES).toBeGreaterThan(MAX_FRAME_BYTES)
    expect(MAX_SAVE_TEXT_BYTES).toBeLessThan(MAX_OUTBOUND_FRAME_BYTES)
    expect(MAX_FRAME_BYTES).toBe(128 * 1024)
    expect(MAX_OUTBOUND_FRAME_BYTES).toBe(32 * 1024 * 1024)
  })
})

describe('createStartupTimers', () => {
  /** A hand-driven clock: `fire()` runs what is due, exactly like the real timer. */
  function fakeTimers() {
    const armed = new Map<number, () => void>()
    let seq = 0
    return {
      deps: {
        delayMs: 250,
        setTimer: (run: () => void) => {
          const handle = ++seq
          armed.set(handle, run)
          return handle
        },
        clearTimer: (handle: number) => {
          armed.delete(handle)
        },
      },
      // One-shot, like the real timer: a fired callback is spent.
      fire: () => {
        for (const [handle, run] of [...armed.entries()]) {
          armed.delete(handle)
          run()
        }
      },
      armedCount: () => armed.size,
    }
  }

  test('runs every scheduled callback when the delay elapses', () => {
    const timers = fakeTimers()
    const startup = createStartupTimers(timers.deps)
    const ran: string[] = []

    startup.schedule(() => ran.push('backfill'))
    startup.schedule(() => ran.push('catalog'))
    expect(startup.pending()).toBe(2)

    timers.fire()
    expect(ran).toEqual(['backfill', 'catalog'])
    expect(startup.pending()).toBe(0)
  })

  /**
   * The teardown race: a window closed inside the post-paint delay must not let
   * the drivers arm afterwards. Two of them re-schedule themselves forever, so a
   * single leaked arm outlives the window that owned it.
   */
  test('cancelAll drops arms that have not fired yet', () => {
    const timers = fakeTimers()
    const startup = createStartupTimers(timers.deps)
    const ran: string[] = []

    startup.schedule(() => ran.push('catalog'))
    startup.schedule(() => ran.push('accounts'))
    startup.cancelAll()

    timers.fire()
    expect(ran).toEqual([])
    expect(startup.pending()).toBe(0)
    expect(timers.armedCount()).toBe(0)
  })

  test('cancelAll is idempotent and leaves the set reusable after reactivate', () => {
    const timers = fakeTimers()
    const startup = createStartupTimers(timers.deps)
    startup.schedule(() => {})
    startup.cancelAll()
    startup.cancelAll()

    const ran: string[] = []
    startup.schedule(() => ran.push('rearmed'))
    timers.fire()
    expect(ran).toEqual(['rearmed'])
  })

  test('a fired callback leaves no handle behind for a later cancel', () => {
    const timers = fakeTimers()
    const startup = createStartupTimers(timers.deps)
    let runs = 0
    startup.schedule(() => {
      runs += 1
    })

    timers.fire()
    expect(startup.pending()).toBe(0)

    startup.cancelAll()
    timers.fire()
    expect(runs).toBe(1)
  })
})
