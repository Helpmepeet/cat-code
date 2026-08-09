# A08 — Electron main process

## Verdict

The Electron security posture proper is genuinely strong: one `BrowserWindow`, every
`webPreferences` box checked, a two-layer CSP, navigation/window-open decisions factored into
a pure unit-tested module, and an HC1 token/dialog design that makes the renderer structurally
unable to author a filesystem path. Where main is weak is *cost and identity on the frame
plane*: the four "allowlisted" frame channels validate `sessionId` only as `typeof === 'string'`,
and main's own error path then writes an unbounded, never-reclaimed entry into the main-process
replay buffer for any id a renderer invents — the single most important thing to fix. Close
behind, `CH_RESTART` is the one renderer-reachable process-spawn path that skips the HC4
spawn-rate cap every other spawn entry point goes through, and it throws away the typed error,
so a refused restart is completely silent to the user.

## Findings

### [HIGH] Frame channels accept any `sessionId` string, and main's error path permanently buffers it

- **Where**: `app/main/main.ts:1198-1201` (`CH_PING`), `app/main/main.ts:1579-1617` (`forward`),
  `app/main/attachmentGate.ts:73-75`, `app/main/replayBuffer.ts:169-180`
- **Type**: security
- **What**: Every `ipcMain.on` frame handler validates `sessionId` with `typeof arg?.sessionId !== 'string'`
  and nothing more (the control-plane handlers, by contrast, get `isUuid` inside the host). When
  `supervisor.send` throws `session_not_found` for an unknown id, `forward` builds an error
  `ServerFrame` and calls `deliver(attachmentGate.onFrame(sessionId, frame))`. `AttachmentGate.onFrame`
  records into the buffer **before** the `attached` check, and `FrameReplayBuffer.record` creates a
  fresh `SessionEntry` for any key it has not seen. `FrameReplayBuffer.sessions` has per-session
  bounds but **no bound on the number of sessions**.
- **Trigger / why it matters**: `window.catcode.ping('A'.repeat(120_000), 'x')` in a loop. Each call
  costs one new map entry holding a ~120 KB key plus an error frame whose `message` is
  `` `session ${sessionId} was not found` `` — another ~120 KB string. Nothing ever removes it:
  `clearSession` only fires on a terminal *lifecycle* frame (never arrives for a fabricated id) or
  on `host.evictReplay` (real ids only); `reset()` only on `window-all-closed`. The preload's shared
  guard permits 120 calls/second, so this grows main's heap by roughly 30 MB/s until the privileged
  process OOMs. This also invalidates the ceiling `replayBuffer.ts:66-71` documents as the number
  to reason about (`MAX_LIVE_SESSIONS × DEFAULT_MAX_BUFFERED_BYTES`).
- **Fix**: Reject a non-UUID `sessionId` at the top of `forward` (main already has the shape check
  pattern), or gate `attachmentGate.onFrame` on the session existing — do not create a buffer entry
  for an id no supervisor record and no registry row vouches for.

### [HIGH] `CH_RESTART` is the one renderer-reachable spawn path with no rate cap

- **Where**: `app/main/main.ts:1203-1210`; `app/host/host.ts:603-649` vs `app/host/host.ts:711-731`
- **Type**: security
- **What**: `ipcMain.on(CH_RESTART)` forwards straight into `host.restartSession`, which — unlike
  `createSession`, `restoreSession`, and `createSessionInWorkspace` — never calls
  `checkSpawnLimits()` and never calls `recordSpawnTime()`. `supervisor.restartSession` then does
  `killSession` (SIGTERM) + `spawnSession` (fresh Bun engine process) with no throttle of its own.
- **Trigger / why it matters**: With a single live session present (`isLive` is the only gate, and
  the re-spawned record is `spawning` immediately, so it re-qualifies at once), a loop on
  `window.catcode.restart(id)` runs at the preload's 120/s ceiling. Each iteration SIGTERMs a child,
  spawns a new ~189 MB engine graph, and performs an atomic registry file write (`upsertOnSpawn`,
  which also bumps `restartCount` without bound). `MAX_SPAWNS_PER_WINDOW = 8 / 10 s` exists
  precisely as fork-bomb defense (HC4) and this path walks around it.
- **Fix**: Call `checkSpawnLimits()` + `recordSpawnTime()` in `Host.restartSession` alongside the
  existing `isLive`/`canResume` gates, so all four spawn entry points share one cap.

### [MED] A refused restart is completely silent — no frame, no toast, nothing

- **Where**: `app/main/main.ts:1203-1210`
- **Type**: correctness
- **What**: `void host.restartSession(arg.sessionId)` discards the `HostResult`. The inline comment
  justifies this with "the renderer already learns liveness from status events", but the two most
  common refusals emit **no** host event at all: `session_not_found` for a malformed/not-live id, and
  `` `transcript for ${id} is gone` `` when `canResume` is false.
- **Trigger / why it matters**: `canResume` is false for any row whose `engineSessionId` was stamped
  from the ready frame but whose `.jsonl` was never materialized — i.e. **a session opened and never
  typed in** — and for any row in `resumeFailed`. Meanwhile `tabStatus.ts:117-123` marks any
  `disconnected`/`exited` descriptor `restartable: true`, so the Restart affordance is rendered.
  A session that crashed before its first turn therefore shows a Restart button that does literally
  nothing, forever, with zero feedback. The `resumeFailed` loop-breaker (`host.ts:228-234`) makes
  this permanent for the rest of the run by design.
- **Fix**: On `!result.ok`, mint the same error `ServerFrame` `forward` already builds and pass it
  through `deliver(attachmentGate.onFrame(...))` — the renderer's error path already renders it.

### [MED] The reactivate supervisor reuses the same socket directory and restarts the filename counter

- **Where**: `app/main/main.ts:634-646` (`createSupervisor`), `app/main/main.ts:1698-1701`
  (`ensureHost`), `app/supervisor/supervisor.ts:188-192`, `app/supervisor/supervisor.ts:239`
- **Type**: correctness
- **What**: `createSupervisor()` passes no `socketDir`, so the supervisor defaults to
  `/tmp/catcode-${process.pid}` — **process**-scoped, not supervisor-scoped. On macOS
  `window-all-closed` nulls `supervisor`, `activate` calls `ensureHost()`, and the second supervisor
  in the same process lands on the same directory with `socketSeq` reset to 0, i.e. `s0.sock` again.
- **Trigger / why it matters**: `supervisor.shutdown()` SIGTERMs children and immediately
  `rmSync`s the directory without waiting. A child SIGTERM'd after spawn but before `Bun.listen`
  can bind `s0.sock` into the directory the *new* supervisor just re-created, and the new
  supervisor's poll-connect (`connectWhenReady`) attaches to it. The only thing that saves this is
  `validateReadyFrame`'s `sessionId does not match supervisor record` check, which fails the record
  closed — so the observable outcome is a dock-reopen session that spuriously reports `failed`
  rather than a cross-wired engine. It is a real collision that happens to land on a guard.
- **Fix**: Give each supervisor generation its own directory: pass
  `socketDir: \`/tmp/catcode-${process.pid}-${generation}\`` from `createSupervisor()` (main owns
  the generation counter, since main is what builds the second supervisor).

### [MED] Die-with-window has no wait, no verify, and three uncovered exit paths

- **Where**: `app/main/main.ts:1844-1850` (`shutdownRuntime`), `1891-1901` (`teardownOnSignal`),
  `1903-1932` (`window-all-closed` / `before-quit`)
- **Type**: correctness
- **What**: Main covers SIGINT/SIGTERM, `window-all-closed`, and `before-quit`. It covers **no**
  crash path: there is no `process.on('uncaughtException')`, no `process.on('unhandledRejection')`,
  and no `render-process-gone` / `child-process-gone` handler anywhere under `app/main`
  (verified by grep). On any of those, Electron main dies without ever calling `shutdownRuntime()`,
  so no row is marked clean and no sidecar receives a SIGTERM. Separately, on the paths that *are*
  covered, `shutdownRuntime()` is fire-and-forget: SIGTERM is sent, the child handle is dropped, no
  exit is awaited and no liveness is re-checked before `app.exit()`.
- **Trigger / why it matters**: An uncaught exception in main (e.g. a floating rejection from
  `void window.loadURL(APP_ORIGIN_DEV)` when Vite dies between the readiness probe and the load)
  orphans every live engine process. They survive until the sidecar's own 15-minute idle janitor
  (`app/sidecar/index.ts:58`) or the next launch's registry orphan sweep — so the locked v1 model
  degrades from "die with the window" to "die within 15 minutes". Every live row is also then
  reported `crashed` on the next launch, which is what `teardownOnSignal`'s own doc-comment says
  must not happen.
- **Fix**: Add `process.on('uncaughtException')` / `process.on('unhandledRejection')` handlers that
  run the same `teardownOnSignal` body (guarded by the existing `signalTeardownStarted` latch) and
  then exit non-zero. Waiting on children is a bigger change and belongs in the supervisor; the
  crash-path coverage is main's and is a few lines.

### [MED] `openHistorySession` and `readSessionsCatalog` do unbounded synchronous disk work on the main thread before validating input

- **Where**: `app/main/main.ts:1419-1423` and `app/main/main.ts:1348-1358`; contrast
  `app/main/main.ts:1360-1379`
- **Type**: security
- **What**: `resolveOpenHistorySession(engineSessionId, host.listSessions(), readSessionsCatalogCache(defaultRegistryDir()))`
  evaluates its arguments eagerly, so **every** invocation pays a `readFileSync` + `JSON.parse` +
  full per-entry validation of a file bounded only by `MAX_SESSIONS_CATALOG_CACHE_BYTES = 4 MiB`,
  plus a `host.listSessions()` that stats one transcript per registry row (up to
  `MAX_REGISTRY_SESSIONS = 256` `existsSync` calls) — *before* `resolveOpenHistorySession` gets to
  its first line, which is the UUID reject at `openHistorySession.ts:81-86`. `CH_HOST_SESSIONS_CATALOG`
  has the same shape with no input to validate at all.
- **Trigger / why it matters**: `window.catcode.openHistorySession('garbage')` in a loop runs at
  120/s, each iteration parsing up to 4 MiB of JSON synchronously on the Electron main thread. The
  window freezes. The sibling handler `CH_HOST_PREVIEW` shows the right pattern immediately above:
  `readCache` is passed as a *lambda* so `resolvePreview` short-circuits on `canPreview` before any
  disk touch, and its comment states that as the boundary requirement.
- **Fix**: Mirror `CH_HOST_PREVIEW` — validate the id shape in the handler first, then pass
  `catalog: () => readSessionsCatalogCache(...)` and `descriptors: () => host.listSessions()` as
  thunks so a malformed id costs nothing.

### [MED] Eight byte-identical verb-forwarding handlers

- **Where**: `app/main/main.ts:1017-1196` (`CH_ACCOUNT_VERB`, `CH_WORKSPACE_TRUST_VERB`,
  `CH_RUN_CONTROL_VERB`, `CH_CONTEXT_BREAKDOWN_VERB`, `CH_SESSION_ACTION_VERB`,
  `CH_TASK_CONTROL_VERB`, `CH_REMOTE_SETTINGS_VERB`, `CH_SETTINGS_VERB`)
- **Type**: quality
- **What**: Eight handlers with structurally identical bodies — string-check `sessionId`, read
  `verb.type`, membership-test it against a `*_VERB_TYPES` constant, `forward(arg.sessionId, arg.verb as X)`
  — differing only in the constant, the type parameter, and a comment naming a different session id.
  About 180 lines that reduce to a table plus one 12-line helper.
- **Trigger / why it matters**: This is the cost, not a hypothetical: it is the single largest block
  in a 1,932-line file, and any change to the shared shape (e.g. adding the UUID check the HIGH
  finding above needs) has to be made eight times, with eight chances to miss one. It also makes the
  `mainSourceGuards.test.ts` grep-based invariants the only thing standing between a copy-paste and
  a widened inbound vocabulary.
- **Fix**: `function registerVerbChannel<M>(channel: string, allowed: readonly string[]): void` and
  eight one-line call sites. The `forwardTypes` guard in `mainSourceGuards.test.ts:130-144` is
  unaffected — object-forwarded verbs already never match that regex.

### [MED] Host error strings that reach the user carry internal vocabulary and engineering notes

- **Where**: `app/main/main.ts:1252`, `app/main/main.ts:1302`; `app/main/openHistorySession.ts:85`
- **Type**: convention
- **What**: These `HostError.message` values are rendered verbatim to the user —
  `App.tsx:4705` formats them as `` `${error.code}: ${error.message}` `` and feeds them to
  `setShellError` (six call sites). The strings are: `'host is not running'`,
  `'a valid directory token from pickDirectory() is required'`, and `'malformed engine session id'`.
- **Trigger / why it matters**: The user sees `spawn_failed: host is not running` and
  `invalid_cwd: a valid directory token from pickDirectory() is required`. That is internal
  vocabulary ("host"), an internal API name, and an internal concept ("directory token") on a
  user-facing surface, and none of them tells the user what to do. The repo's own convention
  ("never render engineering notes"; "tell the user what to DO") is explicit about this, and
  `mainDecisions.ts:203-227` shows the team already writing the right kind of string
  ("There was nothing to save.", "Try another location.") one file over.
- **Fix**: Rewrite these three to say what the user can do, e.g. "The app is still starting. Try
  again in a moment." and "Choose a folder first." (The `${error.code}:` prefix is the renderer's
  defect, out of this scope.)

### [LOW] Navigation guards are per-window rather than app-global

- **Where**: `app/main/main.ts:802-818`
- **Type**: security
- **What**: `will-navigate`, `will-redirect`, and `setWindowOpenHandler` are attached inside
  `createWindow()` to that window's `webContents`. There is no `app.on('web-contents-created')`
  installer and no `will-frame-navigate`.
- **Trigger / why it matters**: Today this is airtight — `createWindow` is the only production
  `new BrowserWindow` (grep confirms), `setWindowOpenHandler` denies unconditionally,
  `webviewTag: false`, and `frame-src 'none'` in both the header CSP and the `index.html` meta
  blocks sub-frames. The cost is structural: the day a second window is added (a settings or
  preview window), it ships with the preload attached and *no* navigation policy, and nothing fails.
  The `once`-registered global handler is the version that cannot be forgotten.
- **Fix**: Move the three registrations into `app.on('web-contents-created', (_e, contents) => …)`
  in `whenReady`, and add `will-frame-navigate` beside `will-navigate`.

### [LOW] The dev branch of the CSP and navigation policy is never exercised by a live test

- **Where**: `app/scripts/hardening-smoke.ts:23-26`; `app/main/devCsp.test.ts`;
  `app/scripts/dev.ts:105-118`
- **Type**: quality
- **What**: The hardening smoke redefines `app.isPackaged` to `true` before main evaluates, so every
  live check (CSP blocking inline script, `will-navigate` blocking a `data:` document, window-open
  denial) runs the packaged branch only. The dev branch's coverage is a source grep (`devCsp.test.ts`
  matches a hash string and asserts no `'unsafe-inline'`) plus pure `isAppOrigin` unit tests. The
  *wiring* — that `navigationConfig()` returns the dev config and that the dev CSP header is actually
  emitted — is proven nowhere. Relatedly, `dev.ts`'s readiness probe is `await fetch(RENDERER_URL); return true`,
  which accepts **any** process answering on :5173, contradicting that file's own header claim
  ("never accept readiness from a server it does not own"); main then hands that origin the preload.
- **Trigger / why it matters**: A dev-branch CSP or navigation regression ships silently and is only
  ever caught by an operator noticing something at runtime. That is exactly the class of bug the
  2026-07-28 `app.isPackaged` incident was.
- **Fix**: Run the hardening smoke a second time without the `isPackaged` override, against a live
  Vite, asserting the same CSP + navigation checks. For `dev.ts`, have the probe assert a marker the
  spawned Vite serves (or bind to a port the launcher allocates) rather than treating any 200 as ours.

### [LOW] `sanitizeSaveFileName` truncates after validating

- **Where**: `app/main/mainDecisions.ts:183-187`
- **Type**: quality
- **What**: The all-dots rejection runs on `cleaned`, then `cleaned.slice(0, MAX_SAVE_NAME_CHARS)`
  runs after it. Truncation can therefore produce a name the check would have rejected.
- **Trigger / why it matters**: Not exploitable at the current bound — reaching `.` or `..` needs
  `MAX_SAVE_NAME_CHARS ≤ 2`, and it is 120 — but `'.'.repeat(120) + 'a'` does pass and truncate to
  120 dots, and the invariant the function's own doc-comment states ("a name that is only dots …
  is rejected") is not actually maintained by the code. The ordering is the bug regardless of
  today's constant.
- **Fix**: Slice first, then run the all-dots and empty checks on the sliced value.

### [LOW] `host.listSessions()` is called three times per backfill result and once per host event

- **Where**: `app/main/main.ts:436-460`; `app/main/main.ts:569` (`idleParkDriver` `listSessions`)
- **Type**: quality
- **What**: Inside `onSession`, main calls `currentHost.canPreview(...)`, then
  `currentHost.listSessions().find(...)` inside `getCurrentSession`, then
  `currentHost.listSessions().find(...)` **again** at line 454 to look up the same row it just
  resolved. Each `listSessions()` builds a descriptor for every registry row and each descriptor
  runs `hasTranscript` → `existsSync` (up to `MAX_REGISTRY_SESSIONS = 256`). Separately,
  `startIdleParkDriver` wires `subscribeHostEvents` to *every* host event, and each evaluation calls
  `listSessions()` again.
- **Trigger / why it matters**: A full backfill (`MAX_TRANSCRIPT_BACKFILL_SESSIONS = 32`) costs on
  the order of 24,000 synchronous `existsSync` calls on the Electron main thread. `host.ts:684-687`
  already flags exactly this stat cost as the reason `canPreview` was rewritten; main then re-added
  the pattern in the caller.
- **Fix**: Hoist one `const sessions = currentHost.listSessions()` per `onSession` invocation and
  reuse it for both lookups.

## What is good here

- **Decisions extracted from Electron wiring.** `navigationPolicy.ts`, `mainDecisions.ts`,
  `attachmentGate.ts`, `openHistorySession.ts`, `sessionsCatalogBaseline.ts` are Electron-free and
  genuinely unit-tested. `mainSourceGuards.test.ts` is unusually honest about what a grep can and
  cannot prove and deleted ~40 assertions that proved nothing — that file should be the template
  for any other "test" that reads its own source.
- **`isAppOrigin`'s opaque-origin handling.** Requiring `dev.protocol` to be http/https before
  comparing origins, because `file:`/`data:`/`javascript:` all serialize to the literal `"null"`,
  is the exact bug most Electron apps ship. It is covered by a named regression test
  (`navigationPolicy.test.ts:54-63`).
- **The HC1 token/dialog pair.** `pickDirectory` returns a single-use token instead of a path and
  `saveTextToFile` has no path field at all, so the renderer is structurally incapable of naming a
  destination on either side. `sanitizeSaveFileName`'s whitelist-reduction (discard through the last
  separator, then allowlist characters) is the right shape, not an escaping pass.
- **`CH_HOST_PREVIEW`'s lazy-dependency handler.** Passing `readCache` as a callback so
  `resolvePreview` can short-circuit on `canPreview` before any disk touch is the pattern the two
  MED-flagged handlers should copy.
- **`FRAME_RETENTION` as a `Record<ServerFrame['kind'], …>`.** A compile-time forcing function that
  makes a new protocol frame kind impossible to leave unclassified — the right way to hold a
  three-tier retention policy honest.

## Not reviewed / uncertain

- **Live Electron behaviour.** Per the contract I did not run the app or the hardening smoke, so
  every claim about `will-navigate`, CSP delivery, and window creation is read from source plus the
  existing smoke's assertions. The dev-branch claims in particular are source-only, because no live
  test exercises that branch (see the LOW above).
- **Whether `onHeadersReceived` fires for the packaged `file://` load** in Electron 33. It does not
  matter for the verdict — `app/renderer/index.html` carries an equivalent meta CSP and the smoke
  proves inline script is blocked in packaged mode — but I did not determine which of the two layers
  is doing the work in production.
- **Exact exploitability of the socket-filename collision.** I traced the ordering and confirmed the
  `validateReadyFrame` identity check catches the mis-attach, but the window is a race between a
  dying child's `Bun.listen` and a new supervisor's `mkdirSync`; I did not reproduce it. The fix is
  cheap enough that reproducing it is not worth the cost.
- **`app/main/transcriptCache.ts`, `transcriptBackfill.ts`, `replayBuffer.ts`** were read only as far
  as needed to substantiate findings above; they were not in my file list and have not had a full
  pass. `replayBuffer.ts` in particular deserves one, since the HIGH finding shows its documented
  memory ceiling is not enforced by anything.
