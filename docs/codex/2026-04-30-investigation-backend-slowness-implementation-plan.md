# Codex Backend Slowness — Implementation Plan

**Date:** 2026-04-24
**Companion to:** `docs/codex/2026-04-30-investigation-backend-slowness-current-code.md`
**Goal:** Close the latency gap between this fork and upstream `openai/codex` against `chatgpt.com/backend-api/codex/responses`.

## 0. Read this first

This plan is long on purpose. Every section is context the implementer needs to make the right judgment calls mid-PR. Skim:

- **Section 1** if you're new to the Codex path — tells you where data flows and which module owns what.
- **Section 2** before writing code — lists everything verified against current source plus everything assumed (these are the places the plan may be wrong).
- **Sections 3-7** for each change. Each one has: problem, upstream behavior, design, code sketch with exact file:line anchors, test impact, rollback.
- **Section 8** for shipping — order, dependencies, verification protocol, success criteria.
- **Section 9** for what's not in this plan and why (for the reviewer who asks "why isn't X here").

## 1. Topology primer

### Two transports, one conversation

Every Codex request flows:

```
Anthropic SDK call
  → fetch interceptor in createCodexFetch                    (codex-fetch-adapter.ts:1689)
  → translateToCodexBody builds the Codex-shaped body         (codex-fetch-adapter.ts:504)
  → if !hasStickyHttpFallback(convId):
      → streamTurnViaWebSocketLocked                          (codex-websocket-transport.ts:245)
         → acquireConversationTurn (per-conv queue)           (codex-websocket-transport.ts:94)
         → ensureWebSocketSession (dial if needed)            (codex-websocket-transport.ts:233)
         → prewarmWebSocket (WAITS for response.completed)    (codex-websocket-transport.ts:581) ← BAD
         → streamTurnViaWebSocket (real turn)                 (codex-websocket-transport.ts:525)
  → else:
      → HTTP POST to CODEX_BASE_URL                           (codex-fetch-adapter.ts:1774)
  → translateCodexWsStreamToAnthropic / translateCodexStreamToAnthropic (1396 / 1378)
  → SSE events flow back up the Anthropic SDK
```

### What "conversation" means here

A Codex conversation is uniquely identified by a UUID-shaped string used in three places simultaneously:

- `prompt_cache_key` on the request body (`codex-fetch-adapter.ts:1736`)
- `session_id` HTTP header and `x-client-request-id` HTTP header on the connect (`codex-websocket-transport.ts:156-157` and adapter `:1781-1782`)

Three conversation-id sources exist, in priority order (`codex-fetch-adapter.ts:1733`):
1. `conversationIdOverride` — explicitly passed by subagents and side queries
2. `codexPromptCacheKey` — set at session bootstrap and on session-switch (`setup.ts:90,95-97`)
3. `CODEX_SESSION_ID` — process-local fallback UUID

**Subagents** (`src/services/api/claude.ts:743-753`) use `${sessionId}/${agentId}` — a distinct conversation per subagent. Each has its own WS session, its own prewarm, its own KV-cache state. Multi-subagent flows pay the connect + prewarm cost N times.

**Side queries** (session title generation) use `side/title/${uuid}` — also a distinct conversation.

### Where the WebSocket `WsSession` state lives

The module-level `sessions: Map<string, WsSession>` (`codex-websocket-transport.ts:82`) is keyed by conversationId. Fields that matter for the plan:

- `lastResponseId` — used as `previous_response_id` on the next turn
- `lastRequestSignature` — stringified non-input body fields; used to detect "real" turn changes
- `lastRequestInput` — exact items sent last turn; canonical baseline for delta
- `lastResponseOutputItems` — completed output items last turn
- `turnState` — sticky routing token; **currently dead code** (see Section 4)
- `accountId` — ChatGPT account whose token opened this WS

## 2. Upstream ground truth vs. current code

Verified against `codex-rs/core/src/client.rs` and `codex-rs/core/src/session_startup_prewarm.rs` via external agent read (see conversation log).

| Concern | Upstream behavior | Current code | Match? |
|---|---|---|---|
| Prewarm scheduling | Async via `tokio::spawn` at session startup | Sync, on first real turn | **NO** |
| Prewarm body | `build_prompt(Vec::new(), ...)` — empty input | Full real `codexBody` including user input | **NO** |
| Prewarm lifecycle | One-shot (`if last_request.is_some() return Ok(())`) | Runs whenever `lastResponseId` unset OR signature changes | **NO** (side effect of serial path) |
| `x-codex-turn-state` | Server→client via WS upgrade response header; per-turn `OnceLock<String>`; echoed as request header | Field declared, reads always `null`, never captured | **NO** (dead code) |
| `OpenAI-Beta` (WS) | `responses_websockets=2026-02-06` | `responses_websockets=2026-02-06` | **yes** |
| `store` on body | `provider.is_azure_responses_endpoint()` → false on ChatGPT | `false` hardcoded | **yes** (same effective value) |
| `service_tier` | `ServiceTier::Fast` → body `"priority"` | Not set anywhere | **NO** |
| `originator` | `codex_cli_rs` | `codex_cli_rs` (`codex-fetch-adapter.ts:1764`) | **yes** |
| `prompt_cache_key` | `conversation_id.to_string()` | `conversationId` | **yes** |
| `session_id` header | underscore (`session_id`) | underscore on WS connect (`:156`) and HTTP (`:1781`) | **yes** |
| `x-client-request-id` | `conversation_id` | `conversationId` (`:157`, `:1782`) | **yes** |

### Things I assumed without verifying

Flag these to the reviewer:

1. **`x-codex-turn-state` rotation:** plan assumes it's captured once on WS upgrade and reused for the lifetime of the WS. Upstream has per-turn `OnceLock`, which could imply per-turn rotation. The instrumentation PR in Section 4 resolves this.
2. **Cross-account `previous_response_id` reuse** (Change 5): plan assumes the server either accepts or cleanly returns "not found"; not tested. Graceful-degradation path exists (`StaleResponseIdError` at `codex-websocket-transport.ts:268`), so the downside of a wrong assumption is bounded.
3. **`service_tier` on prewarm:** upstream shares `build_responses_request` for both prewarm and real turn, so the field appears on both. Plan replicates that. If the ChatGPT backend rejects `service_tier: "priority"` on `generate: false` prewarm turns, we'd need a conditional.

## 3. Change 1 — Async startup prewarm with empty-input seed (P0)

### Problem

`streamTurnViaWebSocketLocked` at `codex-websocket-transport.ts:251-263`:

```ts
const releaseTurn = await acquireConversationTurn(conversationId)
try {
  await ensureWebSocketSession(conversationId, authHeaders)
  await prewarmWebSocket(conversationId, codexBody, authHeaders, fullInputLength)
  yield* streamTurnViaWebSocket(...)
}
```

The `prewarmWebSocket` call is on the critical path and sends the full `codexBody` including the real user input (`codex-websocket-transport.ts:606`). On turn 1 the skip condition at `:595-601` fails (no `lastResponseId`), so the server ingests the full prompt twice — once for the prewarm, once for the real turn.

Upstream does this async at session startup with `input: []`. The user's first turn doesn't wait unless the startup task is somehow still in flight.

### Upstream reference

```rust
// codex-rs/core/src/session_startup_prewarm.rs
let startup_prewarm = tokio::spawn(async move {
    schedule_startup_prewarm_inner(startup_prewarm_session, base_instructions).await
});

let startup_prompt = build_prompt(
    Vec::new(),  // ← empty input
    startup_router.as_ref(),
    startup_turn_context.as_ref(),
    BaseInstructions { text: base_instructions },
);

client_session.prewarm_websocket(&startup_prompt, ...).await?;
```

```rust
// codex-rs/core/src/client.rs
impl ModelClientSession {
    pub async fn prewarm_websocket(&self, ...) -> Result<()> {
        if self.websocket_session.last_request.is_some() {
            return Ok(());  // one-shot
        }
        // ... waits for response.completed internally
    }
}
```

### Design

Two-part change:

**Part A — introduce `schedulePrewarm`**, a fire-and-forget async entry point on the transport.

New `WsSession` fields:

```ts
// codex-websocket-transport.ts — WsSession interface at :61
interface WsSession {
  // ... existing fields unchanged
  prewarmPromise: Promise<void> | null  // resolves when startup prewarm completes (or fails)
  prewarmDone: boolean                  // latched on completion
}
```

Module-level map for prewarms scheduled before the WS has opened:

```ts
// codex-websocket-transport.ts — near :82
const pendingPrewarms = new Map<string, Promise<void>>()
```

New public API:

```ts
// codex-websocket-transport.ts — replace prewarmWebSocket with:
export function schedulePrewarm(
  conversationId: string,
  seedCodexBody: Record<string, unknown>,
  authHeaders: Record<string, string>,
): void {
  // Idempotent: if already scheduled or done for this conv, no-op.
  const existing = sessions.get(conversationId)
  if (existing?.prewarmDone || existing?.prewarmPromise) return
  if (pendingPrewarms.has(conversationId)) return

  const promise = (async () => {
    try {
      await ensureWebSocketSession(conversationId, authHeaders)
      const session = sessions.get(conversationId)
      if (!session || session.ws.readyState !== WebSocket.OPEN) return

      // Seed body: instructions + all non-input fields from the real body,
      // but input = []. Matches build_prompt(Vec::new(), ...) in upstream
      // session_startup_prewarm.rs.
      const seedBody = { ...seedCodexBody, input: [] }

      const events = streamTurnViaWebSocket(
        conversationId,
        seedBody,
        authHeaders,
        /* fullInputLength */ 0,
        /* isPrewarm */ true,
      )
      for await (const _event of events) { /* drain */ }
      logForDebugging(
        `[codex-ws] startup prewarm complete conv=${conversationId.slice(0, 8)} ` +
        `response_id=${sessions.get(conversationId)?.lastResponseId?.slice(0, 16) ?? 'none'}`,
      )
    } catch (err) {
      logForDebugging(
        `[codex-ws] startup prewarm failed (non-fatal) conv=${conversationId.slice(0, 8)}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
        { level: 'warn' },
      )
    } finally {
      const session = sessions.get(conversationId)
      if (session) session.prewarmDone = true
      pendingPrewarms.delete(conversationId)
    }
  })()

  pendingPrewarms.set(conversationId, promise)
}
```

**Part B — openSession must pick up the pending prewarm**, because `schedulePrewarm` calls `ensureWebSocketSession` before the session exists.

```ts
// codex-websocket-transport.ts — openSession at :166 (inside ws.onopen)
ws.onopen = () => {
  clearTimeout(timeout)
  const session: WsSession = {
    ws,
    accountId: authHeaders['chatgpt-account-id'] ?? null,
    turnState: null,  // becomes non-null after Change 2 lands
    lastResponseId: null,
    lastRequestSignature: null,
    lastRequestInput: [],
    lastResponseOutputItems: [],
    prewarmPromise: pendingPrewarms.get(conversationId) ?? null,
    prewarmDone: false,
  }
  sessions.set(conversationId, session)
  logForDebugging(`[codex-ws] connected for ${conversationId.slice(0, 8)}`)
  resolve(session)
}
```

**Part C — `streamTurnViaWebSocketLocked` awaits the prewarm only if still in flight.**

```ts
// codex-websocket-transport.ts — replace :251-263
export async function* streamTurnViaWebSocketLocked(
  conversationId: string,
  codexBody: Record<string, unknown>,
  authHeaders: Record<string, string>,
  fullInputLength: number,
): AsyncGenerator<Record<string, unknown>> {
  const releaseTurn = await acquireConversationTurn(conversationId)
  try {
    await ensureWebSocketSession(conversationId, authHeaders)
    const session = sessions.get(conversationId)
    if (session?.prewarmPromise && !session.prewarmDone) {
      // Startup prewarm still in flight — wait for it so the first real
      // turn gets previous_response_id. Zero cost if already done.
      await session.prewarmPromise
    }
    yield* streamTurnViaWebSocket(
      conversationId,
      codexBody,
      authHeaders,
      fullInputLength,
    )
  } finally {
    releaseTurn()
  }
}
```

**Part D — delete the old `prewarmWebSocket`** at `codex-websocket-transport.ts:581-616`. No other callers exist (verified via grep).

### Where to trigger `schedulePrewarm`

Call it from inside the fetch interceptor the first time a conversationId is seen, just before the WS branch runs:

```ts
// codex-fetch-adapter.ts — inside createCodexFetch's returned async fn,
// AFTER `codexBody.prompt_cache_key = conversationId` at :1736, and AFTER
// the pre-request log at :1745-1750. Location-wise, just before the
// `requestCacheMetadata` object at :1752:

// Kick off async startup prewarm for this conversation. Idempotent — only
// the first call per conversationId does real work. Non-blocking.
schedulePrewarm(conversationId, codexBody, authHeaders)
```

Export `schedulePrewarm` from `codex-websocket-transport.ts` and import at the top of `codex-fetch-adapter.ts` alongside `streamTurnViaWebSocketLocked`.

### Alternative trigger considered

Triggering in `setup.ts` alongside `setCodexPromptCacheKey` was rejected: at bootstrap time we don't have a token, model, or instruction block to seed with. Option A (first fetch interceptor call) is cheaper and achieves the same latency outcome — by the time the user's real turn kicks off the interceptor a second time, the prewarm has a head start.

### Edge cases

- **Seed signature matches real turn:** after the prewarm records `lastResponseId` and `lastRequestSignature`, the real turn calls `createRequestSignature(codexBody)` at `:669`. The signature strips `input`, so the seed's signature and real turn's signature are identical (same model, same instructions, same tools, same reasoning, same service_tier). Canonical reconciliation at `:678` treats the seed as the baseline and delta = all of the real turn's input items. ✓ correct.
- **Seed fails, real turn falls through:** the try/catch in `schedulePrewarm` swallows the error and latches `prewarmDone = true`. The real turn sees no `lastResponseId`, takes the "no prior response_id" branch at `:667-668`, and sends a full body. ✓ correct fallback.
- **Real turn arrives before prewarm completes:** `streamTurnViaWebSocketLocked` awaits `prewarmPromise`. Worst case: both turns land on the WS back-to-back with the real turn starting only microseconds after prewarm completion. ✓ correct.
- **Subagent first call:** `schedulePrewarm` is idempotent per conversationId. Each subagent triggers its own prewarm the first time its fetch interceptor fires. Unchanged cost profile for subagents but moved off the critical path. ✓.
- **`/switch-account` clears the WS but the pending prewarm map may hold stale entries:** update `resetCodexCacheContext` or add a companion export that clears `pendingPrewarms` too. Easier: reset in `clearWebSocketSession(conversationId)` at `:131-138`:

  ```ts
  export function clearWebSocketSession(conversationId: string): void {
    const session = sessions.get(conversationId)
    if (session) {
      try { session.ws.close() } catch { /* ignore */ }
      sessions.delete(conversationId)
      logForDebugging(`[codex-ws] session cleared for ${conversationId.slice(0, 8)}`)
    }
    pendingPrewarms.delete(conversationId)  // ← add this
  }
  ```

### Test impact

Existing tests in `codex-websocket-transport.test.ts` and `codex-fetch-adapter.test.ts` use `FakeWebSocket` with `globalThis.WebSocket` swapping (`codex-websocket-transport.test.ts:90-105`). These continue to work — `schedulePrewarm` uses `new WebSocket(...)` through `ensureWebSocketSession`, which is already mocked.

New tests in `codex-websocket-transport.test.ts`:

1. `schedulePrewarm` sends `input: []` even when the seed body has items — assert `fakeWs.getSent()[0].input` is `[]`.
2. `schedulePrewarm` skips on re-call for the same conversationId — spy on `ws.send` call count.
3. `streamTurnViaWebSocketLocked` awaits `prewarmPromise` when not done — use a deferred promise, assert order.
4. When prewarm throws, the real turn still runs as a full send — simulate prewarm error, assert real turn sent without `previous_response_id`.
5. After prewarm completes, real turn sends delta with `previous_response_id` — end-to-end happy path.
6. `clearWebSocketSession(conv)` purges `pendingPrewarms[conv]` — direct state inspection via an exported test-only accessor, or indirect via scheduling twice and confirming both runs actually execute.

Update `codex-fetch-adapter.test.ts` existing tests only if they assert on the pre/post message pattern of two-request prewarm+real (unlikely — check each that invokes the WS path).

### Rollback

Revert both files. Restore `prewarmWebSocket` and its call site in `streamTurnViaWebSocketLocked`. No persisted state, no migration.

## 4. Change 2 — Capture `x-codex-turn-state` (P0)

### Problem

`codex-websocket-transport.ts`:

- `WsSession.turnState: string | null` declared at `:68`
- Initialized to `null` at `:171`
- Read into `turnStateForThisTurn` at `:632`, then reset to `null` at `:633`
- Echoed as body field `'x-codex-turn-state'` at `:740-742` if non-null

Nothing ever assigns a non-null value. The comment at `:142-146` acknowledges Bun's `new WebSocket(url, { headers })` doesn't expose upgrade response headers, but the workaround ("rely on reconnection") is a dead-end — reconnection doesn't fetch them either.

Also note: the current code echoes `turnState` as a **body field** named `'x-codex-turn-state'`. Upstream echoes it as an **HTTP header** on the WS connect request. The body-field echo is wrong regardless and should be deleted.

### Upstream reference

```rust
// codex-rs/codex-api/src/endpoint/responses_websocket.rs — connect_websocket
if let Some(turn_state) = turn_state
    && let Some(header_value) = response.headers().get(X_CODEX_TURN_STATE_HEADER)
        .and_then(|value| value.to_str().ok())
{
    let _ = turn_state.set(header_value.to_string());
}

// codex-rs/core/src/client.rs — build_responses_headers
if let Some(turn_state) = turn_state
    && let Some(state) = turn_state.get()
    && let Ok(header_value) = HeaderValue::from_str(state)
{
    headers.insert(X_CODEX_TURN_STATE_HEADER, header_value);
}
```

Upstream stores it in `Arc<OnceLock<String>>`, set once per turn, echoed on subsequent requests within the same turn.

### Dependency check

**`ws@^8.20.0` is already a project dependency** (`package.json:112`). Two existing code paths already consume it:

- `src/utils/mcpWebSocketTransport.ts` — MCP WebSocket transport
- `src/cli/transports/WebSocketTransport.ts` — CLI bridge transport
- `src/services/voiceStreamSTT.ts` — voice streaming

Both existing MCP/CLI transports implement a **dual-runtime pattern**: detect `typeof Bun !== 'undefined'`, use Bun's native `WebSocket` in Bun mode (supports `headers` option), fall back to `ws` package otherwise. Bun's native `WebSocket` does **not** expose upgrade response headers via any documented API as of the Bun version pinned here (`bun@1.3.11`).

**Therefore:** Change 2 must switch the Codex transport to `ws`'s `WebSocket` unconditionally — because we need `upgrade` event headers, which Bun's native doesn't expose. This does not affect the other dual-runtime transports.

### Design

Replace the `globalThis.WebSocket` call at `codex-websocket-transport.ts:152` with `new WSNode(...)` from the `ws` package.

The `ws` package's `WebSocket` class fires an `upgrade` event with the raw `IncomingMessage` before the `open` event. Upgrade response headers (including `x-codex-turn-state`) are on `res.headers`.

```ts
// codex-websocket-transport.ts — top of file
import WSNode from 'ws'
import type { IncomingMessage } from 'http'
```

Rewrite `openSession` (`:147-187`):

```ts
async function openSession(
  conversationId: string,
  authHeaders: Record<string, string>,
): Promise<WsSession> {
  return new Promise((resolve, reject) => {
    const ws = new WSNode(CODEX_WS_URL, {
      headers: {
        ...authHeaders,
        'OpenAI-Beta': WS_BETA_HEADER,
        session_id: conversationId,
        'x-client-request-id': conversationId,
      },
    })

    let capturedTurnState: string | null = null

    // Upgrade event fires once, between connection and WebSocket handshake.
    ws.on('upgrade', (res: IncomingMessage) => {
      const header = res.headers['x-codex-turn-state']
      if (typeof header === 'string') {
        capturedTurnState = header
      } else if (Array.isArray(header) && typeof header[0] === 'string') {
        capturedTurnState = header[0]
      }
    })

    const timeout = setTimeout(() => {
      ws.close()
      reject(new Error('WebSocket connect timeout'))
    }, 15_000)

    ws.on('open', () => {
      clearTimeout(timeout)
      const session: WsSession = {
        ws: ws as unknown as WebSocket, // see WsSession.ws type note below
        accountId: authHeaders['chatgpt-account-id'] ?? null,
        turnState: capturedTurnState,
        lastResponseId: null,
        lastRequestSignature: null,
        lastRequestInput: [],
        lastResponseOutputItems: [],
        prewarmPromise: pendingPrewarms.get(conversationId) ?? null,
        prewarmDone: false,
      }
      pendingPrewarms.delete(conversationId)
      sessions.set(conversationId, session)
      logForDebugging(
        `[codex-ws] connected for ${conversationId.slice(0, 8)}` +
        (capturedTurnState
          ? ` turn_state=${capturedTurnState.slice(0, 12)}...`
          : ' turn_state=none'),
      )
      resolve(session)
    })

    ws.on('error', () => {
      clearTimeout(timeout)
      reject(new Error('WebSocket connect error'))
    })
  })
}
```

Rewrite event-listener wiring in `_streamTurnAttempt`. `ws` uses Node event emitter conventions (`on` / `off`) with `data: Buffer | string`:

Replace at `codex-websocket-transport.ts:930-932`:

```ts
session.ws.addEventListener('message', onMessage)
session.ws.addEventListener('error', onError)
session.ws.addEventListener('close', onClose)
```

with:

```ts
// ws.WebSocket uses EventEmitter API; message payload can be Buffer | string.
const nws = session.ws as unknown as WSNode
nws.on('message', onMessage as (data: Buffer | string) => void)
nws.on('error', onError as () => void)
nws.on('close', onClose as (code: number, reason: Buffer) => void)
```

And update the message handler at `:767-769`:

```ts
const onMessage = (data: Buffer | string) => {
  const text = typeof data === 'string' ? data : data.toString('utf8')
  // ... rest unchanged — uses `text`
}
```

And the teardown at `:964-966` and `:1065-1068`:

```ts
const nws = session.ws as unknown as WSNode
nws.off('message', onMessage as (data: Buffer | string) => void)
nws.off('error', onError as () => void)
nws.off('close', onClose as (code: number, reason: Buffer) => void)
```

`onClose` shape changes too — `ws` fires `(code: number, reason: Buffer)`, not a `CloseEvent`. Update `:891-928`:

```ts
const onClose = (code?: number, reason?: Buffer) => {
  const closeCode = typeof code === 'number' ? code : undefined
  const rawReason = reason?.toString('utf8') ?? ''
  const closeReason = rawReason.length > 0 ? rawReason : 'none'
  // wasClean doesn't exist on ws; infer from code range.
  const wasClean = closeCode !== undefined && closeCode >= 1000 && closeCode < 1100
  // ... rest unchanged
}
```

### Remove the body-field echo

The echo at `:740-742` is wrong — drop it:

```ts
// DELETE:
if (turnStateForThisTurn) {
  requestBody['x-codex-turn-state'] = turnStateForThisTurn
}
```

Upstream uses the header, not a body field. Because `ws` sends headers on the connect (which we already do), and upstream's `OnceLock` is set from the upgrade response (one-time), the captured `turnState` is for observability only — unless the server rotates it (see instrumentation below).

### Instrumentation PR first (recommended)

Before committing to the refactor, ship a **one-shot instrumentation PR** that logs all upgrade response headers. This answers:

- Is `x-codex-turn-state` actually present on the WS upgrade for this endpoint?
- Does the server ever send a rotated value via a mid-stream SSE event?
- Are there other routing headers (`cf-ray`, etc.) we're missing?

Minimal version: temporarily switch `codex-websocket-transport.ts` to `WSNode` (since `ws` is already a dep — add the import, swap `new WebSocket` for `new WSNode`, leave the rest alone) and log `res.headers` on the `upgrade` event. Run one session. Revert if `x-codex-turn-state` is absent (saves writing Change 2 entirely if the header doesn't exist on this endpoint).

Alternative instrumentation path without a code change: use a proxy like `mitmproxy` on `chatgpt.com:443`. Requires cert trust setup — harder than the one-shot PR.

### `WsSession.ws` type

Current type is `ws: WebSocket` (browser/Bun DOM). After Change 2, the actual runtime instance is `ws.WebSocket` (Node). Two options:

- **Cast at boundary** (shown above): `ws: ws as unknown as WebSocket` in openSession, `as unknown as WSNode` wherever `on` / `off` / `send` are called. Pragmatic but ugly.
- **Change the type** to a minimal `WebSocketLike` matching the pattern in `src/cli/transports/WebSocketTransport.ts:67-72`:

  ```ts
  type WebSocketLike = {
    readonly readyState: number
    close(): void
    send(data: string): void
  }
  ```

  Then narrow in each handler. Cleaner but touches more lines.

Recommend the casting path for this PR to keep the diff focused. A follow-up can clean up the typing if it gets unwieldy.

### Test impact (this is the biggest surprise of the plan)

The existing test pattern swaps `globalThis.WebSocket` with a class returning `FakeWebSocket`:

```ts
// codex-websocket-transport.test.ts:90-105
const OriginalWebSocket = globalThis.WebSocket
function installFakeWs(autoOpen = true): FakeWebSocket {
  fakeWs = new FakeWebSocket()
  ;(globalThis as any).WebSocket = class { ... constructor() { return fakeWs } }
  ...
}
```

After Change 2, the transport doesn't use `globalThis.WebSocket`; it uses `WSNode`. **The global swap no longer intercepts anything.**

Options:

1. **Mock the `ws` module via Bun's test mocker.** Bun supports `mock.module('ws', () => ({ default: FakeWSNode }))`. This is the cleanest fix but requires rewriting `FakeWebSocket` to expose `on`/`off` (EventEmitter API) instead of `addEventListener`/`removeEventListener`, and fake the `upgrade` event.

2. **Inject a WebSocket factory into the transport.** Add a module-level `let openSocket: (url, opts) => Socket = defaultOpenSocket`, with a test-only `_setOpenSocketForTest` export. Tests construct and inject their fake. More plumbing but avoids Bun-specific mocking.

3. **Test through a higher level** (e.g., the fetch adapter) and only smoke-test the WS transport. Less granular, but the existing adapter tests already exercise the full happy path.

Recommend **Option 1** (Bun `mock.module`) paired with a rewrite of `FakeWebSocket` into a `FakeWSNode` that extends `EventEmitter`. This is consistent with modern Bun test patterns and keeps tests deterministic.

Plan for test file changes:

- `codex-websocket-transport.test.ts` — rewrite `FakeWebSocket` → `FakeWSNode`, replace `installFakeWs` with `mock.module('ws', ...)` in `beforeAll`. Add tests for `upgrade` event capturing `turn_state`.
- `codex-fetch-adapter.test.ts` — same rewrite applies to its own `FakeWebSocket` (lines 28-80).

Both rewrites are mechanical and together are ~150 lines of test code churn.

### Rollback

Revert both files. Restore the `globalThis.WebSocket` path and the global-swap test mocking. No persisted state impact.

## 5. Change 3 — `service_tier: "priority"` for fast mode (P1)

### Problem

`claude.ts:1754` computes `speed = 'fast'` for eligible turns and attaches it to the Anthropic SDK body at `:1829`. `translateToCodexBody` (`codex-fetch-adapter.ts:504`) reads fields from `anthropicBody` but ignores `speed`. No `service_tier` field on the Codex body.

### Upstream reference

```rust
// codex-rs/core/src/client.rs — build_responses_request
service_tier: match service_tier {
    Some(ServiceTier::Fast) => Some("priority".to_string()),
    Some(service_tier) => Some(service_tier.to_string()),
    None => None,
},
```

Body field only (no header). Same `build_responses_request` used for both prewarm and real turn, so the field appears on both.

### SDK `speed` type

Per `node_modules/@anthropic-ai/sdk`, `speed: 'standard' | 'fast' | null` — three valid values. `null` means explicit default, `undefined` means absent.

### Design

Two-line addition in `translateToCodexBody` (`codex-fetch-adapter.ts`), after the base body construction at `:528-536` and before `parallel_tool_calls`:

```ts
// codex-fetch-adapter.ts — translateToCodexBody
const codexBody: Record<string, unknown> = {
  model: codexModel,
  store: false,
  stream: true,
  instructions,
  input,
  tool_choice: 'auto',
  parallel_tool_calls: true,
}

// Map Anthropic `speed: 'fast'` → Codex `service_tier: "priority"`.
// Upstream openai/codex (codex-rs/core/src/client.rs, build_responses_request)
// sets this whenever ServiceTier::Fast is active, on both prewarm and real turns.
const speed = anthropicBody.speed as 'standard' | 'fast' | null | undefined
if (speed === 'fast') {
  codexBody.service_tier = 'priority'
}
```

**Prewarm inheritance:** Change 1's `schedulePrewarm` spreads the full `codexBody` into the seed. `service_tier` is part of `codexBody`, so it's inherited automatically. No extra wiring needed.

**Subagent / side-query inheritance:** these paths also call `translateToCodexBody`, and if their Anthropic SDK call set `speed: 'fast'`, they get `service_tier` too. Per `claude.ts:1747-1752`, the `isFastModeForRetry` gate checks the retry context's `fastMode` flag — it's set on subagent paths when the controlling session has fast mode active. Nothing further needed.

**Request signature impact:** `createRequestSignature` at `codex-websocket-transport.ts:276-279` stringifies all non-input body fields. Adding `service_tier` means existing conversations that previously had no `service_tier` on their signature will see a signature change on the first turn after upgrade. Effect: one extra full-send on the post-upgrade boot turn per conversation. Acceptable.

### Verification

Add a debug log when `service_tier` is set, so the implementer can eyeball it in logs:

```ts
if (speed === 'fast') {
  codexBody.service_tier = 'priority'
  logForDebugging(`[codex-cache] service_tier=priority (fast mode)`)
}
```

### Tests

Add to `codex-fetch-adapter.test.ts`:

```ts
test('translateToCodexBody sets service_tier="priority" when speed=fast', () => {
  const result = translateToCodexBody({
    model: 'claude-sonnet-4-6',
    speed: 'fast',
    _openaiInstructionAssembly: { instructions: '', inputMessages: [] },
  })
  expect(result.codexBody.service_tier).toBe('priority')
})

test('translateToCodexBody omits service_tier when speed=standard', () => {
  const result = translateToCodexBody({
    model: 'claude-sonnet-4-6',
    speed: 'standard',
    _openaiInstructionAssembly: { instructions: '', inputMessages: [] },
  })
  expect(result.codexBody.service_tier).toBeUndefined()
})

test('translateToCodexBody omits service_tier when speed is undefined', () => {
  const result = translateToCodexBody({
    model: 'claude-sonnet-4-6',
    _openaiInstructionAssembly: { instructions: '', inputMessages: [] },
  })
  expect(result.codexBody.service_tier).toBeUndefined()
})
```

### Rollback

Revert 5 lines. Single-file change.

## 6. Change 4 — Time-bound sticky HTTP fallback (P2)

### Problem

`codex-fetch-adapter.ts:55`:

```ts
const stickyHttpFallbackConversations = new Set<string>()
```

Once a conversation enters sticky HTTP fallback — via idle timeout, close-before-completed, or stream transport error (`:1525`, `:1537`, `:1555`, `:1647`) — it stays there for the life of the process. A single transient error permanently disables `previous_response_id` continuation for that conversation, which means permanent cache-ceiling pinning at ~13,824 tokens (the instructions-only cache).

### Design

Replace the `Set<string>` with a `Map<string, StickyFallbackEntry>` with a TTL:

```ts
// codex-fetch-adapter.ts — replace the Set at :55 and helpers at :69-85
const STICKY_HTTP_FALLBACK_TTL_MS = 2 * 60 * 1000  // 2 minutes

interface StickyFallbackEntry {
  until: number
  reason: string
}
const stickyHttpFallback = new Map<string, StickyFallbackEntry>()

function markStickyHttpFallback(conversationId: string, reason: string): void {
  // Don't extend on repeated errors within the same window — one failure
  // buys one window. This keeps the common-case (one bad turn, recovery)
  // bounded while still riding through transient bursts.
  if (stickyHttpFallback.has(conversationId)) return
  const until = Date.now() + STICKY_HTTP_FALLBACK_TTL_MS
  stickyHttpFallback.set(conversationId, { until, reason })
  logForDebugging(
    `[codex-fetch] sticky_http_fallback conv=${conversationId.slice(0, 8)} ` +
    `reason=${reason} ttl_ms=${STICKY_HTTP_FALLBACK_TTL_MS}`,
    { level: 'warn' },
  )
}

function hasStickyHttpFallback(conversationId: string): boolean {
  const entry = stickyHttpFallback.get(conversationId)
  if (!entry) return false
  if (Date.now() >= entry.until) {
    stickyHttpFallback.delete(conversationId)
    logForDebugging(
      `[codex-fetch] sticky_http_fallback expired conv=${conversationId.slice(0, 8)} ` +
      `reason=${entry.reason}`,
    )
    return false
  }
  return true
}
```

Update the public reset function at `:65-67`:

```ts
export function resetCodexCacheContext(): void {
  stickyHttpFallback.clear()
}
```

### TTL choice rationale

- **2 minutes** is long enough to ride through a cluster of transient errors without thrashing the WS — if the first WS re-attempt would fail because of a still-present network glitch, a 2-minute wait is usually enough for the condition to clear.
- Short enough that one bad moment doesn't degrade a multi-hour session.
- Alternative considered: consecutive-failure counter with exponential backoff (e.g., 30s → 1min → 2min → 5min). More accurate modeling of reality, but doubles the implementation complexity without a clear win against the 2-minute flat TTL.
- Alternative considered: exposing via env var (`CODEX_STICKY_FALLBACK_TTL_MS`). Low value — 2 minutes is fine in practice and env-driven knobs rot.

### Interaction with Change 5

Change 5 preserves `lastResponseId` across account rotation. Change 4's TTL means that after a transient error, the conversation resumes WS in 2 minutes and at that point still has the preserved `lastResponseId` (Change 5). So a transient error → 2 minutes of HTTP fallback → WS returns, still warm. Pair well.

### Tests

Update `codex-fetch-adapter.test.ts`:

- Mark → `hasStickyHttpFallback` returns true within TTL.
- Mark → advance `Date.now` past TTL → `hasStickyHttpFallback` returns false, entry removed from map (assert via `resetCodexCacheContext` being a no-op afterward or via a test-only accessor).
- Double mark within TTL does not extend the window — mark, advance 1 min, mark again, advance 1 min + 1 sec, assert expired.

Bun's test runner has `mock.setSystemTime(...)` — or introduce an injectable clock in the module for testability:

```ts
let nowForTest: (() => number) | null = null
export function _setNowForTest(fn: (() => number) | null): void { nowForTest = fn }
function now(): number { return nowForTest ? nowForTest() : Date.now() }
```

The clock-injection helper is ugly but cheap; the ergonomic cost is one extra line per call site (`Date.now()` → `now()`).

### Rollback

Revert the Map back to Set and drop the TTL check. The public API (`markStickyHttpFallback`, `hasStickyHttpFallback`, `resetCodexCacheContext`) stays stable.

## 7. Change 5 — Preserve `lastResponseId` across account rotation (P2)

### Problem

`codex-websocket-transport.ts:197-224`, `getOrOpenSession`:

```ts
const existing = sessions.get(conversationId)
if (existing && existing.ws.readyState === WebSocket.OPEN
    && existing.accountId === (authHeaders['chatgpt-account-id'] ?? null)) {
  return existing
}
if (existing) {
  // logs, closes WS, deletes session
}
return openSession(conversationId, authHeaders)
```

When `authHeaders['chatgpt-account-id']` changes mid-conversation (from `/switch-account`, a 429 failover via `codexAccountLeaseManager.ts:238-285`, or a pool rotation), the existing `WsSession` is discarded. The new `WsSession` returned by `openSession` at `:166-180` has `lastResponseId: null`. Next turn takes the "no prior response_id" branch at `:667-668`: full send.

The full send is expensive. The underlying question is whether the server would have accepted a cross-account `previous_response_id` reuse. We don't know — but the `StaleResponseIdError` path at `:804-821` already handles graceful degradation: server returns "not found" → retry as full send on same connection, no user-visible error.

### Design

Preserve continuation state across the reconnect. Let the server decide whether the preserved `previous_response_id` is still valid:

```ts
// codex-websocket-transport.ts — rewrite getOrOpenSession at :192-226
async function getOrOpenSession(
  conversationId: string,
  authHeaders: Record<string, string>,
): Promise<WsSession> {
  const existing = sessions.get(conversationId)
  if (
    existing
    && existing.ws.readyState === WebSocket.OPEN
    && existing.accountId === (authHeaders['chatgpt-account-id'] ?? null)
  ) {
    return existing
  }

  if (existing) {
    const oldAcct = existing.accountId ? existing.accountId.slice(0, 8) : 'none'
    const newAcct = authHeaders['chatgpt-account-id']
      ? authHeaders['chatgpt-account-id'].slice(0, 8)
      : 'none'
    const reason =
      existing.ws.readyState !== WebSocket.OPEN
        ? `ws_readyState=${existing.ws.readyState}`
        : `account_changed old=${oldAcct} new=${newAcct}`
    logForDebugging(
      `[codex-ws] reconnecting conv=${conversationId.slice(0, 8)} ${reason}`,
      { level: 'warn' },
    )

    // Preserve continuation state across the reconnect. The server either
    // accepts the preserved previous_response_id (cache carries over — best
    // case) or returns "not found" (StaleResponseIdError retry path at :804-821
    // handles it cleanly as a full-send retry — no user-visible error).
    const preserved = {
      lastResponseId: existing.lastResponseId,
      lastRequestSignature: existing.lastRequestSignature,
      lastRequestInput: existing.lastRequestInput,
      lastResponseOutputItems: existing.lastResponseOutputItems,
      prewarmDone: existing.prewarmDone,  // don't re-prewarm on new connection
    }

    try { existing.ws.close() } catch { /* ignore */ }
    sessions.delete(conversationId)

    const fresh = await openSession(conversationId, authHeaders)
    fresh.lastResponseId = preserved.lastResponseId
    fresh.lastRequestSignature = preserved.lastRequestSignature
    fresh.lastRequestInput = preserved.lastRequestInput
    fresh.lastResponseOutputItems = preserved.lastResponseOutputItems
    fresh.prewarmDone = preserved.prewarmDone
    logForDebugging(
      `[codex-ws] continuation preserved across reconnect ` +
      `conv=${conversationId.slice(0, 8)} ` +
      `response_id=${preserved.lastResponseId?.slice(0, 16) ?? 'none'}`,
    )
    return fresh
  }

  return openSession(conversationId, authHeaders)
}
```

### Why preserving `prewarmDone` matters

Without it, a reconnect would re-fire the startup prewarm (Change 1's `schedulePrewarm`) — pointless since the server already has the cache warmed up for this conversationId, and this connection can just carry `previous_response_id` forward. Preserving `prewarmDone = true` prevents redundant work.

### What this breaks if the server is strict

If the ChatGPT backend ties `previous_response_id` to account identity and refuses cross-account reuse, the graceful-degradation path at `codex-websocket-transport.ts:804-821` kicks in:

- Server sends `error` event with message containing "not found"
- `StaleResponseIdError` thrown
- Outer retry at `:549-555` retries as full send on the same connection
- One extra full send on the post-rotation turn, no user-visible error

In the worst case, behavior matches today's status quo (full send after rotation). In the best case, we preserve cache hits.

### Account-rotation in the lease manager

`codexAccountLeaseManager.ts:238-285` (`failoverCodexLease`) calls `setActiveAccount(selection.account.accountId)`. The fetch adapter reads the new token via `getPoolAccountForCurrentLease` at `:1718-1723` on the next request. Change 5 handles the WS-side bookkeeping once the new `authHeaders` arrive.

Worth noting: the lease manager doesn't directly touch WS sessions — it just changes which token the adapter reads. So Change 5 is the right layer.

### Interaction with `/switch-account`

`src/commands/switch-account/switch-account.ts:68` calls `resetCodexCacheContext()`. Combined with Change 5, an explicit `/switch-account` still forces a full reset (good — user intent is to start fresh on the new account). An automatic 429 failover doesn't call `resetCodexCacheContext` and thus benefits from Change 5's preservation.

### Tests

Add to `codex-websocket-transport.test.ts`:

1. Reconnect with `accountId` changed preserves `lastResponseId` on the new session.
2. Reconnect due to `ws_readyState != OPEN` preserves `lastResponseId`.
3. If server rejects preserved ID on next turn, `StaleResponseIdError` path clears state and retries full send (already covered by existing tests — confirm pass rate unchanged).
4. `prewarmDone` is preserved → no re-prewarm on reconnect.

### Rollback

Restore the original `getOrOpenSession` body (discard all preserved state). Single-function revert.

## 8. Ship plan

### Dependencies

```
Change 3 (service_tier)       — independent, no deps
Change 4 (sticky TTL)         — independent, no deps
Change 5 (preserve lastRespId)— independent, no deps
Change 1 (async prewarm)      — independent; easier after Change 3 ships so
                                prewarm body inherits service_tier for free
Change 2 (turn_state capture) — independent; changes test mocking, can ship
                                standalone, but see instrumentation PR below
```

### Recommended order

**Ship them as five separate PRs in this order:**

1. **Change 3** — smallest, lowest risk, immediately testable.
2. **Change 4** — small, improves reliability tail, independent.
3. **Change 5** — small, pairs well with Change 4, independent.
4. **(Optional) Instrumentation PR** — swap `globalThis.WebSocket` for `WSNode` in `codex-websocket-transport.ts` and log `upgrade` response headers; ship, run one session, inspect log, revert. Confirms Change 2's premise.
5. **Change 1** — medium complexity, highest latency win. Ship fourth so Change 3's `service_tier` is already there when prewarm starts sending `service_tier` too.
6. **Change 2** — medium complexity, touches tests broadly. Ship last to minimize merge conflicts with the other PRs.

### Per-PR verification protocol

Before merging each PR:

1. **Unit tests:**
   ```bash
   bun test src/services/api/codex-continuation-e2e.test.ts \
            src/services/api/codex-websocket-transport.test.ts \
            src/services/api/codex-fetch-adapter.test.ts
   ```
   Expected: `37 pass, 0 fail` before PR; same or more after.

2. **Build:**
   ```bash
   bun run build:dev:full
   ```
   Produces `./cli-dev` — use this, not `./cli`.

3. **Smoke session with debug logs:**
   ```bash
   ./cli-dev --cli-dev --debug
   # Send 3 short turns: "hi", "what is 2+2", "thanks"
   # /exit
   ```

4. **Inspect evidence:**
   - Debug log: `~/.cat-code/debug/<session>.txt`
   - Session JSONL: `~/.cat-code/projects/-Users-pt-cat-code/<session>.jsonl`

   Per-PR expectations:

   | PR | Expected log line |
   |---|---|
   | Change 3 | `[codex-cache] service_tier=priority` on fast-mode turns |
   | Change 4 | After inducing error (disconnect wifi mid-turn or similar), `sticky_http_fallback expired` appears ~2 min later; next turn back on WebSocket |
   | Change 5 | After `/switch-account`, `[codex-ws] continuation preserved across reconnect response_id=...` instead of a cold turn |
   | Change 1 | `[codex-ws] startup prewarm complete` BEFORE first `[codex-ws] incremental` or `[codex-ws] full send`; cold TTFB drops by the prewarm round-trip time |
   | Change 2 | `[codex-ws] connected for <conv> turn_state=<value>...` instead of `turn_state=none` |

### Success criteria (after all five ship)

Measured on a scripted 5-turn session, comparing before and after:

- **Cold TTFB (turn 1):** reduced by one full-body server ingestion. Expected 2-4 seconds saved on a 30KB instruction block.
- **`turn_state=<value>` captured** on every WebSocket connect.
- **`service_tier: "priority"`** present on every fast-mode request body (visible via `COLD_DIAG` dump).
- **After induced transport error:** conversation recovers to WebSocket within ~2 minutes with cache state intact.
- **After `/switch-account`:** cache hit rate on next turn matches pre-rotation hit rate (no cold turn).
- **Steady-state hit rate** on same protocol as Section 2.7 of `debug-report.md` (5 short turns, `hi` / `what is 2+2` / `thanks` / resume / final) should exceed the current 47.5%.

## 9. What's deliberately NOT in this plan

These are real issues but scoped out — each needs a brief justification so the reviewer doesn't spend time asking:

- **Full native Codex request pipeline (replacing the Anthropic compat adapter):** 1-2 week rewrite. None of the five changes above require it. Revisit if the five land and the gap is still large.
- **Request compression (`zstd` / `Content-Encoding`):** upstream Codex has it, we don't. Matters most on large full-sends. Changes 1 and 5 reduce full-send frequency, so compression's marginal value drops. Defer.
- **`normalizeMessagesForAPI` Statsig-gate drift** (`utils/messages.ts` :2164, :2308, :2349): real source of false full-sends. The canonical-reconciliation path (`codex-websocket-transport.ts:382-441`) already tolerates most drift. Lower leverage than the five above; defer unless telemetry after Change 1 shows the drift is the remaining dominant cause.
- **Subagent cold WS sessions** (`claude.ts:743-753`, `${sessionId}/${agentId}`): each subagent pays its own connect + prewarm. After Change 1, prewarm is off the critical path, so the cost is hidden. Unchanged cost model but no longer a critical-path latency issue.
- **Idle-timeout tuning** (`codex-websocket-transport.ts:55-56`, `CLAUDE_STREAM_IDLE_TIMEOUT_MS` default 90s): out of scope. Current value is fine.
- **Adapter-side request caching of `normalizeMessagesForAPI` output:** could be done for back-to-back identical turns. Marginal.
- **Upstream codex's "Azure responses endpoint" branch** (for `store: true`): upstream has this for Azure-hosted Responses API. We don't target Azure, so `store: false` is correct.

## 10. Open questions for the reviewer

1. **Is ship order correct?** I've placed Change 1 (highest-ROI) as PR 4 because Change 3's `service_tier` should already be in place when prewarm bodies start including it. Alternative: ship Change 1 first and let it go out without `service_tier` inheritance for a few days — lower total wait time to the biggest win. Defer to reviewer preference.
2. **Change 2's test-mocking approach:** I recommend Bun's `mock.module('ws', ...)` + `EventEmitter`-based fake. Alternative is a WebSocket-factory injection pattern. Worth a small design doc if the reviewer prefers a different direction.
3. **Change 4's TTL value:** I picked 2 minutes. If telemetry shows transient errors clustering over longer windows, bump to 5.
4. **Change 5's cross-account assumption:** we don't know if the ChatGPT backend accepts cross-account `previous_response_id`. If the graceful-degradation path turns out noisy in logs, we may want to gate preservation on `existing.accountId === new.accountId` only (preserve on readyState changes but not account changes). Start with the broader preservation and narrow if needed.
5. **Change 1's conversationId `/`-suffix handling:** subagents have `${sessionId}/${agentId}` conversationIds. Confirm `schedulePrewarm` behaves correctly for these — should be fine since it's just a string key, but worth an explicit test.

## 11. Files touched — complete list

For PR-review CODEOWNERS planning:

| Change | File | Approx LOC |
|---|---|---|
| 1 | `src/services/api/codex-websocket-transport.ts` | +80, -40 |
| 1 | `src/services/api/codex-fetch-adapter.ts` | +3 |
| 1 | `src/services/api/codex-websocket-transport.test.ts` | +60 |
| 2 | `src/services/api/codex-websocket-transport.ts` | +30, -15 |
| 2 | `src/services/api/codex-websocket-transport.test.ts` | +~100 churn (test rewrite) |
| 2 | `src/services/api/codex-fetch-adapter.test.ts` | +~50 churn |
| 3 | `src/services/api/codex-fetch-adapter.ts` | +6 |
| 3 | `src/services/api/codex-fetch-adapter.test.ts` | +30 |
| 4 | `src/services/api/codex-fetch-adapter.ts` | +25, -15 |
| 4 | `src/services/api/codex-fetch-adapter.test.ts` | +40 |
| 5 | `src/services/api/codex-websocket-transport.ts` | +25, -3 |
| 5 | `src/services/api/codex-websocket-transport.test.ts` | +40 |

Total production code: ~+170 lines, -70 lines.
Total test code: ~+320 lines net (including rewrite churn).
