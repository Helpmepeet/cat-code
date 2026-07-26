# IDLE-PARK — host-initiated park of idle engines behind kept tabs

> **STATUS: RATIFIED (operator-delegated) + BUILT + MERGED 2026-07-22** — CC-5
> audit ruling #7 (`docs/migration/reviews/2026-07-21-app-cutlist-ram-audit.md`
> Part III). Merged to `migration` as `ea5558c` (backend only, zero renderer/
> preload; battery on merged tree: `bun test app/` 1323/0 · tsc clean · sidecar
> 0 owned · hardening 19/19 · renderer:build ok). **Open decisions §10 resolved:**
> host-initiated cap+TTL shape (§2); DIE-list accepted, no persistence (§7);
> sidecar parking-latch + exit-code-is-truth, no ack frame (§3); focus protection
> = accept / restore-on-click (§4a); `MAX_LIVE_ENGINES=4`, `PARK_IDLE_TTL_MS=20m`
> (§4). **Review found + closed** a no-turn-loss hole: the park gate's task check
> missed a *foregrounded* running agent-mode worker — fixed by a raw-store,
> foreground-inclusive `tasksDomain.hasLiveWork()` (§3), with a test.
> **Measured fleet reclaim** (headless `app/scripts/ram-fleet.ts`, 2026-07-22):
> **~223 MB RSS / ~183 MB footprint reclaimed per parked session** — 6 engines
> 1338.9 MB → park 4 → 445.8 MB (**~67% less**); all 4 victims self-exit
> `PARKED_EXIT_CODE`, zero leaks; matches the ~230/~190 boot floor. Every
> `file:line` re-verified against source 2026-07-22. **Remaining: operator GUI
> acceptance** (§9 step 5) — not claimable headlessly.

## 0. What this is

N-process means every open session tab holds a full engine process (~230 MB
boot floor, RAM-1) even when idle. **Idle-park** kills the engine process behind
an idle-but-open tab and reclaims that process; the tab stays, and returning to
it restores the session on click from the on-disk transcript. Parking reuses the
**existing crash/disconnect→restorable UX end to end** — a parked session is
projected by the host as a `(status:'disconnected', restorable:true)` descriptor,
i.e. it is *byte-for-byte the crash descriptor*, so no renderer, no descriptor,
and no visual code is aware that "park" exists.

Locked decisions honoured (never reopened): N-process · UDS transport · raw
`AppSessionEvent` · die-with-window v1 · two-id model. Security baseline
(`SECURITY-MINIMUM.md`) is a hard gate for the one new inbound frame.

CC-4 already named the policy: *"Cap concurrent live sessions — a soft LRU that
idle-TTLs the least-recently-used … this makes a cap the policy"*
(`decisions/PER-SESSION-COST.md`, "cheap wins" #4). The audit corrected CC-4's
"CC-3 already does the reaping": CC-3's idle-TTL fires only at **zero supervisor
connections**, and the supervisor holds its socket for the session's whole life
(`app/sidecar/index.ts:34-47`), so **no live desktop session ever idle-TTLs
today**. Idle-park is the missing enforcement for that cap.

## 1. Zero-visual-change verdict — YES (with one accepted consequence)

**Zero visual change is achievable.** A parked session is projected as the
existing dead-restorable descriptor, and every downstream surface already
handles that shape:

- **Tab is kept.** `foldTabMembership` keeps a tab iff the descriptor is
  `restorable` + `status==='disconnected'`, and revokes it on a clean-close
  (`restorable` + `'exited'`) (`app/renderer/src/shellState.ts:149-163`). Park
  must therefore present `disconnected`, not `exited`.
- **Chip reads "crashed".** The merged status module renders a `disconnected`
  + `restorable` descriptor as `{tone:'dead', label:'crashed'}`
  (`app/renderer/src/sessionStatusVisual.ts:52-53`). A parked tab shows the
  identical chip a crashed tab shows.
- **Composer disables.** When the parked engine exits, main synthesises a
  `lifecycle{status:'exited'}` frame (`app/main/main.ts:671-695`) which
  `reduceConnectionState` folds to `inputEnabled:false`
  (`app/renderer/src/connectionState.ts:54-65`) — the composer greys out exactly
  as on a crash.
- **Restore on click.** Clicking the tab / restore-offer runs the existing
  `performRestore` → `restoreLiveSession` → `bridge.restoreSession`
  (`app/renderer/src/App.tsx:1327-1417`) → `CH_HOST_RESTORE` → `host.restoreSession`
  (`app/main/main.ts:1051-1073`), which re-spawns with resume and arms P4-28
  replay coalescing (`attachmentGate.startReplayCoalescing`, `main.ts:1060`).

**The one consequence the operator must consciously accept:** a parked session
is *visually indistinguishable from a crashed one*, including the word
**"crashed"** wherever the dead-restorable vocabulary appears. This is not a new
design choice — it is entailed by the constraint "reuse the EXISTING
crash/disconnect→restorable UX / no parked badge." If a distinct-but-quiet
"parked" reading is ever wanted, that is a separate, operator-gated UI decision
and is explicitly **out of scope here**.

## 2. Chosen shape (recommended)

**Host-initiated park; sidecar owns the gate; the exit code is the truth
signal; the registry gets an in-memory `'parked'` state.**

```
                        MAIN (policy owner)                 SIDECAR (gate owner)
  host events ─▶ evaluate LRU-over-cap / idle-TTL
                        │  pick victim V (least-recent live, not over-protected)
                        └─ supervisor.send(V, {type:'app.park', requestId})  ─────▶  handlePark:
                                                                                       1. gate: no active turn,
                                                                                          no pending permission,
                                                                                          no running/pending task
                                                                                       2. if any fail → stay alive
                                                                                          (park declined; no exit)
                                                                                       3. else LATCH parking=true,
                                                                                          re-verify gate, flush,
                                                                                          process.exit(PARKED_EXIT_CODE=5)
  supervisor 'exit'{code:5} ◀───────────────────────────────────────────────────────┘
        │
        ├─ HOST.onSupervisorEvent: code===5 ⇒ registry.markParked(V)   (not markCrashed)
        │        → descriptor (disconnected, restorable) → session-status → tab kept
        └─ MAIN.wireRendererBridge: lifecycle{exited} → composer disabled; persist
                 transcript cache + evict replay (existing crash path, main.ts:636-644)
```

Why host-initiated (not renderer-initiated, not sidecar-self-park):

- **A cap needs a central owner.** Only main sees all sessions and their
  recency; a per-sidecar self-timer can express a TTL but cannot enforce
  "keep the N most-recent live, park the rest." The RAM lever is the *count*
  cap (RAM-3 lever 3), so the policy must live where the count is visible.
- **The renderer sends nothing.** Main already writes client frames to a
  sidecar (`forward` → `supervisor.send`, `app/main/main.ts:1293-1313`).
  `app.park` is originated by main's policy loop, not by any renderer IPC
  channel — **no preload sender, no renderer outbound verb, confirmed.** The
  frame is added to the sidecar's closed allowlist (defence-in-depth) but no
  `ipcMain` handler forwards it, so the renderer is structurally unable to
  author it.
- **The gate must be in the sidecar** ("engine truth"): only the sidecar knows
  the true turn / permission / task state at the instant of park. Main's view
  (built from frames it has already seen) can be stale by one in-flight submit.
- **`killSession` cannot be the park signal.** It is ungated and immediate
  (`app/supervisor/supervisor.ts:316-323`, SIGTERM → `index.ts:321-324` exits
  at once) — it must stay that way for die-with-window, so it would kill
  mid-turn. Park needs a *gated* request, which is what `app.park` is.

### Why the exit code, not an ack frame, is the authoritative classifier

A **self-exit** (the sidecar calling `process.exit`, *not* `killSession`) leaves
the supervisor record registered, so `child.on('exit')` fires and the supervisor
emits `{type:'exit', code, signal}` (`supervisor.ts:256-267`; the F11 guard only
drops exits after a `killSession` deregister). The host reads that `code`
(`host.ts:186-199` — today it ignores the code and always `markCrashed`). Giving
park a dedicated non-zero exit code (`PARKED_EXIT_CODE = 5`, alongside the
existing `RESUME_FAILED_EXIT_CODE = 4` idiom, since 2026-07-26 beside it in
`shared/limits.ts`) lets the host
classify a park purely from the exit — no host↔main coordination, no `parking`
set, no ack frame required for correctness. This keeps the **host plane free of
socket frames** (its stated invariant, `host.ts:13-16`): main sends the frame,
the host only *classifies the exit*.

## 3. The parking latch (R2-F2 — the crux)

The failure R2-F2 forbids: a submit accepted, then the engine killed → a lost
turn. The submit path checks-then-sets its turn flag with **no `await` between**:

```
handleSubmit (app/sidecar/sidecarServer.ts:918-1038):
  … workspace-trust gate, prompt-byte cap, goalSnapshot parse (all SYNC) …
  985  if (this.activeTurn) { sendError(turn_already_running); return }
  997  this.activeTurn = true            ← set synchronously, no await before controller.submit
 1007  void this.controller.submit(...)  ← async turn starts here
```

The sidecar dispatches one inbound frame at a time, synchronously
(`dispatch`, `sidecarServer.ts:875-916`; JS single-thread). So park and submit
cannot interleave *within* a dispatch — only whole dispatches interleave.
The latch is therefore an ordering guarantee over whole dispatches:

**`handlePark(frame)` (new), executed synchronously in one dispatch:**

1. **Gate check (all synchronous reads):**
   - no active turn — `this.activeTurn === false` (the server flag,
     `sidecarServer.ts:314`, authoritative because it is set sync at :997);
   - no pending permission — `controller.getPendingPermissionRequests().length
     === 0` (`AppSessionController.ts:78-80`; used already at :473). Pending
     permissions DIE unrecoverably by design (T5a) — never park over one;
   - no running/pending task — `tasksSnapshot(store).some(status ∈
     {running,pending})`, derivable synchronously from the tasks domain
     (`app/sidecar/tasksDomain.ts:23,61-65`; this is the gate the audit noted
     "does not exist yet" — it is a read, not new state; backgrounded
     `local_agent` workers are tasks in the same store, so this one read covers
     agent-mode workers too).
2. **If any gate fails → do nothing.** The session stays live; the park is
   silently declined (main re-evaluates on its next trigger). A turn/permission
   that was *accepted before this dispatch* thus **aborts the park, not the
   turn** — exactly R2-F2's required direction.
3. **If all pass → LATCH:** set `this.parking = true`.
4. **Re-verify the same three gates after latching** (belt-and-suspenders;
   trivially still-true under single-thread, but it makes the invariant explicit
   and future-proofs against an `await` creeping into the gate). If anything
   flipped, unset `parking` and decline.
5. **Flush + exit:** call `onPark()` (the closure `index.ts` supplies, mirroring
   `onIdle`, `index.ts:210-213`) → `cleanup()` (unlink socket, `index.ts:313-320`)
   → `process.exit(PARKED_EXIT_CODE)`. The process exit is the last thing that
   happens; there is no frame after it.

**Submit arriving after the latch:** `handleSubmit` gains one early guard —

```
if (this.parking) { sendError(requestId, 'session_disconnected', 'session parking', /*retryable*/ true); return }
```

before `this.activeTurn` is touched. The turn never starts (`activeTurn` never
set, `controller.submit` never called → **no turn loss**). `session_disconnected`
is an *existing* `ErrorFrame` code (`app/shared/protocol.ts:480-491`) that the
renderer already folds to `disconnected`/`inputEnabled:false`
(`connectionState.ts:66-73`) — so this reuses the existing degrade-gracefully
path with **no new error code and no renderer change**.

**The two orderings, resolved:**

| Ordering at the sidecar | Outcome |
|---|---|
| submit dispatched **before** park | submit sets `activeTurn=true` (sync); park gate sees it → park declined; turn runs. **No turn loss.** |
| park dispatched **before** submit | park latches + exits; submit sees `parking` → typed `session_disconnected`; turn never started. **No turn loss; draft preserved** (see below). |

### How narrow is the race, and what the renderer does with the rejection

**Park fires only on IDLE sessions** — a session with an active turn is gated
away. For a renderer submit to race a park at all, main must select a session as
a park victim at the *same millisecond* a user presses Enter into that session's
composer. Main only parks **background / least-recent** sessions; a submit comes
from the **focused** composer. The residual race is the few-ms IPC window between
"park latched in the sidecar" and "the `lifecycle{exited}` frame reaches the
renderer and disables the composer." A submit fired inside that window is
rejected with `session_disconnected`.

**Renderer handling (no new UI):** nothing new. The rejection lands on the
existing `session_disconnected` path → the tab reads disconnected, the composer
disables, the user clicks to restore (unpark) and re-sends. **No turn ran, no
conversation content was lost.** The prompt text is preserved: `submitSession`
pushes it into composer history before the network call
(`App.tsx:1481`, `reduceHistoryPushed`) so it is recoverable with ↑; the
per-session draft is also renderer-local (`promptDrafts`, keyed by appSessionId
— `App.tsx:1462,1479,1488-1499`) and independent of the engine, dying only on
app quit. *(Anchor note: the audit's F5 matrix cited `App.tsx:3482-3499` for the
draft; that region is now a Restart button — the live draft sites are above.)*
The only artifact is
that the optimistic draft-clear at `App.tsx:1479` empties the composer on a
rejected submit; the text is one ↑ away. This is a bounded, no-data-loss
papercut in a few-ms window on a background tab; it is **not** turn loss.

*(Optional hardening, not funded here: a renderer error-handler that restores
the draft on `session_disconnected` would erase even that papercut, at the cost
of a small renderer change — flagged, not designed in.)*

## 4. Idle policy + owner

**Owner: main** (it holds the supervisor, runs the periodic drivers, and sees
the whole live set). Concretely a small `createIdleParkDriver({ host, supervisor })`
module mirroring the existing `sessionsCatalogDriver` lifecycle
(`main.ts:374-388,1562`), started with the window and stopped on
`window-all-closed`.

**Trigger — soft LRU cap (primary, per CC-4) + idle TTL (secondary):**

- **Cap:** keep at most `MAX_LIVE_ENGINES` sessions live; when the live count
  (`host.listSessions()` filtered to `status ∈ {spawning,ready}`) exceeds the
  cap, park the least-recently-active live sessions (recency = `lastMessageSentAt`
  ?? `lastAttachedAt` ?? `createdAt`, all on the descriptor,
  `hostApi.ts:85-95`) until at the cap. Re-evaluated on each `session-added` /
  `session-status` host event (event-driven, no polling needed for the cap).
- **TTL (optional):** a session idle for `PARK_IDLE_TTL_MS` (generous, e.g.
  20–30 min) is parked even under the cap, to reclaim genuinely-abandoned tabs.
  This needs a low-frequency timer in the driver.

**The one unresolved policy question (operator decision, § Open decisions):**
main does **not** know which tab the renderer has focused — `activeSessionId` is
deliberately renderer-only (`shellState.ts:6-9`), and merely switching tabs
bumps no registry recency (`lastAttachedAt` moves on attach/restore/spawn, never
on focus). So a user reading an *old, idle* tab could see it parked under it (no
data loss — one click restores). Two ways to resolve, operator's call:
(a) **accept it** — parking a focused-idle tab is the audit-accepted
"restore on click" UX, and gating on no-active-turn already protects any tab
mid-turn; or (b) fund a **one-way renderer→main "active session" hint** so main
excludes the focused tab from victim selection — a small, bounded renderer
change (a single fixed-sender, no engine state). Recommendation: ship (a);
add (b) only if live use shows focused-idle parking is annoying.

## 5. Per-plane change list

| Plane | Change | New inbound surface? |
|---|---|---|
| **shared/protocol.ts** | Add `AppParkMessage = {type:'app.park'; requestId:string}` to the `SidecarClientMessage` union (`protocol.ts:386-397`), with a doc-comment citing this file. Additive under v1 — no `PROTOCOL_VERSION` bump. | inbound verb (see §6) |
| **sidecar/sidecarServer.ts** | `checkStrictKeys` allowlist entry `['app.park', new Set(['type','requestId'])]` (`:2711-2765`); a sidecar-local Zod schema for `app.park`; a `dispatch` case (`:875-916`) → `handlePark`; the `parking` field + `handlePark` (§3); the one-line `if (this.parking)` guard in `handleSubmit` (`:918`); an `onPark` option (mirrors `onIdle`, `:302,350,429-442`). | yes — full security tax |
| **sidecar/index.ts** | `PARKED_EXIT_CODE = 5` const; pass `onPark: () => { cleanup(); process.exit(PARKED_EXIT_CODE) }` into `SidecarServer` (mirrors `onIdle`, `:204-214`). | no |
| **host/registry.ts** | `ShutdownState` gains `'parked'` (`:85`); `normalizeShutdown` maps a **persisted** `'parked'` → `'crashed'` on read (`:961-969`) so `'parked'` is an in-memory-only state for the current run; `enforceBound` excludes `'parked'` rows from the terminal reap (`:570-609`, filter `:578`); new `markParked()` (like `markCrashed`, `:777-786`, transitions `null → 'parked'`). | no |
| **host/host.ts** | `onSupervisorEvent` exit branch (`:186-199`): `event.code === PARKED_EXIT_CODE ⇒ registry.markParked` else `markCrashed`; `descriptorFromRow` status map (`:705-709`): treat `'parked'` like `'crashed'` → `'disconnected'` so the tab is kept + `restorable` stays true (`isRestorable` already returns true for a dead row with an `engineSessionId` — and, since 2026-07-26, a transcript that actually exists; a session parked before it ever ran a turn has none, so it reads `disconnected` + NOT restorable, which keeps its tab just the same). | no (host sends no frame) |
| **main/main.ts** | `createIdleParkDriver` (policy §4) sending `app.park` via `supervisor.send`; started/stopped with the window (mirror `sessionsCatalogDriver`, `:374-388,1562,1591`). The exit→`lifecycle{exited}` synth (`:671-695`) and the terminal-frame persist+evict (`:636-644`) need **no change** — a parked exit rides them exactly like a crash. | no |
| **preload** | **none.** | — |
| **renderer** | **none** (unless the operator picks focus-hint (b) in §4, or the optional draft-restore hardening in §3). | — |

## 6. Security-baseline additions (the `app.park` tax)

`app.park` is a new inbound frame kind, so `SECURITY-MINIMUM.md` requires the
full tax. It is unusually cheap because the frame carries **no renderer-authored
state** (no path, no policy, no permission id, no secret — just a `requestId`):

1. **Sidecar-local schema:** `z.object({ type: z.literal('app.park'), requestId:
   z.string() })`, validated at the sidecar (the trust boundary), not only at
   any sender.
2. **Closed-allowlist entry:** `checkStrictKeys` rejects any key beyond
   `{type, requestId}` (`sidecarServer.ts:2711-2765`).
3. **Boundary tests** (accept-valid / reject-invalid, plus the R2-F2 orderings):
   valid `app.park` on an idle session → gated exit; malformed (`extra key`,
   wrong type) → `bad_request`; `app.park` while `activeTurn` → declined, session
   stays live, turn unaffected; `app.submit` after `parking` latched → typed
   `session_disconnected`, `controller.submit` never called; `app.park` while a
   permission is pending or a task is running → declined.
4. **Decision doc-comment** on `AppParkMessage` in `protocol.ts` citing this file.
5. **Hardening inventory** entry in `app/scripts/hardening-smoke.ts` (the socket
   frame-count / inbound-vocabulary check) so the new verb is accounted for.

Directional caps unchanged (`MAX_FRAME_BYTES` inbound); no `secretGuard` change
(no new outbound secret surface). **Threat model:** the renderer cannot originate
`app.park` (no IPC channel forwards it); if it somehow could, the worst outcome
is requesting a park of a session — gated on idleness, and restorable on click —
i.e. a self-inflicted, fully-recoverable minor DoS. Documented, not a hole.

## 7. State across park/restore — the DIE-list, ACCEPTED as-is

Hard invariants (both hold): **NO turn loss** (park is gated on no active turn;
an accepted turn aborts the park) and **NO conversation loss** (the transcript is
engine-owned JSONL, appended incrementally, `sessionStorage.ts`; resume reloads
it into the engine's turn context, `sessionController.ts:296-306`, and replays it
to the renderer, `index.ts:174-176`). The following are **accepted to reset on
park→restore — do NOT fund persistence** (F5 matrix, audit Part III; the rows
below are the ones the operator is asked to ratify as DIE):

| Item | Fate on park→restore | Evidence |
|---|---|---|
| Conversation + turn context | **SURVIVES** | `sessionResume.ts:64-113` → `sessionController.ts:296-306`; replay `index.ts:174-176` |
| Both ids, cwd, title | **SURVIVES** (registry-backed) | `host.restoreSession` re-spawns with `row.engineSessionId`, `host.ts:322-327` |
| Composer draft / prompt history | **SURVIVES** (renderer-local, per appSessionId) | `App.tsx:1462,1488-1499` (draft), `App.tsx:1481` (history) |
| Always-allow permission rules (userSettings/project) | **SURVIVES** (engine re-applies + persists) | `sidecarServer.ts` permission apply path; F5 matrix |
| **Thread goal** | **DIES** — resume drops `ProcessedResume.initialState`; controller rebuilds from `getDefaultAppState()` (`threadGoal:null`) | `sessionResume.ts:98,112`; `sessionController.ts` default state |
| **Effort override** (xhigh/ultra/numeric ephemeral; low/med/high shared LWW) | **DIES / SHARED-LWW** | F5 matrix (`effort.ts`, `runControlsDomain.ts`) |
| **Permission MODE; session-scoped rules; model override; fast mode** | **DIE** (in-memory, session-scoped) | `runControlsDomain.ts`; `sidecarServer.ts` setMode is session-scoped |
| Pending permission requests; in-flight turn | **GATED AWAY** (park refuses) | §3 |
| Agent-mode restoration fidelity | **DEGRADES** (`modeApi:null` on headless resume) | `sessionResume.ts:88-99` |
| Scroll position; MCP (`mcpClients:[]`) | DIES / MOOT | `App.tsx`; `sessionController.ts:227` |

These are identical to what a **crash→restore** already loses today — park adds
no new loss class. The audit's worktree / cost-state / context-collapse rows stay
**UNVERIFIED** (they restore via separate engine-side resume side effects,
`sessionRestore.ts:14,136-148,334-375`); park does not change them, and they are
not a park-specific obligation.

## 8. Registry bookkeeping & restore-path confirmations

- **enforceBound reap (the dangling-tab hazard):** `enforceBound` reaps oldest
  terminal rows over `MAX_REGISTRY_SESSIONS` (`registry.ts:72,570-609`; raised
  32 → 256 on 2026-07-26, `REGISTRY.md` §3 — the exclusion below is unaffected).
  A `'parked'` row is an *open tab*, so it is excluded from the reap
  (`:578` filter gains `&& r.shutdown !== 'parked'`). Live rows (`shutdown:null`)
  are already never reaped. `checkSpawnLimits` counts **live processes** against
  the separate `MAX_LIVE_SESSIONS` cap (`this.liveCount()` = supervisor sessions,
  `host.ts:636,664-666`), which a parked session is NOT part of — so **parking
  frees a live slot**, the whole point, while the row is retained for the tab.
- **Not misread as a crash:** the parked self-exit carries `PARKED_EXIT_CODE`;
  `host.onSupervisorEvent` classifies on the code → `markParked`, never
  `markCrashed`. A `'disconnected'` supervisor status event (socket close) does
  **not** `markCrashed` (only `'failed'` does, `host.ts:203`), so ordering of
  the exit vs the socket-close event is harmless.
- **Not misread across a relaunch:** `'parked'` normalises to `'crashed'` on
  disk read (§5), so a parked row that survives an app crash becomes an ordinary
  restore-offer next launch (the sweep skips it — `shutdown != null`,
  `registry.ts:491` — and reap treats it like any terminal restorable row).
  Foldable back to a tab only via an explicit restore (`foldTabMembership`
  never grants a tab to a hydrated restorable-only row, `shellState.ts:154-163`).
- **Unpark = the existing restore machinery, no new UX:** `performRestore` /
  `engagePreview` (`App.tsx:1327-1417`) → `CH_HOST_RESTORE`
  (`main.ts:1051-1073`, arms P4-28 replay coalescing at `:1060`) →
  `host.restoreSession` (`host.ts:255-328`, clears the dead tombstone via
  `killSession` on the already-dead pid `:316-320`, then re-spawns with resume
  `:322-327`). The transcript cache was persisted at park time
  (`main.ts:636-644`, the terminal-lifecycle path), so a cached preview opens
  instantly, then engages the live resume — identical to crash-restore.
  *(Anchor note: the audit cited "replay coalescing armed at main.ts:1004"; the
  current arming site is `main.ts:1060` inside `CH_HOST_RESTORE` — source wins.)*

## 9. Acceptance test (park→restore, real public path)

Before ratification-close, prove — through the real path, not this table:

1. **No turn loss under the race** (the load-bearing test): spawn a session;
   fire `app.park` and `app.submit` in both orders at the sidecar boundary and
   assert (a) submit-before-park → turn runs, no exit; (b) park-before-submit →
   sidecar exits `PARKED_EXIT_CODE`, submit gets `session_disconnected`,
   `controller.submit` never invoked.
2. **Gate refusals:** `app.park` is declined (no exit) while a turn is active,
   while a permission is pending, and while a task is running/pending.
3. **Public park→restore:** spawn → run one turn (transcript has content) →
   trigger park (driver or direct) → assert the tab stays, chip reads "crashed",
   composer disabled, engine process gone (registry `'parked'`, `liveCount`
   dropped) → click restore → assert the conversation replays (P4-28), a new
   turn runs, and the DIE-list items reset as in §7 (goal null, mode default).
4. **enforceBound:** with more than `MAX_REGISTRY_SESSIONS` rows including a
   parked open tab, a new spawn reaps an oldest *clean/crashed* row and **never**
   the parked one.
5. **Battery:** `bun test app/`, `bun run --cwd app typecheck` +
   `typecheck:sidecar` (0 owned), `bun run --cwd app test:hardening` (all pass),
   `renderer:build`. GUI acceptance (operator): park a background tab, confirm it
   reads exactly as a crashed tab and restores on click with full history.

## 10. Open decisions (operator must ratify before build)

1. **The shape** (§2): host-initiated `app.park` frame + registry `'parked'` +
   exit-code classification. (Alternatives in §11.)
2. **The DIE-list** (§7): confirm thread-goal / permission-mode / effort-override
   reset is accepted (no persistence funded).
3. **The parking-latch** (§3): confirm the sidecar-latch + `session_disconnected`
   rejection + "no ack frame, exit-code is truth" is acceptable, OR request an
   explicit `park.result` ack/refuse outbound frame (small additive, intercepted
   by main like `session-title` at `main.ts:626-629`) for policy telemetry.
4. **Focus protection** (§4): accept that a focused-idle tab may be parked
   (restore-on-click), OR fund the one-way renderer→main active-session hint (b).
5. **Policy knobs** (§4): `MAX_LIVE_ENGINES` value; whether the idle-TTL
   secondary trigger ships in v1 or the cap alone suffices.

## 11. Considered and rejected

- **Renderer-initiated park (audit Part III's "one HC3 preload sender").**
  Rejected: adds a renderer outbound verb for no benefit; the renderer has no
  reason to decide park policy, and it forces a preload channel that then must be
  DoS-reasoned. Host-initiated needs **zero** renderer/preload change.
- **Sidecar self-park on an activity-TTL (no frame at all).** Simplest possible
  (no protocol change, no security tax — just an activity timer + gate + exit
  code); genuinely viable **if a TTL is sufficient**. Rejected as the primary
  because it cannot enforce a concurrent-count **cap** (each sidecar only knows
  its own idleness), and the cap is the stated RAM lever + CC-4's named policy.
  Kept on the table as the fallback if the operator drops the cap (would delete
  the entire §6 tax and the main driver).
- **Reuse `'crashed'` for parked rows (no new registry state).** Rejected:
  `enforceBound` would reap a parked open tab over the row bound and dangle it. The
  `'parked'` state exists solely to exclude it from that reap; it is invisible
  to the descriptor (maps to `'disconnected'`) and to disk (normalises to
  `'crashed'`).
- **Add `parked:boolean` to `SessionDescriptor`** (audit's tentative suggestion).
  Rejected as unnecessary: putting the distinction in the *registry row* (not the
  descriptor) keeps the descriptor byte-identical to a crash, which is what makes
  the renderer provably unaware of park (zero-UI proof by construction).

## 12. Ordered build spec (dependency order, sized for subagents)

Build only after §10 is ratified. Each step is independently testable; run the
`app/` battery per step. Steps 1–3 are the sidecar path (must land together to
be coherent); 4–5 the host path; 6 the policy; 7 the tests + hardening; 8
bookkeeping.

**Step 1 — protocol (foundation).** `app/shared/protocol.ts`: add
`AppParkMessage = { type:'app.park'; requestId: string }` with a doc-comment
citing `decisions/IDLE-PARK.md`; add it to the `SidecarClientMessage` union
(`:386-397`). Additive; **no `PROTOCOL_VERSION` bump**. Verify: `typecheck`.

**Step 2 — sidecar exit code.** `app/sidecar/index.ts`: add
`PARKED_EXIT_CODE = 5` (beside `RESUME_FAILED_EXIT_CODE`; both now live in
`app/shared/limits.ts`); add an
`onPark: () => { cleanup(); process.exit(PARKED_EXIT_CODE) }` and pass it into
`new SidecarServer({... onPark})` (mirror `onIdle`, `:204-214`).

**Step 3 — sidecar gate + latch (the crux).** `app/sidecar/sidecarServer.ts`:
(a) `onPark` option + `private parking = false` field (near `:302,314`);
(b) sidecar-local Zod schema for `app.park`; (c) `checkStrictKeys` entry
`['app.park', new Set(['type','requestId'])]` (`:2711`); (d) `dispatch` case
(`:912`-adjacent) → `handlePark`; (e) `handlePark` per §3 (3-gate check →
latch → re-verify → `onPark()`); (f) the `if (this.parking) { sendError(...,
'session_disconnected', ..., true); return }` guard as the FIRST line of
`handleSubmit` (`:918`). The task gate reads `tasksSnapshot` — reuse the tasks
domain the server already holds (`this.tasks`, `sessionController.ts:483`),
do not re-derive. Verify: new boundary tests (§9.1–9.2) + `test:hardening`.

**Step 4 — registry `'parked'` state.** `app/host/registry.ts`: `ShutdownState`
+= `'parked'` (`:85`); `normalizeShutdown` maps persisted `'parked'` → `'crashed'`
(`:961-969`); `enforceBound` filter excludes `'parked'` (`:578`); `markParked()`
(clone `markCrashed`, `:777-786`, `null → 'parked'`). Verify: registry unit tests
(parked excluded from reap; parked normalises to crashed on read).

**Step 5 — host classification + descriptor.** `app/host/host.ts`:
`onSupervisorEvent` exit branch (`:186-199`) → `event.code === PARKED_EXIT_CODE`
? `registry.markParked` : `markCrashed`; `descriptorFromRow` (`:705-709`) →
`(shutdown === 'crashed' || shutdown === 'parked') ? 'disconnected' : 'exited'`.
Import `PARKED_EXIT_CODE` from a shared const (put it in `app/shared/limits.ts`
so both `index.ts` and `host.ts` import one source — avoids two literals).
Verify: host unit test (exit code 5 → parked descriptor disconnected+restorable;
tab-kept via a `foldTabMembership` assertion).

**Step 6 — main policy driver.** `app/main/main.ts` (+ a new
`app/main/idleParkDriver.ts` mirroring `sessionsCatalogDriver`): `createIdleParkDriver({ host, supervisor })`
computing LRU-over-cap victims (`host.listSessions()` filtered to live, recency
per §4), sending `app.park` via `supervisor.send`, guarding the throw when a
victim is no longer `ready` (`supervisor.ts:292`); started with the window,
stopped on `window-all-closed`/`before-quit` (`main.ts:374-388,1562,1591`).
`MAX_LIVE_ENGINES` + optional `PARK_IDLE_TTL_MS` constants. Verify: driver unit
(victim selection excludes the top-K recent, respects the cap).

**Step 7 — integration + hardening.** Park→restore probe (§9.3), enforceBound
32-row test (§9.4), hardening-inventory entry for `app.park`
(`app/scripts/hardening-smoke.ts`). Full battery: `bun test app/`,
`typecheck` + `typecheck:sidecar` (0 owned), `test:hardening` (all pass),
`renderer:build`.

**Step 8 — bookkeeping.** STATUS row (CC-5 #7 → BUILT); flip this doc
DRAFT→ratified header; no `DONE.md` without operator ask. GUI acceptance is an
operator step (park a background tab; confirm it reads as a crashed tab and
restores with full history) — not claimed done headlessly.
