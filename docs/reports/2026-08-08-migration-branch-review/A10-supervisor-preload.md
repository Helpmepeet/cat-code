# A10 — supervisor, preload bridge, replay buffer

## Verdict

The preload is genuinely default-deny and is the strongest file in this scope: fixed
per-method channel constants, no generic `send`/`invoke`, no Node primitive or live object
crossing `contextBridge`, and source-level tests that would fail if any of that regressed. The
supervisor and `replayBuffer` are well-reasoned but the *process-lifetime* half of the
supervisor is the weak point: teardown is SIGTERM-only with no escalation and no retained
handle, socket paths are predictable and collide across supervisor generations in the same
process, and the socket directory is world-traversable. The single most important thing to fix
is `app/scripts/reap-orphan-sidecars.ts`: it kills by `ps` command-line substring and never
consults the registry's recorded pids, even though the correct owned-pid + dual-identity
implementation already exists in `app/host/registry.ts:505-543`.

## Findings

### [HIGH] Orphan reaper kills by command-line pattern match, not by owned pid

- **Where**: `/Users/pt/cat-code/app/scripts/reap-orphan-sidecars.ts:53-76`, `:83-95`, `:141`
- **Type**: security
- **What**: `listMatchingProcesses` enumerates *every* process on the machine via
  `ps -axo pid=,ppid=,command=` and selects on `command.includes(marker)` where `marker`
  defaults to the string `app/sidecar/index.ts`. `partitionOrphans` then classifies anything
  whose `ppid === 1` (or whose parent is dead) as reapable and `--confirm` SIGTERMs it. The
  registry is never read, so the script never asks "is this a pid *we* recorded?".
- **Trigger / why it matters**: on macOS anything launched by launchd, by `open`, or from a
  terminal that has since exited has `ppid === 1`. So an editor holding
  `app/sidecar/index.ts`, a detached `bun test app/sidecar/index.ts`, or another agent
  session's worktree sidecar under `.claude/worktrees/agent-*/app/sidecar/index.ts` all match
  the substring, all report `ppid 1`, and all get SIGTERM'd. `--marker` makes it worse by
  design: `--marker bun` (a plausible "packaged binary" override, since the flag is documented
  for exactly that) SIGTERMs every parentless `bun` process on the shared machine. The
  ownership-based implementation is 400 lines away and is stricter on purpose:
  `registry.ts:505-521` iterates only `row.enginePid` values *the registry itself wrote*, and
  `matchesSidecarIdentity` (`registry.ts:531-543`) additionally requires the recorded
  `socketPath` to still exist AND the cmdline marker, refusing to kill if either signal is
  missing. This script has one of those three guards.
- **Fix**: drive the candidate list from the registry document (`enginePid` + recorded
  `socketPath`) instead of `ps`, and reuse `matchesSidecarIdentity`'s two-signal test. Keep the
  parent-dead check as an *additional* filter, never as the primary selector. If a
  registry-less mode is genuinely wanted, at minimum require the recorded socket path to exist
  and drop the `--marker` override.

### [MED] Socket directory is predictable and world-traversable, with no ownership check

- **Where**: `/Users/pt/cat-code/app/supervisor/supervisor.ts:188-197`
- **Type**: security
- **What**: `socketDir` defaults to `/tmp/catcode-${process.pid}` and is created with
  `mkdirSync(dir, { recursive: true })` — no `mode`, so under the operator's `umask 022` it
  lands at `0755`. The `existsSync` guard means that if the path *already* exists the mode and
  owner are never checked.
- **Trigger / why it matters**: verified on this machine — every `/tmp/catcode-*` dir is
  `drwxr-xr-x pt wheel`, sitting inside world-writable `/tmp`. Two consequences. (a) The
  standard mitigation for a Unix-domain socket (a `0700` parent, so connect permission does not
  depend on platform-specific enforcement of the socket inode's own mode) is not applied;
  anything that can connect to that socket drives the engine with full tool permissions.
  (b) The pid space is small and the name is fully predictable, so a local process can
  pre-create `/tmp/catcode-<pid>` for every pid; the supervisor's `existsSync` then short-circuits
  the mkdir and it operates inside a directory it does not own, where the socket file can be
  unlinked and replaced. The repo already has the safe pattern in three places:
  `app/scripts/ram-probe.ts:218`, `app/scripts/ram-fleet.ts:397`, and `supervisor.test.ts:69`
  all use `mkdtempSync`, which yields `0700` and an unpredictable name.
- **Fix**: pass `{ recursive: true, mode: 0o700 }`, and when the directory already exists
  `lstatSync` it and refuse to proceed unless it is a directory owned by `process.getuid()`
  with no group/other bits. (Keeping the `catcode-<pid>` name preserves the reaper's staleness
  check, so this is a two-line change, not a naming change.)

### [MED] Teardown is SIGTERM-only, and the child handle is dropped immediately

- **Where**: `/Users/pt/cat-code/app/supervisor/supervisor.ts:356-363` (`killSession`),
  `:379-391` (`shutdown`)
- **Type**: correctness
- **What**: `killSession` sends `SIGTERM`, removes the socket file, and deletes the registry
  entry in the same synchronous block. There is no grace window, no `SIGKILL` escalation, and
  no retained reference to the child after the `registry.delete` — so a sidecar that is blocked
  and does not run its SIGTERM handler becomes permanently unreachable by the supervisor that
  spawned it. `shutdown()` is the same code in a loop, and it runs on `window-all-closed`,
  `before-quit`, and the signal path, i.e. on every die-with-window exit.
- **Trigger / why it matters**: a sidecar mid-tool-call (a long synchronous engine operation, a
  hung child process of its own) does not process SIGTERM promptly; Electron main exits
  immediately after `shutdownAll()` and the sidecar survives with a full engine graph resident.
  The only backstops are the 15-minute idle TTL (`app/sidecar/index.ts:57`) and the
  manually-invoked reaper — which is the HIGH finding above. Empirical evidence that the
  graceful path routinely does not complete: this machine currently holds **98**
  `/tmp/catcode-*` directories, 97 of them with a dead owning pid, meaning
  `shutdown()`'s `rmSync(this.socketDir, …)` never ran for those 97 supervisor generations.
  The repo already implements the correct shape: `app/scripts/devLauncher.ts:106-126`
  `terminateChild` does SIGTERM → bounded grace poll → SIGKILL, with a doc comment explaining
  that the pre-fix version "abandoned [the child] to the operator's machine".
- **Fix**: keep the record (or at least the pid) in a `pendingKills` set after SIGTERM, arm an
  unref'd timer for the grace window, and `SIGKILL` any pid still alive when it fires. Reuse
  `terminateChild`'s escalation shape rather than writing a second one.

### [MED] Socket filenames collide across supervisor generations in the same process

- **Where**: `/Users/pt/cat-code/app/supervisor/supervisor.ts:149-150` (`socketSeq`), `:239`;
  consumed by `/Users/pt/cat-code/app/main/main.ts:1698-1700` (`ensureHost`)
- **Type**: correctness
- **What**: `socketPath` is `join(this.socketDir, \`s${this.socketSeq++}.sock\`)`. `socketSeq`
  is **instance** state that restarts at 0 for every `new SidecarSupervisor`, but `socketDir`
  is **process** state (`/tmp/catcode-${process.pid}`). `ensureHost()` deliberately constructs
  a second supervisor in the same Electron main process on macOS reactivate, so the second
  generation re-issues `s0.sock`, `s1.sock`, … over the exact paths the first generation used.
- **Trigger / why it matters**: on macOS, `window-all-closed` runs `shutdownRuntime()` (SIGTERM
  + `rmSync` of the dir) but the process survives. Dock-reopen fires `activate` → `ensureHost()`
  → new supervisor → new sidecar binds `/tmp/catcode-<pid>/s0.sock`. If the *previous*
  generation's sidecar had not yet processed its SIGTERM (see the finding above — nothing
  escalates), its handler then runs `unlinkSync(args.socketPath)`
  (`app/sidecar/index.ts:365-370`) and deletes the **new** session's live socket file. The new
  supervisor is in `connectWhenReady`, polling `existsSync(record.socketPath)`; the file is
  gone, so it polls for the full ~10 s and then marks the session `failed` and SIGTERMs a
  perfectly healthy child (`supervisor.ts:428-436`). The user sees a session that refuses to
  start after a dock reopen. Secondary damage: `registry.matchesSidecarIdentity` treats a
  missing `socketPath` as "not ours", so that live sidecar can never be swept.
- **Fix**: make the socket filename unique per process, not per instance — e.g. seed
  `socketSeq` from a module-level counter, or append a short random suffix
  (`s${seq}-${randomBytes(3).toString('hex')}.sock`). Path length headroom is ample; the
  existing `sun_path` guard at `:240` still covers it.

### [MED] Renderer-driven restart has no cooldown: 120 engine spawns per second

- **Where**: `/Users/pt/cat-code/app/main/main.ts:1203-1210`; `/Users/pt/cat-code/app/host/host.ts:603-648`
- **Type**: security
- **What**: `bridge.restart(sessionId)` passes only the shared preload rate guard
  (120 frames/second, `MAX_FRAMES_PER_WINDOW`). `ipcMain.on(CH_RESTART, …)` forwards straight to
  `host.restartSession`, which kills and respawns the sidecar and then `await`s
  `registry.upsertOnSpawn` — a durable JSON write that bumps `restartCount`. Nothing between
  the renderer and the spawn applies a cooldown, a debounce, or a restart budget.
- **Trigger / why it matters**: the security baseline models the renderer as hostile, and this
  is the one inbound verb whose per-call cost is a *process spawn*. A loop calling
  `restart(id)` sustains 120 Bun processes/second, each loading the full engine graph, plus 120
  atomic registry file writes/second. Session *creation* is bounded (`MAX_LIVE_SESSIONS` 32);
  restart of an existing live session has no equivalent bound. The registry's own
  `restartCount` is recorded but never read as a circuit breaker.
- **Fix**: a per-session minimum interval in `host.restartSession` (reject with the existing
  `HostResult` error union if the last restart was under, say, a second ago), or an
  exponential backoff keyed off `restartCount`. The typed error path already exists.

### [MED] The IPC rate guard uses wall-clock time, so a backward clock step wedges every sender

- **Where**: `/Users/pt/cat-code/app/preload/rendererIpcGuard.ts:12`, `:34-38`
- **Type**: correctness
- **What**: the window is tracked with `now = Date.now` and reset only when
  `currentTime - windowStart >= RATE_WINDOW_MS`. If the wall clock moves backward, that
  difference goes negative and the condition never becomes true, so `frameCount` is never reset.
- **Trigger / why it matters**: a manual clock change, a VM/laptop resume with a stepped (not
  slewed) NTP correction, or a timezone-adjacent clock write while the app is open. Once
  `frameCount` has reached 120 — which one active session does in seconds — *every* bridge
  method throws `renderer IPC rate exceeds 120 frames per 1000ms` until wall time passes the
  stale `windowStart`. A one-hour backward step means one hour of a completely inert app: no
  submit, no permission response, no session create. There is no recovery path short of
  restarting the app.
- **Fix**: use a monotonic clock. `performance.now()` is available in the preload's sandboxed
  context and needs no other change; the injected `now` seam for tests stays as-is.

### [MED] Replay truncation is permanently sticky and its user-visible text reports frames as messages

- **Where**: `/Users/pt/cat-code/app/main/replayBuffer.ts:190-200`, `:246-248`, `:273-286`
- **Type**: correctness
- **What**: two separate problems in the same marker. (1) `entry.truncated` is set to `true`
  and never cleared, including on the "drop only this oversized frame" branch at `:191-199`.
  (2) `replayTruncationFrame` is built with `entry.recent.length` — a count of **frames** — and
  renders it as `Only the ${retained} most recent messages are shown.`
- **Trigger / why it matters**: the code comment at `:192-199` explicitly says the oversized
  branch is "reachable in a healthy session" (a base64 image or a large tool result exceeding
  the 8 MiB ring budget while under the 32 MiB outbound cap). So one image early in a session
  permanently marks the buffer lossy, and from then on every renderer reload prepends a
  truncation banner to a transcript that lost exactly one frame. And the number in that banner
  is wrong in the other direction: frames greatly outnumber messages once streamed partials are
  counted (`DEFAULT_MAX_BUFFERED_FRAMES`'s own doc comment at `:56-58` says "each message is
  several frames"), so the user is told "Only the 6,214 most recent messages are shown" for a
  session that had a few hundred messages and lost none of them. Both halves make the banner
  say something untrue to the user.
- **Fix**: track the two causes separately — a `droppedOversized` counter distinct from
  `evictedFromRing` — and only emit the banner when the ring actually evicted. Phrase the text
  without a count, or count `event` frames carrying a completed message rather than raw frames.

### [MED] Frame byte accounting re-serializes every frame, twice at steady state, in main

- **Where**: `/Users/pt/cat-code/app/main/replayBuffer.ts:288-290` and `:190`, `:210`;
  duplicated verbatim at `/Users/pt/cat-code/app/main/attachmentGate.ts:201-203`; same
  anti-pattern at `/Users/pt/cat-code/app/preload/preload.ts:343`
- **Type**: quality
- **What**: `serializedUtf8Bytes` does `new TextEncoder().encode(JSON.stringify(value)).byteLength`
  — it allocates the entire UTF-8 byte array purely to read `.byteLength`. `record()` calls it
  once on push (`:190`) and then again on every eviction (`:210`) because the byte cost is not
  stored beside the frame. The identical helper is defined a second time in `attachmentGate.ts`,
  and `AttachmentGate.onFrame` calls its own copy on every replay frame, so a replay frame is
  measured in both modules.
- **Trigger / why it matters**: once the ring is at its 8 MiB / 8,000-frame cap — which the
  constant's own doc comment says a real working session reaches — every arriving frame causes
  one push-serialize plus one evict-serialize, both with a full byte-array allocation, on the
  Electron **main** thread that also drives the window. During a streaming turn that is
  hundreds of frames per second of avoidable stringify + allocation, on top of the structured
  clone Electron already performs for the IPC send. It also makes the accounting fragile: the
  subtraction at `:210` is only correct because nothing ever mutates a buffered frame.
- **Fix**: store `{ frame, bytes }` in `recent` so eviction subtracts a stored number, and use
  `Buffer.byteLength(json, 'utf8')` instead of `TextEncoder().encode(...).byteLength` (no
  allocation). Export the one helper from a shared module instead of defining it twice; the
  preload, which has no `Buffer`, can use `new Blob([text]).size`.

### [LOW] The `isObjectRecord` guard runs after the dereference it was written to protect

- **Where**: `/Users/pt/cat-code/app/supervisor/supervisor.ts:461-488`
- **Type**: correctness
- **What**: line 461 does `const frame = result.payload as ServerFrame` and line 462
  immediately reads `frame.kind`. `FrameDecoder` (`app/shared/framing.ts:72`) returns whatever
  `JSON.parse` produced, which includes `null`. The defensive `isObjectRecord(frame)` check
  exists — but at line 481, *after* the dereference — so for the one input it was written to
  reject it is dead code: `null.kind` throws a `TypeError` inside the socket `data` handler,
  which in Electron main is an uncaught exception.
- **Trigger / why it matters**: a well-behaved sidecar never emits a bare `null` frame, so this
  is not reachable today through the trusted path. It becomes reachable through anything that
  can own the socket — which the predictable-socket-dir finding above makes non-hypothetical.
  The cost of fixing it is one moved line, and the module's stated posture at `:481-488` is
  already fail-closed on malformed peer frames.
- **Fix**: hoist `if (!isObjectRecord(frame)) { log + continue }` above the `frame.kind === 'ready'`
  branch, and drop the now-redundant `isObjectRecord` re-test inside the mismatch log.

### [LOW] A sidecar rejected at the frame layer keeps running; only the connect-timeout path kills it

- **Where**: `/Users/pt/cat-code/app/supervisor/supervisor.ts:463-471` and `:489-496`, versus
  `:428-436`
- **Type**: correctness
- **What**: three failure paths set the record to `failed`. The connect-timeout path at
  `:428-436` explicitly kills the child, with a comment saying "do not silently abandon a
  slow/hung sidecar". The invalid-`ready` path (`:466-471`) and the frame-before-ready path
  (`:489-496`) both `setStatus(record, 'failed')` and `socket.destroy()` but never touch
  `record.child`.
- **Trigger / why it matters**: a sidecar that boots, binds, and emits a malformed ready frame
  (a protocol-version skew after a partial upgrade, e.g. a stale packaged binary against a new
  main) is marked unusable while its engine process keeps running with the session's cwd
  loaded. It is only reaped at app shutdown, and only if that SIGTERM lands. The inconsistency
  with the sibling path 30 lines above makes this look like an oversight rather than a
  decision.
- **Fix**: `record.child.kill('SIGTERM')` alongside `setStatus(record, 'failed')` in both
  branches, matching `:433`.

### [LOW] Cap violations in `send` throw an untyped `Error`, so callers classify them as `bad_request`

- **Where**: `/Users/pt/cat-code/app/supervisor/supervisor.ts:341-351`; consumed at
  `/Users/pt/cat-code/app/main/main.ts:1596-1616`
- **Type**: quality
- **What**: the module defines `SidecarSendError` with a closed `SendFailureCode` union and a
  `retryable` flag, and uses it for all three lifecycle refusals. The two *size* refusals —
  `prompt exceeds ${MAX_PROMPT_BYTES} bytes` and `frame exceeds ${MAX_FRAME_BYTES} bytes` —
  throw a bare `Error` instead. `forward` in main tests `isSidecarSendError`, falls through to
  `code: 'bad_request'`, and puts `error.message` verbatim into the `error` server frame.
- **Trigger / why it matters**: the two conditions that are most obviously *not retryable and
  caller's fault* are the two that bypass the typed error the module exists to provide, so
  every consumer has to string-match to tell "your prompt was too long" from "something else
  went wrong". The raw message also carries a byte count and the word "frame" into a
  user-reachable field (`rawMessageLog.ts:116-121` stores it as the session's `error`), which
  is the engineering-vocabulary-in-user-text convention this repo enforces.
- **Fix**: extend `SendFailureCode` with a `payload_too_large` member and throw
  `SidecarSendError` from both checks; give the message a user-readable form and keep the byte
  count in the `log` line only.

### [LOW] The rate limiter is a tumbling window but is documented as sliding

- **Where**: `/Users/pt/cat-code/app/preload/rendererIpcGuard.ts:34-44`;
  `/Users/pt/cat-code/app/shared/limits.ts:28`
- **Type**: quality
- **What**: `limits.ts:28` reads "Sliding-window rate cap". The implementation resets
  `windowStart` and `frameCount` wholesale when the window elapses — a tumbling window.
- **Trigger / why it matters**: a tumbling window admits 2× the nominal cap across a boundary:
  120 sends at t=999 ms plus 120 at t=1001 ms is 240 sends in 2 ms, all accepted. That is a
  factor-of-two gap between the documented T7 bound and the enforced one. Small in absolute
  terms, but it is the kind of doc-vs-code disagreement that a future reader will trust the
  wrong side of.
- **Fix**: either correct the comment to "fixed-window", or keep the prior window's count and
  interpolate. Correcting the comment is the smaller and probably right change.

### [LOW] Promise-returning bridge methods throw synchronously from the guard

- **Where**: `/Users/pt/cat-code/app/preload/preload.ts:252-347`
- **Type**: quality
- **What**: the ten control-plane methods are declared `Promise<…>` but `sendGuard.assertAllowed`
  (and the `MAX_SAVE_TEXT_BYTES` check at `:343`) throw synchronously before the `invoke`, so a
  rate-limited or oversized call raises rather than rejecting.
- **Trigger / why it matters**: a caller written as
  `bridge.previewSession(id).then(…).catch(…)` gets an uncaught exception instead of its
  `catch`; only `await` inside a `try` catches it. Renderer call sites currently use
  `await`/`try` (`App.tsx:2172` handles exactly this for the void-returning
  `reportVisibleSessions`, with a good comment), so nothing is broken today — but the
  signature promises one contract and the code delivers another, and the next `.catch(...)`
  call site will be the bug.
- **Fix**: wrap the guarded body of the promise-returning methods so the failure surfaces as
  `Promise.reject(error)`. The `void`-returning senders should keep throwing synchronously —
  `App.tsx` depends on that.

## What is good here

- **The preload is genuinely default-deny and stays that way by test.** Every sender names a
  module-level `CH_*` constant the renderer cannot influence; `preloadSource.test.ts:126-165`
  extracts the first argument of every `ipcRenderer.invoke` and asserts it is one of ten known
  constants, then strips comments before asserting `send(channel` / `invoke(channel` /
  `readFile` / `writeFile` / `'node:fs'` are absent from *code*. That comment-stripping detail
  is what makes the assertion honest rather than a prose false-positive. Nothing live, no
  closure over privileged state, and no Node primitive reaches `contextBridge`.
- **`subscribe`/`subscribeHost` correctly do not call the send guard, and this is documented as
  a rule with a count.** `preloadSource.test.ts:92` pins `sendGuard.assertAllowed` at exactly
  29 occurrences, so adding a sender without guarding it fails the suite. That is the right
  shape for an allowlist invariant.
- **`reportSocketLoss`'s settle window (`supervisor.ts:527-559`) is a model of a well-argued
  fix**: the doc comment states the observed timing (~7 ms FIN-to-reap), the user-visible
  symptom it caused, why `record.socket` is nulled synchronously while only the *event* waits,
  and both directions are covered by tests (`supervisor.test.ts:199-260`) — including the
  negative one that a dropped report must stay dropped.
- **The replay-buffer retention table is exhaustive by construction.**
  `Record<ServerFrame['kind'], FrameRetention>` (`replayBuffer.ts:101`) makes tsc fail when the
  protocol union grows, so a new once-per-attach snapshot cannot silently land in the evictable
  ring — which is precisely the defect it was written to fix, and
  `replayBuffer.test.ts:272` cross-checks the sticky set against the sidecar's real attach burst.
- **`App.tsx:2160-2192`'s handling of a rate-guard rejection is exactly right**: it records the
  reported key only *after* the send returns, with a comment naming the exact bug that ordering
  fixes and an explicit argument for why no retry timer is warranted. That is the standard the
  rest of the guard's callers should be held to.

## Not reviewed / uncertain

- **Whether the socket file itself is created `0600`.** The sidecar binds via
  `Bun.listen({ unix })` (`app/sidecar/index.ts:268-274`) with no `chmod`, and I did not find a
  live socket on disk to inspect (all 98 `/tmp/catcode-*` dirs here are empty). Whether a
  non-owner can `connect()` at the resulting mode differs between Linux and macOS/BSD, which is
  why the `0700`-parent mitigation is the portable answer and why I framed the finding that
  way. Resolving it: launch the app and `ls -l` the live `s*.sock`.
- **Real-world frequency of the `s0.sock` collision.** The code path is proven by reading
  `ensureHost` + `socketSeq`, but I did not measure how often a sidecar outlives a dock-reopen
  in practice. Resolving it: a probe test that spawns a sidecar with a SIGTERM handler that
  sleeps, shuts the supervisor down, builds a second supervisor in the same process, and
  asserts the new session reaches `ready`.
- **Where the `error` server-frame `message` ultimately renders.** I traced it as far as
  `rawMessageLog.ts:116-121` storing it as `session.error`; I did not follow it to a JSX
  surface, so the user-visible-text half of the untyped-`Error` finding is asserted about the
  string's origin, not about a confirmed on-screen render. That surface belongs to a renderer
  scope, not this one.
- I did not run any test file (contract: read-only, no suites). All claims above are from
  source plus read-only inspection of `/tmp` and `ps`-free liveness probes via `kill -0`.
