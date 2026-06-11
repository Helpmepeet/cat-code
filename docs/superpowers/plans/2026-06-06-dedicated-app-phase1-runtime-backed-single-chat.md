# Dedicated App Phase 1A Runtime Transport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the tested runtime transport, browser state model, and app-session bootstrap seam needed for one browser chat slice, then hand off the remaining `main.tsx` startup extraction as a separate Phase 1B plan.

**Architecture:** Phase 1A uses `src/app-runtime/` as the runtime boundary and adds a dedicated app-session WebSocket adapter under `src/web/`. The browser receives a small app protocol and maps raw runtime events into a string-first message view model; the prototype remains design evidence and is not copied into production code. This plan does not satisfy the full Phase 1 Definition of Done in `docs/design/dedicated-app/migration-scope.md` until Phase 1B wires the real `--web` startup path and manual smoke test.

**Tech Stack:** Bun tests, TypeScript, Vite React app in `web/`, `ws`, Zod schemas, existing `AppSessionController`, existing `createQueryEngineSessionController`, existing `QueryEngine`, and final verification with `bun run build:dev:full`.

---

## Scope

This plan intentionally covers only the first runtime transport slice. It does not attempt the full Claude Design migration, and it does not claim the full Phase 1 outcome until the follow-up startup extraction plan is complete.

Included:

- One active browser chat session state model and tested WebSocket adapter path.
- Browser submit into `AppSessionController.submit()` in adapter tests and browser state.
- Real app-runtime event transport for messages, goal snapshot, permission request and resolution, and abort status.
- Minimal SDK-message mapper for text assistant output, partial text deltas, visible system diagnostics, user echoes when needed, and result errors.
- Permission allow, deny, and cancel-as-deny-interrupt responses over WebSocket using the existing `PermissionPromptToolResultSchema` output shape.
- Abort request over WebSocket and recovery for a later turn.
- Loopback-only WebSocket server with per-session token and origin/host validation.
- Web TypeScript/build verification baseline.
- A Phase 1B startup extraction plan with the exact `QueryEngineAppSessionConfig` assembly work needed for `cat-code --web`.

Excluded:

- Split panels.
- Multiple tabs.
- Session browser and resume UI.
- Account pages, charts, and settings pages.
- Model/provider/effort mutation controls.
- Full tool cards, diffs, thinking blocks, and task pages.
- Copying `cat-app/*.jsx` from the Claude Design handoff into `web/src/`.
- Manual `cat-code --web` runtime smoke. That belongs to Phase 1B after startup extraction is implemented.

## File Structure

Create:

- `src/web/appSessionProtocol.ts`: Zod schemas and TypeScript types for app WebSocket messages.
- `src/web/appSessionProtocol.test.ts`: schema tests for submit, permission response, abort, ready, ack, error, and event envelopes.
- `src/web/appSessionEventMapper.ts`: maps raw `AppSessionEvent` values into browser-facing app protocol events.
- `src/web/appSessionEventMapper.test.ts`: mapper tests for assistant text, stream deltas, system/status/result handling, permissions, goal, and abort.
- `src/web/AppSessionWebSocketServer.ts`: runtime-backed WebSocket server that wraps one `AppSessionController`.
- `src/web/AppSessionWebSocketServer.test.ts`: transport tests with a fake controller and real `ws` client.
- `src/app-runtime/createRuntimeBackedWebAppSession.ts`: app-runtime bootstrap seam that creates an `AppSessionController` from a complete `QueryEngineAppSessionConfig`.
- `src/app-runtime/createRuntimeBackedWebAppSession.test.ts`: tests that the bootstrap seam wires `createQueryEngineAppSession()` and `createQueryEngineSessionController()`.
- `docs/superpowers/plans/2026-06-07-dedicated-app-phase1b-startup-extraction.md`: follow-up plan for real `--web` QueryEngine config extraction and manual smoke.
- `web/src/appProtocol.ts`: browser-local mirror of the app protocol view types.
- `web/src/appState.ts`: pure reducer for browser message/status/permission/abort state.
- `web/src/appState.test.ts`: reducer tests independent of React.

Modify:

- `src/app-runtime/createQueryEngineAppSession.ts`: make abort controller lifecycle turn-safe.
- `src/app-runtime/createQueryEngineAppSession.test.ts`: cover abort and later turn recovery.
- `src/QueryEngine.ts`: expose a turn-safe abort-controller refresh that preserves conversation state.
- `src/web/WebSocketServer.ts`: leave as legacy proof-of-life server or mark as legacy; do not extend it with app-session semantics.
- `web/package.json`: add `typecheck` and `test` scripts.
- `web/vite.config.ts`: target the loopback WebSocket server through `127.0.0.1`.
- `web/src/hooks/useWebSocket.ts`: use the app protocol, WebSocket subprotocol token, typed send helpers, and surfaced connection errors.
- `web/src/App.tsx`: replace legacy `message`/`delta` handling with app reducer, submit, permission, and abort actions.
- `web/src/components/MessageContent.tsx`: fix the current TypeScript error while preserving Markdown rendering.

Read before implementation:

- `CLAUDE.md`
- `docs/maps/WORKSPACE_MAP.md`
- `docs/maps/query-provider-runtime.md`
- `docs/maps/tools-permissions.md`
- `docs/design/dedicated-app/runtime-contract-map.md`
- `docs/design/dedicated-app/migration-scope.md`
- `src/main.tsx`

## Runtime Contracts To Preserve

`src/app-runtime/sessionEvents.ts` is the source contract for app-runtime events:

```ts
export type AppSessionEvent =
  | AppSessionMessageEvent
  | AppSessionGoalSnapshotEvent
  | AppSessionPermissionRequestedEvent
  | AppSessionPermissionResolvedEvent
  | AppSessionAbortStatusEvent
```

Permission responses must keep the existing output shape from `src/utils/permissions/PermissionPromptToolResultSchema.ts`:

```ts
export type AppPermissionResponse =
  | {
      behavior: 'allow'
      updatedInput: Record<string, unknown>
      updatedPermissions?: PermissionUpdate[]
      toolUseID?: string
      decisionClassification?: 'user_temporary' | 'user_permanent' | 'user_reject'
    }
  | {
      behavior: 'deny'
      message: string
      interrupt?: boolean
      toolUseID?: string
      decisionClassification?: 'user_temporary' | 'user_permanent' | 'user_reject'
    }
```

The browser protocol wraps runtime events; it does not replace `AppSessionEvent`.

## Task 1: Establish Web Verification Baseline

**Files:**
- Modify: `web/package.json`
- Modify: `web/src/App.tsx`
- Modify: `web/src/components/MessageContent.tsx`

- [ ] **Step 1: Run current web checks to capture the baseline**

Run:

```bash
./node_modules/.bin/tsc --noEmit -p web/tsconfig.json
```

Expected: FAIL before this task is implemented with the known current errors:

```text
web/src/App.tsx: data.message is possibly undefined
web/src/components/MessageContent.tsx: inline prop typing mismatch
```

- [ ] **Step 2: Add web check scripts**

Patch `web/package.json` scripts to:

```json
{
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "typecheck": "tsc --noEmit",
    "test": "bun test ./src"
  }
}
```

- [ ] **Step 3: Fix the `data.message` narrowing in `web/src/App.tsx`**

Replace the first branch in `onMessage` with:

```tsx
if (data.type === "message") {
  const incomingMessage = data.message;
  if (!incomingMessage) return;

  setMessages((prev) => {
    const role = incomingMessage.role ?? "assistant";
    const content = incomingMessage.content ?? "";
    if (incomingMessage.replaceLast) {
      const last = prev[prev.length - 1];
      if (last?.role === role) {
        return [...prev.slice(0, -1), { ...last, content }];
      }
    }
    return [
      ...prev,
      {
        id: messageId(role),
        role,
        content,
      },
    ];
  });
  return;
}
```

- [ ] **Step 4: Fix the Markdown renderer typing and link referrer policy in `web/src/components/MessageContent.tsx`**

Use a code renderer that does not require the unsupported `inline` prop:

```tsx
code({ children, className, ...props }) {
  const match = /language-(\w+)/.exec(className ?? "");
  return (
    <code
      className={match ? className : undefined}
      {...props}
    >
      {children}
    </code>
  );
}
```

If the existing file already has surrounding syntax highlighting code, keep that code and only remove the invalid `inline` assumption.

Also update external Markdown links so browser-originated app credentials cannot leak through `Referer` if a later task accidentally places a credential in a URL:

```tsx
<a
  href={href}
  target="_blank"
  rel="noreferrer"
  referrerPolicy="no-referrer"
  className="text-pink-300 underline decoration-pink-400/40 underline-offset-4 transition hover:text-pink-200"
>
  {children}
</a>
```

- [ ] **Step 5: Verify web typecheck passes**

Run:

```bash
bun run --cwd web typecheck
```

Expected: PASS with no TypeScript errors.

- [ ] **Step 6: Verify web build passes**

Run:

```bash
bun run --cwd web build
```

Expected: PASS and Vite reports built assets under `web/dist/`.

- [ ] **Step 7: Commit the verification baseline**

```bash
git add web/package.json web/src/App.tsx web/src/components/MessageContent.tsx
git commit -m "chore: establish web verification baseline"
```

## Task 2: Define The App WebSocket Protocol

**Files:**
- Create: `src/web/appSessionProtocol.ts`
- Create: `src/web/appSessionProtocol.test.ts`

- [ ] **Step 1: Write protocol schema tests**

Create `src/web/appSessionProtocol.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'
import {
  appClientMessageSchema,
  appServerMessageSchema,
} from './appSessionProtocol.js'

describe('app session web protocol', () => {
  test('accepts submit, abort, ping, and permission response messages', () => {
    expect(
      appClientMessageSchema.parse({
        type: 'app.submit',
        requestId: 'submit-1',
        prompt: 'hello',
      }),
    ).toEqual({
      type: 'app.submit',
      requestId: 'submit-1',
      prompt: 'hello',
    })

    expect(
      appClientMessageSchema.parse({
        type: 'app.abort',
        requestId: 'abort-1',
        reason: 'user clicked stop',
      }),
    ).toMatchObject({ type: 'app.abort', requestId: 'abort-1' })

    expect(
      appClientMessageSchema.parse({
        type: 'app.ping',
        nonce: 'nonce-1',
      }),
    ).toEqual({ type: 'app.ping', nonce: 'nonce-1' })

    expect(
      appClientMessageSchema.parse({
        type: 'permission.response',
        requestId: 'perm-1',
        response: {
          behavior: 'allow',
          updatedInput: { command: 'pwd' },
        },
      }),
    ).toMatchObject({
      type: 'permission.response',
      requestId: 'perm-1',
      response: { behavior: 'allow' },
    })
  })

  test('rejects malformed client messages', () => {
    expect(() =>
      appClientMessageSchema.parse({
        type: 'app.submit',
        prompt: '',
      }),
    ).toThrow()

    expect(() =>
      appClientMessageSchema.parse({
        type: 'permission.response',
        requestId: 'perm-1',
        response: { behavior: 'allow' },
      }),
    ).toThrow()
  })

  test('accepts ready, ack, error, and event envelopes', () => {
    expect(
      appServerMessageSchema.parse({
        type: 'app.ready',
        protocolVersion: 1,
        inputEnabled: true,
        abort: { status: 'idle' },
        goalSnapshot: null,
        pendingPermissionRequests: [],
      }),
    ).toMatchObject({ type: 'app.ready', inputEnabled: true })

    expect(
      appServerMessageSchema.parse({
        type: 'app.ack',
        requestId: 'submit-1',
      }),
    ).toEqual({ type: 'app.ack', requestId: 'submit-1' })

    expect(
      appServerMessageSchema.parse({
        type: 'app.error',
        requestId: 'submit-1',
        code: 'turn_already_running',
        message: 'Session turn already running',
        retryable: true,
      }),
    ).toMatchObject({ type: 'app.error', retryable: true })

    expect(
      appServerMessageSchema.parse({
        type: 'app.event',
        event: {
          type: 'abort.status',
          abort: { status: 'requested', reason: 'stop' },
        },
      }),
    ).toMatchObject({ type: 'app.event' })
  })
})
```

- [ ] **Step 2: Run the failing protocol tests**

Run:

```bash
bun test src/web/appSessionProtocol.test.ts
```

Expected: FAIL because `src/web/appSessionProtocol.ts` does not exist.

- [ ] **Step 3: Implement protocol schemas**

Create `src/web/appSessionProtocol.ts`:

```ts
import z from 'zod/v4'
import type {
  AppGoalSnapshot,
  AppPermissionRequest,
  AppPermissionResponse,
  AppSessionAbortState,
} from '../app-runtime/sessionEvents.js'
import { outputSchema as permissionResponseSchema } from '../utils/permissions/PermissionPromptToolResultSchema.js'

const requestIdSchema = z.string().min(1)

const appSubmitMessageSchema = z.object({
  type: z.literal('app.submit'),
  requestId: requestIdSchema,
  prompt: z.string().min(1),
  options: z
    .object({
      uuid: z.string().optional(),
      isMeta: z.boolean().optional(),
      goalSnapshot: z.unknown().optional(),
    })
    .optional(),
})

const appAbortMessageSchema = z.object({
  type: z.literal('app.abort'),
  requestId: requestIdSchema,
  reason: z.string().optional(),
})

const permissionResponseMessageSchema = z.object({
  type: z.literal('permission.response'),
  requestId: requestIdSchema,
  response: permissionResponseSchema(),
})

const appPingMessageSchema = z.object({
  type: z.literal('app.ping'),
  nonce: z.string().min(1),
})

export const appClientMessageSchema = z.union([
  appSubmitMessageSchema,
  appAbortMessageSchema,
  permissionResponseMessageSchema,
  appPingMessageSchema,
])

const abortStateSchema = z.union([
  z.object({ status: z.literal('idle') }),
  z.object({ status: z.literal('requested'), reason: z.string().optional() }),
  z.object({ status: z.literal('aborted'), reason: z.string().optional() }),
])

const browserMessageSchema = z.object({
  id: z.string().min(1),
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string(),
  sdkType: z.string().optional(),
  sdkSubtype: z.string().optional(),
})

const appBrowserEventSchema = z.union([
  z.object({
    type: z.literal('message.append'),
    message: browserMessageSchema,
  }),
  z.object({
    type: z.literal('message.replace'),
    message: browserMessageSchema,
  }),
  z.object({
    type: z.literal('message.delta'),
    id: z.string().optional(),
    delta: z.string(),
  }),
  z.object({
    type: z.literal('status.update'),
    connected: z.boolean().optional(),
    inputEnabled: z.boolean().optional(),
    activeTurn: z.boolean().optional(),
    model: z.string().optional(),
    effort: z.string().optional(),
    contextTokens: z.number().optional(),
    notice: z.string().optional(),
  }),
  z.object({
    type: z.literal('goal.snapshot'),
    snapshot: z.unknown(),
  }),
  z.object({
    type: z.literal('permission.requested'),
    request: z.unknown(),
  }),
  z.object({
    type: z.literal('permission.resolved'),
    requestId: z.string(),
    response: z.unknown(),
  }),
  z.object({
    type: z.literal('abort.status'),
    abort: abortStateSchema,
  }),
])

export const appServerMessageSchema = z.union([
  z.object({
    type: z.literal('app.ready'),
    protocolVersion: z.literal(1),
    inputEnabled: z.boolean(),
    abort: abortStateSchema,
    goalSnapshot: z.unknown(),
    pendingPermissionRequests: z.array(z.unknown()),
  }),
  z.object({
    type: z.literal('app.event'),
    event: appBrowserEventSchema,
  }),
  z.object({
    type: z.literal('app.ack'),
    requestId: requestIdSchema,
  }),
  z.object({
    type: z.literal('app.error'),
    requestId: z.string().optional(),
    code: z.enum([
      'bad_request',
      'turn_already_running',
      'permission_not_found',
      'unauthorized',
      'internal_error',
    ]),
    message: z.string(),
    retryable: z.boolean(),
  }),
  z.object({
    type: z.literal('app.pong'),
    nonce: z.string(),
  }),
])

export type AppClientMessage = z.infer<typeof appClientMessageSchema>
export type AppSubmitMessage = z.infer<typeof appSubmitMessageSchema>
export type PermissionResponseMessage = z.infer<
  typeof permissionResponseMessageSchema
>
export type AppServerMessage = z.infer<typeof appServerMessageSchema>
export type AppBrowserEvent = z.infer<typeof appBrowserEventSchema>

export type AppReadyPayload = {
  protocolVersion: 1
  inputEnabled: boolean
  abort: AppSessionAbortState
  goalSnapshot: AppGoalSnapshot
  pendingPermissionRequests: AppPermissionRequest[]
}

export type AppPermissionResponsePayload = AppPermissionResponse
```

- [ ] **Step 4: Run protocol tests**

Run:

```bash
bun test src/web/appSessionProtocol.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit protocol schemas**

```bash
git add src/web/appSessionProtocol.ts src/web/appSessionProtocol.test.ts
git commit -m "feat: define app session web protocol"
```

## Task 3: Add SDK Message To Browser Event Mapper

**Files:**
- Create: `src/web/appSessionEventMapper.ts`
- Create: `src/web/appSessionEventMapper.test.ts`

- [ ] **Step 1: Write mapper tests**

Create `src/web/appSessionEventMapper.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'
import type { AppSessionEvent } from '../app-runtime/sessionEvents.js'
import { createAppSessionEventMapper } from './appSessionEventMapper.js'

describe('createAppSessionEventMapper', () => {
  test('maps assistant text blocks to append messages', () => {
    const mapper = createAppSessionEventMapper({ createId: () => 'generated-1' })
    const event: AppSessionEvent = {
      type: 'message',
      message: {
        type: 'assistant',
        uuid: 'assistant-1',
        message: {
          content: [
            { type: 'text', text: 'hello' },
            { type: 'text', text: ' world' },
          ],
        },
      },
    }

    expect(mapper.map(event)).toEqual([
      {
        type: 'message.append',
        message: {
          id: 'assistant-1',
          role: 'assistant',
          content: 'hello world',
          sdkType: 'assistant',
        },
      },
    ])
  })

  test('ignores tool-only assistant messages in phase 1', () => {
    const mapper = createAppSessionEventMapper({ createId: () => 'generated-1' })
    const event: AppSessionEvent = {
      type: 'message',
      message: {
        type: 'assistant',
        uuid: 'assistant-tool-only',
        message: {
          content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} }],
        },
      },
    }

    expect(mapper.map(event)).toEqual([])
  })

  test('maps stream text deltas and replaces the streamed row with the final assistant text', () => {
    const mapper = createAppSessionEventMapper({
      createId: () => 'assistant-stream-1',
    })

    expect(
      mapper.map({
        type: 'message',
        message: {
          type: 'stream_event',
          uuid: 'stream-start',
          event: {
            type: 'message_start',
            message: { usage: {} },
          },
        },
      } as AppSessionEvent),
    ).toEqual([])

    const deltaEvent: AppSessionEvent = {
      type: 'message',
      message: {
        type: 'stream_event',
        uuid: 'stream-1',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'partial' },
        },
      },
    }

    expect(mapper.map(deltaEvent)).toEqual([
      {
        type: 'message.delta',
        id: 'assistant-stream-1',
        delta: 'partial',
      },
    ])

    expect(
      mapper.map({
        type: 'message',
        message: {
          type: 'assistant',
          uuid: 'assistant-final',
          message: {
            content: [{ type: 'text', text: 'partial final' }],
          },
        },
      }),
    ).toEqual([
      {
        type: 'message.replace',
        message: {
          id: 'assistant-stream-1',
          role: 'assistant',
          content: 'partial final',
          sdkType: 'assistant',
        },
      },
    ])
  })

  test('maps visible system diagnostics to system messages', () => {
    const mapper = createAppSessionEventMapper({ createId: () => 'generated-1' })
    const event: AppSessionEvent = {
      type: 'message',
      message: {
        type: 'system',
        subtype: 'cat_code_account_diagnostic',
        uuid: 'diag-1',
        user_message: 'Account temporarily unavailable.',
      },
    }

    expect(mapper.map(event)).toEqual([
      {
        type: 'message.append',
        message: {
          id: 'diag-1',
          role: 'system',
          content: 'Account temporarily unavailable.',
          sdkType: 'system',
          sdkSubtype: 'cat_code_account_diagnostic',
        },
      },
    ])
  })

  test('maps result errors but ignores success results', () => {
    const mapper = createAppSessionEventMapper({ createId: () => 'generated-1' })

    expect(
      mapper.map({
        type: 'message',
        message: {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'done',
        },
      }),
    ).toEqual([])

    expect(
      mapper.map({
        type: 'message',
        message: {
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          result: 'failed',
        },
      }),
    ).toEqual([
      {
        type: 'message.append',
        message: {
          id: 'result-error',
          role: 'system',
          content: 'failed',
          sdkType: 'result',
          sdkSubtype: 'error_during_execution',
        },
      },
    ])
  })

  test('passes goal, permission, and abort events through as browser events', () => {
    const mapper = createAppSessionEventMapper({ createId: () => 'generated-1' })

    expect(
      mapper.map({
        type: 'goal.snapshot',
        snapshot: null,
      }),
    ).toEqual([{ type: 'goal.snapshot', snapshot: null }])

    expect(
      mapper.map({
        type: 'permission.requested',
        request: {
          requestId: 'perm-1',
          request: {
            subtype: 'can_use_tool',
            tool_name: 'Bash',
            input: { command: 'pwd' },
            tool_use_id: 'toolu_1',
          },
        },
      }),
    ).toEqual([
      {
        type: 'permission.requested',
        request: {
          requestId: 'perm-1',
          request: {
            subtype: 'can_use_tool',
            tool_name: 'Bash',
            input: { command: 'pwd' },
            tool_use_id: 'toolu_1',
          },
        },
      },
    ])

    expect(
      mapper.map({
        type: 'abort.status',
        abort: { status: 'requested', reason: 'stop' },
      }),
    ).toEqual([
      { type: 'abort.status', abort: { status: 'requested', reason: 'stop' } },
    ])
  })
})
```

- [ ] **Step 2: Run mapper tests and see the missing module failure**

Run:

```bash
bun test src/web/appSessionEventMapper.test.ts
```

Expected: FAIL because `src/web/appSessionEventMapper.ts` does not exist.

- [ ] **Step 3: Implement the mapper**

Create `src/web/appSessionEventMapper.ts`:

```ts
import { randomUUID } from 'crypto'
import type { SDKMessage } from '../entrypoints/agentSdkTypes.js'
import type { AppSessionEvent } from '../app-runtime/sessionEvents.js'
import type { AppBrowserEvent } from './appSessionProtocol.js'

export type AppSessionEventMapperOptions = {
  createId?: () => string
}

export function createAppSessionEventMapper({
  createId = randomUUID,
}: AppSessionEventMapperOptions = {}) {
  let activeAssistantMessageId: string | undefined

  function getActiveAssistantMessageId() {
    if (!activeAssistantMessageId) {
      activeAssistantMessageId = createId()
    }
    return activeAssistantMessageId
  }

  return {
    map(event: AppSessionEvent): AppBrowserEvent[] {
      if (event.type === 'goal.snapshot') {
        return [{ type: 'goal.snapshot', snapshot: event.snapshot }]
      }

      if (event.type === 'permission.requested') {
        return [{ type: 'permission.requested', request: event.request }]
      }

      if (event.type === 'permission.resolved') {
        return [
          {
            type: 'permission.resolved',
            requestId: event.request.requestId,
            response: event.response,
          },
        ]
      }

      if (event.type === 'abort.status') {
        return [{ type: 'abort.status', abort: event.abort }]
      }

      if (event.message.type === 'stream_event') {
        return mapStreamEvent(event.message, getActiveAssistantMessageId)
      }

      const mapped = mapSdkMessage(event.message, activeAssistantMessageId)
      if (event.message.type === 'assistant') {
        activeAssistantMessageId = undefined
      }
      return mapped
    },
  }
}

function mapSdkMessage(
  message: SDKMessage,
  activeAssistantMessageId: string | undefined,
): AppBrowserEvent[] {
  if (message.type === 'assistant') {
    const text = extractTextFromContent(message.message?.content)
    if (!text) return []
    const id = activeAssistantMessageId ?? message.uuid ?? message.message?.id

    return [
      {
        type: activeAssistantMessageId ? 'message.replace' : 'message.append',
        message: {
          id: id ?? randomUUID(),
          role: 'assistant',
          content: text,
          sdkType: message.type,
        },
      },
    ]
  }

  if (message.type === 'user') {
    const text = extractUserText(message.message?.content)
    if (!text || message.isSynthetic) return []

    return [
      {
        type: 'message.append',
        message: {
          id: message.uuid ?? `user-${Date.now()}`,
          role: 'user',
          content: text,
          sdkType: message.type,
        },
      },
    ]
  }

  if (message.type === 'system') {
    const content =
      typeof message.user_message === 'string'
        ? message.user_message
        : typeof message.content === 'string'
          ? message.content
          : typeof message.summary === 'string'
            ? message.summary
            : undefined
    if (!content) return []

    return [
      {
        type: 'message.append',
        message: {
          id: message.uuid ?? `system-${message.subtype ?? 'message'}`,
          role: 'system',
          content,
          sdkType: message.type,
          sdkSubtype: message.subtype,
        },
      },
    ]
  }

  if (message.type === 'result') {
    if (!message.is_error) return []
    const content =
      typeof message.result === 'string' && message.result.length > 0
        ? message.result
        : Array.isArray(message.errors)
          ? message.errors.join('\n')
          : 'The turn ended with an error.'

    return [
      {
        type: 'message.append',
        message: {
          id: message.uuid ?? 'result-error',
          role: 'system',
          content,
          sdkType: message.type,
          sdkSubtype: message.subtype,
        },
      },
    ]
  }

  if (message.type === 'assistant_error') {
    return [
      {
        type: 'message.append',
        message: {
          id: message.uuid ?? message.request_id ?? 'assistant-error',
          role: 'system',
          content: message.message ?? message.error ?? 'Assistant error',
          sdkType: message.type,
        },
      },
    ]
  }

  return []
}

function mapStreamEvent(
  message: SDKMessage & { type: 'stream_event' },
  getActiveAssistantMessageId: () => string,
): AppBrowserEvent[] {
  const event = message.event
  if (
    event &&
    typeof event === 'object' &&
    'type' in event &&
    event.type === 'message_start'
  ) {
    getActiveAssistantMessageId()
    return []
  }

  const delta = extractTextDelta(message.event)
  if (!delta) return []

  return [
    {
      type: 'message.delta',
      id: getActiveAssistantMessageId(),
      delta,
    },
  ]
}

function extractTextFromContent(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .map(block => {
      if (
        block &&
        typeof block === 'object' &&
        'type' in block &&
        block.type === 'text' &&
        'text' in block &&
        typeof block.text === 'string'
      ) {
        return block.text
      }
      return ''
    })
    .join('')
}

function extractUserText(content: unknown): string {
  if (typeof content === 'string') return content
  return extractTextFromContent(content)
}

function extractTextDelta(event: unknown): string {
  if (!event || typeof event !== 'object') return ''
  if (!('type' in event) || event.type !== 'content_block_delta') return ''
  if (!('delta' in event)) return ''

  const delta = event.delta
  if (!delta || typeof delta !== 'object') return ''
  if (!('type' in delta) || delta.type !== 'text_delta') return ''
  if (!('text' in delta) || typeof delta.text !== 'string') return ''
  return delta.text
}
```

- [ ] **Step 4: Run mapper tests**

Run:

```bash
bun test src/web/appSessionEventMapper.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the mapper**

```bash
git add src/web/appSessionEventMapper.ts src/web/appSessionEventMapper.test.ts
git commit -m "feat: map app session events for web"
```

## Task 4: Harden QueryEngine App Session Abort Lifecycle

**Files:**
- Modify: `src/QueryEngine.ts`
- Modify: `src/app-runtime/createQueryEngineAppSession.ts`
- Modify: `src/app-runtime/createQueryEngineSessionController.ts`
- Create or modify: `src/app-runtime/createQueryEngineAppSession.test.ts`

- [ ] **Step 1: Write abort recovery tests**

Create `src/app-runtime/createQueryEngineAppSession.test.ts` if it does not exist:

```ts
import { describe, expect, test } from 'bun:test'
import { createQueryEngineAppSession } from './createQueryEngineAppSession.js'

describe('createQueryEngineAppSession abort lifecycle', () => {
  test('refreshes abort state without recreating the session engine', async () => {
    let createEngineCalls = 0
    let refreshAbortControllerCalls = 0
    let interruptCalls = 0
    const session = createQueryEngineAppSession({
      cwd: '/tmp',
      tools: [],
      commands: [],
      mcpClients: [],
      agents: [],
      getAppState: () => ({}) as never,
      setAppState: () => undefined,
      readFileCache: new Map() as never,
      createEngine: () => {
        createEngineCalls += 1
        return {
          refreshAbortController() {
            refreshAbortControllerCalls += 1
          },
          interrupt() {
            interruptCalls += 1
          },
          async *submitMessage(prompt: string) {
            yield {
              type: 'assistant',
              message: { content: [{ type: 'text', text: prompt }] },
            } as never
          },
        }
      },
    } as never)

    for await (const _message of session.submitMessage('first')) {
      // drain
    }
    session.interrupt?.()
    for await (const _message of session.submitMessage('second')) {
      // drain
    }

    expect(createEngineCalls).toBe(1)
    expect(refreshAbortControllerCalls).toBe(2)
    expect(interruptCalls).toBe(1)
  })
})
```

This test protects the important behavior: after interrupt, the app session must not create a second `QueryEngine` because that would lose conversation history and file state.

- [ ] **Step 2: Run abort recovery test**

Run:

```bash
bun test src/app-runtime/createQueryEngineAppSession.test.ts
```

Expected: FAIL because `QueryEngineSessionLike` does not expose `refreshAbortController()` and `createQueryEngineAppSession()` does not call it before turns.

- [ ] **Step 3: Add a state-preserving abort refresh to `QueryEngine`**

In `src/QueryEngine.ts`, add this method next to `interrupt()`:

```ts
  refreshAbortController(): AbortController {
    if (this.abortController.signal.aborted) {
      this.abortController = createAbortController()
    }
    return this.abortController
  }
```

Do not rebuild `QueryEngine` to recover from abort. `QueryEngine` owns `mutableMessages`, `readFileState`, usage, loaded memory paths, and discovered skill state for the conversation.

- [ ] **Step 4: Extend the app-session interface**

In `src/app-runtime/createQueryEngineSessionController.ts`, extend `QueryEngineSessionLike`:

```ts
export type QueryEngineSessionLike = {
  submitMessage(
    prompt: AppSessionPrompt,
    options?: QueryEngineSessionOptions,
  ): AsyncIterable<SDKMessage>
  interrupt?: () => void
  refreshAbortController?: () => AbortController
}
```

- [ ] **Step 5: Call abort refresh before each submit**

Update `src/app-runtime/createQueryEngineAppSession.ts` to keep one engine and refresh its controller before each turn:

```ts
export type QueryEngineAppSessionConfig = Omit<
  QueryEngineConfig,
  'abortController' | 'canUseTool'
> & {
  abortController?: AbortController
  canUseTool?: QueryEngineConfig['canUseTool']
  createRequestId?: () => string
  createEngine?: (config: QueryEngineConfig) => QueryEngineSessionLike
}

export function createQueryEngineAppSession(
  config: QueryEngineAppSessionConfig,
): QueryEngineSessionLike {
  let currentPermissionHandler: AppPermissionRequestHandler | undefined
  const abortController = config.abortController ?? createAbortController()
  const engine =
    config.createEngine?.({
      ...config,
      abortController,
      canUseTool: createAppRuntimeCanUseTool({
        baseCanUseTool: config.canUseTool,
        createRequestId: config.createRequestId,
        getPermissionRequestHandler: () => currentPermissionHandler,
      }),
    }) ??
    new QueryEngine({
      ...config,
      abortController,
      canUseTool: createAppRuntimeCanUseTool({
        baseCanUseTool: config.canUseTool,
        createRequestId: config.createRequestId,
        getPermissionRequestHandler: () => currentPermissionHandler,
      }),
    })

  return {
    async *submitMessage(prompt, options?: QueryEngineSessionOptions) {
      engine.refreshAbortController?.()
      currentPermissionHandler = options?.onPermissionRequest
      try {
        yield* engine.submitMessage(prompt, {
          uuid: options?.uuid,
          isMeta: options?.isMeta,
        })
      } finally {
        currentPermissionHandler = undefined
      }
    },
    interrupt() {
      engine.interrupt?.()
    },
    refreshAbortController() {
      return engine.refreshAbortController?.() ?? abortController
    },
  }
}
```

After implementation, remove duplication in the `createAppRuntimeCanUseTool(...)` construction if it reads better locally. The required invariant is one engine per app session and a refreshed abort controller inside that engine before later turns.

- [ ] **Step 6: Run app-runtime tests**

Run:

```bash
bun test src/app-runtime/*.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit abort hardening**

```bash
git add src/QueryEngine.ts src/app-runtime/createQueryEngineAppSession.ts src/app-runtime/createQueryEngineSessionController.ts src/app-runtime/createQueryEngineAppSession.test.ts
git commit -m "fix: recover app sessions after abort"
```

## Task 5: Add Runtime-Backed WebSocket Server

**Files:**
- Create: `src/web/AppSessionWebSocketServer.ts`
- Create: `src/web/AppSessionWebSocketServer.test.ts`

- [ ] **Step 1: Write WebSocket server tests**

Create `src/web/AppSessionWebSocketServer.test.ts`:

```ts
import { afterEach, describe, expect, test } from 'bun:test'
import { WebSocket } from 'ws'
import { AppSessionController } from '../app-runtime/AppSessionController.js'
import { startAppSessionWebSocketServer } from './AppSessionWebSocketServer.js'

const servers: Array<{ stop: () => Promise<void> | void }> = []

afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()?.stop()
  }
})

function connect(url: string, token?: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const options = { headers: { Origin: 'http://localhost:5173' } }
    const ws = token
      ? new WebSocket(url, [`cat-code.${token}`], options)
      : new WebSocket(url, options)
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
  })
}

function nextJson(ws: WebSocket): Promise<unknown> {
  return new Promise(resolve => {
    ws.once('message', raw => resolve(JSON.parse(String(raw))))
  })
}

describe('AppSessionWebSocketServer', () => {
  test('requires the session token', async () => {
    const controller = new AppSessionController({
      async *runTurn() {},
    })
    const server = await startAppSessionWebSocketServer({
      port: 0,
      token: 'secret',
      allowedOrigins: ['http://localhost:5173'],
      controller,
    })
    servers.push(server)

    await expect(connect(`ws://127.0.0.1:${server.port}/ws`)).rejects.toThrow()
  })

  test('sends ready then submits a prompt and relays mapped messages', async () => {
    const prompts: unknown[] = []
    const controller = new AppSessionController({
      async *runTurn({ prompt }) {
        prompts.push(prompt)
        yield {
          type: 'assistant',
          uuid: 'assistant-1',
          message: { content: [{ type: 'text', text: 'hello from runtime' }] },
        } as never
      },
    })
    const server = await startAppSessionWebSocketServer({
      port: 0,
      token: 'secret',
      allowedOrigins: ['http://localhost:5173'],
      controller,
    })
    servers.push(server)

    const ws = await connect(`ws://127.0.0.1:${server.port}/ws`, 'secret')

    expect(await nextJson(ws)).toMatchObject({
      type: 'app.ready',
      protocolVersion: 1,
      inputEnabled: true,
    })

    ws.send(
      JSON.stringify({
        type: 'app.submit',
        requestId: 'submit-1',
        prompt: 'hi',
      }),
    )

    expect(await nextJson(ws)).toEqual({
      type: 'app.ack',
      requestId: 'submit-1',
    })
    expect(await nextJson(ws)).toEqual({
      type: 'app.event',
      event: {
        type: 'status.update',
        activeTurn: true,
        inputEnabled: false,
      },
    })
    expect(await nextJson(ws)).toEqual({
      type: 'app.event',
      event: {
        type: 'message.append',
        message: {
          id: 'assistant-1',
          role: 'assistant',
          content: 'hello from runtime',
          sdkType: 'assistant',
        },
      },
    })
    expect(prompts).toEqual(['hi'])
    ws.close()
  })

  test('responds to pending permissions and aborts active turns', async () => {
    let permissionResponse: unknown
    let releaseTurn: (() => void) | undefined
    const turnReleased = new Promise<void>(resolve => {
      releaseTurn = resolve
    })
    const controller = new AppSessionController({
      async *runTurn({ onPermissionRequest }) {
        permissionResponse = await onPermissionRequest({
          requestId: 'perm-1',
          request: {
            subtype: 'can_use_tool',
            tool_name: 'Bash',
            input: { command: 'pwd' },
            tool_use_id: 'toolu_1',
          },
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
    const ws = await connect(`ws://127.0.0.1:${server.port}/ws`, 'secret')
    await nextJson(ws)

    ws.send(JSON.stringify({ type: 'app.submit', requestId: 'submit-1', prompt: 'hi' }))
    expect(await nextJson(ws)).toEqual({
      type: 'app.ack',
      requestId: 'submit-1',
    })
    expect(await nextJson(ws)).toEqual({
      type: 'app.event',
      event: {
        type: 'status.update',
        activeTurn: true,
        inputEnabled: false,
      },
    })

    expect(await nextJson(ws)).toMatchObject({
      type: 'app.event',
      event: {
        type: 'permission.requested',
        request: { requestId: 'perm-1' },
      },
    })

    ws.send(
      JSON.stringify({
        type: 'permission.response',
        requestId: 'perm-1',
        response: {
          behavior: 'deny',
          message: 'no',
          interrupt: true,
        },
      }),
    )

    expect(await nextJson(ws)).toEqual({
      type: 'app.ack',
      requestId: 'perm-1',
    })
    expect(await nextJson(ws)).toMatchObject({
      type: 'app.event',
      event: {
        type: 'permission.resolved',
        requestId: 'perm-1',
      },
    })
    expect(permissionResponse).toMatchObject({ behavior: 'deny', message: 'no' })

    ws.send(JSON.stringify({ type: 'app.abort', requestId: 'abort-1', reason: 'stop' }))
    expect(await nextJson(ws)).toEqual({
      type: 'app.ack',
      requestId: 'abort-1',
    })
    expect(await nextJson(ws)).toEqual({
      type: 'app.event',
      event: {
        type: 'abort.status',
        abort: { status: 'requested', reason: 'stop' },
      },
    })
    releaseTurn?.()
    ws.close()
  })
})
```

- [ ] **Step 2: Run WebSocket tests and see the missing module failure**

Run:

```bash
bun test src/web/AppSessionWebSocketServer.test.ts
```

Expected: FAIL because `src/web/AppSessionWebSocketServer.ts` does not exist.

- [ ] **Step 3: Implement runtime-backed WebSocket server**

Create `src/web/AppSessionWebSocketServer.ts`:

```ts
import { WebSocketServer, type WebSocket } from 'ws'
import type { AppSessionController } from '../app-runtime/AppSessionController.js'
import {
  appClientMessageSchema,
  type AppServerMessage,
} from './appSessionProtocol.js'
import { createAppSessionEventMapper } from './appSessionEventMapper.js'

type StartAppSessionWebSocketServerOptions = {
  port: number
  token: string
  allowedOrigins: string[]
  controller: AppSessionController
}

type StartedAppSessionWebSocketServer = {
  port: number
  url: string
  protocol: string
  stop(): Promise<void>
}

const MAX_MESSAGE_BYTES = 128 * 1024

export async function startAppSessionWebSocketServer({
  port,
  token,
  allowedOrigins,
  controller,
}: StartAppSessionWebSocketServerOptions): Promise<StartedAppSessionWebSocketServer> {
  const requiredProtocol = `cat-code.${token}`
  const server = new WebSocketServer({
    host: '127.0.0.1',
    port,
    path: '/ws',
    handleProtocols(protocols) {
      return protocols.has(requiredProtocol) ? requiredProtocol : false
    },
    verifyClient(info) {
      const protocolHeader = info.req.headers['sec-websocket-protocol']
      const protocols = String(protocolHeader ?? '')
        .split(',')
        .map(protocol => protocol.trim())
      if (!protocols.includes(requiredProtocol)) return false

      const origin = info.origin
      if (origin && !allowedOrigins.includes(origin)) return false

      const host = info.req.headers.host ?? ''
      return host.startsWith('127.0.0.1:') || host.startsWith('localhost:')
    },
  })

  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })

  const clients = new Set<WebSocket>()
  const mapper = createAppSessionEventMapper()
  const unsubscribe = controller.subscribe(event => {
    for (const mappedEvent of mapper.map(event)) {
      broadcast(clients, { type: 'app.event', event: mappedEvent })
    }
  })

  server.on('connection', ws => {
    clients.add(ws)

    send(ws, {
      type: 'app.ready',
      protocolVersion: 1,
      inputEnabled: true,
      abort: controller.getAbortState(),
      goalSnapshot: controller.getGoalSnapshot(),
      pendingPermissionRequests: controller.getPendingPermissionRequests(),
    })

    ws.on('message', raw => {
      if (raw.length > MAX_MESSAGE_BYTES) {
        send(ws, {
          type: 'app.error',
          code: 'bad_request',
          message: 'Message is too large',
          retryable: false,
        })
        return
      }

      let parsed: unknown
      try {
        parsed = JSON.parse(String(raw))
      } catch {
        send(ws, {
          type: 'app.error',
          code: 'bad_request',
          message: 'Message is not valid JSON',
          retryable: false,
        })
        return
      }

      const result = appClientMessageSchema.safeParse(parsed)
      if (!result.success) {
        send(ws, {
          type: 'app.error',
          code: 'bad_request',
          message: result.error.issues[0]?.message ?? 'Invalid message',
          retryable: false,
        })
        return
      }

      const message = result.data
      if (message.type === 'app.ping') {
        send(ws, { type: 'app.pong', nonce: message.nonce })
        return
      }

      if (message.type === 'app.abort') {
        send(ws, { type: 'app.ack', requestId: message.requestId })
        controller.abort(message.reason)
        return
      }

      if (message.type === 'permission.response') {
        const pending = controller
          .getPendingPermissionRequests()
          .some(request => request.requestId === message.requestId)
        if (!pending) {
          send(ws, {
            type: 'app.error',
            requestId: message.requestId,
            code: 'permission_not_found',
            message: 'Permission request is no longer pending',
            retryable: false,
          })
          return
        }

        send(ws, { type: 'app.ack', requestId: message.requestId })
        controller.respondToPermissionRequest(
          message.requestId,
          message.response,
        )
        return
      }

      send(ws, { type: 'app.ack', requestId: message.requestId })
      broadcast(clients, {
        type: 'app.event',
        event: {
          type: 'status.update',
          activeTurn: true,
          inputEnabled: false,
        },
      })
      void controller
        .submit(message.prompt, message.options)
        .catch(error => {
          const errorMessage =
            error instanceof Error ? error.message : String(error)
          send(ws, {
            type: 'app.error',
            requestId: message.requestId,
            code:
              errorMessage === 'Session turn already running'
                ? 'turn_already_running'
                : 'internal_error',
            message: errorMessage,
            retryable: errorMessage === 'Session turn already running',
          })
        })
        .finally(() => {
          broadcast(clients, {
            type: 'app.event',
            event: {
              type: 'status.update',
              activeTurn: false,
              inputEnabled: true,
            },
          })
        })
    })

    ws.on('close', () => clients.delete(ws))
    ws.on('error', () => clients.delete(ws))
  })

  const address = server.address()
  const actualPort =
    typeof address === 'object' && address !== null ? address.port : port

  return {
    port: actualPort,
    url: `ws://127.0.0.1:${actualPort}/ws`,
    protocol: requiredProtocol,
    stop: () =>
      new Promise<void>(resolve => {
        unsubscribe()
        for (const client of clients) {
          client.close()
        }
        server.close(() => resolve())
      }),
  }
}

function broadcast(clients: Set<WebSocket>, message: AppServerMessage): void {
  for (const client of clients) {
    send(client, message)
  }
}

function send(ws: WebSocket, message: AppServerMessage): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(message))
  }
}
```

- [ ] **Step 4: Run WebSocket tests**

Run:

```bash
bun test src/web/AppSessionWebSocketServer.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run app web protocol tests together**

Run:

```bash
bun test src/web/appSessionProtocol.test.ts src/web/appSessionEventMapper.test.ts src/web/AppSessionWebSocketServer.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit runtime WebSocket server**

```bash
git add src/web/AppSessionWebSocketServer.ts src/web/AppSessionWebSocketServer.test.ts
git commit -m "feat: add runtime-backed web socket server"
```

## Task 6: Add Browser Reducer And Protocol Mirror

**Files:**
- Create: `web/src/appProtocol.ts`
- Create: `web/src/appState.ts`
- Create: `web/src/appState.test.ts`

- [ ] **Step 1: Create browser protocol types**

Create `web/src/appProtocol.ts`:

```ts
export type BrowserRole = "user" | "assistant" | "system";

export type BrowserMessage = {
  id: string;
  role: BrowserRole;
  content: string;
  sdkType?: string;
  sdkSubtype?: string;
};

export type AppAbortState =
  | { status: "idle" }
  | { status: "requested"; reason?: string }
  | { status: "aborted"; reason?: string };

export type AppBrowserEvent =
  | { type: "message.append"; message: BrowserMessage }
  | { type: "message.replace"; message: BrowserMessage }
  | { type: "message.delta"; id?: string; delta: string }
  | {
      type: "status.update";
      connected?: boolean;
      inputEnabled?: boolean;
      activeTurn?: boolean;
      model?: string;
      effort?: string;
      contextTokens?: number;
      notice?: string;
    }
  | { type: "goal.snapshot"; snapshot: unknown }
  | { type: "permission.requested"; request: AppPermissionRequest }
  | { type: "permission.resolved"; requestId: string; response: unknown }
  | { type: "abort.status"; abort: AppAbortState };

export type AppServerMessage =
  | {
      type: "app.ready";
      protocolVersion: 1;
      inputEnabled: boolean;
      abort: AppAbortState;
      goalSnapshot: unknown;
      pendingPermissionRequests: AppPermissionRequest[];
    }
  | { type: "app.event"; event: AppBrowserEvent }
  | { type: "app.ack"; requestId: string }
  | {
      type: "app.error";
      requestId?: string;
      code: string;
      message: string;
      retryable: boolean;
    }
  | { type: "app.pong"; nonce: string };

export type AppPermissionRequest = {
  requestId: string;
  request: {
    subtype: "can_use_tool";
    tool_name: string;
    input: Record<string, unknown>;
    permission_suggestions?: unknown[];
    blocked_path?: string;
    decision_reason?: string;
    title?: string;
    display_name?: string;
    tool_use_id: string;
    agent_id?: string;
    description?: string;
  };
};

export type AppClientMessage =
  | { type: "app.submit"; requestId: string; prompt: string }
  | { type: "app.abort"; requestId: string; reason?: string }
  | {
      type: "permission.response";
      requestId: string;
      response:
        | {
            behavior: "allow";
            updatedInput: Record<string, unknown>;
            updatedPermissions?: unknown[];
            toolUseID?: string;
            decisionClassification?:
              | "user_temporary"
              | "user_permanent"
              | "user_reject";
          }
        | {
            behavior: "deny";
            message: string;
            interrupt?: boolean;
            toolUseID?: string;
            decisionClassification?:
              | "user_temporary"
              | "user_permanent"
              | "user_reject";
          };
    };
```

- [ ] **Step 2: Write reducer tests**

Create `web/src/appState.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { createInitialAppState, reduceAppServerMessage } from "./appState";

describe("web app state reducer", () => {
  test("applies ready state", () => {
    const state = reduceAppServerMessage(createInitialAppState(), {
      type: "app.ready",
      protocolVersion: 1,
      inputEnabled: true,
      abort: { status: "idle" },
      goalSnapshot: null,
      pendingPermissionRequests: [],
    });

    expect(state.status.inputEnabled).toBe(true);
    expect(state.abort).toEqual({ status: "idle" });
  });

  test("appends messages and accumulates deltas", () => {
    let state = createInitialAppState();
    state = reduceAppServerMessage(state, {
      type: "app.event",
      event: {
        type: "message.append",
        message: {
          id: "assistant-1",
          role: "assistant",
          content: "hello",
        },
      },
    });
    state = reduceAppServerMessage(state, {
      type: "app.event",
      event: {
        type: "message.delta",
        delta: " world",
      },
    });

    expect(state.messages).toEqual([
      {
        id: "assistant-1",
        role: "assistant",
        content: "hello world",
      },
    ]);
  });

  test("tracks pending permission requests and resolutions", () => {
    let state = createInitialAppState();
    state = reduceAppServerMessage(state, {
      type: "app.event",
      event: {
        type: "permission.requested",
        request: {
          requestId: "perm-1",
          request: {
            subtype: "can_use_tool",
            tool_name: "Bash",
            input: { command: "pwd" },
            tool_use_id: "toolu_1",
          },
        },
      },
    });

    expect(state.pendingPermissions).toHaveLength(1);

    state = reduceAppServerMessage(state, {
      type: "app.event",
      event: {
        type: "permission.resolved",
        requestId: "perm-1",
        response: { behavior: "deny", message: "no" },
      },
    });

    expect(state.pendingPermissions).toEqual([]);
  });

  test("records errors as system messages", () => {
    const state = reduceAppServerMessage(createInitialAppState(), {
      type: "app.error",
      requestId: "submit-1",
      code: "turn_already_running",
      message: "Session turn already running",
      retryable: true,
    });

    expect(state.messages[0]).toMatchObject({
      role: "system",
      content: "Session turn already running",
    });
  });
});
```

- [ ] **Step 3: Run reducer tests and see the missing module failure**

Run:

```bash
bun run --cwd web test
```

Expected: FAIL because `web/src/appState.ts` does not exist.

- [ ] **Step 4: Implement the reducer**

Create `web/src/appState.ts`:

```ts
import type {
  AppAbortState,
  AppPermissionRequest,
  AppServerMessage,
  BrowserMessage,
} from "./appProtocol";

export type WebAppState = {
  messages: BrowserMessage[];
  status: {
    connected: boolean;
    reconnecting: boolean;
    inputEnabled: boolean;
    activeTurn: boolean;
    model?: string;
    effort?: string;
    contextTokens?: number;
    notice?: string;
  };
  abort: AppAbortState;
  goalSnapshot: unknown;
  pendingPermissions: AppPermissionRequest[];
};

export function createInitialAppState(): WebAppState {
  return {
    messages: [],
    status: {
      connected: false,
      reconnecting: true,
      inputEnabled: false,
      activeTurn: false,
    },
    abort: { status: "idle" },
    goalSnapshot: null,
    pendingPermissions: [],
  };
}

export function reduceAppServerMessage(
  state: WebAppState,
  message: AppServerMessage,
): WebAppState {
  if (message.type === "app.ready") {
    return {
      ...state,
      status: {
        ...state.status,
        inputEnabled: message.inputEnabled,
      },
      abort: message.abort,
      goalSnapshot: message.goalSnapshot,
      pendingPermissions: message.pendingPermissionRequests,
    };
  }

  if (message.type === "app.ack" || message.type === "app.pong") {
    return state;
  }

  if (message.type === "app.error") {
    return {
      ...state,
      messages: [
        ...state.messages,
        {
          id: `error-${message.requestId ?? crypto.randomUUID()}`,
          role: "system",
          content: message.message,
          sdkType: "app.error",
          sdkSubtype: message.code,
        },
      ],
    };
  }

  const event = message.event;

  if (event.type === "message.append") {
    return { ...state, messages: [...state.messages, event.message] };
  }

  if (event.type === "message.replace") {
    return {
      ...state,
      messages: [
        ...state.messages.filter(candidate => candidate.id !== event.message.id),
        event.message,
      ],
    };
  }

  if (event.type === "message.delta") {
    const last = state.messages[state.messages.length - 1];
    if (last?.role === "assistant") {
      return {
        ...state,
        messages: [
          ...state.messages.slice(0, -1),
          { ...last, content: last.content + event.delta },
        ],
      };
    }

    return {
      ...state,
      messages: [
        ...state.messages,
        {
          id: event.id ?? `assistant-${crypto.randomUUID()}`,
          role: "assistant",
          content: event.delta,
        },
      ],
    };
  }

  if (event.type === "status.update") {
    return {
      ...state,
      status: {
        ...state.status,
        connected: event.connected ?? state.status.connected,
        inputEnabled: event.inputEnabled ?? state.status.inputEnabled,
        activeTurn: event.activeTurn ?? state.status.activeTurn,
        model: event.model ?? state.status.model,
        effort: event.effort ?? state.status.effort,
        contextTokens: event.contextTokens ?? state.status.contextTokens,
        notice: event.notice ?? state.status.notice,
      },
    };
  }

  if (event.type === "goal.snapshot") {
    return { ...state, goalSnapshot: event.snapshot };
  }

  if (event.type === "permission.requested") {
    return {
      ...state,
      pendingPermissions: [
        ...state.pendingPermissions.filter(
          request => request.requestId !== event.request.requestId,
        ),
        event.request,
      ],
    };
  }

  if (event.type === "permission.resolved") {
    return {
      ...state,
      pendingPermissions: state.pendingPermissions.filter(
        request => request.requestId !== event.requestId,
      ),
    };
  }

  if (event.type === "abort.status") {
    return { ...state, abort: event.abort };
  }

  return state;
}
```

- [ ] **Step 5: Run browser tests and typecheck**

Run:

```bash
bun run --cwd web test
bun run --cwd web typecheck
```

Expected: both PASS.

- [ ] **Step 6: Commit browser reducer**

```bash
git add web/src/appProtocol.ts web/src/appState.ts web/src/appState.test.ts
git commit -m "feat: add browser app session reducer"
```

## Task 7: Wire The Browser Hook And UI To The App Protocol

**Files:**
- Modify: `web/src/hooks/useWebSocket.ts`
- Modify: `web/src/App.tsx`
- Modify: `web/vite.config.ts`

- [ ] **Step 1: Update `useWebSocket` to typed app messages**

Replace the legacy event types in `web/src/hooks/useWebSocket.ts` with:

```tsx
import { useCallback, useEffect, useRef, useState } from "react";
import type { AppClientMessage, AppServerMessage } from "../appProtocol";

function getWebSocketUrl() {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  return `${protocol}://${window.location.host}/ws`;
}

function getWebSocketProtocols() {
  const token = import.meta.env.VITE_CAT_CODE_WS_TOKEN as string | undefined;
  return token ? [`cat-code.${token}`] : undefined;
}

export function useWebSocket(onMessage: (data: AppServerMessage) => void) {
  const [connected, setConnected] = useState(false);
  const [reconnecting, setReconnecting] = useState(true);
  const [lastError, setLastError] = useState<string | undefined>();
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  useEffect(() => {
    let closedByCleanup = false;

    function connect(initial = false) {
      if (!initial) {
        setReconnecting(true);
      }

      const ws = new WebSocket(getWebSocketUrl(), getWebSocketProtocols());
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        setReconnecting(false);
        setLastError(undefined);
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as AppServerMessage;
          onMessageRef.current(data);
        } catch {
          setLastError("Received an invalid server message.");
        }
      };

      ws.onclose = () => {
        setConnected(false);
        if (closedByCleanup) return;
        setReconnecting(true);
        reconnectTimerRef.current = window.setTimeout(() => connect(), 1500);
      };

      ws.onerror = () => {
        setLastError("WebSocket connection failed.");
        ws.close();
      };
    }

    connect(true);

    return () => {
      closedByCleanup = true;
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
      }
      wsRef.current?.close();
    };
  }, []);

  const send = useCallback((data: AppClientMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data));
    }
  }, []);

  return { send, connected, reconnecting, lastError };
}
```

- [ ] **Step 2: Point the Vite proxy at IPv4 loopback**

Update `web/vite.config.ts`:

```ts
export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/ws": {
        target: "ws://127.0.0.1:3456",
        ws: true,
      },
    },
  },
});
```

- [ ] **Step 3: Replace legacy state handling in `web/src/App.tsx`**

Use the reducer as the source of truth:

```tsx
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MessageContent } from "./components/MessageContent";
import type { AppServerMessage } from "./appProtocol";
import {
  createInitialAppState,
  reduceAppServerMessage,
} from "./appState";
import { useWebSocket } from "./hooks/useWebSocket";
```

Replace `messages` and `status` state with:

```tsx
const [appState, setAppState] = useState(createInitialAppState);
const messages = appState.messages;
const status = appState.status;
```

Replace `onMessage` with:

```tsx
const onMessage = useCallback((data: AppServerMessage) => {
  setAppState(prev => reduceAppServerMessage(prev, data));
}, []);
```

Replace the connection effect with:

```tsx
useEffect(() => {
  setAppState(prev => ({
    ...prev,
    status: {
      ...prev.status,
      connected,
      reconnecting,
      notice: lastError ?? prev.status.notice,
    },
  }));
}, [connected, reconnecting, lastError]);
```

- [ ] **Step 4: Send app submit messages**

Replace the old `send({ type: "user_input", text })` call with:

```tsx
send({
  type: "app.submit",
  requestId: crypto.randomUUID(),
  prompt: text,
});
```

Keep the optimistic user message append in `handleSubmit`, but append it through `setAppState`:

```tsx
setAppState(prev => ({
  ...prev,
  messages: [
    ...prev.messages,
    { id: messageId("user"), role: "user", content: text },
  ],
}));
```

- [ ] **Step 5: Add a minimal permission panel**

Render the first pending permission above the composer:

```tsx
const pendingPermission = appState.pendingPermissions[0];
```

Add this JSX before the composer container:

```tsx
{pendingPermission ? (
  <div className="mx-auto w-full max-w-3xl rounded-2xl border border-amber-300/20 bg-amber-500/[0.08] p-4 text-sm text-amber-50">
    <div className="font-medium">
      {pendingPermission.request.display_name ??
        pendingPermission.request.tool_name} wants permission
    </div>
    <div className="mt-1 flex flex-wrap gap-2 text-xs text-amber-100/80">
      <span>Tool: {pendingPermission.request.tool_name}</span>
      {pendingPermission.request.agent_id ? (
        <span>Worker: {pendingPermission.request.agent_id}</span>
      ) : null}
      {pendingPermission.request.blocked_path ? (
        <span>Path: {pendingPermission.request.blocked_path}</span>
      ) : null}
    </div>
    {pendingPermission.request.decision_reason ? (
      <p className="mt-2 text-xs text-amber-100/80">
        {pendingPermission.request.decision_reason}
      </p>
    ) : null}
    <pre className="mt-2 max-h-40 overflow-auto rounded-xl bg-black/30 p-3 text-xs text-amber-100">
      {JSON.stringify(pendingPermission.request.input, null, 2)}
    </pre>
    <div className="mt-3 flex flex-wrap gap-2">
      <button
        type="button"
        onClick={() =>
          send({
            type: "permission.response",
            requestId: pendingPermission.requestId,
            response: {
              behavior: "allow",
              updatedInput: pendingPermission.request.input,
              decisionClassification: "user_temporary",
            },
          })
        }
        className="rounded-full bg-amber-300 px-3 py-1.5 text-xs font-medium text-zinc-950"
      >
        Allow once
      </button>
      <button
        type="button"
        onClick={() =>
          send({
            type: "permission.response",
            requestId: pendingPermission.requestId,
            response: {
              behavior: "deny",
              message: "Denied in browser app",
              decisionClassification: "user_reject",
            },
          })
        }
        className="rounded-full border border-amber-200/20 px-3 py-1.5 text-xs text-amber-50"
      >
        Deny
      </button>
      <button
        type="button"
        onClick={() =>
          send({
            type: "permission.response",
            requestId: pendingPermission.requestId,
            response: {
              behavior: "deny",
              message: "Cancelled in browser app",
              interrupt: true,
              decisionClassification: "user_reject",
            },
          })
        }
        className="rounded-full border border-red-200/20 px-3 py-1.5 text-xs text-red-100"
      >
        Cancel turn
      </button>
    </div>
  </div>
) : null}
```

This is not the full persistent-permission UI. Phase 1B must add updated-input editing, `updatedPermissions` persistence choices, sandbox/network distinction, and reconnect replay tests before full Phase 1 can be marked done.

- [ ] **Step 6: Add stop action while a turn is active**

Add a button beside `Send`:

```tsx
<button
  type="button"
  onClick={() =>
    send({
      type: "app.abort",
      requestId: crypto.randomUUID(),
      reason: "Stopped from browser",
    })
  }
  disabled={!connected || !status.activeTurn}
  className="mb-1 inline-flex h-11 shrink-0 items-center justify-center rounded-full border border-white/10 px-4 text-sm font-medium text-zinc-100 transition hover:bg-white/[0.08] disabled:text-zinc-600"
>
  Stop
</button>
```

- [ ] **Step 7: Run browser checks**

Run:

```bash
bun run --cwd web test
bun run --cwd web typecheck
bun run --cwd web build
```

Expected: PASS.

- [ ] **Step 8: Commit browser app protocol wiring**

```bash
git add web/src/hooks/useWebSocket.ts web/src/App.tsx web/vite.config.ts
git commit -m "feat: wire browser chat to app protocol"
```

## Task 8: Add Runtime-Backed App Session Bootstrap Seam

**Files:**
- Create: `src/app-runtime/createRuntimeBackedWebAppSession.ts`
- Create: `src/app-runtime/createRuntimeBackedWebAppSession.test.ts`

- [ ] **Step 1: Write bootstrap seam tests**

Create `src/app-runtime/createRuntimeBackedWebAppSession.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'
import { createRuntimeBackedWebAppSession } from './createRuntimeBackedWebAppSession.js'

describe('createRuntimeBackedWebAppSession', () => {
  test('creates an AppSessionController from a complete QueryEngine config', async () => {
    const controller = createRuntimeBackedWebAppSession({
      queryEngineConfig: {
        cwd: '/tmp',
        tools: [],
        commands: [],
        mcpClients: [],
        agents: [],
        getAppState: () => ({}) as never,
        setAppState: () => undefined,
        readFileCache: new Map() as never,
        createEngine: () => ({
          async *submitMessage(prompt: string) {
            yield {
              type: 'assistant',
              message: { content: [{ type: 'text', text: prompt }] },
            } as never
          },
        }),
      } as never,
    })

    const events: string[] = []
    controller.subscribe(event => events.push(event.type))
    await controller.submit('hello')

    expect(events).toEqual(['message'])
  })
})
```

- [ ] **Step 2: Run bootstrap seam test**

Run:

```bash
bun test src/app-runtime/createRuntimeBackedWebAppSession.test.ts
```

Expected: FAIL because `src/app-runtime/createRuntimeBackedWebAppSession.ts` does not exist.

- [ ] **Step 3: Implement the bootstrap seam**

Create `src/app-runtime/createRuntimeBackedWebAppSession.ts`:

```ts
import {
  createQueryEngineAppSession,
  type QueryEngineAppSessionConfig,
} from './createQueryEngineAppSession.js'
import { createQueryEngineSessionController } from './createQueryEngineSessionController.js'

export type RuntimeBackedWebAppSessionOptions = {
  queryEngineConfig: QueryEngineAppSessionConfig
}

export function createRuntimeBackedWebAppSession({
  queryEngineConfig,
}: RuntimeBackedWebAppSessionOptions) {
  return createQueryEngineSessionController(
    createQueryEngineAppSession({
      ...queryEngineConfig,
      includePartialMessages: true,
    }),
  )
}
```

- [ ] **Step 4: Run app-runtime tests**

Run:

```bash
bun test src/app-runtime/*.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit bootstrap seam**

```bash
git add src/app-runtime/createRuntimeBackedWebAppSession.ts src/app-runtime/createRuntimeBackedWebAppSession.test.ts
git commit -m "feat: add runtime backed web app session seam"
```

## Task 9: Write The Phase 1B Startup Extraction Plan

**Files:**
- Read: `src/main.tsx`
- Read: `src/QueryEngine.ts`
- Read: `src/setup.ts`
- Create: `docs/superpowers/plans/2026-06-07-dedicated-app-phase1b-startup-extraction.md`

- [ ] **Step 1: Inspect current `--web` branch and normal setup owners**

Run:

```bash
rg -n "--web|webModeEnabled|startWebUIServer|Web mode is browser-first|setup\\(|launchRepl\\(" src/main.tsx
rg -n "const sessionConfig|initialTools|mcpClients|commands|agentDefinitions|initialState|getDefaultAppState|readFileCache" src/main.tsx src/setup.ts
sed -n '130,180p' src/QueryEngine.ts
```

Expected findings:

- Current `--web` branch starts the legacy server, spawns Vite, opens browser, prints that input is disabled, and waits forever.
- Normal setup, command/agent/MCP/AppState/QueryEngine assembly is later in the file and is not reached by current `--web`.
- `main.tsx` currently assembles a REPL `sessionConfig`, not a clean `QueryEngineAppSessionConfig`.
- `QueryEngineConfig` requires `cwd`, `tools`, `commands`, `mcpClients`, `agents`, `canUseTool`, `getAppState`, `setAppState`, `readFileCache`, model/thinking settings, and optional partial-message status hooks.

- [ ] **Step 2: Create the Phase 1B plan file**

Create `docs/superpowers/plans/2026-06-07-dedicated-app-phase1b-startup-extraction.md` with this header:

```markdown
# Dedicated App Phase 1B Startup Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire `cat-code --web` to the runtime-backed app-session WebSocket server by extracting real `QueryEngineAppSessionConfig` assembly from the normal startup path without mounting the Ink REPL.

**Architecture:** Reuse normal startup, setup, commands, agents, MCP, permission mode, AppState, and QueryEngine configuration owners. `src/main.tsx` remains the router; any new helper owns config assembly and is tested before `--web` routing changes.

**Tech Stack:** Bun tests, `src/main.tsx`, `src/setup.ts`, `src/QueryEngine.ts`, `src/app-runtime/createRuntimeBackedWebAppSession.ts`, `src/web/AppSessionWebSocketServer.ts`, Vite dev server, and final manual `bun run dev -- --web` smoke.
```

- [ ] **Step 3: Add the required Phase 1B task list**

The Phase 1B plan must contain these tasks with tests and exact file paths:

- Extract a `createQueryEngineAppSessionConfigFromSetup(...)` helper from the normal interactive setup path.
- Add tests proving the helper includes commands, MCP clients, agents, permission mode, `getAppState`, `setAppState`, `readFileCache`, model/thinking settings, and `includePartialMessages: true`.
- Add a browser launcher helper that starts Vite on `127.0.0.1`, injects `VITE_CAT_CODE_WS_TOKEN`, opens `http://127.0.0.1:5173` without a token query parameter, and cleans up the child process.
- Route `--web` through the normal setup path, start `startAppSessionWebSocketServer(...)`, skip `launchRepl()` only after the runtime-backed server is ready, and fail visibly if bootstrap fails.
- Add a smoke script or manual checklist for `bun run dev -- --web`.
- Verify terminal mode still reaches `launchRepl()` unchanged.

- [ ] **Step 4: Add the Phase 1B permission coverage task**

The Phase 1B plan must explicitly cover the remaining permission Definition of Done from `docs/design/dedicated-app/migration-scope.md`:

- cancel as `behavior: "deny"` with `interrupt: true`
- updated input
- persistent permission updates from `updatedPermissions`
- worker identity display from `agent_id`
- sandbox/network distinction when present in permission suggestions or decision metadata
- pending permission replay after reconnect
- rejection behavior for stale permission request ids

- [ ] **Step 5: Validate the Phase 1B plan**

Run:

```bash
git diff --check
rg -n "T[B]D|T[O]DO|implement [l]ater|fill in [d]etails|appropriate error [h]andling|add [v]alidation|handle [e]dge cases|Write tests for the [a]bove|Similar to Task [0-9]" docs/superpowers/plans/2026-06-07-dedicated-app-phase1b-startup-extraction.md
```

Expected:

- `git diff --check` exits 0.
- The placeholder scan exits 1 with no matches.

- [ ] **Step 6: Commit the Phase 1B plan**

```bash
git add docs/superpowers/plans/2026-06-07-dedicated-app-phase1b-startup-extraction.md
git commit -m "docs: plan dedicated app startup extraction"
```

## Final Verification

Run these commands before calling Phase 1A complete:

```bash
bun test src/app-runtime/*.test.ts src/web/*.test.ts
bun run --cwd web test
bun run --cwd web typecheck
bun run --cwd web build
bun run build:dev:full
```

Expected: all commands PASS.

Run docs/code hygiene checks:

```bash
git diff --check
rg -n "T[B]D|T[O]DO|implement [l]ater|fill in [d]etails|appropriate error [h]andling|add [v]alidation|handle [e]dge cases|Write tests for the [a]bove|Similar to Task [0-9]" docs/design/dedicated-app docs/superpowers/plans/2026-06-06-dedicated-app-phase1-runtime-backed-single-chat.md
```

Expected:

- `git diff --check` exits 0.
- The placeholder scan exits 1 with no matches.

## Execution Notes

- Do Task 1 first. It creates the web verification floor needed for all later browser work.
- Do Tasks 2 through 5 before planning startup extraction. The server should be testable with a fake `AppSessionController` before it is connected to real startup.
- Task 9 is a planning handoff only. It should not edit `src/main.tsx`.
- Keep the legacy `WebUIBus` path available until the runtime-backed path works. Do not expand legacy events.
- Phase 1A is complete at the tested transport/bootstrap seam. Phase 1B owns QueryEngine config extraction, `--web` routing, and manual smoke.
