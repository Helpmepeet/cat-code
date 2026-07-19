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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

import { SessionRegistry } from './registry.js'
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
}

class FakeSupervisor {
  readonly records = new Map<SessionId, FakeRecord>()
  private readonly listeners = new Set<(e: SupervisorEvent) => void>()
  private pidSeq = 10000
  private sockSeq = 0

  /** If set, the NEXT spawnSession throws (spawn_failed path). */
  throwOnNextSpawn: Error | null = null

  subscribe(listener: (e: SupervisorEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  spawnSession(
    sessionId: SessionId,
    config?: { cwd: string; resumeEngineSessionId?: string },
  ): SessionId {
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

  restartSession(
    sessionId: SessionId,
    config?: { cwd: string; resumeEngineSessionId?: string },
  ): void {
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
  }

  shutdown(): void {
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
        protocolVersion: 1,
        sessionId,
        engineSessionId,
        payload: { type: 'app.ready' } as never,
      },
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
 */
async function settle(predicate: () => boolean, tries = 100): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (predicate()) return
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

test('createSession enforces the live-row bound (HC4 → session_limit)', async () => {
  // A tiny fake registry that reports a saturated live set via the supervisor.
  const h = makeHost()
  // Stuff the supervisor with MAX_REGISTRY_SESSIONS live records directly.
  const { MAX_REGISTRY_SESSIONS } = await import('./registry.js')
  for (let i = 0; i < MAX_REGISTRY_SESSIONS; i++) {
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
  await h.registry.upsertOnSpawn({ appSessionId: repId, cwd: h.cwd })

  const result = await h.host.createSessionInWorkspace(repId)
  expect(result.ok).toBe(true)
  if (!result.ok) return

  // A FRESH session: a NEW appSessionId (not the named one), rooted at the row's
  // host-validated cwd, spawned with NO resume (blank engine context).
  expect(result.value.appSessionId).not.toBe(repId)
  expect(result.value.cwd).toBe(h.cwd)
  expect(result.value.engineSessionId).toBeNull()
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

  // Fill the registry to the bound with terminal rows.
  const seeded: string[] = []
  for (let i = 0; i < 32; i++) {
    const id = randomUUID()
    seeded.push(id)
    await registry.upsertOnSpawn({ appSessionId: id, cwd: '/seeded' })
    await registry.markClean(id)
  }
  expect(registry.sessions.length).toBe(32)

  // The 33rd row (a live create) must reap one terminal row — and the reap
  // must surface on the HostEvent stream, not silently vanish from the file.
  const created = await h.host.createSession({ cwd: h.cwd })
  if (!created.ok) throw new Error(`create failed: ${created.error.code}`)

  const removed = h.events.filter(e => e.type === 'session-removed')
  expect(removed.length).toBe(1)
  expect(seeded).toContain(
    (removed[0] as { type: 'session-removed'; appSessionId: string }).appSessionId,
  )
  expect(registry.sessions.length).toBe(32)
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
