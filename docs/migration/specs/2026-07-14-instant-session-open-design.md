# Instant session open — cached transcript first, lazy engine connect

**Date:** 2026-07-14 · **Status:** proposed design (NOT a locked decision) ·
**Revised 2026-07-14** after a source-backed design review (verdict REVISE,
8 findings — all addressed; the original draft's "raw buffer replay + security
baseline untouched" mechanism was wrong and is withdrawn). **Scope:** desktop
app (`app/`) restore/switch UX. Companion to
`docs/reports/2026-07-07-session-switch-restore-performance.md` (F1–F5;
strategies #1–4 shipped in `56f5904`) and `decisions/RESTORE-HISTORY.md`.
Design only — the implementing session owns file-level scoping, tests, and
STATUS bookkeeping.

## Problem

Opening a session that has no running sidecar (typically: any session after an
app relaunch) blocks the transcript behind the whole cold chain: spawn → engine
boot → resume → replay → first render. Measured 2026-07-14 on the production
spawn path (20 runs, temp config home): **~0.6 s to engine-ready, flat across
transcript sizes** (fresh 584 ms avg · resume of a p90 ~3.6 MB transcript
616 ms avg; replay delivery of 329 frames ~10 ms). In the live dev app the
perceived wait is 1–2 s, and with no restore affordance (report F4, never
built) it reads as a hang.

The user goal is NOT "type sooner" — it is "see the transcript immediately".
Typing can wait for the engine; reading should not.

## Design in one paragraph

Decouple transcript display from engine connection. On session close/quit,
main persists a **transcript-only cache** distilled from its per-session
replay buffer (`app/main/replayBuffer.ts`) — never the raw buffer. Clicking a
restorable session opens a **preview pane** that renders instantly from that
cache via a dedicated preview store (never the live-frame fan-out). The
sidecar spawn happens lazily on real engagement, and when the live replay
arrives the pane **swaps wholesale** from preview to live projection. No
engine processes are pre-warmed; no transcript parsing happens outside the
engine (the cache stores the sidecar's own already-emitted frames).

## Why this shape (constraints that force it)

- **Warm engine pools are rejected by arithmetic.** One sidecar ≈ 286 MB RSS
  (measured live); the last-24h set is 36–37 sessions ≈ ~10 GB on a 24 GB
  machine. Report F1 already concluded pooling is misdirected.
- **Transcript JSONL can only be parsed by engine code.** The host plane is
  engine-free by design (`docs/reports/2026-07-08-app-engine-duplication-review.md`;
  CLAUDE.md mistake #10). Caching **already-produced frames** sidesteps
  parsing entirely.
- **Locked decisions untouched:** N-process, die-with-window v1, raw
  `AppSessionEvent` fidelity, UDS transport — all as-is.
- Security surface DOES change, in two enumerated places (see §Security
  delta) — the original draft's "baseline untouched" claim was wrong.

## Mechanism

### M1 — Persist a transcript-only cache (review findings 2, 5, 6)

**Content.** The cache is a new versioned artifact (`TranscriptCache`), NOT
the raw `ServerFrame[]` buffer. At snapshot time main filters the session's
replay buffer to transcript-bearing frames only: message `event` frames
(replayed or live) plus the truncation-boundary frame. **Excluded by
allowlist:** `ready`, permission frames, and every operational snapshot
(accounts, settings, tasks, goals, agent-config, extensions, diagnostics).
Rationale: the live delivery path fans every frame into all renderer stores
(`app/renderer/src/serverFrameBatch.ts:93-101`); replaying a cached `ready`
would mark a dead session connected/input-enabled and resurrect stale
actionable permission prompts. Cache hydration must be able to touch nothing
but transcript state.

**Write transaction.** Every point that today evicts the buffer becomes
**snapshot → atomic persist → evict**, in that order:
- terminal lifecycle frame in main (currently clears the gate immediately,
  `app/main/main.ts:348-351`);
- host `closeSession` (currently kills then evicts, `app/host/host.ts:391-397`);
- `shutdownAll` quit path — SYNCHRONOUS by design (`app/host/host.ts:503`),
  so the persist here is a synchronous atomic write (temp file + fsync +
  rename), bounded by live-session count × ≤8 MiB.
An optional periodic flush bounds crash loss; a crashed session without a
cache simply falls back to the no-cache path.

**File hygiene (all fail-closed).** 0700 directory / 0600 files; atomic
write + fsync; header `{appSessionId, engineSessionId, protocolVersion,
appVersion, guardVersion, writtenAt}`; reads are size-bounded (reject > buffer
budget) before parsing; parsed frames are runtime-schema-validated; any
mismatch, corruption, or version drift ⇒ treat as no-cache AND delete the
file. Cache files are deleted when their registry row is reaped or their
`engineSessionId` no longer matches.

**Secret posture.** Cached frames were secretGuard-scanned when the sidecar
emitted them; the cache adds (a) a second at-rest copy — same trust domain as
the transcript JSONL itself, mitigated by the file permissions above and
delete-on-reap — and (b) guard-version drift: a frame the CURRENT guard would
block could replay from an old cache. Mitigation: the `guardVersion` stamp;
mismatch discards the cache. (Main is engine-free and cannot re-run the
engine's guard at read time; version-gating is the design answer.)

### M2 — Preview request path (finding 1)

The renderer today has no way to ask for a cache — `restoreSession(id)`
spawns immediately through the host. Add **one fixed, ID-only, read-only
bridge method** (illustrative name `previewSession(appSessionId)`):
- preload allowlist grows by exactly one method; the renderer sends an id and
  nothing else;
- main validates the id against the current restorable roster (host registry
  view) before touching disk; unknown/non-restorable ids are rejected;
- the validated cache is delivered to a **dedicated preview ingestion** that
  feeds ONLY a per-session preview transcript store (projector-compatible
  rows). Cached frames never enter `applyServerFrameBatch`, so connection,
  permission, and snapshot stores are unreachable from cache data by
  construction.

This is a real (if minimal) control-plane expansion. Per the baseline
discipline (CLAUDE.md mistake #5) it ships with: validation at main, a
boundary test (invalid / unknown / live-session ids rejected), and this spec
as its decision reference.

### M2b — Preview panes (finding 4)

Today restorable rows can never own a pane: focus correction clears any
active id not in the LIVE tab set, and tabs/panels are live-only
(`app/renderer/src/App.tsx:511-531` — "Restorable-only rows never
auto-focus"). Define a renderer-owned **preview membership** state:
- pane/tab roster becomes live ∪ previewing; selecting a restorable row opens
  a preview pane (no spawn);
- focus correction treats previewing ids as valid owners;
- closing a preview tab drops preview state only (no process to kill);
  a reaped registry row force-closes its preview;
- workspace splits may hold preview panes like live ones;
- on spawn, the pane transitions preview → live **in place** (the
  `appSessionId` is the pane key in both states).

### M3 — Lazy connect on engagement (finding 8)

The composer in preview state is **focusable-readOnly (not disabled)** — the
current composer is a genuinely disabled control and cannot receive focus or
keys, so it cannot be the trigger as originally drafted. Trigger:
first composer focus / pointer-down, OR ~300 ms dwell on the pane, whichever
comes first ⇒ fire the existing `restoreSession`. Until `ready` +
input-enabled (live connection state only — never cache-derived), the
composer shows a quiet "connecting…" hint and stays readOnly.

**Cache-miss policy:** no cache ⇒ spawn immediately on click (today's
behavior) + the M5 skeleton. Only cache hits defer the spawn.

### M4 — Swap, don't merge (findings 3, 7)

**Provenance is structural, not per-frame.** Preview rows live in the preview
store; live rows live in the existing live projection. No new frame tags;
`replay:true` keeps its sole meaning (sidecar attach history). The pane
renders preview rows only while the session has no live replay yet.

**Swap rule.** When the live session's replay completes (its replay boundary
/ first post-replay state), the pane swaps to the live projection and the
preview entry is dropped via a per-session preview-reset action. A live
session with zero history swaps to the empty transcript (the stale cache must
not win); a truncation-only replay swaps to the truncation boundary per the
existing visible-lossiness idiom.

**Coalescing (required for the one-commit swap).** Post-attach, frames are
delivered one per IPC send — the attachment gate returns single frames once
the renderer is attached (`app/main/attachmentGate.ts:39-42`) and the
supervisor emits each decoded frame separately. `serverFrameBatch` only folds
frames already grouped into one delivery. So main must coalesce a lazy-spawned
session's `replay:true` frames per session — accumulate until the first
non-replay frame or a short flush window, then deliver as ONE `frames[]`
batch (bounded by the existing 400-frame / 4 MiB replay caps). Outbound-only;
the `deliver(frames[])` shape already exists (`56f5904`), so no wire change.

### M5 — Affordance (report F4, finally)

Preview rows render under a "restored session" divider; preview/connecting
states show as a skeleton/badge, never an empty pane. The no-cache fallback
gets the skeleton too — this alone fixes the "reads as a hang" half and is
the cheapest piece of the design.

## Security delta (finding 5 — replaces the withdrawn "untouched" claim)

| Surface | Change | Required with it |
|---|---|---|
| Preload bridge | +1 fixed ID-only read-only method (`previewSession`) | main-side roster validation; boundary test; hardening allowlist update acknowledged in the smoke |
| At-rest data | new per-session `TranscriptCache` files | 0700/0600, atomic+fsync, size-bounded reads, schema validation fail-closed, version/guard stamps, delete-on-reap |
| Renderer stores | preview ingestion path | transcript-only by construction (allowlist filter at write AND dedicated store at read); a test that a cached `ready`/permission frame can never reach connection/permission stores |
| Sidecar inbound vocabulary | none | — |
| Wire protocol / version | none (additive batching within the existing `frames[]` delivery) | — |

## Costs (measured 2026-07-14, user's real data)

| Item | Cost |
|---|---|
| Disk cache | ≤ 8 MiB/session hard cap; last-24h set = 37 files, 48.7 MB raw / **36.2 MB under the 4 MiB replay cap** — trivial |
| Click → transcript visible (cache hit) | bounded disk read + preview-store fold ≈ tens of ms (live-path fold measured ~9 ms) |
| Engine connect (hidden behind engagement) | ~0.6 s measured floor, unchanged |
| Renderer RAM | preview stores loaded per click, dropped on swap/close — no launch-time bulk preload |
| RAM avoided vs warm-pool alternative | ~286 MB × N (≈10 GB for the 24h set) |

## Non-goals

- Pre-warming engine processes (rejected above).
- Transcript virtualization / packaged-build render work — separate
  measure-first item (report strategy #6); the residual DOM-mount cost is
  real, unmeasured headlessly, and dev-build-amplified (report F3).
  Acceptance below includes the packaged-build measurement.
- A shared "reader" engine process for never-cached sessions — deferred
  unless the no-cache path proves common.
- Any change to sidecar inbound frames or `protocol.ts` versioning.

## Open questions for the implementing session

1. Periodic-flush cadence (crash-loss bound) vs write amplification.
2. Dwell-trigger tuning (and whether hover-prefetch — the deferred STATUS
   follow-up — is layered on top).
3. Where `guardVersion` is sourced from so main can stamp it without engine
   imports (build-time constant is the likely answer).
4. Whether the swap should animate/cross-fade if the preview and live tails
   differ visibly.

## Acceptance sketch

- Cache-hit click → transcript visible well under 100 ms (headless fold
  timing + operator glance per GUI-VERIFICATION.md).
- Boundary tests: `previewSession` rejects unknown/non-restorable/live ids;
  cached `ready`/permission frames cannot reach connection/permission stores;
  corrupt/oversized/version-mismatched cache ⇒ no-cache fallback + file
  deleted.
- Swap correctness: zero-history live session ends empty; truncation-only
  replay shows the boundary; no duplicate rows after swap.
- Composer never enabled by cache data; enabled only by live ready +
  input-enabled.
- Quit path persists synchronously (snapshot → persist → evict order proven
  by test) and relaunch previews what was open.
- Hardening smoke all-pass with the +1 preload method accounted for;
  `bun test app/` and both tscs green.
- One packaged-build measurement of click→painted on a p90 session, recorded
  in the report, closing the DOM-mount unknown.
