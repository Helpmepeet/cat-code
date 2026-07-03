> ⚠️ **SUPERSEDED 2026-06-26 by `PROGRAM-PLAN.md`.** This was the 06-19 cold-start handoff;
> the 06-26 interview restarted planning from zero. Read PROGRAM-PLAN.md instead.

# Migration handoff — read this first (morning session)

Written end of session 2026-06-19 (evening) for the next session. Goal of this doc:
let a COLD session continue without re-deriving anything or repeating mistakes.

---

## 0. TL;DR — where we are
We spent the session **planning the prototype→production migration of cat-code** (NOT
building yet). We produced a coherent 4-doc plan set and retired the two biggest risks
(the app↔engine seam, and shell/transport tech). **No production code written yet.**
Next real step is **Phase 1: the walking skeleton** — but the user wanted to sleep on
the docs first, so DO NOT start building unless they greenlight it in the morning.

## 1. The goal, in the user's own words
- Migrate cat-code from **TUI → a dedicated app** ("not a browser tab" — a real native app).
- **Every feature in the prototype must eventually be real**, but **start with whatever's
  wireable now** (~80% of the prototype is built).
- The prototype's **visuals are ~production-ready**; the hard part is features whose real
  cat-code home is unknown or that fight cat-code's architecture.
- **Multi-session is in scope** (the prototype's tabs/panels model).

## 2. CRITICAL working-style notes (the user corrected me repeatedly — honor these)
- **Do NOT jump to plans/artifacts/solutions.** The user pushed back HARD, twice, on me
  sprinting to a finished plan instead of discussing. Discuss first. Ask, listen, THEN act.
- **They like the AskUserQuestion tool for being interviewed** ("use ask tool to interview
  me"). Use it for decisions — but real decisions, not to rubber-stamp a plan.
- **They delegate engineering calls to me** ("it's up to you, I just want what's best for
  the user") — but I should make those calls from EVIDENCE (spikes against ~/cat-code),
  not gut. They valued that I spiked Electron-vs-Tauri instead of guessing.
- **They don't expect one doc to hold everything** — they explicitly wanted a proper
  multi-doc strategy. Keep the strategy/territory/depth split.
- They're an architect-executor (see global CLAUDE.md): arrives with plans, delegates
  implementation, course-corrects. "sure/yes/go ahead" = proceed immediately.
- Repo norm: **commit directly to master, no feature branches** (but ask before committing).

## 3. Two facts that REWROTE the plan mid-session (don't regress on these)
1. **`~/cat-code/web/` is STALE — ignore it entirely.** The user said it's "not real."
   It works but is a throwaway ahead of the design. My FIRST plan (now deleted —
   `MIGRATION-PLAN.md`) wrongly treated `web/` as the live migration target. Do not
   resurrect that framing. We build fresh; we may *mine* `src/web/` server code for reuse
   but assume nothing is correct without re-checking against `src/`.
2. **The prototype's 82 `// SOURCE:` anchors to `~/cat-code/src` are ACCURATE** (spot-checked
   8 at exact line numbers — all held). Trust them as the migration contract.

## 4. The plan docs (read in this order)
- `audit/MIGRATION-STRATEGY.md` — the HOW. Key ideas: this is NOT a strangler-fig (no
  facade — the TUI keeps living, prototype is a parallel artifact); our patterns are
  **vertical slices** + **anti-corruption layer** + **walking-skeleton-first**. Has the
  phase shape (0-6) and the per-domain working loop.
- `audit/MIGRATION-DOMAINS.md` — the WHAT/WHERE. 13 domains (A-M) derived from the actual
  prototype code. Bottom has the verified multi-session analysis.
- `decisions/SEAM-SPIKE.md` — how the app drives a real cat-code session. SETTLED.
- `decisions/SHELL.md` — Tauri + Bun sidecar + socket. SETTLED.
(`MEMORY.md` also has `catcode-migration-target` + `catcode-source-anchors-verified` —
but note the migration-target memory predates the "ignore web/" turn; treat the 4 docs
above as authoritative over that memory, and update that memory when convenient.)

## 5. The architecture we settled (the answer to "how does this even work")
```
Tauri shell (Rust: window + sidecar lifecycle + socket proxy)
  └─ spawns the cat-code Bun binary as a SIDECAR  (cli/cli-dev = standalone Bun, 177MB)
       └─ runs AppSessionWebSocketServer over AppSessionController → QueryEngine
          (QueryEngine = the SAME core the TUI uses, src/QueryEngine.ts:1314)
  └─ React UI (ported from prototype) ⇄ local socket ⇄ sidecar, rendering full SDKMessage
```
- **Why Tauri not Electron:** the engine is **Bun-native** (195 `bun:bundle` imports, can't
  run on Node), so it's a sidecar binary either way → Electron's "embed Node" value is void
  → Tauri wins on size (~8MB vs ~165MB shell). Full reasoning in decisions/SHELL.md.
- **The seam (`src/app-runtime/AppSessionController`)** is real, tested, current, has ZERO
  Ink/TUI imports (headless-safe), and its event stream carries the **full `SDKMessage`**
  (rich tool/thinking blocks) — so the prototype's rich transcript IS feasible. The stale
  `web/` mapper flattened it to a string; we DON'T reuse that mapper.

## 6. Still-open decisions (do NOT guess — ask the user)
- **Production target repo:** fresh app inside `~/cat-code` vs. promote this prototype
  workspace into the real app. User said "idk" — genuinely undecided. Needs a real decision
  before/at Phase 1 (it determines WHERE the skeleton's files live).
- **Multi-session process model:** N sidecars coordinated via the session registry
  (`src/utils/concurrentSessions.ts` — PID-file-per-session, kind/status/name). Gates the
  shell domain (Phase 5). Not needed for the single-session skeleton.
- **Skeleton transport sub-question:** reuse `AppSessionWebSocketServer` as-is vs. a thin
  custom socket wrapper around `app-runtime`. Decide when building Phase 1.
- **Per-domain deliverable format:** TBD — we agreed to define it by DOING the first domain,
  not pre-specifying it.

## 7. Suggested next-session opening (don't just barrel in)
Ask the user: did they read the docs / any pushback? Then the live fork is one of:
(a) act on doc feedback, (b) resolve the production-target-repo decision (needed for Phase 1),
or (c) greenlight Phase 1 — the walking skeleton (FIRST real code; thinnest path: Tauri shell
+ Bun sidecar runs ONE real session, renders ONE real message, sends ONE real prompt).
If greenlit, the production-target-repo decision must be made first (it sets the file home).

## 8. What exists on disk right now
- Plan docs: the 4 files in §4 (now under `docs/migration/`; originally authored under the
  prototype's `audit/migration/`).
- `audit/visual-build-prompts.md` — the PRE-EXISTING prototype build backlog (~35 sessions,
  mostly ✅). Different thing from the migration plan; it's how the prototype itself was built.
- NO production code, NO Tauri scaffold, NO sidecar wiring yet. Pure planning state.
- Prototype itself unchanged (the `cat-app/*.jsx` working-tree edits in git status predate
  this session and are unrelated to the migration planning).
