# Instant session open — preload + backfill (follow-on plan)

**Date:** 2026-07-15 · **Status:** proposed follow-on plan · **Builds on:**
`2026-07-14-instant-session-open-design.md` (M1–M5) + its
`…-implementation-plan.md` (IS-A/B/C, all landed: commits `16b62d7`, `f17853b`,
`0826f5c`). **Scope:** desktop app (`app/`) restore/switch UX. Every source
anchor below was verified against current `app/` + `src/` source on 2026-07-15.

## Why this exists (the correction)

The shipped design makes clicking a **closed** session fast by reading its
at-rest transcript cache **on click** (one `previewSession` IPC → disk read →
fold → render). That is "fetch when clicked," not "already there" — so a switch
is *fast* but not *instant*, and a session with **no cache file yet** (everything
closed before the feature) falls to the eager-spawn path and shows the
"Restoring…" skeleton (report F4's slow half).

The original design rejected preloading under one blanket rule — *"no
launch-time bulk preload"* (design §Costs, Renderer RAM row). That rule
**conflated two very different costs** (design's own measured numbers, user's
real data):

| Preload what | Cost | Verdict |
|---|---|---|
| Warm **engine processes** (the "auto-connect" idea) | **~286 MB each ≈ 10 GB** for the 24h set | reject — this is the real RAM blowup |
| Warm **transcript caches** (text/JSON) | **~36 MB TOTAL** for the 24h set (37 files under the 4 MiB replay cap) | trivial — preloading is nearly free |

Preloading the *caches* is three orders of magnitude cheaper than preloading
*processes*. The blanket rule threw out the cheap win with the expensive one.

**Corrected model (this plan):** load every session's transcript UI into the
renderer up front (bounded budget) → switching any closed session is instant
(already in memory, no click-time IPC/disk, no "Restoring…") → the engine still
connects **lazily after you open** (IS-B, unchanged — no warm processes, no RAM
blowup).

Nothing from IS-A/B/C is discarded: the cache format, `distill`, atomic
fail-closed read (`app/main/transcriptCache.ts`), the `previewSession` bridge,
the `previewTranscriptState` store + projector, lazy-connect, and the
preview→live swap (`app/renderer/src/App.tsx`, `previewTranscriptState.ts`) are
the engine of this feature. This plan changes **when the store is filled** and
adds **coverage for uncached sessions**.

## Locked decisions untouched

N-process · die-with-window v1 · raw `AppSessionEvent` fidelity · UDS transport ·
two-id model. Wire protocol untouched (preload reuses `previewSession`; backfill
writes cache files main already owns). Nothing here reopens a locked decision;
the "no bulk preload" line is a design cost-note, **not** a `decisions/` entry.

## Phase split

Two phases, independent in value. **PL-A ships the felt win alone.**

| ID | Title | Depends on | Model · Difficulty |
|---|---|---|---|
| PL-A | Preload all existing caches at startup | IS-A/B | ANY · 5/10 · 🖐 GUI |
| PL-B | Backfill caches for uncached sessions | IS-A + PL-A | CLAUDE (system-architecture) · 8/10 |

---

## PL-A — Preload existing caches at startup

**Goal.** After the roster hydrates on launch, populate the preview store for
**every restorable row that already has a cache file**, so a later click renders
from memory with zero IPC/disk. No pane opens until you click; the engine still
connects lazily on engage.

**What makes a switch instant here.** Today `performRestore` (`App.tsx:1019`)
`await`s `bridge.previewSession(id)` on click. After PL-A the store is already
populated, so the click path checks the store **first** and opens the pane
synchronously (no await); the on-click fetch remains only as the not-preloaded
fallback.

**Files.**

- **`app/renderer/src/App.tsx`** — a startup preload effect:
  - After the host roster hydrates (`App.tsx:502-556`, `listSessions()` at ~545)
    and `restorableIds` is derived (`App.tsx:706`), fire `previewSession(id)` for
    each restorable id **up to a bounded budget** (below) and dispatch
    `preview-load` into the existing preview store **without** a `preview-open`
    (populate store, do NOT open a pane).
  - Change `performRestore` (`App.tsx:1019`) so a click on a session already in
    the preview store opens the preview pane from the in-memory entry
    immediately (no `await`); the disk fetch stays as the miss fallback.
  - **Store/pane decoupling — verified ALREADY SAFE; do NOT edit `App.tsx:584-593`
    (cold-review correction).** Preloading fills the store for ids with **no** pane.
    The reconciliation effect at `App.tsx:583-593` iterates preview **panes**
    (`shell.previews`) and closes a pane when the **store** lacks an entry
    (`hasPreviewTranscript`, `previewTranscriptState.ts:102`) — it never iterates or
    drops store entries, so a preloaded store-only id is invisible to it and is NOT
    force-dropped. Leak is already prevented: `session-removed` drops the store entry
    (`App.tsx:537`). **Editing 584-593 is a REGRESSION risk** — it exists to close a
    pane whose store was reset on swap (`App.tsx:495`). So the store/pane decoupling
    is wiring, not a rewrite. The two real PL-A changes are the preload effect above
    and the store-first `performRestore` below.
- **`app/renderer/src/previewTranscriptState.ts`** — no shape change expected
  (`preview-load`/`preview-reset` already exist); add a selector for "is this id
  preloaded" if the click path needs it. **Correction (cold review):** N awaited
  `previewSession` responses are N separate `preview-load` dispatches — React
  auto-batching does NOT span `await`, and `withBatch` only coalesces frames WITHIN
  one cache — so the N-call path is N renders, not one. Mitigate by deferring the
  preload loop off the launch-paint critical path (after first paint, throttled)
  and/or the batch `previewSessions` method (O3), NOT by assuming a single render.

**Bounded budget — cap BOTH RAM and launch-CPU (cold-review correction).** Two
costs, not one:
- **RAM:** the renderer holds **projected `TranscriptState`** (parsed row models via
  `projectServerFrame`), materially LARGER than the ~36 MB disk-serialized figure the
  design measured (`design:189`). Size the budget on projected in-memory footprint,
  measured — not the disk number.
- **Launch-CPU:** every preloaded `previewSession` runs `readCache` →
  `scanForSecrets` (`transcriptCache.ts:221`), a full recursive frame-tree walk
  (`secretGuard.ts:57-93`) on the **Electron main thread**, N times, at the most
  paint-sensitive moment. This partly trades the design's deliberate one-at-a-time
  on-click cost for an all-at-once launch cost. Run the preload loop AFTER first
  renderer paint, throttled; never block the window on N scans.

Cap by **most-recent-first up to a budget** (K most-recently-attached rows or a
projected-bytes cap). Rows beyond it keep today's on-click fetch (still fast) — only
their *first* open costs the IPC. `log` the cap; never silently preload all. Order by
`SessionDescriptor.lastAttachedAt` (`app/shared/hostApi.ts:86`).

**Optional optimization (defer unless N-IPC shows up in the measurement):** a
batch bridge method `previewSessions(ids[])` folds N reads into one main-side
pass (one secret-scan batch, one round-trip). Costs a **new preload method** →
hardening allowlist + boundary test (the IS-A discipline). PL-A ships first with
**N `previewSession` calls** (zero new inbound surface, existing boundary) and
only adds the batch method if the per-call overhead is measurable.

**Tests.**

- Startup preload populates the store for cached restorable ids without opening
  panes; a subsequent click opens from the store with no `previewSession` call
  (spy asserts zero on-click fetch for a preloaded id).
- The reconciliation effect keeps a preloaded-but-unopened store entry; a
  session-removed/reap drops it; closing a preview pane drops only its pane, not
  other preloaded entries.
- Budget cap: with > budget restorable rows, only the most-recent K preload; the
  rest fall to on-click fetch (still works).
- No regression: cache-miss id still eager-restores + shows the IS-C skeleton;
  fresh `New session` still Welcomes.

**Battery.** `bun test app/` · both tscs · `renderer:build` · `test:hardening`
(re-run; no new inbound surface unless the batch method is added — then +1
method acknowledged in `expectedBridgeKeys`).

**GUI (🖐).** The win is visual/perceptual — STOP and print operator steps: close
a session with this build (writes cache), relaunch, click it → transcript
appears with **no "Restoring…"** and no perceptible delay (it's preloaded). Also
verify a large all-time roster still launches promptly (budget cap holds).

---

## PL-B — Backfill caches for uncached sessions

**Goal.** "Instant for **all** sessions" — including ones closed before the
feature — needs a cache for sessions that have none. Build it from the transcript
already at rest (the same transcript `restore` reads), so a first-ever open of an
old session is also instant.

**The hard constraint (why this is its own phase).** The transcript→frames
machinery is **engine-graph only**:
- `loadConversationForResume(id)` deserializes the transcript JSONL → `Message[]`
  (`app/sidecar/sessionResume.ts:68`, wrapping `src/utils/conversationRecovery.ts:465`).
- `toSDKMessages(messages)` converts those to the history-replay events the
  renderer projects (`app/sidecar/index.ts:173`, decision `RESTORE-HISTORY.md`).

Both import `src/` (the engine graph). **Main is Electron and engine-free by
architecture** (CLAUDE.md §1/§5) — it CANNOT run these. And the full
`resumeEngineSession` mutates process-global state via `switchSession`
(`sessionResume.ts:80-102`, `getSessionId()` adoption), so it is strictly
one-session-per-process (N-process locked decision). So backfill must run in a
**sidecar-class engine-graph process**, not in main.

**Two strategies (the implementing session verifies which is possible).**

**O1 RESOLVED by cold review — the read is NOT pure; "one pure worker" is
impossible.** `toSDKMessages` stamps `session_id: getSessionId()` on every message
(`src/utils/messages/mappers.ts:123,134,154`), reading the module-global
`STATE.sessionId` (`src/bootstrap/state.ts:437`), mutated only by `switchSession`
(`:474`). And `loadConversationForResume` resolves the transcript path from the
**global cwd** (`getSessionProjectDir() ?? getProjectDir(getOriginalCwd())`,
`src/utils/sessionStorage.ts:4216`). So a worker reading N sessions across N project
dirs MUST `switchSession(id, projectDir)` per session — the exact global mutation
"pure" was meant to avoid. The realistic strategies:

- **B1 — one worker, serialized, side-effects suppressed (preferred).** ONE
  short-lived engine-graph process loops over uncached rows:
  `switchSession(id, projectDir)` → load → convert → emit frames → next. The
  singleton mutation is fine because iteration is SEQUENTIAL, not concurrent. Far
  cheaper than N processes. Feasibility now hinges NOT on purity but on cleanly
  suppressing resume side-effects (below).
- **B2 — one short-lived process per uncached session (fallback).** A
  `--backfill-cache` sidecar mode per session: load, emit replay frames, main
  caches, exit. Correct but O(N) spawns; serialize + bound (HC4 spawn-rate cap),
  background, never blocking the window.

**HARD requirement for BOTH (cold-review MAJOR) — suppress resume side-effects.**
`loadConversationForResume` is not a read: it fires **SessionStart hooks**
(`processSessionStartHooks('resume', …)`, `src/utils/conversationRecovery.ts:582`
→ user + plugin shell hooks, `src/utils/sessionStart.ts:35-65`), restores global
skill state (`:575`), and copies plan/file-history to disk (`:562-566`). Backfilling
would run arbitrary user shell hooks once per session the user **never opened** — a
real safety hazard. The worker MUST run hook-suppressed (only `--bare` suppresses
SessionStart hooks today) or use a leaner load path that skips hooks/skill/plan-copy.
B2's "reuse the real resume path" inherits this hazard wholesale; neither strategy is
safe without it.

**Cheap alternative — lazy-warm (recommended default; may make PL-B unnecessary).**
Do **no** proactive backfill. PL-A preloads everything already cached; a session
never opened with the feature is cache-miss on its *first* open (IS-C skeleton +
eager restore) — but that open **writes the cache on close** (IS-A
`persistTranscriptCache`, `main.ts:187`), so every subsequent open is instant.
After normal use, the whole active set self-warms. The only residual gap is the
*first* touch of a cold old session. **Recommendation: ship PL-A + lazy-warm,
measure how often a first-touch miss actually bites, and only build PL-B (B1/B2)
if the cold-first-open proves common.** This mirrors the design's own
"deferred unless the no-cache path proves common" stance (design §Non-goals).

**Security.** A backfill worker reads transcripts — same trust domain as resume
(engine-side). Output frames pass `secretGuard`; main's `readCache` already
re-scans on every read (IS-A). No new inbound surface; cache files are the
existing artifact. The worker writes cache files main GCs, or hands frames to
main to write — keep the writer single (IS-A owns the cache dir), decide in-phase.

**Tests / battery.** Deferred to the phase (depends on B1 vs B2). At minimum: a
backfilled cache round-trips through `readCache` identically to an on-close cache;
the worker never mutates a live session; O1 resolved with a source-cited answer.

---

## Cross-cutting

**Acceptance.**
- Relaunch → click a previously-open session → transcript instant, **no
  "Restoring…"**, engine connects only on engage (PL-A + operator glance).
- One click→painted measurement for a preloaded hit vs an on-click hit vs a miss,
  recorded (proves preload removes the per-click cost). Pairs with the still-open
  packaged-build measurement from the IS-C plan.
- Large all-time roster still launches promptly (budget + after-paint throttle hold).
- Hardening all-pass; `bun test app/` + both tscs green.

**Carried caveats (cold review).**
- "Instant" removes IPC/disk, **not** the DOM-mount of a large transcript — the
  design's separate, unmeasured non-goal (`design:196-201`). A p90 (~3.6 MB)
  transcript may still not *feel* instant on mount; that's virtualization/render
  work, a different fix. PL-A's acceptance is "no IPC/disk fetch + no Restoring…",
  not "zero render time."
- Staleness: store-first serves the launch-time in-memory copy. If a same-cwd
  concurrent window rewrites the cache file after launch, PL-A serves stale until
  swap-to-live on engage. Narrow (closed sessions don't change under you; swap
  corrects it) and accepted — noted so it isn't a surprise.

**Naming fix (carry-over from IS-C review).** "Restored session" (instant, done)
vs "Restoring session…" (slow miss) read alike — one word apart, opposite
meaning. With PL-A the miss label should become unambiguous (e.g. "Connecting…"
or "Opening…"). Trivial; fold into PL-A.

**STATUS / backlog.** The orchestrator assigns P-numbers and writes STATUS rows;
IS-A/B/C were dispatched from the plan doc without STATUS rows, so PL-A/B either
get rows or stay plan-tracked — operator's call. No PARITY-LEDGER rows (perf/UX,
no prototype counterpart).

**Open questions.**
- **O1 RESOLVED (cold review):** the read is not pure — global cwd path resolution
  (`sessionStorage.ts:4216`) + `getSessionId()` stamping (`mappers.ts:123`) — and
  fires SessionStart hooks (`conversationRecovery.ts:582`). See PL-B. Residual: pick
  B1 (one serialized worker, side-effects suppressed) vs B2 (process per session),
  and the exact hook-suppression path.
- **O2**: preload budget shape — count-cap vs byte-cap vs recency window; pick
  from a real measurement of the user's all-time set (24h set = ~36 MB; all-time
  is the unknown).
- **O3**: whether the batch `previewSessions` method is worth its +1 inbound
  surface, decided by PL-A's N-IPC measurement.
