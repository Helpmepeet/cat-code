/**
 * Host composition-layer tests (P3-3 — REGISTRY §6/§6.1 · SECURITY-MINIMUM
 * Addendum HC1–HC4). Covers all five methods, every HostErrorCode path, the HC2
 * id fuzz, the HC4 caps, closeSession replay eviction + clean-restorable row, and
 * the HostEvent stream on status/exit/add/remove.
 *
 * Hermetic: a FAKE supervisor (drives spawn/ready/status/exit deterministically,
 * reports pid/socketPath) + the REAL registry over an injected temp dir. No
 * electron, no real process tree, no real sockets.
 */

import { afterEach, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

import { NAME_REPAIR_WINDOW_MS, SessionRegistry } from './registry.js'
import { PEER_NAME_POOL } from './peerNames.js'
import { Host, type CwdValidation } from './host.js'
import type { SessionId } from '../shared/protocol.js'
import type {
  SidecarStatus,
  SupervisorEvent,
} from '../supervisor/supervisor.js'
import type { HostEvent } from '../shared/hostApi.js'
import {
  MAX_SPAWNS_PER_WINDOW,
  SPAWN_RATE_WINDOW_MS,
} from '../shared/hostApi.js'
import {
  PARKED_EXIT_CODE,
  RESUME_BUSY_EXIT_CODE,
  RESUME_FAILED_EXIT_CODE,
} from '../shared/limits.js'
import { createShellState, reduceShellState } from '../renderer/src/shellState.js'

/* ------------------------------------------------------------------------- *
 * Fake supervisor — the exact public surface the host calls.
 * ------------------------------------------------------------------------- */

type FakeRecord = {
  sessionId: SessionId
  status: SidecarStatus
  pid: number
  socketPath: string
  cwd: string
  resumeEngineSessionId?: string
  /** PEER-SESSIONS §2 — recorded so a test can prove what reached the spawn env. */
  name?: string
  createdBy?: string
  createdByName?: string
  model?: string
  effort?: string
}

/** The peer half of the real `SpawnConfig` (`app/supervisor/supervisor.ts`). */
type FakeSpawnConfig = {
  cwd: string
  resumeEngineSessionId?: string
  name?: string
  createdBy?: string
  createdByName?: string
  model?: string
  effort?: string
}

class FakeSupervisor {
  readonly records = new Map<SessionId, FakeRecord>()
  private readonly listeners = new Set<(e: SupervisorEvent) => void>()
  private pidSeq = 10000
  private sockSeq = 0

  /** If set, the NEXT spawnSession throws (spawn_failed path). */
  throwOnNextSpawn: Error | null = null

  /** Mirrors the real supervisor's terminal state after `shutdown()`. */
  private closed = false

  subscribe(listener: (e: SupervisorEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  spawnSession(sessionId: SessionId, config?: FakeSpawnConfig): SessionId {
    if (this.closed) {
      throw new Error('supervisor has shut down; refusing to spawn')
    }
    if (this.throwOnNextSpawn) {
      const err = this.throwOnNextSpawn
      this.throwOnNextSpawn = null
      throw err
    }
    if (this.records.has(sessionId)) throw new Error('duplicate id')
    this.records.set(sessionId, {
      sessionId,
      status: 'spawning',
      pid: ++this.pidSeq,
      socketPath: `/tmp/fake/s${this.sockSeq++}.sock`,
      cwd: config?.cwd ?? '',
      ...(config?.resumeEngineSessionId !== undefined
        ? { resumeEngineSessionId: config.resumeEngineSessionId }
        : {}),
      ...(config?.name !== undefined ? { name: config.name } : {}),
      ...(config?.createdBy !== undefined ? { createdBy: config.createdBy } : {}),
      ...(config?.createdByName !== undefined
        ? { createdByName: config.createdByName }
        : {}),
      ...(config?.model !== undefined ? { model: config.model } : {}),
      ...(config?.effort !== undefined ? { effort: config.effort } : {}),
    })
    return sessionId
  }

  killSession(sessionId: SessionId): void {
    const record = this.records.get(sessionId)
    if (!record) return
    this.records.delete(sessionId)
    // The REAL supervisor emits NO exit after a kill (it deregisters first;
    // the F11 guard drops the child's late exit). This synthetic exit is
    // deliberately HARSHER than reality: it exercises the host's `closing`
    // suppression — without which a host-asked kill would be mis-marked as a
    // crash (F3).
    this.emit({ type: 'exit', sessionId, code: null, signal: 'SIGTERM' })
  }

  restartSession(sessionId: SessionId, config?: FakeSpawnConfig): void {
    const record = this.records.get(sessionId)
    if (!record) throw new Error('no such session')
    // Fresh child = new pid + socketPath (what SF5 must re-record).
    record.pid = ++this.pidSeq
    record.socketPath = `/tmp/fake/s${this.sockSeq++}.sock`
    record.status = 'spawning'
    record.cwd = config?.cwd ?? record.cwd
    if (config?.resumeEngineSessionId !== undefined) {
      record.resumeEngineSessionId = config.resumeEngineSessionId
    } else {
      delete record.resumeEngineSessionId
    }
    // A restart re-applies the peer identity too: the fresh process must boot
    // knowing its own name and its creator's LABEL, or a live session becomes
    // unaddressable and a created one holds an id it cannot render.
    if (config?.name !== undefined) record.name = config.name
    if (config?.createdBy !== undefined) record.createdBy = config.createdBy
    if (config?.createdByName !== undefined) {
      record.createdByName = config.createdByName
    }
  }

  shutdown(): void {
    this.closed = true
    const ids = [...this.records.keys()]
    this.records.clear()
    for (const sessionId of ids) {
      this.emit({ type: 'exit', sessionId, code: null, signal: 'SIGTERM' })
    }
  }

  listSessions(): Array<{ sessionId: SessionId; status: SidecarStatus }> {
    return [...this.records.values()].map(r => ({
      sessionId: r.sessionId,
      status: r.status,
    }))
  }

  getSessionProcessId(sessionId: SessionId): number | undefined {
    return this.records.get(sessionId)?.pid
  }

  getSessionSocketPath(sessionId: SessionId): string | undefined {
    return this.records.get(sessionId)?.socketPath
  }

  /* --- test drivers --- */

  /** Drive a ready frame (the two-id bridge fires here). */
  emitReady(sessionId: SessionId, engineSessionId: string): void {
    const record = this.records.get(sessionId)
    if (record) record.status = 'ready'
    this.emit({
      type: 'frame',
      sessionId,
      frame: {
        kind: 'ready',
        protocolVersion: 2,
        sessionId,
        engineSessionId,
        payload: { type: 'app.ready' } as never,
      },
    })
  }

  /**
   * Drive an outbound engine `EventFrame` (the CC-2 message-sent path). `event`
   * is the raw `AppSessionEvent` the engine forwards; `replay:true` marks a
   * history frame the resumed sidecar re-emits at OPEN/restore.
   */
  emitEventFrame(
    sessionId: SessionId,
    event: unknown,
    opts: { replay?: true } = {},
  ): void {
    this.emit({
      type: 'frame',
      sessionId,
      frame: {
        kind: 'event',
        protocolVersion: 2,
        sessionId,
        ...(opts.replay ? { replay: true } : {}),
        event,
      } as never,
    })
  }

  setStatus(sessionId: SessionId, status: SidecarStatus): void {
    const record = this.records.get(sessionId)
    if (record) record.status = status
    this.emit({ type: 'status', sessionId, status })
  }

  /**
   * Drive a REAL crash: the child dies WITHOUT killSession, so the record
   * STAYS registered with a terminal status (the real supervisor deregisters
   * only on killSession — supervisor.ts child.on('exit') keeps the record).
   * This is the `kill <pid>` shape the P3-5b GUI acceptance exercised.
   */
  emitCrash(sessionId: SessionId): void {
    const record = this.records.get(sessionId)
    if (record) record.status = 'exited'
    this.emit({ type: 'exit', sessionId, code: 1, signal: null })
    this.emit({ type: 'status', sessionId, status: 'exited' })
  }

  /**
   * IDLE-PARK — a gated self-exit: the sidecar flushed + exited with
   * `PARKED_EXIT_CODE`. Same tombstone-kept shape as `emitCrash` (the record
   * stays registered), but the exit CODE tells the host it is a park, not a crash.
   */
  emitPark(sessionId: SessionId): void {
    const record = this.records.get(sessionId)
    if (record) record.status = 'exited'
    this.emit({ type: 'exit', sessionId, code: PARKED_EXIT_CODE, signal: null })
    this.emit({ type: 'status', sessionId, status: 'exited' })
  }

  /**
   * The sidecar refusing an unresumable engine session id: `resumeEngineSession`
   * threw `SidecarResumeError` and the process self-exited with
   * `RESUME_FAILED_EXIT_CODE` (app/sidecar/index.ts). Same tombstone-kept shape
   * as `emitCrash` — only the exit CODE distinguishes the two.
   */
  emitResumeFailed(sessionId: SessionId): void {
    const record = this.records.get(sessionId)
    if (record) record.status = 'exited'
    this.emit({
      type: 'exit',
      sessionId,
      code: RESUME_FAILED_EXIT_CODE,
      signal: null,
    })
    this.emit({ type: 'status', sessionId, status: 'exited' })
  }

  emitResumeBusy(sessionId: SessionId): void {
    const record = this.records.get(sessionId)
    if (record) record.status = 'exited'
    this.emit({
      type: 'exit',
      sessionId,
      code: RESUME_BUSY_EXIT_CODE,
      signal: null,
    })
    this.emit({ type: 'status', sessionId, status: 'exited' })
  }

  emit(event: SupervisorEvent): void {
    for (const listener of this.listeners) listener(event)
  }
}

/* ------------------------------------------------------------------------- *
 * Harness
 * ------------------------------------------------------------------------- */

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // best-effort
    }
  }
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'catcode-host-'))
  tempDirs.push(dir)
  return dir
}

function writeTranscript(storageDir: string, engineSessionId: string): void {
  const dir = join(storageDir, 'transcripts')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${engineSessionId}.jsonl`), '{"type":"summary"}\n')
}

/**
 * Supervisor events are handled on an async task (fill → persist → real lock),
 * so a test that drives an event must let that settle. Poll briefly until
 * `predicate` holds (host event emitted / row updated) rather than guessing a
 * fixed number of microtask hops.
 *
 * Throwing on exhaustion is the whole point (matching `waitFor` in
 * `sidecarServer.test.ts`): a wait that gives up quietly lets the assertion
 * after it pass for the OPPOSITE reason, because the state it was waiting for
 * never arriving usually satisfies the same "not yet / still false" check.
 */
async function settle(predicate: () => boolean, tries = 100): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  throw new Error(`settle: predicate never held after ${tries} tries`)
}

/** A deliberate drain: give an async task room to run so a test can then prove it did NOT. */
async function drain(tries = 25): Promise<void> {
  for (let i = 0; i < tries; i++) {
    await new Promise(resolve => setTimeout(resolve, 2))
  }
}

type Harness = {
  host: Host
  supervisor: FakeSupervisor
  registry: SessionRegistry
  storageDir: string
  cwd: string
  events: HostEvent[]
  evicted: SessionId[]
  logs: string[]
  now: () => number
  setNow: (v: number) => void
}

function makeHost(
  overrides: {
    validateCwd?: (cwd: string) => CwdValidation
    registry?: SessionRegistry
  } = {},
): Harness {
  const storageDir = tempDir()
  const cwd = join(storageDir, 'project')
  mkdirSync(cwd, { recursive: true })

  const supervisor = new FakeSupervisor()
  const logs: string[] = []
  const registry =
    overrides.registry ??
    new SessionRegistry({
      storageDir,
      log: line => logs.push(line),
      transcriptPathFor: (_cwd, engineSessionId) =>
        join(storageDir, 'transcripts', `${engineSessionId}.jsonl`),
    })

  let nowValue = 1_000_000
  const now = () => nowValue
  const setNow = (v: number) => {
    nowValue = v
  }

  const events: HostEvent[] = []
  const evicted: SessionId[] = []

  const host = new Host({
    supervisor: supervisor as never,
    registry,
    validateCwd:
      overrides.validateCwd ??
      ((c: string): CwdValidation =>
        c === cwd || c === storageDir
          ? { ok: true, realpath: c }
          : { ok: false }),
    evictReplay: id => evicted.push(id),
    log: line => logs.push(line),
    now,
  })
  host.subscribe(e => events.push(e))

  return { host, supervisor, registry, storageDir, cwd, events, evicted, logs, now, setNow }
}

/* ------------------------------------------------------------------------- *
 * createSession — happy path + engineSessionId bridge + session-added
 * ------------------------------------------------------------------------- */

test('createSession spawns, persists a live row, and emits session-added', async () => {
  const h = makeHost()
  const result = await h.host.createSession({ cwd: h.cwd, title: 'work' })

  expect(result.ok).toBe(true)
  if (!result.ok) return
  const { appSessionId } = result.value
  expect(result.value.status).toBe('spawning')
  expect(result.value.cwd).toBe(h.cwd)
  expect(result.value.title).toBe('work')
  expect(result.value.engineSessionId).toBeNull()
  expect(result.value.forked).toBe(false)

  // Row persisted, live, addressed by the same id, cwd captured.
  const row = h.registry.findSession(appSessionId)
  expect(row?.shutdown).toBeNull()
  expect(row?.cwd).toBe(h.cwd)
  expect(row?.enginePid).toBe(h.supervisor.getSessionProcessId(appSessionId))
  expect(row?.socketPath).toBe(h.supervisor.getSessionSocketPath(appSessionId))

  // Spawn config carried the cwd (fresh spawn = no resume).
  const spawned = h.supervisor.records.get(appSessionId)
  expect(spawned?.cwd).toBe(h.cwd)
  expect(spawned?.resumeEngineSessionId).toBeUndefined()

  expect(h.events.some(e => e.type === 'session-added')).toBe(true)
})

// Opening a session from history is a `createSession` with a resume target and a
// FRESH appSessionId, so it takes the new-row path. Before this, the row carried
// no engine id until the ready frame echoed one back — and for that whole window
// the renderer could not join it to its own transcript entry
// (`sessionsCatalogState.ts` keys the merge on `engineSessionId`), so it both
// duplicated the history row and sorted to the top of the sidebar on
// `createdAtMs` as if it were brand-new activity (`sidebarState.ts`
// `sidebarActivityKey`). The visible symptom was a row jumping to the top on
// open and then dropping back once the frame landed.
test('a resume-create exposes engineSessionId immediately, before any ready frame', async () => {
  const h = makeHost()
  const result = await h.host.createSession({
    cwd: h.cwd,
    resumeEngineSessionId: 'engine-history-7',
  })

  expect(result.ok).toBe(true)
  if (!result.ok) return
  expect(result.value.status).toBe('spawning')
  // The descriptor the renderer sees FIRST already carries the id.
  expect(result.value.engineSessionId).toBe('engine-history-7')
  expect(h.registry.findSession(result.value.appSessionId)?.engineSessionId).toBe(
    'engine-history-7',
  )
  // And the resume still reaches the sidecar unchanged.
  expect(
    h.supervisor.records.get(result.value.appSessionId)?.resumeEngineSessionId,
  ).toBe('engine-history-7')
  expect(result.value.forked).toBe(false)
})

test('trusted fork provenance survives descriptor projection, close/restore, and restart', async () => {
  const h = makeHost()
  writeTranscript(h.storageDir, 'engine-fork-7')
  const created = await h.host.createSession({
    cwd: h.cwd,
    resumeEngineSessionId: 'engine-fork-7',
    forked: true,
  })

  expect(created.ok).toBe(true)
  if (!created.ok) return
  const { appSessionId } = created.value
  expect(created.value.forked).toBe(true)
  expect(h.registry.findSession(appSessionId)?.forked).toBe(true)
  expect(
    h.events.find(
      event =>
        event.type === 'session-added' &&
        event.session.appSessionId === appSessionId,
    ),
  ).toMatchObject({ session: { forked: true } })

  expect((await h.host.closeSession(appSessionId)).ok).toBe(true)
  const restored = await h.host.restoreSession(appSessionId)
  expect(restored.ok).toBe(true)
  if (!restored.ok) return
  expect(restored.value.forked).toBe(true)

  expect((await h.host.restartSession(appSessionId)).ok).toBe(true)
  expect(h.registry.findSession(appSessionId)?.forked).toBe(true)
  expect(
    h.host.listSessions().find(session => session.appSessionId === appSessionId)
      ?.forked,
  ).toBe(true)
})

test('concurrent restores elect one owner without replacing its new sidecar', async () => {
  const h = makeHost()
  writeTranscript(h.storageDir, 'engine-restore-race')
  const created = await h.host.createSession({
    cwd: h.cwd,
    resumeEngineSessionId: 'engine-restore-race',
  })
  expect(created.ok).toBe(true)
  if (!created.ok) return
  await h.host.closeSession(created.value.appSessionId)

  const [winner, loser] = await Promise.all([
    h.host.restoreSession(created.value.appSessionId),
    h.host.restoreSession(created.value.appSessionId),
  ])

  expect([winner, loser].filter(result => result.ok)).toHaveLength(1)
  expect([winner, loser].filter(result => !result.ok)).toHaveLength(1)
  expect(h.supervisor.records.get(created.value.appSessionId)?.status).toBe('spawning')
  expect(h.registry.findSession(created.value.appSessionId)?.shutdown).toBeNull()
})

test('ready frame bridges engineSessionId into the row and emits session-status', async () => {
  const h = makeHost()
  const result = await h.host.createSession({ cwd: h.cwd })
  expect(result.ok).toBe(true)
  if (!result.ok) return
  const { appSessionId } = result.value

  h.events.length = 0
  h.supervisor.emitReady(appSessionId, 'engine-abc')
  await settle(() => h.events.some(e => e.type === 'session-status'))

  expect(h.registry.findSession(appSessionId)?.engineSessionId).toBe('engine-abc')
  const statusEvent = h.events.find(e => e.type === 'session-status')
  expect(statusEvent).toBeDefined()
  if (statusEvent?.type === 'session-status') {
    expect(statusEvent.session.status).toBe('ready')
    expect(statusEvent.session.engineSessionId).toBe('engine-abc')
    // A LIVE ready session is NOT a restore candidate — restorable is set only
    // when no process is live (app/shared/hostApi.ts:74). It becomes restorable
    // on close/crash (see the closeSession test), never while ready.
    expect(statusEvent.session.restorable).toBe(false)
  }
})

test('CC-2: a live result event frame stamps lastMessageSentAt and surfaces it; replay/user/non-message frames do NOT', async () => {
  const h = makeHost()
  const created = await h.host.createSession({ cwd: h.cwd })
  expect(created.ok).toBe(true)
  if (!created.ok) return
  const { appSessionId } = created.value
  h.supervisor.emitReady(appSessionId, 'engine-1')
  await settle(() => h.registry.findSession(appSessionId)?.engineSessionId === 'engine-1')

  // Opening/attaching a session (create + ready frame) has SENT nothing.
  expect(h.registry.findSession(appSessionId)?.lastMessageSentAt).toBeNull()

  // NONE of: a replayed turn-end (open/restore history), a live user/tool_result
  // frame (we key on `result`, not `user`), or a live non-message event frame
  // (goal snapshot) may stamp recency.
  h.supervisor.emitEventFrame(
    appSessionId,
    { type: 'message', message: { type: 'result', subtype: 'success' } },
    { replay: true },
  )
  h.supervisor.emitEventFrame(appSessionId, {
    type: 'message',
    message: { type: 'user', message: { role: 'user', content: [] } },
  })
  h.supervisor.emitEventFrame(appSessionId, { type: 'goal.snapshot', snapshot: null })
  // Let any (erroneous) async bump drain, then assert it never happened.
  await drain()
  expect(h.registry.findSession(appSessionId)?.lastMessageSentAt).toBeNull()

  // A live (non-replay) `result` frame = a turn actually ran → stamp + surface
  // the refreshed descriptor so the sidebar's recency updates live.
  h.events.length = 0
  const before = Date.now()
  h.supervisor.emitEventFrame(appSessionId, {
    type: 'message',
    message: { type: 'result', subtype: 'success' },
  })
  // Settle on the EMITTED event, not the in-memory field: markMessageSent sets
  // the field before its persist resolves and before emitStatus fires, so the
  // event is the later, complete signal.
  await settle(() => h.events.some(e => e.type === 'session-status'))

  const stamped = h.registry.findSession(appSessionId)?.lastMessageSentAt
  expect(typeof stamped).toBe('number')
  expect(stamped as number).toBeGreaterThanOrEqual(before)
  // The descriptor carries the field through to the renderer (mapping wired).
  const statusEvent = h.events.find(e => e.type === 'session-status')
  expect(statusEvent).toBeDefined()
  if (statusEvent?.type === 'session-status') {
    expect(statusEvent.session.lastMessageSentAt).toBe(stamped ?? null)
  }
})

/* ------------------------------------------------------------------------- *
 * HC1 — invalid_cwd
 * ------------------------------------------------------------------------- */

test('setTitle — persists on the row, surfaces the descriptor, caps length, no-ops on empty/bad id', async () => {
  const h = makeHost()
  const created = await h.host.createSession({ cwd: h.cwd })
  expect(created.ok).toBe(true)
  if (!created.ok) return
  const { appSessionId } = created.value

  const before = h.events.length
  await h.host.setTitle(appSessionId, 'Fix login button')

  // Durable on the row AND surfaced on the descriptor (the sidebar's source).
  expect(h.registry.findSession(appSessionId)?.title).toBe('Fix login button')
  expect(
    h.host.listSessions().find(s => s.appSessionId === appSessionId)?.title,
  ).toBe('Fix login button')
  // A HostEvent was emitted so the renderer relabels the tab/sidebar live.
  expect(h.events.length).toBeGreaterThan(before)

  // Empty title is a no-op — never clobbers a real title with a blank.
  await h.host.setTitle(appSessionId, '')
  expect(h.registry.findSession(appSessionId)?.title).toBe('Fix login button')

  // Length-capped to MAX_SESSION_TITLE_CHARS (200).
  await h.host.setTitle(appSessionId, 'x'.repeat(500))
  expect(h.registry.findSession(appSessionId)?.title?.length).toBe(200)

  // A malformed id resolves to a silent no-op (defensive; never throws).
  await expect(
    h.host.setTitle('not-a-uuid' as never, 'ignored'),
  ).resolves.toBeUndefined()
})

test('setTitle surfaces titleUpdatedAt on the descriptor (the renderer title-precedence input)', async () => {
  const h = makeHost()
  const created = await h.host.createSession({ cwd: h.cwd })
  expect(created.ok).toBe(true)
  if (!created.ok) return
  const { appSessionId } = created.value
  const find = () =>
    h.host.listSessions().find(s => s.appSessionId === appSessionId) ?? null

  // A session created without a title recorded no intent — null, so the renderer
  // lets any real transcript title win.
  expect(created.value.titleUpdatedAt).toBeNull()
  expect(find()?.titleUpdatedAt).toBeNull()

  const before = Date.now()
  await h.host.setTitle(appSessionId, 'Fix login button')
  const stamped = find()?.titleUpdatedAt
  expect(typeof stamped).toBe('number')
  expect(stamped!).toBeGreaterThanOrEqual(before)
})

test('createSession rejects a cwd that is not an existing directory (invalid_cwd)', async () => {
  const h = makeHost()
  const result = await h.host.createSession({ cwd: '/no/such/dir' })
  expect(result.ok).toBe(false)
  if (result.ok) return
  expect(result.error.code).toBe('invalid_cwd')
  // Nothing spawned, no row written.
  expect(h.supervisor.records.size).toBe(0)
  expect(h.registry.sessions.length).toBe(0)
})

test('createSession rejects an empty/absent cwd (invalid_cwd) without touching validateCwd', async () => {
  const h = makeHost()
  for (const bad of ['', undefined, null, 42, {}]) {
    const result = await h.host.createSession({ cwd: bad as never })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('invalid_cwd')
  }
  expect(h.supervisor.records.size).toBe(0)
})

test('createSession canonicalizes the cwd — the row + spawn use the realpath', async () => {
  const h = makeHost({
    validateCwd: (c: string) =>
      c === '/link/to/proj'
        ? { ok: true, realpath: '/real/proj' }
        : { ok: false },
  })
  const result = await h.host.createSession({ cwd: '/link/to/proj' })
  expect(result.ok).toBe(true)
  if (!result.ok) return
  expect(result.value.cwd).toBe('/real/proj')
  expect(h.supervisor.records.get(result.value.appSessionId)?.cwd).toBe('/real/proj')
})

/* ------------------------------------------------------------------------- *
 * spawn_failed
 * ------------------------------------------------------------------------- */

test('createSession reports spawn_failed when the supervisor throws, and marks the dead row clean', async () => {
  const h = makeHost()
  h.supervisor.throwOnNextSpawn = new Error('socket path too long')
  const result = await h.host.createSession({ cwd: h.cwd })

  expect(result.ok).toBe(false)
  if (result.ok) return
  expect(result.error.code).toBe('spawn_failed')
  // The row we pre-wrote is marked clean (not a phantom live crash) + removed.
  const rows = h.registry.sessions
  expect(rows.length).toBe(1)
  expect(rows[0]?.shutdown).toBe('clean')
  expect(h.events.some(e => e.type === 'session-removed')).toBe(true)
})

/* ------------------------------------------------------------------------- *
 * HC4 — session_limit (rate cap + row cap)
 * ------------------------------------------------------------------------- */

test('createSession enforces the spawn rate cap (HC4 → session_limit)', async () => {
  const h = makeHost()
  // Fill the window.
  for (let i = 0; i < MAX_SPAWNS_PER_WINDOW; i++) {
    const r = await h.host.createSession({ cwd: h.cwd })
    expect(r.ok).toBe(true)
  }
  const overflow = await h.host.createSession({ cwd: h.cwd })
  expect(overflow.ok).toBe(false)
  if (!overflow.ok) expect(overflow.error.code).toBe('session_limit')

  // Advancing past the window frees the cap again.
  h.setNow(h.now() + SPAWN_RATE_WINDOW_MS + 1)
  const next = await h.host.createSession({ cwd: h.cwd })
  expect(next.ok).toBe(true)
})

test('a backward wall-clock jump resets the host spawn-rate window', async () => {
  const h = makeHost()
  for (let index = 0; index < MAX_SPAWNS_PER_WINDOW; index += 1) {
    expect((await h.host.createSession({ cwd: h.cwd })).ok).toBe(true)
  }
  expect((await h.host.createSession({ cwd: h.cwd })).ok).toBe(false)

  h.setNow(h.now() - SPAWN_RATE_WINDOW_MS - 1)
  expect((await h.host.createSession({ cwd: h.cwd })).ok).toBe(true)
})

test('restartSession shares the HC4 spawn-rate cap', async () => {
  const h = makeHost()
  const created = await h.host.createSession({ cwd: h.cwd })
  expect(created.ok).toBe(true)
  if (!created.ok) return

  // The initial create consumes one slot; restarts consume the remaining slots.
  for (let i = 1; i < MAX_SPAWNS_PER_WINDOW; i++) {
    const restarted = await h.host.restartSession(created.value.appSessionId)
    expect(restarted.ok).toBe(true)
  }

  const refused = await h.host.restartSession(created.value.appSessionId)
  expect(refused.ok).toBe(false)
  if (!refused.ok) expect(refused.error.code).toBe('session_limit')

  h.setNow(h.now() + SPAWN_RATE_WINDOW_MS + 1)
  const resumed = await h.host.restartSession(created.value.appSessionId)
  expect(resumed.ok).toBe(true)
})

test('restarting a terminal tombstone cannot exceed the live-process cap', async () => {
  const h = makeHost()
  const created = await h.host.createSession({ cwd: h.cwd })
  expect(created.ok).toBe(true)
  if (!created.ok) return

  const target = h.supervisor.records.get(created.value.appSessionId)
  expect(target).toBeDefined()
  if (!target) return
  target.status = 'exited'

  const { MAX_LIVE_SESSIONS } = await import('../shared/hostApi.js')
  for (let i = 0; i < MAX_LIVE_SESSIONS; i++) {
    h.supervisor.records.set(`live-restart-${i}`, {
      sessionId: `live-restart-${i}`,
      status: 'ready',
      cwd: h.cwd,
      pid: i + 1,
      socketPath: `/tmp/live-restart-${i}.sock`,
    })
  }
  h.setNow(h.now() + SPAWN_RATE_WINDOW_MS + 1)

  const result = await h.host.restartSession(created.value.appSessionId)
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.error.code).toBe('session_limit')
  expect(h.supervisor.records.get(created.value.appSessionId)?.status).toBe('exited')
  expect(
    h.supervisor
      .listSessions()
      .filter(record => record.status !== 'exited' && record.status !== 'failed'),
  ).toHaveLength(MAX_LIVE_SESSIONS)
})

test('createSession enforces the live-process bound (HC4 → session_limit)', async () => {
  // A tiny fake registry that reports a saturated live set via the supervisor.
  const h = makeHost()
  // Stuff the supervisor with MAX_LIVE_SESSIONS live records directly.
  const { MAX_LIVE_SESSIONS } = await import('../shared/hostApi.js')
  for (let i = 0; i < MAX_LIVE_SESSIONS; i++) {
    h.supervisor.records.set(`live-${i}`, {
      sessionId: `live-${i}`,
      status: 'ready',
      pid: 1000 + i,
      socketPath: `/tmp/s${i}`,
      cwd: h.cwd,
    })
  }
  const result = await h.host.createSession({ cwd: h.cwd })
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.error.code).toBe('session_limit')
})

test('HC4 admits only one concurrent create into the final live slot', async () => {
  const h = makeHost()
  const { MAX_LIVE_SESSIONS } = await import('../shared/hostApi.js')
  for (let i = 0; i < MAX_LIVE_SESSIONS - 1; i++) {
    h.supervisor.records.set(`live-${i}`, {
      sessionId: `live-${i}`,
      status: 'ready',
      cwd: h.cwd,
      pid: i + 1,
      socketPath: `/tmp/live-${i}.sock`,
    })
  }

  const results = await Promise.all([
    h.host.createSession({ cwd: h.cwd }),
    h.host.createSession({ cwd: h.cwd }),
  ])

  expect(results.filter(result => result.ok)).toHaveLength(1)
  expect(results.filter(result => !result.ok)).toHaveLength(1)
  expect(
    h.supervisor
      .listSessions()
      .filter(record => record.status !== 'exited' && record.status !== 'failed'),
  ).toHaveLength(MAX_LIVE_SESSIONS)
})

test('HC4: terminal tombstones do not consume the live-session cap', async () => {
  const { MAX_LIVE_SESSIONS } = await import('../shared/hostApi.js')

  const createHarness = makeHost()
  for (let i = 0; i < MAX_LIVE_SESSIONS - 1; i++) {
    createHarness.supervisor.records.set(`live-${i}`, {
      sessionId: `live-${i}`,
      status: 'ready',
      pid: 1000 + i,
      socketPath: `/tmp/s${i}`,
      cwd: createHarness.cwd,
    })
  }
  createHarness.supervisor.records.set('dead-tombstone', {
    sessionId: 'dead-tombstone',
    status: 'failed',
    pid: 2000,
    socketPath: '/tmp/dead.sock',
    cwd: createHarness.cwd,
  })

  const created = await createHarness.host.createSession({ cwd: createHarness.cwd })
  expect(created.ok).toBe(true)

  const restoreHarness = makeHost()
  for (let i = 0; i < MAX_LIVE_SESSIONS - 1; i++) {
    restoreHarness.supervisor.records.set(`live-${i}`, {
      sessionId: `live-${i}`,
      status: 'ready',
      pid: 3000 + i,
      socketPath: `/tmp/restore-${i}`,
      cwd: restoreHarness.cwd,
    })
  }
  const appSessionId = randomUUID()
  writeTranscript(restoreHarness.storageDir, 'engine-parked')
  await restoreHarness.registry.upsertOnSpawn({
    appSessionId,
    cwd: restoreHarness.cwd,
  })
  await restoreHarness.registry.fillEngineSessionId(appSessionId, 'engine-parked')
  await restoreHarness.registry.markParked(appSessionId)
  restoreHarness.supervisor.records.set(appSessionId, {
    sessionId: appSessionId,
    status: 'exited',
    pid: 4000,
    socketPath: '/tmp/parked.sock',
    cwd: restoreHarness.cwd,
  })

  const restored = await restoreHarness.host.restoreSession(appSessionId)
  expect(restored.ok).toBe(true)
  if (restored.ok) expect(restored.value.appSessionId).toBe(appSessionId)
})

test('HC4: the live-process cap is independent of the registry row bound', async () => {
  // These were ONE constant until 2026-07-26, so raising the registry's
  // file-growth bound silently raised the fork-bomb cap. The row bound must be
  // free to grow while the process cap stays put; a future edit that re-fuses
  // them (or lets the process cap drift up with the rows) fails here.
  const { MAX_LIVE_SESSIONS } = await import('../shared/hostApi.js')
  const { MAX_REGISTRY_SESSIONS } = await import('./registry.js')
  expect(MAX_LIVE_SESSIONS).toBe(32)
  expect(MAX_REGISTRY_SESSIONS).toBeGreaterThan(MAX_LIVE_SESSIONS)

  // And the cap that actually gates spawning is the process one: a supervisor
  // holding MAX_LIVE_SESSIONS live records refuses, well below the row bound.
  const h = makeHost()
  for (let i = 0; i < MAX_LIVE_SESSIONS; i++) {
    h.supervisor.records.set(`live-${i}`, {
      sessionId: `live-${i}`,
      status: 'ready',
      pid: 1000 + i,
      socketPath: `/tmp/s${i}`,
      cwd: h.cwd,
    })
  }
  const refused = await h.host.createSession({ cwd: h.cwd })
  expect(refused.ok).toBe(false)
  if (!refused.ok) expect(refused.error.message).toContain(`${MAX_LIVE_SESSIONS}`)
})

/* ------------------------------------------------------------------------- *
 * HC2 — id fuzz (malformed → typed error, no crash/throw)
 * ------------------------------------------------------------------------- */

test('HC2 fuzz: malformed ids → session_not_found, never a throw', async () => {
  const h = makeHost()
  const fuzz: unknown[] = [
    '',
    'not-a-uuid',
    '../../etc/passwd',
    '"; DROP TABLE sessions;--',
    '💥',
    'x'.repeat(10_000),
    '00000000-0000-0000-0000-000000000000', // nil UUID (version nibble 0 — rejected)
    'g0000000-0000-1000-8000-000000000000', // non-hex
  ]
  for (const id of fuzz) {
    const restore = await h.host.restoreSession(id as string)
    expect(restore.ok).toBe(false)
    if (!restore.ok) expect(restore.error.code).toBe('session_not_found')

    const close = await h.host.closeSession(id as string)
    expect(close.ok).toBe(false)
    if (!close.ok) expect(close.error.code).toBe('session_not_found')
  }
})

/* ------------------------------------------------------------------------- *
 * restoreSession — session_not_found (row/transcript gone) + happy path
 * ------------------------------------------------------------------------- */

test('restoreSession fails session_not_found for a well-formed but unknown id', async () => {
  const h = makeHost()
  const result = await h.host.restoreSession(randomUUID())
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.error.code).toBe('session_not_found')
})

test('restoreSession re-spawns a clean row with its cwd + engineSessionId (resume)', async () => {
  const h = makeHost()
  const appSessionId = randomUUID()
  writeTranscript(h.storageDir, 'engine-xyz')
  // Seed a restorable clean row.
  await h.registry.upsertOnSpawn({ appSessionId, cwd: h.cwd })
  await h.registry.fillEngineSessionId(appSessionId, 'engine-xyz')
  await h.registry.markClean(appSessionId)

  const result = await h.host.restoreSession(appSessionId)
  expect(result.ok).toBe(true)
  if (!result.ok) return
  expect(result.value.appSessionId).toBe(appSessionId)
  // Spawn carried the resume id + the row's cwd (REGISTRY R3).
  const spawned = h.supervisor.records.get(appSessionId)
  expect(spawned?.resumeEngineSessionId).toBe('engine-xyz')
  expect(spawned?.cwd).toBe(h.cwd)
  // Row flipped back to live.
  expect(h.registry.findSession(appSessionId)?.shutdown).toBeNull()
})

test('a session stranded on a lost connection is refused with a code that does not mean "wait"', async () => {
  // `reportSocketLoss` settles a lost socket to `disconnected` and schedules no
  // reconnection, so the only exits are a kill or an explicit restart in place.
  // Restore cannot take either: it refuses the row, and it used to refuse it as
  // `session_not_found`, the same code it returns while a spawn is genuinely in
  // flight. The peer plane reads that code as "already restoring, wait for
  // ready", so every message to a stranded session sat through the whole wake
  // timeout holding one of the recipient's delivery slots, then failed anyway.
  const h = makeHost()
  const created = await h.host.createSession({ cwd: h.cwd })
  if (!created.ok) throw new Error(`create failed: ${created.error.code}`)
  const { appSessionId } = created.value
  writeTranscript(h.storageDir, 'engine-stranded')
  h.supervisor.emitReady(appSessionId, 'engine-stranded')
  await settle(
    () => h.registry.findSession(appSessionId)?.engineSessionId === 'engine-stranded',
  )
  // Everything else about the row is healthy: it has content and could be
  // resumed. Only the transport is gone.
  expect(h.host.canResume(appSessionId)).toBe(true)

  h.supervisor.setStatus(appSessionId, 'disconnected')
  const stranded = await h.host.restoreSession(appSessionId)

  expect(stranded.ok).toBe(false)
  if (stranded.ok) return
  expect(stranded.error.code).toBe('session_unreachable')
  expect(stranded.error.code).not.toBe('session_not_found')
  // Refused, not recovered: the child is left alone. A restore that killed a
  // stranded engine to respawn it would be doing the user's restart for them,
  // without being asked, to a process that may still be mid-turn.
  expect(h.supervisor.records.has(appSessionId)).toBe(true)
  expect(h.supervisor.records.get(appSessionId)?.status).toBe('disconnected')

  // A spawn genuinely in flight keeps the old answer, because there waiting for
  // the row's next ready IS the right advice.
  const spawning = await h.host.createSession({ cwd: h.cwd })
  if (!spawning.ok) throw new Error(`create failed: ${spawning.error.code}`)
  const inFlight = await h.host.restoreSession(spawning.value.appSessionId)
  expect(inFlight.ok).toBe(false)
  if (inFlight.ok) return
  expect(inFlight.error.code).toBe('session_not_found')
})

test('a failed RESTORE spawn keeps the row as a restore-offer (SF-2), a failed CREATE spawn removes it', async () => {
  const h = makeHost()
  // Seed a restorable clean row with a transcript (a real offer).
  const appSessionId = randomUUID()
  writeTranscript(h.storageDir, 'engine-sf2')
  await h.registry.upsertOnSpawn({ appSessionId, cwd: h.cwd })
  await h.registry.fillEngineSessionId(appSessionId, 'engine-sf2')
  await h.registry.markClean(appSessionId)

  // Restore whose spawn throws synchronously: the row still holds its
  // engineSessionId — it must STAY in the live∪restorable union as an offer
  // (session-status, NOT session-removed: the renderer pins removed ids until
  // relaunch, which would hide a perfectly restorable session).
  h.events.length = 0
  h.supervisor.throwOnNextSpawn = new Error('boom')
  const restore = await h.host.restoreSession(appSessionId)
  expect(restore.ok).toBe(false)
  if (!restore.ok) expect(restore.error.code).toBe('spawn_failed')

  expect(h.events.some(e => e.type === 'session-removed')).toBe(false)
  const statusEvent = h.events.find(e => e.type === 'session-status')
  expect(statusEvent).toBeDefined()
  if (statusEvent?.type === 'session-status') {
    expect(statusEvent.session.restorable).toBe(true)
    expect(statusEvent.session.status).toBe('exited')
  }
  const listed = h.host.listSessions().find(s => s.appSessionId === appSessionId)
  expect(listed?.restorable).toBe(true)

  // Contrast: a fresh CREATE whose spawn throws has no engineSessionId — its
  // row is neither a tab nor an offer, so it is removed (unchanged behavior).
  h.events.length = 0
  h.supervisor.throwOnNextSpawn = new Error('boom')
  const created = await h.host.createSession({ cwd: h.cwd })
  expect(created.ok).toBe(false)
  expect(h.events.some(e => e.type === 'session-removed')).toBe(true)
})

test('restoreSession refuses an already-live session', async () => {
  const h = makeHost()
  writeTranscript(h.storageDir, 'engine-live')
  const created = await h.host.createSession({ cwd: h.cwd })
  expect(created.ok).toBe(true)
  if (!created.ok) return
  h.supervisor.emitReady(created.value.appSessionId, 'engine-live')
  await settle(
    () => h.registry.findSession(created.value.appSessionId)?.engineSessionId === 'engine-live',
  )

  // Transcript exists (so it's not the SF6 recheck failing) — the live check is
  // what refuses this.
  const result = await h.host.restoreSession(created.value.appSessionId)
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.error.code).toBe('session_not_found')
})

test('restoreSession refuses when advisory pid/socket still identify a live prior sidecar', async () => {
  const storageDir = tempDir()
  const cwd = join(storageDir, 'project')
  mkdirSync(cwd, { recursive: true })
  const socketPath = join(storageDir, 'prior.sock')
  writeFileSync(socketPath, '')
  const marker = 'catcode-prior-sidecar'
  const priorPid = 4242
  const registry = new SessionRegistry({
    storageDir,
    transcriptPathFor: (_cwd, engineSessionId) =>
      join(storageDir, 'transcripts', `${engineSessionId}.jsonl`),
    isProcessAlive: pid => pid === priorPid,
    processCommand: pid => (pid === priorPid ? `/bin/bun ${marker}` : null),
    sidecarCommandMarker: marker,
  })
  const supervisor = new FakeSupervisor()
  const host = new Host({
    supervisor: supervisor as never,
    registry,
    validateCwd: (candidate: string): CwdValidation =>
      candidate === cwd ? { ok: true, realpath: candidate } : { ok: false },
  })
  const appSessionId = randomUUID()
  writeTranscript(storageDir, 'engine-prior')
  await registry.upsertOnSpawn({
    appSessionId,
    cwd,
    enginePid: priorPid,
    socketPath,
  })
  await registry.fillEngineSessionId(appSessionId, 'engine-prior')
  await registry.markClean(appSessionId)

  const result = await host.restoreSession(appSessionId)

  expect(result.ok).toBe(false)
  if (!result.ok) {
    expect(result.error.code).toBe('session_not_found')
    expect(result.error.message).toContain('prior sidecar')
  }
  expect(supervisor.records.has(appSessionId)).toBe(false)
})

/* ------------------------------------------------------------------------- *
 * closeSession — evicts replay + marks the row clean + restorable
 * ------------------------------------------------------------------------- */

test('closeSession evicts replay, marks the row clean, keeps it restorable', async () => {
  const h = makeHost()
  const created = await h.host.createSession({ cwd: h.cwd })
  expect(created.ok).toBe(true)
  if (!created.ok) return
  const { appSessionId } = created.value
  h.supervisor.emitReady(appSessionId, 'engine-close')
  await settle(() => h.registry.findSession(appSessionId)?.engineSessionId === 'engine-close')
  writeTranscript(h.storageDir, 'engine-close')

  const result = await h.host.closeSession(appSessionId)
  expect(result.ok).toBe(true)

  // The P3-0 carry — replay evicted for exactly this session.
  expect(h.evicted).toContain(appSessionId)
  // Sidecar killed.
  expect(h.supervisor.records.has(appSessionId)).toBe(false)
  // Row KEPT + marked clean + advisory fields retained for restore-time
  // prior-writer checks.
  const row = h.registry.findSession(appSessionId)
  expect(row).toBeDefined()
  expect(row?.shutdown).toBe('clean')
  expect(row?.enginePid).toBe(10001)
  expect(row?.socketPath).toBe('/tmp/fake/s0.sock')
  // Still restorable (transcript present, engineSessionId set).
  expect(row?.engineSessionId).toBe('engine-close')
  const listed = h.host.listSessions().find(s => s.appSessionId === appSessionId)
  expect(listed?.restorable).toBe(true)
  expect(listed?.status).toBe('exited')
})

test('closeSession removes a pre-ready row instead of emitting an uncloseable exited tab', async () => {
  const h = makeHost()
  const created = await h.host.createSession({ cwd: h.cwd })
  expect(created.ok).toBe(true)
  if (!created.ok) return
  const { appSessionId } = created.value

  h.events.length = 0
  const result = await h.host.closeSession(appSessionId)
  expect(result.ok).toBe(true)

  expect(h.supervisor.records.has(appSessionId)).toBe(false)
  expect(h.host.listSessions().some(s => s.appSessionId === appSessionId)).toBe(false)
  expect(
    h.events.some(e => e.type === 'session-removed' && e.appSessionId === appSessionId),
  ).toBe(true)
  expect(
    h.events.some(e => e.type === 'session-status' && e.session.appSessionId === appSessionId),
  ).toBe(false)
})

/* ------------------------------------------------------------------------- *
 * Kill/close parity (P3-5b GUI-acceptance fix) — a crash must surface as a
 * restorable, crash-flagged descriptor, distinguishable from a clean close.
 * ------------------------------------------------------------------------- */

test('a sidecar crash (kill, no closeSession) yields a restorable + crashed descriptor; a clean close stays exited', async () => {
  const h = makeHost()

  // Session A: crashes (the record stays as the restart tombstone).
  const crashed = await h.host.createSession({ cwd: h.cwd })
  expect(crashed.ok).toBe(true)
  if (!crashed.ok) return
  const crashedId = crashed.value.appSessionId
  h.supervisor.emitReady(crashedId, 'engine-killed')
  await settle(() => h.registry.findSession(crashedId)?.engineSessionId === 'engine-killed')
  writeTranscript(h.storageDir, 'engine-killed')

  h.events.length = 0
  h.supervisor.emitCrash(crashedId)
  await settle(() => h.registry.findSession(crashedId)?.shutdown === 'crashed')

  // The descriptor reads dead + crash-flagged + restorable — NOT the clean
  // -close shape — even though the tombstone record is still registered.
  const crashedDescriptor = h.host
    .listSessions()
    .find(s => s.appSessionId === crashedId)
  expect(crashedDescriptor?.status).toBe('disconnected')
  expect(crashedDescriptor?.restorable).toBe(true)
  // The session-status the crash emitted carried the same shape (what the
  // renderer's Sidebar actually receives).
  const statusEvent = h.events.find(e => e.type === 'session-status')
  expect(statusEvent).toBeDefined()
  if (statusEvent?.type === 'session-status') {
    expect(statusEvent.session.status).toBe('disconnected')
    expect(statusEvent.session.restorable).toBe(true)
  }
  // Tombstone kept: restart-in-place stays host-accepted.
  expect(h.supervisor.records.has(crashedId)).toBe(true)

  // Session B: clean close — restorable but NOT crash-flagged (the two paths
  // must stay distinguishable).
  const closed = await h.host.createSession({ cwd: h.cwd })
  expect(closed.ok).toBe(true)
  if (!closed.ok) return
  const closedId = closed.value.appSessionId
  h.supervisor.emitReady(closedId, 'engine-closed')
  await settle(() => h.registry.findSession(closedId)?.engineSessionId === 'engine-closed')
  writeTranscript(h.storageDir, 'engine-closed')
  await h.host.closeSession(closedId)

  const closedDescriptor = h.host
    .listSessions()
    .find(s => s.appSessionId === closedId)
  expect(closedDescriptor?.status).toBe('exited')
  expect(closedDescriptor?.restorable).toBe(true)
})

test('IDLE-PARK — a PARKED_EXIT_CODE exit marks parked → disconnected+restorable (crash-shaped, tab kept); a non-park exit stays crashed', async () => {
  const h = makeHost()

  // Session P: parks (self-exit with PARKED_EXIT_CODE; the tombstone stays).
  const parked = await h.host.createSession({ cwd: h.cwd })
  expect(parked.ok).toBe(true)
  if (!parked.ok) return
  const parkedId = parked.value.appSessionId
  h.supervisor.emitReady(parkedId, 'engine-parked')
  await settle(() => h.registry.findSession(parkedId)?.engineSessionId === 'engine-parked')
  writeTranscript(h.storageDir, 'engine-parked')

  // Capture the LIVE descriptor before parking (status ready, not restorable) —
  // it grants a tab in the renderer's shell reducer.
  const liveDescriptor = h.host.listSessions().find(s => s.appSessionId === parkedId)
  expect(liveDescriptor?.status).toBe('ready')
  expect(liveDescriptor?.restorable).toBe(false)
  expect(liveDescriptor?.parked).toBe(false)

  h.events.length = 0
  h.supervisor.emitPark(parkedId)
  await settle(() => h.registry.findSession(parkedId)?.shutdown === 'parked')

  // Classified as PARKED, not crashed — but byte-identical descriptor to a crash.
  expect(h.registry.findSession(parkedId)?.shutdown).toBe('parked')
  const parkedDescriptor = h.host.listSessions().find(s => s.appSessionId === parkedId)
  expect(parkedDescriptor?.status).toBe('disconnected')
  expect(parkedDescriptor?.restorable).toBe(true)
  // §1b — the ONE bit that separates this from a crash, and the reason four
  // descriptor-derived surfaces stopped calling an intentional reclaim
  // `crashed`. Everything else about the descriptor stays byte-identical.
  expect(parkedDescriptor?.parked).toBe(true)

  // The live gate: an unpark spawns BEFORE `upsertOnSpawn` clears the row's
  // `shutdown` mark (`registry.ts` sets it to null only inside that upsert), so
  // for that window a live child coexists with a `'parked'` row. Reading the
  // mark alone would paint a booting engine as resting and swallow `starting`.
  h.supervisor.emitReady(parkedId, 'engine-parked')
  const respawning = h.host.listSessions().find(s => s.appSessionId === parkedId)
  expect(h.registry.findSession(parkedId)?.shutdown).toBe('parked')
  expect(respawning?.status).toBe('ready')
  expect(respawning?.parked).toBe(false)
  h.supervisor.emitPark(parkedId)
  await settle(() => h.registry.findSession(parkedId)?.shutdown === 'parked')
  const statusEvent = h.events.find(e => e.type === 'session-status')
  expect(statusEvent).toBeDefined()
  if (statusEvent?.type === 'session-status') {
    expect(statusEvent.session.status).toBe('disconnected')
    expect(statusEvent.session.restorable).toBe(true)
  }
  // Tombstone kept: restart/restore-in-place stays host-accepted.
  expect(h.supervisor.records.has(parkedId)).toBe(true)

  // Tab-kept (the CRASH branch of foldTabMembership): fold the real live-then-
  // parked descriptors through the renderer's public shell reducer and assert
  // the tab survives the park — the zero-visual-change guarantee (§1).
  let shell = createShellState()
  shell = reduceShellState(shell, { type: 'session-added', session: liveDescriptor! })
  expect(shell.tabs[parkedId]).toBe(true)
  shell = reduceShellState(shell, { type: 'session-status', session: parkedDescriptor! })
  expect(shell.tabs[parkedId]).toBe(true)

  // Contrast — a non-park exit (any other code) is still a CRASH, unchanged.
  const crashed = await h.host.createSession({ cwd: h.cwd })
  expect(crashed.ok).toBe(true)
  if (!crashed.ok) return
  const crashedId = crashed.value.appSessionId
  h.supervisor.emitReady(crashedId, 'engine-nonpark')
  await settle(() => h.registry.findSession(crashedId)?.engineSessionId === 'engine-nonpark')
  writeTranscript(h.storageDir, 'engine-nonpark')
  h.supervisor.emitCrash(crashedId)
  await settle(() => h.registry.findSession(crashedId)?.shutdown === 'crashed')
  expect(h.registry.findSession(crashedId)?.shutdown).toBe('crashed')
})

test('restoreSession restores a crashed session whose tombstone record is still registered', async () => {
  const h = makeHost()
  const created = await h.host.createSession({ cwd: h.cwd })
  expect(created.ok).toBe(true)
  if (!created.ok) return
  const { appSessionId } = created.value
  h.supervisor.emitReady(appSessionId, 'engine-resume-crash')
  await settle(() => h.registry.findSession(appSessionId)?.engineSessionId === 'engine-resume-crash')
  writeTranscript(h.storageDir, 'engine-resume-crash')

  h.supervisor.emitCrash(appSessionId)
  await settle(() => h.registry.findSession(appSessionId)?.shutdown === 'crashed')

  // Restore must deregister the tombstone and re-spawn with the resume id —
  // pre-fix this failed as "already live" off the dead record.
  const result = await h.host.restoreSession(appSessionId)
  expect(result.ok).toBe(true)
  if (!result.ok) return
  expect(result.value.appSessionId).toBe(appSessionId)
  const spawned = h.supervisor.records.get(appSessionId)
  expect(spawned?.status).toBe('spawning')
  expect(spawned?.resumeEngineSessionId).toBe('engine-resume-crash')
  // Row flipped back to live — the deregistering kill was NOT re-reported as a
  // fresh crash over the new spawn.
  expect(h.registry.findSession(appSessionId)?.shutdown).toBeNull()
})

/* ------------------------------------------------------------------------- *
 * listSessions — live ∪ restorable
 * ------------------------------------------------------------------------- */

test('listSessions returns live ∪ restorable with live status winning', async () => {
  const h = makeHost()
  // A restorable-only row.
  const restorableId = randomUUID()
  writeTranscript(h.storageDir, 'engine-rest')
  await h.registry.upsertOnSpawn({ appSessionId: restorableId, cwd: h.cwd })
  await h.registry.fillEngineSessionId(restorableId, 'engine-rest')
  await h.registry.markClean(restorableId)

  // A live one.
  const created = await h.host.createSession({ cwd: h.cwd })
  expect(created.ok).toBe(true)
  if (!created.ok) return
  h.supervisor.emitReady(created.value.appSessionId, 'engine-live2')
  await settle(
    () => h.registry.findSession(created.value.appSessionId)?.engineSessionId === 'engine-live2',
  )

  const list = h.host.listSessions()
  const ids = list.map(s => s.appSessionId).sort()
  expect(ids).toContain(restorableId)
  expect(ids).toContain(created.value.appSessionId)

  const liveDescriptor = list.find(s => s.appSessionId === created.value.appSessionId)
  expect(liveDescriptor?.status).toBe('ready')
  const restDescriptor = list.find(s => s.appSessionId === restorableId)
  expect(restDescriptor?.status).toBe('exited')
  expect(restDescriptor?.restorable).toBe(true)
})

test('a terminal tombstone whose registry row was reaped is not listed (no empty-id ghost)', () => {
  // Reachable shape: a crashed session's terminal row is bound-reaped
  // (enforceBound) while its supervisor tombstone lingers. descriptorFor must
  // return undefined for it — pre-fix it minted a ghost descriptor with
  // appSessionId '' via descriptorFromRow(undefined, live.status) (SF7).
  const h = makeHost()
  h.supervisor.records.set('tombstone-no-row', {
    sessionId: 'tombstone-no-row',
    status: 'exited',
    pid: 999,
    socketPath: '/tmp/fake/tomb.sock',
    cwd: h.cwd,
  })
  const list = h.host.listSessions()
  expect(list.some(s => s.appSessionId === '')).toBe(false)
  expect(list.some(s => s.appSessionId === 'tombstone-no-row')).toBe(false)
})

/* ------------------------------------------------------------------------- *
 * HostEvent stream — status / exit / add / remove
 * ------------------------------------------------------------------------- */

test('HostEvent stream fires on add, status, exit', async () => {
  const h = makeHost()
  const created = await h.host.createSession({ cwd: h.cwd })
  expect(created.ok).toBe(true)
  if (!created.ok) return
  const { appSessionId } = created.value

  const types = () => h.events.map(e => e.type)
  expect(types()).toContain('session-added')

  h.events.length = 0
  h.supervisor.setStatus(appSessionId, 'disconnected')
  await settle(() => types().includes('session-status'))
  expect(types()).toContain('session-status')

  h.events.length = 0
  // A sidecar death the host did not ask for (crash) still emits a status
  // event. Driven via emitCrash so the fake's record state matches the real
  // supervisor (record kept, terminal status) — a raw exit with the record
  // left 'ready' is a state the real supervisor cannot produce (HA-6).
  h.supervisor.emitCrash(appSessionId)
  await settle(() => types().includes('session-status'))
  expect(types()).toContain('session-status')
})

/* ------------------------------------------------------------------------- *
 * registry_unavailable — write failure degrades persistence, never kills the
 * session.
 * ------------------------------------------------------------------------- */

test('registry_unavailable: a failing registry write does not kill the session', async () => {
  const storageDir = tempDir()
  const cwd = join(storageDir, 'proj')
  mkdirSync(cwd, { recursive: true })
  const logs: string[] = []
  // A registry whose lock acquire always rejects → every persist fails (swallowed).
  const registry = new SessionRegistry({
    storageDir,
    log: line => logs.push(line),
    acquireLock: async () => {
      throw new Error('lock held')
    },
  })
  const supervisor = new FakeSupervisor()
  const events: HostEvent[] = []
  const host = new Host({
    supervisor: supervisor as never,
    registry,
    validateCwd: (c: string) => (c === cwd ? { ok: true, realpath: c } : { ok: false }),
    log: line => logs.push(line),
  })
  host.subscribe(e => events.push(e))

  const result = await host.createSession({ cwd })
  // Session still spawned (persistence degraded, not fatal).
  expect(result.ok).toBe(true)
  expect(supervisor.records.size).toBe(1)
  expect(registry.lastWriteFailed).toBe(true)
  // The degradation is observable (the host surfaced registry_unavailable).
  expect(logs.some(l => l.includes('registry_unavailable'))).toBe(true)
})

test('setPeerWakeBlocked reports a failed write instead of claiming the block was saved', async () => {
  // The counterpart to the test above, and the reason both exist. There the
  // degrade-not-die posture is right: the session spawned, it works, and the
  // caller has a live tab whatever the file did. Here there is no liveness to
  // protect and durability is the whole promise ("survives close, park, restore
  // and relaunch"), so an ok result meant the user set the block, saw the menu
  // agree, and found it gone at the next launch.
  //
  // The write fails for real: no stubbed writer, no injected lock. The document
  // on disk is replaced by a directory at the same path, so the merge read
  // inside `persist()` throws EISDIR — one of the five failures `persist()`
  // swallows, and the one a stub would be least likely to imitate.
  const h = makeHost()
  const created = await h.host.createSession({ cwd: h.cwd })
  if (!created.ok) throw new Error(`create failed: ${created.error.code}`)
  const { appSessionId } = created.value
  await settle(() => existsSync(h.registry.filePath))

  const lastPersisted = JSON.parse(readFileSync(h.registry.filePath, 'utf8')) as {
    sessions: { appSessionId: string; peerWakeBlocked?: boolean }[]
  }
  expect(lastPersisted.sessions.some(r => r.peerWakeBlocked === true)).toBe(false)

  rmSync(h.registry.filePath)
  mkdirSync(h.registry.filePath)

  h.events.length = 0
  const blocked = await h.host.setPeerWakeBlocked(appSessionId, true)

  expect(blocked.ok).toBe(false)
  if (blocked.ok) return
  expect(blocked.error.code).toBe('registry_unavailable')
  expect(h.registry.lastWriteFailed).toBe(true)

  // Narrowed, not inverted: the block IS in force for this run, and the menu is
  // told so. Rolling the row back on a write failure would leave the control
  // doing nothing at all, which is worse than losing it at the next launch.
  expect(h.registry.findSession(appSessionId)?.peerWakeBlocked).toBe(true)
  const published = h.events
    .filter(e => e.type === 'session-status')
    .map(e => (e as { session: { appSessionId: string; peerWakeBlocked?: boolean } }).session)
    .filter(session => session.appSessionId === appSessionId)
  expect(published.at(-1)?.peerWakeBlocked).toBe(true)
})

/* ------------------------------------------------------------------------- *
 * closeSession on a restorable-only (not live) row still succeeds
 * ------------------------------------------------------------------------- */

test('closeSession on a known restorable-only row succeeds without a live process', async () => {
  const h = makeHost()
  const appSessionId = randomUUID()
  writeTranscript(h.storageDir, 'engine-idle')
  await h.registry.upsertOnSpawn({ appSessionId, cwd: h.cwd })
  await h.registry.fillEngineSessionId(appSessionId, 'engine-idle')
  await h.registry.markClean(appSessionId)

  const result = await h.host.closeSession(appSessionId)
  expect(result.ok).toBe(true)
  expect(h.registry.findSession(appSessionId)?.shutdown).toBe('clean')
})

/* ------------------------------------------------------------------------- *
 * SF6 — restoreSession re-checks transcript existence AT restore time
 * ------------------------------------------------------------------------- */

test('restoreSession fails session_not_found when the transcript vanished after launch', async () => {
  const h = makeHost()
  const appSessionId = randomUUID()
  // A clean, restorable row — but NO transcript on disk (pruned since launch).
  await h.registry.upsertOnSpawn({ appSessionId, cwd: h.cwd })
  await h.registry.fillEngineSessionId(appSessionId, 'engine-pruned')
  await h.registry.markClean(appSessionId)
  // Deliberately do NOT writeTranscript('engine-pruned').

  const result = await h.host.restoreSession(appSessionId)
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.error.code).toBe('session_not_found')
  // Nothing spawned — we never offer a restore we cannot perform.
  expect(h.supervisor.records.has(appSessionId)).toBe(false)
})

/* ------------------------------------------------------------------------- *
 * §9-A4 at READ time — a row that acquired its `engineSessionId` DURING THIS RUN
 * but never materialized a transcript.
 *
 * The two-id bridge stamps `engineSessionId` from the ready frame, i.e. at
 * SPAWN, while the engine writes the `.jsonl` only on the first user/assistant
 * message (`src/utils/sessionStorage.ts` materializeSessionFile). Every session
 * opened and never typed in is therefore a row with a non-null `engineSessionId`
 * pointing at a file that does not exist. The launch reap drops those, but it
 * only runs BETWEEN launches — so for the rest of the run the row was advertised
 * as restorable and the sidecar died `resume-failed` on click.
 * ------------------------------------------------------------------------- */

test('a session opened and never typed in is never offered as restorable: no union entry, no preview, no tab, no restore', async () => {
  const h = makeHost()
  const created = await h.host.createSession({ cwd: h.cwd })
  expect(created.ok).toBe(true)
  if (!created.ok) return
  const { appSessionId } = created.value
  // Ready stamps the transcript key at spawn…
  h.supervisor.emitReady(appSessionId, 'engine-never-typed')
  await settle(
    () =>
      h.registry.findSession(appSessionId)?.engineSessionId === 'engine-never-typed' &&
      h.events.some(e => e.type === 'session-status'),
  )
  // …and deliberately NO writeTranscript: no turn ever ran.
  expect(h.registry.findSession(appSessionId)?.engineSessionId).toBe('engine-never-typed')

  const liveDescriptor = h.host.listSessions().find(s => s.appSessionId === appSessionId)
  expect(liveDescriptor?.status).toBe('ready')

  h.events.length = 0
  const closed = await h.host.closeSession(appSessionId)
  expect(closed.ok).toBe(true)

  // Gone from the live ∪ restorable union — it is neither.
  expect(h.host.listSessions().some(s => s.appSessionId === appSessionId)).toBe(false)
  // Not previewable: main must not read an at-rest transcript cache for an id
  // the host cannot vouch for (the IS-A boundary).
  expect(h.host.canPreview(appSessionId)).toBe(false)
  // The stream reports it REMOVED. A `session-status` would be actively wrong
  // here: `restorable === false` is how the renderer recognises a tab.
  expect(h.events.map(e => e.type)).toContain('session-removed')
  expect(h.events.some(e => e.type === 'session-status')).toBe(false)

  // Renderer projection through the real shell reducer: the tab it had while
  // live is released and no roster row survives to be clicked.
  let shell = createShellState()
  shell = reduceShellState(shell, { type: 'session-added', session: liveDescriptor! })
  expect(shell.tabs[appSessionId]).toBe(true)
  for (const event of h.events) shell = reduceShellState(shell, event)
  expect(shell.tabs[appSessionId]).toBeUndefined()
  expect(shell.byId[appSessionId]).toBeUndefined()

  // And the restore it would have offered is refused — it was never performable.
  const restored = await h.host.restoreSession(appSessionId)
  expect(restored.ok).toBe(false)
  if (!restored.ok) expect(restored.error.code).toBe('session_not_found')

  // CONTRAST — the SAME row once a turn materializes its transcript is a real
  // offer again. The verdict tracks the transcript, nothing else.
  writeTranscript(h.storageDir, 'engine-never-typed')
  const offered = h.host.listSessions().find(s => s.appSessionId === appSessionId)
  expect(offered?.restorable).toBe(true)
  expect(h.host.canPreview(appSessionId)).toBe(true)
})

test('restartSession refuses to resume an engineSessionId with no transcript (the asymmetry with restoreSession is closed)', async () => {
  const h = makeHost()
  const created = await h.host.createSession({ cwd: h.cwd })
  expect(created.ok).toBe(true)
  if (!created.ok) return
  const { appSessionId } = created.value
  h.supervisor.emitReady(appSessionId, 'engine-no-file')
  await settle(
    () => h.registry.findSession(appSessionId)?.engineSessionId === 'engine-no-file',
  )
  // No transcript — a session opened and never typed in.
  const pidBefore = h.supervisor.getSessionProcessId(appSessionId)
  const restartsBefore = h.registry.findSession(appSessionId)?.restartCount
  h.evicted.length = 0

  const refused = await h.host.restartSession(appSessionId)
  expect(refused.ok).toBe(false)
  if (!refused.ok) expect(refused.error.code).toBe('session_not_found')
  // Nothing was restarted: no fresh child, no replay eviction, and crucially no
  // `restartCount` bump — the live registry showed restartCount 2 from exactly
  // this retry loop, one bump per failed resume.
  expect(h.supervisor.getSessionProcessId(appSessionId)).toBe(pidBefore)
  expect(h.registry.findSession(appSessionId)?.restartCount).toBe(restartsBefore)
  expect(h.evicted).not.toContain(appSessionId)

  // With a transcript the same restart succeeds and carries the resume id.
  writeTranscript(h.storageDir, 'engine-no-file')
  const accepted = await h.host.restartSession(appSessionId)
  expect(accepted.ok).toBe(true)
  expect(h.supervisor.records.get(appSessionId)?.resumeEngineSessionId).toBe(
    'engine-no-file',
  )
})

test('a RESUME_FAILED_EXIT_CODE exit retires an id whose transcript FILE exists but carries no loadable conversation; an ordinary crash does not', async () => {
  const h = makeHost()
  const created = await h.host.createSession({ cwd: h.cwd })
  expect(created.ok).toBe(true)
  if (!created.ok) return
  const { appSessionId } = created.value
  h.supervisor.emitReady(appSessionId, 'engine-unloadable')
  await settle(
    () => h.registry.findSession(appSessionId)?.engineSessionId === 'engine-unloadable',
  )
  // The file EXISTS — this is the engine's "no conversation found" case, which
  // `existsSync` structurally cannot see. Only the exit code reports it.
  writeTranscript(h.storageDir, 'engine-unloadable')

  h.supervisor.emitResumeFailed(appSessionId)
  await settle(() => h.registry.findSession(appSessionId)?.shutdown === 'crashed')

  // The row is still crash-marked on disk (the process did die unasked) …
  expect(h.registry.findSession(appSessionId)?.shutdown).toBe('crashed')
  // … but it is no longer advertised, and neither spawn path will retry it.
  expect(
    h.host.listSessions().find(s => s.appSessionId === appSessionId)?.restorable,
  ).toBe(false)
  expect(h.host.canPreview(appSessionId)).toBe(false)
  const rejectedRestart = await h.host.restartSession(appSessionId)
  expect(rejectedRestart.ok).toBe(false)

  // CONTRAST — an ordinary crash with the same transcript on disk stays a real
  // restore offer. The verdict is the exit CODE, not the death.
  const other = await h.host.createSession({ cwd: h.cwd })
  expect(other.ok).toBe(true)
  if (!other.ok) return
  const otherId = other.value.appSessionId
  h.supervisor.emitReady(otherId, 'engine-plain-crash')
  await settle(() => h.registry.findSession(otherId)?.engineSessionId === 'engine-plain-crash')
  writeTranscript(h.storageDir, 'engine-plain-crash')
  h.supervisor.emitCrash(otherId)
  await settle(() => h.registry.findSession(otherId)?.shutdown === 'crashed')
  expect(h.host.listSessions().find(s => s.appSessionId === otherId)?.restorable).toBe(true)

  // The verdict holds for the rest of the run: an explicit restore of the retired
  // id is refused too, so nothing can re-arm the retry loop, and no sidecar is
  // spawned to fail again.
  const restored = await h.host.restoreSession(appSessionId)
  expect(restored.ok).toBe(false)
  if (!restored.ok) expect(restored.error.code).toBe('session_not_found')
  expect(h.supervisor.records.get(appSessionId)?.status).toBe('exited')
})

test('a busy resume exit is clean and remains a retryable restore offer', async () => {
  const h = makeHost()
  const created = await h.host.createSession({ cwd: h.cwd })
  expect(created.ok).toBe(true)
  if (!created.ok) return
  const { appSessionId } = created.value
  h.supervisor.emitReady(appSessionId, 'engine-busy')
  await settle(
    () => h.registry.findSession(appSessionId)?.engineSessionId === 'engine-busy',
  )
  writeTranscript(h.storageDir, 'engine-busy')

  h.supervisor.emitResumeBusy(appSessionId)
  await settle(
    () =>
      h.registry.findSession(appSessionId)?.shutdown === 'clean' &&
      h.logs.some(line => line.includes('resume_busy')),
  )

  expect(h.registry.findSession(appSessionId)?.shutdown).toBe('clean')
  expect(
    h.host.listSessions().find(s => s.appSessionId === appSessionId)?.restorable,
  ).toBe(true)
  expect(h.logs.some(line => line.includes('resume_busy'))).toBe(true)
  // `canResume` consults the private resume-failed verdict set. Remaining true
  // proves a busy refusal did not permanently retire the transcript.
  expect(h.host.canResume(appSessionId)).toBe(true)
  expect(h.host.canPreview(appSessionId)).toBe(true)
  expect((await h.host.restoreSession(appSessionId)).ok).toBe(true)
})

/* ------------------------------------------------------------------------- *
 * SF7 — listSessions excludes rows that are neither live nor restorable
 * ------------------------------------------------------------------------- */

test('listSessions omits a clean row that never acquired an engineSessionId', async () => {
  const h = makeHost()
  // A spawn that failed before any ready frame: the pre-written row is marked
  // clean with engineSessionId still null.
  h.supervisor.throwOnNextSpawn = new Error('boom')
  const failed = await h.host.createSession({ cwd: h.cwd })
  expect(failed.ok).toBe(false)

  // The failed row is clean + null-engineSessionId → NOT a tab, NOT restorable.
  const list = h.host.listSessions()
  expect(list.length).toBe(0)
})

/* ------------------------------------------------------------------------- *
 * SF5 — restartSession refreshes the registry advisory fields (pid/socketPath)
 * ------------------------------------------------------------------------- */

test('restartSession refreshes the row pid + socketPath from the fresh child', async () => {
  const h = makeHost()
  const created = await h.host.createSession({ cwd: h.cwd })
  expect(created.ok).toBe(true)
  if (!created.ok) return
  const { appSessionId } = created.value
  const oldPid = h.registry.findSession(appSessionId)?.enginePid
  const oldSock = h.registry.findSession(appSessionId)?.socketPath
  h.evicted.length = 0

  const result = await h.host.restartSession(appSessionId)
  expect(result.ok).toBe(true)

  const row = h.registry.findSession(appSessionId)
  // Advisory fields now match the FRESH child, not the dead one.
  expect(row?.enginePid).toBe(h.supervisor.getSessionProcessId(appSessionId))
  expect(row?.socketPath).toBe(h.supervisor.getSessionSocketPath(appSessionId))
  expect(row?.enginePid).not.toBe(oldPid)
  expect(row?.socketPath).not.toBe(oldSock)
  // Replay evicted around the restart (P3-0 carry preserved).
  expect(h.evicted).toContain(appSessionId)
})

test('restartSession resumes the current engineSessionId instead of minting blank context', async () => {
  const h = makeHost()
  const created = await h.host.createSession({ cwd: h.cwd })
  expect(created.ok).toBe(true)
  if (!created.ok) return
  const { appSessionId } = created.value
  h.supervisor.emitReady(appSessionId, 'engine-restart-context')
  await settle(
    () =>
      h.registry.findSession(appSessionId)?.engineSessionId ===
      'engine-restart-context',
  )
  writeTranscript(h.storageDir, 'engine-restart-context')

  const result = await h.host.restartSession(appSessionId)
  expect(result.ok).toBe(true)

  expect(h.supervisor.records.get(appSessionId)?.resumeEngineSessionId).toBe(
    'engine-restart-context',
  )
  expect(h.registry.findSession(appSessionId)?.engineSessionId).toBe(
    'engine-restart-context',
  )
})

test('restartSession rejects an unknown/non-live id (session_not_found)', async () => {
  const h = makeHost()
  const result = await h.host.restartSession(randomUUID())
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.error.code).toBe('session_not_found')
})

test('restartSession refuses a row whose cwd no longer exists, leaving the live sidecar untouched (invalid_cwd)', async () => {
  // The supervisor KILLS the child before it respawns (`supervisor.ts` restartSession),
  // and a dead cwd only surfaces on the fresh child's async error handler as
  // `failed`. So without the same HC1 re-check `restoreSession` performs, moving
  // a live session's directory turns a Restart click into a destroyed sidecar.
  let workspaceExists = true
  const h = makeHost({
    validateCwd: (c: string): CwdValidation =>
      workspaceExists ? { ok: true, realpath: c } : { ok: false },
  })
  const created = await h.host.createSession({ cwd: h.cwd })
  expect(created.ok).toBe(true)
  if (!created.ok) return
  const { appSessionId } = created.value
  const pidBefore = h.supervisor.getSessionProcessId(appSessionId)
  const sockBefore = h.supervisor.getSessionSocketPath(appSessionId)
  const restartsBefore = h.registry.findSession(appSessionId)?.restartCount
  h.evicted.length = 0

  // The directory is moved/deleted while the session is live.
  workspaceExists = false
  const refused = await h.host.restartSession(appSessionId)
  expect(refused.ok).toBe(false)
  if (!refused.ok) expect(refused.error.code).toBe('invalid_cwd')

  // The live child is untouched: no restart (same pid + socketPath), no replay
  // eviction, no restartCount bump.
  expect(h.supervisor.getSessionProcessId(appSessionId)).toBe(pidBefore)
  expect(h.supervisor.getSessionSocketPath(appSessionId)).toBe(sockBefore)
  expect(h.evicted).not.toContain(appSessionId)
  expect(h.registry.findSession(appSessionId)?.restartCount).toBe(restartsBefore)

  // With the directory back, the same restart succeeds.
  workspaceExists = true
  const accepted = await h.host.restartSession(appSessionId)
  expect(accepted.ok).toBe(true)
  expect(h.supervisor.getSessionProcessId(appSessionId)).not.toBe(pidBefore)
})

/* ------------------------------------------------------------------------- *
 * #15 — createSessionInWorkspace: the per-workspace "+" spawns a FRESH session
 * in an existing workspace named by a REGISTRY id. HC1 BOUNDARY: the renderer
 * names an id, never a path; the host re-derives + re-validates the cwd from its
 * OWN registry row and spawns with NO resume.
 * ------------------------------------------------------------------------- */

test('createSessionInWorkspace ACCEPTS a known registry id: fresh session in the row cwd, no resume', async () => {
  const h = makeHost()
  // Seed a workspace: a registry row rooted at h.cwd (the "representative" the
  // renderer would name from the group's active/first row).
  const repId = randomUUID()
  await h.registry.upsertOnSpawn({
    appSessionId: repId,
    cwd: h.cwd,
    forked: true,
  })

  const result = await h.host.createSessionInWorkspace(repId)
  expect(result.ok).toBe(true)
  if (!result.ok) return

  // A FRESH session: a NEW appSessionId (not the named one), rooted at the row's
  // host-validated cwd, spawned with NO resume (blank engine context).
  expect(result.value.appSessionId).not.toBe(repId)
  expect(result.value.cwd).toBe(h.cwd)
  expect(result.value.engineSessionId).toBeNull()
  expect(result.value.forked).toBe(false)
  const spawned = h.supervisor.records.get(result.value.appSessionId)
  expect(spawned?.cwd).toBe(h.cwd)
  expect(spawned?.resumeEngineSessionId).toBeUndefined()
  expect(
    h.events.some(
      e =>
        e.type === 'session-added' &&
        e.session.appSessionId === result.value.appSessionId,
    ),
  ).toBe(true)
})

test('createSessionInWorkspace RE-DERIVES the cwd from validateCwd, not the stored row string (HC1)', async () => {
  // A host whose validateCwd canonicalizes the row cwd to a DIFFERENT realpath
  // (symlink skew): the spawn must use the re-derived realpath, proving the host
  // never trusts the raw stored value.
  const storageDir = tempDir()
  const rowCwd = join(storageDir, 'link')
  const realCwd = join(storageDir, 'real')
  mkdirSync(realCwd, { recursive: true })
  const logs: string[] = []
  const registry = new SessionRegistry({
    storageDir,
    log: line => logs.push(line),
    transcriptPathFor: (_cwd, engineSessionId) =>
      join(storageDir, 'transcripts', `${engineSessionId}.jsonl`),
  })
  const supervisor = new FakeSupervisor()
  const host = new Host({
    supervisor: supervisor as never,
    registry,
    validateCwd: (c: string): CwdValidation =>
      c === rowCwd ? { ok: true, realpath: realCwd } : { ok: false },
    log: line => logs.push(line),
  })
  const repId = randomUUID()
  await registry.upsertOnSpawn({ appSessionId: repId, cwd: rowCwd })

  const result = await host.createSessionInWorkspace(repId)
  expect(result.ok).toBe(true)
  if (!result.ok) return
  // The re-derived realpath — never the raw row string — is what got spawned.
  expect(result.value.cwd).toBe(realCwd)
  expect(supervisor.records.get(result.value.appSessionId)?.cwd).toBe(realCwd)
})

test('createSessionInWorkspace REJECTS a renderer-supplied raw path (session_not_found, nothing spawned)', async () => {
  const h = makeHost()
  // The argument is typed `SessionId` (a string id) — the renderer is
  // structurally unable to pass a cwd object. Even a raw filesystem-path string
  // smuggled across the boundary is not a UUID, so it is rejected before any
  // lookup: the renderer can NEVER author a cwd through this method.
  const before = h.supervisor.records.size
  const rawPath = '/etc' as SessionId
  const result = await h.host.createSessionInWorkspace(rawPath)
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.error.code).toBe('session_not_found')
  // No session spawned, and the path never became a cwd anywhere.
  expect(h.supervisor.records.size).toBe(before)
  expect(
    [...h.supervisor.records.values()].some(r => r.cwd === '/etc'),
  ).toBe(false)
})

test('createSessionInWorkspace REJECTS a well-formed id absent from the registry (session_not_found)', async () => {
  const h = makeHost()
  // A syntactically valid UUID that names no registry row — the renderer cannot
  // conjure a workspace the host does not already own.
  const result = await h.host.createSessionInWorkspace(randomUUID())
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.error.code).toBe('session_not_found')
  expect(h.supervisor.records.size).toBe(0)
})

test('createSessionInWorkspace RE-VALIDATES a stale row cwd and refuses (invalid_cwd, nothing spawned)', async () => {
  // A row whose directory was moved/deleted since it was written: validateCwd now
  // rejects it. The host must not spawn into a stale cwd (HC1 defense in depth).
  const h = makeHost({ validateCwd: () => ({ ok: false }) })
  const repId = randomUUID()
  await h.registry.upsertOnSpawn({ appSessionId: repId, cwd: h.cwd })

  const result = await h.host.createSessionInWorkspace(repId)
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.error.code).toBe('invalid_cwd')
  expect(h.supervisor.records.size).toBe(0)
})

test('createSessionInWorkspace REJECTS a non-string payload coerced by main to a non-UUID (session_not_found, nothing spawned)', async () => {
  const h = makeHost()
  // main's IPC handler coerces the renderer arg with `String(appSessionId)`
  // (main.ts:1057) before it reaches the host. A non-string / object / array /
  // null payload stringifies to a non-UUID, so the host rejects it at the
  // id-shape gate (HC2) before any registry lookup — nothing is ever spawned.
  const payloads: unknown[] = [null, undefined, 123, true, {}, ['a', 'b'], []]
  for (const payload of payloads) {
    const coerced = String(payload) as SessionId
    const result = await h.host.createSessionInWorkspace(coerced)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('session_not_found')
  }
  expect(h.supervisor.records.size).toBe(0)
})

test('createSessionInWorkspace is subject to the HC4 spawn cap (refuses past the rate limit → session_limit)', async () => {
  const h = makeHost()
  // A representative workspace row the per-workspace "+" names.
  const repId = randomUUID()
  await h.registry.upsertOnSpawn({ appSessionId: repId, cwd: h.cwd })

  // Fill the spawn-rate window: each "+" mints a FRESH session in that workspace.
  for (let i = 0; i < MAX_SPAWNS_PER_WINDOW; i++) {
    const r = await h.host.createSessionInWorkspace(repId)
    expect(r.ok).toBe(true)
  }
  // The next "+" is refused by checkSpawnLimits, exactly like createSession.
  const overflow = await h.host.createSessionInWorkspace(repId)
  expect(overflow.ok).toBe(false)
  if (!overflow.ok) expect(overflow.error.code).toBe('session_limit')

  // Advancing past the window frees the cap again (same checkSpawnLimits path).
  h.setNow(h.now() + SPAWN_RATE_WINDOW_MS + 1)
  const next = await h.host.createSessionInWorkspace(repId)
  expect(next.ok).toBe(true)
})

/* ------------------------------------------------------------------------- *
 * B3 — shutdownAll marks every live row CLEAN (die-with-window ≠ crash)
 * ------------------------------------------------------------------------- */

test('shutdownAll marks live rows clean and kills the sidecars', async () => {
  const h = makeHost()
  const a = await h.host.createSession({ cwd: h.cwd })
  const b = await h.host.createSession({ cwd: h.cwd })
  expect(a.ok && b.ok).toBe(true)
  if (!a.ok || !b.ok) return

  // Both rows are live (shutdown: null) before the quit.
  expect(h.registry.findSession(a.value.appSessionId)?.shutdown).toBeNull()
  expect(h.registry.findSession(b.value.appSessionId)?.shutdown).toBeNull()

  h.host.shutdownAll()

  // A clean quit leaves BOTH rows marked clean — not left null (which the next
  // launch's orphan sweep would report as crashed).
  expect(h.registry.findSession(a.value.appSessionId)?.shutdown).toBe('clean')
  expect(h.registry.findSession(b.value.appSessionId)?.shutdown).toBe('clean')
  // Sidecars gone; replay evicted.
  expect(h.supervisor.records.size).toBe(0)
  expect(h.evicted).toContain(a.value.appSessionId)
  expect(h.evicted).toContain(b.value.appSessionId)
})

/* ------------------------------------------------------------------------- *
 * B4 — host ops await the registry launch sweep before touching the registry
 * ------------------------------------------------------------------------- */

test('createSession awaits the launch gate before spawning (no interleave)', async () => {
  const storageDir = tempDir()
  const cwd = join(storageDir, 'proj')
  mkdirSync(cwd, { recursive: true })
  const registry = new SessionRegistry({
    storageDir,
    transcriptPathFor: (_c, e) => join(storageDir, 'transcripts', `${e}.jsonl`),
  })
  const supervisor = new FakeSupervisor()

  // A launch gate that resolves only when we release it.
  let releaseLaunch = () => {}
  const launched = new Promise<void>(resolve => {
    releaseLaunch = resolve
  })
  let launchDone = false
  const gated = launched.then(() => {
    launchDone = true
  })

  const host = new Host({
    supervisor: supervisor as never,
    registry,
    validateCwd: (c: string) => (c === cwd ? { ok: true, realpath: c } : { ok: false }),
    launched: gated,
  })

  // Fire a create BEFORE the gate resolves.
  const pending = host.createSession({ cwd })
  // Give the microtask queue a few turns — the spawn must NOT have happened yet.
  await new Promise(r => setTimeout(r, 10))
  expect(launchDone).toBe(false)
  expect(supervisor.records.size).toBe(0)

  // Release the gate; now the create proceeds.
  releaseLaunch()
  const result = await pending
  expect(launchDone).toBe(true)
  expect(result.ok).toBe(true)
  expect(supervisor.records.size).toBe(1)

  rmSync(storageDir, { recursive: true, force: true })
})

/* ------------------------------------------------------------------------- *
 * Host-plane review LOW fixes (2026-07-05): F3 crash labeling · F4 single
 * restartCount bump · F5 session-removed on runtime reaps
 * ------------------------------------------------------------------------- */

test('F3: a mid-run sidecar crash marks the row crashed, and a later quit does NOT relabel it clean', async () => {
  const h = makeHost()
  const created = await h.host.createSession({ cwd: h.cwd })
  if (!created.ok) throw new Error('create failed')
  const id = created.value.appSessionId
  h.supervisor.emitReady(id, 'engine-crash-test')
  await settle(() => h.registry.findSession(id)?.engineSessionId === 'engine-crash-test')

  // Crash: the child exits without the host asking. emitCrash keeps the
  // record with a terminal status, matching the real supervisor's un-killed
  // death path (HA-6 — a raw exit left the record 'ready', an unreal state).
  h.supervisor.emitCrash(id)
  await settle(() => h.registry.findSession(id)?.shutdown === 'crashed')
  expect(h.registry.findSession(id)?.shutdown).toBe('crashed')
  expect(h.registry.findSession(id)?.enginePid).toBe(10001)

  // Quit after the crash: markLiveCleanSync must not relabel the crash.
  h.host.shutdownAll()
  expect(h.registry.findSession(id)?.shutdown).toBe('crashed')
  // The row kept its engineSessionId — still restorable, honestly flagged.
  expect(h.registry.findSession(id)?.engineSessionId).toBe('engine-crash-test')
})

test('IDLE-PARK — an ordinary quit marks PARKED rows clean, so the next launch does not read them as crashed', async () => {
  const h = makeHost()

  // Session P parks (the host reclaimed its engine); session C genuinely crashes.
  const parked = await h.host.createSession({ cwd: h.cwd })
  const crashed = await h.host.createSession({ cwd: h.cwd })
  if (!parked.ok || !crashed.ok) throw new Error('create failed')
  const parkedId = parked.value.appSessionId
  const crashedId = crashed.value.appSessionId
  h.supervisor.emitReady(parkedId, 'engine-parked-quit')
  h.supervisor.emitReady(crashedId, 'engine-crashed-quit')
  await settle(() => h.registry.findSession(crashedId)?.engineSessionId === 'engine-crashed-quit')
  writeTranscript(h.storageDir, 'engine-parked-quit')
  writeTranscript(h.storageDir, 'engine-crashed-quit')

  h.supervisor.emitPark(parkedId)
  h.supervisor.emitCrash(crashedId)
  await settle(() => h.registry.findSession(parkedId)?.shutdown === 'parked')
  await settle(() => h.registry.findSession(crashedId)?.shutdown === 'crashed')

  // Wait for the FILE, not just the in-memory doc. Every write point mutates
  // the row and then persists, so `findSession` reports the new value while the
  // write behind it is still in flight — and the relaunch below reads the file.
  // Without this the two rows reached it in whatever order the pending persists
  // happened to settle, and one that arrived still holding `engineSessionId:
  // null` is a row the launch reap is entitled to drop.
  await settle(() =>
    (
      JSON.parse(readFileSync(h.registry.filePath, 'utf8')) as {
        sessions: { engineSessionId: string | null }[]
      }
    ).sessions.every(row => row.engineSessionId !== null),
  )

  // The quit. A park is a reclaim the host chose, so an ordinary quit that finds
  // one is an ordinary quit — the parked row ends clean. A real crash is still
  // never relabelled.
  h.host.shutdownAll()
  expect(h.registry.findSession(parkedId)?.shutdown).toBe('clean')
  expect(h.registry.findSession(crashedId)?.shutdown).toBe('crashed')

  // The half the user sees: a fresh launch reading that file. Before this fix
  // the parked row was still `'parked'` on disk and `normalizeShutdown` turned
  // it into `'crashed'`, so a session nothing had happened to came back
  // dead-toned in the sidebar, the Sessions page and the palette.
  const next = new SessionRegistry({
    storageDir: h.storageDir,
    log: () => {},
    // The same hermetic resolution the harness uses. With the real one both
    // rows point at transcripts that do not exist under this temp dir, and the
    // launch reap drops them before the assertions below can look.
    transcriptPathFor: (_cwd, engineSessionId) =>
      join(h.storageDir, 'transcripts', `${engineSessionId}.jsonl`),
  })
  await next.launch()
  expect(next.findSession(parkedId)?.shutdown).toBe('clean')
  expect(next.findSession(crashedId)?.shutdown).toBe('crashed')
})

test('F3: a failed spawn (no exit event behind it) also marks the row crashed', async () => {
  const h = makeHost()
  const created = await h.host.createSession({ cwd: h.cwd })
  if (!created.ok) throw new Error('create failed')
  const id = created.value.appSessionId

  h.supervisor.setStatus(id, 'failed')
  await settle(() => h.registry.findSession(id)?.shutdown === 'crashed')
  expect(h.registry.findSession(id)?.shutdown).toBe('crashed')
})

test('F3: closeSession still records a CLEAN shutdown (the closing guard holds)', async () => {
  const h = makeHost()
  const created = await h.host.createSession({ cwd: h.cwd })
  if (!created.ok) throw new Error('create failed')
  const id = created.value.appSessionId
  h.supervisor.emitReady(id, 'engine-clean-test')
  await settle(() => h.registry.findSession(id)?.engineSessionId === 'engine-clean-test')

  const closed = await h.host.closeSession(id)
  expect(closed.ok).toBe(true)
  await settle(() => h.registry.findSession(id)?.shutdown === 'clean')
  expect(h.registry.findSession(id)?.shutdown).toBe('clean')
})

test('F4: a fresh createSession lands with restartCount 0; one restart bumps it exactly once', async () => {
  const h = makeHost()
  const created = await h.host.createSession({ cwd: h.cwd })
  if (!created.ok) throw new Error('create failed')
  const id = created.value.appSessionId
  h.supervisor.emitReady(id, 'engine-f4')
  await settle(() => h.registry.findSession(id)?.engineSessionId === 'engine-f4')
  // A session that actually ran a turn has a materialized transcript — required
  // for the restart below, which now refuses to resume an id with no transcript
  // (§9-A4, the guard `restoreSession` always had). This test is about
  // restartCount, so it uses the real shape rather than exercising that refusal.
  writeTranscript(h.storageDir, 'engine-f4')

  // Pre-fix, the create path's second (advisory) upsert had already bumped
  // this to 1.
  expect(h.registry.findSession(id)?.restartCount).toBe(0)
  // The advisory fields still landed (the split must not lose them).
  expect(h.registry.findSession(id)?.enginePid).toBeGreaterThan(0)
  expect(h.registry.findSession(id)?.socketPath).toContain('/tmp/fake/')

  const restarted = await h.host.restartSession(id)
  expect(restarted.ok).toBe(true)
  expect(h.registry.findSession(id)?.restartCount).toBe(1)
})

test('F5: a runtime bound-reap emits session-removed for the reaped terminal row', async () => {
  const storageDir = tempDir()
  // Fast no-op advisory lock: this test writes ~70 registry persists; the
  // locking discipline itself is covered by the concurrent-writer test.
  const registry = new SessionRegistry({
    storageDir,
    log: () => {},
    transcriptPathFor: (_cwd, engineSessionId) =>
      join(storageDir, 'transcripts', `${engineSessionId}.jsonl`),
    acquireLock: async () => async () => {},
  })
  const h = makeHost({ registry })
  const { MAX_REGISTRY_SESSIONS } = await import('./registry.js')

  // Fill the registry to the bound with terminal rows. Seeded off the CONSTANT,
  // not a literal 32 — this test proves the reap still emits `session-removed`
  // at whatever the bound is, and hardcoding the old value would have quietly
  // stopped exercising the reap at all when the bound was raised (it did).
  const seeded: string[] = []
  for (let i = 0; i < MAX_REGISTRY_SESSIONS; i++) {
    const id = randomUUID()
    seeded.push(id)
    await registry.upsertOnSpawn({ appSessionId: id, cwd: '/seeded' })
    await registry.markClean(id)
  }
  expect(registry.sessions.length).toBe(MAX_REGISTRY_SESSIONS)

  // One row past the bound (a live create) must reap one terminal row — and the
  // reap must surface on the HostEvent stream, not silently vanish from the file.
  const created = await h.host.createSession({ cwd: h.cwd })
  if (!created.ok) throw new Error(`create failed: ${created.error.code}`)

  const removed = h.events.filter(e => e.type === 'session-removed')
  expect(removed.length).toBe(1)
  expect(seeded).toContain(
    (removed[0] as { type: 'session-removed'; appSessionId: string }).appSessionId,
  )
  expect(registry.sessions.length).toBe(MAX_REGISTRY_SESSIONS)
  // The new live row survived; the reaped one is gone from the doc.
  expect(registry.findSession(created.value.appSessionId)).toBeDefined()
})

/* ------------------------------------------------------------------------- *
 * canPreview — the IS-A transcript-cache gate (not-live + restorable row)
 * ------------------------------------------------------------------------- */

test('canPreview is true only for a not-live restorable row; false for live/unknown/non-restorable', async () => {
  const h = makeHost()

  // Unknown / malformed id → false (no row).
  expect(h.host.canPreview(randomUUID())).toBe(false)
  expect(h.host.canPreview('not-a-uuid')).toBe(false)

  // A LIVE session (ready) is never previewable — restoreSession would reject an
  // already-live id, so canPreview must force false while a process is live.
  const created = await h.host.createSession({ cwd: h.cwd })
  if (!created.ok) throw new Error('create failed')
  const { appSessionId } = created.value
  h.supervisor.emitReady(appSessionId, 'engine-live')
  await settle(() => h.registry.findSession(appSessionId)?.engineSessionId === 'engine-live')
  expect(h.host.canPreview(appSessionId)).toBe(false)

  // Close it → not-live + restorable row (transcript + engineSessionId) → true.
  writeTranscript(h.storageDir, 'engine-live')
  const closed = await h.host.closeSession(appSessionId)
  expect(closed.ok).toBe(true)
  expect(h.host.canPreview(appSessionId)).toBe(true)

  // A clean row that never acquired an engineSessionId is NOT restorable → false.
  const orphan = randomUUID()
  await h.registry.upsertOnSpawn({ appSessionId: orphan, cwd: h.cwd })
  await h.registry.markClean(orphan)
  expect(h.host.canPreview(orphan)).toBe(false)
})

test('canResume reads transcript truth for a live idle-park candidate', async () => {
  const h = makeHost()
  const created = await h.host.createSession({ cwd: h.cwd })
  if (!created.ok) throw new Error('create failed')
  const { appSessionId } = created.value
  h.supervisor.emitReady(appSessionId, 'engine-park-candidate')
  await settle(
    () =>
      h.registry.findSession(appSessionId)?.engineSessionId ===
      'engine-park-candidate',
  )

  // Ready stamps an id before any message has materialized its transcript.
  expect(h.host.canResume(appSessionId)).toBe(false)

  writeTranscript(h.storageDir, 'engine-park-candidate')
  expect(h.host.canResume(appSessionId)).toBe(true)

  // The predicate is read-time, so it also catches a transcript pruned after a
  // completed turn instead of inferring resumability from message recency.
  rmSync(join(h.storageDir, 'transcripts', 'engine-park-candidate.jsonl'))
  expect(h.host.canResume(appSessionId)).toBe(false)
})

/**
 * Create-after-shutdown. `ensureHost` fires the primary `createSession` as
 * fire-and-forget, and it awaits the registry launch gate before spawning — so a
 * window closed during launch lets that continuation resume AFTER
 * `shutdownAll()` has already killed everything. Without a terminal state on the
 * supervisor it spawns a sidecar nothing owns, which then outlives the window it
 * was supposed to die with (D6).
 */
test('createSession that resumes after shutdownAll fails closed instead of spawning', async () => {
  const h = makeHost()

  // Start the create, then tear down before awaiting it — the launch-gate race.
  const pending = h.host.createSession({ cwd: h.cwd })
  h.host.shutdownAll()
  const result = await pending

  expect(result.ok).toBe(false)
  if (result.ok) return
  expect(result.error.code).toBe('spawn_failed')

  // Nothing was spawned, and the row written before the spawn attempt is not
  // left masquerading as live for the next launch's orphan sweep.
  expect(h.supervisor.records.size).toBe(0)
  for (const row of h.registry.sessions) {
    expect(row.shutdown).not.toBeNull()
  }
})

test('shutdownAll marks every live row clean so the next launch sweep sees no crash', async () => {
  const h = makeHost()
  const first = await h.host.createSession({ cwd: h.cwd })
  const second = await h.host.createSession({ cwd: h.cwd })
  expect(first.ok && second.ok).toBe(true)
  expect(h.registry.sessions.every(row => row.shutdown === null)).toBe(true)

  h.host.shutdownAll()

  expect(h.registry.sessions.length).toBe(2)
  expect(h.registry.sessions.every(row => row.shutdown === 'clean')).toBe(true)
})

/* ------------------------------------------------------------------------- *
 * Peer sessions — naming, the wake-block toggle, and the HR4 churn rule
 * (PEER-SESSIONS §2/§6 · HOST-REQUEST-PLANE HR4)
 * ------------------------------------------------------------------------- */

test('every created session is named, the name reaches the spawn config, and a restore never renames it', async () => {
  const h = makeHost()
  const created = await h.host.createSession({ cwd: h.cwd })
  if (!created.ok) throw new Error(`create failed: ${created.error.code}`)
  const { appSessionId } = created.value

  const name = h.registry.findSession(appSessionId)?.name
  expect(typeof name).toBe('string')
  expect(name!.length).toBeGreaterThan(0)
  // The name is handed to the child at spawn, not after: the sidecar's system
  // prompt is fixed when its controller is built, before any socket exists.
  expect(h.supervisor.records.get(appSessionId)?.name).toBe(name!)
  // …and the descriptor carries it, so the sidebar renders from state.
  expect(created.value.name).toBe(name!)
  expect(created.value.peerWakeBlocked).toBe(false)

  // Give the row a transcript, close it, and restore: the name must survive.
  h.supervisor.emitReady(appSessionId, 'engine-named')
  await settle(() => h.registry.findSession(appSessionId)?.engineSessionId === 'engine-named')
  writeTranscript(h.storageDir, 'engine-named')
  await h.host.closeSession(appSessionId)
  const restored = await h.host.restoreSession(appSessionId)
  if (!restored.ok) throw new Error(`restore failed: ${restored.error.code}`)
  expect(restored.value.name).toBe(name!)
  expect(h.supervisor.records.get(appSessionId)?.name).toBe(name!)
})

test('a launch renames the recently-active rows a build without the field stripped, and leaves the rest', async () => {
  // The registry exactly as a build that predates `name` leaves it. `validateRow`
  // is a closed whitelist, so such a build drops the field from every row it
  // loads and writes the stripped document back at its own launch — one run of a
  // stale packaged app un-names a fully named registry. These are `clean` rows
  // with transcripts: the closed history rows `peersOf`
  // (`app/main/peerRequestPlane.ts`) drops for having no name, which is what
  // makes the loss permanent — a row nobody can list is a row nobody can wake,
  // and only a spawn would have given it a name back.
  //
  // The repair is bounded by `NAME_REPAIR_WINDOW_MS` on `lastAttachedAt`, so this
  // pins THREE outcomes, one per row shape below. The stale row is the one a
  // future reader will read as a bug: it is not one. A registry stripped at 224
  // rows would otherwise hand a model a 223-name roster, and the window trades
  // the archive's addressability for one a model can actually read.
  const storageDir = tempDir()
  const cwd = join(storageDir, 'project')
  mkdirSync(cwd, { recursive: true })
  const registryPath = join(storageDir, 'registry.json')

  const day = 24 * 60 * 60 * 1000
  const now = Date.now()
  // Ages straddle the window rather than sitting on it: a row one hour inside is
  // as much a pass as one a minute inside, and a test that hugs the boundary
  // fails on clock skew instead of on behaviour.
  const rows = [
    { id: randomUUID(), age: 1 * day, name: undefined },
    { id: randomUUID(), age: NAME_REPAIR_WINDOW_MS - 6 * 60 * 60 * 1000, name: undefined },
    { id: randomUUID(), age: NAME_REPAIR_WINDOW_MS + 3 * day, name: undefined },
    // Named, and far outside the window: proves the write-once rule is about the
    // field being present, not about the row being recent enough to touch.
    { id: randomUUID(), age: 90 * day, name: 'Kept' },
  ]
  const [freshest, insideEdge, stale, alreadyNamed] = rows
  const repaired = [freshest!.id, insideEdge!.id]
  rows.forEach((_row, index) => writeTranscript(storageDir, `engine-strip-${index}`))
  writeFileSync(
    registryPath,
    `${JSON.stringify(
      {
        registryVersion: 1,
        hostPid: process.pid,
        updatedAt: now,
        sessions: rows.map((row, index) => ({
          appSessionId: row.id,
          engineSessionId: `engine-strip-${index}`,
          cwd,
          forked: false,
          createdAt: now - row.age,
          lastAttachedAt: now - row.age,
          lastMessageSentAt: null,
          shutdown: 'clean',
          ...(row.name === undefined ? {} : { name: row.name }),
        })),
      },
      null,
      2,
    )}\n`,
  )

  const registry = new SessionRegistry({
    storageDir,
    log: () => {},
    transcriptPathFor: (_cwd, engineSessionId) =>
      join(storageDir, 'transcripts', `${engineSessionId}.jsonl`),
  })
  const supervisor = new FakeSupervisor()
  const host = new Host({
    supervisor: supervisor as never,
    registry,
    validateCwd: (candidate: string): CwdValidation =>
      candidate === cwd ? { ok: true, realpath: candidate } : { ok: false },
    launched: registry.launch(),
  })

  await settle(() =>
    repaired.every(
      id =>
        host.listSessions().find(session => session.appSessionId === id)?.name != null,
    ),
  )
  // The stale row is asserted as a NEGATIVE, so give the fill every chance to
  // reach it first — otherwise this passes because the repair had not run yet.
  await drain()

  const named = new Map(
    host.listSessions().map(session => [session.appSessionId, session.name]),
  )
  expect(named.size).toBe(rows.length)

  // (1) Inside the window: repaired.
  for (const id of repaired) {
    expect(typeof named.get(id as SessionId)).toBe('string')
    expect(named.get(id as SessionId)!.length).toBeGreaterThan(0)
  }
  // Uniqueness is the point of a name: the allocator must widen its reserved set
  // as it goes, not hand the same pool entry to every row it repairs.
  expect(new Set(repaired.map(id => named.get(id as SessionId))).size).toBe(
    repaired.length,
  )

  // (2) Outside the window: left nameless, ON PURPOSE. This row is now outside
  // the peer world for good — it cannot be listed, so it cannot be woken, so it
  // never spawns and never earns a name later. It stays openable from history.
  expect(named.get(stale!.id as SessionId)).toBeNull()

  // (3) Already named: untouched regardless of age.
  expect(named.get(alreadyNamed!.id as SessionId)).toBe('Kept')

  // …and it reached DISK. The in-memory row is what the previous test asserted,
  // and the in-memory row is exactly what survives a quit only if it is written.
  const persisted = JSON.parse(readFileSync(registryPath, 'utf8')) as {
    sessions: Array<{ appSessionId: string; name?: string }>
  }
  const onDisk = new Map(persisted.sessions.map(row => [row.appSessionId, row.name]))
  for (const id of repaired) {
    expect(onDisk.get(id)).toBe(named.get(id as SessionId)!)
  }
  expect(onDisk.get(stale!.id)).toBeUndefined()
  expect(onDisk.get(alreadyNamed!.id)).toBe('Kept')

  // Idempotent: a second launch over the repaired file renames nothing, and does
  // not reconsider the stale row either — the window is not a retry schedule.
  const relaunched = new SessionRegistry({
    storageDir,
    log: () => {},
    transcriptPathFor: (_cwd, engineSessionId) =>
      join(storageDir, 'transcripts', `${engineSessionId}.jsonl`),
  })
  const second = new Host({
    supervisor: new FakeSupervisor() as never,
    registry: relaunched,
    validateCwd: (candidate: string): CwdValidation =>
      candidate === cwd ? { ok: true, realpath: candidate } : { ok: false },
    launched: relaunched.launch(),
  })
  await settle(() => second.listSessions().length === rows.length)
  await drain()
  for (const session of second.listSessions()) {
    expect(session.name).toBe(named.get(session.appSessionId)!)
  }
})

test('allocation consults the names on registry rows, not just the cursor', async () => {
  // R3. Six sequential creates draw six consecutive pool entries whether or not
  // the reserved set is consulted, because the host carries the picker's cursor
  // across spawns — so "they were all different" proves nothing.
  //
  // The case that matters in life is a RELAUNCH: `peerNameCursor` is in-memory
  // and reseeded by `randomPeerNameCursor()` every launch, so it comes back at
  // an arbitrary offset and the registry rows are the only thing standing
  // between it and a duplicate. Drive exactly that: learn where the cursor is,
  // plant a row holding the very name the next allocation would hand out, and
  // require the host to step over it.
  const h = makeHost()
  const first = await h.host.createSession({ cwd: h.cwd })
  if (!first.ok) throw new Error('first create failed')
  const firstName = String(first.value.name)

  // After allocating `firstName` the cursor sits one past it, so this is the
  // name an unreserved allocation would return next.
  const firstIndex = PEER_NAME_POOL.findIndex(entry => entry === firstName)
  expect(firstIndex).toBeGreaterThanOrEqual(0)
  const nextUp = PEER_NAME_POOL[(firstIndex + 1) % PEER_NAME_POOL.length]!

  // Plant it on an unrelated row, the way a relaunch finds names it did not
  // allocate this run.
  await h.registry.upsertOnSpawn({
    appSessionId: randomUUID(),
    cwd: h.cwd,
    name: nextUp,
  })

  h.setNow(h.now() + SPAWN_RATE_WINDOW_MS + 1)
  const second = await h.host.createSession({ cwd: h.cwd })
  if (!second.ok) throw new Error('second create failed')
  expect(second.value.name).not.toBe(nextUp)
  expect(second.value.name).toBe(
    PEER_NAME_POOL[(firstIndex + 2) % PEER_NAME_POOL.length]!,
  )
})

test('setPeerWakeBlocked persists, publishes the new state, and refuses an unknown id', async () => {
  const h = makeHost()
  const created = await h.host.createSession({ cwd: h.cwd })
  if (!created.ok) throw new Error(`create failed: ${created.error.code}`)
  const { appSessionId } = created.value

  const blocked = await h.host.setPeerWakeBlocked(appSessionId, true)
  expect(blocked.ok).toBe(true)
  expect(h.registry.findSession(appSessionId)?.peerWakeBlocked).toBe(true)
  // A write-only toggle cannot show its own state: the change must reach the
  // subscriber as a descriptor, not just the file.
  const published = h.events
    .filter(e => e.type === 'session-status')
    .map(e => (e as { session: { appSessionId: string; peerWakeBlocked?: boolean } }).session)
    .filter(session => session.appSessionId === appSessionId)
  expect(published.at(-1)?.peerWakeBlocked).toBe(true)

  const cleared = await h.host.setPeerWakeBlocked(appSessionId, false)
  expect(cleared.ok).toBe(true)
  expect(h.registry.findSession(appSessionId)?.peerWakeBlocked).toBeUndefined()

  const unknown = await h.host.setPeerWakeBlocked(randomUUID(), true)
  expect(unknown.ok).toBe(false)
  if (unknown.ok) return
  expect(unknown.error.code).toBe('session_not_found')
  const malformed = await h.host.setPeerWakeBlocked('not-a-uuid', true)
  expect(malformed.ok).toBe(false)
})

test('HR4: a peer create is refused at the registry bound when nothing is reapable, and the file stops growing', async () => {
  // The create-park-create churn HC4 does not bound: parked rows leave the live
  // count and are exempt from the reap, so without this rule the registry, the
  // tab bar and main's peer state grow without limit at 8 spawns per 10 s.
  const storageDir = tempDir()
  const registry = new SessionRegistry({
    storageDir,
    log: () => {},
    transcriptPathFor: (_cwd, engineSessionId) =>
      join(storageDir, 'transcripts', `${engineSessionId}.jsonl`),
    acquireLock: async () => async () => {},
  })
  const h = makeHost({ registry })
  const { MAX_REGISTRY_SESSIONS } = await import('./registry.js')

  // One real workspace row to name the workspace, then fill to the bound with
  // PARKED rows — the state the reap refuses to touch.
  const seedSession = await h.host.createSession({ cwd: h.cwd })
  if (!seedSession.ok) throw new Error('seed create failed')
  const workspaceId = seedSession.value.appSessionId
  for (let i = registry.sessions.length; i < MAX_REGISTRY_SESSIONS; i++) {
    const id = randomUUID()
    await registry.upsertOnSpawn({ appSessionId: id, cwd: h.cwd })
    await registry.markParked(id)
  }
  await registry.markParked(workspaceId)
  expect(registry.sessions.length).toBe(MAX_REGISTRY_SESSIONS)

  h.setNow(h.now() + SPAWN_RATE_WINDOW_MS + 1)
  const refused = await h.host.createSessionInWorkspace(workspaceId, {
    enforceRegistryChurnLimit: true,
  })
  expect(refused.ok).toBe(false)
  if (refused.ok) return
  expect(refused.error.code).toBe('session_limit')
  expect(registry.sessions.length).toBe(MAX_REGISTRY_SESSIONS)

  // The rule is opt-in: the operator's own "+" is not refused because 256 rows
  // happen to be parked. It reaches the ordinary caps instead, which is the
  // behavior every other create has.
  const rendererCreate = await h.host.createSessionInWorkspace(workspaceId)
  expect(rendererCreate.ok).toBe(true)

  // One reapable row is enough for the peer create to proceed again.
  const reapable = randomUUID()
  await registry.upsertOnSpawn({ appSessionId: reapable, cwd: h.cwd })
  await registry.markClean(reapable)
  h.setNow(h.now() + SPAWN_RATE_WINDOW_MS + 1)
  const allowed = await h.host.createSessionInWorkspace(workspaceId, {
    enforceRegistryChurnLimit: true,
  })
  expect(allowed.ok).toBe(true)
})

test('a peer create carries its creator id and the creator name into the spawn config', async () => {
  const h = makeHost()
  const creator = await h.host.createSession({ cwd: h.cwd })
  if (!creator.ok) throw new Error('creator create failed')
  const creatorId = creator.value.appSessionId
  const creatorName = String(creator.value.name)

  h.setNow(h.now() + SPAWN_RATE_WINDOW_MS + 1)
  const peer = await h.host.createSessionInWorkspace(creatorId, {
    createdBy: creatorId,
    model: 'gpt-5.6-luna',
    effort: 'low',
  })
  if (!peer.ok) throw new Error(`peer create failed: ${peer.error.code}`)
  const peerId = peer.value.appSessionId

  // The name is the picker's, never the caller's: PEER-SESSIONS §2 rules out
  // user-chosen call signs in v1, so there is no name argument to pass.
  expect(typeof peer.value.name).toBe('string')
  expect(h.registry.findSession(peerId)?.createdBy).toBe(creatorId)
  // The creator is on the DESCRIPTOR too, as an id: the renderer derives the
  // "Bear, created by Alex" seam row from `name` + `createdBy` (§6) and cannot
  // read the registry itself. Deliberately no resolved creator NAME here, which
  // would bake a reusable name into a snapshot outliving the row (§2).
  expect(peer.value.createdBy).toBe(creatorId)

  const spawned = h.supervisor.records.get(peerId)
  expect(spawned?.name).toBe(String(peer.value.name))
  expect(spawned?.createdBy).toBe(creatorId)
  // The creator's NAME is resolved by the host, the only process that can read
  // the registry, and travels as a label beside the id.
  expect(spawned?.createdByName).toBe(creatorName)
  expect(spawned?.model).toBe('gpt-5.6-luna')
  expect(spawned?.effort).toBe('low')

  // An ordinary user-created session has no creator at all.
  expect(creator.value.createdBy).toBeNull()
  expect(h.registry.findSession(creatorId)?.createdBy).toBeUndefined()
})

test('a restore of a created peer rebuilds the creator id AND the creator name in its spawn config', async () => {
  // PEER-SESSIONS §5 + R1. The doctrine block is built from the spawn env when
  // the controller is constructed, so anything missing here is lost for the life
  // of the process: a restored Bear boots reading as user-created. Every wake
  // takes this path, including the peer-message restore (HRP §4 step 5).
  // The config asserted here is what the supervisor turns into env, which
  // `supervisor.test.ts` proves separately.
  const h = makeHost()
  const alex = await h.host.createSession({ cwd: h.cwd })
  if (!alex.ok) throw new Error('creator create failed')
  const alexId = alex.value.appSessionId
  const alexName = String(alex.value.name)

  h.setNow(h.now() + SPAWN_RATE_WINDOW_MS + 1)
  const bear = await h.host.createSessionInWorkspace(alexId, { createdBy: alexId })
  if (!bear.ok) throw new Error(`peer create failed: ${bear.error.code}`)
  const bearId = bear.value.appSessionId
  const bearName = String(bear.value.name)
  expect(h.supervisor.records.get(bearId)?.createdByName).toBe(alexName)

  // Park/close Bear, then bring it back the way a peer message would.
  h.supervisor.emitReady(bearId, 'engine-bear')
  await settle(() => h.registry.findSession(bearId)?.engineSessionId === 'engine-bear')
  writeTranscript(h.storageDir, 'engine-bear')
  await h.host.closeSession(bearId)

  h.setNow(h.now() + SPAWN_RATE_WINDOW_MS + 1)
  const restored = await h.host.restoreSession(bearId)
  if (!restored.ok) throw new Error(`restore failed: ${restored.error.code}`)
  const afterRestore = h.supervisor.records.get(bearId)
  expect(afterRestore?.name).toBe(bearName)
  expect(afterRestore?.createdBy).toBe(alexId)
  expect(afterRestore?.createdByName).toBe(alexName)
})

test('a restart of a created peer re-applies the creator name, not just the opaque id', async () => {
  // The sidecar cannot resolve an id at boot: its system prompt is fixed before
  // the socket to main exists and it may not read the registry. So a restart
  // that carried only `createdBy` would leave Bear holding a value it can never
  // render.
  const h = makeHost()
  const alex = await h.host.createSession({ cwd: h.cwd })
  if (!alex.ok) throw new Error('creator create failed')
  const alexId = alex.value.appSessionId
  const alexName = String(alex.value.name)

  h.setNow(h.now() + SPAWN_RATE_WINDOW_MS + 1)
  const bear = await h.host.createSessionInWorkspace(alexId, { createdBy: alexId })
  if (!bear.ok) throw new Error(`peer create failed: ${bear.error.code}`)
  const bearId = bear.value.appSessionId
  const bearName = String(bear.value.name)

  h.supervisor.emitReady(bearId, 'engine-bear-restart')
  await settle(
    () => h.registry.findSession(bearId)?.engineSessionId === 'engine-bear-restart',
  )
  writeTranscript(h.storageDir, 'engine-bear-restart')

  // Clear what the create recorded, so the assertion can only pass if the
  // RESTART re-supplied all three values.
  const record = h.supervisor.records.get(bearId)!
  delete record.name
  delete record.createdBy
  delete record.createdByName

  h.setNow(h.now() + SPAWN_RATE_WINDOW_MS + 1)
  const restarted = await h.host.restartSession(bearId)
  if (!restarted.ok) throw new Error(`restart failed: ${restarted.error.code}`)
  // Re-read rather than reuse the alias above: the `delete`s narrowed its
  // fields to `undefined`, which would make these assertions uncheckable.
  const afterRestart = h.supervisor.records.get(bearId)
  expect(afterRestart?.name).toBe(bearName)
  expect(afterRestart?.createdBy).toBe(alexId)
  expect(afterRestart?.createdByName).toBe(alexName)
})

/**
 * F17, ruling 11 — the case the id check exists for, and the one that used to
 * disarm it.
 *
 * `expectCreatorId` rides a send only when the sidecar can match `to` against a
 * creator NAME it holds. That name was re-resolved from the registry at every
 * spawn, so a reap of the creator's row returned nothing and the child booted
 * with an id and no name: no expectation went on the wire, and the reissued
 * name it was still addressing resolved to a stranger. Exactly the sequence the
 * ruling names, defeated by the reap that creates it.
 *
 * The name is stored on the row now, so the reap cannot take it. Bear is left
 * LIVE while Alex is closed, because the bound reap takes terminal rows and the
 * point here is that only the creator goes.
 */
test('a peer whose creator was reaped is still restarted with the creator name, so the id check stays armed', async () => {
  const storageDir = tempDir()
  const registry = new SessionRegistry({
    storageDir,
    log: () => {},
    transcriptPathFor: (_cwd, engineSessionId) =>
      join(storageDir, 'transcripts', `${engineSessionId}.jsonl`),
    acquireLock: async () => async () => {},
  })
  const h = makeHost({ registry })
  const { MAX_REGISTRY_SESSIONS } = await import('./registry.js')

  const alex = await h.host.createSession({ cwd: h.cwd })
  if (!alex.ok) throw new Error('creator create failed')
  const alexId = alex.value.appSessionId
  const alexName = String(alex.value.name)

  h.setNow(h.now() + SPAWN_RATE_WINDOW_MS + 1)
  const bear = await h.host.createSessionInWorkspace(alexId, { createdBy: alexId })
  if (!bear.ok) throw new Error(`peer create failed: ${bear.error.code}`)
  const bearId = bear.value.appSessionId

  // Written at create, while the creator is still there to be named. This is
  // the assertion the whole fix rests on: re-resolving later is what failed.
  expect(registry.findSession(bearId)?.createdByName).toBe(alexName)

  h.supervisor.emitReady(bearId, 'engine-bear-reaped-creator')
  await settle(
    () =>
      registry.findSession(bearId)?.engineSessionId === 'engine-bear-reaped-creator',
  )
  // The local `storageDir` above, not `h.storageDir`: this test builds its own
  // registry to drive the bound reap, and that registry resolves transcripts
  // under its own directory. Restart re-checks the transcript (§9-A4).
  writeTranscript(storageDir, 'engine-bear-reaped-creator')

  // Alex closes and becomes reapable; Bear stays live and does not.
  await h.host.closeSession(alexId)
  await registry.markClean(alexId)

  // Alex is the OLDEST terminal row, so the bound reap takes it first. Seed off
  // the constant for the same reason the F5 test does: a literal would stop
  // exercising the reap the next time the bound moves.
  while (registry.sessions.length < MAX_REGISTRY_SESSIONS) {
    const id = randomUUID()
    await registry.upsertOnSpawn({ appSessionId: id, cwd: '/seeded' })
    await registry.markClean(id)
  }
  const filler = randomUUID()
  await registry.upsertOnSpawn({ appSessionId: filler, cwd: '/seeded' })
  expect(registry.findSession(alexId)).toBeUndefined()
  expect(registry.findSession(bearId)).toBeDefined()

  // Clear what the create recorded, so this can only pass if the RESTART
  // re-supplied the name from the row rather than from a live lookup that now
  // has nothing to find.
  const record = h.supervisor.records.get(bearId)!
  delete record.createdByName

  h.setNow(h.now() + SPAWN_RATE_WINDOW_MS + 1)
  const restarted = await h.host.restartSession(bearId)
  if (!restarted.ok) throw new Error(`restart failed: ${restarted.error.code}`)
  expect(h.supervisor.records.get(bearId)?.createdByName).toBe(alexName)
  expect(h.supervisor.records.get(bearId)?.createdBy).toBe(alexId)
})

test('restoring a row written before peer names existed allocates one and hands it to the spawn', async () => {
  // HOST-REQUEST-PLANE §6 names this test: "restoring a pre-field row allocates
  // a name". It is the load-bearing half of PEER-SESSIONS §2's invariant that
  // every LIVE session has a name — an unnamed live row could never be listed,
  // addressed or reported back to. The other naming tests all restore a row that
  // already has one, so they prove survival, not minting.
  const storageDir = tempDir()
  const cwd = join(storageDir, 'project')
  mkdirSync(cwd, { recursive: true })
  const registryPath = join(storageDir, 'registry.json')
  const appSessionId = randomUUID()

  // The exact on-disk shape of a row written before the field existed: no
  // `name`, no `createdBy`, no `peerWakeBlocked`.
  writeFileSync(
    registryPath,
    `${JSON.stringify({
      registryVersion: 1,
      hostPid: 999999,
      updatedAt: Date.now(),
      sessions: [
        {
          appSessionId,
          engineSessionId: 'engine-prefield',
          cwd,
          forked: false,
          createdAt: 1_700_000_000_000,
          lastAttachedAt: 1_700_000_000_000,
          lastMessageSentAt: null,
          shutdown: 'clean',
        },
      ],
    }, null, 2)}\n`,
  )
  writeTranscript(storageDir, 'engine-prefield')

  const registry = new SessionRegistry({
    storageDir,
    log: () => {},
    transcriptPathFor: (_c, engineSessionId) =>
      join(storageDir, 'transcripts', `${engineSessionId}.jsonl`),
  })
  await registry.launch()
  expect(registry.findSession(appSessionId)?.name).toBeUndefined()

  const supervisor = new FakeSupervisor()
  const host = new Host({
    supervisor: supervisor as never,
    registry,
    validateCwd: (c: string): CwdValidation =>
      c === cwd ? { ok: true, realpath: c } : { ok: false },
  })

  const restored = await host.restoreSession(appSessionId)
  if (!restored.ok) throw new Error(`restore failed: ${restored.error.code}`)

  // Minted, persisted, published, and — the half that actually reaches the
  // engine process — handed to the spawn, since the doctrine block is built
  // from the spawn env at controller construction.
  const allocated = registry.findSession(appSessionId)?.name
  expect(typeof allocated).toBe('string')
  expect(PEER_NAME_POOL).toContain(allocated!)
  expect(restored.value.name).toBe(allocated!)
  expect(supervisor.records.get(appSessionId)?.name).toBe(allocated!)
})
