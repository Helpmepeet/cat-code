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
  MAX_OPERATIONAL_FIELDS,
  MAX_OPERATIONAL_STRING_BYTES,
  createOperationalRecord,
  parseOperationalRecord,
} from '../shared/operationalLog.js'
import {
  CWD_TOKEN_TTL_MS,
  RENDERER_HEALTH_RING_CAPACITY,
  RENDERER_RECOVERY_MAX_ATTEMPTS,
  RENDERER_RECOVERY_WINDOW_MS,
  PACKAGED_SIDECAR_BINARY,
  SIDECAR_MODE_ENTRIES,
  SIDECAR_RUNTIME_ARGS,
  createCwdTokenStore,
  createRendererHealthFlightRecorder,
  createRendererHealthMonitor,
  createRendererRecoveryPolicy,
  createStartupTimers,
  createWindowVisibilityTracker,
  type DetachedCliHandle,
  frameMutatedAccountsPool,
  isTerminalLifecycleFrame,
  parseVisibleSessions,
  runDetachedCliFallbackSpawn,
  selectRendererWorkingSetKiB,
  sanitizeSaveFileName,
  selectTranscriptBackfillCandidates,
  supervisorEventToServerFrame,
  resolveSidecarLaunch,
  validateSaveTextRequest,
} from './mainDecisions.js'

const SID = 'app-session-1'

test('the production sidecar runtime enables the desktop engine features', () => {
  expect(SIDECAR_RUNTIME_ARGS).toEqual([
    '--feature=TRANSCRIPT_CLASSIFIER',
    '--feature=REACTIVE_COMPACT',
    'run',
  ])
})

describe('sidecar launch resolution (P5-1)', () => {
  const DEV = { packaged: false, mainDir: '/repo/app/main' } as const
  const PACKAGED = {
    packaged: true,
    mainDir: '/Apps/Cat Code.app/Contents/Resources/app/main',
    resourcesPath: '/Apps/Cat Code.app/Contents/Resources',
  } as const

  test('development spawns repository TypeScript under bun, unchanged from before packaging existed', () => {
    const plan = resolveSidecarLaunch(DEV)
    expect(plan.command).toBe('bun')
    expect(plan.argsFor('session')).toEqual([
      '--feature=TRANSCRIPT_CLASSIFIER',
      '--feature=REACTIVE_COMPACT',
      'run',
      '/repo/app/sidecar/index.ts',
    ])
  })

  test('CATCODE_BUN_BIN still overrides the development interpreter', () => {
    expect(resolveSidecarLaunch({ ...DEV, bunBin: '/opt/bun' }).command).toBe('/opt/bun')
  })

  test('the disposable workers keep their own argument shape: no feature flags, own CLI args last', () => {
    const plan = resolveSidecarLaunch(DEV)
    expect(plan.argsFor('catalog', ['--bare'])).toEqual([
      'run',
      '/repo/app/sidecar/sessionsCatalogWorker.ts',
      '--bare',
    ])
    expect(plan.argsFor('accounts-pool', ['--bare', '--usage-stats'])).toEqual([
      'run',
      '/repo/app/sidecar/accountsPoolWorker.ts',
      '--bare',
      '--usage-stats',
    ])
  })

  test('debug cleanup keeps the feature flags the session sidecar has', () => {
    expect(resolveSidecarLaunch(DEV).argsFor('debug-cleanup')).toEqual([
      '--feature=TRANSCRIPT_CLASSIFIER',
      '--feature=REACTIVE_COMPACT',
      'run',
      '/repo/app/sidecar/debugCleanupWorker.ts',
    ])
  })

  test('packaged spawns the compiled binary inside the bundle and never names bun or a .ts file', () => {
    const plan = resolveSidecarLaunch(PACKAGED)
    expect(plan.command).toBe(`/Apps/Cat Code.app/Contents/Resources/sidecar/${PACKAGED_SIDECAR_BINARY}`)
    for (const mode of Object.keys(SIDECAR_MODE_ENTRIES) as Array<keyof typeof SIDECAR_MODE_ENTRIES>) {
      const args = plan.argsFor(mode, ['--bare'])
      expect(args).toEqual([mode, '--bare'])
      expect(args.some(arg => arg.endsWith('.ts'))).toBe(false)
    }
    expect(plan.command).not.toContain('bun')
  })

  test('no mode token prefixes another, so the packaged marker cannot match a worker', () => {
    const modes = Object.keys(SIDECAR_MODE_ENTRIES)
    for (const mode of modes) {
      for (const other of modes) {
        if (mode === other) continue
        expect(other.startsWith(mode)).toBe(false)
      }
    }
  })

  test('packaged resolution falls back to the bundle layout when resourcesPath is absent', () => {
    expect(resolveSidecarLaunch({ packaged: true, mainDir: PACKAGED.mainDir }).command).toBe(
      resolveSidecarLaunch(PACKAGED).command,
    )
  })

  test('the orphan-identity marker selects session sidecars alone in both topologies', () => {
    // Development: the session entry path, which no worker command line contains.
    const dev = resolveSidecarLaunch(DEV)
    expect(dev.identityMarker).toBe('/repo/app/sidecar/index.ts')
    for (const mode of ['catalog', 'accounts-pool', 'transcript-backfill'] as const) {
      expect(dev.argsFor(mode).join(' ')).not.toContain(dev.identityMarker)
    }

    // Packaged: every mode shares one executable, so the marker carries the mode
    // token. Without that a pid recycled onto a live worker would be swept.
    const packaged = resolveSidecarLaunch(PACKAGED)
    const commandLine = (mode: Parameters<typeof packaged.argsFor>[0]): string =>
      `${packaged.command} ${packaged.argsFor(mode).join(' ')}`
    expect(commandLine('session')).toContain(packaged.identityMarker)
    for (const mode of ['catalog', 'accounts-pool', 'transcript-backfill'] as const) {
      expect(commandLine(mode)).not.toContain(packaged.identityMarker)
    }
  })
})

describe('renderer health evidence', () => {
  test('escalates sustained loss to repeated error records with current duration', () => {
    let clock = 0
    const health = createRendererHealthMonitor({ now: () => clock })
    health.reset()

    const events = []
    for (clock = 5_000; clock <= 95_000; clock += 5_000) {
      const event = health.probe()
      if (event) events.push(event)
    }

    expect(events).toEqual([
      {
        event: 'renderer.health.missed',
        level: 'warn',
        fields: { missed: 3, elapsedMs: 20_000 },
      },
      {
        event: 'renderer.health.unavailable',
        level: 'error',
        fields: { missed: 6, elapsedMs: 35_000 },
      },
      {
        event: 'renderer.health.unavailable',
        level: 'error',
        fields: { missed: 18, elapsedMs: 95_000 },
      },
    ])
  })

  test('recovery closes a transient episode and resets escalation state', () => {
    let clock = 0
    const health = createRendererHealthMonitor({ now: () => clock })
    health.reset()
    for (clock = 5_000; clock <= 20_000; clock += 5_000) health.probe()

    clock = 25_000
    expect(health.response()).toEqual({
      recovered: true,
      priorMisses: 3,
      outageDurationMs: 5_000,
      shouldSample: true,
    })
    clock = 30_000
    expect(health.probe()).toBeNull()
  })
})

describe('renderer health flight recorder', () => {
  /** The live pairing in main: every response is recorded, few are sampled. */
  function runProbeBurst(
    recorder: ReturnType<typeof createRendererHealthFlightRecorder>,
    monitor: ReturnType<typeof createRendererHealthMonitor>,
    setClock: (value: number) => void,
  ): Array<{ at: number; eventLoopLagMs: number }> {
    const sampled: Array<{ at: number; eventLoopLagMs: number }> = []
    for (let index = 1; index <= 12; index++) {
      setClock(index * 5_000)
      const eventLoopLagMs = index === 12 ? 900 : 4
      recorder.record({
        eventLoopLagMs,
        visible: index !== 6,
        jsHeapUsedBytes: index === 6 ? null : (200 + index) * 1_048_576,
        rendererWorkingSetKiB: index === 6 ? null : (100 + index) * 1_024,
        rendersCommitted: 100 + index,
      })
      if (monitor.response().shouldSample) sampled.push({ at: index * 5_000, eventLoopLagMs })
    }
    return sampled
  }

  test('a crash surfaces the readings the 30s sample dedup dropped', () => {
    let clock = 0
    const monitor = createRendererHealthMonitor({ now: () => clock })
    const recorder = createRendererHealthFlightRecorder({ now: () => clock })

    const sampled = runProbeBurst(recorder, monitor, value => { clock = value })
    clock = 62_000
    const ring = recorder.flush()

    // Two of twelve readings reached the log, and the terminal spike was not
    // one of them: that gap is the whole defect.
    expect(sampled).toEqual([
      { at: 5_000, eventLoopLagMs: 4 },
      { at: 35_000, eventLoopLagMs: 4 },
    ])
    expect(ring?.count).toBe(12)
    const entries = ring?.samples.split(';') ?? []
    expect(entries).toHaveLength(12)
    expect(entries[0]).toBe('57000:4:201:103424:101:v')
    // Hidden window, V8 heap and process memory unavailable.
    expect(entries[5]).toBe('32000:4:-:-:106:h')
    // The reading 2s before the crash, carrying the lag spike no record held.
    expect(entries[11]).toBe('2000:900:212:114688:112:v')
  })

  test('the ring fits one record without the sanitizer rewriting it', () => {
    let clock = 0
    const monitor = createRendererHealthMonitor({ now: () => clock })
    const recorder = createRendererHealthFlightRecorder({ now: () => clock })
    runProbeBurst(recorder, monitor, value => { clock = value })
    clock = 62_000
    const ring = recorder.flush()
    if (!ring) throw new Error('expected a flushed ring')

    const record = createOperationalRecord(
      {
        level: 'error',
        event: 'renderer.health.flight_recorder',
        process: 'main',
        fields: { reason: 'process_gone', count: ring.count, samples: ring.samples },
      },
      { launchId: 'launch-1', processInstanceId: 'instance-1' },
    )

    expect(Object.keys(record.fields).length).toBeLessThanOrEqual(MAX_OPERATIONAL_FIELDS)
    expect(new TextEncoder().encode(ring.samples).byteLength)
      .toBeLessThanOrEqual(MAX_OPERATIONAL_STRING_BYTES)
    // No path, URL, or control shape survives redaction, so what was measured
    // is what is stored.
    expect(record.fields.samples).toBe(ring.samples)
  })

  test('drops whole readings rather than letting truncation corrupt one', () => {
    let clock = 0
    const recorder = createRendererHealthFlightRecorder({ now: () => clock, maxBytes: 50 })
    for (let index = 1; index <= 5; index++) {
      clock = index * 1_000
      recorder.record({
        eventLoopLagMs: 1,
        visible: true,
        jsHeapUsedBytes: 100 * 1_048_576,
        rendererWorkingSetKiB: 100 * 1_024,
        rendersCommitted: 10,
      })
    }
    clock = 6_000
    const ring = recorder.flush()

    expect(ring?.count).toBe(2)
    expect(new TextEncoder().encode(ring?.samples ?? '').byteLength).toBeLessThanOrEqual(50)
    for (const entry of ring?.samples.split(';') ?? []) {
      expect(entry).toMatch(/^\d+:\d+:(\d+|-):(\d+|-):\d+:[vh]$/)
    }
    // The readings nearest the failure are the ones kept.
    expect(ring?.samples.endsWith('1000:1:100:102400:10:v')).toBe(true)
    expect(ring?.samples).not.toContain('5000:')
  })

  test('bounds the ring and empties it once flushed', () => {
    let clock = 0
    const recorder = createRendererHealthFlightRecorder({ now: () => clock })
    for (let index = 1; index <= RENDERER_HEALTH_RING_CAPACITY + 3; index++) {
      clock = index * 5_000
      recorder.record({
        eventLoopLagMs: index,
        visible: true,
        jsHeapUsedBytes: null,
        rendererWorkingSetKiB: null,
        rendersCommitted: index,
      })
    }
    expect(recorder.flush()?.count).toBe(RENDERER_HEALTH_RING_CAPACITY)
    // A second trigger for the same failure must not re-emit spent evidence.
    expect(recorder.flush()).toBeNull()

    clock += 5_000
    recorder.record({
      eventLoopLagMs: 7,
      visible: false,
      jsHeapUsedBytes: null,
      rendererWorkingSetKiB: null,
      rendersCommitted: 7,
    })
    expect(recorder.flush()).toEqual({ count: 1, samples: '0:7:-:-:7:h' })
  })

  test('F5: reset drops readings from a closed BrowserWindow generation', () => {
    // The recorder is module-global in main, but a BrowserWindow is not: a
    // closed window's readings must not survive into the next one's flush,
    // or a fresh renderer that fails before its first health response gets
    // blamed for evidence it never produced.
    let clock = 0
    const recorder = createRendererHealthFlightRecorder({ now: () => clock })
    recorder.record({
      eventLoopLagMs: 4,
      visible: true,
      jsHeapUsedBytes: 200 * 1_048_576,
      rendererWorkingSetKiB: 100 * 1_024,
      rendersCommitted: 1,
    })
    clock = 5_000
    recorder.record({
      eventLoopLagMs: 5,
      visible: true,
      jsHeapUsedBytes: 201 * 1_048_576,
      rendererWorkingSetKiB: 101 * 1_024,
      rendersCommitted: 2,
    })

    recorder.reset()

    clock = 10_000
    expect(recorder.flush()).toBeNull()
  })
})

test('selectRendererWorkingSetKiB returns only the responding renderer process measurement', () => {
  expect(
    selectRendererWorkingSetKiB(
      [
        { pid: 101, memory: { workingSetSize: 200 } },
        { pid: 202, memory: { workingSetSize: 400 } },
      ],
      202,
    ),
  ).toBe(400)
  expect(selectRendererWorkingSetKiB([], 202)).toBeNull()
  expect(
    selectRendererWorkingSetKiB(
      [{ pid: 202, memory: { workingSetSize: -1 } }],
      202,
    ),
  ).toBeNull()
})

describe('window visibility transitions', () => {
  test('brackets a hidden episode with exactly two records', () => {
    const tracker = createWindowVisibilityTracker()

    // The launch show is a transition, so an incident reader has a baseline
    // rather than a log that first mentions the window when it disappears.
    expect(tracker.observe('show')).toEqual({ visible: true, reason: 'show' })
    // macOS fires both for one Cmd-H; the overlap must not double the record.
    expect(tracker.observe('hide')).toEqual({ visible: false, reason: 'hide' })
    expect(tracker.observe('minimize')).toBeNull()
    expect(tracker.observe('restore')).toEqual({ visible: true, reason: 'restore' })
    expect(tracker.observe('show')).toBeNull()
  })

  test('a repeated signal in the same direction is not a transition', () => {
    const tracker = createWindowVisibilityTracker()
    tracker.observe('show')
    expect(tracker.observe('minimize')).toEqual({ visible: false, reason: 'minimize' })
    expect(tracker.observe('minimize')).toBeNull()
    expect(tracker.observe('hide')).toBeNull()
    expect(tracker.observe('show')).toEqual({ visible: true, reason: 'show' })
  })

  test('a transition is a writable, exportable record', () => {
    const tracker = createWindowVisibilityTracker()
    const transition = tracker.observe('hide')
    if (!transition) throw new Error('expected a transition')

    const record = createOperationalRecord(
      {
        level: 'info',
        event: 'window.visibility.changed',
        process: 'main',
        fields: { visible: transition.visible, reason: transition.reason },
      },
      { launchId: 'launch-1', processInstanceId: 'instance-1' },
    )

    expect(record.fields).toEqual({ visible: false, reason: 'hide' })
    // The bundle admits records through the same closed schema, so this is also
    // the export check.
    expect(parseOperationalRecord(record)).not.toBeNull()
  })
})

describe('renderer process identity', () => {
  test('the pid a crash report names travels on the window and death records', () => {
    const created = createOperationalRecord(
      { level: 'info', event: 'window.created', process: 'main', fields: { pid: 4242 } },
      { launchId: 'launch-1', processInstanceId: 'instance-1', pid: 11 },
    )
    const gone = createOperationalRecord(
      {
        level: 'error',
        event: 'renderer.process.gone',
        process: 'main',
        fields: { reason: 'oom', exitCode: 5, pid: 4242 },
      },
      { launchId: 'launch-1', processInstanceId: 'instance-1', pid: 11 },
    )
    const recovered = createOperationalRecord(
      { level: 'info', event: 'renderer.recovery.succeeded', process: 'main', fields: { pid: 4343 } },
      { launchId: 'launch-1', processInstanceId: 'instance-1', pid: 11 },
    )

    // The record's own `pid` is main's; the renderer's is the field. Conflating
    // them is what made the 2026-08-09 crash report unmatchable.
    expect(created.pid).toBe(11)
    expect(created.fields.pid).toBe(4242)
    expect(gone.fields).toEqual({ reason: 'oom', exitCode: 5, pid: 4242 })
    expect(recovered.fields.pid).toBe(4343)
    for (const record of [created, gone, recovered]) {
      expect(parseOperationalRecord(record)).not.toBeNull()
    }
  })
})

describe('renderer recovery policy', () => {
  test('reloads an abnormal death and numbers the attempts', () => {
    let clock = 0
    const recovery = createRendererRecoveryPolicy({ now: () => clock })
    expect(recovery.decide('crashed')).toEqual({ action: 'reload', attempt: 1 })
    clock = 60_000
    expect(recovery.decide('oom')).toEqual({ action: 'reload', attempt: 2 })
  })

  test('never reloads a clean exit, and a clean exit costs no attempt', () => {
    const recovery = createRendererRecoveryPolicy({ now: () => 0 })
    expect(recovery.decide('clean-exit')).toEqual({ action: 'ignore' })
    expect(recovery.decide('crashed')).toEqual({ action: 'reload', attempt: 1 })
  })

  test('gives up after the attempt cap inside the sliding window', () => {
    let clock = 0
    const recovery = createRendererRecoveryPolicy({ now: () => clock })
    for (let attempt = 1; attempt <= RENDERER_RECOVERY_MAX_ATTEMPTS; attempt++) {
      clock += 1_000
      expect(recovery.decide('crashed')).toEqual({ action: 'reload', attempt })
    }
    clock += 1_000
    expect(recovery.decide('crashed')).toEqual({ action: 'give-up' })
  })

  test('attempts expire once they age out of the window', () => {
    let clock = 0
    const recovery = createRendererRecoveryPolicy({ now: () => clock })
    for (let attempt = 1; attempt <= RENDERER_RECOVERY_MAX_ATTEMPTS; attempt++) {
      recovery.decide('crashed')
    }
    expect(recovery.decide('crashed')).toEqual({ action: 'give-up' })
    clock = RENDERER_RECOVERY_WINDOW_MS
    expect(recovery.decide('crashed')).toEqual({ action: 'reload', attempt: 1 })
  })

  test('ages out only the attempts older than the window', () => {
    let clock = 0
    const recovery = createRendererRecoveryPolicy({ now: () => clock })
    recovery.decide('crashed')
    clock = 1_000
    recovery.decide('crashed')
    clock = 2_000
    recovery.decide('crashed')
    clock = RENDERER_RECOVERY_WINDOW_MS
    expect(recovery.decide('crashed')).toEqual({ action: 'reload', attempt: 3 })
    clock = RENDERER_RECOVERY_WINDOW_MS + 500
    expect(recovery.decide('crashed')).toEqual({ action: 'give-up' })
  })

  test('holds an attempt for the whole window, to its last millisecond', () => {
    let clock = 0
    const recovery = createRendererRecoveryPolicy({ now: () => clock })
    for (let attempt = 1; attempt <= RENDERER_RECOVERY_MAX_ATTEMPTS; attempt++) {
      recovery.decide('crashed')
    }
    clock = RENDERER_RECOVERY_WINDOW_MS - 1
    expect(recovery.decide('crashed')).toEqual({ action: 'give-up' })
  })
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

describe('frameMutatedAccountsPool', () => {
  const oauth = (state: string): ServerFrame =>
    ({
      kind: 'oauth.login.progress',
      protocolVersion: PROTOCOL_VERSION,
      sessionId: 's1',
      progress: { state },
    }) as unknown as ServerFrame

  const accountResult = (
    verb: string,
    ok: boolean,
  ): ServerFrame =>
    ({
      kind: 'account.result',
      protocolVersion: PROTOCOL_VERSION,
      sessionId: 's1',
      requestId: 'r1',
      verb,
      ok,
      message: 'done',
    }) as unknown as ServerFrame

  test('a completed sign-in mutates the pool; its earlier phases do not', () => {
    expect(frameMutatedAccountsPool(oauth('success'))).toBe(true)
    for (const state of [
      'starting',
      'waiting_for_login',
      'waiting_for_alias',
      'error',
    ]) {
      expect(frameMutatedAccountsPool(oauth(state))).toBe(false)
    }
  })

  test('an account verb that landed mutates the pool; a refused one does not', () => {
    // These are the surfaces the operator asked about: without a re-read, a
    // deleted account keeps rendering and a renamed one keeps its old name until
    // the next interval, because the page reads main's pool, not the session's.
    for (const verb of [
      'account.delete',
      'account.rename',
      'account.logout',
      'account.switch',
      'account.touchAll',
    ]) {
      expect(frameMutatedAccountsPool(accountResult(verb, true))).toBe(true)
      expect(frameMutatedAccountsPool(accountResult(verb, false))).toBe(false)
    }
  })

  test('every verb the sidecar marks poolChanged:false is excluded, not just login', () => {
    // These four answer ok without touching the pool
    // (`app/sidecar/accountsDomain.ts`). Each false trigger is a ~189 MB worker
    // boot plus a live usage fetch, and `oauthAlias` emits the success progress
    // BEFORE its own ok, so counting it here bought two spawns for one sign-in.
    for (const verb of [
      'account.login',
      'account.oauthPasteCode',
      'account.oauthAlias',
      'account.oauthCancel',
    ]) {
      expect(frameMutatedAccountsPool(accountResult(verb, true))).toBe(false)
    }
  })

  test('the allowlist is closed: an unrecognised verb refreshes nothing', () => {
    // A verb added later must cost nothing until it is listed, rather than
    // silently spawning a worker on every occurrence.
    expect(frameMutatedAccountsPool(accountResult('account.somethingNew', true)))
      .toBe(false)
  })

  test('no other frame kind refreshes, and a malformed frame does not throw', () => {
    expect(frameMutatedAccountsPool(errorFrame())).toBe(false)
    expect(frameMutatedAccountsPool(pongFrame())).toBe(false)
    expect(frameMutatedAccountsPool(lifecycle('exited'))).toBe(false)
    // main's handler runs inside the supervisor socket loop, which has no
    // try/catch: a nested read on a frame missing its payload must not throw the
    // loop out and drop delivery for that session.
    const malformed = {
      kind: 'oauth.login.progress',
      protocolVersion: PROTOCOL_VERSION,
      sessionId: 's1',
    } as unknown as ServerFrame
    expect(() => frameMutatedAccountsPool(malformed)).not.toThrow()
    expect(frameMutatedAccountsPool(malformed)).toBe(false)
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
    forked: false,
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

describe('runDetachedCliFallbackSpawn (editor CLI fallback settle policy)', () => {
  /** A hand-driven child: `emit` fires a registered listener directly, no real process involved. */
  function fakeChild() {
    const listeners: { error: ((error: Error) => void)[]; exit: ((code: number | null) => void)[] } = {
      error: [],
      exit: [],
    }
    const handle: DetachedCliHandle = {
      on: (event, listener) => {
        if (event === 'error') listeners.error.push(listener as (error: Error) => void)
        else listeners.exit.push(listener as (code: number | null) => void)
      },
      unref: () => {},
    }
    return {
      handle,
      emitError: (error: Error) => listeners.error.forEach(l => l(error)),
      emitExit: (code: number | null) => listeners.exit.forEach(l => l(code)),
    }
  }

  /** A hand-driven timer: `fire()` runs the one armed callback, like `createStartupTimers`'s fake. */
  function fakeTimer() {
    let armed: (() => void) | null = null
    return {
      setTimer: (run: () => void) => {
        armed = run
        return null
      },
      fire: () => {
        const run = armed
        armed = null
        run?.()
      },
    }
  }

  test('resolves true once the settle delay elapses with no error or nonzero exit', async () => {
    const child = fakeChild()
    const timer = fakeTimer()
    const result = runDetachedCliFallbackSpawn({
      spawn: () => child.handle,
      setTimer: timer.setTimer,
      settleDelayMs: 150,
    })
    timer.fire()
    expect(await result).toBe(true)
  })

  test('resolves true when the child exits 0 before the settle delay', async () => {
    const child = fakeChild()
    const timer = fakeTimer()
    const result = runDetachedCliFallbackSpawn({
      spawn: () => child.handle,
      setTimer: timer.setTimer,
      settleDelayMs: 150,
    })
    child.emitExit(0)
    timer.fire()
    expect(await result).toBe(true)
  })

  // The regression this policy exists for: a CLI that spawns and then exits
  // nonzero is not a spawn `error` event, so without an `exit` listener the
  // settle timer used to win and report success anyway.
  test('resolves false when the child exits nonzero before the settle delay', async () => {
    const child = fakeChild()
    const timer = fakeTimer()
    const result = runDetachedCliFallbackSpawn({
      spawn: () => child.handle,
      setTimer: timer.setTimer,
      settleDelayMs: 150,
    })
    child.emitExit(1)
    expect(await result).toBe(false)
  })

  test('resolves false on a spawn error event, and the later timer cannot overturn it', async () => {
    const child = fakeChild()
    const timer = fakeTimer()
    const result = runDetachedCliFallbackSpawn({
      spawn: () => child.handle,
      setTimer: timer.setTimer,
      settleDelayMs: 150,
    })
    child.emitError(new Error('spawn ENOENT'))
    // A once-settled outcome must not flip: firing the timer afterwards is a
    // no-op, proving `finish` is idempotent rather than racy.
    timer.fire()
    expect(await result).toBe(false)
  })

  test('resolves false when spawn throws synchronously', async () => {
    const timer = fakeTimer()
    const result = runDetachedCliFallbackSpawn({
      spawn: () => {
        throw new Error('spawn failed')
      },
      setTimer: timer.setTimer,
      settleDelayMs: 150,
    })
    expect(await result).toBe(false)
  })
})

test('renderer health sampling cadence resets with the monitor', () => {
  // The cadence used to be a module global in main.ts that reset() never
  // cleared, so the first sample of a reopened window could be suppressed for a
  // full interval.
  let clock = 0
  const health = createRendererHealthMonitor({ now: () => clock })
  health.reset()

  clock = 1_000
  expect(health.response().shouldSample).toBe(true)
  clock = 2_000
  expect(health.response().shouldSample).toBe(false)
  clock = 40_000
  expect(health.response().shouldSample).toBe(true)

  // A window reopen must sample immediately rather than wait out the interval.
  clock = 41_000
  health.reset()
  clock = 42_000
  expect(health.response().shouldSample).toBe(true)
})
