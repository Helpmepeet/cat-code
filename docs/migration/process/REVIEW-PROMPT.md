# Cold-review prompt — paste into a fresh agent before building

Copy everything in the block below into a new agent session. It is self-contained.
Its job: independently audit the migration plan against real source — trust nothing,
verify everything — and report findings. It writes NO code and changes NO plan; it
only produces a findings report for the user to act on.

---

You are doing a **cold pre-flight review** of a migration plan that another agent wrote.
Assume nothing in the plan is correct until you verify it against the real code. Your
job is to find what's wrong, stale, contradictory, or unbuildable — BEFORE building
starts tomorrow. Do not write app code. Do not edit the plan. Produce a findings report.

## Context (what's being migrated)
A high-fidelity in-browser React **prototype** at `/Users/pt/catcode_prototype`
(`cat-app/*.jsx` + `data.js`, ~20k lines, no TypeScript, inline styles, loaded by
`CatCode Web App.html`) is being rebuilt as a **production desktop app** on the real
cat-code engine. Target code home: `~/cat-code/web/` (React 19 + Vite + TypeScript +
Tailwind v4). The engine lives at `~/cat-code/src`. The prototype is the UX spec, not
shipped code — every line gets rewritten in the real stack.

## The plan you are auditing (read these four, in order)
- `PROGRAM-PLAN.md` — strategy, 5 workstreams, dependency map, phases+gates.
- `INVENTORY.md` — per-surface ledger (file, anchor count, faked?, disposition).
- `backlog/phase0-1.md` — the first 7 pasteable build sessions (P0-1..P1-4).
- `decisions/SEAM-SPIKE.md` + `decisions/SHELL.md` — settled spikes (seam = `AppSessionController`; shell = Tauri + Bun sidecar). Reference, not under audit.
(Ignore the banner-marked SUPERSEDED docs: `MIGRATION-STRATEGY.md`, `MIGRATION-DOMAINS.md`, `process/HANDOFF.md`.)

## What to verify (do the work, don't take claims on faith)

**1. Source citations resolve.** Every `src/…` or `~/cat-code/…` path/symbol the BACKLOG
hands a cold agent must exist. Open each and confirm the cited file + symbol is real and
says what the prompt implies. Specifically check: `src/app-runtime/AppSessionController.ts`
(the seam — does it expose subscribe/submit/abort + a permission round-trip?),
`src/web/startRuntimeBackedWebMode.ts` (does it really wire the controller → a WS server
and forward the full `SDKMessage`, NOT a flattened string?), `src/app-runtime/sessionEvents.ts`,
`src/entrypoints/sdk/coreTypes.generated.ts` (is `SDKMessage` the rich union the plan
claims?), `web/src/appProtocol.ts`, and the `app.ready` / `permission.requested` symbols.
Flag any that are missing, renamed, or moved since the plan was written (2026-06-26).

**2. The INVENTORY is accurate.** Spot-check ~6 rows against the real prototype: does the
named component actually exist in the named `cat-app/*.jsx` file, and is its `⚓` anchor
count right (`grep -c 'SOURCE:' <file>`)? Critically: confirm the **zero-anchor (❌)**
surfaces really have no `// SOURCE:` anchors — Sidebar, TabBar, SlashCommandPicker,
SessionActions, OrchestratorMode. If any of those DOES have anchors (or any "anchored"
file has zero), the recon flags are wrong and sessions will be mis-scoped.

**3. The dependency order is buildable.** Walk BACKLOG P0-1 → P1-4. Does anything depend
on something not yet produced? Is the claim "P0-2/P0-3 run parallel to P0-1" actually
true (no hidden dependency)? Does P1-1 genuinely need P0-1's `decisions/TRANSPORT.md`
first? Flag any ordering that would dead-end an agent.

**4. Internal consistency across the docs.** Session counts, anchor totals, the
zero-anchor list, the "faked-runtime" list (streaming / permissions / multi-session) —
do PROGRAM-PLAN, INVENTORY, and BACKLOG agree with each other? Flag any number or list
that disagrees between docs.

**5. Unbuildable or under-specified sessions.** For each of the 7 sessions, ask: could a
cold agent actually finish this in one sitting with what the prompt gives it? Is the
"Done when" criterion real and checkable? Flag any session that's secretly two sessions,
or whose done-criterion can't be verified.

**6. Biggest-risk gut check.** The plan bets the whole program on the Phase 1 walking
skeleton (can the app drive the real engine?). From what you saw in `src/app-runtime` and
`src/web`, is that seam as turn-key as the plan assumes — or is there a hidden blocker
(transport, process boundary, Bun-vs-Node, permission wiring) the plan glosses over?

## Rules
- **Verify against real files.** Use `grep`/Read on `~/cat-code/src` and
  `/Users/pt/catcode_prototype/cat-app`. A claim you didn't check is not a finding.
- **`grep -n`, not `rg`,** for anything you'll quote — `rg` mangles identifiers in this env.
- Don't fix anything. Don't write code. Report only.

## Output (the report)
1. **Verdict:** GREEN (safe to start P0-1 tomorrow) / YELLOW (start, but fix flagged items
   first) / RED (do not start — a load-bearing assumption is wrong).
2. **Citation check:** table of every cited path/symbol → exists? says-what-plan-claims?
3. **Findings:** numbered, each with `file:line`, what's wrong, and the fix. Rank by severity.
4. **The one thing** most likely to bite during P1 (the skeleton), and why.
Keep it tight. Evidence over prose. If it's GREEN, say so plainly — don't manufacture findings.
