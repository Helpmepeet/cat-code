# Review-program postmortem — 2026-06-28 → 2026-07-05

**Date:** 2026-07-05 · **Author:** big-picture session · **Subject:** all 19 review documents
in `docs/migration/reviews/` (+ `delegated/`), cross-checked against `STATUS.md` and the
commit log for open/closed state. This is a postmortem of the *bugs found and the process
that found them*, not a re-review of any code. Externally reviewed (context-free pass,
same day); its caveats are folded into the recommendations below.

## TL;DR

The last 48 hours produced 1 Critical and ~6 High findings versus roughly one High in the
entire month before. That is not the process degrading — it is the process working exactly
where it was designed to. **Every severe bug in this program lives at a seam between two
sessions that were each locally correct.** Phase 3 is the first phase where seams carry
behavior instead of docs, and the by-layer review cadence was aimed at precisely that
moment. Nothing severe was found by an end user or a gate failure; everything was caught by
a review, and almost everything was fixed same-day with a pre-fix-failing regression test.
The one recurring weakness worth changing: **joins between sessions have no owner until a
review claims them after the fact.**

## Bug ledger, by phase

| Phase | Review docs | Severe findings | Character |
|---|---|---|---|
| Pre-build (06-28) | `2026-06-28-review.md`, `2026-06-28-inventory-verification.md` | 1 fatal premise | "Electron hosts the Bun engine in-process" refuted against source before any code existed; 38 of 43 inventory rows corrected |
| Phase 0 (07-02) | `2026-07-02-phase0-review.md`, `2026-07-02-direction-review.md` | 0 code, ~4 doc-plumbing | Security contract orphaned behind a stale "P0-3" pointer (F1); code home specified three contradictory ways (F2); P0-4 and P0-5 written the same day in incompatible worlds (F3). Direction review's DR-1 unfused host from window before P1-0 "poured concrete"; DR-2 predicted the shared-external-state race class |
| Phase 1 (07-03) | five workstream reviews + `2026-07-03-phase1-review.md` | 1 High (live-reproduced) | The oversized-paste zombie socket (P1-F1); phase verdict "CLEARED ON OVERSTATED EVIDENCE" — surrogate hardening smoke, zero supervisor tests, `tools:[]` not regression-locked, a test name promising coverage it didn't deliver |
| Phase 2 (07-04) | `2026-07-04-p2-0-projector-review.md`, `2026-07-04-phase2-review.md`, mcp flag, delegated audit | 0 | Cleanest phase. GREEN; findings were fixture realism (four samples the engine cannot emit, one masking a real empty-tool-card display gap) plus a replay-eviction edge (F1) |
| Phase 3 (07-05) | host-plane, shell, crosscut, harness, lifetime/restore | 1 Critical + ~5 High | The harvest: restore amnesia (Critical), no history-to-renderer path, shell RED (close/restore contract mismatches), restart-in-place Potemkin (LR-1), settings lost-update proven live |

## Why the bugs clustered in Phase 3 — three compounding reasons

1. **Phase 3 is where composition starts.** Multi-session, lifecycle, crash, restore — the
   first phase where "session A correct + session B correct ≠ system correct" manifests as
   wrong *behavior* rather than wrong *docs*. Phase 0–2 seam bugs were pointer rot; Phase-3
   seam bugs were amnesiac engines.
2. **Review density spiked deliberately.** Five review documents landed on 07-05 alone.
   More eyes on the most integration-heavy layer found more — a selection effect, not a
   quality regression.
3. **Earlier phases built the instruments that made these bugs findable.** The committed
   probe pattern, the anti-Potemkin gate clauses (D6 §4), the exhaustive fixture, the P3-H
   harness. The Critical restore-amnesia bug was caught *because* D6 had already defined
   what a fake restore looks like.

## Pattern 1 — the dominant root cause: unowned joins

Every Critical/High behavioral bug in the program is the same shape; the reviews say it
themselves:

- **P3 host-plane F1 (Critical, restore amnesia):** P3-1 proved the loader returns the
  messages *in a probe process*; P3-3 wired restore→spawn. The hand-off of loaded messages
  into the served QueryEngine "belongs to neither session's spec and does not exist." Both
  sessions green; restored sessions answered with amnesia.
- **LR-1 (High, restart Potemkin):** restart-in-place is a *third* respawn path no decision
  doc defined. A supervisor comment claimed it "re-resumes" — true for restored sessions,
  silently false for fresh ones. The renderer kept rendering history the new engine didn't
  have.
- **P3-5 shell F1/F2 (RED):** the host's `restorable` predicate and the renderer's tab
  projection disagreed about what the word meant — a contract mismatch between P3-3 and
  P3-5b.
- **P1-F1 (High, zombie socket):** four layers each individually fine (no cap above the
  sidecar, prompt cap below the frame decoder, half-close on reject, close-only disconnect
  detection) composed into a session that is dead forever while reporting `ready`.
- **P0 F3:** P0-4 (N-process) and P0-5 (single-session security model) produced in parallel
  the same day; "the seam between them was never owned."

This is structural, not sloppiness: the sharded-session process makes each worker verify
its own scope, so the failure mass migrates to the joins. The by-layer integration reviews
are the compensating control, and they are catching it — but always *after* the join was
built wrong.

## Pattern 2 — camouflaged success (Potemkin) is the signature failure shape

A striking number of findings are things that *look* done:

- "2-proc proven" — sequential emulation in one process (P0 F4).
- A test named "a forged sessionId frame is rejected at the sidecar boundary" that sends a
  valid ping — flagged in **four** documents before being fixed.
- A hardening smoke that tests a copied policy in a surrogate window, not production main
  (P1-F3).
- A restored session with the right id and the right transcript and no context (P3 F1).
- A restart that renders continuity over an empty engine (LR-1).
- Fixture samples that typecheck but cannot be emitted (P2 F6); "+9 samples" that were 5;
  "IDs unique across all docs" with six survivors (P0 F5).

The countermeasures evolved visibly across the program and are worth naming as doctrine,
because they worked:

1. **Evidence must be committed and re-runnable** — the P0-1 deleted-spike lesson (F6),
   explicitly absorbed by P1's committed roundtrip probe and every probe since.
2. **Tripwires must be proven to fire** — P2-0's negative-tsc experiments.
3. **Fixes ship with a regression test verified failing on pre-fix code** — done for every
   P3 fix (e.g. `3c73b94`'s stash/run/pop verification).
4. **Anti-Potemkin claims need durable artifacts, not eyeballs** — the lifetime review's
   scorecard, including the honest gap that clause (d) rests on an uncaptured stderr line.

## Pattern 3 — what headless review structurally cannot see

Three bugs needed something beyond source-reading:

- **The settings lost-update race:** *predicted* on 07-02 (P0 F4 / DR-2), only *proven* on
  07-05 by a human-driven two-session GUI test — after an agent-driven attempt could not
  set it up. Fixed engine-side (`9487ed3`), live re-run 15/15 clean.
- **The P3-5b crash-parity defect:** found by GUI verification, not by the shell review.
- **FakeSupervisor divergence (crosscut F-5):** the fake emits a synchronous kill-exit the
  real supervisor never can — "exactly the divergence class that hid the original 5b bug."
  Host code ended up modeling the fake's behavior, comments included.

Headless review + fakes have a blind spot precisely where real process/timing semantics
diverge from the doubles. The 🖐 GUI runs and the P3-H harness are pulling real weight;
they are not ceremony.

## Pattern 4 — findings without owners recur; findings with owners close

The forged-sessionId test name was flagged in four separate documents (P1-0 scaffold
review, IS-6, transport F-8, build/test finding 4) before anyone owned it. The sidecar
typecheck was parked at "Phase-5 CI" twice and pushed back twice until P2-4 built the
scoped wrapper — which ended the recurrence instantly. Everything in a carry-forward table
with a *named session* ("P2-0 step 0", "before P2-4") got done. The lesson is mechanical:
an owner-less LOW is a standing tax on every future review.

## Open ledger (as of 2026-07-05 evening)

**Closed today:**
- Crosscut SF-1/SF-2 + fake fidelity — `6c9caeb`.
- Crosscut LOWs L1/L2/L3 — `3c73b94`.
- P3-H harness cleanup + HC1 test pin + gitignore — `641bff0`; GUI-routing docs — `b73e325`.
- Settings-race P3-8 rider — fix `9487ed3`, live re-run passed, P3-5a closed ✅.
- Host-plane F1–F6 — all fixed same day (see that review's addenda).
- P3-5 shell F1/F2/F3 — fixed same day, lead-verified.

**Open at write time:**
- **LR-1/LR-2/LR-3 fixes uncommitted in the worktree** (host restart threads
  `resumeEngineSessionId`; close-before-ready emits `session-removed`; restore refuses a
  still-live prior sidecar) alongside the untracked lifetime review doc — the exact
  IS-8/F6 "evidence one reset away from testimony" pattern. Commit once signed off.
- LR-4 (`registry_unavailable` invisible), LR-5 (immortal null-engine crashed rows), LR-6
  (single-slot error strings), LR-7 (composed-boundary test gap) — LOW.
- Crosscut F-3 (liveCount counts tombstones), F-4 (`cwd:''` garbage row), F-6 (close
  relabels crashed clean — deliberate, history-loss flagged).
- **P2 F6 fixture repair — a hard pre-condition for Phase-4 backlog generation.** Do not
  lose this one.
- Harness L-4 (debounce deviation unrecorded).
- P3-8 gate itself, plus P3-6/P3-7.

## Recommendations

0. **First, before any of these: commit the LR-1/2/3 worktree.** The fixes + the lifetime
   review doc sitting uncommitted is the "evidence one reset away from testimony" pattern
   the program has already learned from twice (P0 F6, P1 IS-8). It outranks everything
   below in urgency.
1. **Assign joins at backlog-generation time.** When PROGRAM-PLAN §8 generates a phase's
   sessions, add one step: enumerate the cross-session contracts (who produces X, who
   consumes it) and stamp each join onto a session or onto the layer review *by name*.
   Every Critical/High in this program would have been caught earlier by that one line of
   process. **Limitation, stated so Phase 4 doesn't misread this:** enumeration only
   catches joins visible in the plan. LR-1 is the counterexample from this program's own
   record — restart-in-place was a third respawn path *no decision doc defined*, so it
   would have appeared in no producer/consumer list. Upfront assignment shrinks the
   unowned-join class; it does not eliminate emergent ones. It reduces the load on the
   by-layer integration reviews — it is not license to thin them (the cadence decision —
   per-session reviews AND by-layer reviews, every session in exactly one layer — stands).
2. **Land LR-7's state-machine invariant test.** One fuzz/model test over the descriptor
   fold ("a close eventually removes the tab", "restorable ⇒ engineSessionId ≠ null")
   would have caught LR-2, the crash-parity bug, and forced restart to be enumerated as its
   own path. The single highest-leverage test artifact identified anywhere in these 19
   documents. **Sequencing caveat (couples to #4):** the test is only as good as the
   transition semantics that drive it, and Pattern 3 documents host code ending up modeled
   on the fake's impossible orderings. Derive the legal-event vocabulary from
   real-component guarantees (fake fidelity pinned first — `6c9caeb` started this — or
   drive the model through the P3-H harness against real processes) before trusting its
   green.
3. **Two-strikes rule for findings.** Flagged in two reviews without an owner → it gets a
   named owner or an explicit waive in STATUS. That retires the forged-test-name class
   after one repeat instead of four. A waive risks becoming a rubber stamp, but a waive on
   record still strictly beats four silent repeats.
4. **Keep fake-fidelity pinning going** (started in `6c9caeb`): every fake's event ordering
   gets a parity test against the real component — the divergence has already hidden one
   real bug. **Design caution:** pin *invariants and orderings the real component
   guarantees* (e.g. "kill-exit is never synchronous"), not exact event traces — real
   process timing is nondeterministic, and trace-exact parity tests get deleted the first
   week they're red for timing reasons.
5. **Do not relax the evidence doctrine under Phase-4 fan-out.** The direction review said
   it plainly and the record since has proven it: the epistemic hygiene "is the only
   mechanism that has caught every real error so far." Phase 4's parallelism will create
   pressure to economize on exactly this; the P3 week is the argument for not doing so.
   The sharper version of the worry: the *doctrine* (committed probes, pre-fix-failing
   regression tests, proven tripwires) scales fine — what may not scale is review
   *density*. Five review documents landed in one day for Phase 3; Phase 4 has more
   parallel sessions, so the join surface grows combinatorially while review capacity does
   not. That is the second reason #1 is the recommendation to invest in hardest.

## How to falsify this postmortem's thesis

The "this is the process working" framing rests on composition-onset + deliberate review
density being a selection effect. Phase 4 is the natural experiment: if joins assigned
owners per recommendation #1 produce materially fewer post-hoc Critical/High findings than
Phase 3's five-in-48-hours, the theory is confirmed. If the spike repeats anyway, seams
are being created faster than ownership can be assigned, and the *process* — not just the
phase — needs rework.
