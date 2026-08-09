import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import type { spawn } from 'node:child_process'

import type { SessionsCatalogSnapshot } from '../shared/protocol.js'
import { SESSIONS_CATALOG_WORKER_BOUNDARY_VERSION } from '../shared/sessionsCatalogWorker.js'
import {
  createSessionsCatalogDriver,
  runSessionsCatalogWorker,
} from './sessionsCatalogRunner.js'

const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0))

function catalog(ids: string[]): SessionsCatalogSnapshot {
  return {
    entries: ids.map(id => ({
      sessionId: id,
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

  test('rejects when the worker emits more than one record', async () => {
    const one = {
      type: 'catalog',
      version: SESSIONS_CATALOG_WORKER_BOUNDARY_VERSION,
      catalog: catalog(['a']),
    }
    await expect(
      runSessionsCatalogWorker({
        command: 'bun',
        args: [],
        cwd: process.cwd(),
        spawnWorker: fakeSpawn({ stdout: ndjson(one) + ndjson(one) }),
        onCatalog: () => {},
      }),
    ).rejects.toThrow()
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

describe('createSessionsCatalogDriver — single-flight + keeps-last-good', () => {
  test('single-flight: a tick while a run is in flight never starts a second worker', async () => {
    let runCount = 0
    let running = 0
    let maxConcurrent = 0
    let release: (() => void) | null = null
    const driver = createSessionsCatalogDriver({
      run: () => {
        runCount++
        running++
        maxConcurrent = Math.max(maxConcurrent, running)
        return new Promise<void>(resolve => {
          release = () => {
            running--
            resolve()
          }
        })
      },
      intervalMs: 0,
      setTimer: () => ({ unref() {} }) as unknown as ReturnType<typeof setTimeout>,
      clearTimer: () => {},
    })

    driver.start() // run #1 in flight
    await flush()
    expect(runCount).toBe(1)

    // Simulate the timer firing (and any spurious extra starts) mid-flight: the
    // in-flight guard must drop them — no second worker while #1 runs.
    driver.start()
    driver.start()
    await flush()
    expect(runCount).toBe(1)
    expect(maxConcurrent).toBe(1)

    release!() // #1 settles
    await flush()
    driver.stop()
    expect(maxConcurrent).toBe(1)
  })

  test('keeps last good: a rejected run is swallowed and the driver reschedules', async () => {
    let runCount = 0
    const logged: string[] = []
    let scheduled = 0
    const driver = createSessionsCatalogDriver({
      run: () => {
        runCount++
        return Promise.reject(new Error('worker blew up'))
      },
      intervalMs: 0,
      log: line => logged.push(line),
      setTimer: () => {
        scheduled++
        return { unref() {} } as unknown as ReturnType<typeof setTimeout>
      },
      clearTimer: () => {},
    })

    driver.start()
    await flush()
    // The run rejected, but start() did not throw and the driver rescheduled the
    // next run (the renderer keeps its last good catalog — no delivery happened).
    expect(runCount).toBe(1)
    expect(scheduled).toBe(1)
    expect(logged.some(line => line.includes('refresh failed'))).toBe(true)
    driver.stop()
  })

  test('fixed cadence: the next run is anchored to run START, not completion', async () => {
    // Before the fix the driver always scheduled `intervalMs` AFTER the run
    // settled, so the real refresh period was `intervalMs + runDuration` — the
    // measured 30.36 s ceiling against a 30 s freshness contract.
    const delays: number[] = []
    let clock = 0
    const runMs = 450
    const driver = createSessionsCatalogDriver({
      run: () => {
        clock += runMs // the run consumes wall time
        return Promise.resolve()
      },
      intervalMs: 30_000,
      now: () => clock,
      setTimer: (_cb, ms) => {
        delays.push(ms)
        return { unref() {} } as unknown as ReturnType<typeof setTimeout>
      },
      clearTimer: () => {},
    })

    driver.start()
    await flush()
    driver.stop()
    // Period = interval exactly: the run's own 450 ms is absorbed, not added.
    expect(delays).toEqual([30_000 - runMs])
  })

  test('fixed cadence: a run that overruns the interval reschedules immediately, never stacks', async () => {
    const delays: number[] = []
    let clock = 0
    let running = 0
    let maxConcurrent = 0
    const driver = createSessionsCatalogDriver({
      run: async () => {
        running++
        maxConcurrent = Math.max(maxConcurrent, running)
        clock += 90_000 // three intervals long
        running--
      },
      intervalMs: 30_000,
      now: () => clock,
      setTimer: (_cb, ms) => {
        delays.push(ms)
        return { unref() {} } as unknown as ReturnType<typeof setTimeout>
      },
      clearTimer: () => {},
    })

    driver.start()
    await flush()
    driver.stop()
    // Clamped to 0 (never negative), and the in-flight guard still serialized it.
    expect(delays).toEqual([0])
    expect(maxConcurrent).toBe(1)
  })

  test('stop() prevents any further scheduled runs', async () => {
    let runCount = 0
    let timerCb: (() => void) | null = null
    const driver = createSessionsCatalogDriver({
      run: () => {
        runCount++
        return Promise.resolve()
      },
      intervalMs: 0,
      setTimer: cb => {
        timerCb = cb
        return { unref() {} } as unknown as ReturnType<typeof setTimeout>
      },
      clearTimer: () => {},
    })
    driver.start()
    await flush()
    expect(runCount).toBe(1)
    driver.stop()
    // Even if a pending timer callback fires after stop(), no run happens.
    timerCb!()
    await flush()
    expect(runCount).toBe(1)
  })
})
