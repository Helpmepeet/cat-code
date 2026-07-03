# P1-1 Connection Handshake Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Start the desktop sidecar with a real QueryEngine-backed `AppSessionController`, deliver the canonical `app.ready` payload over the existing IPC path, and render only `connecting` or `ready` from that payload.

**Architecture:** Keep the P1-0 socket, framing, supervisor, replay buffer, preload bridge, validation, and error behavior unchanged. Add the missing canonical discriminant to the ready payload, construct the normal sidecar controller through the existing QueryEngine app-session setup builder, retain the fixture controller only behind `CATCODE_SIDECAR_PROBE=1`, and make the renderer transition only after runtime validation of both ready discriminants.

**Tech Stack:** Bun, TypeScript, Electron, React 19, Vite, Bun test.

---

## File Structure

- Modify `src/web/appSessionProtocol.ts`: make the canonical `AppReadyPayload` include `type: 'app.ready'`.
- Modify `app/shared/engine-types.snapshot.d.ts`: synchronize the desktop snapshot of `AppReadyPayload`.
- Modify `app/sidecar/sidecarServer.ts`: place `type: 'app.ready'` inside the ready frame payload.
- Create `app/sidecar/sessionController.ts`: own probe-versus-real controller construction and the temporary P1-1 cwd.
- Modify `app/sidecar/index.ts`: select the controller factory result and keep probe submission conditional.
- Create `app/sidecar/sessionController.test.ts`: construct the real controller without credentials or a turn and preserve the explicit probe path.
- Modify `app/sidecar/sidecarServer.test.ts`: assert the canonical ready payload.
- Modify `app/sidecar/roundtrip.probe.test.ts`: assert the real no-probe sidecar payload and absence of fixture events.
- Create `app/renderer/src/connectionState.ts`: validate ready frames at runtime.
- Create `app/renderer/src/connectionState.test.ts`: cover valid, unrelated, and malformed frames.
- Modify `app/renderer/src/App.tsx`: render only the connection state while preserving subscribe-before-`rendererReady`.
- Create `app/main/mainSource.test.ts`: prevent normal Electron startup from opting into the probe.
- Modify `app/main/main.ts`: remove the normal-startup probe flag and make the existing smoke hook print the observed initial ready payload.
- Modify `docs/migration/STATUS.md`: mark P1-1 complete and record the temporary hardcoded cwd.

### Task 1: Canonicalize the ready payload discriminant

**Files:**
- Modify: `app/sidecar/sidecarServer.test.ts`
- Modify: `src/web/appSessionProtocol.ts`
- Modify: `app/shared/engine-types.snapshot.d.ts`
- Modify: `app/sidecar/sidecarServer.ts`

- [ ] **Step 1: Tighten the existing attach test**

Change the ready-frame test in `app/sidecar/sidecarServer.test.ts` to assert the full controller-derived payload:

```ts
test('on attach, the server sends the canonical controller-derived app.ready payload', () => {
  const server = makeServer(new AppSessionController(probeAdapter()))
  const { socket, received } = makeSocket()

  server.addConnection(socket)

  expect(received[0]).toEqual({
    kind: 'ready',
    protocolVersion: PROTOCOL_VERSION,
    sessionId: SESSION,
    payload: {
      type: 'app.ready',
      protocolVersion: PROTOCOL_VERSION,
      inputEnabled: true,
      activeTurn: false,
      abort: { status: 'idle' },
      goalSnapshot: null,
      pendingPermissionRequests: [],
    },
  })
})
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
bun test app/sidecar/sidecarServer.test.ts
```

Expected: FAIL because `payload.type` is missing.

- [ ] **Step 3: Add the discriminant to the canonical type and desktop snapshot**

Update `AppReadyPayload` in both `src/web/appSessionProtocol.ts` and `app/shared/engine-types.snapshot.d.ts`:

```ts
export type AppReadyPayload = {
  type: 'app.ready'
  protocolVersion: 1
  inputEnabled: boolean
  activeTurn: boolean
  abort: AppSessionAbortState
  goalSnapshot: AppGoalSnapshot
  pendingPermissionRequests: AppPermissionRequest[]
}
```

This matches the current canonical WebSocket message emitted by `src/web/AppSessionWebSocketServer.ts`.

- [ ] **Step 4: Emit the canonical payload**

Add the discriminant in `SidecarServer.addConnection()`:

```ts
payload: {
  type: 'app.ready',
  protocolVersion: PROTOCOL_VERSION,
  inputEnabled: !this.activeTurn,
  activeTurn: this.activeTurn,
  abort: this.controller.getAbortState(),
  goalSnapshot: this.controller.getGoalSnapshot(),
  pendingPermissionRequests: this.controller.getPendingPermissionRequests(),
},
```

- [ ] **Step 5: Run the focused test and verify GREEN**

Run:

```bash
bun test app/sidecar/sidecarServer.test.ts
```

Expected: all tests pass.

### Task 2: Construct the normal sidecar controller through the real QueryEngine builder

**Files:**
- Create: `app/sidecar/sessionController.test.ts`
- Create: `app/sidecar/sessionController.ts`
- Modify: `app/sidecar/index.ts`
- Modify: `app/sidecar/roundtrip.probe.test.ts`

- [ ] **Step 1: Add a credential-free real-controller construction test**

Create `app/sidecar/sessionController.test.ts`:

```ts
import { expect, test } from 'bun:test'
import { AppSessionController } from '../../src/app-runtime/AppSessionController.js'
import {
  P1_1_CWD,
  createSidecarSessionController,
} from './sessionController.js'

test('normal startup constructs a real runtime-backed controller without starting a turn', () => {
  const controller = createSidecarSessionController({ probe: false })

  expect(controller).toBeInstanceOf(AppSessionController)
  expect(P1_1_CWD).toBe('/Users/pt/cat-code')
  expect(controller.getAbortState()).toEqual({ status: 'idle' })
  expect(controller.getGoalSnapshot()).toBeNull()
  expect(controller.getPendingPermissionRequests()).toEqual([])
})
```

This intentionally does not call `submit()`: construction and the ready handshake require no credentials.

- [ ] **Step 2: Run the construction test and verify RED**

Run:

```bash
bun test app/sidecar/sessionController.test.ts
```

Expected: FAIL because `sessionController.ts` does not exist.

- [ ] **Step 3: Add the focused sidecar controller factory**

Create `app/sidecar/sessionController.ts`:

```ts
import { AppSessionController } from '../../src/app-runtime/AppSessionController.js'
import { createQueryEngineAppSessionConfigFromSetup } from '../../src/app-runtime/createQueryEngineAppSessionConfigFromSetup.js'
import { createQueryEngineSessionController } from '../../src/app-runtime/createQueryEngineSessionController.js'
import { createRuntimeBackedWebAppSession } from '../../src/app-runtime/createRuntimeBackedWebAppSession.js'
import { getDefaultAppState } from '../../src/state/AppStateStore.js'
import { createStore } from '../../src/state/store.js'
import {
  createFileStateCacheWithSizeLimit,
  READ_FILE_STATE_CACHE_SIZE,
} from '../../src/utils/fileStateCache.js'
import { createProbeAdapter } from './probeAdapter.js'

export const P1_1_CWD = '/Users/pt/cat-code'

export function createSidecarSessionController({
  probe,
}: {
  probe: boolean
}): AppSessionController {
  if (probe) {
    return createQueryEngineSessionController({
      submitMessage(prompt, options) {
        return createProbeAdapter().runTurn({
          prompt,
          options: { uuid: options?.uuid, isMeta: options?.isMeta },
          signal: new AbortController().signal,
          onPermissionRequest: async () => ({
            behavior: 'deny',
            message: 'probe: no permission handler',
          }),
        })
      },
    })
  }

  const appStateStore = createStore(getDefaultAppState())
  const queryEngineConfig = createQueryEngineAppSessionConfigFromSetup({
    cwd: P1_1_CWD,
    tools: [],
    commands: [],
    mcpTools: [],
    mcpCommands: [],
    mcpClients: [],
    mcpResources: {},
    agents: [],
    getAppState: appStateStore.getState,
    setAppState: appStateStore.setState,
    readFileCache: createFileStateCacheWithSizeLimit(
      READ_FILE_STATE_CACHE_SIZE,
    ),
  })

  return createRuntimeBackedWebAppSession({ queryEngineConfig })
}
```

The empty arrays are the correct real values for P1-1's tool/command/MCP/agent collections. The remainder is real state and cache infrastructure assembled by the proven setup builder. Do not add model, provider, credential, or permissive `canUseTool` fields: `createQueryEngineAppSession()` installs `createAppRuntimeCanUseTool()` when the runtime-backed session is built.

- [ ] **Step 4: Replace inline controller construction in the entrypoint**

In `app/sidecar/index.ts`, remove the direct imports of `createQueryEngineSessionController`, `AppSessionController`, and `createProbeAdapter`. Import the factory:

```ts
import { createSidecarSessionController } from './sessionController.js'
```

Replace the inline controller block with:

```ts
const controller = createSidecarSessionController({
  probe: args.probeOnAttach,
})
```

Leave the existing `if (args.probeOnAttach) controller.submit(...)` block intact so only explicit probe runs emit the fixture.

- [ ] **Step 5: Run the construction test and sidecar typecheck**

Run:

```bash
bun test app/sidecar/sessionController.test.ts
bunx tsc --noEmit -p app/sidecar/tsconfig.json
```

Expected: both commands pass. The typecheck confirms the complete config reaches `QueryEngineAppSessionConfig`; source inspection of `createQueryEngineAppSession.ts` confirms its engine config always replaces any optional base handler with `createAppRuntimeCanUseTool()`.

- [ ] **Step 6: Strengthen the real-process no-probe integration test**

In `app/sidecar/roundtrip.probe.test.ts`, change the first test to start the sidecar without `CATCODE_SIDECAR_PROBE`, then assert the complete payload:

```ts
test('normal sidecar starts a real engine session and emits app.ready without a fixture event', async () => {
  supervisor = new SidecarSupervisor({
    sidecarCommand: 'bun',
    sidecarArgs: ['run', sidecarEntry],
  })
  const sessionId = supervisor.spawnSession('p1-1-real-ready')
  const events: ServerFrame[] = []
  const unsubscribe = supervisor.subscribe(event => {
    if (event.type === 'frame' && event.frame.kind === 'event') {
      events.push(event.frame)
    }
  })

  const ready = await waitForFrame(supervisor, frame => frame.kind === 'ready')
  expect(ready).toEqual({
    kind: 'ready',
    protocolVersion: 1,
    sessionId,
    payload: {
      type: 'app.ready',
      protocolVersion: 1,
      inputEnabled: true,
      activeTurn: false,
      abort: { status: 'idle' },
      goalSnapshot: null,
      pendingPermissionRequests: [],
    },
  })

  await Bun.sleep(200)
  unsubscribe()
  expect(events).toEqual([])
})
```

- [ ] **Step 7: Run the real-process test**

Run:

```bash
bun test app/sidecar/roundtrip.probe.test.ts
```

Expected: all tests pass. The explicit probe test must still observe the fixture `tool_use`; the normal-startup test must observe no event.

### Task 3: Gate readiness in the renderer and remove the normal startup probe

**Files:**
- Create: `app/renderer/src/connectionState.test.ts`
- Create: `app/renderer/src/connectionState.ts`
- Modify: `app/renderer/src/App.tsx`
- Create: `app/main/mainSource.test.ts`
- Modify: `app/main/main.ts`

- [ ] **Step 1: Add runtime ready-frame validation tests**

Create `app/renderer/src/connectionState.test.ts`:

```ts
import { expect, test } from 'bun:test'
import { isAppReadyFrame } from './connectionState.js'

const validReady = {
  kind: 'ready',
  protocolVersion: 1,
  sessionId: 'session-1',
  payload: {
    type: 'app.ready',
    protocolVersion: 1,
    inputEnabled: true,
    activeTurn: false,
    abort: { status: 'idle' },
    goalSnapshot: null,
    pendingPermissionRequests: [],
  },
}

test('accepts only a ready frame carrying an app.ready payload', () => {
  expect(isAppReadyFrame(validReady)).toBe(true)
})

test('rejects unrelated and malformed frames', () => {
  expect(isAppReadyFrame({ ...validReady, kind: 'event' })).toBe(false)
  expect(
    isAppReadyFrame({
      ...validReady,
      payload: { ...validReady.payload, type: 'app.pong' },
    }),
  ).toBe(false)
  expect(isAppReadyFrame({ kind: 'ready' })).toBe(false)
  expect(isAppReadyFrame(null)).toBe(false)
})
```

- [ ] **Step 2: Run the renderer test and verify RED**

Run:

```bash
bun test app/renderer/src/connectionState.test.ts
```

Expected: FAIL because `connectionState.ts` does not exist.

- [ ] **Step 3: Implement the narrow runtime guard**

Create `app/renderer/src/connectionState.ts`:

```ts
import type { ReadyFrame } from '../../shared/protocol.js'

export function isAppReadyFrame(frame: unknown): frame is ReadyFrame {
  if (typeof frame !== 'object' || frame === null) return false
  const candidate = frame as {
    kind?: unknown
    payload?: { type?: unknown }
  }
  return (
    candidate.kind === 'ready' &&
    typeof candidate.payload === 'object' &&
    candidate.payload !== null &&
    candidate.payload.type === 'app.ready'
  )
}
```

- [ ] **Step 4: Reduce the renderer to connection state only**

Replace `app/renderer/src/App.tsx` with:

```tsx
import { useEffect, useState } from 'react'
import { getBridge } from './bridge.js'
import { isAppReadyFrame } from './connectionState.js'

type ConnectionState = 'connecting' | 'ready'

export function App() {
  const [connectionState, setConnectionState] =
    useState<ConnectionState>('connecting')

  useEffect(() => {
    const bridge = getBridge()
    const unsubscribe = bridge.subscribe(frame => {
      if (isAppReadyFrame(frame)) {
        setConnectionState('ready')
      }
    })
    bridge.rendererReady()
    return unsubscribe
  }, [])

  return (
    <main className="min-h-screen bg-app-bg text-text-primary font-sans p-8">
      {connectionState}
    </main>
  )
}
```

This preserves the P1-0 ordering contract: subscribe first, then call `rendererReady()`.

- [ ] **Step 5: Run the renderer test and build**

Run:

```bash
bun test app/renderer/src/connectionState.test.ts
bun run --cwd app renderer:build
```

Expected: test passes and Vite build exits 0.

- [ ] **Step 6: Add a regression test for Electron's normal startup environment**

Create `app/main/mainSource.test.ts`:

```ts
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

test('normal Electron startup does not opt into the sidecar probe', () => {
  const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8')
  const createSupervisorStart = source.indexOf(
    'function createSupervisor(): SidecarSupervisor',
  )
  const createSupervisorEnd = source.indexOf(
    'function applySecurityBaseline(): void',
  )
  const createSupervisorSource = source.slice(
    createSupervisorStart,
    createSupervisorEnd,
  )

  expect(createSupervisorSource).not.toContain('CATCODE_SIDECAR_PROBE')
})
```

- [ ] **Step 7: Run the startup regression test and verify RED**

Run:

```bash
bun test app/main/mainSource.test.ts
```

Expected: FAIL because normal startup still sets `CATCODE_SIDECAR_PROBE=1`.

- [ ] **Step 8: Remove the normal-startup probe opt-in**

In `app/main/main.ts`, remove:

```ts
sidecarEnv: { CATCODE_SIDECAR_PROBE: '1' },
```

Do not change `SidecarSupervisor` environment forwarding. Explicit probes such as the P1-0 F2 harness must remain able to set `CATCODE_SIDECAR_PROBE=1`.

- [ ] **Step 9: Make the existing smoke hook report the observed ready payload**

Inside the `CATCODE_SMOKE_EXIT_MS` subscriber in `app/main/main.ts`, print the initial payload without changing frame delivery:

```ts
if (event.type === 'frame') {
  if (event.frame.kind === 'ready') {
    process.stdout.write(
      `[main-smoke] ready ${JSON.stringify(event.frame.payload)}\n`,
    )
  } else {
    process.stdout.write(`[main-smoke] frame ${event.frame.kind}\n`)
  }
}
```

The normal smoke must not print `event message`; that would indicate the fixture path leaked into normal startup.

- [ ] **Step 10: Run the startup regression test and app typecheck**

Run:

```bash
bun test app/main/mainSource.test.ts
bun run --cwd app typecheck
```

Expected: both commands pass.

### Task 4: Verify the whole P1-1 path and update migration status

**Files:**
- Modify: `docs/migration/STATUS.md`

- [ ] **Step 1: Run all desktop tests**

Run:

```bash
bun test app/
```

Expected: all tests pass, including the explicit P1-0 probe tests and the new P1-1 real-session tests.

- [ ] **Step 2: Run both desktop typecheck boundaries**

Run:

```bash
bun run --cwd app typecheck
bunx tsc --noEmit -p app/sidecar/tsconfig.json
```

Expected: both pass. The first checks the snapshot-isolated Electron/preload/renderer graph; the second checks the real engine-adjacent sidecar graph.

- [ ] **Step 3: Build all desktop artifacts**

Run:

```bash
bun run --cwd app renderer:build
bun run app/scripts/build-electron.ts
```

Expected: Vite and Electron main/preload builds exit 0.

- [ ] **Step 4: Re-run the P1-0 security and replay smokes**

Run:

```bash
bun run app/scripts/run-hardening-smoke.ts
bun run app/scripts/run-f2-attach-smoke.ts
```

Expected: hardening checks pass; the explicit probe harness still receives one ready and one probe event before and after reload, without duplicates.

- [ ] **Step 5: Observe the real normal-startup handshake through Electron main**

Run:

```bash
cd app
CATCODE_SMOKE_EXIT_MS=3000 ./node_modules/.bin/electron .
```

Expected output contains exactly one line shaped as:

```text
[main-smoke] ready {"type":"app.ready","protocolVersion":1,"inputEnabled":true,"activeTurn":false,"abort":{"status":"idle"},"goalSnapshot":null,"pendingPermissionRequests":[]}
```

Expected output does not contain:

```text
[main-smoke] frame event
```

This is the observed payload to report. It is emitted by `SidecarServer` from getter calls on the controller returned by `createRuntimeBackedWebAppSession`; the normal Electron launcher does not set the probe flag.

- [ ] **Step 6: Launch the visible app and inspect the renderer**

Run:

```bash
bun run --cwd app dev
```

Expected: the window initially renders `connecting`, then renders only `ready`. It must show no heading, probe diagnostic, raw frame dump, or tool-use status.

- [ ] **Step 7: Run the repository build as a secondary regression gate**

Run:

```bash
bun run build:dev:full
```

Expected: exit 0. The app-specific tests, two typechecks, desktop builds, and Electron smoke are the load-bearing P1-1 gates; this repository build is the broader engine regression check required by `CLAUDE.md`, not a substitute for them.

- [ ] **Step 8: Mark P1-1 complete**

Update the P1-1 row in `docs/migration/STATUS.md`:

```md
| **P1-1** Connect, get `app.ready` | ANY | 5 | ✅ 2026-07-03 | Normal Electron startup launches `createRuntimeBackedWebAppSession` → `createQueryEngineAppSession` → real `QueryEngine`; IPC ready payload now carries canonical `type: 'app.ready'`, and renderer shows only `connecting`→`ready` from both discriminants. Probe remains opt-in via `CATCODE_SIDECAR_PROBE=1`; no credentials/turn used. ⚠️ P1-1 temporarily hardcodes cwd `/Users/pt/cat-code`; replace with session-owned cwd in the later shell/session phase. dep: P1-0 ✅ |
```

- [ ] **Step 9: Run final diff checks**

Run:

```bash
git diff --check
git status --short
git diff -- src/web/appSessionProtocol.ts app/shared/engine-types.snapshot.d.ts app/sidecar app/renderer/src app/main/main.ts app/main/mainSource.test.ts docs/migration/STATUS.md
```

Expected: no whitespace errors; only the scoped P1-1 changes appear in the focused diff. Do not commit unless the user explicitly requests it.
