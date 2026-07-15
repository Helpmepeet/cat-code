# Instant session open — implementation plan

**Date:** 2026-07-14 · **Status:** proposed implementation plan (companion to the
design) · **Design:** `2026-07-14-instant-session-open-design.md` (approved shape;
NOT a locked decision) · **Scope:** desktop app (`app/`) restore/switch UX.

This plan does the file-level scoping, session split, test list, and verification
battery the design deferred ("the implementing session owns file-level scoping,
tests, and STATUS bookkeeping"). Every source anchor below was verified against
current `app/` source on 2026-07-14.

## Decisions carried in (do not re-litigate)

- **Security posture: APPROVED as designed** (operator, 2026-07-14). Build the
  at-rest `TranscriptCache` with the design's mitigations verbatim: `0700`/`0600`,
  atomic write + fsync + rename, size-bounded reads, schema-validation fail-closed,
  delete-on-reap, `guardVersion` discard-on-drift. Treat the cache as the same
  trust domain as the transcript JSONL already at rest engine-side. Do NOT add or
  remove mitigations without a new operator ruling.
- **Locked decisions untouched:** N-process, die-with-window v1, raw
  `AppSessionEvent` fidelity, UDS transport. Nothing here reopens them.
- **Wire protocol untouched:** additive batching within the existing
  `deliver(frames[])` shape (`app/main/main.ts:144`, shipped `56f5904`). No new
  frame kind, no `protocol.ts` version bump.
- **Inbound sidecar vocabulary untouched:** the only new inbound surface is one
  read-only control-plane method (`previewSession`), main-validated. No new sidecar
  frame kind.

## Session split

Three sessions. **A → B → C** by dependency (B needs A's bridge + cache; C's
preview-specific states need B, though C's *no-cache* skeleton is independent and
could ship first as a standalone hang-fix if desired).

| ID | Title | Mechanisms | Model · Difficulty | Depends on |
|---|---|---|---|---|
| IS-A | Persist + read the transcript cache | M1 + M2 (bridge) | ANY · 7/10 | — |
| IS-B | Preview panes, lazy connect, swap | M2 (ingestion) + M2b + M3 + M4 | ANY · 8/10 | IS-A |
| IS-C | Restore affordance / skeleton | M5 | CLAUDE (visual-design) · 3/10 · 🖐 GUI | IS-B (no-cache skeleton: none) |

`ID` is a placeholder — the orchestrator assigns the real P-number and inserts the
STATUS rows per the migration loop (this plan does not write STATUS or backlog).

---

## IS-A — Persist + read the transcript cache (M1 + M2 bridge)

**Goal.** A dead session's transcript-bearing frames are distilled to a versioned
at-rest `TranscriptCache` on close/quit, and the renderer can fetch one by id over
a new read-only bridge method — with nothing but transcript state reachable from
cache data.

**Files.**

- **NEW `app/main/transcriptCache.ts`** — the artifact + codec:
  - `TranscriptCache` type; header `{appSessionId, engineSessionId, protocolVersion,
    appVersion, guardVersion, writtenAt}`.
  - `distill(frames): TranscriptCache` — **allowlist filter**: keep message `event`
    frames (replayed or live) + the truncation-boundary frame; **exclude** `ready`,
    permission frames, and every operational snapshot (accounts, settings, tasks,
    goals, agent-config, extensions, diagnostics). Rationale is the
    `serverFrameBatch` fan-out (`app/renderer/src/serverFrameBatch.ts:74-111`) — a
    replayed `ready` would mark a dead session connected/input-enabled and a
    permission frame would resurrect a stale actionable prompt.
  - `writeCache(cache)` — temp file + fsync + rename, `0700` dir / `0600` file.
  - `readCache(id)` — size-bounded (reject > buffer budget) **before** parse;
    runtime schema-validate; re-run `scanForSecrets` on the parsed frames; any
    corruption / schema drift / secret hit ⇒ return null **and delete the file**.
  - `deleteCache(id)` — called on reap / `engineSessionId` change (call sites wired
    in the `app/main/main.ts` bullet below).
  - re-run `scanForSecrets` (`app/shared/secretGuard.ts`) on every read; any hit ⇒
    null + delete (Q3 resolution below). Optional `GUARD_VERSION` fast-path only.
- **`app/main/replayBuffer.ts`** — add `snapshotSession(sessionId): ServerFrame[]`
  returning one session's frames (`snapshot()` today concatenates ALL sessions,
  `replayBuffer.ts:93-101`). Decide the `ready`-head ONCE: `snapshotSession` may
  include the permanent `ready` head like `snapshot()` does (`:96`) and `distill`
  drops it via the allowlist — do not assert both drop it. Small, pure, testable.
- **`app/main/main.ts`** — persist at every eviction point, order **snapshot →
  atomic persist → evict**:
  - terminal-lifecycle path (`main.ts:348-351`, currently `onFrame` then
    `clearSession`): snapshot that session, persist, then `clearSession`.
  - the `evictReplay` callback main wires into the host (`host.ts:131`,
    `options.evictReplay`): wrap it so host-driven eviction persists first. NB this
    callback also fires on `restartSession` (`host.ts:482`), not just close/quit, so
    a restart will now also persist a cache — harmless (bounded extra sync write),
    but confirm it's acceptable. The buffer lives in main's `AttachmentGate`; kill
    order in host is irrelevant because only eviction clears the buffer.
  - **quit path is synchronous** — `shutdownAll` evicts per session synchronously
    (`host.ts:513-518`); the persist inside the wrapped callback must be a
    synchronous atomic write there. Bounded by live-session count × ≤ 8 MiB.
  - add `ipcMain.handle(CH_HOST_PREVIEW, …)` alongside the existing host handlers
    (`main.ts:685-702`): validate the id against the host's restorable roster
    (below) → `readCache(id)` → return the cache or null. Never reads disk for an
    id the host does not vouch for.
  - **delete-on-reap wiring (approved mitigation — must not be left unwired):** call
    `deleteCache(id)` from main's `session-removed` HostEvent handler (`wireHostEvents`,
    ~`main.ts:361-367`), AND add a startup cache-GC deleting any cache file with no
    matching restorable row — launch-time registry reap runs BEFORE main subscribes
    to HostEvents, so those reaps emit no `session-removed`. The `engineSessionId`-
    change case is already covered by read-time validation.
- **`app/host/host.ts`** — one tiny read-only method, e.g.
  `canPreview(appSessionId): boolean` (NOT `isRestorable` — that name is already a
  private method, `host.ts:639`). It must encode **not-live + row exists + non-null
  `engineSessionId`**: the `restoreSession` block at `host.ts:241-259` checks only
  row/`engineSessionId`/`hasTranscript`; the not-live guard is separate
  (`host.ts:260-265`, `271-279`), so reusing 241-259 alone would wrongly accept a
  LIVE id and fail the IS-A boundary test. Cleanest: reuse the descriptor's
  `restorable` flag — `isRestorable(row, liveStatus)` forces `false` when live
  (`host.ts:624`, `:639-645`) — e.g. `listSessions().find(id)?.restorable === true`.
  Main's preview handler calls this before touching disk. No change to
  `closeSession`/`shutdownAll` logic itself.
- **`app/preload/preload.ts`** — `previewSession(appSessionId): Promise<…>` modeled
  exactly on `restoreSession` (`preload.ts:193-200`): id-only, rate/size-guarded,
  fixed `CH_HOST_PREVIEW` channel. **+1 method, nothing else.**
- **`app/shared/protocol.ts` or `app/shared/hostApi.ts`** — the `TranscriptCache`
  type + `CH_HOST_PREVIEW` result type (additive; no version bump).

**Tests.**

- `app/main/transcriptCache.test.ts` — distill drops `ready`/permission/every
  snapshot and keeps message + truncation frames; round-trip write→read; oversized
  / corrupt / `protocolVersion` / `guardVersion` mismatch ⇒ null + file deleted;
  perms are `0600`.
- `app/main/replayBuffer.test.ts` (extend) — `snapshotSession` returns exactly one
  session's frames; the `ready` head is dropped by `distill` (allowlist), not by
  `snapshotSession`.
- **Boundary test** (a handler test) — `previewSession` rejects unknown /
  non-restorable / **live** ids (never reads disk for them).
- Allowlist updates (the +1 method trips three enumerated allowlists): add
  `'previewSession'` to `expectedBridgeKeys` (`app/scripts/hardening-smoke.ts:231-254`),
  add `CH_HOST_PREVIEW` to `preloadSource.test.ts:79-83` and `mainSource.test.ts:164-168`
  (bump their "five host/control-plane methods" comment → six), and add
  `previewSession` to the `CatCodeBridge` type in `app/shared/protocol.ts`.

**Battery.** `bun test app/` · `bun run --cwd app typecheck` · `typecheck:sidecar`
wrapper · `bun run --cwd app test:hardening` (**+1 preload method acknowledged in
`expectedBridgeKeys`** — `app/scripts/hardening-smoke.ts:231-254`) · `renderer:build`
(unaffected but cheap to confirm).

**Security notes.** This is the security-sensitive session. The `previewSession`
method + at-rest cache are the two enumerated surface changes from the design's
Security delta. Hardening must stay all-pass with the +1 method counted; the
boundary test is the T-discipline gate (CLAUDE.md mistake #5).

**Design Q3 — RESOLVED by review (2026-07-15).** The design's premise ("main cannot
re-run the engine's guard at read time") is **wrong**: `scanForSecrets`
(`app/shared/secretGuard.ts`) is a pure, dependency-free **shared-layer** module, and
main already imports its siblings (`../shared/protocol.js`, `limits.js`, `hostApi.js`).
So main **re-runs the current guard on every cache read** via `scanForSecrets`,
discarding + deleting the cache on any hit — this closes guard-drift completely with
no version constant and no engine-graph import (main stays engine-free). `guardVersion`
is demoted to an optional fast-path; if kept it is a NEW constant main owns, not a
mirror (no such version exists in `src/` to mirror). This is no longer a blocker.

---

## IS-B — Preview panes, lazy connect, swap (M2 ingestion + M2b + M3 + M4)

**Goal.** Clicking a restorable row opens a preview pane rendered from the cache
(no spawn); real engagement lazily spawns; when live replay arrives the pane swaps
wholesale from preview to live projection.

**Files.**

- **NEW `app/renderer/src/previewTranscriptState.ts`** — per-session preview
  transcript stores (`Map<SessionId, TranscriptState>`) fed by cache frames through
  the SAME projector as live: `createTranscriptState()` + `projectServerFrame`
  (`app/renderer/src/transcriptProjector.ts:279,496`), i.e. the
  `projectServerFrameBatched = withBatch(projectServerFrame)` seam wired at
  `App.tsx:248,307` (there is NO `reduceTranscript`). Preview rows are
  projector-compatible by construction. A `preview-reset(sessionId)` action drops one
  session on swap. **Cache frames never enter `applyServerFrameBatch`** — and because
  `projectServerFrame` only builds transcript rows and never touches the
  connection/permission/snapshot stores, those are unreachable from cache data
  structurally (design M2/M4).
- **`app/renderer/src/shellState.ts`** — preview membership. Today `selectLiveSessions`
  filters by the run-local `tabs` set (`shellState.ts:170`) and `activeAfterLiveChange`
  only keeps live-tab owners (`shellState.ts:183`). Add a `previews` set (or hold it
  as App UI state, mirroring how `activeSessionId` is deliberately App-owned per the
  module header) and a pane-roster selector = **live ∪ previewing**; teach focus
  correction to treat previewing ids as valid owners.
- **`app/renderer/src/App.tsx`**:
  - on selecting a **restorable** row: call `bridge.previewSession(id)`, feed the
    per-session preview store, open a preview pane (no spawn). Today restorable rows
    never own a pane (`App.tsx:505-536`, "Restorable-only rows never auto-focus") —
    this is the behavior that changes.
  - lazy connect (M3): composer **focus / pointer-down OR ~300 ms pane dwell** ⇒ fire
    the existing `bridge.restoreSession(id)` (`host.ts:233`). Composer is
    **focusable-readOnly** in preview (the design flags today's composer as a
    genuinely *disabled* control that cannot receive focus — verify the composer
    component and switch disabled→readOnly). Composer enables ONLY on live `ready` +
    input-enabled, never on cache data.
  - swap (M4): on the live session's replay boundary / first post-replay state, swap
    the pane to the live projection and dispatch `preview-reset`. Zero-history live
    ⇒ empty transcript (stale cache must not win); truncation-only ⇒ boundary row.
    **Zero-history has no `replay:true` frames**, so the M4 coalescing flush cannot be
    the swap trigger there — key the swap off live `ready` + input-enabled (or first
    live frame), which is also M3's composer-enable signal. Confirm this
    "replay-complete for an already-attached session" signal exists during IS-B.
  - cache-miss: spawn immediately on click (today's behavior) + the IS-C skeleton;
    only cache hits defer the spawn.
- **`app/renderer/src/workspaceLayout.ts`** — allow a preview pane as a valid split
  panel member (`splitWorkspacePanel`), so workspace splits hold preview panes like
  live ones; pane key is `appSessionId` in both preview and live states (swap is
  in-place).
- **`app/main/attachmentGate.ts` (+ `main.ts`)** — M4 coalescing. Post-attach,
  `onFrame` returns single frames (`attachmentGate.ts:39-42`) and the supervisor
  emits each decoded frame separately, so `serverFrameBatch` never folds them. Add a
  per-session replay-coalescing buffer: accumulate a lazy-spawned session's
  `replay:true` frames, flush as ONE `frames[]` batch on the first non-replay frame
  OR a short flush window — bounded by `MAX_HISTORY_REPLAY_FRAMES` / `_BYTES`
  (`app/shared/limits.ts:67-68` = 400 / 4 MiB). **Outbound-only**, uses the existing
  `deliver(frames[])` shape — no wire change.

**Tests.**

- `previewTranscriptState.test.ts` — cache frames project to the same rows as live;
  `preview-reset` drops exactly one session; a cache `ready`/permission frame can
  never reach connection/permission stores (structural — assert the ingestion path
  has no handle to them).
- `shellState.test.ts` (extend) — pane roster = live ∪ previewing; focus correction
  keeps a previewing id; closing a preview drops preview state only; a reaped row
  force-closes its preview.
- Swap correctness — zero-history live ends empty; truncation-only shows the
  boundary; no duplicate rows after swap; swap is in-place (same pane key).
- Coalescing — a lazy-spawned session's replay frames arrive as one `frames[]`
  batch (flush-on-first-non-replay and flush-on-window both covered); caps enforced.
- Lazy-connect trigger — focus/pointer-down and dwell both fire exactly one
  `restoreSession`; composer stays readOnly until live ready + input-enabled.

**Battery.** `bun test app/` · both tscs · `renderer:build` · `test:hardening`
(no new inbound surface here, but re-run to confirm intact).

**Open questions handled here (tuning, implementer's choice):** Q1 periodic-flush
cadence, Q2 dwell tuning + whether hover-prefetch layers on, Q4 whether the swap
cross-fades when preview and live tails differ.

---

## IS-C — Restore affordance / skeleton (M5)

**Goal.** Preview/connecting/no-cache states read as *restoring*, never as an empty
pane or a hang. This is the cheapest piece and half of it (the no-cache skeleton)
is independent of A and B.

**Files.**

- `app/renderer/src/TranscriptView.tsx` (+ a small `PreviewSkeleton`/badge component)
  — preview rows render under a "restored session" divider; preview and connecting
  states show a skeleton/badge; the **no-cache fallback gets the skeleton too** —
  this alone fixes the "reads as a hang" half (report F4).

**Tests.** Render tests for the divider + each state (preview, connecting, no-cache);
no empty-pane state reachable while a restore is in flight.

**Battery.** `bun test app/` · both tscs · `renderer:build`.

**GUI (🖐).** The skeleton is a visual affordance — STOP and print exact operator
steps per `docs/migration/process/GUI-VERIFICATION.md` (launch, click a restorable
row, observe skeleton→transcript). Do not drive the GUI. Migration test turns use
`gpt-5.6-luna` low effort on a healthy account.

---

## Cross-cutting

**Acceptance (from the design, mapped to sessions).**

- Cache-hit click → transcript visible well under 100 ms — IS-B (headless fold
  timing) + IS-C operator glance.
- Boundary tests (`previewSession` rejects bad ids; cached `ready`/permission can't
  reach connection/permission stores; corrupt/oversized/version-mismatch ⇒ no-cache
  + file deleted) — IS-A + IS-B.
- Swap correctness (zero-history empty, truncation-only boundary, no dup rows) — IS-B.
- Composer never enabled by cache data — IS-B.
- Quit persists synchronously, order proven by test; relaunch previews what was
  open — IS-A (sync order) + IS-B (relaunch preview).
- Hardening all-pass with the +1 method; `bun test app/` + both tscs green — every
  session.
- One **packaged-build** measurement of click→painted on a p90 session, recorded in
  the report — IS-C (closes the design's DOM-mount unknown; dev-build amplifies it).

**STATUS / backlog promotion (not done by this plan).** The orchestrator assigns
P-numbers, writes the STATUS rows, and files the backlog prompts per the migration
loop. Each session updates its own STATUS row as its last step; parity is not in
play (this is a perf/UX feature, not a prototype surface) so no PARITY-LEDGER rows.

**What this plan intentionally does NOT decide** (left to the implementing session):
exact cache file directory + naming (home is the host registry data dir), periodic-
flush cadence, dwell/hover tuning, swap animation, and the precise composer
component to flip disabled→readOnly. All are tuning or trivially-scoped. Q3
(guard-drift) is **resolved above** — re-scan cache reads with `scanForSecrets`,
fail-closed — so nothing now blocks dispatch.
