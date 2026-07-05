# P3 lifetime/restore integration review (P3-4..P3-5b composed on the host plane, pre-P3-8)

**Date:** 2026-07-05 · **Reviewer:** big-picture session (full P3 context) · **Scope:** the
composed lifetime/restore stack as it stands on `migration` @ da4e1c2 **plus the uncommitted
working-tree diff** (per-session prompt drafts in `App.tsx` + STATUS P3-5a/P3-8 flips). Read
against `decisions/SESSION-LIFETIME.md`, `REGISTRY.md`, `RESTORE-HISTORY.md`,
`SECURITY-MINIMUM.md`. This is the renderer/shell-isolation-layer review of the cadence
(review B), widened to trace lifetime, crash recovery, registry integrity, anti-Potemkin
provability, and structural invariants end to end — the seams P3-8 will stand on. Findings
are numbered **LR-n** (lifetime/restore) to avoid colliding with the host-plane review's
F-n namespace.

> **Post-review resolution note (2026-07-05):** LR-1, LR-2, and LR-3 were
> evaluated and fixed in the working tree after this review. Restart-in-place now
> threads the row's current `engineSessionId` into the respawn, close-before-ready
> emits `session-removed` for pre-ready rows, and terminal registry rows retain
> advisory `enginePid`/`socketPath` so restore can refuse while a prior writer
> still matches sidecar identity. The findings below remain as the original
> review record, not current open-state text. LR-4 through LR-7 remain follow-up
> notes unless closed elsewhere.

## Review-time verdict

| Dimension | Verdict | One line |
|---|---|---|
| 1 Lifetime & restore correctness | **GREEN with one hole** | Clean quit → relaunch → restore → resume was real end to end (id adoption asserted, context seeded, history replayed, dedup on same-run reuse); the review-time hole was the RESTART path (LR-1). |
| 2 Crash & orphan recovery | **GREEN with edges** | Sweep is conservative and live-validated; crash restore = clean restore semantically; two low-likelihood still-alive-writer edges (LR-3). |
| 3 Multi-session isolation | **GREEN with nits** | P3-4 stores + shell projection isolate correctly (incl. the working-tree prompt-draft fix); residual single-slot error strings bleed across tabs (LR-6). |
| 4 Registry & persistence integrity | **GREEN** | Index-not-store honored; write discipline honored; two hygiene nits (LR-4, LR-5). |
| 5 Anti-Potemkin provability | **YELLOW** | (a)(b)(c) were provable from durable artifacts; (d) "resume machinery ran" rested on an uncaptured stderr line; restore *failure* was visually indistinguishable from a generic crash; LR-1 was a live Potemkin path. |
| 6 Structural invariants | **GREEN** | Zero `electron` in supervisor/host (grep-proven); transport is the socket file both ends; sidecar stdio carries no IPC pipe; lifetime comes from `host.shutdownAll()`, not parenting. |
| 7 Verification quality | **YELLOW** | Strong hermetic + probe coverage of each piece; the composed restart-boundary cycle, close-before-ready, and restart-context semantics have no test (LR-7). |

**Review-time P3-8 blocker call:** The gate could *run* and its restore half would pass
honestly, but LR-1 was marked as requiring a fix before P3-8 because the restart-in-place
affordance the gate's crash-sim would naturally exercise produced exactly the
renderer-replay illusion the anti-Potemkin clause exists to catch. LR-2 was recommended
alongside it (same one-branch shape as the already-landed SF-2).

**Security baseline (hard gate): NO REGRESSION.** T4/T5a/T6/T6b/T7 enforcement in
`app/sidecar/sidecarServer.ts` unchanged; directional caps intact; secretGuard on every
non-error outbound frame; HC1 token chain, HC2 UUID+membership, HC3 fixed channels, HC4
caps all verified present with their regression tests. The working-tree renderer diff
touches none of it.

## Gates re-run (this review, working tree = migration @ da4e1c2 + prompt-drafts diff)

- `bun test app/` — **369 pass / 0 fail** (40 files).
- `bunx tsc --noEmit -p app/tsconfig.json` — clean.
- `bun run --cwd app typecheck:sidecar` — clean (5,550 upstream diagnostics ignored, zero in
  `app/` files — matches the documented carry-forward).
- `bun run --cwd app test:hardening` — **19/19**, real Electron launch (incl. the packaged
  no-debug-export assertion).
- `bun run app/scripts/run-f2-attach-smoke.ts` — PASS (two real sidecars routed
  independently; survivor live after peer kill; killed session evicted).
- LR-2's renderer half reproduced with a scratch reducer test (see the finding); scratch
  file deleted after.
- **Not run:** any GUI/operator step (P3-8 owns those); the settings-contention probe
  (engine-side, 15/15-verified per the P3-5a row, outside `app/` scope).

## Findings (ranked)

### LR-1 — HIGH — Restart-in-place discards engine context while the renderer keeps showing history (Potemkin continuity)
**Seam:** P3-3 restart wiring ↔ P3-1 resume semantics ↔ P3-4 store retention.
**Anchors:** `app/host/host.ts:446` (`restartSession` → bare supervisor restart) →
`app/supervisor/supervisor.ts:328-343` (restart re-applies the ORIGINAL `SpawnConfig`;
comment at `:336-337` claims it "re-resumes the same engine session") →
`app/host/host.ts:154-162` (the new ready frame's `engineSessionId` overwrites the row).

The supervisor comment's rationale is true for **restored** sessions (their retained config
carries `resumeEngineSessionId`, so a restart re-resumes the same id — correct, and the
resumed transcript now includes post-restore turns, so this half is sound). It is silently
false for sessions **created fresh**: their config is `{cwd}` only, so restart spawns a
sidecar with no resume env → the engine **mints a new `engineSessionId` with empty
context**. Meanwhile the P3-4 stores are deliberately never torn down, so the pane keeps
rendering the pre-restart transcript — history the new engine does not have. The ready
frame then overwrites the row's `engineSessionId`, orphaning the old transcript from the
desktop's view (no longer offered for restore either).

Compounding UX: after a crash, the SAME session simultaneously offers the tab's
restart-in-place (context silently lost) and the Sidebar's restore (context resumed) —
identical-looking outcomes, opposite semantics. Reachable from every `CH_RESTART` surface:
the dead-tab affordance, the pane's `ConnectionRecovery` restart, ⌘-driven restarts.

**Failure it implies:** the D6 §4 anti-Potemkin clause names this exact shape — "a renderer
that merely re-renders old JSONL … fails all three." The restart path re-renders old rows
over an amnesiac engine and looks continuous until the next answer.

**Fix shape (small):** `host.restartSession` reads the row and threads its current
`engineSessionId` into the respawn as the resume id (extend `supervisor.restartSession` to
accept a config override, or have the host kill+`spawn()` through its own path, which
already does exactly this for restore). One decision-note line in `SESSION-LIFETIME.md`
naming restart-in-place as a third respawn path with defined context semantics would keep
this from regressing. Regression test: restart a fresh session that has a minted
transcript, assert the served QueryEngine's live messages contain the pre-restart nonce
(the `resumeSeed.probe` pattern fits verbatim).

### LR-2 — MEDIUM — Closing a tab before its ready frame mints an unremovable zombie tab
**Seam:** P3-3 `closeSession` descriptor shape ↔ P3-5a tab-membership fold.
**Anchors:** `app/host/host.ts:376-402` (`closeSession` ends with unconditional
`emitStatus` at `:401`) → `app/host/host.ts:568-587` (`descriptorFromRow`: dead + clean +
`engineSessionId: null` → `status:'exited', restorable:false`) →
`app/renderer/src/shellState.ts:103-117` (`foldTabMembership`: any `!restorable`
descriptor is tab-retaining/tab-granting).

Close a tab during `spawning` (⌘W or the close button in the window before the ready frame
— people close mis-created tabs immediately, which is exactly when they're spawning) and
the resulting `(exited, restorable:false)` status keeps the tab alive as a dead EXITED tab
that (a) restart cannot revive — `host.restartSession` returns `session_not_found`, which
the `CH_RESTART` handler swallows (`app/main/main.ts:437-444`) — and (b) close cannot
remove — a second `closeSession` succeeds and re-emits the same descriptor. It persists
until a renderer reload (SF7's `listSessions` filter drops it on hydrate) or relaunch (the
launch reap drops the clean+null row). Same zombie via closing a crashed-before-ready
tab's tombstone.

**Reproduced** (renderer half) through the real reducer: `session-added(spawning,
restorable:false)` then `session-status(exited, restorable:false)` leaves
`selectLiveSessions` length 1 with status `exited`.

**Fix shape (one branch):** `closeSession` mirrors the spawn-failure branch that already
solved this exact shape (`app/host/host.ts:340-346`, the P3-5 SF-2 fix): after `markClean`,
if the row has no `engineSessionId`, `emitRemoved` instead of `emitStatus`. Add the
close-before-ready case to the host suite and the fold case to `shellState.test.ts`.

### LR-3 — LOW (likelihood) / HIGH (impact) — A kill-that-didn't-happen leaves a live prior engine that a restore then double-writes against
**Seam:** D6 kill policy ↔ REGISTRY restore eligibility.
**Review-time anchors:** two variants —
(a) *clean-quit:* `app/host/host.ts:472-478` (`shutdownAll` marks clean THEN SIGTERMs) +
`app/host/registry.ts:718-739` (`markLiveCleanSync` then dropped advisory pid/socket data) +
`app/host/registry.ts:444-464` (the sweep probes ONLY `shutdown === null` rows) — a sidecar
that survived SIGTERM (wedged event loop) was recorded clean with no advisory identity data and
invisible to every future sweep;
(b) *sweep-refusal:* `app/host/registry.ts:449-463` + `:474-484` — when the pid is alive
but the §9-A3 identity check refuses the kill (cmdline unreadable; dev-vs-packaged marker
drift — the marker is the build's own `SIDECAR_ENTRY`, so a packaged run never matched a
dev orphan's cmdline), the row was still flipped to `crashed` + restorable.

In both variants the row becomes restore-eligible while the prior engine process may still
be alive and mid-turn — restoring it spawns a **second engine resuming and appending to the
same transcript JSONL the survivor is still writing**. The conservative-kill choices are
deliberate and documented; the *restorability* consequence was not decided anywhere.

**Implemented fix shape:** terminal clean/crashed marking now retains advisory
`enginePid`/`socketPath`, and `restoreSession` checks `hasLiveAdvisorySidecar` before
spawning — refusing when the old pid still matches sidecar identity. That turns both
variants into a typed error instead of silent transcript interleaving.

### LR-4 — LOW — `registry_unavailable` never reaches any surface (silent persistence degradation)
**Anchors:** `app/host/registry.ts:753-793` (`persist` swallows, sets `lastWriteFailed`) →
`app/host/host.ts:631-638` (`surfaceRegistryHealth` = stderr log only). The
`registry_unavailable` HostErrorCode exists in the union but is never returned; a full run
with an unwritable registry looks identical to a healthy one, and a failed
`markLiveCleanSync` at quit (`registry.ts:734-737`) means the next launch reports clean
sessions as crashes with no explanation on record. Minimum: include `lastWriteFailed` in
the debug-state export (`app/main/main.ts:563-588`) so harness runs can assert on it;
UI surfacing can wait for a real chrome slot.

### LR-5 — LOW — `crashed` rows with `engineSessionId: null` are immortal until the bound reap
**Anchors:** `app/host/registry.ts:501-522` (reap drops clean+null and missing-transcript
rows only; a crashed-before-ready row is neither) — such rows are never offered
(`listSessions` skips null-engine restorables, `app/host/host.ts:417-419`), never reaped
except by the 32-row bound, and accumulate as invisible litter. One extra reap clause
(`shutdown !== null && engineSessionId === null` → drop) matches §9-A5's spirit: an address
that never acquired content is not worth a row, however it died.

### LR-6 — LOW — Renderer error surfaces are single-slot, not per-session
**Anchors:** `app/renderer/src/App.tsx:86-87` (`transportError`, `shellError` are single
strings) and `:739` (`ConnectionRecovery`'s `restartError` is component state that survives
tab switches — the component never remounts across sessions). A submit failure on tab A
stays displayed after switching to tab B. Same class as the prompt-draft bleed the
working-tree diff just fixed (that fix is correct — keyed map, empty-string cleanup,
null-session guard, reducer unit-tested); these are the remaining single-slot leftovers.
Fix when touched next: key them by `sessionId` like `PromptDraftState`, or clear on tab
switch.

### LR-7 — LOW — Missing headless regression coverage at the composed boundaries
The pieces are well tested (registry 22 hermetic incl. a real orphan kill; host suite
incl. crash-parity and SF5-7; resumeSeed/spawnConfig/roundtrip probes against the real
engine; renderer isolation fixtures). What has NO test is the composition:
- the full quit→relaunch cycle over ONE real registry file (`markLiveCleanSync` → fresh
  `SessionRegistry` → `launch()` sweep/reap → `restorable()` → `restoreSession` → real
  resume) — every hop tested separately, never chained;
- close-before-ready (LR-2 — both halves);
- restart-preserves-context (LR-1 — currently it doesn't, and no test says which is
  intended);
- a fuzz/model test of the descriptor state machine: drive random legal event sequences
  through the host fold + `reduceShellState` and assert invariants ("a close eventually
  removes the tab", "tab ⇒ live record ∨ tombstone", "restorable ⇒ engineSessionId ≠
  null"). This one artifact would have caught LR-2, the P3-5b crash-parity defect, and
  arguably LR-1 (it forces enumerating restart as its own path).

### Notes (no action required now)
- `liveCount()` counts supervisor tombstones (`app/host/host.ts:525-527`), so
  dead-but-unclosed tabs consume `session_limit` headroom near the 32 bound — re-noting the
  host-plane review's observation, now user-reachable via the crash-tab flow.
- `hostPid` in the registry doc is documented "liveness-checked by readers"
  (`registry.ts:94`) but no reader checks it — doc/code drift, harmless.
- `removedIdsRef` (`App.tsx:109`) grows unboundedly within a run — bounded in practice by
  removal volume; fine.
- Frame-driven focus adoption (`App.tsx:121-129`) can flip focus between two pre-row
  sessions racing hydration — bounded (stops once rows land), cosmetic.

## Seam-by-seam status (dimensions 1–4, 6 traced)

- **Clean quit → relaunch → restore → first turn — HOLDS (minus LR-1's sibling path).**
  `window-all-closed`/`before-quit` both route `host.shutdownAll()` (idempotent); mark-clean
  precedes kill; `markCrashed` only transitions live rows so a mid-run crash is never
  relabeled clean; overlapping persists cannot lose mutations (shared in-memory doc,
  serialization at write time — the `markLiveCleanSync` lock bypass is safe for the same
  reason). Relaunch: single-instance lock → registry `launch()` (read/sweep/reap run
  synchronously before the first await) → B4 gate serializes every host op behind it.
  Restore: `restoreSession` re-checks row, transcript existence (SF6), cwd validity, and
  live-collision; spawn reuses the appSessionId; the sidecar resumes through the real
  machinery with `sessionIdOverride`, asserts the adopted id, refuses fresh-mint with exit
  code 4; the SAME `Message[]` seeds the QueryEngine (F1 fix, probe-proven) and the
  renderer replay (F2, `replay:true`, capped ≤ main's buffer budgets, truncation-signalled).
  First post-restore turn: ready frame reports `inputEnabled` from live `activeTurn`.
- **Same-run restore double-render — SOLVED.** Replay frames dedupe by uuid in both the raw
  log (`rawMessageLog.ts:104-109`) and the projector (`seenFrameIds`,
  `transcriptProjector.ts:501-503`); live frames never deduped.
- **Identity continuity/separation — HOLDS.** appSessionId (address, stable across
  restarts/restores) vs engineSessionId (transcript key, bridged once per attach via the
  validated ready frame, `supervisor.ts:520-544` → `host.ts:154-162`) vs pid/socketPath
  (advisory, rewritten per spawn, verified before any trust). The one place the bridge
  moves *wrongly* is LR-1's fresh-restart overwrite.
- **Crash/orphan recovery — HOLDS, conservative.** Sweep kills only on pid-alive AND
  socket-file-exists AND cmdline-marker; EPERM treated as dead; no marker ⇒ never kills;
  hermetic tests include a real spawned orphan and a recycled-pid impostor. Crash restore
  is the SAME `restoreSession` path as clean restore (row `crashed` vs `clean` only affects
  the descriptor's `disconnected`/`exited` split). A failed restore keeps the row
  restorable (upsert never nulls `engineSessionId`), so retry works. Residual edges are
  LR-3.
- **Multi-session isolation — HOLDS.** All four frame stores keyed by `frame.sessionId`;
  shell roster is a pure HostEvent projection with subscribe-before-snapshot hydrate that
  cannot resurrect removed rows or roll back fresher descriptors; tab membership is
  run-local event history (hydrated restorables never become tabs); ⌘n indexes the tab
  projection, not the roster; background permission badges computed per-slice; switching
  tabs touches only `activeSessionId`. Working-tree prompt-draft fix verified correct.
  Unrelated historical rows cannot enter the tab set — they contaminate only the Sidebar
  offer list (see gate recommendations). Residual: LR-6.
- **Registry as index — HOLDS.** No transcript bytes/secrets/layout; corrupt file →
  move-aside + empty + loud log; atomic temp/fsync/rename + advisory lock + bounded
  retries; fail-the-write-never-the-session; transcript-path re-implementation
  NFC-normalized with the long-path prefix-scan fallback.
- **Structural invariants — HOLD (grep-proven this review).** `electron` imports only in
  `app/main`, `app/preload`, and the launch scripts; zero `src/**` imports in
  `app/host`/`app/supervisor`; sidecar spawn stdio `['ignore','inherit','inherit']` (no IPC
  channel); transport is `Bun.listen({unix})` ↔ `net.connect({path})`; no code path derives
  session lifetime from window-process exit.

## Anti-Potemkin scorecard (dimension 5)

| Claim | Provable today? | Evidence path |
|---|---|---|
| (a) prior unique context survived restore | **YES (headless) + gate nonce (live)** | `resumeSeed.probe.test.ts` proves the served QueryEngine's live `mutableMessages` contain the pre-quit nonce, tripwire-verified; the live credentialed proof stays P3-8's job by design. |
| (b) same `engineSessionId` transcript continued | **YES** | Registry row + ready-frame echo + on-disk JSONL; the sidecar hard-asserts the adopted id and exits 4 rather than fresh-mint. |
| (c) post-restore writer is a fresh engine PID | **YES** | `enginePid` advisory in the row + debug-state export; compare pre/post. |
| (d) engine-side resume machinery ran | **PARTIAL** | The only artifact is the sidecar's `[sidecar] resume-seeded messages=N engineSessionId=…` stderr line (`index.ts:108-110`), inherited into main's stderr but captured nowhere durable. Gate run must tee main's stderr and grep it. |
| (e) success not produced by replay/paste/another session | **YES structurally, minus LR-1** | Replay frames are flagged `replay:true` and deduped; the nonce answer can only come from engine context. LR-1's restart path is the one live surface where renderer-visible history genuinely diverges from engine context. |

**Additional gap:** a restore *failure* is loud but indistinct — exit code 4 rides the
lifecycle frame's `exit.code`, but nothing maps it, so a failed restore renders as a
generic dead tab. Not fake success, but "restore failed" is invisible. Smallest change:
map exit code 4 to a distinct renderer label (or at least log it distinctly in main).

## Recommendations for the P3-8 gate run

1. Fix **LR-1** (and ideally LR-2) first; add a restart-in-place step to the gate protocol
   ONLY after — today it would pass visually while failing semantically.
2. Run the gate under a scratch `CLAUDE_CONFIG_DIR` so historical registry rows don't
   clutter the two-session Sidebar assertions (the hardening/smoke runs already write rows
   into the real registry — host-plane review note).
3. Tee main's stderr for the `resume-seeded` line — that is the (d) evidence.
4. Land LR-7's chained quit→relaunch headless test as the gate's regression companion, so
   the lifetime line survives after P3-8 closes.
