import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'bun:test'
import type { QueryEngineAppSessionConfig } from '../app-runtime/createQueryEngineAppSession.js'
import type { AppSessionController } from '../app-runtime/AppSessionController.js'
import { getDefaultAppState } from '../state/AppStateStore.js'
import { createFileStateCacheWithSizeLimit } from '../utils/fileStateCache.js'
import { startRuntimeBackedWebMode } from './startRuntimeBackedWebMode.js'

function baseConfig(): QueryEngineAppSessionConfig {
  return {
    cwd: '/repo',
    tools: [],
    commands: [],
    mcpClients: [],
    agents: [],
    getAppState: () => getDefaultAppState(),
    setAppState: () => {},
    readFileCache: createFileStateCacheWithSizeLimit(20),
    includePartialMessages: true,
  }
}

describe('startRuntimeBackedWebMode', () => {
  test('keeps app-session setup inside the web-mode branch in main startup', () => {
    const mainSource = readFileSync(new URL('../main.tsx', import.meta.url), 'utf8')
    const startRuntimeIndex = mainSource.indexOf('await startRuntimeBackedWebMode')
    const webStartIndex = mainSource.lastIndexOf(
      'if (webModeEnabled) {',
      startRuntimeIndex,
    )

    expect(startRuntimeIndex).toBeGreaterThan(-1)
    expect(webStartIndex).toBeGreaterThan(-1)
    expect(
      mainSource.indexOf(
        'const appStateStore = createStore(initialState, onChangeAppState)',
      ),
    ).toBeGreaterThan(webStartIndex)
    expect(
      mainSource.indexOf(
        'const queryEngineAppSessionConfig = createQueryEngineAppSessionConfigFromSetup',
      ),
    ).toBeGreaterThan(webStartIndex)
  })

  test('starts the app-session server before waiting forever and cleans up after release', async () => {
    const calls: string[] = []
    let serverController: AppSessionController | undefined
    let markWaitStarted: (() => void) | undefined
    let releaseWait: (() => void) | undefined
    const waitStarted = new Promise<void>(resolve => {
      markWaitStarted = resolve
    })
    const waitReleased = new Promise<void>(resolve => {
      releaseWait = resolve
    })

    const routePromise = startRuntimeBackedWebMode({
      queryEngineConfig: baseConfig(),
      webDir: '/repo/web',
      token: 'token-1',
      wsPort: 3456,
      webPort: 5173,
      allowedOrigins: ['http://127.0.0.1:5173'],
      createController: () => ({}) as AppSessionController,
      startServer: async options => {
        calls.push('server')
        serverController = options.controller
        expect(options.port).toBe(3456)
        return {
          port: 3456,
          url: 'ws://127.0.0.1:3456/ws',
          protocol: 'cat-code.token-1',
          stop: async () => {
            calls.push('server.stop')
          },
        }
      },
      launchWebApp: async options => {
        calls.push(`launcher:${options.token}:${options.port}`)
        return {
          url: 'http://127.0.0.1:5173',
          logPath: '/tmp/cat-code-web-dev.log',
          child: {} as never,
          stop: async () => {
            calls.push('launcher.stop')
          },
        }
      },
      waitForever: async () => {
        calls.push('wait')
        markWaitStarted?.()
        await waitReleased
      },
      log: () => {},
      writeError: () => {},
    })

    await waitStarted
    expect(serverController).toBeDefined()
    expect(calls).toEqual(['server', 'launcher:token-1:5173', 'wait'])

    releaseWait?.()
    await routePromise
    expect(calls).toEqual([
      'server',
      'launcher:token-1:5173',
      'wait',
      'launcher.stop',
      'server.stop',
    ])
  })

  test('stops started resources when waiting rejects', async () => {
    const calls: string[] = []

    await expect(
      startRuntimeBackedWebMode({
        queryEngineConfig: baseConfig(),
        webDir: '/repo/web',
        token: 'token-1',
        wsPort: 3456,
        webPort: 5173,
        allowedOrigins: ['http://127.0.0.1:5173'],
        createController: () => ({}) as AppSessionController,
        startServer: async () => ({
          port: 3456,
          url: 'ws://127.0.0.1:3456/ws',
          protocol: 'cat-code.token-1',
          stop: async () => {
            calls.push('server.stop')
          },
        }),
        launchWebApp: async () => ({
          url: 'http://127.0.0.1:5173',
          logPath: '/tmp/cat-code-web-dev.log',
          child: {} as never,
          stop: async () => {
            calls.push('launcher.stop')
          },
        }),
        waitForever: async () => {
          throw new Error('shutdown')
        },
        log: () => {},
        writeError: () => {},
      }),
    ).rejects.toThrow('shutdown')

    expect(calls).toEqual(['launcher.stop', 'server.stop'])
  })

  test('continues cleanup and preserves the original error when a stop rejects', async () => {
    const calls: string[] = []
    const errors: string[] = []

    await expect(
      startRuntimeBackedWebMode({
        queryEngineConfig: baseConfig(),
        webDir: '/repo/web',
        token: 'secret-token',
        createController: () => ({}) as AppSessionController,
        startServer: async () => ({
          port: 3456,
          url: 'ws://127.0.0.1:3456/ws',
          protocol: 'cat-code.secret-token',
          stop: async () => {
            calls.push('server.stop')
          },
        }),
        launchWebApp: async () => ({
          url: 'http://127.0.0.1:5173',
          logPath: '/tmp/cat-code-web-dev.log',
          child: {} as never,
          stop: async () => {
            calls.push('launcher.stop')
            throw new Error('launcher stop failed with secret-token')
          },
        }),
        waitForever: async () => {
          throw new Error('wait failed with secret-token')
        },
        log: () => {},
        writeError: message => {
          errors.push(message)
        },
      }),
    ).rejects.toThrow('wait failed with secret-token')

    expect(calls).toEqual(['launcher.stop', 'server.stop'])
    expect(errors.join('')).not.toContain('secret-token')
    expect(errors.join('')).toContain('[REDACTED]')
    expect(errors.join('')).toContain('Failed to stop web app dev server')
  })
})
