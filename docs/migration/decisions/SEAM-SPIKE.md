# Seam spike — how a dedicated app drives a real cat-code session

Question (from STRATEGY §3, §6): what's the seam the walking skeleton runs on?
Spiked 2026-06-19 against `~/cat-code/src`. **Answer: a real, purpose-built,
tested in-process driver already exists — `app-runtime/`.** We don't invent the seam.

---

## The finding

cat-code already has a clean programmatic driver layer in `src/app-runtime/`,
built specifically to run a session for a non-TUI frontend (it's what the stale
`web/` was wired to). It is small, current (Jun 2026), and fully test-covered.

**`AppSessionController`** (`src/app-runtime/AppSessionController.ts`, ~6KB) — the seam:
- `subscribe(listener: (event: AppSessionEvent) => void): () => void` — event stream out.
- submit a prompt + `abort()` — drive in.
- owns the permission round-trip: adapter's `runTurn` gets `onPermissionRequest(request) => Promise<AppPermissionResponse>`, and the controller tracks pending requests + resolves them. This is the real permission seam (maps to Domain E).
- adapter shape `AppSessionControllerAdapter.runTurn({ prompt, onPermissionRequest, … })` — pluggable; the real impl is the QueryEngine one below.

**`AppSessionEvent`** (`src/app-runtime/sessionEvents.ts`) — what streams out:
```
type AppSessionEvent =
  | { type: 'message'; message: SDKMessage }      // ← FULL SDKMessage, not flattened text
  | { type: 'goal.snapshot'; snapshot: AppGoalSnapshot }
  | { type: 'permission.requested'; request: AppPermissionRequest }
  | { type: 'permission.resolved'; request; response }
  | { type: 'abort.status'; abort: AppSessionAbortState }
```

**`createQueryEngineAppSession`** (`createQueryEngineAppSession.ts`) — wires the controller
to the real engine: `submitMessage(prompt)` is an async generator that does
`yield* engine.submitMessage(...)` straight off **`QueryEngine`** — and `QueryEngine`
is the **same core the TUI uses** (`src/QueryEngine.ts:1314` constructs it for the REPL).

## Why this is the decisive result

1. **The seam is real and maintained — we adopt, not invent.** This is exactly the
   risk STRATEGY §1 flagged (no facade → unproven seam). It's already proven by
   `AppSessionController.test.ts` + `createQueryEngineAppSession.test.ts`.
2. **The stream carries the FULL `SDKMessage`** (`{type:'message'; message: SDKMessage}`),
   i.e. real assistant content blocks incl. tool_use / thinking / tool_result — NOT the
   flattened string the stale `web/` reducer dumbed it down to. So the prototype's rich
   transcript + tool cards (Domains B, C) are **feasible on this seam** — the loss was in
   the stale `web/` mapper, not the engine. We render off `SDKMessage` directly and skip
   that lossy layer.
3. **Same engine as the TUI ⇒ every feature is reachable in principle.** Because the
   driver runs the real `QueryEngine`, anything the TUI can do, this seam can do. That
   backs the user's bar ("every feature must be real") at the architecture level.
4. **The permission round-trip is built in** — `onPermissionRequest => Promise<response>`
   is the live seam Domain E needs; not a thing we design from scratch.

## What this does NOT solve (still open)

- **Transport / process model.** `app-runtime` is *in-process* — it assumes the app and
  the engine share a JS runtime. A dedicated app (Electron/Tauri) means a process
  boundary: either (a) run `app-runtime` inside the app's Node/main process, or (b) keep
  the WS server idea (`AppSessionWebSocketServer`, which the stale web/ used) and talk over
  a socket. The CONTROLLER seam is settled; how we transport it is the next sub-question.
- **Multi-session.** `AppSessionController` is **one session**. Multi-session = N controllers
  + the on-disk session registry (`concurrentSessions.ts`, see DOMAINS §A). The seam
  composes to N, but the spawn/attach/multiplex orchestration is unbuilt. Gates the shell.
- **Stale `web/` server layer.** `AppSessionWebSocketServer` / `appSessionEventMapper`
  exist but the mapper FLATTENS `SDKMessage`→string (that's the staleness). If we go the
  socket route we reuse the WS server but **replace the mapper** (or send `SDKMessage` raw).

## Recommendation for the walking skeleton (STRATEGY §3 → Phase 1)

Thinnest real path: **dedicated-app shell → `AppSessionController` (in-process, via
`createQueryEngineAppSession`) → render one real `SDKMessage` → submit one real prompt →
resolve one real permission.** Single session. Defer transport-vs-socket and multi-session.
This proves the seam end-to-end with code that already has tests behind it.

Open decision before Phase 1: **in-process driver vs. WS server** (the §"does NOT solve"
transport question) — depends on the shell tech (Electron makes in-process trivial; a
pure web view pushes toward the socket). That's the one thing to settle next.
