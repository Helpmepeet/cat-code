import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import type { spawn } from 'node:child_process'

import type { SessionsCatalogSnapshot } from '../shared/protocol.js'
import { SESSIONS_CATALOG_WORKER_BOUNDARY_VERSION } from '../shared/sessionsCatalogWorker.js'
import { runSessionsCatalogWorker } from './sessionsCatalogRunner.js'

function catalog(ids: string[]): SessionsCatalogSnapshot {
  return {
    entries: ids.map(id => ({
      sessionId: id,
      forked: false,
      cwd: '/w/proj',
      cwdExists: true,
      title: id,
      transcriptTitle: null,
      modifiedAtMs: 1,
      createdAtMs: 1,
      messageCount: 0,
      gitBranch: null,
      tag: null,
      mode: null,
      agentSetting: null,
      prNumber: null,
      prRepository: null,
    })),
    truncated: false,
    capturedAtMs: 1,
  }
}

/**
 * A fake `spawn` that scripts the child's stdout + exit. Emits its stdout on the
 * next macrotask (after the runner has installed its handlers and closed stdin),
 * then closes. No real process is spawned.
 */
function fakeSpawn(script: {
  stdout?: string
  exitCode?: number
  signal?: NodeJS.Signals | null
  emitError?: Error
}): typeof spawn {
  return ((): unknown => {
    const child = new EventEmitter() as EventEmitter & {
      exitCode: number | null
      signalCode: NodeJS.Signals | null
      kill: (signal?: NodeJS.Signals) => boolean
      stdout: EventEmitter
      stderr: EventEmitter
      stdin: EventEmitter & { end: () => void }
    }
    child.exitCode = null
    child.signalCode = null
    child.kill = (signal?: NodeJS.Signals) => {
      child.signalCode = signal ?? 'SIGTERM'
      return true
    }
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    const stdin = new EventEmitter() as EventEmitter & { end: () => void }
    stdin.end = () => {}
    child.stdin = stdin
    setTimeout(() => {
      if (script.emitError) {
        child.emit('error', script.emitError)
        return
      }
      if (script.stdout !== undefined) {
        child.stdout.emit('data', Buffer.from(script.stdout, 'utf8'))
      }
      child.exitCode = script.exitCode ?? 0
      child.emit('close', script.exitCode ?? 0, script.signal ?? null)
    }, 0)
    return child
  }) as unknown as typeof spawn
}

function ndjson(record: unknown): string {
  return `${JSON.stringify(record)}\n`
}

describe('runSessionsCatalogWorker — accept + deliver', () => {
  test('delivers the single catalog record to onCatalog', async () => {
    const delivered: SessionsCatalogSnapshot[] = []
    const outcome = await runSessionsCatalogWorker({
      command: 'bun',
      args: [],
      cwd: process.cwd(),
      spawnWorker: fakeSpawn({
        stdout: ndjson({
          type: 'catalog',
          version: SESSIONS_CATALOG_WORKER_BOUNDARY_VERSION,
          catalog: catalog(['a', 'b']),
        }),
      }),
      onCatalog: snapshot => delivered.push(snapshot),
    })
    expect(outcome).toBe('delivered')
    expect(delivered).toHaveLength(1)
    expect(delivered[0]!.entries.map(e => e.sessionId)).toEqual(['a', 'b'])
  })

  test('reports only metadata-only worker start and exit lifecycle', async () => {
    const lifecycle: unknown[] = []
    await runSessionsCatalogWorker({
      command: 'bun',
      args: [],
      cwd: process.cwd(),
      spawnWorker: fakeSpawn({
        stdout: ndjson({
          type: 'catalog',
          version: SESSIONS_CATALOG_WORKER_BOUNDARY_VERSION,
          catalog: catalog([]),
        }),
      }),
      onCatalog: () => {},
      onWorkerLifecycle: event => lifecycle.push(event),
    })
    expect(lifecycle).toEqual([
      { phase: 'started', pid: 0 },
      { phase: 'exited', pid: 0, code: 0, signal: null },
    ])
  })

  test('a clean worker-reported failure resolves "failure" and never calls onCatalog (keeps last good)', async () => {
    let called = false
    const outcome = await runSessionsCatalogWorker({
      command: 'bun',
      args: [],
      cwd: process.cwd(),
      spawnWorker: fakeSpawn({
        stdout: ndjson({
          type: 'failure',
          version: SESSIONS_CATALOG_WORKER_BOUNDARY_VERSION,
          reason: 'internal',
        }),
      }),
      onCatalog: () => {
        called = true
      },
    })
    expect(outcome).toBe('failure')
    expect(called).toBe(false)
  })
})

describe('runSessionsCatalogWorker — fail closed', () => {
  test('rejects on non-JSON stdout and never calls onCatalog', async () => {
    let called = false
    await expect(
      runSessionsCatalogWorker({
        command: 'bun',
        args: [],
        cwd: process.cwd(),
        spawnWorker: fakeSpawn({ stdout: 'not json\n' }),
        onCatalog: () => {
          called = true
        },
      }),
    ).rejects.toThrow()
    expect(called).toBe(false)
  })

  test('rejects on a schema-invalid record', async () => {
    await expect(
      runSessionsCatalogWorker({
        command: 'bun',
        args: [],
        cwd: process.cwd(),
        spawnWorker: fakeSpawn({
          stdout: ndjson({ type: 'catalog', version: 999, catalog: catalog([]) }),
        }),
        onCatalog: () => {},
      }),
    ).rejects.toThrow()
  })

  test('rejects when the worker emits more than one record and publishes nothing', async () => {
    const one = {
      type: 'catalog',
      version: SESSIONS_CATALOG_WORKER_BOUNDARY_VERSION,
      catalog: catalog(['a']),
    }
    const delivered: SessionsCatalogSnapshot[] = []
    await expect(
      runSessionsCatalogWorker({
        command: 'bun',
        args: [],
        cwd: process.cwd(),
        spawnWorker: fakeSpawn({ stdout: ndjson(one) + ndjson(one) }),
        onCatalog: snapshot => delivered.push(snapshot),
      }),
    ).rejects.toThrow()
    // The first record parsed cleanly, but the run was never accepted: a
    // rejected run must keep the last good catalog.
    expect(delivered).toHaveLength(0)
  })

  test('a valid record followed by a non-zero exit publishes nothing', async () => {
    const delivered: SessionsCatalogSnapshot[] = []
    await expect(
      runSessionsCatalogWorker({
        command: 'bun',
        args: [],
        cwd: process.cwd(),
        spawnWorker: fakeSpawn({
          stdout: ndjson({
            type: 'catalog',
            version: SESSIONS_CATALOG_WORKER_BOUNDARY_VERSION,
            catalog: catalog(['a']),
          }),
          exitCode: 1,
        }),
        onCatalog: snapshot => delivered.push(snapshot),
      }),
    ).rejects.toThrow()
    expect(delivered).toHaveLength(0)
  })

  test('rejects on a non-zero exit with no record', async () => {
    await expect(
      runSessionsCatalogWorker({
        command: 'bun',
        args: [],
        cwd: process.cwd(),
        spawnWorker: fakeSpawn({ exitCode: 1 }),
        onCatalog: () => {},
      }),
    ).rejects.toThrow()
  })

  test('rejects on a spawn error', async () => {
    await expect(
      runSessionsCatalogWorker({
        command: 'bun',
        args: [],
        cwd: process.cwd(),
        spawnWorker: fakeSpawn({ emitError: new Error('ENOENT') }),
        onCatalog: () => {},
      }),
    ).rejects.toThrow()
  })
})
