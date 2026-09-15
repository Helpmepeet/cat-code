# D5 — Does welcome-launcher state persist?

**Status: SUPERSEDED FOR AGENT MODE 2026-09-07; ARCHITECTURE RULED 2026-07-04 FOR
THE REMAINING LAUNCHER.** This rules
the architecture half of INVENTORY's D5 — whether the `WelcomeScreen` launcher's state
(project recents, branch chooser, "start in") needs desktop-owned persistence — and surfaces
the product half. The row stays open until the operator answers §4. All anchors verified
against the working tree 2026-07-04; where this doc and source disagree, source wins.

**Retirement amendment 2026-09-07.** The Agent Mode Orchestrator toggle and its
desktop mode-switch path were retired. The remaining WelcomeScreen launcher uses
the derived recents and trust decisions below; generic worker UI is not a
launcher concern. The removed inbound mode verb is rejected by the sidecar, and
the locked transport, N-process, raw-event, die-with-window, and two-id decisions
are unchanged.

| # | Question | Verdict |
|---|---|---|
| **W1** | Is there a persisted recents/project-history list in source? | **NO.** `src/utils/config.ts` and `src/utils/sessionStorage.ts` re-verified: the only "project history" hit is `removeProjectHistory` (`config.ts:1004`) — a *migration cleaner* stripping the legacy per-project prompt-history field. No `recentProjects`, no ordered recency store. |
| **W2** | Is "recent projects" derivable without a new store? | **YES, from three real sources:** (a) `GlobalConfig.projects: Record<path, ProjectConfig>` (`config.ts:188`) — every project the engine ever ran in, with per-path trust (`:111`); (b) the engine's per-project transcript dirs (`getProjectDir`, `src/utils/sessionStorage.ts:229`) with session files carrying mtimes; (c) **the D1 registry** — rows already persist exactly `cwd` + `lastAttachedAt` + `createdAt` (`REGISTRY.md` §3), i.e. desktop-native recency, durable, already decided. |
| **W3** | Is "start in a worktree" real? | **YES.** `createWorktreeForSession` (`src/utils/worktree.ts:703`), CLI `--worktree[=name\|PR]` (`src/main.tsx:1182-1185`, fast-path `worktree.ts:1252,1287-1294`), branch naming (`worktreeBranchName`, `:222`), gate `isWorktreeModeEnabled` (currently hard-true, `src/utils/worktreeModeEnabled.ts:9-11`). A launcher "start in: worktree" maps to a real launch capability, computed host-side *before* spawn (it produces the cwd — composes with HC1). |
| **W4** | Is the branch chooser real? | **Only as the worktree flow's name/base input.** There is no general "pick a branch to start on" primitive — the engine starts in a cwd and the checkout's branch is whatever it is. The prototype's branch dropdown on a *local* start is garnish; on a *worktree* start it maps to the real slug/base parameters (`worktree.ts:222,258`). |
| **W5** | Are the rest of the WelcomeScreen pieces real? | **YES (already so marked in INVENTORY):** Codex account table = pool status (W4/S8 Accounts domain), orchestrator toggle = real Agent Mode (`src/agent-mode/agentMode.ts`), per-path trust in the picker = G1 of `STARTUP-GATES.md`. Not at issue in D5. |
| **W6** | Architecture ruling | **Derive, don't persist (v1).** Recents = D1 registry rows (primary, includes closed-but-restorable) ∪ engine project dirs (secondary, for projects the desktop never opened), ordered by recency, trust-badged from `GlobalConfig.projects`. **No new store.** A *curated* list (pins, ordering, hiding) is the only thing that would need one — product question §4. |

---

## 1. Why "derive" wins on architecture grounds

- **The D1 registry already is the desktop's recency store.** Its rows persist `cwd` and
  `lastAttachedAt` per session (`REGISTRY.md` §3, [D] fields) — a "recent projects" list is a
  `GROUP BY cwd, MAX(lastAttachedAt)` over data that D1 already committed to writing. Adding a
  second persisted list would create the A7-class drift problem REGISTRY §9 warns about
  (two stores caching the same fact).
- **The engine side fills the cold-start gap.** On a fresh desktop install (empty registry),
  `GlobalConfig.projects` keys + transcript dirs surface everything the operator's TUI history
  knows — free continuity between TUI and desktop, impossible with a desktop-only store.
- **HC1 stays intact.** Every recents entry is either a registry row or an
  engine-recorded path — both are "existing registry row / native picker" class sources; the
  renderer still never authors filesystem paths.
- The prototype agrees with this reading of source — `Welcome.jsx:107-114` says verbatim that
  recents are "derivable from those project keys + transcript dirs; there is NO persisted
  ordered recents list upstream." (Its anchor `config.ts:110` has drifted one line to `:111`.)

## 2. "Start in" (worktree) — real, but scope-gated

W3 shows the capability is real and host-shaped: compute/create the worktree first
(`createWorktreeForSession`, `worktree.ts:703`), then spawn the session with the worktree path
as its cwd via the P3-1 spawn-config. Zero engine changes, zero new wire vocabulary. It is
still **new desktop scope** (the TUI does this via CLI flag, not a launcher UI), so it enters
the Phase-4 backlog only if the operator wants it in v1 (§4) — recommend deferring it behind
plain "start locally," which needs nothing.

## 3. Keep/cut summary

| Launcher piece | Verdict | Anchor / justification |
|---|---|---|
| Project picker w/ recents | **adapt — derived** (W6) | registry rows `REGISTRY.md` §3 ∪ `config.ts:188` ∪ `sessionStorage.ts:229`; trust badge `config.ts:111` |
| "Open folder…" | **adapt** | HC1 native picker (already decided, `REGISTRY.md` §6.1) |
| Per-path trust prompt in picker | **adapt** | = `STARTUP-GATES.md` G1 (same gate, same store); its "Open read-only" button follows D4 §5-Q1 |
| "Start in: locally" | **adapt** | just spawn-config cwd (P3-1) |
| "Start in: new worktree" | **defer pending §4** | real (`worktree.ts:703`, `main.tsx:1182-1185`) but new desktop scope |
| Branch chooser | **cut as standalone; keep as worktree name/base input if worktree ships** | W4 — no general branch-start primitive exists |
| Codex table | **not D5's** | W4-Accounts (S8) owns the account surface; the retired mode toggle has no replacement launcher control |
| Persisted ordered recents store | **do not build in v1** (recommendation; §4) | W1 — nothing to adapt; derivation covers the need |

## 4. Product question for the operator (blocks closing this row)

> **Q1 — Recents:** is *derived* recency (registry ∪ engine history, most-recent-first) the
> product, or do you want a **curated** launcher (pinned projects, manual ordering, hide) —
> which is the one thing that genuinely needs a new desktop-owned store?
> Recommendation: **derived for v1**; a pin store is a cheap later additive if dogfooding
> wants it (renderer/W2-owned preference, per REGISTRY §3's layout-exclusion precedent — NOT
> registry fields).
>
> **Q2 — Worktree launch:** in v1 launcher scope, or deferred?
> Recommendation: **defer** — it's real and cleanly host-shaped (§2), but it's new scope in
> the phase whose job is parity, and the CLI path still exists.

> **✅ OPERATOR RULING 2026-07-04.** Q1: **derive, don't persist** — recents = registry ∪
> engine history via the host API, no new store; a pin/curation store stays a cheap later
> additive if dogfooding wants it. Q2: **defer worktree-at-launch** past v1. This row is now
> CLOSED — Phase-4 WelcomeScreen unblocked at derived scope.

## 5. Pressure test

- **"Derived recents will be noisy/wrong (dead paths, one-off dirs) — a real store would be
  clean."** Derivation gets hygiene for free from its sources: the registry reaps rows whose
  transcripts vanished (REGISTRY §4.3) and existence-checks are one `stat` at render time;
  a curated store would need its *own* dead-path hygiene anyway. Noise beyond that (too many
  legitimate old projects) is a ranking/cap problem, solvable in the selector, not a
  persistence problem.
- **"You're smuggling the product answer by recommending 'derive'."** The architecture half —
  *no new store is needed for recency itself* — is a source fact (W1/W2), not a preference.
  The open half (§4-Q1: is curation the product?) genuinely changes what gets built and is
  left to the operator with the row held open.
- **"The registry wasn't designed to be a recents feed; you're coupling surfaces to its
  schema."** The launcher consumes it through the host API (`listSessions` descriptors carry
  `cwd`/`lastAttachedAt`, `REGISTRY.md` §6.1), not by reading the file — the same boundary the
  Sidebar already uses. No new coupling beyond what D1 §6 established; and REGISTRY §3 already
  excludes UI preferences from its schema, which is why a future pin-list is renderer-owned.
- **"Worktree-at-launch could silently mint paths the picker never showed (HC1 tension)."**
  No: the host computes the worktree path itself from a validated repo cwd + validated slug
  (`worktree.ts:67` validates slugs) — the renderer still authors no path; it picks an option.
  The tension is real enough to record (that's why the row stays a flagged defer, §2) but not
  a blocker.

## 6. Carry-forwards

- If §4-Q1 = curated: pins/ordering live as renderer-plane persistence (W2), never in the
  registry file (REGISTRY §3 exclusion), never in engine config.
- If §4-Q2 = ship worktree launch: it lands as spawn-config pre-processing in the host
  (compute cwd → HC1 revalidate → spawn), one Phase-4 session, plus copy from
  `worktreeUxCopy.ts` for parity.
- The launcher's account table + orchestrator toggle inherit their domains' read paths
  (W4-Accounts / Agent-Mode) — the welcome screen must not grow its own data feeds.
