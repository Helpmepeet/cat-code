import { afterEach, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  defaultTranscriptPath,
  MAX_REGISTRY_SESSIONS,
  REGISTRY_VERSION,
  SessionRegistry,
  type RegistryDocument,
  type RegistryOptions,
  type RegistrySession,
} from './registry.js'

/* ------------------------------------------------------------------------- *
 * Test harness — hermetic storage dir, captured logs, controllable probes.
 * ------------------------------------------------------------------------- */

const tempDirs: string[] = []
const spawnedPids: number[] = []

afterEach(() => {
  for (const pid of spawnedPids.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // already gone
    }
  }
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // best-effort
    }
  }
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'catcode-registry-'))
  tempDirs.push(dir)
  return dir
}

type Harness = {
  registry: SessionRegistry
  storageDir: string
  logs: string[]
  registryPath: string
}

function makeRegistry(overrides: Partial<RegistryOptions> = {}): Harness {
  const storageDir = overrides.storageDir ?? tempDir()
  const logs: string[] = []
  const registry = new SessionRegistry({
    storageDir,
    log: line => logs.push(line),
    // Hermetic transcript resolution unless a test overrides it: every session's
    // transcript is a file under <storageDir>/transcripts/<engineSessionId>.jsonl.
    transcriptPathFor: (_cwd, engineSessionId) =>
      join(storageDir, 'transcripts', `${engineSessionId}.jsonl`),
    ...overrides,
  })
  return { registry, storageDir, logs, registryPath: registry.filePath }
}

function writeTranscript(storageDir: string, engineSessionId: string): void {
  const dir = join(storageDir, 'transcripts')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${engineSessionId}.jsonl`), '{"type":"summary"}\n')
}

function readDoc(registryPath: string): RegistryDocument {
  return JSON.parse(readFileSync(registryPath, 'utf8')) as RegistryDocument
}

/** Seed an on-disk registry document directly (pre-launch state). */
function seed(registryPath: string, sessions: RegistrySession[]): void {
  const doc: RegistryDocument = {
    registryVersion: REGISTRY_VERSION,
    hostPid: 999999,
    updatedAt: Date.now(),
    sessions,
  }
  writeFileSync(registryPath, `${JSON.stringify(doc, null, 2)}\n`)
}

function baseRow(overrides: Partial<RegistrySession>): RegistrySession {
  return {
    appSessionId: overrides.appSessionId ?? `app-${Math.random().toString(36).slice(2)}`,
    // Preserve an explicit `null` engineSessionId — `?? 'engine-x'` would mangle it.
    engineSessionId: 'engineSessionId' in overrides ? overrides.engineSessionId! : 'engine-x',
    cwd: overrides.cwd ?? '/Users/pt/cat-code',
    createdAt: overrides.createdAt ?? 1_700_000_000_000,
    lastAttachedAt: overrides.lastAttachedAt ?? 1_700_000_000_000,
    // Preserve an explicit `null` (orphan/live row) — `?? 'clean'` would mangle it.
    shutdown: 'shutdown' in overrides ? overrides.shutdown! : 'clean',
    ...(overrides.title !== undefined ? { title: overrides.title } : {}),
    ...(overrides.enginePid !== undefined ? { enginePid: overrides.enginePid } : {}),
    ...(overrides.socketPath !== undefined ? { socketPath: overrides.socketPath } : {}),
    ...(overrides.restartCount !== undefined ? { restartCount: overrides.restartCount } : {}),
  }
}

/** Spawn a long-lived child so the sweep can probe a REAL live pid + cmdline. */
function spawnDummy(marker: string): number {
  // The marker rides on argv so `ps -o command=` shows it — this is the identity
  // signal the sweep matches on (§9-A3). A blocking `setInterval` keeps the
  // process alive for the test; node keeps the trailing marker arg in its argv.
  const child = spawn('node', ['-e', 'setInterval(() => {}, 1e9)', marker], {
    stdio: 'ignore',
  })
  const pid = child.pid
  if (pid === undefined) throw new Error('failed to spawn dummy process')
  spawnedPids.push(pid)
  return pid
}

/* ------------------------------------------------------------------------- *
 * (1) read + validate — corrupt / unknown-version handling (§4.1, A2)
 * ------------------------------------------------------------------------- */

test('corrupt (unparseable) file is moved aside, launch starts empty, logs loudly', async () => {
  const storageDir = tempDir()
  const registryPath = join(storageDir, 'registry.json')
  writeFileSync(registryPath, '{ this is not valid json ')

  const { registry, logs } = makeRegistry({ storageDir })
  const restorable = await registry.launch()

  expect(restorable).toEqual([])
  // The bad file was moved aside as registry.json.corrupt-<ts>.
  const movedAside = readdirSync(storageDir).filter(f => f.startsWith('registry.json.corrupt-'))
  expect(movedAside.length).toBe(1)
  // A fresh empty registry now exists.
  expect(existsSync(registryPath)).toBe(true)
  expect(readDoc(registryPath).sessions).toEqual([])
  // Loud log.
  expect(logs.some(l => l.includes('CORRUPT'))).toBe(true)
})

test('unknown registryVersion is moved aside and launch starts empty', async () => {
  const storageDir = tempDir()
  const registryPath = join(storageDir, 'registry.json')
  writeFileSync(
    registryPath,
    JSON.stringify({ registryVersion: 999, hostPid: 1, updatedAt: 1, sessions: [] }),
  )

  const { registry, logs } = makeRegistry({ storageDir })
  const restorable = await registry.launch()

  expect(restorable).toEqual([])
  expect(readdirSync(storageDir).some(f => f.startsWith('registry.json.corrupt-'))).toBe(true)
  expect(logs.some(l => l.includes('CORRUPT'))).toBe(true)
})

test('a valid document round-trips through launch unchanged (live rows survive)', async () => {
  const storageDir = tempDir()
  const registryPath = join(storageDir, 'registry.json')
  writeTranscript(storageDir, 'engine-a')
  seed(registryPath, [
    baseRow({ appSessionId: 'app-a', engineSessionId: 'engine-a', shutdown: 'clean' }),
  ])

  const { registry } = makeRegistry({ storageDir })
  const restorable = await registry.launch()

  expect(restorable.map(r => r.appSessionId)).toEqual(['app-a'])
  expect(restorable[0]!.engineSessionId).toBe('engine-a')
})

/* ------------------------------------------------------------------------- *
 * (2) liveness sweep — pid + identity (§9-A3)
 * ------------------------------------------------------------------------- */

test('sweep KILLS a real orphaned process when pid AND identity both match', async () => {
  const storageDir = tempDir()
  const registryPath = join(storageDir, 'registry.json')
  const marker = `catcode-sidecar-${Math.random().toString(36).slice(2)}`
  const pid = spawnDummy(marker)

  // The row's socketPath must still exist for the identity check to pass.
  const socketPath = join(storageDir, 'live.sock')
  writeFileSync(socketPath, '')
  writeTranscript(storageDir, 'engine-live')

  seed(registryPath, [
    baseRow({
      appSessionId: 'app-live',
      engineSessionId: 'engine-live',
      shutdown: null, // orphaned: host died without marking it
      enginePid: pid,
      socketPath,
    }),
  ])

  const killed: number[] = []
  const { registry } = makeRegistry({
    storageDir,
    sidecarCommandMarker: marker,
    killProcess: p => {
      killed.push(p)
    },
  })
  const restorable = await registry.launch()

  // Killed exactly this pid (identity matched: alive + socket exists + cmdline marker).
  expect(killed).toEqual([pid])
  // Row is now flagged crashed and offered for restore, but the advisory identity
  // hints are retained so restore can refuse while the old writer is still alive.
  const row = restorable.find(r => r.appSessionId === 'app-live')!
  expect(row.shutdown).toBe('crashed')
  expect(row.enginePid).toBe(pid)
  expect(row.socketPath).toBe(socketPath)
  expect(existsSync(socketPath)).toBe(true)
  expect(registry.hasLiveAdvisorySidecar('app-live')).toBe(true)
})

test('sweep SPARES a recycled-pid impostor (pid alive but identity mismatch)', async () => {
  const storageDir = tempDir()
  const registryPath = join(storageDir, 'registry.json')
  // Spawn a live process whose cmdline does NOT contain the expected marker —
  // the classic PID-recycling case: same pid, different (innocent) process.
  const impostorPid = spawnDummy('some-unrelated-process')
  const socketPath = join(storageDir, 'live.sock')
  writeFileSync(socketPath, '')
  writeTranscript(storageDir, 'engine-live')

  seed(registryPath, [
    baseRow({
      appSessionId: 'app-live',
      engineSessionId: 'engine-live',
      shutdown: null,
      enginePid: impostorPid,
      socketPath,
    }),
  ])

  const killed: number[] = []
  const { registry } = makeRegistry({
    storageDir,
    sidecarCommandMarker: 'catcode-sidecar-EXPECTED', // never matches the impostor
    killProcess: p => {
      killed.push(p)
    },
  })
  const restorable = await registry.launch()

  // Never killed the innocent recycled-pid process.
  expect(killed).toEqual([])
  // Still marked crashed (host died) and offered for restore.
  const row = restorable.find(r => r.appSessionId === 'app-live')!
  expect(row.shutdown).toBe('crashed')
})

test('sweep does NOT kill on pid-match alone when the socket file is gone', async () => {
  const storageDir = tempDir()
  const registryPath = join(storageDir, 'registry.json')
  const marker = `catcode-sidecar-${Math.random().toString(36).slice(2)}`
  const pid = spawnDummy(marker) // cmdline WOULD match…
  writeTranscript(storageDir, 'engine-live')

  seed(registryPath, [
    baseRow({
      appSessionId: 'app-live',
      engineSessionId: 'engine-live',
      shutdown: null,
      enginePid: pid,
      socketPath: join(storageDir, 'does-not-exist.sock'), // …but socket is gone
    }),
  ])

  const killed: number[] = []
  const { registry } = makeRegistry({
    storageDir,
    sidecarCommandMarker: marker,
    killProcess: p => {
      killed.push(p)
    },
  })
  await registry.launch()

  expect(killed).toEqual([]) // identity signal 1 (socket) missing → never kill
})

test('sweep marks a dead-pid orphan crashed and kills nothing', async () => {
  const storageDir = tempDir()
  const registryPath = join(storageDir, 'registry.json')
  writeTranscript(storageDir, 'engine-live')

  seed(registryPath, [
    baseRow({
      appSessionId: 'app-live',
      engineSessionId: 'engine-live',
      shutdown: null,
      enginePid: 2, // effectively never a live sidecar
      socketPath: join(storageDir, 'gone.sock'),
    }),
  ])

  const killed: number[] = []
  const { registry } = makeRegistry({
    storageDir,
    isProcessAlive: () => false,
    sidecarCommandMarker: 'anything',
    killProcess: p => {
      killed.push(p)
    },
  })
  const restorable = await registry.launch()

  expect(killed).toEqual([])
  expect(restorable.find(r => r.appSessionId === 'app-live')!.shutdown).toBe('crashed')
})

/* ------------------------------------------------------------------------- *
 * (3) reap — missing transcript, null engineSessionId, over-bound
 * ------------------------------------------------------------------------- */

test('reap drops a row whose transcript is gone (never offer an impossible restore)', async () => {
  const storageDir = tempDir()
  const registryPath = join(storageDir, 'registry.json')
  writeTranscript(storageDir, 'engine-present')
  // engine-absent has NO transcript file.

  seed(registryPath, [
    baseRow({ appSessionId: 'app-present', engineSessionId: 'engine-present', shutdown: 'clean' }),
    baseRow({ appSessionId: 'app-absent', engineSessionId: 'engine-absent', shutdown: 'clean' }),
  ])

  const { registry, logs } = makeRegistry({ storageDir })
  const restorable = await registry.launch()

  expect(restorable.map(r => r.appSessionId)).toEqual(['app-present'])
  expect(logs.some(l => l.includes('transcript is gone'))).toBe(true)
})

test('reap drops a clean row that never acquired an engineSessionId (§9-A5)', async () => {
  const storageDir = tempDir()
  const registryPath = join(storageDir, 'registry.json')
  writeTranscript(storageDir, 'engine-real')

  seed(registryPath, [
    baseRow({ appSessionId: 'app-real', engineSessionId: 'engine-real', shutdown: 'clean' }),
    baseRow({ appSessionId: 'app-empty', engineSessionId: null, shutdown: 'clean' }),
  ])

  const { registry, logs } = makeRegistry({ storageDir })
  const restorable = await registry.launch()

  expect(restorable.map(r => r.appSessionId)).toEqual(['app-real'])
  expect(logs.some(l => l.includes('never acquired content'))).toBe(true)
})

test('a crashed row with null engineSessionId is KEPT (only clean+null is reaped)', async () => {
  const storageDir = tempDir()
  const registryPath = join(storageDir, 'registry.json')

  // shutdown: null + enginePid gone → sweep marks it crashed; null engineSessionId
  // must NOT then reap it (only shutdown:"clean" + null is the §9-A5 rule).
  seed(registryPath, [
    baseRow({
      appSessionId: 'app-crashed-empty',
      engineSessionId: null,
      shutdown: null,
      enginePid: 2,
      socketPath: join(storageDir, 'gone.sock'),
    }),
  ])

  const { registry } = makeRegistry({ storageDir, isProcessAlive: () => false })
  const restorable = await registry.launch()

  const row = restorable.find(r => r.appSessionId === 'app-crashed-empty')
  expect(row).toBeDefined()
  expect(row!.shutdown).toBe('crashed')
})

test('reap enforces MAX_REGISTRY_SESSIONS, dropping oldest terminal rows first', async () => {
  const storageDir = tempDir()
  const registryPath = join(storageDir, 'registry.json')

  const rows: RegistrySession[] = []
  // MAX + 5 terminal rows, each with a present transcript, distinct lastAttachedAt.
  const total = MAX_REGISTRY_SESSIONS + 5
  for (let i = 0; i < total; i++) {
    const engineSessionId = `engine-${i}`
    writeTranscript(storageDir, engineSessionId)
    rows.push(
      baseRow({
        appSessionId: `app-${i}`,
        engineSessionId,
        shutdown: 'clean',
        lastAttachedAt: 1_700_000_000_000 + i, // higher i = more recent
      }),
    )
  }
  seed(registryPath, rows)

  const { registry } = makeRegistry({ storageDir })
  const restorable = await registry.launch()

  expect(restorable.length).toBe(MAX_REGISTRY_SESSIONS)
  // The 5 oldest (i = 0..4) were reaped; the newest survive.
  const survivingIds = new Set(restorable.map(r => r.appSessionId))
  expect(survivingIds.has('app-0')).toBe(false)
  expect(survivingIds.has('app-4')).toBe(false)
  expect(survivingIds.has('app-5')).toBe(true)
  expect(survivingIds.has(`app-${total - 1}`)).toBe(true)
})

test('spawn over the bound reaps a terminal row, never the new LIVE row', async () => {
  const storageDir = tempDir()
  const registryPath = join(storageDir, 'registry.json')

  // Seed exactly MAX terminal rows (all clean, all with transcripts), then let
  // the registry load them and spawn one MORE — the live spawn pushes us over
  // the bound, and enforceBound must drop the oldest TERMINAL row, not the new
  // live one. This is the real mid-run invariant (§3: the bound only reaps
  // `shutdown != null` rows; a `shutdown == null` live row is never eligible).
  const rows: RegistrySession[] = []
  for (let i = 0; i < MAX_REGISTRY_SESSIONS; i++) {
    writeTranscript(storageDir, `engine-t-${i}`)
    rows.push(
      baseRow({
        appSessionId: `app-t-${i}`,
        engineSessionId: `engine-t-${i}`,
        shutdown: 'clean',
        lastAttachedAt: 1_700_000_000_000 + i, // app-t-0 is the oldest
      }),
    )
  }
  seed(registryPath, rows)

  const { registry } = makeRegistry({ storageDir })
  await registry.launch()
  expect(registry.sessions.length).toBe(MAX_REGISTRY_SESSIONS)

  // Spawn one more — a live row. This is now MAX+1 rows.
  await registry.upsertOnSpawn({
    appSessionId: 'app-new-live',
    cwd: '/Users/pt/cat-code',
    enginePid: 4242,
  })

  const doc = readDoc(registryPath)
  expect(doc.sessions.length).toBe(MAX_REGISTRY_SESSIONS)
  // The new live row survived…
  const live = doc.sessions.find(r => r.appSessionId === 'app-new-live')!
  expect(live).toBeDefined()
  expect(live.shutdown).toBeNull()
  // …and the OLDEST terminal row (app-t-0) was the one reaped.
  expect(doc.sessions.some(r => r.appSessionId === 'app-t-0')).toBe(false)
})

/* ------------------------------------------------------------------------- *
 * (4) restore-offer ordering
 * ------------------------------------------------------------------------- */

test('restorable rows are ordered by lastAttachedAt desc with crashed flagged', async () => {
  const storageDir = tempDir()
  const registryPath = join(storageDir, 'registry.json')
  writeTranscript(storageDir, 'engine-old')
  writeTranscript(storageDir, 'engine-new')
  writeTranscript(storageDir, 'engine-mid')

  seed(registryPath, [
    baseRow({
      appSessionId: 'app-old',
      engineSessionId: 'engine-old',
      shutdown: 'clean',
      lastAttachedAt: 100,
    }),
    baseRow({
      appSessionId: 'app-new',
      engineSessionId: 'engine-new',
      shutdown: 'clean',
      lastAttachedAt: 300,
    }),
    baseRow({
      appSessionId: 'app-mid',
      engineSessionId: 'engine-mid',
      shutdown: null, // will be marked crashed
      enginePid: 2,
      socketPath: join(storageDir, 'gone.sock'),
      lastAttachedAt: 200,
    }),
  ])

  const { registry } = makeRegistry({ storageDir, isProcessAlive: () => false })
  const restorable = await registry.launch()

  expect(restorable.map(r => r.appSessionId)).toEqual(['app-new', 'app-mid', 'app-old'])
  expect(restorable.find(r => r.appSessionId === 'app-mid')!.shutdown).toBe('crashed')
})

/* ------------------------------------------------------------------------- *
 * (5) write points — each updates the right fields
 * ------------------------------------------------------------------------- */

test('upsertOnSpawn creates a live row with null engineSessionId', async () => {
  const { registry, registryPath } = makeRegistry()
  await registry.upsertOnSpawn({
    appSessionId: 'app-1',
    cwd: '/Users/pt/cat-code',
    title: 'first session',
    enginePid: 4321,
    socketPath: '/tmp/catcode/s0.sock',
  })

  const doc = readDoc(registryPath)
  expect(doc.sessions.length).toBe(1)
  const row = doc.sessions[0]!
  expect(row.appSessionId).toBe('app-1')
  expect(row.engineSessionId).toBeNull()
  expect(row.shutdown).toBeNull()
  expect(row.title).toBe('first session')
  expect(row.enginePid).toBe(4321)
  expect(row.socketPath).toBe('/tmp/catcode/s0.sock')
  expect(row.restartCount).toBe(0)
})

test('upsertOnSpawn on an existing appSessionId refreshes advisory fields + bumps restartCount', async () => {
  const { registry, registryPath } = makeRegistry()
  await registry.upsertOnSpawn({ appSessionId: 'app-1', cwd: '/a', enginePid: 1, socketPath: '/s0' })
  await registry.upsertOnSpawn({ appSessionId: 'app-1', cwd: '/a', enginePid: 2, socketPath: '/s1' })

  const doc = readDoc(registryPath)
  expect(doc.sessions.length).toBe(1)
  const row = doc.sessions[0]!
  expect(row.enginePid).toBe(2)
  expect(row.socketPath).toBe('/s1')
  expect(row.restartCount).toBe(1)
  expect(row.shutdown).toBeNull()
})

test('fillEngineSessionId bridges the two ids on the ready frame', async () => {
  const { registry, registryPath } = makeRegistry()
  await registry.upsertOnSpawn({ appSessionId: 'app-1', cwd: '/a' })
  await registry.fillEngineSessionId('app-1', 'engine-42')

  expect(readDoc(registryPath).sessions[0]!.engineSessionId).toBe('engine-42')
})

test('setTitle and touchAttached update only their fields', async () => {
  const { registry, registryPath } = makeRegistry()
  await registry.upsertOnSpawn({ appSessionId: 'app-1', cwd: '/a' })
  const before = readDoc(registryPath).sessions[0]!.lastAttachedAt

  await registry.setTitle('app-1', 'renamed')
  await new Promise(r => setTimeout(r, 2))
  await registry.touchAttached('app-1')

  const row = readDoc(registryPath).sessions[0]!
  expect(row.title).toBe('renamed')
  expect(row.lastAttachedAt).toBeGreaterThanOrEqual(before)
})

test('markClean sets shutdown clean, keeps advisory fields and the row', async () => {
  const { registry, registryPath } = makeRegistry()
  await registry.upsertOnSpawn({
    appSessionId: 'app-1',
    cwd: '/a',
    enginePid: 111,
    socketPath: '/s0',
  })
  await registry.fillEngineSessionId('app-1', 'engine-1')
  await registry.markClean('app-1')

  const row = readDoc(registryPath).sessions[0]!
  expect(row.shutdown).toBe('clean')
  expect(row.enginePid).toBe(111)
  expect(row.socketPath).toBe('/s0')
  expect(row.engineSessionId).toBe('engine-1') // durable field preserved
})

test('write points that reference an unknown appSessionId are no-ops that log', async () => {
  const { registry, logs } = makeRegistry()
  await registry.fillEngineSessionId('nope', 'engine-x')
  await registry.setTitle('nope', 't')
  await registry.markClean('nope')
  expect(registry.sessions.length).toBe(0)
  expect(logs.filter(l => l.includes('no row for')).length).toBe(3)
})

/* ------------------------------------------------------------------------- *
 * §5 — atomic write under a simulated concurrent writer (no torn JSON)
 * ------------------------------------------------------------------------- */

test('atomic writes under a simulated concurrent writer never produce torn JSON', async () => {
  const storageDir = tempDir()
  const registryPath = join(storageDir, 'registry.json')

  // Two registries pointed at the SAME file — the DR-2 shared-file scenario.
  const logsA: string[] = []
  const logsB: string[] = []
  const a = new SessionRegistry({ storageDir, log: l => logsA.push(l) })
  const b = new SessionRegistry({ storageDir, log: l => logsB.push(l) })

  // Interleave many writes from both. The advisory lock + atomic rename means
  // any reader between writes sees a consistent snapshot, last-writer-wins.
  // (upsertOnSpawn returns reaped ids since F5; this test ignores them.)
  const work: Promise<string[]>[] = []
  for (let i = 0; i < 25; i++) {
    work.push(a.upsertOnSpawn({ appSessionId: `a-${i}`, cwd: '/a' }))
    work.push(b.upsertOnSpawn({ appSessionId: `b-${i}`, cwd: '/b' }))
  }
  await Promise.all(work)

  // The file is always parseable (never torn) and is a valid registry document.
  const doc = readDoc(registryPath)
  expect(doc.registryVersion).toBe(REGISTRY_VERSION)
  expect(Array.isArray(doc.sessions)).toBe(true)
  // Every row is a well-formed row (no partial write bled through).
  for (const row of doc.sessions) {
    expect(typeof row.appSessionId).toBe('string')
    expect(row.appSessionId.length).toBeGreaterThan(0)
    expect(typeof row.cwd).toBe('string')
  }
})

test('a held lock fails the WRITE, not the session (in-memory doc still advances)', async () => {
  const storageDir = tempDir()
  const logs: string[] = []
  const registry = new SessionRegistry({
    storageDir,
    log: l => logs.push(l),
    // Simulate a permanently-held lock: acquire always rejects.
    acquireLock: async () => {
      throw new Error('ELOCKED (simulated held lock)')
    },
  })

  // The call resolves (does not throw) even though the write can't happen.
  await registry.upsertOnSpawn({ appSessionId: 'app-1', cwd: '/a' })

  // In-memory state advanced (the session is unaffected)…
  expect(registry.sessions.map(r => r.appSessionId)).toEqual(['app-1'])
  // …and the failure was logged, not thrown.
  expect(logs.some(l => l.includes('could not acquire lock'))).toBe(true)
  // Nothing was written to disk.
  expect(existsSync(join(storageDir, 'registry.json'))).toBe(false)
})

/* ------------------------------------------------------------------------- *
 * default transcript-path encoding matches the engine's (simple-path case)
 * ------------------------------------------------------------------------- */

test('default transcript path resolves and reaps against the real engine encoding', async () => {
  const storageDir = tempDir()
  const registryPath = join(storageDir, 'registry.json')
  const configDir = tempDir()

  // Point config-home at a hermetic dir and lay down a transcript the way the
  // engine does: <config>/projects/<sanitizePath(cwd)>/<engineSessionId>.jsonl.
  const priorConfig = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = configDir
  try {
    const cwd = '/Users/pt/some-project'
    const sanitized = cwd.replace(/[^a-zA-Z0-9]/g, '-')
    const projectDir = join(configDir, 'projects', sanitized)
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(join(projectDir, 'engine-real.jsonl'), '{}\n')

    seed(registryPath, [
      baseRow({ appSessionId: 'app-real', engineSessionId: 'engine-real', cwd, shutdown: 'clean' }),
      baseRow({
        appSessionId: 'app-missing',
        engineSessionId: 'engine-missing',
        cwd,
        shutdown: 'clean',
      }),
    ])

    // NOTE: no transcriptPathFor override — exercises defaultTranscriptPath.
    const registry = new SessionRegistry({ storageDir, log: () => {} })
    const restorable = await registry.launch()
    expect(restorable.map(r => r.appSessionId)).toEqual(['app-real'])
  } finally {
    if (priorConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = priorConfig
  }
})

/* ------------------------------------------------------------------------- *
 * Host-plane review LOW fixes (2026-07-05): F4 advisory split · F3 markCrashed
 * · F6 NFC parity
 * ------------------------------------------------------------------------- */

test('F4: setAdvisoryRuntime refreshes pid/socketPath WITHOUT bumping restartCount or lastAttachedAt', async () => {
  const { registry, registryPath } = makeRegistry()
  await registry.upsertOnSpawn({ appSessionId: 'app-1', cwd: '/a' })
  const before = readDoc(registryPath).sessions[0]!

  await registry.setAdvisoryRuntime('app-1', { enginePid: 777, socketPath: '/s7' })

  const row = readDoc(registryPath).sessions[0]!
  expect(row.enginePid).toBe(777)
  expect(row.socketPath).toBe('/s7')
  // The hint refresh is not a re-spawn: the counter and recency are untouched.
  expect(row.restartCount).toBe(0)
  expect(row.lastAttachedAt).toBe(before.lastAttachedAt)
  expect(row.shutdown).toBeNull()
})

test('F3: markCrashed flips a LIVE row to crashed + retains advisory fields, but never relabels a terminal row', async () => {
  const { registry, registryPath } = makeRegistry()
  await registry.upsertOnSpawn({ appSessionId: 'app-live', cwd: '/a', enginePid: 1, socketPath: '/s0' })
  await registry.upsertOnSpawn({ appSessionId: 'app-closed', cwd: '/a' })
  await registry.markClean('app-closed')

  await registry.markCrashed('app-live')
  await registry.markCrashed('app-closed') // terminal — must be a no-op

  const doc = readDoc(registryPath)
  const live = doc.sessions.find(r => r.appSessionId === 'app-live')!
  const closed = doc.sessions.find(r => r.appSessionId === 'app-closed')!
  expect(live.shutdown).toBe('crashed')
  expect(live.enginePid).toBe(1)
  expect(live.socketPath).toBe('/s0')
  expect(closed.shutdown).toBe('clean')
})

test('F6: defaultTranscriptPath NFC-normalizes the cwd so a decomposed-Unicode path finds the engine-written transcript', () => {
  const configDir = tempDir()
  const priorConfig = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = configDir
  try {
    // The engine canonicalizes realpath+NFC before sanitizing
    // (sessionStoragePortable.ts canonicalizePath), so its project dir comes
    // from the NFC form: 'café' = 'café' → sanitize → 'caf-'. The NFD form
    // 'café' would sanitize to 'cafe-' — a DIFFERENT dir.
    const cwdNfc = '/tmp/café-proj'
    const cwdNfd = '/tmp/café-proj'
    expect(cwdNfc).not.toBe(cwdNfd) // distinct code points…
    expect(cwdNfd.normalize('NFC')).toBe(cwdNfc) // …same canonical path

    const sanitizedNfc = cwdNfc.replace(/[^a-zA-Z0-9]/g, '-')
    const projectDir = join(configDir, 'projects', sanitizedNfc)
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(join(projectDir, 'engine-nfc.jsonl'), '{}\n')

    // A registry row minted before the F6 fix may carry the NFD spelling; the
    // resolver must still land on the engine's NFC-derived dir.
    const resolved = defaultTranscriptPath(cwdNfd, 'engine-nfc')
    expect(resolved).toBe(join(projectDir, 'engine-nfc.jsonl'))
    expect(existsSync(resolved)).toBe(true)
  } finally {
    if (priorConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = priorConfig
  }
})
