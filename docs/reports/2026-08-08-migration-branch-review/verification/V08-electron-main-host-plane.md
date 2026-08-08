# V08 adversarial validation: Electron main (A08) + host plane (A09)

> **Verification provenance:** Claude Opus 5, high effort. Source review of
> `app/main/main.ts`, `app/main/{attachmentGate,replayBuffer,mainDecisions,navigationPolicy,idleParkDriver,openHistorySession,sessionsCatalogBaseline,transcriptBackfill,mainSourceGuards.test}.ts`,
> `app/host/{host,registry}.ts`, `app/supervisor/supervisor.ts`,
> `app/shared/{hostApi,limits,protocol}.ts`, `app/preload/{preload,rendererIpcGuard}.ts`,
> `app/scripts/{dev,hardening-smoke,devLauncher,reap-orphan-sidecars}.ts`,
> `app/renderer/src/{App.tsx,tabStatus.ts}`. **Six standalone scratch scripts**
> importing the REAL repo modules and run under Bun outside the repo, including
> one that drives the REAL `SidecarSupervisor` against 121 REAL `child_process`
> spawns and 120 REAL SIGTERMs, and one that drives the REAL `SessionRegistry`
> through real lockfile/fsync/rename writes. No focused test file was needed (the
> repros are stronger). No GUI, no app launch, no Electron process, no full
> suite, no repo edits. Branch `migration` at `a1012b1` (the tip moved from
> `a17e5e9` during this run).
>
> **Working-tree state:** `app/` does not exist on `main` at all
> (`git ls-tree -r main -- app/` → 0 files), so every file in both scopes is
> branch-new. Of the files these two reports cite, exactly **two are DIRTY**:
> `app/main/main.ts` (a 3-line comment edit at `:998-1005`, shifting every line
> after it by −1 vs HEAD — both reports appear to have been written against the
> working tree, and their `main.ts` citations match it) and `app/scripts/dev.ts`
> (adds `CATCODE_INITIAL_CWD`, does not touch the readiness probe A08 cites).
> `host.ts`, `registry.ts`, `supervisor.ts`, `hostApi.ts`, `replayBuffer.ts`,
> `attachmentGate.ts`, `idleParkDriver.ts`, `mainDecisions.ts`,
> `navigationPolicy.ts`, `App.tsx`, `tabStatus.ts` are all clean.

## Overall verdict

Both reports are substantially right, and the four-way-agreed `CH_RESTART`
finding **survives a direct end-to-end attack**: I drove `host.restartSession`
through the real supervisor and the real registry and got **121 real child
processes and 120 real SIGTERMs with zero refusals from any layer**, all 120
spawns completing in **20 ms** (≈6,000 spawns/sec), and the create-side rate ring
(`host.spawnTimes`) still holding exactly **one** entry afterwards. Nothing in
the chain serializes below the preload's 120/s, so 120 engine processes per
second is achievable, not inferred. The `liveCount()` lockout also reproduces
exactly — 32 parks, zero live engine processes, and `createSession`,
`restoreSession` **and** `createSessionInWorkspace` all returning
`session_limit: at most 32 live sessions`. Of 27 findings, **22 are CONFIRMED and
5 PARTIALLY CONFIRMED**; none is invalid, stale, or mis-located, and the
`file:line` citations are the most accurate I have checked in this review (~55
verified, all within ±2). The corrections that matter: A09-F1's "only relaunch
recovers" is **wrong** — closing one session frees a slot, and restart-in-place
still works; A09-F5's packaged-binary sub-claim is **impossible by construction**
(one constant is both the spawn argument and the identity marker); A08-F6's
"the window freezes" measures at **604 ms of blocked main thread per second**
(severe jank, not a freeze); A08-F12 counts three `listSessions()` where the code
makes two; and A08-F10's `dev.ts` half is closed by `strictPort: true`. The one
thing that most deserves action is the `CH_RESTART` cap — it is a four-line
change that closes a measured 6,000-spawns/sec hole.

**Reconciling the two "clean bills" the prompt flagged.** A09's praise of the
write primitive is *not* contradicted by the sibling verifier's proven lost
update, because A09 reports that lost update **itself**, as its own F3. Its clean
bill is scoped precisely to atomicity ("Crash-during-write leaves either the old
file or the new one"), which I re-derived independently and which holds. I also
reproduced the lost update (25 rows on disk, all of writer B's gone, JSON
untorn) — the two statements are about different properties of the same
function, and both are true.

## Summary

| # | Sev | Finding (short) | Verdict | One-line reason |
|---|-----|-----------------|---------|-----------------|
| A08-F1 | HIGH | Frame channels take any `sessionId`; main's error path buffers it forever | CONFIRMED | Measured 203 KiB/id retained, ~24 MiB/s at the preload ceiling, nothing reclaims it |
| A08-F2 | HIGH | `CH_RESTART` is the one renderer-reachable spawn path with no rate cap | CONFIRMED | 121 real spawns / 120 real SIGTERMs, zero refusals, 120 spawns in 20 ms |
| A08-F3 | MED | A refused restart is completely silent | CONFIRMED | Repro: refusal returns an error, emits **0** HostEvents, tab still renders `restartable: true` |
| A08-F4 | MED | Reactivate supervisor reuses the socket dir and restarts the counter | PARTIALLY CONFIRMED | Mechanism verified exactly; the race itself not reproduced, consequence bounded to a spurious `failed` |
| A08-F5 | MED | Die-with-window has no wait, no verify, three uncovered exit paths | CONFIRMED | `rg` finds zero crash handlers anywhere in `app/`; teardown is fire-and-forget |
| A08-F6 | MED | `openHistorySession`/`readSessionsCatalog` do eager sync disk work | PARTIALLY CONFIRMED | Real, but measured 5.0 ms/call → 604 ms/s blocked, not a freeze; the catalog half has no input to validate |
| A08-F7 | MED | Eight byte-identical verb-forwarding handlers | CONFIRMED | Exactly 8, `main.ts:1017-1196`; "byte-identical" is loose (comments differ) |
| A08-F8 | MED | Host error strings reaching the user carry internal vocabulary | CONFIRMED | All three strings verbatim; `App.tsx:4705` formats them; six `setShellError` sites; plain-text render |
| A08-F9 | LOW | Navigation guards are per-window, not app-global | CONFIRMED | No `web-contents-created`, no `will-frame-navigate`; one production `new BrowserWindow` |
| A08-F10 | LOW | The dev CSP/navigation branch is never live-exercised | PARTIALLY CONFIRMED | CSP half confirmed; the `dev.ts` probe half is closed by `strictPort: true` + the child-exit check |
| A08-F11 | LOW | `sanitizeSaveFileName` truncates after validating | CONFIRMED | Check at `:186`, slice at `:187`; `'.'×120 + 'a'` returns 120 dots |
| A08-F12 | LOW | `host.listSessions()` called three times per backfill result | PARTIALLY CONFIRMED | It is **two**, and the second is conditional; ~16k not ~24k `existsSync`; ≈42 ms total |
| A09-F1 | HIGH | `liveCount()` counts dead tombstones and traps the app | CONFIRMED | Repro: 32 parks, 0 live engines, create + restore + create-in-workspace all `session_limit` |
| A09-F2 | HIGH | `restartSession` bypasses both HC4 caps | CONFIRMED | Same defect as A08-F2, measured; plus a real ~145 KB fsynced rewrite per restart |
| A09-F3 | MED | `persist()` is a stale-view full-file overwrite | CONFIRMED | Repro: 25 rows on disk, all 25 of writer B lost, JSON untorn. Also proven by V29-F4 |
| A09-F4 | MED | A transient read error silently destroys the registry | CONFIRMED | Repro: 5 valid rows → 0 after one `EACCES` launch, no corrupt-copy preserved |
| A09-F5 | MED | The restore-refusal guard reuses a kill-polarity predicate | PARTIALLY CONFIRMED | Polarity real; sub-claims (a)+(b) hold; the packaged-binary sub-claim (c) is impossible by construction |
| A09-F6 | MED | Host error messages are rendered verbatim and are debug text | CONFIRMED | All eight cited lines hold; `App.tsx:3170-3172` renders `shellError` as plain text |
| A09-F7 | MED | `registry_unavailable` is a declared code no caller can observe | CONFIRMED | Zero `hostError('registry_unavailable', …)` call sites repo-wide; prior LR-4 verified |
| A09-F8 | LOW | `'parked'` rows are permanently exempt from the row bound | CONFIRMED | Repro: 286 parked rows retained vs a 256 bound; clean-row control caps at exactly 256 |
| A09-F9 | LOW | Nothing prunes `registry.json.corrupt-*` or leaked `.tmp` files | CONFIRMED | No enumeration or unlink of either pattern anywhere in `app/host` or `app/main` |
| A09-F10 | LOW | `ShutdownState` is a closed union with no exhaustiveness tripwire | CONFIRMED | All three consumers are if-chains/ternaries with catch-alls; `mapStatus` is the protected counter-example |
| A09-F11 | LOW | The launch sweep runs a synchronous `ps` per live row before the window | CONFIRMED | `ensureHost()` precedes `createWindow()`; read/sweep/reap all precede `launch()`'s first `await` |
| A09-F12 | LOW | `defaultTranscriptPath`'s long-path fallback does an uncached `readdirSync` | CONFIRMED | Reached per row per `listSessions()`; trigger needs a >200-char sanitized cwd |
| A09-F13 | LOW | A malformed row is dropped with no log | CONFIRMED | Repro: one row silently vanished, **zero** log lines produced |
| A09-F14 | LOW | `errText` and `isUuid`/`UUID_RE` are copy-pasted across planes | CONFIRMED | Exactly 4 `errText` and 5 UUID regexes; the report's location list omits one of the five |
| A09-F15 | LOW | Two injected callbacks are treated as infallible | CONFIRMED | Both control-flow gaps exist; latent because today's injection catches internally |

## Per finding

### A08-F1 — [HIGH] Frame channels accept any `sessionId` string, and main's error path permanently buffers it

- **Verdict**: CONFIRMED
- **Cited location holds?**: Yes, all four, exactly (against the dirty working
  tree the report was written against). `main.ts:1198-1201` is the `CH_PING`
  handler whose only check is
  `if (typeof arg?.sessionId !== 'string' || typeof arg?.nonce !== 'string') return`,
  followed by `forward(arg.sessionId, { type: 'app.ping', nonce: arg.nonce })`.
  `main.ts:1579-1616` is `forward`, with the `!supervisor` error frame at
  `:1580-1594` and the `supervisor.send` catch frame at `:1596-1616`; both end in
  `deliver(attachmentGate.onFrame(sessionId, frame))`.
  `attachmentGate.ts:73-75` is `onFrame`, whose **first** statement is
  `this.buffer.record(sessionId, frame)` and whose **second** is
  `if (!this.attached) return []` — record-before-gate, as claimed.
  `replayBuffer.ts:169-180` is `record`, which mints a fresh `SessionEntry` for
  any unseen key. `sessions` is `private readonly sessions = new Map<SessionId, SessionEntry>()`
  (`:158`) with per-session `maxRecent`/`maxRecentBytes` and **no** bound on key count.
- **Reachable in production?**: Yes. `registerIpcHandlers()` is called
  unconditionally in `whenReady` (`main.ts:1822`); `ping` is on the exposed
  bridge (`preload.ts:214-219`) and `contextBridge.exposeInMainWorld('catcode', bridge)`
  is unconditional (`preload.ts:365`). No env gate, no feature flag, no dev
  harness. `main.ts` contains **no** `isUuid`/UUID check at all (grep: the only
  `uuid` hits are `randomUUID` imports), so the frame plane's *only* session-id
  validation is `typeof === 'string'`. This is not limited to `CH_PING`: all
  eight verb channels and `CH_SUBMIT`/`CH_ABORT` reach `forward` the same way.
- **Trigger**: `window.catcode.ping('A'.repeat(120_000) + i, 'x')` in a
  try/catch loop. `supervisor.send` throws `SidecarSendError('session_not_found', …)`
  (`supervisor.ts:322-327`), `forward` catches and mints an error frame whose
  `message` is `` `session ${sessionId} was not found` ``, and `onFrame` records
  it under the fabricated key.
- **Counter-arguments considered**:
  1. *Does the preload's byte cap stop a 120 KB id?* No. `MAX_FRAME_BYTES` is
     131,072 (`limits.ts:20`) and the serialized `{sessionId, nonce}` is ~120 KB.
     I ran the **real** `createRendererIpcGuard` and it admitted 120 such
     payloads before throwing — the rate cap binds, not the size cap.
  2. *Is there an LRU or a session-count cap in `FrameReplayBuffer`?* No. Read
     the whole file: the only reclaim paths are `clearSession` (called from
     `main.ts:900` on a **terminal lifecycle frame**, which the supervisor never
     emits for an id it has no record of, and from `host.evictReplay` at
     `main.ts:1735`, which only ever receives real registry ids) and `clear()`
     via `attachmentGate.reset()` at `main.ts:1920`, i.e. `window-all-closed`.
  3. *Does the frame get evicted by the ring budget?* No — one ~120 KB frame is
     far under the 8 MiB per-session budget, and the budget is **per session**,
     which is precisely the problem.
  4. *Is `gcTranscriptCache` or the idle-park driver a reclaim path?* No; both
     operate on disk cache files and registry rows, not on this Map.
- **True consequence**: Unbounded growth of a Map in the **privileged** Electron
  main process at ~24 MiB/s, plus a second-order amplification neither report
  names (below). The documented ceiling at `replayBuffer.ts:66-71`
  (`MAX_LIVE_SESSIONS × DEFAULT_MAX_BUFFERED_BYTES` = 256 MiB) is indeed not
  enforced by anything.
- **Evidence**: `scratchpad/v08/f-replaybuffer.ts`, driving the REAL
  `AttachmentGate` + `FrameReplayBuffer` with the exact frame `forward` builds:
  ```
  MAX_FRAME_BYTES = 131072 ; rate: 120 per 1000 ms
  guard threw after 120 calls: renderer IPC rate exceeds 120 frames per 1000ms
  preload guard admitted 120 x 120KB-sessionId ping payloads in one window

  entries in FrameReplayBuffer.sessions after 1000 fabricated ids: 1000
  heapUsed delta: 198.2 MiB      per-id cost: 203.0 KiB
  projected at the preload ceiling (120/s): 23.8 MiB/s
  entries after a renderer reload: 1000
  entries after reset() (window-all-closed only): 0
  ```
  The report's "roughly 30 MB/s" is ~25% high; 24 MiB/s is the measured figure.
- **Disposition**: Apply the report's fix, and prefer its **first** option. Add
  one `if (!isUuid(sessionId)) return` at the top of `forward` — that is a single
  edit covering all ten channels at once, which is exactly why A08-F7's
  eight-fold duplication matters. Do **not** take the second option
  ("gate `attachmentGate.onFrame` on the session existing") as the primary fix:
  `onFrame` is also the path a legitimately-racing frame takes while a row is
  being written, and adding an existence lookup there risks dropping real frames
  for a narrower win. `isUuid` already exists at `host.ts:92`; per A09-F14 it
  should be lifted into `app/shared/` rather than copied a sixth time.

### A08-F2 — [HIGH] `CH_RESTART` is the one renderer-reachable spawn path with no rate cap

- **Verdict**: CONFIRMED
- **Cited location holds?**: Yes. `main.ts:1203-1210` is
  `ipcMain.on(CH_RESTART, (_e, arg) => { if (typeof arg?.sessionId !== 'string' || !host) return; … void host.restartSession(arg.sessionId) })`.
  `host.ts:603-649` is `restartSession`: `await this.launched`, `isUuid`,
  `isLive`, `findSession`, the SF6 `canResume` re-check, `evictReplay`,
  `supervisor.restartSession`, `registry.upsertOnSpawn`, `emitStatus` — and
  **neither** `checkSpawnLimits()` nor `recordSpawnTime()`. `host.ts:711-731` is
  `checkSpawnLimits`, called from `createSession:283`, `restoreSession:352` and
  `createSessionInWorkspace:409` only. `supervisor.restartSession`
  (`supervisor.ts:366-376`) is `killSession` + `spawnSession` with no throttle.
- **Reachable in production?**: Yes. `restart` is on the exposed bridge
  (`preload.ts:219-223`), rate-guarded at 120/s and nothing else. `isLive()` is
  satisfied by a **tombstone** as well as a live process (`host.ts:745-747`
  checks membership only), and `supervisor.restartSession` re-registers the id as
  `spawning` synchronously, so the session re-qualifies instantly.
  `canResume` is only consulted when `row.engineSessionId !== null`, so a fresh
  never-resumed session passes unconditionally.
- **Trigger**: `for(;;){ try{ window.catcode.restart(id) }catch{} }` against any
  one live session id the renderer already holds.
- **Counter-arguments considered**: I looked for a cap at **every** layer and
  found exactly one, the preload's.
  1. *Preload*: `sendGuard.assertAllowed({sessionId})` → 120 per 1000 ms
     (`limits.ts:29,32`). This is the only throttle in the chain.
  2. *`ipcMain`*: no rate limit, no queue, `void`-ed.
  3. *`host.restartSession`*: verified above — no cap.
  4. *Does `await this.launched` serialize the calls?* No. It is an
     already-resolved promise, so each call resumes on a microtask, and
     `supervisor.restartSession` (the kill + spawn) is fully synchronous and runs
     **before** the first real `await` (`registry.upsertOnSpawn`).
  5. *Does the registry's advisory lock serialize the spawns?* No — the spawn has
     already happened by the time `persist()` is reached. I measured this
     directly rather than reasoning about it.
  6. *Does the create-side rate cap notice?* No. After 120 restarts,
     `host.spawnTimes.length` was **1**, and an immediate `createSession`
     succeeded.
- **True consequence**: A renderer can mint Bun engine processes at the preload's
  120/s ceiling indefinitely, with a SIGTERM per iteration and an unbounded
  `restartCount` bump. Each spawn is the ~189 MB engine graph the repo's own
  comment cites (`main.ts:824`; I did not re-measure that figure). This is the
  fork bomb `MAX_SPAWNS_PER_WINDOW = 8 / 10 s` documents itself as preventing.
- **Evidence**: `scratchpad/v08/f-restart-rate.ts` — REAL `SidecarSupervisor`
  (`sidecarCommand: '/bin/sleep'` so no engine graph is booted, which makes the
  measured rate an **upper bound on process-creation cost** and a **lower bound**
  on the machine cost of a real engine spawn), REAL `SessionRegistry`, REAL
  `Host`, driven exactly as `ipcMain.on(CH_RESTART)` drives it:
  ```
  --- burst of 120 fire-and-forget restartSession calls ---
  REAL child processes spawned: 121 (distinct pids: 121 )
  REAL SIGTERMs sent: 120
  calls REFUSED by any cap: 0
  restartCount on the row: 120
  host.spawnTimes ring length after 120 restarts: 1
  createSession immediately after the burst -> ok (cap unaware of restarts)
  ```
  and `scratchpad/v08/f-restart-amplify.ts` at a full 256-row registry:
  ```
  120-call burst at a full registry:
    all 120 REAL spawns completed after 20.0 ms -> 5988 spawns/sec
    all persists settled after 434.2 ms -> 276 restarts/sec sustained
    refusals: 0
  ```
  **The preload's 120/s is the only thing standing between a renderer and ~6,000
  process spawns per second.** Nothing downstream serializes or awaits.
- **Disposition**: Apply the report's fix exactly — `this.checkSpawnLimits()` at
  the top of `restartSession` and `this.recordSpawnTime()` before
  `supervisor.restartSession`. Two caveats. (a) Land it **together with** A09-F1's
  `liveCount` filter, or restart-in-place inherits the tombstone lockout and a
  crashed tab's Restart button starts failing after 32 sessions — today it is the
  one path that still works when capped, which is a property worth keeping. (b)
  The `session_limit` refusal must be surfaced, or A08-F3 turns a rate-limited
  restart into another silent no-op; fix F3 in the same change.

### A08-F3 — [MED] A refused restart is completely silent — no frame, no toast, nothing

- **Verdict**: CONFIRMED
- **Cited location holds?**: Yes. `main.ts:1203-1210`, and the inline comment
  reads verbatim "A typed error is swallowed here (fire-and-forget IPC); the
  renderer already learns liveness from status events." The two refusals are
  `host.ts:608-610` (`session ${id} is not live`) and `host.ts:623-627`
  (`transcript for ${id} is gone`), neither of which calls `this.emit`.
  `tabStatus.ts:114-123` sets `restartable = true` for a `disconnected`/`exited`
  descriptor (the report cited `:117-123`; the branch spans `:114-123`).
- **Reachable in production?**: Yes. `restartTab` (`App.tsx:1828-1835`) is a bare
  `getBridge().restart(sessionId)` whose only `catch` is for a **synchronous**
  preload throw (the rate guard); the async host refusal is unreachable to it.
  The banner Restart at `App.tsx:4666-4672` is the same.
- **Trigger**: A session opened and never typed in, then crashed. Its ready frame
  stamped `engineSessionId`, but the engine only materializes the `.jsonl` on the
  first user/assistant message, so `hasTranscript` is false and `canResume`
  refuses.
- **Counter-arguments considered**:
  1. *Does the descriptor even stay a tab, or is it removed?* It stays. I checked
     the full chain rather than assuming: `markCrashed` → `emitStatus` →
     `descriptorFromRow(row, null)` → `{status:'disconnected', restorable:false}`,
     and `listSessions()` still returns it. I then fed that exact descriptor to
     the REAL `deriveTabVisualState` and got `restartable: true`.
  2. *Does the parked path rescue this?* No, and it is the opposite case: for a
     genuinely parked session `tabStatus.ts:98-113` returns `restartable: false`
     with label `idle`, so the affordance is correctly withheld there. The
     defective case is the crash-shaped one where the affordance IS shown.
  3. *Does `connectionState` paint something?* Only a generic connection banner
     on an active chat tab; it names no verb and does not change after the
     refusal.
- **True consequence**: A Restart button rendered on a dead tab that returns
  `session_not_found` forever, with **zero** signal of any kind. Made permanent
  for the run by `resumeFailed` (`host.ts:225-234`) once a resume actually fails.
- **Evidence**: `scratchpad/v08/f-silent-restart.ts`, REAL `Host` + REAL
  `SessionRegistry` + REAL `deriveTabVisualState`:
  ```
  restartSession -> {"ok":false,"error":{"code":"session_not_found","message":"transcript for 88ef… is gone"}}
  HostEvents emitted by the refusal: 0 []
  descriptor in listSessions(): {"status":"disconnected","restorable":false}
  tabStatus: {"label":"disconnected","tone":"dead","restartable":true,...}
  second restart -> {...same...}  events: 0
  ```
- **Disposition**: Apply the report's fix (mint the same error `ServerFrame` on
  `!result.ok` and push it through `deliver(attachmentGate.onFrame(...))`), with
  one correction: **do not** route it through `attachmentGate.onFrame` without
  first taking A08-F1's `isUuid` guard, or the silent-restart fix becomes a
  second unbounded-buffer path for a fabricated id. Order the two fixes: F1's
  guard first, then F3's frame. Also consider suppressing `restartable` in
  `tabStatus.ts` when `descriptor.restorable === false && engineSessionId !== null`
  — the button is unactionable in exactly that state, and the honest presentation
  is no button rather than a button plus a toast.

### A08-F4 — [MED] The reactivate supervisor reuses the same socket directory and restarts the filename counter

- **Verdict**: PARTIALLY CONFIRMED
- **Cited location holds?**: Yes, all four. `main.ts:635-647` is
  `createSupervisor()` and it passes **no** `socketDir`. `supervisor.ts:186-195`
  defaults it to `/tmp/catcode-${process.pid}` — process-scoped, not
  supervisor-scoped — and `mkdirSync`s it in the constructor. `supervisor.ts:150`
  is `private socketSeq = 0`, an instance field, so a second supervisor restarts
  at `s0.sock` (`:238`). `main.ts:1698-1701` is `ensureHost()`, called from
  `app.on('activate')` at `main.ts:1830`.
- **Reachable in production?**: On macOS, yes. `window-all-closed`
  (`main.ts:1903-1925`) calls `shutdownRuntime()`, nulls `supervisor` and `host`,
  and deliberately does **not** `app.quit()` on darwin; `activate` then rebuilds.
  `supervisor.shutdown()` (`supervisor.ts:384-396`) SIGTERMs every child and
  immediately `rmSync`s the directory with no wait.
- **Trigger**: Close the window while a sidecar is between `exec` and its
  `Bun.listen`, then reopen from the dock fast enough that the new supervisor has
  re-`mkdirSync`ed `/tmp/catcode-<pid>` before the dying child binds
  `s0.sock` into it.
- **Counter-arguments considered**:
  1. *Does `spawnSession`'s stale-socket removal close it?* Partly and not
     reliably: `supervisor.ts:246-249` does `if (existsSync(socketPath)) rmSync(...)`
     **before** spawning, so a socket file created *after* that check still wins
     the poll-connect at `:417-438`.
  2. *Does the child survive SIGTERM long enough?* It has a handler
     (`app/sidecar/index.ts:371`), so a booted sidecar cleans up gracefully; one
     killed before installing it dies on the default action. The window is real
     but narrow, and I did not reproduce it.
  3. *What actually happens if it lands?* `validateReadyFrame`'s
     `sessionId does not match supervisor record` check fires, the record goes
     `failed`, and the socket is destroyed — the report's own conclusion. So the
     outcome is a spurious `failed` on a dock-reopen session, **not** a
     cross-wired engine.
- **True consequence**: A narrow reopen race whose worst observed outcome is one
  dock-reopen session reporting `failed` and needing a retry. The collision is
  real; the security consequence is nil.
- **Evidence**: `main.ts:635-647,1698-1701,1830,1903-1925`;
  `supervisor.ts:150,186-195,238,246-249,384-396,417-438`;
  `app/sidecar/index.ts:371`.
- **Disposition**: Apply the fix — it is one string and removes a whole class of
  reasoning. But prefer a monotonic generation counter **owned by the supervisor
  module** over main threading one through (`/tmp/catcode-${process.pid}-${gen}`
  with `gen` a module-level counter incremented per constructor), so a future
  second construction site cannot forget it — the same argument A08-F9 makes for
  the navigation guards. Also worth pairing: have `shutdown()` `rmSync` the
  directory it owns *after* a short drain, or not at all (the next launch's
  `existsSync` check already handles staleness).

### A08-F5 — [MED] Die-with-window has no wait, no verify, and three uncovered exit paths

- **Verdict**: CONFIRMED
- **Cited location holds?**: Yes. `shutdownRuntime()` at `main.ts:1845-1851` is
  `if (host) host.shutdownAll() else supervisor?.shutdown()` — synchronous,
  fire-and-forget. `teardownOnSignal` at `main.ts:1891-1899` with the
  `signalTeardownStarted` latch. `window-all-closed` at `:1903` and
  `before-quit` at `:1927`.
- **Reachable in production?**: Yes, and the *absence* is total.
  `rg --glob '!**/dist/**' 'uncaughtException|unhandledRejection|render-process-gone|child-process-gone' app/`
  returns **zero matches across the entire `app/` tree** — not just `app/main`.
  So an uncaught throw or floating rejection in main exits without ever running
  `shutdownRuntime()`.
- **Trigger**: Any uncaught exception or unhandled rejection in main. The
  report's example — a floating rejection from `void window.loadURL(...)` when
  Vite dies between the readiness probe and the load — is plausible; so is any
  throw inside the many `void`-ed async host calls.
- **Counter-arguments considered**:
  1. *Is anything else marking rows clean?* No. `markLiveCleanSync` is reached
     only through `host.shutdownAll()`, which only `shutdownRuntime()` calls.
  2. *Are the orphans permanent?* No, and the report says so honestly: the
     sidecar's own idle janitor self-exits after 15 minutes with zero supervisor
     connections (`app/sidecar/index.ts:58` `DEFAULT_SIDECAR_IDLE_TTL_MS`,
     independently confirmed by V29-F7). So "die with the window" degrades to
     "die within 15 minutes", exactly as claimed.
  3. *Does the launch sweep clean up next time?* Yes for the process, but only if
     `matchesSidecarIdentity` holds — which A09-F5 shows is not guaranteed — and
     every such row is reported `crashed`, which `teardownOnSignal`'s own comment
     (`main.ts:1879-1888`) says must not happen.
- **True consequence**: On a main-process crash, every live engine survives up to
  15 minutes and every live row is misreported as a crash on the next launch.
- **Evidence**: the `rg` above (exit 1, no matches); `main.ts:1845-1851,1879-1899,1903,1927`.
- **Disposition**: Apply as written — `process.on('uncaughtException')` /
  `process.on('unhandledRejection')` running the `teardownOnSignal` body behind
  the existing latch, then a non-zero exit. Add `render-process-gone` too: the
  report names it in its "verified by grep" list but omits it from the fix, and a
  dead renderer with a live engine fleet is the same leak by another route. The
  report is right that waiting on children belongs in the supervisor and should
  not ride this change.

### A08-F6 — [MED] `openHistorySession` and `readSessionsCatalog` do unbounded synchronous disk work before validating input

- **Verdict**: PARTIALLY CONFIRMED
- **Cited location holds?**: Yes. `main.ts:1420-1424` is
  `resolveOpenHistorySession(engineSessionId, host.listSessions(), readSessionsCatalogCache(defaultRegistryDir()))`
  — all three arguments evaluated eagerly (report cited `:1419-1423`, off by one).
  `main.ts:1348-1358` is `CH_HOST_SESSIONS_CATALOG`. `main.ts:1360-1378` is
  `CH_HOST_PREVIEW` with `readCache` passed as a **lambda** and the comment
  stating that as the boundary requirement. The UUID reject is at
  `openHistorySession.ts:81-86`. `MAX_SESSIONS_CATALOG_CACHE_BYTES = 4 MiB`
  (`sessionsCatalogBaseline.ts:34`); `MAX_REGISTRY_SESSIONS = 256`.
- **Reachable in production?**: Yes. `openHistorySession` is on the bridge
  (`preload.ts:317-330`), rate-guarded at 120/s.
- **Trigger**: `window.catcode.openHistorySession('garbage')` in a loop.
- **Counter-arguments considered**:
  1. *Is the cost actually large?* I measured it instead of assuming. Built a
     schema-valid 4.0 MiB catalog cache (10,000 entries) and a 256-row registry,
     then timed the real functions: `readSessionsCatalogCache` **4.39 ms**
     median, `host.listSessions()` **0.65 ms** median → **5.04 ms** of
     synchronous main-thread work per malformed-id call, i.e. **604 ms of
     blocked main thread per second** at the preload ceiling.
  2. *So does the window freeze?* Not literally — 60% of the main thread is
     consumed, which is severe jank and dropped frames, not a hang. "The window
     freezes" is the one claim here I would not repeat verbatim.
  3. *Does the `CH_HOST_SESSIONS_CATALOG` half belong in this finding?* Weakly.
     It has **no input to validate**, so there is nothing to short-circuit on;
     the honest criticism there is that a read-only, id-less handler does 4 ms of
     synchronous work per call, not that it validates late.
- **True consequence**: A renderer can consume ~60% of the Electron main thread
  with malformed ids, at zero cost to itself, on a path whose sibling handler one
  screen above demonstrates the correct pattern.
- **Evidence**: `scratchpad/v08/f-openhistory-cost.ts`:
  ```
  catalog cache entries: 10000  bytes: 4027840 (bound 4194304)
  median readSessionsCatalogCache: 4.39 ms
  median host.listSessions() at 256 rows: 0.65 ms
  per malformed-id openHistorySession call TODAY: 5.04 ms of SYNCHRONOUS main-thread work
  at the preload ceiling ( 120 /s ): 604 ms of main-thread work per second
  main thread saturated? false
  resolver verdict for "garbage": {"kind":"reject",...,"message":"malformed engine session id"}
  ```
- **Disposition**: Apply the thunk fix — it is the right shape and the resolver
  already returns `reject` before touching either argument. But make the
  `OpenHistoryResolution` deps a single options object of thunks rather than two
  positional lambdas, so the next argument added cannot be eager by default. Drop
  the `CH_HOST_SESSIONS_CATALOG` half from the finding, or restate it as "cache
  the parsed snapshot with an mtime check", which is the actual fix there.

### A08-F7 — [MED] Eight byte-identical verb-forwarding handlers

- **Verdict**: CONFIRMED
- **Cited location holds?**: Yes. Exactly eight `*_VERB_TYPES.includes(...)`
  membership tests at `main.ts:1030, 1050, 1088, 1108, 1130, 1151, 1170, 1190`,
  spanning `:1017-1196` as cited — about 180 lines, and the largest contiguous
  block in the 1,932-line file.
- **Reachable in production?**: N/A (structure), but the cost claim is live: the
  A08-F1 fix needs the same guard added in each of them unless `forward` is
  changed instead.
- **Trigger**: n/a.
- **Counter-arguments considered**:
  1. *Are they really "byte-identical"?* **No** — that word is wrong. The bodies
     are structurally identical but each carries a substantive, non-boilerplate
     comment naming a different sidecar validation (P4-5 pool-resolved business
     rules vs P4-19 Zod + `EDITABLE_SETTINGS` + `SettingsUpdater`-under-lock).
     A table-driven helper would have to relocate eight genuinely different
     comments, which is a real cost the finding does not price.
  2. *Would a helper break `mainSourceGuards.test.ts`?* No. Its `forwardTypes`
     guard (`:130-144`) matches `forward(x, { type: '...'` literals only, and
     object-forwarded verbs never match — the report is right about that.
- **True consequence**: One shared-shape change costs eight edits with eight
  chances to miss one. That is exactly the risk A08-F1's fix runs into.
- **Evidence**: line list above; `mainSourceGuards.test.ts:128-145`.
- **Disposition**: Apply, but fix A08-F1 in `forward` **first** so the refactor
  is not on the critical path of a security fix. And keep the eight comments —
  move each to its `*_VERB_TYPES` constant declaration rather than deleting them
  with the handler; they document a sidecar contract, not the handler.

### A08-F8 — [MED] Host error strings that reach the user carry internal vocabulary and engineering notes

- **Verdict**: CONFIRMED
- **Cited location holds?**: Yes, all three verbatim. `main.ts:1252`
  `message: 'host is not running'`; `main.ts:1302`
  `message: 'a valid directory token from pickDirectory() is required'`;
  `openHistorySession.ts:85` `reject('session_not_found', 'malformed engine session id')`.
  `App.tsx:4705-4707` is `` return `${error.code}: ${error.message}` ``, and there
  are exactly **six** `setShellError(hostErrorMessage(...))` call sites
  (`App.tsx:1240, 1259, 1822, 1848, 1864, 1985`) — the count is right.
- **Reachable in production?**: Yes. `shellError` renders as plain text at
  `App.tsx:3170-3172`.
- **Trigger**: Any create/restore/close/open-history failure before the host is
  constructed, or a create with a spent/absent picker token.
- **Counter-arguments considered**:
  1. *Is `host is not running` reachable at all, given `ensureHost()` runs in
     `whenReady` before `createWindow()`?* Yes but rarely — the `noHost` guard
     fires when `host` is null, which after `window-all-closed` on macOS is the
     state until `activate` rebuilds it, and a frame in flight can land there.
  2. *Is `mainDecisions.ts` really the counter-example?* Yes: `:203-227` carries
     "There was nothing to save.", "This is too large to save as one file. Save
     fewer sessions at a time.", "That file name cannot be used." — user-facing
     copy written the right way, one file over.
- **True consequence**: The user sees `spawn_failed: host is not running` and
  `invalid_cwd: a valid directory token from pickDirectory() is required`.
- **Evidence**: line citations above.
- **Disposition**: Do **not** rewrite the three host-side strings, which is what
  the report proposes. Take A09-F6's disposition instead — it is the better fix
  and the two findings are the same defect seen from two sides: keep
  `HostError.message` as the diagnostic field its own type comment says it is,
  and map `error.code` → human copy in `hostErrorMessage` (five codes, one
  function, one place). That also fixes the `${error.code}:` prefix, which A08
  correctly identifies as the renderer's defect but then leaves out of scope.

### A08-F9 — [LOW] Navigation guards are per-window rather than app-global

- **Verdict**: CONFIRMED
- **Cited location holds?**: Yes. `main.ts:802-818` attaches `will-navigate`,
  `will-redirect` and `setWindowOpenHandler` to `window.webContents` inside
  `createWindow()`. `rg` finds no `app.on('web-contents-created')` and no
  `will-frame-navigate` anywhere in `app/`.
- **Reachable in production?**: The gap is not reachable today, which is what
  makes it LOW. `new BrowserWindow` appears exactly twice: `main.ts:726`
  (production) and `app/scripts/f2-attach-smoke.ts:217` (a script, not shipped).
  `setWindowOpenHandler` denies unconditionally (`decideWindowOpen` always
  returns `action: 'deny'`), `webviewTag: false`, and `frame-src 'none'` is in
  both CSP layers.
- **Trigger**: None today; the cost is the day a second window is added.
- **Counter-arguments considered**: I checked whether `f2-attach-smoke.ts`
  already constitutes the "second window" — it does construct a `BrowserWindow`,
  but it is a dev smoke script outside the shipped surface, so the report's
  "production" qualifier holds.
- **True consequence**: Structural. A future settings/preview window ships with
  the preload attached and no navigation policy, and nothing fails.
- **Evidence**: `main.ts:726,802-818`; `navigationPolicy.ts` `decideWindowOpen`; grep.
- **Disposition**: Apply. Note one thing the report does not: moving to
  `app.on('web-contents-created')` means the handler also fires for any future
  `WebContentsView`/devtools contents, so `navigationConfig()` must stay correct
  for a contents whose expected origin is not the renderer's — keep the
  per-window `setWindowOpenHandler` call as well rather than relying on the
  global for window-open.

### A08-F10 — [LOW] The dev branch of the CSP and navigation policy is never exercised by a live test

- **Verdict**: PARTIALLY CONFIRMED
- **Cited location holds?**: Yes for the CSP half. `hardening-smoke.ts:22-25`
  (report said `:23-26`) is
  `Object.defineProperty(app, 'isPackaged', { configurable: true, get: () => true })`
  evaluated **before** production main, so every live check runs the packaged
  branch. `devCsp.test.ts` is entirely `readFileSync` + `toContain` over
  `main.ts` and `index.html` — a source grep, exactly as described.
  `dev.ts:104-118` is the readiness probe `await fetch(RENDERER_URL); return true`.
- **Reachable in production?**: The coverage gap is real: no test asserts that
  `navigationConfig()` returns the dev config or that the dev CSP header is
  emitted.
- **Trigger**: A dev-branch CSP or navigation regression.
- **Counter-arguments considered**: **The `dev.ts` half does not survive.** The
  report says the probe "accepts **any** process answering on :5173,
  contradicting that file's own header claim". Two guards it did not check close
  that: (a) `app/renderer/vite.config.ts` sets `server: { port: 5173, strictPort: true }`,
  so if anything else holds :5173 our Vite **fails to start** rather than moving
  to 5174; and (b) `waitForRendererReady` is passed `childExit: () => vite.exit`,
  so that failure aborts the launch instead of proceeding. The scenario "our Vite
  is alive while a foreign server answers :5173" is therefore not constructible.
  The header claim is honoured by the port policy, not by the probe — a fair
  criticism of where the invariant lives, but not the security gap described.
- **True consequence**: The dev CSP + navigation wiring has source-grep coverage
  only. The `dev.ts` readiness concern is theoretical.
- **Evidence**: `hardening-smoke.ts:19-25`; `devCsp.test.ts:9-26`;
  `dev.ts:1-12,104-118`; `app/renderer/vite.config.ts:15-18`;
  `devLauncher.ts` `waitForRendererReady` `childExit`.
- **Disposition**: Apply only the first half — a second hardening-smoke pass
  without the `isPackaged` override, against a live Vite. Drop the `dev.ts`
  recommendation: a marker assertion adds a failure mode (Vite serving before the
  marker route resolves) to close a hole `strictPort: true` already closes. If
  the header sentence is what bothers, amend the sentence to name the port policy
  as the mechanism.

### A08-F11 — [LOW] `sanitizeSaveFileName` truncates after validating

- **Verdict**: CONFIRMED
- **Cited location holds?**: Yes, off by one. `mainDecisions.ts:186` is
  `if (cleaned.replace(/\./g, '') === '') return null` and `:187` is
  `return cleaned.slice(0, MAX_SAVE_NAME_CHARS)` (report cited `:183-187`).
- **Reachable in production?**: Yes — `validateSaveTextRequest` (`:218`) calls it
  on every `saveTextToFile`, and `MAX_SAVE_NAME_CHARS` is 120.
- **Trigger**: `'.'.repeat(120) + 'a'` passes the all-dots check (the `a` saves
  it) and then truncates to 120 dots, i.e. a value the function's own doc-comment
  says is rejected.
- **Counter-arguments considered**: Is it a traversal? No — the separator-discard
  runs first, so the result can never contain `/` or `\`, and reaching `.`/`..`
  would need `MAX_SAVE_NAME_CHARS ≤ 2`. It is also only a dialog **default**, and
  the user can rename. So the invariant is broken; the exploit is not.
- **True consequence**: A stated invariant the code does not maintain, producing
  a nonsense default file name at a bound nobody will hit.
- **Evidence**: `mainDecisions.ts:176-188`; `limits.ts` `MAX_SAVE_NAME_CHARS`.
- **Disposition**: Apply — slice first, then run the empty and all-dots checks.
  One line moved; correct regardless of the constant.

### A08-F12 — [LOW] `host.listSessions()` is called three times per backfill result and once per host event

- **Verdict**: PARTIALLY CONFIRMED
- **Cited location holds?**: Yes as to lines. `main.ts:436-460` is the `onSession`
  callback; `main.ts:569` is `listSessions: () => activeHost.listSessions()` in
  `startIdleParkDriver`.
- **Reachable in production?**: Yes, on the post-paint backfill and on every host
  event.
- **Trigger**: A full backfill (`MAX_TRANSCRIPT_BACKFILL_SESSIONS = 32`,
  `transcriptBackfill.ts:27`) over a 256-row registry.
- **Counter-arguments considered**: **The count is wrong, by the report's own
  citation.** It lists `canPreview(...)` as the first of the three, but
  `canPreview` calls `descriptorFor` (one row), *not* `listSessions()` — which is
  precisely the rewrite `host.ts:684-687` documents and which the report itself
  cites approvingly one sentence earlier. The real count is **two**
  `listSessions()` per result: one inside `getCurrentSession`, invoked exactly
  once at `transcriptBackfill.ts:81`, and a second at `main.ts:453-456` that is
  **conditional on `persisted === 'written'`**. So 32 × 2 × 256 ≈ **16,400**
  `existsSync`, not "on the order of 24,000", and fewer when results are not
  written. I also measured the unit cost: `host.listSessions()` at 256 rows is
  **0.65 ms**, so the whole backfill's redundant work is ≈ 42 ms spread across an
  async, post-paint job.
- **True consequence**: One redundant O(rows) descriptor build per written
  backfill result, ≈20 ms of avoidable work per full backfill. The idle-park
  driver's per-host-event `listSessions()` is the larger of the two and is
  unconditional.
- **Evidence**: `main.ts:436-460,453-456,569`; `transcriptBackfill.ts:27,81`;
  `host.ts:684-696`; measurement in `scratchpad/v08/f-openhistory-cost.ts`.
- **Disposition**: Apply the hoist — it is two lines and obviously right. Restate
  the finding as two calls, not three, and lead with the idle-park driver, which
  is the unconditional one: memoize `listSessions()` per host-event tick (the
  driver already re-evaluates on *every* event, so a burst of N status events
  costs N full builds).

### A09-F1 — [HIGH] `liveCount()` counts dead tombstones, so the concurrency cap traps the app

- **Verdict**: CONFIRMED (with one claim corrected)
- **Cited location holds?**: Yes, exactly. `host.ts:739-741` is
  `private liveCount(): number { return this.supervisor.listSessions().length }`,
  consumed at `host.ts:717` (`if (this.liveCount() >= MAX_LIVE_SESSIONS)`).
  `supervisor.ts:296-306` is `child.on('exit')`, which emits and calls
  `setStatus(record, 'exited')` and **keeps** the record; `killSession`
  (`supervisor.ts:356-363`) is the only `registry.delete`. `host.ts:907-913` is
  the tombstone doc-comment plus `isTerminalStatus`. `restoreSession`'s
  `checkSpawnLimits()` at `:352` does run **before** the `killSession` at `:360`.
- **Reachable in production?**: Yes. A park is a `PARKED_EXIT_CODE` self-exit
  (`idleParkDriver.ts` header + `host.ts:210-215`), i.e. a child exit with no
  `killSession`, i.e. a permanent tombstone.
- **Trigger — reproduced end to end.** 32 sessions created, made ready, and
  parked one at a time (never more than one live engine), against the REAL `Host`
  and REAL `SessionRegistry`.
- **Counter-arguments considered**:
  1. *Does `MAX_LIVE_ENGINES = 4` contradict a claimed 32?* No — the prompt's
     reconciliation resolves cleanly: they are unrelated constants.
     `MAX_LIVE_ENGINES` (`idleParkDriver.ts:41`) caps **concurrent live engines**
     and is what *causes* parking; `MAX_LIVE_SESSIONS = 32` (`hostApi.ts:245`) is
     what `liveCount()` is compared against. The 4 makes the 32 tombstones *more*
     reachable, not less: with a cap of 4 and a 20-minute TTL, background
     sessions are parked aggressively.
  2. *Does closing recover?* **Yes, and this refutes the report's "Only relaunch
     recovers."** `closeSession` calls `supervisor.killSession`, which
     deregisters. I proved it: after one `closeSession`, the count dropped to 31
     and the very next `createSession` succeeded.
  3. *Can the user unpark their way out?* Partly. `restoreSession` fails (proven),
     but `restartSession` **succeeds** while capped (proven) because it never
     calls `checkSpawnLimits`. However, `tabStatus.ts:98-113` deliberately renders
     a parked tab with `restartable: false`, so the UI does not offer Restart for
     the parked case — the report's "cruel" characterization survives for parks,
     and fails for crashes (a crashed tab does offer Restart, and it works).
  4. *Is the accumulation really about parks?* The precise invariant is broader
     and worse: the supervisor record set is **every session spawned this run
     that has not been `closeSession`d**. Restore does not decrement it (it kills
     the tombstone and immediately re-spawns the same id). Opening the same
     history transcript N times mints N *new* appSessionIds, so browsing history
     is itself an accumulation path.
- **True consequence**: After 32 distinct sessions have been spawned this run and
  not explicitly closed — trivially reachable on an always-on multi-day run, and
  guaranteed by IDLE-PARK — `createSession`, `createSessionInWorkspace` and
  `restoreSession` all fail with `session_limit: at most 32 live sessions`, a
  message that is false (zero engines are alive) and gives no guidance. Recovery
  is closing sessions or relaunching, not relaunch alone.
- **Evidence**: `scratchpad/v08/f-livecount.ts`, REAL `Host` + REAL
  `SessionRegistry` + a supervisor faithful to `supervisor.ts` (kill deregisters,
  exit keeps the record):
  ```
  parked sessions: 32
  supervisor.listSessions().length = 32
  all supervisor records terminal? true
  live engine PROCESSES actually running: 0 (every one self-exited)

  createSession after 32 parks        -> session_limit: at most 32 live sessions
  restoreSession(parked[0])           -> session_limit: at most 32 live sessions
  createSessionInWorkspace            -> session_limit: at most 32 live sessions

  closeSession(parked[2])             -> ok
  supervisor.listSessions().length after close = 31
  createSession after ONE close       -> ok
  restartSession(parked[3]) while capped -> ok
  ```
- **Disposition**: Apply the report's one-line fix
  (`.filter(s => !isTerminalStatus(s.status))`) — I checked it compiles in place
  (`isTerminalStatus` is module-scope at `host.ts:911`) and that it does not
  under-count: `'disconnected'` is *not* terminal, so a session whose socket
  dropped while its child lives still counts, which is correct for a process cap.
  Keep `isLive()` unfiltered, as the report says. Add two things it omits: (1) a
  regression test — `emitPark` × 32 then `createSession` expecting **not**
  `session_limit`, which the suite has no case for; (2) land it **with** A09-F2's
  cap, because adding `checkSpawnLimits()` to `restartSession` on top of the
  broken `liveCount()` would remove the one escape hatch that currently works.

### A09-F2 — [HIGH] `restartSession` bypasses both HC4 caps — unbounded process churn and registry writes

- **Verdict**: CONFIRMED — the same defect as A08-F2, settled together
- **Cited location holds?**: Yes. `host.ts:603-649`; `main.ts:1203-1210`;
  `supervisor.ts:349-359` is `restartSession` = `killSession` + `spawnSession`
  (actual `:366-376`, the closest miss in either report);
  `hostApi.ts:247-254` is the `MAX_SPAWNS_PER_WINDOW` fork-bomb doc.
- **Reachable in production?**: Yes — see A08-F2. Everything in that finding
  applies; I will not repeat the measurement.
- **Trigger**: As A08-F2.
- **Counter-arguments considered**: Beyond A08-F2's list, two specific to this
  report's extra claims:
  1. *Is the registry write really a full-document fsynced rewrite per restart?*
     Yes. `upsertOnSpawn` → `persist()` → `acquireLock` → `atomicWriteJson`
     (`registry.ts:1031-1080`: tmp `openSync` 0o600 → `writeFileSync` → `fsyncSync`
     → `closeSync` → `renameSync` → **directory fsync**). I measured it at the
     sized-for 256 rows: **145 KB file, 0.98 ms median end-to-end per restart**.
     The report's "~98 KB / 0.50 ms" is quoted from `registry.ts:62-71` and it
     says so; my rows were fatter, so the real number is in that neighbourhood
     and if anything higher.
  2. *Is `restartCount` really read by nothing?* Confirmed by grep across `app/`
     and `src/`: written at `registry.ts:686`, seeded at `:703`, validated at
     `:1004`, asserted in tests, mentioned in three comments — **zero**
     behavioural readers. The `src/services/lsp/LSPServerInstance.ts` hits are an
     unrelated symbol.
- **True consequence**: As A08-F2, plus ~145 KB of fully-fsynced disk write and a
  second synchronous transcript-cache write in main (`evictReplay` →
  `persistTranscriptCache`, `main.ts:1731-1736`) per iteration.
- **Evidence**: `scratchpad/v08/f-restart-rate.ts` and
  `scratchpad/v08/f-restart-amplify.ts` (outputs in A08-F2); grep for
  `restartCount`.
- **Disposition**: One fix for both reports — see A08-F2. On the report's second
  suggestion: **do not delete `restartCount` from the schema.** It is the only
  durable evidence of a restart loop and the idle-park comment at
  `idleParkDriver.ts:129` cites a real incident diagnosed from it
  (`restartCount: 3`). Make it a **reader**: gate restart on it (refuse past N
  within a window), which is a circuit breaker the rate cap alone does not give,
  because the rate cap resets every 10 s while a resume-failure loop does not.

### A09-F3 — [MED] `persist()` is a stale-view full-file overwrite — the lock prevents tearing, not lost updates

- **Verdict**: CONFIRMED
- **Cited location holds?**: Yes. `registry.ts:892-932` is `persist()`: sets
  `hostPid`/`updatedAt`, `ensureDir`, `acquireLock`, `atomicWriteJson(this.path, this.doc)`
  — **no re-read, no merge**. `markLiveCleanSync` at `:859-878` calls
  `atomicWriteJson` with no lock at all. `registry.test.ts:950-952` carries the
  "last-writer-wins" comment.
- **Reachable in production?**: The mechanism is unconditional. The concurrency
  trigger is source-established, not observed: `main.ts:190`
  `if (IS_DEV) app.setName('Cat Code Dev')` runs before
  `app.requestSingleInstanceLock()` at `main.ts:1802`, and `defaultRegistryDir()`
  is `${CLAUDE_CONFIG_DIR ?? ~/.cat-code}/desktop` (`registry.ts:213-220`), which
  neither `main.ts` nor `dev.ts` overrides — I re-checked `dev.ts` including its
  uncommitted diff, which adds `CATCODE_INITIAL_CWD` only.
- **Trigger — reproduced.** Two `SessionRegistry` instances over one dir,
  interleaved 25+25 `upsertOnSpawn`.
- **Counter-arguments considered**:
  1. *Does the advisory lock prevent it?* No — proven, not argued.
  2. *Does anything reload from disk before writing?* No; `upsertOnSpawn` mutates
     `this.doc` only, and `this.doc` is set once in `launch()`.
  3. *Is A09's own "the write primitive is genuinely correct" clean bill in
     conflict?* No. That claim is scoped to atomicity, and my run confirms it —
     the surviving document parsed cleanly. A09 reports the lost update itself,
     as this very finding. There is no contradiction to reconcile.
- **True consequence**: Half of two concurrent writers' rows are silently lost,
  including any `shutdown: null` row, which makes that sidecar permanently
  unreachable to every future launch sweep.
- **Evidence**: `scratchpad/v08/f-registry.ts`:
  ```
  F3 lost update:
    rows on disk: 25 (expected 50 if both writers survived)
    of A: 25  of B: 0
    JSON parsed cleanly (atomicity holds): true
  ```
  Independently proven by **V29-F4**, which additionally showed every existing
  assertion still passes with `acquireLock` replaced by a no-op.
- **Disposition**: Apply the read-merge-under-lock fix. Add what neither report
  says: `markLiveCleanSync` (`:859-878`) takes **no lock at all** and runs on the
  quit path, so a merge in `persist()` alone still leaves the highest-stakes
  write (mark-clean-then-kill) able to clobber a concurrent writer. Either give it
  a synchronous lock or accept and document that the quit write is
  last-writer-wins by design. Also take V29's test disposition — assert
  `toHaveLength(50)` and let it fail, rather than leaving a green test whose name
  claims concurrent-writer safety.

### A09-F4 — [MED] A transient read error silently destroys the registry on the next write

- **Verdict**: CONFIRMED
- **Cited location holds?**: Yes, exactly. `registry.ts:456-462` is the
  `readFileSync` catch: `this.log(...)` then `return emptyDoc()` — no
  `moveAside`, unlike the parse-failure (`:466-469`) and unknown-version
  (`:471-474`) branches, both of which do call it. `launch()` at `:434-446`
  performs `await this.persist()` unconditionally at `:443`.
- **Reachable in production?**: Yes. Any `EMFILE`/`EACCES`/`EIO`/NFS blip at
  launch. `readFileSync` is **not** injectable (`RegistryOptions` injects fs
  probes, process probes and the lock, but not the file read), so this branch has
  no test — `registry.test.ts` covers corrupt and unknown-version, not read
  failure.
- **Trigger — reproduced.** Seed 5 valid rows, `chmod 000` the file (a real
  `EACCES` for a non-root reader), construct a fresh registry and `launch()`.
- **Counter-arguments considered**:
  1. *Does `atomicWriteJson` even succeed against an unreadable file?* Yes —
     `renameSync` needs write permission on the **directory**, not the target
     file, so the intact file is replaced. Proven.
  2. *Does `writeFailed` suppress the write?* No. `writeFailed` is only ever
     **set** by a failed write; nothing reads it to suppress a subsequent one.
  3. *Is a corrupt copy preserved?* No — zero `registry.json.corrupt-*` files
     after the run.
- **True consequence**: One unlucky read at launch converts a fully valid
  registry into `{sessions: []}` with no recoverable copy, taking every live
  row's `enginePid`/`socketPath` — so that boot's orphan sweep is gone too.
- **Evidence**: `scratchpad/v08/f-registry.ts`:
  ```
  F4 transient read failure:
    seeded rows: 5  bytes: 1817
    readFileSync throws under chmod 000: true
    rows after ONE unreadable launch: 0
    corrupt-* copies preserved: 0
    log lines: ["[registry] could not read …: EACCES: permission denied…; starting empty"]
  ```
- **Disposition**: Prefer the report's **second** option, not its first.
  `moveAside` on a read failure is wrong: the same `EACCES`/`EMFILE` that blocked
  the read will usually block the `renameSync` too, and on the paths where it
  does not you have renamed a perfectly good file. Set `writeFailed = true` and
  suppress writes for the run (an explicit `readFailed` latch checked at the top
  of `persist()` and `markLiveCleanSync`), which preserves the intact file, keeps
  the session alive on the in-memory doc, and lights up the
  `registry_unavailable` signal A09-F7 says is already wired for exactly this.
  The two findings fix each other.

### A09-F5 — [MED] The restore-time prior-writer guard fails OPEN (kill-polarity predicate reused for a refusal)

- **Verdict**: PARTIALLY CONFIRMED
- **Cited location holds?**: Yes. `registry.ts:420-423` is
  `hasLiveAdvisorySidecar` = `row ? this.matchesSidecarIdentity(row) : false`;
  `:531-543` is `matchesSidecarIdentity`, where **every** uncertainty returns
  `false`. `restoreSession` uses it to refuse at `host.ts:324-329`.
  `sweepOrphans:505-521` and `enforceBound`'s evict-reap `:607-621` are the two
  pid-based kills, and they are the only ones — every other kill goes through an
  owned `ChildProcess` handle.
- **Reachable in production?**: The polarity inversion is real and unconditional.
- **Trigger / counter-arguments — this is where it narrows:**
  1. **(a) EPERM — holds.** `defaultIsProcessAlive` (`:296-306`) returns `false`
     on any throw including EPERM, and `app/scripts/reap-orphan-sidecars.ts:41-50`
     adopts the **opposite** convention for the same question
     (`return (error as NodeJS.ErrnoException).code === 'EPERM'`). Two files in
     one repo answering "is this pid alive" differently is real drift.
  2. **(b) `ps` failure / 2 s timeout — holds.** `defaultProcessCommand`
     (`:309-331`) returns `null` on any throw.
  3. **(c) packaged-binary marker mismatch — INVALID.** The report says a
     packaged build "spawning a compiled binary would never match" the
     `SIDECAR_ENTRY` marker. There is no such branch. `createSupervisor()`
     (`main.ts:639-640`) spawns `process.env.CATCODE_BUN_BIN ?? 'bun'` with
     `sidecarArgs: [...SIDECAR_RUNTIME_ARGS, SIDECAR_ENTRY]`, and `ensureHost()`
     (`main.ts:1708`) passes `sidecarCommandMarker: SIDECAR_ENTRY` — **the same
     constant on both sides**, in dev and packaged alike. The marker cannot
     diverge from the command line without someone editing both.
  4. **The guard's true-positive window is narrower than either side implies.**
     `sweepOrphans` runs at launch with the *same* predicate: any orphan it
     cannot identify it also does not kill, and `hasLiveAdvisorySidecar` will not
     refuse for it either. So the only state where the guard actually fires is a
     prior sidecar that WAS identified and SIGTERMed but has not yet exited —
     which is precisely the graceful-shutdown race it was written for. That is a
     genuine narrowing the report does not make.
  5. **The pid-recycling sub-claim holds and is the sharper half.** Neither
     signal is session-scoped: the marker is identical for every sidecar and a
     SIGKILLed sidecar never runs `cleanup()` (`app/sidecar/index.ts:245-263`),
     so a recycled pid that happens to be *another* live sidecar satisfies both.
     `registry.test.ts:232` covers a non-sidecar impostor, not a sidecar one.
- **True consequence**: In two constructible states — EPERM on the probe, or `ps`
  unavailable/slow — a restore proceeds while a prior writer is genuinely alive,
  and two engine processes resume the same transcript. Narrower than the
  three-way claim, and unreachable via the packaged-binary route.
- **Evidence**: `registry.ts:296-331,420-423,505-521,531-543,607-621`;
  `host.ts:324-329`; `main.ts:639-640,1708`;
  `app/scripts/reap-orphan-sidecars.ts:41-50`.
- **Disposition**: Apply a separate fail-closed predicate for the refusal, as the
  report says, but scope it correctly: refuse when the pid is alive **and**
  identity is either confirmed or **undeterminable**; allow only when the pid is
  provably dead. Do **not** also flip `defaultIsProcessAlive`'s EPERM convention
  — it is deliberately conservative for the kill paths and changing it there
  would make the sweep SIGTERM foreign processes. Instead have the refusal path
  distinguish "probe threw EPERM" from "probe returned ESRCH", which needs the
  probe to return a tri-state rather than a boolean. Drop sub-claim (c) from the
  finding.

### A09-F6 — [MED] Host error messages are rendered verbatim to the user and are debug text

- **Verdict**: CONFIRMED
- **Cited location holds?**: Yes, all eight. `host.ts:311` (`no restorable
  session ${id}`), `:320-322` (`transcript for ${id} is gone`), `:326-327`
  (`prior sidecar for ${id} is still running`), `:349` (`session cwd no longer
  exists: ${row.cwd}`), `:404` (`workspace cwd no longer exists: ${row.cwd}`),
  `:479` (`could not spawn session: ${errText(error)}`), `:718` (`at most 32 live
  sessions`), `:726-728` (`spawn rate cap: 8 per 10000ms`).
  `main.ts:1287-1341` returns `HostResult` straight to the renderer;
  `App.tsx:4705-4707` formats `` `${error.code}: ${error.message}` ``;
  `App.tsx:3170-3172` renders `shellError` as plain text in a danger banner.
- **Reachable in production?**: Yes — six `setShellError(hostErrorMessage(...))`
  call sites, all on ordinary user actions (create, restore, close, open-history).
- **Trigger**: Any of them. `session_limit: at most 32 live sessions` is the one
  A09-F1 makes routine, and it is false when it fires.
- **Counter-arguments considered**: I checked whether the renderer already
  intercepts by code — it does not; `hostErrorMessage` is the whole mapping, and
  it is two lines. I also checked whether `shellError` is truncated or styled
  down — it is `min-w-0 flex-1` text at `text-xs`, i.e. the full string.
- **True consequence**: The user sees `session_not_found: prior sidecar for
  7c1e…-… is still running` (internal vocabulary + raw UUID),
  `session_limit: spawn rate cap: 8 per 10000ms` (a constant printed as copy),
  and `spawn_failed: could not spawn session: socket path too long (105 ≥ 104): …`
  (a raw Node error carrying a filesystem path).
- **Evidence**: line citations above.
- **Disposition**: Apply as written, and treat it as the single fix for A08-F8 as
  well — one `code → copy` map in `hostErrorMessage` covers both reports' string
  lists and removes the `${error.code}:` prefix at the same time. Keep the
  detailed `message` for `this.log`. One addition: `session_limit`'s copy must
  not say "at most 32 live sessions" until A09-F1 lands, because today that
  sentence is a lie; until then it should say what to do ("Close a session to
  open a new one").

### A09-F7 — [MED] `registry_unavailable` is a declared error code no caller can ever observe

- **Verdict**: CONFIRMED
- **Cited location holds?**: Yes. `hostApi.ts:118-128` declares it as the fifth
  `HostErrorCode` with the comment "Registry file unwritable — sessions still
  work, persistence degrades". `host.ts:887-898` is `surfaceRegistryHealth`,
  whose entire body is `this.log(...)`.
- **Reachable in production?**: **No.** `rg 'registry_unavailable' app/` returns
  the union member, `surfaceRegistryHealth`'s log line, four doc comments, and
  one test asserting the **log**. There is no `hostError('registry_unavailable', …)`
  anywhere, so it cannot cross `HostResult`, preload, or the renderer.
- **Trigger**: A read-only or full disk. Every session works; every row is
  silently volatile.
- **Counter-arguments considered**:
  1. *Is it observable some other way — a `HostEvent` variant, a descriptor
     field?* No; I checked both unions.
  2. *Is the two-strikes claim accurate?* Yes.
     `docs/migration/reviews/2026-07-05-p3-lifetime-restore-review.md:148` is
     LR-4, "`registry_unavailable` never reaches any surface", and
     `docs/migration/reviews/2026-07-05-postmortem.md:137` lists LR-4 as
     unresolved. One severity drift worth noting: LR-4 was filed **LOW**; A09
     files it MED.
- **True consequence**: On a degraded disk the user loses their tab set, titles
  and restore offers at the next launch with no signal on any surface, and a
  five-member error vocabulary has one decorative member.
- **Evidence**: `rg` output above; `hostApi.ts:118-128`; `host.ts:887-898`;
  the two prior review files.
- **Disposition**: Surface it rather than delete it — and A09-F4's disposition
  makes that cheap, because a read failure wants the same signal. A `HostEvent`
  variant plus a persistent shell banner is the right shape; the `HostResult`
  route is wrong here because the condition is not per-call. If it is not being
  fixed this cycle, the CLAUDE.md two-strikes rule requires a recorded waive in
  STATUS, not a third silent pass.

### A09-F8 — [LOW] `'parked'` rows are permanently exempt from the row bound

- **Verdict**: CONFIRMED
- **Cited location holds?**: Yes. `registry.ts:586-626` is `enforceBound`, with
  `.filter(r => r.shutdown !== null && r.shutdown !== 'parked')` at `:594` and
  `removeCount = this.doc.sessions.length - MAX_REGISTRY_SESSIONS` at `:596`
  computed over the **total** length.
- **Reachable in production?**: Yes. IDLE-PARK parks at cap 4 / 20-min TTL, and a
  park leaves `'parked'` only via restore, close, or a relaunch (where
  `normalizeShutdown` at `:1008-1016` folds it to `'crashed'`).
- **Trigger — reproduced.** 286 parked rows against a 256 bound.
- **Counter-arguments considered**: Is the growth actually unbounded? Only within
  one run — `normalizeShutdown` makes it self-healing across launches, exactly as
  the report says. The report also correctly enumerates what *is* bounded
  (`spawnTimes` pruned, `resumeFailed`/`closing` per-run, `listeners`
  unsubscribes); I spot-checked all four.
- **True consequence**: The file grows past its documented 256-row cap by the
  parked-row count of one long run. Small in bytes (my 286-row file was 83 KB),
  but `MAX_REGISTRY_SESSIONS`'s own comment reads as a hard cap and is not.
- **Evidence**: `scratchpad/v08/f-registry.ts`:
  ```
  F8 parked rows exempt from the bound:
    rows in memory after 286 parked upserts: 286
    rows on disk: 286  bytes: 82927
    control (clean rows) in memory: 256
  ```
  The clean-row control capping at exactly 256 is what isolates the exemption.
- **Disposition**: Take the report's **second** option (document the exemption in
  the `MAX_REGISTRY_SESSIONS` comment), not the first. Making parked rows
  reapable "once no tab references them" requires the registry to know about
  renderer tab membership, which it deliberately does not — that is a layering
  violation for a bound that self-heals every launch.

### A09-F9 — [LOW] Nothing ever prunes `registry.json.corrupt-*` or leaked `.tmp` files

- **Verdict**: CONFIRMED
- **Cited location holds?**: Yes. `corruptName` at `registry.ts:337-340`;
  the tmp name at `:1033`
  (`.${basename(filePath)}.${process.pid}.${Date.now()}.tmp`).
- **Reachable in production?**: Yes. `rg` over `app/host` and `app/main` finds no
  enumeration or `unlink` of either pattern; `atomicWriteJson`'s `unlinkSync`
  runs only in the caught-throw branch, never on process death between `openSync`
  and `renameSync`.
- **Trigger**: One corrupt launch, or one hard kill mid-write.
- **Counter-arguments considered**: Does the transcript-cache GC sweep the same
  directory? It sweeps `TRANSCRIPT_CACHE_DIR`, not the registry dir; and
  `readSessionsCatalogCache(defaultRegistryDir())` reads one named file, so the
  litter is not actively harmful — only accumulating.
- **True consequence**: Small permanent litter in a directory the app scans.
- **Evidence**: `registry.ts:337-340,1031-1080`; grep.
- **Disposition**: Apply, with a guard the report does not mention: a `.tmp`
  sweep at `launch()` must only delete files whose embedded pid is **not alive**,
  or a concurrent writer's in-flight temp file gets deleted out from under it —
  which given A09-F3's dev-vs-packaged trigger is a real possibility.

### A09-F10 — [LOW] `ShutdownState` is a closed union with no exhaustiveness tripwire

- **Verdict**: CONFIRMED
- **Cited location holds?**: Yes. `registry.ts:85` is
  `export type ShutdownState = 'clean' | 'crashed' | 'parked' | null`.
  `normalizeShutdown` (`:1008-1016`) is an if-chain ending `return null`;
  `enforceBound` (`:594`) is a `.filter`; `descriptorFromRow`
  (`host.ts:791-795`) is a ternary ending `: 'exited'`. `mapStatus`
  (`host.ts:916-929`) **is** protected — a `switch` whose declared return type
  plus `strictNullChecks` makes a missing case an error — so the file does know
  the idiom.
- **Reachable in production?**: N/A (compile-time).
- **Trigger**: Adding a fifth state compiles clean and behaves as `'exited'` in
  the descriptor and as reapable in the bound.
- **Counter-arguments considered**: Would `strict: true` (which `app/tsconfig.json`
  sets) catch it via the `null` member? No — the fallbacks are total, so nothing
  is unassigned.
- **True consequence**: A silent wrong default on the next state added.
- **Evidence**: line citations above.
- **Disposition**: Apply. `normalizeShutdown` is the important one — it is the
  disk-read boundary, so a new state that survives to disk and normalizes to
  `null` would resurrect a dead row as live.

### A09-F11 — [LOW] The launch sweep runs a synchronous `ps` per live row on the Electron main thread before the window loads

- **Verdict**: CONFIRMED
- **Cited location holds?**: Yes. `launch()` (`registry.ts:434-446`) runs
  `readOrRecover`, `sweepOrphans` and `reap` synchronously before its first
  `await` (`await this.persist()` at `:443`). `defaultProcessCommand`
  (`:309-331`) is `execFileSync('ps', …, { timeout: 2000 })`.
- **Reachable in production?**: Yes, and the ordering is worse than "before the
  window loads": `app.whenReady()` calls `ensureHost()` at `main.ts:1823` —
  which constructs the registry and calls `registry.launch()` — **before**
  `createWindow()` at `:1827`. So the synchronous prefix runs before the window
  is even constructed.
- **Trigger**: A hard crash that left many rows `shutdown: null`, then a relaunch.
- **Counter-arguments considered**: The `ps` only runs when the pid is alive
  **and** the socket file still exists (`matchesSidecarIdentity` short-circuits
  in that order), so the row count that pays it is the surviving-orphan count,
  not the row count. That bounds it well below 256 in practice; the worst case
  the report states (2 s × row count) needs many alive-pid rows.
- **True consequence**: Startup blocks for the sum of the surviving orphans' `ps`
  calls, worst-cased by the 2 s timeout each.
- **Evidence**: `registry.ts:434-446,505-521,531-543,309-331`; `main.ts:1823,1827`.
- **Disposition**: Apply the batched `ps -axo pid=,command=` fix — the shape
  already exists at `app/scripts/reap-orphan-sidecars.ts:56`, so this is reuse,
  not invention, and it turns N calls into one. Do **not** make the sweep async:
  `launch()` is the B4 gate every host op awaits precisely so no spawn interleaves
  with the read-modify-write, and loosening that reopens a race the design closed.

### A09-F12 — [LOW] `defaultTranscriptPath`'s long-path fallback does an uncached `readdirSync` on the descriptor hot path

- **Verdict**: CONFIRMED
- **Cited location holds?**: Yes. `registry.ts:275-287` is the fallback:
  `if (sanitized.length > MAX_SANITIZED_LENGTH)` then
  `for (const dir of readdirSync(projectsDir))`. `MAX_SANITIZED_LENGTH = 200`
  (`:223`).
- **Reachable in production?**: Yes on the stated chain — `hasTranscript`
  (`:409-413`) → `canResume` (`host.ts:857-860`) → `isRestorable` (`:838-842`) →
  `descriptorFromRow`, i.e. once per row per `listSessions()` and once per
  `emitStatus`; and `idleParkDriver` calls `listSessions()` on **every** host
  event (`main.ts:571`).
- **Trigger**: A workspace whose non-alphanumeric-sanitized cwd exceeds 200
  characters **and** whose exact transcript path does not exist — which every
  never-typed-in session satisfies (the CC-12 class the code itself documents at
  `host.ts:826-834`).
- **Counter-arguments considered**: How narrow is 200 sanitized chars? Every
  character is counted after `replace(/[^a-zA-Z0-9]/g, '-')`, so it is the raw
  path length — a nested monorepo path under a long home directory reaches it,
  but a typical `~/projects/foo` does not. The trigger is real but not common,
  which matches the LOW filing.
- **True consequence**: One full `projects` directory enumeration per status emit
  for an affected row.
- **Evidence**: `registry.ts:223,261-289,409-413`; `host.ts:826-860`; `main.ts:571`.
- **Disposition**: Apply the memoization. Scope it to the *negative* result too —
  the expensive case is the scan that finds nothing, and memoizing only hits
  leaves the hot path unchanged for exactly the CC-12 rows that trigger it.

### A09-F13 — [LOW] A malformed row is dropped with no log, unlike every other reap

- **Verdict**: CONFIRMED
- **Cited location holds?**: Yes. `registry.ts:958-962` is
  `for (const candidate of parsed.sessions) { const row = validateRow(candidate); if (row) sessions.push(row) }`
  — no else, no log. `validateRow` is at `:972-1006`.
- **Reachable in production?**: Yes, on every launch read.
- **Trigger — reproduced.** A hand-written registry with one valid row and one
  missing `cwd`.
- **Counter-arguments considered**: Does the caller log a count? No —
  `readOrRecover` logs only on read failure, parse failure and unknown version.
  Both reap paths (`sweepOrphans`, `enforceBound`) and every unknown-id write
  point do log, so the asymmetry the report names is real.
- **True consequence**: A row that lost a field vanishes with its `enginePid`, so
  its sidecar becomes an unreachable orphan, with no trace of why.
- **Evidence**: `scratchpad/v08/f-registry.ts`:
  ```
  F13 malformed row dropped silently:
    rows surviving: 1 (1 = the cwd-less row was dropped)
    log lines produced: []
  ```
- **Disposition**: Apply. `validateDocument` is a module-level function with no
  `this.log`, so the count has to be returned to `readOrRecover` (or the function
  given a log parameter) — a small signature change the report does not mention
  but which is where the work actually is.

### A09-F14 — [LOW] `errText` and `isUuid`/`UUID_RE` are copy-pasted across the app planes

- **Verdict**: CONFIRMED
- **Cited location holds?**: The counts are right; the location list is mixed and
  incomplete. `errText` exists **exactly four times**, identical:
  `main.ts:1793`, `host.ts:936`, `registry.ts:1133`,
  `app/scripts/reap-orphan-sidecars.ts:129`. The UUID regex exists **exactly five
  times**: `host.ts:90`, `main/transcriptCache.ts:105`, `main/devHarness.ts:193`,
  `main/openHistorySession.ts:52`, `shared/transcriptBackfill.ts:33` — one of them
  already in `app/shared/`, as claimed. The report's `Where` list interleaves both
  symbols without separating them and **omits `openHistorySession.ts:52`**, one of
  the five it counts; `devHarness.ts:192` and `transcriptBackfill.ts:32` are each
  off by one.
- **Reachable in production?**: N/A (duplication).
- **Trigger**: n/a.
- **Counter-arguments considered**: Is "`isUuid` is the only runtime enforcement
  of session-id shape in the whole app" true? Yes, and A08-F1 is the direct
  consequence: `main.ts` has **no** UUID check at all, so the entire frame plane
  is outside that enforcement.
- **True consequence**: The one runtime session-id shape check lives in five
  unsynchronized copies, and the plane that most needs it has none.
- **Evidence**: `rg` output for both symbols.
- **Disposition**: Apply — one `isSessionId` beside `SessionId` in
  `app/shared/protocol.ts` and one `errText` in a shared util. Sequence it
  **before** A08-F1's fix so that fix imports the shared predicate rather than
  minting a sixth copy in `main.ts`.

### A09-F15 — [LOW] Two injected callbacks are treated as infallible in paths that must not abort

- **Verdict**: CONFIRMED (latent)
- **Cited location holds?**: Yes. `shutdownAll` (`host.ts:661-668`) is
  `markLiveCleanSync()` → `for (…) this.evictReplay(id)` → `supervisor.shutdown()`,
  so a throw from any callback skips the kill loop. `closeSession`
  (`host.ts:515-525`) does `closing.add` → `killSession` → `evictReplay` →
  `await markClean` → `closing.delete`, with no `finally`.
- **Reachable in production?**: The control-flow gap is unconditional; the
  **throw** is not reachable today. `main.ts:1731-1736` injects
  `evictReplay: id => { persistTranscriptCache(id); cancelReplayFlush(id); attachmentGate.clearSession(id) }`
  and `persistTranscriptCache` wraps its whole body in try/catch. So it is
  latent, exactly as the report says.
- **Trigger**: Any future `evictReplay` injection that can throw.
- **Counter-arguments considered**: Does the `closing` leak actually matter? Yes —
  `onSupervisorEvent` gates crash-marking on `!this.closing.has(id)`
  (`host.ts:206`), so a stuck id means every subsequent exit for that session is
  suppressed and a later crash is never marked `crashed`. That is the mechanism
  the report claims, verified.
- **True consequence**: Latent. If it fires, `shutdownAll`'s failure mode is
  sidecars outliving the window — the die-with-window guarantee itself.
- **Evidence**: `host.ts:206,515-525,661-668`; `main.ts:1731-1736`.
- **Disposition**: Apply — try/catch around each `evictReplay` and
  `closing.delete` in a `finally`. Add the missing half: state the "must not
  throw" contract on the `HostOptions.evictReplay` type, which is what makes the
  guarantee survive the next injection site.

## Findings the original reports missed

### [HIGH] The fabricated-id flood turns the next renderer reload into a single multi-hundred-megabyte IPC message

Same root as A08-F1, but a second-order amplification neither report names, and
it is worse than the steady-state leak. `AttachmentGate.onRendererReady()` returns
`this.buffer.snapshot()`, which concatenates **every** session's frames
(`replayBuffer.ts:221-227`), and `main.ts:1216` hands that whole array to
`deliver` → one `contents.send(CH_SERVER_FRAME, frames)`. A fabricated-id flood
therefore does not only grow main's heap: it arms a single structured-clone of
the entire accumulated buffer, sent on the next reload (`onNavigationStart` →
`onRendererReady`, i.e. ⌘R or any dev HMR full reload).

Measured with the real modules (`scratchpad/v08/f-replaybuffer.ts`), after only
1,000 fabricated ids — **eight seconds** at the preload ceiling:

```
after navigation re-arm, replay frame count: 1000
replay payload bytes on reload: 229.0 MiB
```

229 MiB in one `webContents.send` — and the buffer keeps growing at ~24 MiB/s
until the window is closed, so a minute of flooding arms a ~1.4 GB message. The
`isUuid` guard in `forward` (A08-F1's disposition) closes this too; I flag it
because it changes the severity argument from "main's heap grows" to "the next
reload is an unrecoverable IPC event", and because it means the fix cannot be
deferred on the grounds that the user would notice memory growth first.

### [MED] `markLiveCleanSync` takes no lock, so A09-F3's fix does not cover the quit path

A09-F3 correctly identifies that `persist()` never re-reads under the lock, and
proposes read-merge-under-lock there. But `markLiveCleanSync` (`registry.ts:859-878`)
calls `atomicWriteJson` **directly**, with no `acquireLock` and no merge — it is
the mark-clean-then-kill write on `window-all-closed`/`before-quit`/SIGTERM,
i.e. the write whose loss produces the exact "every session reported crashed on
next launch" symptom `teardownOnSignal`'s own comment says must not happen. Its
doc-comment justifies being synchronous (the process may exit before an async
persist settles) but says nothing about the lock. Fixing only `persist()` leaves
the highest-stakes write last-writer-wins. Either give it `lockSync`-style
handling or record the exemption explicitly.

### Corrections to the two "What is good here" sections

Both clean bills are largely accurate; I re-derived every claim rather than
accepting them.

**A08 — all five hold.** `webPreferences` really does check every box
(`main.ts:755-765`: `sandbox`, `contextIsolation`, `nodeIntegration:false`,
`nodeIntegrationInWorker:false`, `nodeIntegrationInSubFrames:false`,
`webviewTag:false`, `webSecurity:true`). The CSP really is two layers (the
`onHeadersReceived` header at `main.ts:695-720` plus the `http-equiv` meta at
`app/renderer/index.html:12`). `isAppOrigin`'s opaque-origin handling is exactly
as described and its named regression test is at `navigationPolicy.test.ts:53-63`
(report said `:54-63`). The HC1 token pair is real: `CH_HOST_PICK_DIR` returns
`cwdTokens.mint(realpath)` and never a path, `CH_HOST_CREATE` consumes the token,
and `SaveTextInput` has no path field. `FRAME_RETENTION` really is a
`Record<ServerFrame['kind'], FrameRetention>` (`replayBuffer.ts:101`).
`mainSourceGuards.test.ts`'s header states the ~40-assertion deletion and the
grep-honesty rationale verbatim (`:1-26`).

**A09 — four hold, one is imprecise.**
- *Write primitive*: confirmed line by line — tmp `openSync(…, 0o600)` →
  `writeFileSync` → `fsyncSync` → `closeSync` → `renameSync` → **directory
  fsync**, with fd cleanup in both the catch and the finally
  (`registry.ts:1031-1080`). My F3 repro independently confirms the atomicity
  half under real concurrency.
- *Two-id model*: confirmed at every crossing the report names —
  `fillEngineSessionId(event.sessionId, event.frame.engineSessionId)`
  (`host.ts:176-179`), `restoreSession` passing `row.engineSessionId` as
  `resumeEngineSessionId` (`:368`) and never as a lookup key, `upsertOnSpawn`
  seeding `engineSessionId` only on the new-row branch (`registry.ts:697-706`).
  I found no cross-used id either.
- *Error unions*: the substance holds — **zero** `ErrorFrame` references anywhere
  in `app/host/`, and `SaveTextErrorCode` is genuinely a third union
  (`hostApi.ts:157`). But the stated evidence is wrong: `host.ts` does **not**
  import "only from `../shared/hostApi.js` plus `type SessionId`" — it also
  imports `PARKED_EXIT_CODE, RESUME_FAILED_EXIT_CODE` from `../shared/limits.js`
  (`host.ts:34`), plus registry and supervisor types. The conclusion survives the
  wrong premise.
- *Shutdown state machine*: confirmed — `markCrashed`/`markParked` guard on
  `shutdown === null`, `upsertOnSpawn` is the only edge back to `null`,
  `normalizeShutdown` folds `'parked'` to `'crashed'` on disk read, and
  `markClean` is deliberately unguarded.
- *Dependency injection*: confirmed, with one gap worth naming — `readFileSync`
  in `readOrRecover` is **not** injectable, which is precisely why A09-F4's
  branch has no test.
