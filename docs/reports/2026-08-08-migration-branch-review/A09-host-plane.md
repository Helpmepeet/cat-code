# A09 — host plane (registry, host API)

## Verdict

This is the most carefully-reasoned code I have read in `app/`: the write path is a
real atomic-rename + fsync + advisory-lock implementation, the launch sequence is
ordered correctly, the two-id model is never conflated anywhere in scope, and the
control-plane error union is genuinely kept apart from the transport union. The
comments are load-bearing rather than decorative. Two defects nonetheless matter a
lot: `Host.liveCount()` counts *dead* supervisor tombstones against
`MAX_LIVE_SESSIONS`, so ~32 parks or crashes in one run permanently lock the app out
of creating **or restoring** any session until relaunch; and `restartSession` is the
one process-minting path that skips both HC4 caps entirely, which is both a fork-bomb
hole and the write-amplification path onto the registry file. The single most
important thing to fix is `liveCount()` — it is a one-line filter and it silently
disarms IDLE-PARK's whole benefit.

## Findings

### [HIGH] `liveCount()` counts dead tombstones, so the concurrency cap traps the app
- **Where**: `app/host/host.ts:739-741` (`liveCount`), consumed at `:717`
- **Type**: correctness
- **What**: `liveCount()` is `this.supervisor.listSessions().length`. The supervisor
  deregisters a record **only** in `killSession` — `child.on('exit')` keeps the
  record and merely sets `status: 'exited'` (`app/supervisor/supervisor.ts:296-306`),
  which `host.ts:907-913` itself documents as a tombstone. So every session that
  parked, crashed, or spawn-failed and was never restored still counts as a live
  engine process against `MAX_LIVE_SESSIONS = 32`.
- **Trigger / why it matters**: IDLE-PARK guarantees the accumulation. `MAX_LIVE_ENGINES = 4`
  (`app/main/idleParkDriver.ts`) parks background engines; each park is a
  `PARKED_EXIT_CODE` self-exit, i.e. a child exit with no `killSession`, i.e. a
  permanent tombstone for the rest of the run. After 32 distinct sessions have parked
  or crashed without being reopened — trivially reachable on the stated always-on,
  multi-day run — `checkSpawnLimits()` returns `session_limit` for `createSession`,
  `createSessionInWorkspace` **and** `restoreSession`, even with zero engine
  processes alive. `restoreSession` is the cruel one: its `checkSpawnLimits()` call
  (`:352`) runs *before* the `killSession` that would clear the tombstone (`:360`),
  so the user cannot even unpark their way out. The user-facing error reads
  "at most 32 live sessions", which is false. Only relaunch recovers. The reverse of
  the intended design: IDLE-PARK exists to free resources and instead consumes the
  concurrency budget permanently.
- **Fix**: `return this.supervisor.listSessions().filter(s => !isTerminalStatus(s.status)).length`.
  `isTerminalStatus` already exists at `:911`. Leave `isLive()` alone — restart-in-place
  deliberately wants tombstones to read as live.

### [HIGH] `restartSession` bypasses both HC4 caps — unbounded process churn and registry writes
- **Where**: `app/host/host.ts:603-649`; driven from `app/main/main.ts:1203-1210`
- **Type**: security
- **What**: Every other spawn path calls `checkSpawnLimits()` and every spawn records
  a timestamp via `recordSpawnTime()` inside `spawn()` (`:433`). `restartSession`
  calls neither. It goes straight to `supervisor.restartSession` (= `killSession` +
  `spawnSession`, `supervisor.ts:349-359`) and then `registry.upsertOnSpawn`.
- **Trigger / why it matters**: `CH_RESTART` is a fire-and-forget `ipcMain.on` channel
  with no throttle, whose only validation is `typeof arg?.sessionId === 'string'`
  (`main.ts:1203`). A renderer loop calling `bridge.restart(id)` therefore mints Bun
  engine processes at whatever rate it likes. The kill is an async SIGTERM while the
  spawn is immediate, so the in-flight process count is bounded only by boot latency,
  not by anything the host enforces — this is exactly the fork bomb
  `MAX_SPAWNS_PER_WINDOW` documents itself as preventing
  (`app/shared/hostApi.ts:247-254`), and restarts do not even consume that budget, so
  they are invisible to the create-side cap as well. **Registry side, confirmed:**
  each restart is one `upsertOnSpawn` → `persist()` → lockfile mkdir + full-document
  `JSON.stringify` + tmp `openSync`/`writeFileSync`/`fsyncSync`/`closeSync` +
  `renameSync` + directory `fsync` + unlock. At the sized-for 256 rows that is a
  ~98 KB fully-fsynced rewrite per restart (registry.ts:62-71 quotes 0.50 ms/persist),
  plus `evictReplay` → `persistTranscriptCache` (a second synchronous disk write in
  main). Also confirmed: `restartCount` is written at `registry.ts:686` and read by
  **nothing** — grep across the repo finds only writes, tests asserting the write, and
  doc prose. There is no circuit breaker.
- **Fix**: call `this.checkSpawnLimits()` at the top of `restartSession` and
  `this.recordSpawnTime()` before `supervisor.restartSession`, so restart shares the
  one rate window with create/restore. Separately, `restartCount` should either gate
  restart (refuse past N within a window) or be deleted from the schema.

### [MED] `persist()` is a stale-view full-file overwrite — the lock prevents tearing, not lost updates
- **Where**: `app/host/registry.ts:892-932`, and `markLiveCleanSync` at `:859-878`
- **Type**: correctness
- **What**: `persist()` acquires the advisory lock and then writes `this.doc` — the
  whole document, from an in-memory snapshot read once at `launch()`. It never
  re-reads the file under the lock and never merges. `markLiveCleanSync` skips the
  lock entirely by design. The module header claims this is "the DR-2 lesson applied
  to our own new shared file"; only the atomicity half of that lesson is present. The
  repo's own test acknowledges the gap in a comment — "any reader between writes sees
  a consistent snapshot, **last-writer-wins**" (`registry.test.ts:950-952`) — and
  asserts only that the JSON is not torn, never that both writers' rows survive.
- **Trigger / why it matters**: the design rests entirely on `app.requestSingleInstanceLock()`
  (`main.ts:1802`), and that lock is keyed on Electron's userData path, which is
  derived from the app name — `main.ts:190` does `if (IS_DEV) app.setName('Cat Code Dev')`
  *before* the lock is taken. So a dev app and a packaged app hold **different**
  single-instance locks while `defaultRegistryDir()` resolves to the same
  `~/.cat-code/desktop/registry.json` for both (no `CLAUDE_CONFIG_DIR` override in
  `app/scripts/dev.ts`). Both then run the launch read-modify-write and every
  subsequent full-file overwrite against one file. The cost is not only "the
  workspace forgets its tabs" (A2's stated acceptable loss): an overwrite that drops
  the *other* process's `shutdown: null` rows makes those sidecars permanently
  unreachable — no future launch sweep can see a pid whose row no longer exists, which
  is precisely the leak `enforceBound`'s evict-reap was added to prevent
  (registry.ts:599-606).
- **Fix**: inside `persist()`, under the held lock, re-read + `validateDocument` the
  file and merge by `appSessionId` (this process's rows win for ids it owns; unknown
  ids are carried through) before `atomicWriteJson`. That is a contained change — the
  read/validate helpers already exist. At minimum, add a test asserting two registries
  over one file both retain their rows, which today fails.

### [MED] A transient read error silently destroys the registry on the next write
- **Where**: `app/host/registry.ts:456-462`
- **Type**: correctness
- **What**: `readOrRecover` handles a `readFileSync` failure by logging and returning
  `emptyDoc()`. Unlike the parse-failure and unknown-version branches, it does **not**
  move the file aside. The very next `persist()` — which the launch sequence itself
  performs unconditionally at `:443` — overwrites the intact file with `{sessions: []}`.
- **Trigger / why it matters**: any transient `EMFILE` / `EACCES` / `EIO` / NFS blip at
  launch. One unlucky read converts a fully valid registry into an empty one, with no
  recoverable copy, and takes every live row's `enginePid`/`socketPath` with it — so
  the orphan sweep for that boot is also gone. The parse-failure path deliberately
  preserves evidence; this one deliberately does not, and nothing in the code or tests
  distinguishes "corrupt" from "momentarily unreadable". There is no test for this
  branch (see `registry.test.ts` — corrupt and unknown-version are both covered, read
  failure is not).
- **Fix**: route the read failure through `this.moveAside(...)` like the other two, or
  set `writeFailed = true` and suppress writes for the run so the intact file survives.

### [MED] The restore-time prior-writer guard fails OPEN (kill-polarity predicate reused for a refusal)
- **Where**: `app/host/registry.ts:420-423` (`hasLiveAdvisorySidecar`) reusing
  `:531-543` (`matchesSidecarIdentity`)
- **Type**: correctness
- **What**: the characterization in your prompt is accurate as far as it goes —
  `matchesSidecarIdentity` requires a recorded pid, `isProcessAlive(pid)`, the recorded
  `socketPath` to still exist on disk, an injected `sidecarCommandMarker`, and the
  process cmdline to contain it. Every uncertainty returns `false`. That is the right
  polarity for a **kill** (`sweepOrphans:505-521`, `enforceBound`'s evict-reap
  `:607-621`), and those two are the only pid-based kills in the host plane — every
  other kill goes through an owned `ChildProcess` handle, so the "every kill path uses
  it" half of the claim holds. But the *same* predicate backs `hasLiveAdvisorySidecar`,
  which `restoreSession:324-329` uses to **refuse** a restore, and there the safe
  direction is inverted: unsure must mean *refuse*, and this returns `false` = proceed.
- **Trigger / why it matters**: three concrete ways the guard silently never fires
  while a prior writer is genuinely alive — (a) `defaultIsProcessAlive` returns `false`
  on EPERM (`:296-306`, and note `app/scripts/reap-orphan-sidecars.ts:47` adopts the
  *opposite* EPERM convention for the same question); (b) `defaultProcessCommand` returns
  `null` on any `ps` failure or its 2 s timeout; (c) the marker is `SIDECAR_ENTRY`, a
  dev `.ts` path (`main.ts:605,1708`) — a packaged build spawning a compiled binary
  would never match it, and the module doc only reasons about that degrading the
  *sweep* to kill-nothing. In any of those cases `restoreSession` proceeds and a second
  engine process resumes the same transcript while the first is still writing it.
  Secondary, narrower gap: neither identity signal is session-scoped. The marker is
  identical for every sidecar and the socket-file check only proves the file was not
  cleaned up (a SIGKILLed sidecar never runs its `cleanup()`,
  `app/sidecar/index.ts:245-263`), so a recycled pid that happens to be *another*
  session's live sidecar satisfies both signals. `registry.test.ts:232` covers a
  non-sidecar impostor; it does not cover a sidecar impostor.
- **Fix**: give the refusal its own predicate that fails closed — refuse when the pid
  is alive *or* when identity cannot be determined (no marker / `ps` unavailable), and
  only allow the restore when the pid is provably dead.

### [MED] Host error messages are rendered verbatim to the user and are debug text
- **Where**: `app/host/host.ts:326`, `:311-313`, `:320-322`, `:479`, `:718`, `:726-728`,
  `:349`, `:404`
- **Type**: convention
- **What**: `HostError.message` is authored here as engineer-facing text, crosses IPC
  as-is (`main.ts:1287-1341` return `HostResult` straight to the renderer), and is
  rendered by `hostErrorMessage` as `` `${error.code}: ${error.message}` ``
  (`App.tsx:4705-4707`) into `setShellError`, which is displayed as plain text at
  `App.tsx:3170-3172`.
- **Trigger / why it matters**: the strings the user actually sees include
  `session_not_found: prior sidecar for 7c1e…-… is still running` (**"sidecar"** is on
  the named-internal-vocabulary list, plus a raw session UUID),
  `session_limit: spawn rate cap: 8 per 10000ms` (a constant's semantics printed as
  copy), `spawn_failed: could not spawn session: socket path too long (105 ≥ 104): …`
  (a raw Node error carrying a filesystem path and the internal option name
  `socketDir`), and `session_not_found: transcript for <uuid> is gone`. The
  convention also asks that copy tell the user what to DO; none of these do.
- **Fix**: keep these messages for the log, and map `error.code` → human copy in the
  renderer (five codes). No host change needed beyond accepting that `message` is a
  diagnostic field, which is what the type comment already claims it is.

### [MED] `registry_unavailable` is a declared error code no caller can ever observe
- **Where**: `app/shared/hostApi.ts:118-128`; `app/host/host.ts:887-898`
  (`surfaceRegistryHealth`)
- **Type**: dead-code
- **What**: `registry_unavailable` is documented in three places as the non-fatal
  degraded-persistence signal, `SessionRegistry.lastWriteFailed` exists solely to feed
  it, and `surfaceRegistryHealth` is called at every write point — but it only writes
  to stderr. No host method ever returns it, so it is unreachable through `HostResult`,
  through preload, and through the renderer.
- **Trigger / why it matters**: on a read-only or full disk, every session works and
  every row is silently volatile: the user's tab set, titles, and restore offers will
  all be gone at next launch, with no signal anywhere they can see. `HostErrorCode` is
  a five-member vocabulary a caller pattern-matches; one member being decorative
  weakens the contract. This is the second review to flag it — `reviews/2026-07-05-p3-lifetime-restore-review.md`
  LR-4 named it, and `reviews/2026-07-05-postmortem.md:137` lists it as unresolved.
  The repo's two-strikes rule applies: it needs an owner or a recorded waive.
- **Fix**: either surface it (a `HostEvent` variant or a health field on the
  descriptor) and give the shell a persistent banner, or delete the code from
  `HostErrorCode` and keep `lastWriteFailed` as a log-only diagnostic. Do not leave it
  in the union unreachable a third time.

### [LOW] `'parked'` rows are permanently exempt from the row bound — the one in-run growth path
- **Where**: `app/host/registry.ts:586-626` (`enforceBound`, `.filter(r => r.shutdown !== null && r.shutdown !== 'parked')`)
- **Type**: correctness
- **What**: you asked to name the growth path and what bounds it. Rows are bounded at
  `MAX_REGISTRY_SESSIONS = 256` **except** live rows (bounded at 32 by `MAX_LIVE_SESSIONS`)
  and parked rows (bounded by nothing within a run). `removeCount` is computed from
  total length but only non-parked terminal rows are eligible, so once parked rows
  outnumber the reapable surplus the file grows past 256 unchecked. Everything else is
  bounded: `spawnTimes` is pruned, `resumeFailed`/`closing` are per-run and per-session,
  `listeners` unsubscribes.
- **Trigger / why it matters**: IDLE-PARK parks aggressively (cap 4, 20 min TTL), and a
  park has no timeout back to a terminal state — the row leaves `'parked'` only via
  restore, close, or a relaunch (where `normalizeShutdown` folds it to `'crashed'`).
  Self-healing across launches, so the ceiling is one long run's park count, but the
  bound is real and undocumented in the constant's own comment.
- **Fix**: make parked rows reapable once no tab references them, or state the exemption
  in the `MAX_REGISTRY_SESSIONS` doc so the next reader does not read 256 as a hard cap.

### [LOW] Nothing ever prunes `registry.json.corrupt-*` or leaked `.tmp` files
- **Where**: `app/host/registry.ts:338-340` (`corruptName`), `:1031-1033` (`atomicWriteJson` tmp name)
- **Type**: correctness
- **What**: each corrupt launch leaves `registry.json.corrupt-<ts>` in
  `<config-home>/desktop` forever, and a hard kill between `openSync` and `renameSync`
  leaves `.registry.json.<pid>.<ts>.tmp` behind (the `unlinkSync` cleanup only runs on a
  caught throw, not on process death). Neither is ever enumerated or removed.
- **Trigger / why it matters**: small in bytes, but the same directory is read by
  `readSessionsCatalogCache(defaultRegistryDir())` (`main.ts:1348-1358`) and by the
  transcript-cache GC, so it accumulates litter in a directory the app scans.
- **Fix**: keep the newest N corrupt copies and delete stale `.tmp` files during
  `launch()`, where the directory is already being touched.

### [LOW] `ShutdownState` is a closed union with no exhaustiveness tripwire
- **Where**: `app/host/registry.ts:85`; consumers at `:1008-1016` (`normalizeShutdown`),
  `:594` (`enforceBound`), `app/host/host.ts:793-795` (`descriptorFromRow`)
- **Type**: convention
- **What**: all three consumers are if-chains/ternaries with a catch-all fallback. Adding
  a fifth state compiles clean and silently behaves as `'exited'` in the descriptor and
  as reapable in the bound. (`mapStatus` at `host.ts:916-929` *is* protected — the
  declared return type plus `strictNullChecks` makes a missing case an error — so the
  file knows how to do this.)
- **Fix**: switch on `row.shutdown` in `descriptorFromRow` and `normalizeShutdown` with a
  `default` assigning to `never`.

### [LOW] The launch sweep runs a synchronous `ps` per live row on the Electron main thread before the window loads
- **Where**: `app/host/registry.ts:434-446` (`launch`), `:309-331` (`defaultProcessCommand`)
- **Type**: correctness
- **What**: `readOrRecover`, `sweepOrphans`, and `reap` all run synchronously before
  `launch()`'s first `await`. For each row still marked live whose pid is alive and whose
  socket file exists, `matchesSidecarIdentity` calls `execFileSync('ps', …, { timeout: 2000 })`.
  `reap` additionally does one `existsSync` per row (up to 256).
- **Trigger / why it matters**: after a hard crash that left many rows `shutdown: null`,
  startup blocks the main thread for the sum of those `ps` calls before `createWindow()`;
  the worst case is bounded only by the 2 s timeout times the row count.
- **Fix**: batch the identity probe into a single `ps -axo pid=,command=` call (the shape
  `app/scripts/reap-orphan-sidecars.ts:56` already uses), or make the sweep async.

### [LOW] `defaultTranscriptPath`'s long-path fallback does an uncached `readdirSync` on the descriptor hot path
- **Where**: `app/host/registry.ts:275-287`
- **Type**: correctness
- **What**: when the sanitized cwd exceeds 200 chars and the exact transcript is absent,
  the function scans the entire `projects` directory. It is reached from `hasTranscript`
  → `canResume` → `isRestorable` → every `descriptorFromRow`, i.e. once per row per
  `listSessions()` and once per `emitStatus`. `idleParkDriver.evaluate` calls
  `listSessions()` on every host event.
- **Trigger / why it matters**: one deep-path workspace whose transcript does not exist
  (every never-typed-in session qualifies — that is the CC-12 class) turns each status
  emit into a full directory enumeration. The CC-12 perf measurement (0.138 ms / 256
  rows) was taken on the exact-path branch and does not cover this one.
- **Fix**: memoize the prefix→project-dir resolution per `cwd` for the process lifetime;
  the mapping cannot change while the app runs.

### [LOW] A malformed row is dropped with no log, unlike every other reap
- **Where**: `app/host/registry.ts:958-962`, `:972-1006` (`validateRow`)
- **Type**: quality
- **What**: `validateDocument` silently skips any row `validateRow` rejects. Both reap
  paths and every unknown-id write point log; this one does not.
- **Trigger / why it matters**: a row that lost its `cwd` or `appSessionId` vanishes with
  its `enginePid`, so its sidecar becomes an unreachable orphan and there is no trace of
  why. Defensive rebuilding is right; being silent about it is not.
- **Fix**: `this.log` the dropped-row count and the offending `appSessionId` when present.

### [LOW] `errText` and `isUuid`/`UUID_RE` are copy-pasted across the app planes
- **Where**: `app/host/host.ts:89-94,936-938`; `app/host/registry.ts:1133-1135`;
  also `app/main/main.ts:1793`, `app/main/transcriptCache.ts:104-108`,
  `app/main/devHarness.ts:192`, `app/shared/transcriptBackfill.ts:32,626`,
  `app/scripts/reap-orphan-sidecars.ts:129`
- **Type**: quality
- **What**: `errText` exists four times identically; the UUID shape check exists five
  times, one of them already in `app/shared/`.
- **Trigger / why it matters**: `SessionId` is a bare `string` (`protocol.ts:82`), so
  `isUuid` is the *only* runtime enforcement of session-id shape in the whole app, and
  it lives in five unsynchronized copies. A tightening or loosening in one plane will
  not reach the others.
- **Fix**: one `isSessionId` beside `SessionId` in `app/shared/protocol.ts` and one
  `errText` in a shared util; both planes already import from `app/shared/`.

### [LOW] Two injected callbacks are treated as infallible in paths that must not abort
- **Where**: `app/host/host.ts:661-667` (`shutdownAll`), `:515-525` (`closeSession`)
- **Type**: design
- **What**: `shutdownAll` iterates `evictReplay(id)` and only then calls
  `supervisor.shutdown()`; a throw from any one callback skips the kill loop entirely.
  `closeSession` adds to `this.closing`, calls `evictReplay`, and deletes from `closing`
  after an `await` — a throw leaves the id in `closing` for the process lifetime, after
  which every exit event for that session is suppressed and a later crash is never
  marked `crashed`. The contract that `evictReplay` may not throw is nowhere stated;
  today's injection (`main.ts:1731-1735`) happens to catch internally, so this is latent.
- **Trigger / why it matters**: the `shutdownAll` failure mode is sidecars outliving the
  window, which is the die-with-window guarantee itself.
- **Fix**: wrap each `evictReplay` call in try/catch (log and continue) and move
  `closing.delete` into a `finally`.

## What is good here

- **The write primitive is genuinely correct.** `atomicWriteJson` (registry.ts:1031-1081)
  does tmp-open → write → `fsync` → close → `rename` → **directory fsync**, with fd
  cleanup on both the throw and the finally path. The directory fsync in particular is
  the step most implementations skip. Crash-during-write leaves either the old file or
  the new one; the corrupt-JSON path then moves the file aside with a loud log rather
  than deleting it. Copy this, do not reinvent it.
- **The two-id model is honored everywhere in scope — no conflation found.** I checked
  every crossing: `hasTranscript`/`canResume`/`resumeFailed` are keyed strictly by
  `appSessionId` and dereference `row.engineSessionId` internally;
  `fillEngineSessionId(event.sessionId, event.frame.engineSessionId)` bridges in the one
  correct direction; `restoreSession` passes `row.engineSessionId` as
  `resumeEngineSessionId` and never as a lookup key; `upsertOnSpawn` seeds
  `engineSessionId` only on the new-row branch, which is exactly the branch where the
  row cannot already carry one. Despite `SessionId` being a bare `string`, there is not
  a single cross-used id in `registry.ts` or `host.ts`.
- **The error unions are genuinely separate.** `host.ts` imports only from
  `../shared/hostApi.js` plus `type SessionId`; `hostApi.ts` imports three types from
  `protocol.ts` and nothing else. `ErrorFrame['code']` appears nowhere in either file,
  and `SaveTextErrorCode` was kept as a *third* union for the same stated reason. The
  F3 §3 rule is being followed, not just cited.
- **The shutdown state machine is sound.** States `null → {clean, crashed, parked}`;
  `markCrashed`/`markParked` guard on `shutdown === null` so a terminal row is never
  relabeled (which is what keeps `shutdownAll`'s mark-clean-then-kill ordering correct);
  `upsertOnSpawn` is the only edge back to `null`; `'parked'` normalizes to `'crashed'`
  on disk read so it cannot survive a relaunch as a distinct state. I found no
  unreachable transition and no permanently-stuck row (the `'parked'` bound exemption
  above is a growth issue, not a stuck state). `markClean` is deliberately unguarded so
  an explicit close outranks a crash tombstone — an asymmetry worth keeping.
- **Dependency injection is used for the right reasons.** Every filesystem, process, and
  lock touch in `registry.ts` is injectable, which is why `registry.test.ts` can spawn a
  *real* orphan and prove it is killed on a pid+identity match and spared on a
  recycled-pid impostor, hermetically. The `FakeSupervisor` in `host.test.ts` faithfully
  models the real tombstone-on-exit behavior instead of an idealized one.

## Not reviewed / uncertain

- I did not run any test (contract: read-only, no suites). The HIGH findings are derived
  from source reading plus the existing fakes; the `liveCount` one would be provable in
  ~10 lines against the existing `FakeSupervisor` (`emitPark` × 32, then `createSession`
  → expect not `session_limit`), and the current suite has no such case.
- The dev-vs-packaged concurrent-writer trigger for the lost-update finding rests on
  Electron deriving `userData` (and therefore the `SingletonLock`) from `app.getName()`,
  which `main.ts:190` changes under `IS_DEV`. I verified the `setName` call and its
  ordering relative to `requestSingleInstanceLock()`, and that neither `dev.ts` nor
  `main.ts` overrides `CLAUDE_CONFIG_DIR`; I did not empirically launch both builds to
  observe two lock files. Running dev and packaged side by side once and diffing
  `registry.json` would settle it. The finding's core — that `persist()` has no
  read-merge — does not depend on the trigger.
- `MAX_REGISTRY_SESSIONS`'s cited measurements (98 KB / 1.20 ms launch / 0.50 ms persist
  at 256 rows) are taken from the source comment, not re-measured.
- Supervisor internals (`app/supervisor/supervisor.ts`) were read only as far as needed to
  establish tombstone lifetime, socket cleanup, and what `restartSession` actually does;
  that file is another scope's review.
