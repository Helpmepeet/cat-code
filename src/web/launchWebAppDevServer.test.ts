import { EventEmitter } from 'node:events'
import { describe, expect, test } from 'bun:test'
import type { ChildProcess } from 'node:child_process'
import { launchWebAppDevServer } from './launchWebAppDevServer.js'

class FakeStream extends EventEmitter {
  chunks: string[] = []
  endCount = 0
  write(chunk: string) {
    this.chunks.push(chunk)
  }
  end() {
    this.endCount++
  }
}

class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  killed = false
  signals: string[] = []
  kill(signal?: NodeJS.Signals) {
    this.killed = true
    this.signals.push(signal ?? 'SIGTERM')
    this.emit('exit', null, signal ?? 'SIGTERM')
    return true
  }
}

describe('launchWebAppDevServer', () => {
  test('starts Vite on localhost with the WebSocket token in env and opens a tokenless URL', async () => {
    const child = new FakeChildProcess()
    const spawned: unknown[] = []
    const opened: string[] = []
    const log = new FakeStream()

    const started = await launchWebAppDevServer({
      webDir: '/repo/web',
      token: 'secret-token',
      port: 5173,
      logPath: '/tmp/cat-code-web-dev.log',
      logStream: log as never,
      spawnProcess: (command, args, options) => {
        spawned.push({ command, args, options })
        return child as unknown as ChildProcess
      },
      openBrowser: async url => {
        opened.push(url)
      },
    })

    expect(spawned).toEqual([
      {
        command: 'bun',
        args: ['run', 'dev', '--', '--host', '127.0.0.1', '--port', '5173'],
        options: expect.objectContaining({
          cwd: '/repo/web',
          stdio: ['ignore', 'pipe', 'pipe'],
          env: expect.objectContaining({
            VITE_CAT_CODE_WS_TOKEN: 'secret-token',
          }),
        }),
      },
    ])

    child.stdout.emit('data', '  Local:   http://127.0.0.1:5173/\n')
    await Promise.resolve()

    expect(opened).toEqual(['http://127.0.0.1:5173'])
    expect(opened[0]).not.toContain('secret-token')

    await started.stop()
    await started.stop()
    expect(child.signals).toEqual(['SIGTERM'])
    expect(log.endCount).toBe(1)
  })

  test('opens after an exact Vite local root URL from stderr', async () => {
    const child = new FakeChildProcess()
    const opened: string[] = []

    await launchWebAppDevServer({
      webDir: '/repo/web',
      token: 'secret-token',
      port: 5173,
      logPath: '/tmp/cat-code-web-dev.log',
      logStream: new FakeStream() as never,
      spawnProcess: () => child as unknown as ChildProcess,
      openBrowser: async url => {
        opened.push(url)
      },
    })

    child.stderr.emit('data', '  Local:   http://127.0.0.1:5173/\n')
    await Promise.resolve()

    expect(opened).toEqual(['http://127.0.0.1:5173'])
  })

  test('opens when the exact Vite local root URL is split across stream chunks', async () => {
    const stdoutChild = new FakeChildProcess()
    const stderrChild = new FakeChildProcess()
    const opened: string[] = []

    await launchWebAppDevServer({
      webDir: '/repo/web',
      token: 'secret-token',
      port: 5173,
      logPath: '/tmp/cat-code-web-dev.log',
      logStream: new FakeStream() as never,
      spawnProcess: () => stdoutChild as unknown as ChildProcess,
      openBrowser: async url => {
        opened.push(`stdout:${url}`)
      },
    })
    await launchWebAppDevServer({
      webDir: '/repo/web',
      token: 'secret-token',
      port: 5173,
      logPath: '/tmp/cat-code-web-dev.log',
      logStream: new FakeStream() as never,
      spawnProcess: () => stderrChild as unknown as ChildProcess,
      openBrowser: async url => {
        opened.push(`stderr:${url}`)
      },
    })

    stdoutChild.stdout.emit('data', '  Local:   http://127.0.0.1:517')
    stderrChild.stderr.emit('data', '  Local:   http://127.0.0.1:517')
    await Promise.resolve()
    expect(opened).toEqual([])

    stdoutChild.stdout.emit('data', '3/\n')
    stderrChild.stderr.emit('data', '3/\n')
    await Promise.resolve()

    expect(opened).toEqual([
      'stdout:http://127.0.0.1:5173',
      'stderr:http://127.0.0.1:5173',
    ])
  })

  test('does not open non-exact 127.0.0.1 URLs', async () => {
    const child = new FakeChildProcess()
    const opened: string[] = []

    await launchWebAppDevServer({
      webDir: '/repo/web',
      token: 'secret-token',
      port: 5173,
      logPath: '/tmp/cat-code-web-dev.log',
      logStream: new FakeStream() as never,
      spawnProcess: () => child as unknown as ChildProcess,
      openBrowser: async url => {
        opened.push(url)
      },
    })

    child.stdout.emit('data', '  Local:   http://127.0.0.1:5173/malicious\n')
    child.stderr.emit('data', '  Local:   http://127.0.0.1:5173/?token=secret-token\n')
    await Promise.resolve()

    expect(opened).toEqual([])
  })

  test('redacts the token from log output and launcher error messages', async () => {
    const child = new FakeChildProcess()
    const log = new FakeStream()

    await launchWebAppDevServer({
      webDir: '/repo/web',
      token: 'secret-token',
      port: 5173,
      logPath: '/tmp/cat-code-web-dev.log',
      logStream: log as never,
      spawnProcess: () => child as unknown as ChildProcess,
      openBrowser: async () => {
        throw new Error('could not open secret-token')
      },
    })

    child.stdout.emit('data', 'stdout secret-token\n')
    child.stderr.emit('data', 'stderr secret-token http://127.0.0.1:5173/\n')
    child.emit('error', new Error('start failed with secret-token'))
    await Promise.resolve()

    const logText = log.chunks.join('')
    expect(logText).not.toContain('secret-token')
    expect(logText).toContain('[REDACTED]')
  })

  test('redacts tokens split across adjacent stream chunks', async () => {
    const child = new FakeChildProcess()
    const log = new FakeStream()

    const started = await launchWebAppDevServer({
      webDir: '/repo/web',
      token: 'secret-token',
      port: 5173,
      logPath: '/tmp/cat-code-web-dev.log',
      logStream: log as never,
      spawnProcess: () => child as unknown as ChildProcess,
      openBrowser: async () => {},
    })

    child.stdout.emit('data', 'stdout prefix secret-')
    child.stdout.emit('data', 'token suffix\n')
    child.stderr.emit('data', 'stderr prefix secret-')
    child.stderr.emit('data', 'token suffix\n')
    await started.stop()

    const logText = log.chunks.join('')
    expect(logText).not.toContain('secret-token')
    expect(logText).toContain('stdout prefix')
    expect(logText).toContain('stderr prefix')
    expect(logText.match(/\[REDACTED\]/g)).toHaveLength(2)
  })

  test('redacts tokens split across adjacent stdout and stderr writes', async () => {
    const child = new FakeChildProcess()
    const log = new FakeStream()

    const started = await launchWebAppDevServer({
      webDir: '/repo/web',
      token: 'secret-token',
      port: 5173,
      logPath: '/tmp/cat-code-web-dev.log',
      logStream: log as never,
      spawnProcess: () => child as unknown as ChildProcess,
      openBrowser: async () => {},
    })

    child.stdout.emit('data', 'secret-')
    child.stderr.emit('data', 'token')
    await started.stop()

    const logText = log.chunks.join('')
    expect(logText).not.toContain('secret-token')
    expect(logText).toContain('[REDACTED]')
  })

  test('kills the dev server when the parent process exits without stop()', async () => {
    const child = new FakeChildProcess()
    let exitHook: (() => void) | undefined
    let unregisterCount = 0

    await launchWebAppDevServer({
      webDir: '/repo/web',
      token: 'secret-token',
      port: 5173,
      logPath: '/tmp/cat-code-web-dev.log',
      logStream: new FakeStream() as never,
      spawnProcess: () => child as unknown as ChildProcess,
      openBrowser: async () => {},
      registerParentExitHook: hook => {
        exitHook = hook
        return () => {
          unregisterCount++
        }
      },
    })

    expect(exitHook).toBeDefined()
    expect(child.signals).toEqual([])

    // Simulate process.exit(0) (e.g. the global SIGINT handler) firing the
    // 'exit' hook while the dev server is still running.
    exitHook!()
    expect(child.signals).toEqual(['SIGTERM'])

    // Child exit unregisters the hook; a second invocation is a no-op.
    expect(unregisterCount).toBe(1)
    exitHook!()
    expect(child.signals).toEqual(['SIGTERM'])
  })

  test('unregisters the parent exit hook on stop()', async () => {
    const child = new FakeChildProcess()
    let unregisterCount = 0

    const started = await launchWebAppDevServer({
      webDir: '/repo/web',
      token: 'secret-token',
      port: 5173,
      logPath: '/tmp/cat-code-web-dev.log',
      logStream: new FakeStream() as never,
      spawnProcess: () => child as unknown as ChildProcess,
      openBrowser: async () => {},
      registerParentExitHook: () => () => {
        unregisterCount++
      },
    })

    await started.stop()
    expect(unregisterCount).toBeGreaterThanOrEqual(1)
    expect(child.signals).toEqual(['SIGTERM'])
  })

  test('does not open localhost URLs from stale Vite output', async () => {
    const child = new FakeChildProcess()
    const opened: string[] = []

    await launchWebAppDevServer({
      webDir: '/repo/web',
      token: 'secret-token',
      port: 5173,
      logPath: '/tmp/cat-code-web-dev.log',
      logStream: new FakeStream() as never,
      spawnProcess: () => child as unknown as ChildProcess,
      openBrowser: async url => {
        opened.push(url)
      },
    })

    child.stdout.emit('data', '  Local:   http://localhost:5173/\n')
    await Promise.resolve()

    expect(opened).toEqual([])
  })
})
