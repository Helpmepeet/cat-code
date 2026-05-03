# Dedicated App Runtime Refactor Reference Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor the terminal-first Cat Code runtime so a real dedicated app can become the primary client while preserving the existing agent runtime, tools, permissions, transcripts, `/goal` behavior, and provider routing.

**Architecture:** Treat the current Ink REPL as the incumbent UI shell, not as the runtime boundary. Extract a stable app-facing session controller around the existing `QueryEngine`, command, tool, permission, and session-storage surfaces, then let both the terminal and the dedicated app consume the same event contract. Keep the first implementation transport local and incremental so the terminal keeps working throughout the migration.

**Tech Stack:** TypeScript, React 19, Ink/React terminal UI, Bun test, existing `QueryEngine`, existing SDK/stream-json message types, existing session storage and goal helpers.

---

## Warning: Reference Only

This document is a runtime-refactor reference, not the complete dedicated app
execution brief. Do not use it to claim the dedicated app is complete.

For `/cat-swarm`, use:

```text
docs/superpowers/plans/2026-05-03-dedicated-app-cat-swarm-task.md
```

The swarm task explicitly requires a real dedicated app path. It must not treat
the existing `web/` Vite browser UI as the dedicated app target.

## Ground Truth

This is a detailed runtime-boundary reference plan. The whole migration roadmap
lives in `docs/agent/2026-05-03-dedicated-app-groundtruth.md`.

This plan is not the full dedicated app replacement. It describes one possible
runtime-boundary extraction that makes later app UI work possible. Do not mark
the dedicated app replacement complete after this plan.

## Prototype And UI References

The dedicated app UI direction is documented in:

- `docs/design/2026-05-03-dedicated-app-prototype-brief.md`
- `docs/agent/2026-05-03-dedicated-app-groundtruth.md`
- Local prototype archive: `/Users/pt/Downloads/catcode_prototype.zip`

Use these references before any app-shell or UI task. The prototype defines the
desired dense local workspace shape, but it uses mock data and is not runtime
evidence. Do not substitute the existing `web/` app for the dedicated app target
unless the task explicitly says a temporary browser bridge is acceptable.

## Cat Swarm Handoff

Use `docs/superpowers/plans/2026-05-03-dedicated-app-cat-swarm-task.md` as the
direct `/cat-swarm` task brief. That file gives the swarm the end-to-end goal,
required context, constraints, and minimum validation gates.

This runtime-refactor plan remains reference material only. The swarm owns
deciding whether to use it, split it differently, or choose a more direct
dedicated-app scaffold as part of the end-to-end refactor task.

## How To Start This With `/goal`

Use this command in a fresh Cat Code session:

```text
/goal --budget 250K Replace the terminal-first Cat Code UI with a dedicated app by extracting a shared app-facing session runtime from the existing REPL, preserving provider routing, tools, permissions, transcripts, and goal-mode behavior.
```

Then tell the agent if you want to execute only this Phase 1 reference plan
without `/cat-swarm`:

```text
Execute docs/superpowers/plans/2026-05-03-dedicated-app-replacement-plan.md as a Phase 1 runtime-boundary milestone. Preserve existing dirty worktree changes. Do not rewrite the model/provider stack. Extract the app-facing session contract and controller seam, then verify the terminal still works.
```

For `/cat-swarm`, use the dedicated swarm task brief:

```text
/cat-swarm Execute docs/superpowers/plans/2026-05-03-dedicated-app-cat-swarm-task.md end to end. Read the required context docs first. Own the planning, worker decomposition, implementation, integration, and verification. Stop only when the validation gates pass or a blocker is clearly reported.
```

## Current Reality

- The process boots through `src/entrypoints/cli.tsx`, loads the full app in `src/main.tsx`, and renders Ink through `src/replLauncher.tsx`.
- The operational UI hub is `src/screens/REPL.tsx`; it owns input, local JSX commands, remote mode, tool permission dialogs, queues, notifications, session lifecycle, goal continuation, streaming display, and large parts of runtime orchestration.
- `src/QueryEngine.ts` already owns the conversation turn loop and can be used outside the terminal when given tools, commands, app state accessors, permission checks, and session context.
- `src/codex-core/` is a smaller Codex-only extraction. It is useful reference material, but it is not enough for the dedicated app because it intentionally excludes tools, permissions, slash commands, transcript persistence, and the full agent loop.
- `/goal` is already first-class in `src/utils/threadGoal.ts`, `src/commands/goal/goal.tsx`, `src/tools/GetGoalTool/`, `src/tools/CreateGoalTool/`, `src/tools/UpdateGoalTool/`, and REPL continuation logic.

## Migration Principles

- Keep the terminal usable until the dedicated app reaches parity for normal chat, streaming, tool approval, and session resume.
- Extract runtime boundaries before building app UI. A dedicated app that imports `REPL.tsx` or terminal `ink` modules is not a real replacement.
- Prefer existing SDK message and control types over inventing another event protocol.
- Preserve transcript and goal persistence semantics first; visual polish comes after runtime correctness.
- Treat permission prompts as runtime events with app responses, not as terminal-only React dialogs.

## Target Boundary

Create an app-facing runtime layer with this shape:

```text
Dedicated App UI
  -> AppSessionController.submitUserInput(...)
  -> QueryEngine / handlePromptSubmit-compatible command path
  -> Tool execution and permission requests
  -> Session transcript and goal persistence
  -> AppSessionEvent stream back to UI
```

The terminal should later become another client of this controller:

```text
Terminal PromptInput / Messages
  -> AppSessionController
  -> AppSessionEvent stream
  -> Existing Ink rendering
```

## File Structure

- Create `src/app-runtime/sessionEvents.ts`: app-facing event and control-response types, using existing SDK message/control types where possible.
- Create `src/app-runtime/AppSessionController.ts`: lifecycle wrapper around existing message submission, permission request forwarding, abort, and session state snapshots.
- Create `src/app-runtime/AppSessionController.test.ts`: pure/controller-level tests that do not mount Ink.
- Create `docs/agent/2026-05-03-dedicated-app-runtime-boundary.md`: architecture note explaining the boundary, invariants, and migration checkpoints.
- Modify `src/screens/REPL.tsx`: only after the controller exists, route a narrow path through it while preserving the current UI behavior.
- Modify `src/utils/handlePromptSubmit.ts`: only if needed to expose reusable input-processing pieces without importing Ink components.
- Modify `src/QueryEngine.ts`: only if a missing callback prevents non-terminal runtime use.

Phase 1 app-runtime files must not import `ink`, `react`, `src/screens/REPL.tsx`,
or terminal components. If a task needs one of those imports, stop and move that
work to Phase 3 or later.

---

### Task 1: Write The Runtime Boundary Doc

**Files:**
- Create: `docs/agent/2026-05-03-dedicated-app-runtime-boundary.md`
- Reference: `docs/reference/2026-04-30-WORKSPACE_MAP.md`
- Reference: `docs/reference/2026-04-30-codex-core-extraction-map.md`
- Reference: `src/screens/REPL.tsx`
- Reference: `src/QueryEngine.ts`

- [ ] **Step 1: Create the architecture note**

Create `docs/agent/2026-05-03-dedicated-app-runtime-boundary.md` with this content:

```markdown
# Dedicated App Runtime Boundary

## Objective

Replace the terminal-first Cat Code UI with a dedicated app without rewriting the agent runtime.

## Current Entry Points

- `src/entrypoints/cli.tsx` performs fast-path CLI routing and loads the full app.
- `src/main.tsx` assembles settings, auth, commands, tools, MCP, app state, and REPL props.
- `src/replLauncher.tsx` renders `<App><REPL /></App>` into the Ink root.
- `src/screens/REPL.tsx` is the current terminal UI and runtime glue.
- `src/QueryEngine.ts` owns the per-conversation model/tool turn loop.

## Extraction Target

Introduce `src/app-runtime/` as the first dedicated app boundary. It should expose a controller API that a GUI, mobile shell, or terminal client can consume without importing Ink components.

## Required Runtime Capabilities

- Start a session with existing settings, auth, tools, MCP, commands, and app state.
- Submit user text and attachment content.
- Stream assistant text, reasoning summaries, tool-use updates, and result messages.
- Surface permission requests as events and accept app-provided allow/deny responses.
- Persist transcripts through the existing session storage layer.
- Preserve `/goal` state, budget accounting, and idle continuation behavior.
- Abort an active turn.
- Resume a previous session.

## Non-Goals For The First Extraction

- Do not choose the final dedicated app framework.
- Do not remove Ink.
- Do not rewrite provider routing.
- Do not replace `QueryEngine`.
- Do not migrate every slash command at once.

## App-Facing Event Contract

The app runtime should prefer existing SDK-shaped messages where they already fit:

- Assistant/user/system transcript events should be based on `SDKMessage`.
- Permission requests should be based on `SDKControlPermissionRequest`.
- Permission responses should reuse the existing allow/deny shape used by remote and direct-connect sessions.
- Goal snapshots should use `ThreadGoal` from `src/utils/threadGoal.ts`.

## Migration Checkpoints

1. A controller test can submit one prompt through a mocked query path and receive ordered events.
2. A controller test can surface a permission request and resolve it.
3. A controller test can expose a goal snapshot and goal update event.
4. The terminal still builds and `/goal` tests still pass.
5. A minimal dedicated app shell can consume the controller without importing `src/ink` or `src/screens/REPL.tsx`.
```

- [ ] **Step 2: Verify the doc is in the expected docs area**

Run:

```bash
test -f docs/agent/2026-05-03-dedicated-app-runtime-boundary.md
```

Expected: exit code `0`.

- [ ] **Step 3: Commit the boundary doc**

Run:

```bash
git add docs/agent/2026-05-03-dedicated-app-runtime-boundary.md docs/superpowers/plans/2026-05-03-dedicated-app-replacement-plan.md
git commit -m "docs: define dedicated app runtime boundary"
```

Expected: commit succeeds after reviewing that only plan/doc files are staged.

---

### Task 2: Add App Runtime Event Types

**Files:**
- Create: `src/app-runtime/sessionEvents.ts`
- Create: `src/app-runtime/sessionEvents.test.ts`
- Reference: `src/entrypoints/agentSdkTypes.ts`
- Reference: `src/entrypoints/sdk/coreTypes.generated.ts`
- Reference: `src/utils/threadGoal.ts`

- [ ] **Step 1: Write event type tests**

Create `src/app-runtime/sessionEvents.test.ts` with this content:

```ts
import { describe, expect, test } from 'bun:test'
import type { SDKMessage } from '../entrypoints/agentSdkTypes.js'
import type { SDKControlPermissionRequest } from '../entrypoints/sdk/coreTypes.generated.js'
import type { ThreadGoal } from '../utils/threadGoal.js'
import {
  createAppSessionGoalEvent,
  createAppSessionMessageEvent,
  createAppSessionPermissionEvent,
  createAppSessionStatusEvent,
  type AppSessionEvent,
} from './sessionEvents.js'

describe('app session events', () => {
  test('creates message events without changing the SDK payload', () => {
    const message = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'hello' }],
      },
      session_id: 'session-1',
    } as SDKMessage

    expect(createAppSessionMessageEvent(message)).toEqual({
      type: 'message',
      message,
    })
  })

  test('creates permission events with request ids', () => {
    const request: SDKControlPermissionRequest = {
      subtype: 'can_use_tool',
      tool_name: 'Bash',
      tool_use_id: 'toolu_1',
      input: { command: 'pwd' },
    }

    expect(createAppSessionPermissionEvent('request-1', request)).toEqual({
      type: 'permission_request',
      requestId: 'request-1',
      request,
    })
  })

  test('creates goal snapshot events', () => {
    const goal: ThreadGoal = {
      threadId: 'session-1',
      goalId: 'goal-1',
      objective: 'ship app runtime',
      status: 'active',
      tokensUsed: 12,
      timeUsedSeconds: 3,
      createdAtMs: 100,
      updatedAtMs: 100,
    }

    expect(createAppSessionGoalEvent(goal)).toEqual({
      type: 'goal',
      goal,
    })
  })

  test('status event type stays narrow', () => {
    const event: AppSessionEvent = createAppSessionStatusEvent('idle')
    expect(event).toEqual({ type: 'status', status: 'idle' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
bun test src/app-runtime/sessionEvents.test.ts
```

Expected: FAIL because `src/app-runtime/sessionEvents.ts` does not exist.

- [ ] **Step 3: Add event type helpers**

Create `src/app-runtime/sessionEvents.ts` with this content:

```ts
import type { SDKMessage } from '../entrypoints/agentSdkTypes.js'
import type { SDKControlPermissionRequest } from '../entrypoints/sdk/coreTypes.generated.js'
import type { ThreadGoal } from '../utils/threadGoal.js'

export type AppSessionStatus =
  | 'starting'
  | 'idle'
  | 'running'
  | 'waiting_for_permission'
  | 'aborted'
  | 'error'

export type AppSessionMessageEvent = {
  type: 'message'
  message: SDKMessage
}

export type AppSessionStatusEvent = {
  type: 'status'
  status: AppSessionStatus
  message?: string
}

export type AppSessionPermissionEvent = {
  type: 'permission_request'
  requestId: string
  request: SDKControlPermissionRequest
}

export type AppSessionGoalEvent = {
  type: 'goal'
  goal: ThreadGoal | null
}

export type AppSessionEvent =
  | AppSessionMessageEvent
  | AppSessionStatusEvent
  | AppSessionPermissionEvent
  | AppSessionGoalEvent

export function createAppSessionMessageEvent(
  message: SDKMessage,
): AppSessionMessageEvent {
  return { type: 'message', message }
}

export function createAppSessionStatusEvent(
  status: AppSessionStatus,
  message?: string,
): AppSessionStatusEvent {
  return message ? { type: 'status', status, message } : { type: 'status', status }
}

export function createAppSessionPermissionEvent(
  requestId: string,
  request: SDKControlPermissionRequest,
): AppSessionPermissionEvent {
  return { type: 'permission_request', requestId, request }
}

export function createAppSessionGoalEvent(
  goal: ThreadGoal | null,
): AppSessionGoalEvent {
  return { type: 'goal', goal }
}
```

- [ ] **Step 4: Run event tests**

Run:

```bash
bun test src/app-runtime/sessionEvents.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit event contract**

Run:

```bash
git add src/app-runtime/sessionEvents.ts src/app-runtime/sessionEvents.test.ts
git commit -m "feat: add app session event contract"
```

Expected: commit succeeds.

---

### Task 3: Add A Minimal App Session Controller Skeleton

**Files:**
- Create: `src/app-runtime/AppSessionController.ts`
- Create: `src/app-runtime/AppSessionController.test.ts`
- Modify: `src/app-runtime/sessionEvents.ts`
- Reference: `src/QueryEngine.ts`
- Reference: `src/utils/threadGoal.ts`

- [ ] **Step 1: Write controller tests for event ordering**

Create `src/app-runtime/AppSessionController.test.ts` with this content:

```ts
import { describe, expect, test } from 'bun:test'
import type { SDKMessage } from '../entrypoints/agentSdkTypes.js'
import { AppSessionController } from './AppSessionController.js'

describe('AppSessionController', () => {
  test('emits starting and idle status around a submitted message', async () => {
    const assistantMessage = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'done' }],
      },
      session_id: 'session-1',
    } as SDKMessage
    const events: string[] = []

    const controller = new AppSessionController({
      getGoal: () => null,
      submit: async function* () {
        yield assistantMessage
      },
    })

    controller.subscribe(event => {
      events.push(event.type === 'status' ? `status:${event.status}` : event.type)
    })

    await controller.submitUserInput('hello')

    expect(events).toEqual([
      'status:running',
      'message',
      'goal',
      'status:idle',
    ])
  })

  test('emits an error status when submit fails', async () => {
    const events: string[] = []
    const controller = new AppSessionController({
      getGoal: () => null,
      submit: async function* () {
        throw new Error('backend unavailable')
      },
    })

    controller.subscribe(event => {
      if (event.type === 'status') {
        events.push(`${event.status}:${event.message ?? ''}`)
      }
    })

    await expect(controller.submitUserInput('hello')).rejects.toThrow(
      'backend unavailable',
    )
    expect(events).toEqual([
      'running:',
      'error:backend unavailable',
    ])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
bun test src/app-runtime/AppSessionController.test.ts
```

Expected: FAIL because `src/app-runtime/AppSessionController.ts` does not exist.

- [ ] **Step 3: Add controller skeleton**

Create `src/app-runtime/AppSessionController.ts` with this content:

```ts
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import type { SDKMessage } from '../entrypoints/agentSdkTypes.js'
import type { ThreadGoal } from '../utils/threadGoal.js'
import {
  createAppSessionGoalEvent,
  createAppSessionMessageEvent,
  createAppSessionStatusEvent,
  type AppSessionEvent,
} from './sessionEvents.js'

export type AppSessionSubmitInput = string | ContentBlockParam[]

export type AppSessionControllerOptions = {
  getGoal: () => ThreadGoal | null
  submit: (input: AppSessionSubmitInput) => AsyncIterable<SDKMessage>
}

export type AppSessionUnsubscribe = () => void

export class AppSessionController {
  private listeners = new Set<(event: AppSessionEvent) => void>()

  constructor(private readonly options: AppSessionControllerOptions) {}

  subscribe(listener: (event: AppSessionEvent) => void): AppSessionUnsubscribe {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  async submitUserInput(input: AppSessionSubmitInput): Promise<void> {
    this.emit(createAppSessionStatusEvent('running'))

    try {
      for await (const message of this.options.submit(input)) {
        this.emit(createAppSessionMessageEvent(message))
      }
      this.emit(createAppSessionGoalEvent(this.options.getGoal()))
      this.emit(createAppSessionStatusEvent('idle'))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.emit(createAppSessionStatusEvent('error', message))
      throw error
    }
  }

  private emit(event: AppSessionEvent): void {
    for (const listener of this.listeners) {
      listener(event)
    }
  }
}
```

- [ ] **Step 4: Run controller tests**

Run:

```bash
bun test src/app-runtime/sessionEvents.test.ts src/app-runtime/AppSessionController.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit controller skeleton**

Run:

```bash
git add src/app-runtime/AppSessionController.ts src/app-runtime/AppSessionController.test.ts
git commit -m "feat: add app session controller skeleton"
```

Expected: commit succeeds.

---

### Task 4: Wire QueryEngine Into The Controller In A Narrow Adapter

**Files:**
- Create: `src/app-runtime/createQueryEngineSessionController.ts`
- Create: `src/app-runtime/createQueryEngineSessionController.test.ts`
- Reference: `src/QueryEngine.ts`
- Reference: `src/utils/fileStateCache.ts`
- Reference: `src/tools.ts`
- Reference: `src/commands.ts`

- [ ] **Step 1: Write adapter test with a fake QueryEngine-compatible submitter**

Create `src/app-runtime/createQueryEngineSessionController.test.ts` with this content:

```ts
import { describe, expect, test } from 'bun:test'
import type { SDKMessage } from '../entrypoints/agentSdkTypes.js'
import { createQueryEngineSessionController } from './createQueryEngineSessionController.js'

describe('createQueryEngineSessionController', () => {
  test('adapts a submitMessage function into an AppSessionController', async () => {
    const events: string[] = []
    const assistantMessage = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'hello from query engine' }],
      },
      session_id: 'session-1',
    } as SDKMessage

    const controller = createQueryEngineSessionController({
      getGoal: () => null,
      submitMessage: async function* (input) {
        expect(input).toBe('hello')
        yield assistantMessage
      },
    })

    controller.subscribe(event => {
      events.push(event.type === 'status' ? `status:${event.status}` : event.type)
    })

    await controller.submitUserInput('hello')

    expect(events).toEqual([
      'status:running',
      'message',
      'goal',
      'status:idle',
    ])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
bun test src/app-runtime/createQueryEngineSessionController.test.ts
```

Expected: FAIL because the adapter file does not exist.

- [ ] **Step 3: Add adapter factory**

Create `src/app-runtime/createQueryEngineSessionController.ts` with this content:

```ts
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import type { SDKMessage } from '../entrypoints/agentSdkTypes.js'
import type { ThreadGoal } from '../utils/threadGoal.js'
import { AppSessionController } from './AppSessionController.js'

export type QueryEngineLikeSession = {
  getGoal: () => ThreadGoal | null
  submitMessage: (
    input: string | ContentBlockParam[],
  ) => AsyncIterable<SDKMessage>
}

export function createQueryEngineSessionController(
  session: QueryEngineLikeSession,
): AppSessionController {
  return new AppSessionController({
    getGoal: session.getGoal,
    submit: input => session.submitMessage(input),
  })
}
```

- [ ] **Step 4: Run adapter tests**

Run:

```bash
bun test src/app-runtime/sessionEvents.test.ts src/app-runtime/AppSessionController.test.ts src/app-runtime/createQueryEngineSessionController.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit adapter factory**

Run:

```bash
git add src/app-runtime/createQueryEngineSessionController.ts src/app-runtime/createQueryEngineSessionController.test.ts
git commit -m "feat: adapt query engine sessions for app runtime"
```

Expected: commit succeeds.

---

### Task 5: Add Permission And Abort Controller Contract

**Files:**
- Modify: `src/app-runtime/sessionEvents.ts`
- Modify: `src/app-runtime/sessionEvents.test.ts`
- Modify: `src/app-runtime/AppSessionController.ts`
- Modify: `src/app-runtime/AppSessionController.test.ts`
- Reference: `src/entrypoints/sdk/coreTypes.generated.ts`
- Reference: `src/remote/RemoteSessionManager.ts`

- [ ] **Step 1: Add tests for permission requests and abort status**

Add this import at the top of `src/app-runtime/AppSessionController.test.ts`:

```ts
import type { SDKControlPermissionRequest } from '../entrypoints/sdk/coreTypes.generated.js'
```

Append these tests to `src/app-runtime/AppSessionController.test.ts`:

```ts
test('surfaces permission requests and waits for app response', async () => {
  const request: SDKControlPermissionRequest = {
    subtype: 'can_use_tool',
    tool_name: 'Bash',
    tool_use_id: 'toolu_1',
    input: { command: 'pwd' },
  }
  const events: string[] = []
  const controller = new AppSessionController({
    getGoal: () => null,
    submit: async function* () {},
  })

  controller.subscribe(event => {
    events.push(event.type === 'status' ? `status:${event.status}` : event.type)
    if (event.type === 'permission_request') {
      controller.respondToPermission(event.requestId, {
        behavior: 'allow',
        updatedInput: request.input,
      })
    }
  })

  await expect(controller.requestPermission('request-1', request)).resolves.toEqual({
    behavior: 'allow',
    updatedInput: request.input,
  })
  expect(events).toEqual([
    'status:waiting_for_permission',
    'permission_request',
    'status:running',
  ])
})

test('can abort the active controller turn', async () => {
  const events: string[] = []
  const controller = new AppSessionController({
    getGoal: () => null,
    submit: async function* () {
      controller.abort()
    },
  })

  controller.subscribe(event => {
    if (event.type === 'status') {
      events.push(event.status)
    }
  })

  await controller.submitUserInput('stop')
  expect(events).toEqual(['running', 'aborted'])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
bun test src/app-runtime/AppSessionController.test.ts
```

Expected: FAIL because `requestPermission`, `respondToPermission`, and `abort`
do not exist yet.

- [ ] **Step 3: Add permission response types**

Update `src/app-runtime/sessionEvents.ts` so it includes these exported types:

```ts
export type AppSessionPermissionResponse =
  | {
      behavior: 'allow'
      updatedInput: Record<string, unknown>
    }
  | {
      behavior: 'deny'
      message: string
    }
```

- [ ] **Step 4: Add controller permission and abort methods**

Update `src/app-runtime/AppSessionController.ts` with these members inside
`AppSessionController`:

```ts
  private pendingPermissions = new Map<
    string,
    (response: AppSessionPermissionResponse) => void
  >()
  private aborted = false

  async requestPermission(
    requestId: string,
    request: SDKControlPermissionRequest,
  ): Promise<AppSessionPermissionResponse> {
    this.emit(createAppSessionStatusEvent('waiting_for_permission'))
    this.emit(createAppSessionPermissionEvent(requestId, request))

    return new Promise(resolve => {
      this.pendingPermissions.set(requestId, response => {
        this.pendingPermissions.delete(requestId)
        this.emit(createAppSessionStatusEvent('running'))
        resolve(response)
      })
    })
  }

  respondToPermission(
    requestId: string,
    response: AppSessionPermissionResponse,
  ): boolean {
    const resolve = this.pendingPermissions.get(requestId)
    if (!resolve) return false
    resolve(response)
    return true
  }

  abort(): void {
    this.aborted = true
    this.emit(createAppSessionStatusEvent('aborted'))
  }
```

Also update the imports at the top of `src/app-runtime/AppSessionController.ts`:

```ts
import type { SDKControlPermissionRequest } from '../entrypoints/sdk/coreTypes.generated.js'
import {
  createAppSessionGoalEvent,
  createAppSessionMessageEvent,
  createAppSessionPermissionEvent,
  createAppSessionStatusEvent,
  type AppSessionEvent,
  type AppSessionPermissionResponse,
} from './sessionEvents.js'
```

Finally, update `submitUserInput` so it resets the abort flag for each new turn
and does not emit `goal` and `idle` after an abort:

```ts
    this.aborted = false
    this.emit(createAppSessionStatusEvent('running'))
```

```ts
      if (!this.aborted) {
        this.emit(createAppSessionGoalEvent(this.options.getGoal()))
        this.emit(createAppSessionStatusEvent('idle'))
      }
```

- [ ] **Step 5: Run controller and event tests**

Run:

```bash
bun test src/app-runtime/sessionEvents.test.ts src/app-runtime/AppSessionController.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit permission and abort contract**

Run:

```bash
git add src/app-runtime/sessionEvents.ts src/app-runtime/sessionEvents.test.ts src/app-runtime/AppSessionController.ts src/app-runtime/AppSessionController.test.ts
git commit -m "feat: add app session permission and abort contract"
```

Expected: commit succeeds.

---

### Task 6: Decide The First Dedicated App Shell

**Files:**
- Modify: `docs/agent/2026-05-03-dedicated-app-runtime-boundary.md`
- Create only after decision: app shell files under the selected package or directory.

- [ ] **Step 1: Record the app-shell decision criteria**

Append this section to `docs/agent/2026-05-03-dedicated-app-runtime-boundary.md`:

```markdown
## Dedicated App Shell Decision Criteria

The first dedicated app shell should be selected by these constraints:

- It can consume `src/app-runtime` without importing `src/ink` or `src/screens/REPL.tsx`.
- It can render streamed transcript events.
- It can show and answer permission requests.
- It can show current `/goal` state.
- It can run locally against the same server Mac runtime.
- It does not force a provider, model, tool, or transcript rewrite.
- It follows the product and visual direction in `docs/design/2026-05-03-dedicated-app-prototype-brief.md`.

The first shell should optimize for local iteration speed over final distribution. A local web app, Electron, Tauri, or native macOS app can all be considered, but the runtime boundary must stay independent of the shell choice.
```

- [ ] **Step 2: Verify docs and runtime tests**

Run:

```bash
bun test src/app-runtime/sessionEvents.test.ts src/app-runtime/AppSessionController.test.ts src/app-runtime/createQueryEngineSessionController.test.ts
if rg -n "from ['\\\"](ink|react|.*screens/REPL|.*components/)" src/app-runtime; then exit 1; fi
```

Expected: tests pass and `rg` finds no terminal UI imports in `src/app-runtime`.

- [ ] **Step 3: Commit the app-shell decision criteria**

Run:

```bash
git add docs/agent/2026-05-03-dedicated-app-runtime-boundary.md
git commit -m "docs: add dedicated app shell criteria"
```

Expected: commit succeeds.

---

## Validation Commands

Run these before claiming the first extraction phase is complete:

```bash
bun test src/app-runtime/sessionEvents.test.ts src/app-runtime/AppSessionController.test.ts src/app-runtime/createQueryEngineSessionController.test.ts
bun test src/utils/threadGoal.test.ts src/commands/goal/goal.test.ts src/tools/GetGoalTool/GetGoalTool.test.ts src/tools/CreateGoalTool/CreateGoalTool.test.ts src/tools/UpdateGoalTool/UpdateGoalTool.test.ts
if rg -n "from ['\\\"](ink|react|.*screens/REPL|.*components/)" src/app-runtime; then exit 1; fi
bun run build:dev:full
```

Expected:

- App-runtime tests pass.
- Goal-mode tests pass.
- `src/app-runtime` has no terminal UI imports.
- `bun run build:dev:full` creates `./cli-dev` and prints the version.

## Follow-On Phases

- Phase 2: Move permission request orchestration behind `AppSessionController` using existing SDK control request shapes.
- Phase 3: Route a small terminal path through the controller without changing visible REPL behavior.
- Phase 4: Build the first local dedicated app shell against `src/app-runtime`.
- Phase 5: Add session resume, transcript browser, and goal controls to the dedicated app.
- Phase 6: Remove terminal-only assumptions from commands and permission UI once the app shell reaches parity.

## Self-Review

- Spec coverage: This plan covers the first extraction needed before a dedicated app can replace the terminal. It does not attempt the final app UI because the runtime boundary must exist first.
- Placeholder scan: No `TBD`, `TODO`, or open-ended implementation steps are used.
- Type consistency: `AppSessionEvent`, `AppSessionController`, and `createQueryEngineSessionController` names are consistent across tasks.
