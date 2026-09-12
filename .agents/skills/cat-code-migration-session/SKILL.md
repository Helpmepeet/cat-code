---
name: cat-code-migration-session
description: "Use for a dispatched Cat Code desktop-migration backlog session or non-trivial changes under app/. Consult migration rulebooks and invariants. Not for the backlog-dispatch orchestrator or engine-only src/ work."
---

# Cat Code Migration Session (worker side)

## Rule zero — this skill routes, the backlog rules

The **Standing rules** section of the current phase's backlog
(`docs/migration/backlog/phaseN.md`) is the authoritative, maintained worker
rulebook — it encodes the operator rulings, the domain recipe, and the current
verification bar. **Read it before touching code. If it and this skill ever
disagree, the backlog wins.** This skill exists so you find it, and so the
always-true invariants below survive even an ad-hoc `app/` task that has no
backlog prompt.

## Step 0 — Required reads

1. Your session's row in `docs/migration/STATUS.md` (program truth — never
   reconstruct state from git).
2. Your full prompt block + the phase's Standing rules in
   `docs/migration/backlog/<phase>.md`; your surface's row in
   `docs/migration/INVENTORY.md` (disposition, ⚓ grounding, Faked?/spec ID).
3. Every decision doc your prompt cites (`docs/migration/decisions/`); always
   at minimum `SECURITY-MINIMUM.md`. If `docs/migration/PARITY-LEDGER.md`
   exists, read your surface's rows.
4. Echo the session's `🧠 Model/Difficulty` header back to the operator before
   starting (PROGRAM-PLAN §6).

## Always-true invariants

**Locked decisions — never reopen, never work around quietly:** Unix-domain
socket transport · N-process (one engine process per session) · raw
`AppSessionEvent` over the wire (no lossy mapper) · die-with-window v1 ·
two-id model (`appSessionId` ↔ `engineSessionId`). If your task seems to
require changing one, STOP and report.

**Recon before inventing.** Real shapes live in `src/` (esp.
`src/app-runtime/`); the prototype (`~/catcode_prototype/cat-app/`) is the UX
spec, not the data contract — port zero code, no inline `style={{}}`, and
re-verify every `// SOURCE:` anchor in current source (sampled ~83% exact).
The house defect class is wiring a seam with stub context (`tools: []`,
`getEmptyToolPermissionContext`, `commands: []` — three occurrences so far):
construct from the SAME source the engine runtime uses, cite the
`src/<file>:<line>`, and prove it with a live-path test, not a shape test.

**Prototype parity is the default disposition, and a self-flagged deviation is a
proposal — not a decision.** Deviate only when *blocked* (invention, no source
backing → render truth) or *needs-redesign* (collides with real engine behavior
→ adapt). Record every deviation as a §0 flag in your report/STATUS note —
`🔁 adapted(why)` · `⬜ deferred(owner)` · `✂️ cut(reason)` — never a silent drop.
**But that flag only *proposes* the deviation: it stays OPEN DRIFT until the
operator approves it, does not waive fidelity acceptance, and does not make the
gap review-immune or fix-immune.** (History: self-flagged `INTENTIONAL`/`deferred`
deviations became review-and-fix immunity, and every blessed deviation the
operator saw live was reversed on sight.) Surfaces that render UI with a
prototype counterpart carry the visual-fidelity acceptance: done means it *reads
as* the prototype side-by-side, not merely that data is wired — prove it through
the FIDELITY block in `verifying-cat-code-changes`, which fails a fidelity claim
on any open, unapproved mismatch.

**Security baseline is a hard gate** (`decisions/SECURITY-MINIMUM.md` +
Addendum): closed inbound allowlist validated AT THE SIDECAR; T4 goalSnapshot
validated; T5a responses match an engine-minted request id; T6 `updatedInput`
echo-only; T6b renderer never authors permission rules — suggestion-selection
by index only (T6b is a sidecar boundary-test label, not in SECURITY-MINIMUM;
the mechanism is `decisions/PERMISSION-BOUNDARY.md` C1); T7 size/rate caps; `MAX_FRAME_BYTES` (in) vs
`MAX_OUTBOUND_FRAME_BYTES` (out) never swapped; secrets engine-side only with
`secretGuard` on every outbound frame; preload default-deny (new methods use
the HC3 fixed-sender pattern; renderer never authors a cwd — HC1). New data
crosses as a read-only outbound snapshot frame (C3 precedent) or a host-API
read, never a renderer-authored write of engine state.

**Cross-process shared state (the DR-2 lesson):** never add a cross-process
read-modify-write file without single-writer + lockfile + atomic write, and
compute the final state UNDER the lock from a fresh read (the
`SettingsUpdater` form in `src/utils/settings/settings.ts`) — a lock around a
stale pre-computed value still loses updates.

## Verification

Invoke the `verifying-cat-code-changes` skill — DESKTOP battery mandatory;
tripwire re-fire if you touched the `SDKMessage` union; hardening smoke on any
boundary/preload change. **Touched a UI surface with a prototype counterpart?
The skill's FIDELITY block is also mandatory — a state-by-state
prototype-vs-actual comparison artifact with zero open, unapproved mismatches —
and you report the SURFACE ACCEPTANCE tiers separately, never a single ✅: "GUI
not run" blocks the fidelity/overall verdict, not the engineering one.**
Migration dev-loop turns use `gpt-5.4-mini` at low effort on a healthy account
(GUI-VERIFICATION.md §Model) — never burn frontier quota to fire a tool-call turn.

## GUI verification protocol

Read `docs/migration/process/GUI-VERIFICATION.md` before any GUI section.

- A dispatched 🖐 GUI prompt means STOP after headless verification and print
  exact operator steps — launch command with the P3-H harness flags
  (`CATCODE_TEST_CWD_ALLOWLIST` / `CATCODE_INITIAL_CWD` /
  `CATCODE_DEBUG_STATE=1`), what to click, what to look for — UNLESS the
  operator explicitly authorizes agent-driving for THAT run (the P3-8
  precedent). Authorization is per-run, never standing.
- If authorized: locate the "Cat Code Dev" window, wait for
  `[main] renderer ready`, poll the debug export
  (`<config-home>/desktop/debug/state.json`) as locator/cross-check only —
  every acceptance claim must cite a live AX-observed label; use
  `registry.json` for PID forensics.
- **Hover/focus-only surfaces are operator-driven, always — no authorization
  covers them.** cua-driver has no backgrounded hover; warping the real cursor
  stole the operator's machine on 2026-07-07 and forced a restart. Mark such
  checks UNVERIFIED and hand the operator exact hover/click steps, or close
  them by source inspection when the logic is trivial (GUI-VERIFICATION.md) —
  never steal focus.

## Closing bookkeeping (last step, in order)

1. Update YOUR row in `docs/migration/STATUS.md`: status glyph + date + a
   dense one-line-to-paragraph note (what landed, evidence numbers, §0 flags,
   carry-forwards). Never rewrite other rows.
2. Update your parity-ledger rows if the ledger exists; otherwise keep every
   cut/adaptation as an explicit flagged line for the backfill.
3. Final report: outcome first · verification evidence block · §0 flags ·
   source anchors cited · unresolved uncertainties · exact operator steps for
   anything GUI-gated.
4. Work stays on the `migration` branch. Do NOT commit unless the user asked;
   never write `DONE.md` unasked.

## Failure handling

- Acceptance criterion unmeetable → report the gap with evidence; don't
  redefine the criterion.
- Prompt vs current source conflict → source wins for facts, the prompt wins
  for scope; note the conflict.
- Out-of-scope defect found → record as a flagged finding with a proposed
  owner; fix only if it blocks your acceptance path.
- Block too big mid-session → stop and propose a split; don't degrade quality
  to finish in one sitting.
