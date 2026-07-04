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
    // Real supervisor fires an async 'exit' after a kill.
    this.emit({ type: 'exit', sessionId, code: null, signal: 'SIGTERM' })
  }

  restartSession(sessionId: SessionId): void {
    const record = this.records.get(sessionId)
    if (!record) throw new Error('no such session')
    // Fresh child = new pid + socketPath (what SF5 must re-record).
    record.pid = ++this.pidSeq
    record.socketPath = `/tmp/fake/s${this.sockSeq++}.sock`
    record.status = 'spawning'
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
    expect(statusEvent.session.restorable).toBe(true)
  }
})

/* ------------------------------------------------------------------------- *
 * HC1 — invalid_cwd
 * ------------------------------------------------------------------------- */

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
  // Row KEPT + marked clean + advisory fields cleared.
  const row = h.registry.findSession(appSessionId)
  expect(row).toBeDefined()
  expect(row?.shutdown).toBe('clean')
  expect(row?.enginePid).toBeUndefined()
  expect(row?.socketPath).toBeUndefined()
  // Still restorable (transcript present, engineSessionId set).
  expect(row?.engineSessionId).toBe('engine-close')
  const listed = h.host.listSessions().find(s => s.appSessionId === appSessionId)
  expect(listed?.restorable).toBe(true)
  expect(listed?.status).toBe('exited')
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
  // A raw supervisor exit (not a graceful close) still emits a status event.
  h.supervisor.emit({ type: 'exit', sessionId: appSessionId, code: 1, signal: null })
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

test('restartSession rejects an unknown/non-live id (session_not_found)', async () => {
  const h = makeHost()
  const result = await h.host.restartSession(randomUUID())
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.error.code).toBe('session_not_found')
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
