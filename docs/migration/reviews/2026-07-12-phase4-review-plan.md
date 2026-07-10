# Phase-4 whole-phase integration review — PLAN (orchestrator-driven fan-out)

**Status:** ⬜ pending — runs AFTER Phase-4 GUI acceptance, BEFORE the Phase-4 gate is declared.
**Shape:** spawn ONE orchestrator agent → it fans out 9 review subagents (6 by-layer coverage lanes
L1–L6 + 3 cross-cutting sweeps S1–S3) → collects ranked findings → consolidates → writes the report
to `docs/migration/reviews/2026-07-12-phase4-review.md`.
**Why by-layer + sweeps:** the P3 cadence (review A/B/C by layer) proved this catches what per-session
reviews miss. Every P4 session lands in exactly ONE coverage lane (no gap); the three sweeps read
across the whole phase for the concerns that span it (security, integration, parity). Two of today's
build sessions passed headless review and still hid real defects (P4-15's HIGH trust-boundary bug; the
live-GUI misses) — this review is the gate instrument.

## Assumptions (flag if wrong before running)
- Runs AFTER GUI acceptance → judges code/integration/security/parity, does NOT re-drive the GUI.
- Lanes read files in full on `migration` and cross-check against the plan/decisions (a whole-phase
  *diff* would be enormous and noisy).

## Lane map (coverage L1–L6 each own their sessions once; sweeps read across ALL)
| Lane | Owns | Core question |
|---|---|---|
| L1 Read-seams | P4-5,6a,7,9,10,12,14 | All outbound `*.snapshot` follow P4-5's recipe — secretGuard-clean, reactive, redaction-safe? |
| L2 Inbound/write seams | P4-13,15,19 | Every inbound verb validated at the SIDECAR (Zod+strict-keys+T5a/T6/T7), HC3 fixed channel, no renderer-authored path/rule, fail-closed? |
| L3 Transcript+composer | P4-0,18a/b/c,23 | Projector correctness, tool-card families, prose/scroll, user-turn echo, banner removal — no P2-spine regression? |
| L4 Shell/settings-shell/primitives | P4-1,3,4 | Nav wired vs disabled-not-mocked, static-class rule, zero inline style, visual grammar? |
| L5 Orchestrator/plan/agent-vocab | P4-2,8a/c,11 | D2 nesting read-time-derived, agent-card identity from own row, plan approval not bypassable, no fake wiring? |
| L6 Welcome/removals/drift | P4-17,16→22,21 | Reuse-not-duplicate, removals clean+re-tagged, drift tripwires actually fire? |
| S1 SECURITY (sweep) | ALL | No token in any renderer frame; secretGuard all outbound; T5a/T6/T7 all inbound; HC1/HC3; frame limits. *P4-15 hid a HIGH here.* |
| S2 INTEGRATION/no-dup (sweep) | ALL | Seams compose (welcome↔6/5/15; 19-write↔3-read; 14↔C3)? Duplicated machinery? Both tripwires fire? |
| S3 PARITY/§0-honesty (sweep) | ALL | Adapted/deferred/cut flags accurate — silent drops? Output realized-parity NUMBER. 6b/8b/20 tracked? |
| C Consolidation | — | Dedupe, rank, cross-lane patterns, GATE call + parity number, fix/defer plan → the report. |

## Phasing / models
L1–L6 in parallel → S1–S3 (may reference lane findings) → consolidation last. Run **S1 (security) and
S2 (integration) at HIGH effort on a strong model** — that is where systemic defects hide.

## Fallback
An agent spawning its own subagents may be blocked by the harness (nesting is often restricted). If the
orchestrator can't spawn, run this as a **Workflow** instead (purpose-built for this fan-out→sweep→
consolidate shape) — same lane logic as a deterministic script. The orchestrator prompt below has a
"STOP and say so" clause for that case.

---

## THE ORCHESTRATOR PROMPT (spawn one general-purpose agent with this)

```
=== ROLE ===
You are the ORCHESTRATOR of the whole-Phase-4 integration review of the CatCode
desktop migration (~/cat-code, branch `migration`). You do NOT review code
yourself — you decompose the phase into review lanes, spawn ONE review subagent
per lane (Agent tool, general-purpose, read-only), collect each lane's ranked
findings, then consolidate them into the phase verdict + report. This review runs
AFTER GUI acceptance, so it judges code/integration/security/parity - NOT the GUI.

If you cannot spawn subagents (the Agent tool is unavailable to you), STOP and say
so plainly - this review must then be run as a Workflow or the lanes spawned by
the main session. Do not attempt to review all lanes yourself.

=== GROUND TRUTH (source wins over any dated doc) ===
- Plan: docs/migration/backlog/phase4.md (the per-session dispatched prompts).
- Decisions: docs/migration/decisions/ (SECURITY-MINIMUM, PERMISSION-BOUNDARY,
  STARTUP-GATES, AGENT-CHROME, WELCOME-LAUNCHER, RESTORE-HISTORY, REGISTRY).
- Parity: docs/migration/PARITY-LEDGER.md.  Status: docs/migration/STATUS.md
  (per-session §0 flags - verify each claim against SOURCE, not the note).

=== FAN-OUT ===
Spawn 9 review subagents. Phasing: run the 6 COVERAGE lanes (L1-L6) in parallel
first; then the 3 cross-cutting SWEEPS (S1-S3), which may reference the coverage
findings; consolidation is last (you do it yourself). Run S1 (security) and S2
(integration) at HIGH effort on a strong model - that is where systemic defects
hide (P4-15's HIGH trust-boundary bug lived in the security seam). Build each
lane subagent's prompt as: [SHARED TEMPLATE] + [that lane's SCOPE].

=== SHARED TEMPLATE (prepend to every lane's scope) ===
"You are a skeptical staff engineer running the {LANE} lane of the whole-Phase-4
review (~/cat-code, branch `migration`). You did NOT write this code. Read-only:
do NOT edit, checkout, or dirty the tree; read files in full on `migration`, use
git show/log for history. Ground truth: backlog/phase4.md, decisions/,
PARITY-LEDGER.md, STATUS.md (verify claims against SOURCE). Universal bars for
your files: security baseline (secretGuard outbound, T5a/T6/T7 inbound, HC1 no
renderer-authored path, HC3 fixed channels, no token in renderer, MAX_FRAME_BYTES
vs MAX_OUTBOUND_FRAME_BYTES not swapped); zero `as` casts in projector-style code;
inbound fail-closed / display degrade-graceful; exhaustiveness tripwires still
fire; reuse-not-duplicate (CLAUDE.md section 10); section-0 honesty (every
adapted/deferred/cut claim TRUE in source - a 'cut' item genuinely absent, not
hidden/dead). Report CONCRETE findings only, ranked most-severe first - each:
severity (HIGH/MED/LOW), file:line, concrete failure scenario (inputs/state ->
wrong outcome), one-line fix direction. Do NOT rubber-stamp, do NOT invent nits;
clean things get one line. Final message = ranked findings + one-line lane verdict
(CLEAN / CONCERNS / BLOCKERS-named). That text is your return value."

=== LANE SCOPES ===
L1 Read-seams (P4-5,6a,7,9,10,12,14): app/sidecar/*Domain.ts (accounts, sessions
   catalog, agent-config, tasks, goal, memory, extensions, diagnostics, workspace
   -trust) + their app/renderer/src/*State.ts. Each outbound *.snapshot built
   reactively (NOT a per-attach cache reset - the P4-3 resetSettingsCache bug
   class), redacted display data only (no values/tokens/bodies/env), secretGuard
   -clean with a redaction test. All follow P4-5's recipe? Flag divergence.
L2 Inbound/write seams (P4-13,15,19): sidecarServer.ts verb handlers, protocol.ts,
   preload.ts, main.ts, settingsEditable.ts. Each inbound verb (settings.setValue,
   workspace.trust, remoteSettings.*): strict-keys + sidecar-local Zod BEFORE
   dispatch, HC3 fixed channel (no generic invoke), no renderer-authored path/rule,
   fail-closed typed error, accept+reject boundary tests both exist. Re-audit the
   P4-15 handleSubmit trust check specifically.
L3 Transcript+composer (P4-0,18a/b/c,23): transcriptProjector.ts, TranscriptView
   .tsx, Chat/composer, sdkMessageFixtures.ts. User-turn echo on submit; tool-card
   families from real projected data (no `as`); prose/scroll/collapse; banner
   removal kept P3-7 catalog capture; both projector tripwires fire; no regression
   to the P2 correlation/streaming spine.
L4 Shell/settings-shell/primitives (P4-1,3,4): Surfaces/primitives, SettingsShell
   .tsx, SettingsField.tsx, Sidebar/TabBar/WorkspacePanels.tsx. Nav destinations
   wired vs honestly disabled (not mocked); no interpolated Tailwind arbitrary
   classes (static-map rule); zero inline style; HC1 (no per-workspace cwd author).
L5 Orchestrator/plan/agent-vocab (P4-2,8a/c,11): orchestratorState.ts, AgentChrome
   .tsx, agentIdentity.ts, planState.ts, PlanPanel.tsx, inline AgentToolCard/
   DelegateGroup. D2 nesting is read-time derivation (no new frame); agent-card
   identity from its OWN row not the session plane; plan approval not bypassable by
   bare Enter; no fake wiring for states with no engine backing.
L6 Welcome/removals/drift (P4-17,16->22,21): WelcomeScreen.tsx, the P4-22 deletion
   set, P4-21 parity fixtures. Welcome reuses selectMergedSessionRows / P4-5
   snapshot / P4-15 trust (no second merge/feed); resume-dialog removal left no
   dangling refs + re-tagged the ledger; each P4-21 drift tripwire actually FAILS
   under real vocabulary drift.
S1 SECURITY sweep (ALL): read across every inbound frame + outbound seam in
   protocol.ts / sidecarServer.ts / all *Domain.ts. No secret/token in any
   renderer-facing frame; secretGuard on ALL outbound; T5a/T6/T7 on ALL inbound;
   HC1/HC3; directional frame limits correct. Assume more holes exist like P4-15.
S2 INTEGRATION/no-dup sweep (ALL): do seams compose (welcome<->P4-6/5/15; P4-19
   write<->P4-3 read; P4-14<->C3 context)? Any duplicated engine/app machinery
   (P4-21's concern)? Both exhaustiveness tripwires (projector + TranscriptView)
   still fire? Renderer stores keyed-by-sessionId isolation holds?
S3 PARITY/section-0-honesty sweep (ALL): against PARITY-LEDGER, are adapted/
   deferred/cut flags accurate - any SILENT parity drop? Output a realized-parity
   NUMBER (built+adapted / in-scope rows). Deferred splits (P4-6b/8b/20) tracked?

=== CONSOLIDATION (you do this after all lanes report) ===
1. DEDUPE across lanes (sweeps overlap coverage lanes); merge, keep strongest
   evidence. 2. RANK survivors HIGH->LOW (each: file:line, failure scenario, owning
   session, fix direction). 3. CROSS-LANE PATTERNS: any defect class recurring
   across seams = systemic risk. 4. GATE CALL: is the Phase-4 gate (~80% parity,
   security baseline intact, every surface real) MET? State S3's parity number,
   blocker count, MET / NOT-MET-with-blockers. 5. FIX/DEFER plan: which blockers
   before declaring the gate; what's safe to defer.
Write the report to docs/migration/reviews/2026-07-12-phase4-review.md (verdict
first, then ranked findings, then fix/defer plan). Do NOT commit.

=== YOUR RETURN ===
Report back: the gate verdict, the HIGH/MED blocker count, the parity number, and
the report path. Do not paste the whole report - summarize; the file has detail.
```
