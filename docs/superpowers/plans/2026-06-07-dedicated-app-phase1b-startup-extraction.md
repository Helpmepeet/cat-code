# Dedicated App Phase 1B Startup Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire `cat-code --web` to the runtime-backed app-session WebSocket server by extracting real `QueryEngineAppSessionConfig` assembly from the normal startup path without mounting the Ink REPL.

**Architecture:** Reuse normal startup, setup, commands, agents, MCP, permission mode, AppState, and QueryEngine configuration owners. `src/main.tsx` remains the router; any new helper owns config assembly and is tested before `--web` routing changes.

**Tech Stack:** Bun tests, `src/main.tsx`, `src/setup.ts`, `src/QueryEngine.ts`, `src/app-runtime/createRuntimeBackedWebAppSession.ts`, `src/web/AppSessionWebSocketServer.ts`, Vite dev server, and final manual `bun run dev -- --web` smoke.

---

## Current Findings To Preserve

- `src/main.tsx` currently handles `--web` before normal startup reaches `setup(...)`.
- The current `--web` branch imports `src/web/WebSocketServer.ts`, starts the legacy relay server, spawns `bun run dev` in `web/`, opens the Vite URL after parsing Vite output, prints that browser input is disabled, waits forever, and returns.
- Normal setup, command loading, agent loading, MCP config/resource assembly, AppState construction, and REPL session config construction all happen later in `src/main.tsx` and are skipped by the current `--web` branch.
- `src/main.tsx` currently assembles a REPL `sessionConfig` object with `commands`, `initialTools`, `mcpClients`, system prompt fields, and `thinkingConfig`; it does not assemble a standalone `QueryEngineAppSessionConfig` for browser app sessions.
- `src/QueryEngine.ts` defines base `QueryEngineConfig` with required `cwd`, `tools`, `commands`, `mcpClients`, `agents`, `canUseTool`, `getAppState`, `setAppState`, and `readFileCache`, plus model, thinking, budget, prompt, partial-message, SDK-status, and abort-related fields. `src/app-runtime/createQueryEngineAppSession.ts` exposes `QueryEngineAppSessionConfig`, where `canUseTool` is optional because app runtime wraps it with `createAppRuntimeCanUseTool(...)`.
- `src/app-runtime/createRuntimeBackedWebAppSession.ts` already forces `includePartialMessages: true` when it wraps `createQueryEngineAppSession(...)`.
- `src/web/AppSessionWebSocketServer.ts` is the runtime-backed browser transport and already binds to `127.0.0.1`, requires a `cat-code.<token>` subprotocol, checks origin and host, sends `app.ready`, forwards submits/aborts, replays pending permissions on ready, and rejects stale permission response ids with `permission_not_found`.
- `web/vite.config.ts` currently proxies browser `/ws` connections to fixed `ws://127.0.0.1:3456`, so Phase 1B must bind the runtime-backed app-session server to port `3456` unless a later plan changes Vite/browser port discovery.

## Scope Boundary

Phase 1B may edit `src/main.tsx`, add startup helpers, and add runtime/web tests. This planning task must not edit `src/main.tsx` or any source file; only this plan file is changed by Task 9.

## Read Before Implementation

Read these files in this order before editing Phase 1B code:

1. `/Users/pt/cat-code/CLAUDE.md`
2. `/Users/pt/cat-code/docs/maps/WORKSPACE_MAP.md`
3. `/Users/pt/cat-code/docs/maps/web-app-runtime.md`
4. `/Users/pt/cat-code/docs/maps/query-provider-runtime.md`
5. `/Users/pt/cat-code/docs/maps/tools-permissions.md`
6. `/Users/pt/cat-code/docs/design/dedicated-app/runtime-contract-map.md`
7. `/Users/pt/cat-code/docs/design/dedicated-app/migration-scope.md`
8. `/Users/pt/cat-code/src/main.tsx`
9. `/Users/pt/cat-code/src/setup.ts`
10. `/Users/pt/cat-code/src/QueryEngine.ts`
11. `/Users/pt/cat-code/src/app-runtime/createQueryEngineAppSession.ts`
12. `/Users/pt/cat-code/src/app-runtime/createRuntimeBackedWebAppSession.ts`
13. `/Users/pt/cat-code/src/web/AppSessionWebSocketServer.ts`
14. `/Users/pt/cat-code/src/web/appSessionProtocol.ts`
15. `/Users/pt/cat-code/web/src/hooks/useWebSocket.ts`
16. `/Users/pt/cat-code/web/vite.config.ts`

Run these source inspections first and keep the findings above true or update the implementation approach before editing:

```bash
cd /Users/pt/cat-code && rg -n "--web|webModeEnabled|startWebUIServer|Web mode is browser-first|setup\(|launchRepl\(" src/main.tsx
cd /Users/pt/cat-code && rg -n "const sessionConfig|initialTools|mcpClients|commands|agentDefinitions|initialState|getDefaultAppState|readFileCache" src/main.tsx src/setup.ts
cd /Users/pt/cat-code && sed -n '130,180p' src/QueryEngine.ts
```

## File Structure

- Create `/Users/pt/cat-code/src/app-runtime/createQueryEngineAppSessionConfigFromSetup.ts` — pure adapter from normal interactive startup outputs to `QueryEngineAppSessionConfig`.
- Create `/Users/pt/cat-code/src/app-runtime/createQueryEngineAppSessionConfigFromSetup.test.ts` — focused unit tests proving the adapter preserves startup-owned configuration fields.
- Create `/Users/pt/cat-code/src/web/launchWebAppDevServer.ts` — Vite launcher that binds the browser app to `127.0.0.1`, injects the WebSocket token through environment, opens the browser URL without putting the token in the URL, and shuts down the child process.
- Create `/Users/pt/cat-code/src/web/launchWebAppDevServer.test.ts` — focused unit tests for spawn arguments, environment, browser URL, and cleanup behavior.
- Create `/Users/pt/cat-code/src/web/startRuntimeBackedWebMode.ts` — runtime-backed `--web` bootstrap helper that creates the app-session controller, starts `startAppSessionWebSocketServer(...)`, launches Vite, and waits until process shutdown.
- Create `/Users/pt/cat-code/src/web/startRuntimeBackedWebMode.test.ts` — tests that the server starts before the wait point and the browser launcher is stopped when bootstrap fails or shutdown begins.
- Modify `/Users/pt/cat-code/src/main.tsx` — move the `--web` branch to after normal setup/AppState/QueryEngine config assembly, call the runtime-backed helper, and skip `launchRepl(...)` only after the runtime-backed server is ready.
- Optionally modify `/Users/pt/cat-code/src/web/appSessionProtocol.ts`, `/Users/pt/cat-code/web/src/appProtocol.ts`, `/Users/pt/cat-code/web/src/appState.ts`, `/Users/pt/cat-code/web/src/appState.test.ts`, and `/Users/pt/cat-code/web/src/App.tsx` only for the permission coverage task if the existing protocol, reducer, or permission panel does not carry and display the required permission metadata.

## Task 1: Extract QueryEngine App Session Config Assembly

**Files:**
- Create: `/Users/pt/cat-code/src/app-runtime/createQueryEngineAppSessionConfigFromSetup.ts`
- Create: `/Users/pt/cat-code/src/app-runtime/createQueryEngineAppSessionConfigFromSetup.test.ts`
- Read: `/Users/pt/cat-code/src/main.tsx:3058-3227`
- Read: `/Users/pt/cat-code/src/QueryEngine.ts:136-180`

- [ ] **Step 1: Write the config adapter test first**

Create `/Users/pt/cat-code/src/app-runtime/createQueryEngineAppSessionConfigFromSetup.test.ts` with this complete test content:

```ts
import { describe, expect, test } from 'bun:test'
import type { Command } from '../commands.js'
import type { MCPServerConnection } from '../services/mcp/types.js'
import { getDefaultAppState, type AppState } from '../state/AppStateStore.js'
import type { AgentDefinition } from '../tools/AgentTool/loadAgentsDir.js'
import type { Tool } from '../Tool.js'
import { createFileStateCacheWithSizeLimit } from '../utils/fileStateCache.js'
import { createQueryEngineAppSessionConfigFromSetup } from './createQueryEngineAppSessionConfigFromSetup.js'

const command = { name: 'demo-command' } as Command
const mcpCommand = { name: 'mcp-command' } as Command
const tool = { name: 'Read' } as Tool
const mcpTool = { name: 'mcp__server__tool' } as Tool
const mcpClient = { name: 'server', type: 'connected' } as MCPServerConnection
const agent = { agentType: 'builder' } as AgentDefinition
describe('createQueryEngineAppSessionConfigFromSetup', () => {
  test('preserves normal startup owners for runtime-backed web sessions', () => {
    let state: AppState = {
      ...getDefaultAppState(),
      toolPermissionContext: {
        mode: 'plan',
        additionalWorkingDirectories: [],
        alwaysAllowRules: [],
        alwaysDenyRules: [],
        alwaysAskRules: [],
        isBypassPermissionsModeAvailable: false,
      },
    }
    const readFileCache = createFileStateCacheWithSizeLimit(20)

    const config = createQueryEngineAppSessionConfigFromSetup({
      cwd: '/repo',
      tools: [tool],
      commands: [command],
      mcpTools: [mcpTool],
      mcpCommands: [mcpCommand],
      mcpClients: [mcpClient],
      agents: [agent],
      getAppState: () => state,
      setAppState: update => {
        state = update(state)
      },
      readFileCache,
      customSystemPrompt: 'system prompt',
      appendSystemPrompt: 'append prompt',
      userSpecifiedModel: 'gpt-5.5',
      fallbackModel: 'claude-sonnet-4-5-20250929',
      thinkingConfig: { type: 'enabled', budgetTokens: 1024 },
      verbose: true,
      maxTurns: 7,
      maxBudgetUsd: 3,
      taskBudget: { total: 2 },
      replayUserMessages: true,
      setSDKStatus: () => {},
    })

    expect(config.cwd).toBe('/repo')
    expect(config.tools).toEqual([tool, mcpTool])
    expect(config.commands).toEqual([command, mcpCommand])
    expect(config.mcpClients).toEqual([mcpClient])
    expect(config.agents).toEqual([agent])
    expect(config.canUseTool).toBeUndefined()
    expect(config.getAppState().toolPermissionContext.mode).toBe('plan')
    config.setAppState(prev => ({ ...prev, verbose: true }))
    expect(state.verbose).toBe(true)
    expect(config.readFileCache).toBe(readFileCache)
    expect(config.customSystemPrompt).toBe('system prompt')
    expect(config.appendSystemPrompt).toBe('append prompt')
    expect(config.userSpecifiedModel).toBe('gpt-5.5')
    expect(config.fallbackModel).toBe('claude-sonnet-4-5-20250929')
    expect(config.thinkingConfig).toEqual({ type: 'enabled', budgetTokens: 1024 })
    expect(config.verbose).toBe(true)
    expect(config.maxTurns).toBe(7)
    expect(config.maxBudgetUsd).toBe(3)
    expect(config.taskBudget).toEqual({ total: 2 })
    expect(config.replayUserMessages).toBe(true)
    expect(config.includePartialMessages).toBe(true)
    expect(config.setSDKStatus).toBeTypeOf('function')
  })
})
```

- [ ] **Step 2: Run the failing config adapter test**

Run:

```bash
cd /Users/pt/cat-code && bun test src/app-runtime/createQueryEngineAppSessionConfigFromSetup.test.ts
```

Expected result before implementation: the test fails because `/Users/pt/cat-code/src/app-runtime/createQueryEngineAppSessionConfigFromSetup.ts` does not exist.

- [ ] **Step 3: Implement the config adapter**

Create `/Users/pt/cat-code/src/app-runtime/createQueryEngineAppSessionConfigFromSetup.ts` with this complete content:

```ts
import type { Command } from '../commands.js'
import type { MCPServerConnection } from '../services/mcp/types.js'
import type { AppState } from '../state/AppStateStore.js'
import type { Tool } from '../Tool.js'
import type { SDKStatus } from '../types/sdk.js'
import type { AgentDefinition } from '../tools/AgentTool/loadAgentsDir.js'
import type { FileStateCache } from '../utils/fileStateCache.js'
import type { ThinkingConfig } from '../utils/thinking.js'
import type { QueryEngineAppSessionConfig } from './createQueryEngineAppSession.js'

export type QueryEngineAppSessionConfigFromSetupInput = {
  cwd: string
  tools: Tool[]
  commands: Command[]
  mcpTools: Tool[]
  mcpCommands: Command[]
  mcpClients: MCPServerConnection[]
  agents: AgentDefinition[]
  getAppState: () => AppState
  setAppState: (update: (prev: AppState) => AppState) => void
  readFileCache: FileStateCache
  customSystemPrompt?: string
  appendSystemPrompt?: string
  userSpecifiedModel?: string
  fallbackModel?: string
  thinkingConfig?: ThinkingConfig
  maxTurns?: number
  maxBudgetUsd?: number
  taskBudget?: { total: number }
  jsonSchema?: Record<string, unknown>
  verbose?: boolean
  replayUserMessages?: boolean
  setSDKStatus?: (status: SDKStatus) => void
}

export function createQueryEngineAppSessionConfigFromSetup({
  cwd,
  tools,
  commands,
  mcpTools,
  mcpCommands,
  mcpClients,
  agents,
  getAppState,
  setAppState,
  readFileCache,
  customSystemPrompt,
  appendSystemPrompt,
  userSpecifiedModel,
  fallbackModel,
  thinkingConfig,
  maxTurns,
  maxBudgetUsd,
  taskBudget,
  jsonSchema,
  verbose,
  replayUserMessages,
  setSDKStatus,
}: QueryEngineAppSessionConfigFromSetupInput): QueryEngineAppSessionConfig {
  return {
    cwd,
    tools: [...tools, ...mcpTools],
    commands: [...commands, ...mcpCommands],
    mcpClients,
    agents,
    getAppState,
    setAppState,
    readFileCache,
    customSystemPrompt,
    appendSystemPrompt,
    userSpecifiedModel,
    fallbackModel,
    thinkingConfig,
    maxTurns,
    maxBudgetUsd,
    taskBudget,
    jsonSchema,
    verbose,
    replayUserMessages,
    includePartialMessages: true,
    setSDKStatus,
  }
}
```

- [ ] **Step 4: Run the config adapter test again**

Run:

```bash
cd /Users/pt/cat-code && bun test src/app-runtime/createQueryEngineAppSessionConfigFromSetup.test.ts
```

Expected result after implementation: pass.

- [ ] **Step 5: Confirm the adapter is aligned with `QueryEngineConfig`**

Run:

```bash
cd /Users/pt/cat-code && rg -n "export type QueryEngineConfig|includePartialMessages|readFileCache|setSDKStatus" src/QueryEngine.ts src/app-runtime/createQueryEngineAppSessionConfigFromSetup.ts src/app-runtime/createQueryEngineAppSessionConfigFromSetup.test.ts
```

Expected result: matches show the helper provides `readFileCache`, preserves `setSDKStatus`, sets `includePartialMessages: true`, and does not require a React-owned `canUseTool` function from `src/main.tsx`.

## Task 2: Add Browser Dev Server Launcher

**Files:**
- Create: `/Users/pt/cat-code/src/web/launchWebAppDevServer.ts`
- Create: `/Users/pt/cat-code/src/web/launchWebAppDevServer.test.ts`
- Read: `/Users/pt/cat-code/src/main.tsx:1220-1306`
- Read: `/Users/pt/cat-code/web/package.json`

- [ ] **Step 1: Write launcher tests first**

Create `/Users/pt/cat-code/src/web/launchWebAppDevServer.test.ts` with this complete content:

```ts
import { EventEmitter } from 'node:events'
import { describe, expect, test } from 'bun:test'
import type { ChildProcess } from 'node:child_process'
import { launchWebAppDevServer } from './launchWebAppDevServer.js'

class FakeStream extends EventEmitter {
  chunks: string[] = []
  write(chunk: string) {
    this.chunks.push(chunk)
  }
  end() {}
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
```

- [ ] **Step 2: Run the failing launcher tests**

Run:

```bash
cd /Users/pt/cat-code && bun test src/web/launchWebAppDevServer.test.ts
```

Expected result before implementation: the test fails because `/Users/pt/cat-code/src/web/launchWebAppDevServer.ts` does not exist.

- [ ] **Step 3: Implement the launcher**

Create `/Users/pt/cat-code/src/web/launchWebAppDevServer.ts` with this complete content:

```ts
import { spawn, type ChildProcess } from 'node:child_process'
import type { WriteStream } from 'node:fs'
import { createWriteStream } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openBrowser as defaultOpenBrowser } from '../utils/browser.js'

export type LaunchWebAppDevServerOptions = {
  webDir: string
  token: string
  port?: number
  logPath?: string
  logStream?: Pick<WriteStream, 'write' | 'end'>
  spawnProcess?: typeof spawn
  openBrowser?: (url: string) => Promise<unknown> | unknown
}

export type LaunchedWebAppDevServer = {
  url: string
  logPath: string
  child: ChildProcess
  stop(): Promise<void>
}

export async function launchWebAppDevServer({
  webDir,
  token,
  port = 5173,
  logPath = join(tmpdir(), 'cat-code-web-dev.log'),
  logStream = createWriteStream(logPath, { flags: 'a' }),
  spawnProcess = spawn,
  openBrowser = defaultOpenBrowser,
}: LaunchWebAppDevServerOptions): Promise<LaunchedWebAppDevServer> {
  const url = `http://127.0.0.1:${port}`
  let opened = false
  let stopped = false
  const child = spawnProcess(
    'bun',
    ['run', 'dev', '--', '--host', '127.0.0.1', '--port', String(port)],
    {
      cwd: webDir,
      env: {
        ...process.env,
        VITE_CAT_CODE_WS_TOKEN: token,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )

  const maybeOpen = (text: string) => {
    if (opened || !text.includes(`http://127.0.0.1:${port}/`)) return
    opened = true
    void openBrowser(url)
  }

  child.stdout?.on('data', chunk => {
    const text = String(chunk)
    logStream.write(text)
    maybeOpen(text)
  })

  child.stderr?.on('data', chunk => {
    const text = String(chunk)
    logStream.write(text)
    maybeOpen(text)
  })

  child.on('error', error => {
    logStream.write(
      `Failed to start web dev server: ${error instanceof Error ? error.message : String(error)}\n`,
    )
  })

  child.on('exit', (code, signal) => {
    if (stopped || code === 0 || signal === 'SIGTERM') {
      logStream.end()
      return
    }
    logStream.write(
      `Web dev server exited unexpectedly (${signal ?? code ?? 'unknown'})\n`,
    )
    logStream.end()
  })

  return {
    url,
    logPath,
    child,
    async stop() {
      if (stopped) return
      stopped = true
      if (!child.killed) {
        child.kill('SIGTERM')
      }
      logStream.end()
    },
  }
}
```

- [ ] **Step 4: Run launcher tests again**

Run:

```bash
cd /Users/pt/cat-code && bun test src/web/launchWebAppDevServer.test.ts
```

Expected result after implementation: pass.

## Task 3: Add Runtime-Backed Web Mode Bootstrap Helper

**Files:**
- Create: `/Users/pt/cat-code/src/web/startRuntimeBackedWebMode.ts`
- Create: `/Users/pt/cat-code/src/web/startRuntimeBackedWebMode.test.ts`
- Read: `/Users/pt/cat-code/src/app-runtime/createRuntimeBackedWebAppSession.ts`
- Read: `/Users/pt/cat-code/src/web/AppSessionWebSocketServer.ts`

- [ ] **Step 1: Write bootstrap helper tests first**

Create `/Users/pt/cat-code/src/web/startRuntimeBackedWebMode.test.ts` with this complete content:

```ts
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
  test('starts the app-session server before waiting forever', async () => {
    const calls: string[] = []
    let serverController: AppSessionController | undefined

    await startRuntimeBackedWebMode({
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
      },
      log: () => {},
      writeError: () => {},
    })

    expect(serverController).toBeDefined()
    expect(calls).toEqual(['server', 'launcher:token-1:5173', 'wait'])
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
})
```

- [ ] **Step 2: Run the failing bootstrap helper tests**

Run:

```bash
cd /Users/pt/cat-code && bun test src/web/startRuntimeBackedWebMode.test.ts
```

Expected result before implementation: the test fails because `/Users/pt/cat-code/src/web/startRuntimeBackedWebMode.ts` does not exist.

- [ ] **Step 3: Implement the bootstrap helper**

Create `/Users/pt/cat-code/src/web/startRuntimeBackedWebMode.ts` with this complete content:

```ts
import chalk from 'chalk'
import type { AppSessionController } from '../app-runtime/AppSessionController.js'
import {
  createRuntimeBackedWebAppSession,
  type RuntimeBackedWebAppSessionOptions,
} from '../app-runtime/createRuntimeBackedWebAppSession.js'
import type { QueryEngineAppSessionConfig } from '../app-runtime/createQueryEngineAppSession.js'
import { launchWebAppDevServer, type LaunchedWebAppDevServer } from './launchWebAppDevServer.js'
import { startAppSessionWebSocketServer } from './AppSessionWebSocketServer.js'

type StartedAppSessionWebSocketServer = Awaited<
  ReturnType<typeof startAppSessionWebSocketServer>
>

export type StartRuntimeBackedWebModeOptions = {
  queryEngineConfig: QueryEngineAppSessionConfig
  webDir: string
  token: string
  wsPort?: number
  webPort?: number
  allowedOrigins?: string[]
  createController?: (
    options: RuntimeBackedWebAppSessionOptions,
  ) => AppSessionController
  startServer?: typeof startAppSessionWebSocketServer
  launchWebApp?: typeof launchWebAppDevServer
  waitForever?: () => Promise<void>
  log?: (message: string) => void
  writeError?: (message: string) => void
}

export async function startRuntimeBackedWebMode({
  queryEngineConfig,
  webDir,
  token,
  wsPort = 3456,
  webPort = 5173,
  allowedOrigins = [`http://127.0.0.1:${webPort}`],
  createController = createRuntimeBackedWebAppSession,
  startServer = startAppSessionWebSocketServer,
  launchWebApp = launchWebAppDevServer,
  waitForever = () => new Promise<void>(() => {}),
  log = message => {
    console.log(message)
  },
  writeError = message => {
    process.stderr.write(message)
  },
}: StartRuntimeBackedWebModeOptions): Promise<void> {
  let server: StartedAppSessionWebSocketServer | undefined
  let webApp: LaunchedWebAppDevServer | undefined

  try {
    const controller = createController({ queryEngineConfig })
    server = await startServer({
      port: wsPort,
      token,
      allowedOrigins,
      controller,
    })
    log(chalk.magenta(`App session WebSocket listening on ${server.url}`))

    webApp = await launchWebApp({
      webDir,
      token,
      port: webPort,
    })
    log(chalk.magenta(`Web app dev server logs: ${webApp.logPath}`))
    log(chalk.magenta('Web mode is runtime-backed: skipping the Ink REPL.'))

    await waitForever()
  } catch (error) {
    writeError(
      chalk.red(
        `Failed to start runtime-backed web mode: ${error instanceof Error ? error.message : String(error)}\n`,
      ),
    )
    throw error
  } finally {
    await webApp?.stop()
    await server?.stop()
  }
}
```

- [ ] **Step 4: Run bootstrap helper tests again**

Run:

```bash
cd /Users/pt/cat-code && bun test src/web/startRuntimeBackedWebMode.test.ts
```

Expected result after implementation: pass.

## Task 4: Route `--web` Through Normal Startup And Skip Ink Only After Runtime Server Ready

**Files:**
- Modify: `/Users/pt/cat-code/src/main.tsx`
- Read: `/Users/pt/cat-code/src/main.tsx:1220-1306`
- Read: `/Users/pt/cat-code/src/main.tsx:2029-3227`
- Read: `/Users/pt/cat-code/src/main.tsx:3271-3319`

- [ ] **Step 1: Remove the early legacy `--web` branch**

In `/Users/pt/cat-code/src/main.tsx`, delete only the early block that starts at the existing comment `// Start web UI server if --web flag is set` and ends after `return;` for that block. Keep this declaration near the same location so later code can still branch on it:

```ts
const webModeEnabled = (options as { web?: boolean }).web === true;
```

After this edit, `--web` must continue into the normal `setup(...)`, command, agent, MCP, model, permission, and AppState assembly path.

- [ ] **Step 2: Create a read-file cache owner beside the interactive AppState store**

Near the existing interactive AppState assembly in `/Users/pt/cat-code/src/main.tsx`, add imports if they are not already present:

```ts
import {
  createFileStateCacheWithSizeLimit,
  READ_FILE_STATE_CACHE_SIZE,
} from './utils/fileStateCache.js';
import { createStore } from './state/store.js';
```

Then place this immediately after `const initialTools = mcpTools;`:

```ts
const appStateStore = createStore(initialState, onChangeAppState);
const readFileCache = createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE);
```

If `createStore` or `onChangeAppState` already has a local owner in this section, reuse that existing owner and keep a single store for both `--web` and terminal mode.

- [ ] **Step 3: Build the runtime app-session config from the normal startup values**

Add these imports to `/Users/pt/cat-code/src/main.tsx`:

```ts
import { createQueryEngineAppSessionConfigFromSetup } from './app-runtime/createQueryEngineAppSessionConfigFromSetup.js';
import { startRuntimeBackedWebMode } from './web/startRuntimeBackedWebMode.js';
```

Immediately after the existing `sessionConfig` declaration, create this config:

```ts
const queryEngineAppSessionConfig = createQueryEngineAppSessionConfigFromSetup({
  cwd: currentCwd,
  tools,
  commands,
  mcpTools,
  mcpCommands,
  mcpClients,
  agents: agentDefinitions.activeAgents,
  getAppState: appStateStore.getState,
  setAppState: appStateStore.setState,
  readFileCache,
  customSystemPrompt: systemPrompt,
  appendSystemPrompt,
  userSpecifiedModel: effectiveModel,
  fallbackModel: userSpecifiedFallbackModel,
  thinkingConfig,
  maxTurns: options.maxTurns,
  maxBudgetUsd: options.maxBudgetUsd,
  taskBudget: options.taskBudget ? { total: options.taskBudget } : undefined,
  jsonSchema,
  verbose,
  replayUserMessages: effectiveReplayUserMessages,
});
```

Do not pass a terminal `useCanUseTool` value here. Terminal permissions are React-hook-owned inside `/Users/pt/cat-code/src/screens/REPL.tsx`, while app sessions are mediated by `/Users/pt/cat-code/src/app-runtime/createQueryEngineAppSession.ts`, which wraps the optional `config.canUseTool` with `createAppRuntimeCanUseTool(...)`. For Phase 1B, omit `canUseTool` from startup config so app-runtime permission requests are surfaced through the browser handler instead of trying to reuse a nonexistent non-React terminal callback.

- [ ] **Step 4: Start runtime-backed web mode before any `launchRepl(...)` call**

Place this branch after `queryEngineAppSessionConfig` is created and before the first terminal `launchRepl(...)` branch:

```ts
if (webModeEnabled) {
  const webDir = resolve(currentCwd, 'web');
  const token = crypto.randomUUID();
  await startRuntimeBackedWebMode({
    queryEngineConfig: queryEngineAppSessionConfig,
    webDir,
    token,
    wsPort: 3456,
    webPort: 5173,
    allowedOrigins: ['http://127.0.0.1:5173'],
  });
  return;
}
```

Use the repository's existing UUID helper instead of `crypto.randomUUID()` if `/Users/pt/cat-code/src/main.tsx` already imports a local UUID generator in nearby startup code. The token must not be printed and must not be appended to the browser URL.

- [ ] **Step 5: Keep terminal mode launch unchanged**

Where terminal mode calls `launchRepl(root, ...)`, keep existing arguments and branches unchanged except for replacing any duplicated state store with the shared `appStateStore` from Step 2. Terminal mode must still mount Ink and call `launchRepl(...)` when `webModeEnabled` is false.

- [ ] **Step 6: Run focused startup extraction checks**

Run:

```bash
cd /Users/pt/cat-code && bun test src/app-runtime/createQueryEngineAppSessionConfigFromSetup.test.ts src/web/launchWebAppDevServer.test.ts src/web/startRuntimeBackedWebMode.test.ts
cd /Users/pt/cat-code && rg -n "startWebUIServer|Web mode is browser-first|Browser input is intentionally disabled" src/main.tsx
cd /Users/pt/cat-code && rg -n "startRuntimeBackedWebMode|createQueryEngineAppSessionConfigFromSetup|launchRepl\(" src/main.tsx
```

Expected result: tests pass; the legacy disabled-input strings are absent; `startRuntimeBackedWebMode(...)` appears before terminal `launchRepl(...)` branches in the startup flow.

## Task 5: Complete Phase 1B Permission Coverage

**Files:**
- Modify as needed: `/Users/pt/cat-code/src/app-runtime/appRuntimeCanUseTool.test.ts`
- Modify as needed: `/Users/pt/cat-code/src/app-runtime/appRuntimeCanUseTool.ts`
- Modify as needed: `/Users/pt/cat-code/src/web/AppSessionWebSocketServer.test.ts`
- Modify as needed: `/Users/pt/cat-code/src/web/AppSessionWebSocketServer.ts`
- Modify as needed: `/Users/pt/cat-code/src/web/appSessionProtocol.ts`
- Modify as needed: `/Users/pt/cat-code/web/src/appProtocol.ts`
- Modify as needed: `/Users/pt/cat-code/web/src/appState.test.ts`
- Modify as needed: `/Users/pt/cat-code/web/src/appState.ts`
- Modify as needed: `/Users/pt/cat-code/web/src/App.tsx`
- Read: `/Users/pt/cat-code/docs/design/dedicated-app/migration-scope.md:159-173`

- [ ] **Step 1: Extend app-runtime permission tests for cancel, updated input, worker identity, and sandbox/network metadata**

Add this test to `/Users/pt/cat-code/src/app-runtime/appRuntimeCanUseTool.test.ts`:

```ts
test('preserves permission metadata and maps cancel to deny with interrupt', async () => {
  const baseCanUseTool: CanUseToolFn = async () => ({
    behavior: 'ask',
    message: 'Need sandboxed network approval',
    updatedInput: { command: 'curl https://example.com' },
    suggestions: [
      {
        type: 'permission_rule',
        ruleValue: 'Bash(curl https://example.com)',
        ruleDisplay: 'Bash curl https://example.com',
        behavior: 'allow',
        destination: 'project',
        metadata: {
          sandbox: 'workspace-write',
          network: true,
        },
      },
    ],
  } as never)
  const requests: unknown[] = []
  const canUseTool = createAppRuntimeCanUseTool({
    baseCanUseTool,
    createRequestId: () => 'request-1',
    getPermissionRequestHandler: () => async request => {
      requests.push(request)
      return {
        behavior: 'deny',
        message: 'cancelled in browser',
        interrupt: true,
        updatedInput: request.request.input,
      }
    },
  })

  const decision = await canUseTool(
    { name: 'Bash' } as Tool,
    { command: 'curl https://example.com' },
    { agentId: 'worker-7' } as ToolUseContext,
    {} as AssistantMessage,
    'toolu_7',
  )

  expect(requests).toEqual([
    {
      requestId: 'request-1',
      request: expect.objectContaining({
        tool_name: 'Bash',
        input: { command: 'curl https://example.com' },
        agent_id: 'worker-7',
        permission_suggestions: [
          expect.objectContaining({
            metadata: expect.objectContaining({
              sandbox: 'workspace-write',
              network: true,
            }),
          }),
        ],
      }),
    },
  ])
  expect(decision).toMatchObject({
    behavior: 'deny',
    interrupt: true,
    updatedInput: { command: 'curl https://example.com' },
  })
})
```

- [ ] **Step 2: Run the permission runtime test**

Run:

```bash
cd /Users/pt/cat-code && bun test src/app-runtime/appRuntimeCanUseTool.test.ts
```

Expected result: pass if existing metadata is already preserved; otherwise fail on the exact missing field.

- [ ] **Step 3: Patch app-runtime permission request mapping only if Step 2 fails**

If the test fails because metadata is dropped, update `/Users/pt/cat-code/src/app-runtime/appRuntimeCanUseTool.ts` so the request object is created with the existing fields intact:

```ts
const request = {
  subtype: 'can_use_tool' as const,
  tool_name: tool.name,
  input: decision.updatedInput ?? input,
  permission_suggestions: decision.suggestions ?? [],
  blocked_path: decision.blockedPath,
  decision_reason: decision.message,
  tool_use_id: toolUseId,
  agent_id: context.agentId,
}
```

Then rerun:

```bash
cd /Users/pt/cat-code && bun test src/app-runtime/appRuntimeCanUseTool.test.ts
```

Expected result: pass.

- [ ] **Step 4: Add server protocol coverage for persistent updates, replay, and stale ids**

Add this complete executable test to `/Users/pt/cat-code/src/web/AppSessionWebSocketServer.test.ts`:

```ts
test('replays pending permissions and rejects stale permission ids', async () => {
  let permissionResponse: unknown
  let releaseTurn: (() => void) | undefined
  const turnReleased = new Promise<void>(resolve => {
    releaseTurn = resolve
  })

  const controller = new AppSessionController({
    async *runTurn({ onPermissionRequest }) {
      permissionResponse = await onPermissionRequest({
        requestId: 'perm-replay',
        request: {
          subtype: 'can_use_tool',
          tool_name: 'Bash',
          display_name: 'Run shell command',
          input: { command: 'pwd' },
          tool_use_id: 'toolu_replay',
          agent_id: 'worker-1',
          blocked_path: '/repo',
          decision_reason: 'Need shell approval',
          permission_suggestions: [
            {
              type: 'permission_rule',
              ruleValue: 'Bash(pwd)',
              ruleDisplay: 'Bash pwd',
              behavior: 'allow',
              destination: 'project',
              metadata: { sandbox: 'read-only', network: false },
            },
          ],
        } as never,
      })
      await turnReleased
    },
  })

  const server = await startAppSessionWebSocketServer({
    port: 0,
    token: 'secret',
    allowedOrigins: ['http://localhost:5173'],
    controller,
  })
  servers.push(server)

  const firstClient = await connect(`ws://127.0.0.1:${server.port}/ws`, 'secret')
  await nextJson(firstClient)
  firstClient.send(
    JSON.stringify({ type: 'app.submit', requestId: 'submit-1', prompt: 'hi' }),
  )
  expect(await nextJson(firstClient)).toEqual({
    type: 'app.ack',
    requestId: 'submit-1',
  })
  expect(await nextJson(firstClient)).toEqual({
    type: 'app.event',
    event: { type: 'status.update', activeTurn: true, inputEnabled: false },
  })
  expect(await nextJson(firstClient)).toMatchObject({
    type: 'app.event',
    event: {
      type: 'permission.requested',
      request: {
        requestId: 'perm-replay',
        request: {
          display_name: 'Run shell command',
          tool_name: 'Bash',
          agent_id: 'worker-1',
          blocked_path: '/repo',
          decision_reason: 'Need shell approval',
          input: { command: 'pwd' },
          permission_suggestions: [
            expect.objectContaining({
              metadata: expect.objectContaining({ sandbox: 'read-only', network: false }),
            }),
          ],
        },
      },
    },
  })

  const reconnectClient = await connect(`ws://127.0.0.1:${server.port}/ws`, 'secret')
  expect(await nextJson(reconnectClient)).toMatchObject({
    type: 'app.ready',
    pendingPermissionRequests: [
      expect.objectContaining({
        requestId: 'perm-replay',
        request: expect.objectContaining({ agent_id: 'worker-1' }),
      }),
    ],
  })

  reconnectClient.send(
    JSON.stringify({
      type: 'permission.response',
      requestId: 'perm-replay',
      response: {
        behavior: 'allow',
        updatedInput: { command: 'pwd' },
        updatedPermissions: [
          {
            type: 'permission_rule',
            ruleValue: 'Bash(pwd)',
            destination: 'project',
            behavior: 'allow',
          },
        ],
      },
    }),
  )
  expect(await nextJson(reconnectClient)).toEqual({
    type: 'app.ack',
    requestId: 'perm-replay',
  })
  expect(await nextJson(reconnectClient)).toMatchObject({
    type: 'app.event',
    event: {
      type: 'permission.resolved',
      requestId: 'perm-replay',
    },
  })
  expect(permissionResponse).toMatchObject({
    behavior: 'allow',
    updatedInput: { command: 'pwd' },
    updatedPermissions: [expect.objectContaining({ ruleValue: 'Bash(pwd)' })],
  })

  reconnectClient.send(
    JSON.stringify({
      type: 'permission.response',
      requestId: 'stale-perm',
      response: { behavior: 'deny', message: 'stale' },
    }),
  )
  expect(await nextJson(reconnectClient)).toMatchObject({
    type: 'app.error',
    requestId: 'stale-perm',
    code: 'permission_not_found',
    retryable: false,
  })

  releaseTurn?.()
  await Promise.all([closeWebSocket(firstClient), closeWebSocket(reconnectClient)])
})
```

- [ ] **Step 5: Run server permission tests**

Run:

```bash
cd /Users/pt/cat-code && bun test src/web/AppSessionWebSocketServer.test.ts
```

Expected result: pass if the server already carries these fields; otherwise fail on the precise schema or handoff gap.

- [ ] **Step 6: Patch protocol schemas only if Step 5 fails on wire shape**

If schema parsing strips or rejects `updatedInput`, `updatedPermissions`, `agent_id`, or suggestion metadata, update `/Users/pt/cat-code/src/web/appSessionProtocol.ts` and `/Users/pt/cat-code/web/src/appProtocol.ts` to accept the explicit fields:

```ts
const permissionRuleUpdateSchema = z.object({
  type: z.literal('permission_rule'),
  ruleValue: z.string(),
  ruleDisplay: z.string().optional(),
  destination: z.enum(['user', 'project', 'local']).optional(),
  behavior: z.enum(['allow', 'deny', 'ask']).optional(),
  metadata: z
    .object({
      sandbox: z.string().optional(),
      network: z.boolean().optional(),
    })
    .passthrough()
    .optional(),
})

const permissionResponseSchema = z.object({
  behavior: z.enum(['allow', 'deny']),
  message: z.string().optional(),
  interrupt: z.boolean().optional(),
  updatedInput: z.unknown().optional(),
  updatedPermissions: z.array(permissionRuleUpdateSchema).optional(),
})
```

Then rerun:

```bash
cd /Users/pt/cat-code && bun test src/web/appSessionProtocol.test.ts src/web/AppSessionWebSocketServer.test.ts
cd /Users/pt/cat-code && bun --cwd web test
```

Expected result: pass.

- [ ] **Step 7: Confirm browser state preserves and UI reads permission display fields**

Add this concrete reducer test to `/Users/pt/cat-code/web/src/appState.test.ts`:

```ts
test('preserves pending permission display fields for the browser panel', () => {
  let state = createInitialAppState();
  state = reduceAppServerMessage(state, {
    type: 'app.event',
    event: {
      type: 'permission.requested',
      request: {
        requestId: 'perm-1',
        request: {
          subtype: 'can_use_tool',
          tool_name: 'Bash',
          display_name: 'Run shell command',
          input: { command: 'pwd' },
          permission_suggestions: [
            {
              type: 'permission_rule',
              ruleValue: 'Bash(pwd)',
              ruleDisplay: 'Bash pwd',
              behavior: 'allow',
              destination: 'project',
              metadata: { sandbox: 'read-only', network: false },
            },
          ],
          blocked_path: '/repo',
          decision_reason: 'Need shell approval',
          tool_use_id: 'toolu_1',
          agent_id: 'worker-1',
        },
      },
    },
  });

  expect(state.pendingPermissions).toEqual([
    {
      requestId: 'perm-1',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Bash',
        display_name: 'Run shell command',
        input: { command: 'pwd' },
        permission_suggestions: [
          expect.objectContaining({
            ruleValue: 'Bash(pwd)',
            metadata: expect.objectContaining({
              sandbox: 'read-only',
              network: false,
            }),
          }),
        ],
        blocked_path: '/repo',
        decision_reason: 'Need shell approval',
        tool_use_id: 'toolu_1',
        agent_id: 'worker-1',
      },
    },
  ]);
});
```

If `/Users/pt/cat-code/web/src/App.tsx` does not display sandbox/network metadata yet, add this helper above `export function App()`:

```tsx
function permissionSuggestionLabels(permissionSuggestions?: unknown[]) {
  return (permissionSuggestions ?? []).flatMap(suggestion => {
    if (typeof suggestion !== 'object' || suggestion === null) return [];
    const metadata = (suggestion as { metadata?: unknown }).metadata;
    if (typeof metadata !== 'object' || metadata === null) return [];
    const sandbox = (metadata as { sandbox?: unknown }).sandbox;
    const network = (metadata as { network?: unknown }).network;
    const labels: string[] = [];
    if (typeof sandbox === 'string') labels.push(`Sandbox: ${sandbox}`);
    if (typeof network === 'boolean') {
      labels.push(network ? 'Network: requested' : 'Network: not requested');
    }
    return labels;
  });
}
```

Then add these labels inside the existing permission metadata row in `/Users/pt/cat-code/web/src/App.tsx`, immediately after the `blocked_path` span:

```tsx
{permissionSuggestionLabels(pendingPermission.request.permission_suggestions).map(label => (
  <span key={label}>{label}</span>
))}
```

Run:

```bash
cd /Users/pt/cat-code && bun --cwd web test
```

Expected result: pass. Manual smoke in Task 8 must verify the permission panel visibly shows the display name or tool name, worker id from `agent_id`, blocked path, decision reason, JSON input, and sandbox/network labels when the runtime includes those fields.

## Task 6: Add Web Smoke Script Or Manual Checklist

**Files:**
- Modify: `/Users/pt/cat-code/package.json` only if adding a script is preferred by the implementer.
- Otherwise no source file change is required for this task.

- [ ] **Step 1: Choose script or manual checklist**

Use the manual checklist below unless a package script is needed for repeatable local smoke. Do not add a script that launches a long-running server in CI.

Manual smoke checklist:

```markdown
1. Run: `cd /Users/pt/cat-code && bun run dev -- --web`
2. Confirm terminal prints `App session WebSocket listening on ws://127.0.0.1:3456/ws`.
3. Confirm terminal prints `Web mode is runtime-backed: skipping the Ink REPL.`
4. Confirm the opened browser URL is `http://127.0.0.1:5173` with no query string token.
5. Type `Say hello from the runtime-backed app session` in the browser composer.
6. Confirm the browser receives streamed assistant text through `app.event` messages.
7. Trigger a permission request with a harmless command prompt such as `run pwd`.
8. Deny the request in the browser and confirm the terminal process stays alive.
9. Refresh the browser during a pending permission request and confirm the request is replayed.
10. Stop the terminal process with Ctrl-C and confirm the Vite child process exits.
```

- [ ] **Step 2: If adding a local script, use this exact package script**

If a script is added, modify `/Users/pt/cat-code/package.json` scripts with:

```json
{
  "smoke:web": "bun run dev -- --web"
}
```

Run the script manually only; it is intentionally long-running:

```bash
cd /Users/pt/cat-code && bun run smoke:web
```

Expected result: same checklist as Step 1.

## Task 7: Verify Terminal Mode Still Reaches `launchRepl()`

**Files:**
- Modify only if needed: `/Users/pt/cat-code/src/main.tsx`

- [ ] **Step 1: Inspect routing order after edits**

Run:

```bash
cd /Users/pt/cat-code && rg -n "webModeEnabled|startRuntimeBackedWebMode|launchRepl\(" src/main.tsx
```

Expected result: `webModeEnabled` is declared early, `startRuntimeBackedWebMode(...)` is inside an `if (webModeEnabled)` branch after normal setup/AppState config assembly, and existing `launchRepl(...)` calls remain reachable when `webModeEnabled` is false.

- [ ] **Step 2: Run the normal terminal startup manually**

Run:

```bash
cd /Users/pt/cat-code && bun run dev
```

Expected result: the normal terminal UI launches through Ink. Exit without starting a long coding task.

- [ ] **Step 3: Verify no legacy web relay path remains in startup**

Run:

```bash
cd /Users/pt/cat-code && rg -n "startWebUIServer|WebSocketServer.js|Browser input is intentionally disabled|Web mode is browser-first" src/main.tsx src/web
```

Expected result: no `src/main.tsx` startup match for the legacy disabled-input path. Matches inside legacy relay files are acceptable only if those files remain for non-startup compatibility.

## Task 8: Final Automated Verification

**Files:**
- No new edits unless a check fails and the root cause is inside the Phase 1B files.

- [ ] **Step 1: Run app-runtime and web server tests**

Run:

```bash
cd /Users/pt/cat-code && bun test src/app-runtime/*.test.ts src/web/*.test.ts
```

Expected result: pass.

- [ ] **Step 2: Run browser tests**

Run:

```bash
cd /Users/pt/cat-code && bun --cwd web test
```

Expected result: pass.

- [ ] **Step 3: Run browser typecheck**

Run:

```bash
cd /Users/pt/cat-code && bun --cwd web run typecheck
```

Expected result: pass.

- [ ] **Step 4: Run browser production build**

Run:

```bash
cd /Users/pt/cat-code && bun --cwd web run build
```

Expected result: pass.

- [ ] **Step 5: Run full documented build**

Run:

```bash
cd /Users/pt/cat-code && bun run build:dev:full
```

Expected result: pass.

- [ ] **Step 6: Run the manual web smoke**

Run:

```bash
cd /Users/pt/cat-code && bun run dev -- --web
```

Expected result:

```text
App session WebSocket listening on ws://127.0.0.1:3456/ws
Web mode is runtime-backed: skipping the Ink REPL.
```

Checklist:

- Browser opens `http://127.0.0.1:5173` without a token query parameter.
- Browser input is enabled after `app.ready`.
- A prompt submitted from the browser produces streamed app-runtime messages.
- Permission allow, deny, cancel-as-deny-with-interrupt, updated input, and persistent permission update flows complete from the browser.
- Worker identity from `agent_id` is visible when a worker-owned permission request is shown.
- Sandbox and network metadata are visible when present in permission suggestions or decision metadata.
- A pending permission request reappears after browser reconnect.
- A stale permission request id receives `permission_not_found` and does not resolve a current request.
- Ctrl-C stops the main process and the Vite child process.

- [ ] **Step 7: Run the manual terminal smoke**

Run:

```bash
cd /Users/pt/cat-code && bun run dev
```

Expected result: terminal mode launches the Ink REPL through `launchRepl(...)` and does not start the runtime-backed web server.

- [ ] **Step 8: Check diff hygiene**

Run:

```bash
cd /Users/pt/cat-code && git diff --check
cd /Users/pt/cat-code && git status --short
```

Expected result: whitespace check passes; `git status --short` shows only Phase 1B files changed plus any unrelated preexisting files that must not be staged.

## Task 9: Commit Phase 1B Implementation

**Files:**
- Commit only Phase 1B implementation files.

- [ ] **Step 1: Review the exact staged set**

Run:

```bash
cd /Users/pt/cat-code && git status --short
cd /Users/pt/cat-code && git diff -- src/main.tsx src/app-runtime/createQueryEngineAppSessionConfigFromSetup.ts src/app-runtime/createQueryEngineAppSessionConfigFromSetup.test.ts src/web/launchWebAppDevServer.ts src/web/launchWebAppDevServer.test.ts src/web/startRuntimeBackedWebMode.ts src/web/startRuntimeBackedWebMode.test.ts src/app-runtime/appRuntimeCanUseTool.ts src/app-runtime/appRuntimeCanUseTool.test.ts src/web/AppSessionWebSocketServer.ts src/web/AppSessionWebSocketServer.test.ts src/web/appSessionProtocol.ts web/src/appProtocol.ts web/src/appState.ts web/src/appState.test.ts package.json
```

Expected result: no unrelated docs/maps/source changes are included.

- [ ] **Step 2: Stage only Phase 1B files**

Run one `git add` command with the exact files changed by the implementation. Example for the full expected set:

```bash
cd /Users/pt/cat-code && git add src/main.tsx src/app-runtime/createQueryEngineAppSessionConfigFromSetup.ts src/app-runtime/createQueryEngineAppSessionConfigFromSetup.test.ts src/web/launchWebAppDevServer.ts src/web/launchWebAppDevServer.test.ts src/web/startRuntimeBackedWebMode.ts src/web/startRuntimeBackedWebMode.test.ts src/app-runtime/appRuntimeCanUseTool.ts src/app-runtime/appRuntimeCanUseTool.test.ts src/web/AppSessionWebSocketServer.ts src/web/AppSessionWebSocketServer.test.ts src/web/appSessionProtocol.ts web/src/appProtocol.ts web/src/appState.ts web/src/appState.test.ts package.json
```

If `package.json` or protocol files did not change, omit them from the command rather than staging unchanged files.

- [ ] **Step 3: Commit**

Run:

```bash
cd /Users/pt/cat-code && git commit -m "feat: wire runtime-backed web startup"
```

Expected result: commit succeeds without bypassing hooks.

## Self-Review Checklist For Plan Executors

- Every Phase 1B code task starts with a focused failing test or source inspection that explains why the edit is safe.
- The final `--web` path uses normal `setup(...)`, commands, agents, MCP clients/tools/commands, permission mode, AppState, and QueryEngine config owners.
- The browser token is passed with `VITE_CAT_CODE_WS_TOKEN` and the opened URL never contains the token.
- Runtime-backed web mode starts `startAppSessionWebSocketServer(...)`, not `startWebUIServer(...)`.
- Ink `launchRepl(...)` is skipped only after the runtime-backed server and browser launcher are ready.
- Terminal mode still reaches existing `launchRepl(...)` branches when `--web` is false.
- Permission coverage includes cancel as `behavior: "deny"` with `interrupt: true`, updated input, `updatedPermissions`, worker identity from `agent_id`, sandbox/network distinction, pending replay after reconnect, and stale permission id rejection.
- Final checks include `bun test src/app-runtime/*.test.ts src/web/*.test.ts`, `bun --cwd web test`, `bun --cwd web run typecheck`, `bun --cwd web run build`, `bun run build:dev:full`, manual `bun run dev -- --web`, and manual terminal startup.
