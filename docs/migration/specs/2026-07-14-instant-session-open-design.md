# Instant session open — cached transcript first, lazy engine connect

**Date:** 2026-07-14 · **Status:** proposed design (NOT a locked decision) ·
**Scope:** desktop app (`app/`) restore/switch UX. Companion to
`docs/reports/2026-07-07-session-switch-restore-performance.md` (the F1–F5
ledger; strategies #1–4 shipped in `56f5904`) and
`decisions/RESTORE-HISTORY.md` (F2 replay). This doc is design only — the
implementing session owns file-level scoping, tests, and STATUS bookkeeping.

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

Decouple transcript display from engine connection. The transcript a user sees
first is served from a **persisted per-session replay cache** written by main's
existing `replayBuffer` machinery (`app/main/replayBuffer.ts` — per-session
`ServerFrame` retention, 512 frames / 8 MiB, `ready` head kept, synthetic
truncation boundary on eviction; Electron-free and pure). Clicking a
restorable session renders instantly from that cache through the existing
outbound frame channel and projector. The **sidecar spawn happens lazily on
real engagement** (composer focus / first keystroke / short dwell — exact
trigger is an implementation choice), and when the live replay arrives it
**replaces** the cached projection. No engine processes are pre-warmed; no
transcript parsing happens outside the engine.

## Why this shape (constraints that force it)

- **Warm engine pools are rejected by arithmetic.** One sidecar ≈ 286 MB RSS
  (measured live); the user's last-24h set is 36–37 sessions ≈ ~10 GB on a
  24 GB machine. Report F1 already concluded pooling is misdirected.
- **Transcript JSONL can only be parsed by engine code.** The host plane is
  engine-free by design and "cannot import `src/` directly"
  (`docs/reports/2026-07-08-app-engine-duplication-review.md`), and
  `app/sidecar/sessionResume.ts` is blessed there precisely because it routes
  through real engine resume machinery (CLAUDE.md mistake #10). A JSONL
  parser in host/main/renderer is forbidden. Caching **already-produced
  frames** sidesteps parsing entirely — the cache stores the sidecar's own
  output, not a reinterpretation of the transcript.
- **Security baseline stays untouched.** Cache write/read is main-plane only;
  cached frames flow renderer-ward on the existing `subscribe` channel
  (outbound-only). `restoreSession` and the inbound vocabulary are unchanged —
  only *when* it fires moves. No new inbound frame kinds, no protocol bump.
- **Locked decisions untouched:** N-process, die-with-window v1, raw
  `AppSessionEvent` fidelity, UDS transport — all as-is.

## Mechanism

**M1 — Persist the replay cache.** On session exit/close (and periodically or
on eviction, implementer's choice), main flushes that session's replay buffer
to disk, keyed by `appSessionId` (the durable registry key; restorable rows
carry it across app runs). Format: the serialized `ServerFrame[]` the buffer
already holds, plus a small header (engineSessionId, written-at, app/protocol
version). On app launch, cache files for restorable registry rows are indexed
(not necessarily loaded — lazy read on click is fine given the sizes below).

**M2 — Render from cache on click.** Clicking a restorable session delivers
its cached frames to the renderer through the same batched frame-delivery path
a live replay uses (`serverFrameBatch` fold = ~9 ms for a 400-frame replay).
The pane renders the transcript immediately, visibly marked as restored
history (M5). Sessions with no cache file (never opened in the app, cache
version mismatch, corrupt file) fall back to today's behavior exactly.

**M3 — Connect lazily.** The actual `restoreSession` spawn fires on
engagement, not on click. The composer is disabled with a quiet
"connecting…" state until `ready`. Recommended default: fire on composer
focus OR ~300 ms dwell on the pane, whichever comes first — eager enough that
the 0.6 s floor is gone before a human finishes reading, cheap enough that
sidebar flick-throughs spawn nothing. (Prefetch-on-hover, the deferred STATUS
follow-up, remains compatible and optional on top.)

**M4 — Reconcile by replacement, not merge.** When the live sidecar's
`replay:true` frames arrive, rebuild that session's projection from the live
replay alone and drop the cached rows. Rationale: the cache is a stale
snapshot (the session may have advanced in a terminal engine run since the
cache was written); the live replay is the engine's authoritative
newest-tail. Replacement is always correct and costs one batched re-render
(~9 ms fold + one DOM update); uuid-level merge/dedupe
(`seenFrameIds` / `rawMessageLog` dedupe) is an optimization to consider only
if the swap visibly flashes. The truncation-boundary idiom (visible lossiness,
never silent) applies to cached replays exactly as it does to live ones.

**M5 — Affordance (the F4 item, finally).** Cached rows render under a
"restored session" divider; the connect state shows as a skeleton/badge, not
an empty pane. Even the fallback (no-cache) path gets the skeleton — this is
the cheapest part of the design and fixes the "reads as a hang" half of the
complaint on its own.

## Costs (measured 2026-07-14, user's real data)

| Item | Cost |
|---|---|
| Disk cache | ≤ 8 MiB/session hard cap (buffer budget); last-24h set = 37 files, 48.7 MB raw / **36.2 MB under the 4 MiB replay cap** — trivial |
| Click → transcript visible (cache hit) | disk read + batched fold ≈ tens of ms (fold alone measured ~9 ms) |
| Engine connect (now hidden behind engagement) | ~0.6 s measured floor, unchanged |
| Renderer RAM | projections stay resident per app run as today; only sessions actually clicked are loaded — no launch-time bulk preload required |
| RAM avoided vs warm-pool alternative | ~286 MB × N (≈10 GB for the 24h set) |

## Non-goals

- Pre-warming engine processes (rejected above).
- Transcript virtualization / packaged-build render work — the residual DOM
  mount cost of a few-hundred-row transcript is real, unmeasured headlessly,
  and amplified 2–5× by the dev build (report F3). It is a separate
  measure-first item (report strategy #6); this design neither needs it nor
  replaces it. Acceptance below includes the packaged-build measurement so the
  residual is finally quantified.
- A shared "reader" engine process serving previews for never-opened sessions.
  Explicitly deferred: only worth designing if the no-cache fallback proves
  common in practice.
- Any change to `protocol.ts` versioning or the inbound frame vocabulary.

## Open questions for the implementing session

1. Cache write cadence: exit-only is simplest but loses cache on crash;
   periodic flush costs cheap writes. (Crash rows are restorable either way —
   they just fall back to the no-cache path.)
2. Engagement trigger tuning (focus vs dwell vs hover-prefetch combination).
3. Whether M4 replacement visibly flashes on large sessions; if so, layer the
   uuid-dedupe merge.
4. Cache invalidation beyond version/engineSessionId mismatch — e.g. compare
   transcript mtime vs cache written-at to pre-mark "stale, will refresh on
   connect".

## Acceptance sketch

- Cache-hit click → transcript visible well under 100 ms (headless: fold+select
  timing; GUI: operator glance per GUI-VERIFICATION.md).
- Engagement → composer enabled ≈ existing connect time; no double-render
  artifacts after M4 replacement.
- No-cache and corrupt-cache paths behave exactly like today + skeleton.
- Hardening smoke all-pass; no new inbound frame kinds; `bun test app/` and
  both tscs green.
- One packaged-build measurement of click→painted on a p90 session, recorded
  in the report, to close the DOM-mount unknown.
