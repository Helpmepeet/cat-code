# Lane 08 — Lifetime, restore, and failure recovery

**Auditor verdict:** YELLOW
**Rows audited:** 9 · TRUE 7 · OVERSTATED 0 · FALSE 0 · STALE 2 · UNVERIFIABLE-HEADLESS 0

No row in this lane is a Potemkin ✅. The engine restore machinery is real, reachable,
and headless-covered. The lane is YELLOW for one reason: **the program's anti-Potemkin
GATE (P3-8) was cleared against an interaction path that no longer exists**, and the path
that replaced it is, by construction, a stored-transcript re-render.

## Row verdicts

### P3-8 — GATE: lifetime/restore, quit/relaunch + crash-sim (anti-Potemkin)
**Verdict:** STALE
**Claims checked:**
1. Two live sessions → quit → relaunch → both restored from the registry in fresh engine processes.
2. Anti-Potemkin (a) post-restore prompt answers a pre-quit nonce; (b) same `engineSessionId`
   transcript appended by a NEW engine PID; (c) resume ran the real engine machinery.
3. Worker verifies on disk via `sessionStorage.ts:240`.
4. Resume ran through `conversationRecovery.ts:465` / `sessionRestore.ts:493`.
5. Mid-gate blocker fixed: `getLastSessionLog` (`sessionStorage.ts:4275`) and
   `loadMessagesFromJsonlPath` (`conversationRecovery.ts:427`) select the newest
   **user/assistant** leaf, mirroring `loadFullLog` (`:3358`).
6. Regression test `sessionStorage.test.ts` "resume tip skips a trailing dangling system frame".
7. TUI `--resume` funnels through the same three loaders, so the fix covers the daily driver.

**Evidence:**
- Claim 5 is **TRUE and still in force**. `src/utils/sessionStorage.ts:4705-4708` —
  `findLatestMessage(messages.values(), m => !m.isSidechain && (m.type === 'user' || m.type === 'assistant'))`
  with the Codex-`system`-frame rationale in the comment above it.
  `src/utils/conversationRecovery.ts:468-478` — the same predicate on the `.jsonl`-path twin.
  `src/utils/sessionStorage.ts:3676-3682` — `loadFullLog`'s matching leaf predicate.
- Claim 6 **TRUE**: `src/utils/sessionStorage.test.ts:75`.
- Claims 1/2 are a **live GUI run on 2026-07-06** and cannot be re-derived headless. The
  headless companion the row leaves behind is real and does what it says:
  `app/host/lifetimeChain.probe.test.ts:129-227` carries ONE real registry file through
  `upsertOnSpawn → fillEngineSessionId → markLiveCleanSync → fresh SessionRegistry.launch()
  → restorable() → real sidecar spawn with `resumeEngineSessionId`, and asserts the ready
  frame echoes the same `engineSessionId` (`:225`). The transcript is minted through the
  engine's own `recordTranscript`, not hand-written JSONL. The file states plainly
  (`:20-22`) that the model-answers-from-context proof stays the operator gate.

**Reachable-path trace (today):** Sidebar restorable row → `App.tsx:2919 onRestore` →
`performRestore` (`App.tsx:1926`) → `bridge.previewSession` → **if a cache hit, a preview
pane opens and NO engine is spawned** (`App.tsx:1951-1955`) → engine spawn happens only on
composer focus / pointer-down / submit (`App.tsx:4360, 4397-4398` → `engagePreview` →
`restoreLiveSession` → `bridge.restoreSession`, `App.tsx:1841`) → `main.ts:1322` →
`host.restoreSession` (`app/host/host.ts:296-368`) → `spawn({resumeEngineSessionId})` →
`app/sidecar/sessionResume.ts:68-80` (`loadConversationForResume` + `processResumedConversation`).

**Why STALE.** The gate was cleared 2026-07-06 against a path where clicking a restorable
row spawned an engine. That path was deliberately removed later: the CC-5 cut-list §I.1
ruling #3 killed the dwell auto-spawn, CC-16 (✅ 2026-07-27) made the composer the only
spawn trigger, and the PL-A preload made a click open a **cached transcript**. So the
thing a user sees immediately after relaunch today is exactly the artifact the gate exists
to exclude: stored transcript, re-rendered, no engine. The live machinery behind it is
intact and traced above, and LR-7 covers the registry→resume half headlessly — but no gate
run has ever exercised the current click-to-read-to-type sequence end to end, and the
`app/` renderer suite is SSR-only so it structurally cannot.

**Anchor drift:** four of five cited anchors are dead or moved.
`sessionStorage.ts:240` is now `getProjectDir`/`getTranscriptPath` (no worker verification
there at all) · `sessionRestore.ts:493` is deferred-continuation lock code;
`processResumedConversation` is at `:646` · `sessionStorage.ts:4275` → `:4669` ·
`conversationRecovery.ts:427` → `:458` · `loadFullLog :3358` → `:3639`.
`conversationRecovery.ts:465` still lands inside the right function.

### P4-16 — Resume dialogs (CrossProjectResumeDialog / HydrationOverlay)
**Verdict:** TRUE
**Claims checked:** (1) built and merged 2026-07-09; (2) later ✂️ superseded/removed by P4-22;
(3) "do not re-implement".
**Evidence:** repo-wide grep for `HydrationOverlay|ResumeDialog|resumeDialogState|
ResumeBatchAction|dispatchResumeUi` outside `docs/` returns **zero hits**. The row's own
✂️ tag is accurate; it is a historical record of deleted work and says so.
**Reachable-path trace:** n/a (deliberately unreachable — the code is gone).
**Anchor drift:** none. Internal contradiction only (the row's early "no reachable in-app
trigger yet" NB is corrected by its own later sentence); a nit, not a finding.

### P4-22 — Remove resume-confirm + hydration-overlay (frictionless restore)
**Verdict:** TRUE
**Claims checked:** (1) the whole dialog layer deleted; (2) `ResumeBatchAction`/`dispatchResumeUi`
stripped from `serverFrameBatch.ts`; (3) Sidebar `onRestore` + palette rewired straight to
`performRestore`; (4) the ONE real `bridge.restoreSession` call untouched; (5) failures now
surface in the shell-error banner; (6) renderer-only, zero wire/preload/security/engine surface.
**Evidence:** (1)(2) zero grep hits anywhere in `app/`. (3) `App.tsx:2919`
`onRestore={sessionId => void performRestore(sessionId)}` and `App.tsx:2796`
`restoreSession: sessionId => void performRestore(sessionId)` (⌘K palette). (4) exactly one
`bridge.restoreSession(` in the renderer, `App.tsx:1841`. (5) `App.tsx:1864, 1870`
`setShellError(hostErrorMessage(...))` on both failure arms. (6) `host.restoreSession`
and `sessionResume.ts` unchanged in shape.
**Reachable-path trace:** Sidebar row / ⌘K → `performRestore` → (preview or) `restoreLiveSession`
→ `bridge.restoreSession`. No modal, no overlay anywhere on it.
**Anchor drift:** none, but the clause "restores IMMEDIATELY" describes a mechanism that
CC-16/PL-A superseded (see F3). The row's headline claim — the friction is gone — is TRUE.

### P4-54 — Shell lifecycle errors dismiss explicitly
**Verdict:** TRUE
**Claims checked:** (1) all 13 failure writes replace the current `shellError`; (2) explicit
dismissal is its only clearer; (3) ordinary success paths never clear it; (4) roster/account
errors stay on separate surfaces; (5) live click UNVERIFIED.
**Evidence:** `App.tsx:475` declares the state. 15 `setShellError` occurrences total = 1
declaration + 1 clear + **13 writes**, matching the row exactly. The single clearer is
`App.tsx:3175` `onClick={() => setShellError(null)}` — no success path calls it.
`App.tsx:3389-3396` documents and enforces the separation from the account-health plane;
the roster failure lives in `WelcomeScreen`'s ProjectPicker, a third surface.
**Reachable-path trace:** any of the 13 writers → `shellError` → the bar at `App.tsx:3170-3183`,
rendered unconditionally in the shell frame → user clicks the `aria-label="Dismiss shell error"`
button → `setShellError(null)`.
**Anchor drift:** none (the row cites no line anchors). The row is 🟡 and states the live
click is unverified; that is honest.

### P4-55 — Initial session-roster read failure is visible and retryable
**Verdict:** TRUE
**Claims checked:** (1) distinct pending/failure/ready states; (2) a rejected initial
`listSessions()` stays failure; (3) Retry calls the same `hydrateHostRoster` callback and
keeps the failure visible while reading; (4) success alone marks ready; (5) the exact call
path; (6) `mergeRosterSnapshot` prefers newer live descriptors and skips removed ids;
(7) the failure replaces only the Project picker.
**Evidence:** `app/renderer/src/rosterBootstrap.ts:5-33` — the three-state reducer;
`read-started` from a `failure` state returns `{status:'failure', retrying:true}` (claim 3
verbatim), `read-failed` → failure, `read-succeeded` → ready.
`attemptRosterBootstrap:35-55` — a rejected `listSessions()` calls `onFailure` and returns
without ever calling `onSnapshot` (claim 2). `mergeRosterSnapshot:61-75` — `if (removed.has(id)) continue`
and `if (existing && existing.lastAttachedAt >= session.lastAttachedAt) continue` (claim 6).
`App.tsx:880-901` wires it with an attempt-generation guard (`rosterReadAttemptRef`) so a
stale in-flight read cannot resolve over a newer one.
**Reachable-path trace:** `App.tsx:880 hydrateHostRoster` → `getBridge().listSessions()` →
rejection → `dispatchRosterBootstrap({type:'read-failed'})` → `App.tsx:3379-3386` passes
`rosterFailure` to `WelcomeScreen` (mounted on the `workspacePanels.length === 0 ||
!activeSessionId` branch, which a failed roster read guarantees) → `WelcomeScreen.tsx:164`
→ `ProjectPicker` → `WelcomeScreen.tsx:278-294` renders `Recent projects could not load.`
plus a `Retry` button, `disabled`/`aria-busy` while retrying, `onClick={rosterFailure.onRetry}`
→ back to `hydrateHostRoster`.
**Anchor drift:** none, but the row names `HydrationOverlay` among the surfaces it left
untouched. That component was deleted by P4-22 three weeks earlier (F4).

### CC-2 — Restore/open must NOT reorder the tab/sidebar row
**Verdict:** STALE
**Claims checked:** (1) status 🟡 not-fixed, parked by operator; (2) the warp half is fixed
by ordering on the immutable `createdAt`; (3) the operator's fuller "reorder ONLY on
message-send" spec **stays deferred — still needs a `lastMessageSentAt` signal**;
(4) the fix is uncommitted.
**Evidence:** claim 3 is no longer true. `lastMessageSentAt` exists as a **persisted registry
field**: declared `app/host/registry.ts:130`, initialised `:699`, stamped only by
`markMessageSent` (`:779-785`), surfaced on the descriptor at `app/host/host.ts:810` and
`app/shared/hostApi.ts:108`. It is bumped from exactly one place — `app/host/host.ts:191-198`,
gated on `!frame.replay && frame.event.type === 'message' && frame.event.message.type === 'result'`,
i.e. a live turn-end and never an open/restore replay. The sidebar consumes it:
`sidebarState.ts:308-312 sidebarActivityKey` = `lastMessageSentAt ?? transcriptActivityAtMs ??
createdAtMs` for registry rows, with the transcript-activity step explicitly there so that
opening a terminal session (whose `createdAt` is the click moment) does not float it.
Claim 4 is also stale: `git status` shows `sidebarState.ts`/`shellState.ts` clean at HEAD.
**Reachable-path trace:** host `result` frame → `registry.markMessageSent` → descriptor
`lastMessageSentAt` → `sidebarActivityKey` → `compareSidebarActivity` →
`sortSidebarSessionRows` → `Sidebar.tsx:474` (mounted from `App.tsx:2919`).
**Anchor drift:** n/a. The row is understated, not overstated — the risk is a future
session re-deriving a signal that already ships.

### CC-3 — Orphaned sidecar leak: idle-TTL + evict-reap + one-shot cleanup
**Verdict:** TRUE
**Claims checked:** (1) idle-TTL, default 15 min, env-overridable, connection-gated, armed
on construct and on last-disconnect, cleared on connect; (2) evict-reap in
`registry.enforceBound()` gated on the §9-A3 identity check, never pid alone; (3) one-shot
`reap:orphans` script, dry-run by default, keeps sidecars with a live parent; (4) restore
never attaches to an orphan.
**Evidence:**
(1) `app/sidecar/index.ts:58 DEFAULT_SIDECAR_IDLE_TTL_MS = 15 * 60 * 1000`, parsed at `:215`,
passed at `:244` with `onIdle` at `:250`. `sidecarServer.ts:550-562 armIdleTimer` returns
early if `connections.size > 0` and **re-checks the connection count at fire time**;
armed on construct (`:530`) and on last disconnect (`:770-774`), cleared by `clearIdleTimer`
(`:566-571`).
(2) `registry.ts:587-624` — `enforceBound` filters to `r.shutdown !== null && r.shutdown !== 'parked'`
before anything is doomed, so **a live row (`shutdown === null`) can never enter the victim
set**, and a parked row (an open tab) is excluded too. Each doomed pid is then re-gated on
`matchesSidecarIdentity` (`:531-543`): pid alive **and** the row's `socketPath` still exists
**and** the process cmdline contains the injected sidecar marker; with no marker configured
it refuses to kill. A recycled pid and a cleanly-closed session's dead pid both fail.
(3) `app/package.json:18 "reap:orphans"` → `app/scripts/reap-orphan-sidecars.ts`; orphan is
`ppid === 1 || !isProcessAlive(ppid)` (`:90`), `--confirm` required or it prints and exits
(`:175-178`).
(4) `host.restoreSession` refuses when `registry.hasLiveAdvisorySidecar(appSessionId)`
(`host.ts:323`) and always re-spawns via `spawn({resumeEngineSessionId})` (`:365-370`).
**Reachable-path trace:** launch sweep / `enforceBound` → identity check → SIGTERM; and
sidecar self-exit on TTL with socket unlink. Probe: `app/sidecar/idleTtl.probe.test.ts`
(real sidecar).
**Anchor drift:** none checkable (the row cites no line anchors).

### CC-6 — Registry bound 32 → 256 + HC4 cap split
**Verdict:** TRUE
**Claims checked:** (1) `MAX_REGISTRY_SESSIONS` is 256 at `registry.ts:72`; (2) a new
`MAX_LIVE_SESSIONS = 32` in `app/shared/hostApi.ts` now carries the HC4 live-process cap,
formerly `host.ts:640`; (3) `devHarness.ts` pinned to a literal 128; (4) live rows still
never reaped; (5) the `'parked'` exclusion untouched.
**Evidence:** (1) `app/host/registry.ts:72 export const MAX_REGISTRY_SESSIONS = 256` —
**exact anchor match**, the one anchor in this lane that did not drift. (2)
`app/shared/hostApi.ts:245 export const MAX_LIVE_SESSIONS = 32`, consumed at
`app/host/host.ts:717-719` `if (this.liveCount() >= MAX_LIVE_SESSIONS)`. The two constants
are genuinely independent — no code derives one from the other, and `registry.ts:58` and
`host.ts:713` both carry comments naming the split. (3) `app/main/devHarness.ts:225
const MAX_ITEMS = 128` with the "deliberately NOT derived" rationale at `:218-224`.
(4)(5) `registry.ts:594` `.filter(r => r.shutdown !== null && r.shutdown !== 'parked')`.
**Reachable-path trace:** open a history session → `upsertOnSpawn` mints a row →
`reap()` → `enforceBound()`; at ≤256 rows it returns `[]` at `:587` and evicts nothing.
**Anchor drift:** `host.ts:640` → `:717`; `devHarness.ts:215` → `:225`;
`registry.ts:578` → `:594`. All three cited symbols still exist and still say what the row
says they say.

### CC-23 — Compacted terminal session restored as a near-empty desktop conversation
**Verdict:** TRUE (for the 🟡 code-complete claim the row actually makes; its ⬜ operator
GUI acceptance remains open by the row's own admission)
**Claims checked:** (1) display loading follows persisted `logicalParentUuid` across compact
seams; (2) archival display is merged with the exact visible seed tail; (3) live resume and
worker backfill use the same normalized-seed merge; (4) both fail closed on divergent
raw-only history; (5) display/backfill reads bounded at 8 MiB / 4,000 messages; (6) a
one-byte alignment probe preserves a complete first record at an exact byte boundary;
(7) the compacted model seed itself is unchanged.
**Evidence:**
(1) `src/utils/sessionStorage.ts:4574-4616 loadDisplayTranscriptFromJsonlPath` calls
`loadTranscriptFile(..., {keepCompactedHistory: true})` and builds via
`buildDisplayConversationChain` (`:2724-2731`), which is `buildConversationChain` with
`followCompactLogicalParents: true`. Root-parent resolution falls back to
`root.logicalParentUuid` for a compact-boundary root (`:4602-4605`). **This is a different
chain topology, not "show more rows."**
(2)(4) `app/sidecar/historyProjection.ts:29-60 mergeDisplayHistoryWithSeed` — UUID-aligns the
seed against the display tail; on no alignment it returns `{history: seedHistory, truncated: true}`,
i.e. fails closed to the exact model seed rather than showing divergent context.
(3) live resume: `app/sidecar/index.ts:184-212`. Worker: `app/sidecar/transcriptBackfillWorker.ts:60-62,
127, 153-163` — the same three imports, the same merge.
(5) `app/shared/limits.ts:141-142` — `MAX_HISTORY_REPLAY_FRAMES = 4_000`,
`MAX_HISTORY_REPLAY_BYTES = 4 * 1024 * 1024`; both call sites pass `MAX_HISTORY_REPLAY_BYTES * 2`
= 8 MiB with the 2× rationale in the comment. Matches the row.
(6) `src/utils/sessionStorage.ts:4247-4251` — a literal one-byte read at `start - 1` testing
for `0x0a`, then `:4266-4272` drops the partial first line only when the boundary is not aligned.
(7) `index.ts:184-186` states and preserves it: only the display loader crosses seams.
**Reachable-path trace:** restore/resume → `sessionResume` → `index.ts:188` (`resumedMessages !== undefined`)
→ display load + merge + `withRestoredSubagentHistory` → `historyEvents` handed to
`SidecarServer` → replayed to the renderer transcript.
**Anchor drift:** none — every path the row names exists and holds the described code.

## Findings

| # | Severity | Row | Defect | Evidence | Failure scenario |
|---|---|---|---|---|---|
| F1 | High | P3-8 | The program's anti-Potemkin GATE was cleared against a click-spawns-engine restore path that was later deleted (CC-5 cut-list §I.1 ruling #3, CC-16 ✅ 2026-07-27, PL-A preload). Today a click renders a **cached transcript with no engine**; the engine resumes only on composer focus/pointer-down/submit. The gate has never been re-run against this sequence, and the SSR-only renderer suite cannot execute it. | `App.tsx:1926-1965` (preview-first `performRestore`), `App.tsx:3741-3752` + `:4360, 4397-4398` (spawn only on intent), vs `app/host/lifetimeChain.probe.test.ts:20-22` which explicitly defers the model-answers proof to the operator gate | After a quit/relaunch, a user opens a restored session and sees a complete, correct transcript. If the lazy `restoreLiveSession` leg is broken (bad cwd, pruned transcript, `hasLiveAdvisorySidecar`), nothing distinguishes that from a working restore until they type and the shell-error bar fires. The gate exists precisely to exclude a restore that is only a re-render, and it no longer covers the path users take. |
| F2 | Low | P3-8 | Four of five cited anchors are dead or moved; one points at unrelated code. A live source comment carries the same drift. | STATUS `sessionStorage.ts:240` → now `getProjectDir`/`getTranscriptPath`, no worker verification; `sessionRestore.ts:493` → `processResumedConversation` is at `:646` (and `app/sidecar/sessionResume.ts:13` repeats the stale `:493`); `sessionStorage.ts:4275` → `:4669`; `conversationRecovery.ts:427` → `:458`; `loadFullLog :3358` → `:3639` | A future session verifying the gate opens `sessionStorage.ts:240`, finds a memoized path helper, and either concludes the claim is fabricated or gives up on re-verification. |
| F3 | Low | P4-22 | The clause "picking a restorable Sidebar / ⌘K row now restores IMMEDIATELY" describes a mechanism superseded by CC-16/PL-A: picking now opens a cached preview and defers the spawn. | `App.tsx:1943-1955` returns after `openPreviewPane` on a cache hit, before any `restoreSession` | Reading P4-22 as current gives the wrong mental model of when an engine process is created, which is exactly the confusion F1 turns on. The row's headline (no confirm modal, no overlay) is unaffected and TRUE. |
| F4 | Low | P4-55 | The row lists `HydrationOverlay` among the surfaces it left untouched. That component was deleted by P4-22 on 2026-07-09, three weeks before the row was written. | repo-wide grep for `HydrationOverlay` outside `docs/` returns zero hits | Signals the row's scope statement was written from stale context; a reader could go looking for a component that does not exist. |
| F5 | Medium | CC-2 | The row states the operator's "reorder ONLY on message-send" spec "stays deferred (still needs a `lastMessageSentAt` signal)" and that the partial fix is uncommitted. Both are stale: the signal is built, persisted, stamped from exactly one live turn-end, consumed by the mounted Sidebar, and committed. | `registry.ts:130, 699, 779-785`; `host.ts:191-198, 810`; `hostApi.ts:108`; `sidebarState.ts:308-322`; `Sidebar.tsx:474`; `git status` clean on `sidebarState.ts` | A session picking up CC-2 re-derives a signal that already ships, or the operator believes a fix they asked for is still outstanding. STATUS understates rather than overstates, so no user-facing harm. |

## Operator steps required (UNVERIFIABLE-HEADLESS rows only)

None of the nine rows is filed UNVERIFIABLE-HEADLESS, but F1 is only closable live. The
exact re-run that would close it, in one pass:

1. Launch `bun run --cwd app dev`. Open two sessions in different cwds. In each, send a turn
   containing a distinct nonce word (e.g. `ARDVARK-A` / `BOBCAT-B`). Note both engine PIDs
   (`pgrep -lf "Cat Code Dev"` plus the sidecar pids printed by main).
2. Quit the app cleanly (⌘Q). Confirm both sidecar processes are gone.
3. Relaunch. Click session A's Sidebar row. **Do not type.** Confirm the transcript renders
   AND that no new sidecar process exists yet — this is the step the old gate never had.
4. Click into the composer, type `what was my magic word?`, press Enter once.
5. Confirm: (a) the answer is `ARDVARK-A`; (b) a NEW sidecar pid now exists; (c) main logs
   `[sidecar] resume-seeded messages=N` with N ≥ the pre-quit turn count; (d) the same
   `<engineSessionId>.jsonl` under `~/.cat-code/projects/<cwd>/` grew, with the new records
   stamped by the new pid's session.
6. Repeat 3–5 for session B (`BOBCAT-B`) to prove the two are not crossed.
7. Crash arm: with both sessions live, `kill -9` the Electron main pid only. Relaunch and
   confirm main logs `[registry] swept orphaned sidecar pid=…` for both, the rows come back
   marked crashed-but-restorable, and steps 3–5 still pass.

## Nits

- `aria-label="Dismiss shell error"` (`App.tsx:3177`) uses "shell", internal vocabulary, in a
  user-readable label. `Dismiss error` would read the same to a screen reader and leak nothing.
- P4-16's row contradicts itself within one cell ("no reachable in-app trigger yet" vs
  "It WAS in fact reachable"). The later sentence is the correction, but a reader hits the
  wrong one first.
- `app/sidecar/historyProjection.ts` has no `logicalParentUuid` reference despite CC-23
  naming it as an owner file for that behavior; the seam-crossing actually lives in
  `app/sidecar/index.ts` + `src/utils/sessionStorage.ts`. Ownership list is imprecise, not wrong.
- `app/main/main.ts` is dirty in the working tree (another session's in-flight work). All
  verdicts above were taken against committed `HEAD` behavior.
