# Phase-4 GUI acceptance script (2026-07-22)

**Purpose.** Phase 4 is **24 ✅ / 13 🟡** — the 🟡 are built + headless-green but
never operator-accepted. This is the single-sitting checklist to drive them to ✅,
which is the input to **P4-REVIEW** (the Phase-4 gate) → **Phase 5** (release).
It exists because the renderer suite is **SSR-only** and structurally can't see
interaction/ordering bugs — the CC-5 pass proved this (7 checks green, 4 real
defects found only by running it).

**How to run.** Operator-driven — the agent does NOT drive your GUI. Launch the
dev app per `docs/migration/process/GUI-VERIFICATION.md` (P3-H harness). For any
test turn needing a model, use **`gpt-5.6-luna` at low effort** on a healthy
account — never frontier quota. Report pass/fail per item back to the agent; it
triages/fixes headless-fixable failures and flags the rest.

Each session's exhaustive element list is in its report/backlog; the checks below
are the LOAD-BEARING acceptance, not the full element enumeration.

---

## Part A — CC-5 fresh fixes (re-check the 3 just-landed; merged `5927fc6`/`89f2a6a`)

- **A1 · D1 mode pill.** Settings ▸ Permissions → the read-only **current-mode
  pill** shows (e.g. `default`/`plan`), and **no** interactive mode buttons
  appear. *Defect:* pill missing (the pre-fix bug) or clickable mode buttons
  present (T6b breach).
- **A2 · E1 apply_patch diff.** Open the **ToolInspector** drawer on a real
  `apply_patch`/Edit row → the **Diff section renders** (primary file's hunks). A
  real **Bash** row still shows **no** Diff. *Defect:* apply_patch row has no Diff.
- **A3 · #5 failure toast.** Trigger a verb failure — reject an invalid settings
  value, or `task.stop` an already-terminal task → a **red (danger) toast** with
  the sidecar's real error. Success actions stay silent. *Defect:* the failure is
  silent (the pre-#5 behavior).

## Part B — P4-28 warp re-test (the #4 side-effect — HIGH VALUE, likely fixed)

Source analysis (STATUS P4-28) says catalog-owner **#4 structurally eliminated
the leading suspect** behind the "open-from-history row stays at the top" warp.

- **B1 · warp settles now.** Open a **terminal-history** row into the app. →
  Expected NOW: it may briefly jump toward the top, then **SETTLE** to its real
  transcript-activity position within **~30 s** (one catalog refresh). Pre-#4 it
  **never** settled. *Defect:* still pinned at the top after ~40 s → #4 didn't
  fully resolve it; the "resolve the catalog entry at mint" refinement is then
  the follow-up (now #4-owned, not the parked CC-2 seam).
- **B2 · cap eviction (separate open finding).** Open several history rows in a
  row. → Watch whether browsing silently evicts a genuinely-restorable recent
  session (the `MAX_REGISTRY_SESSIONS = 32` "it's not a bookmark if it only goes
  to top when we open it" finding). This is an **undecided design item**, not a
  fix — note if it bites so the reshape decision can be made.

## Part C — the Phase-4 🟡 backlog (drive to ✅)

### Tier 1 — surfaces with open findings (scrutinize; likely to surface defects)

- **P4-24 · ChatView fidelity** — the `SessionPane` transcript+composer matches
  the prototype ChatView, **not** the old scaffold (`<h1>Transcript</h1>` /
  single-line input). Confirm the real composer chrome + transcript render.
- **P4-8 · Orchestrator** (roster/detail/focus) — open the orchestrator surface;
  the roster + detail render over **real** task/agent state (not mock rows).
- **P4-5 · Accounts + Codex pool** — Settings ▸ Accounts shows **real** pool/lease
  status; AccountLifecycle affordances reflect true account state. (Do NOT trigger
  a real login/token action — read-only visual acceptance only.)
- **P4-6 · Sessions page + actions** — `SessionActionsMenu` (row ⋯ / right-click)
  and `MetadataInspector` open over a real session row with real metadata.

### Tier 2 — eyeball pass (lower risk; go fast)

- **P4-4 · Shell chrome** — Sidebar / TabBar / WorkspaceLayout match the prototype.
- **P4-15 · Startup + trust gate + reauth banner** — the trust gate appears on
  session-create in an untrusted cwd; the reauth banner is non-blocking with a ×
  close (the all-dead wall stays persistent).
- **P4-17 · Welcome/launcher** — recents are the real derived registry ∪ history.
- **P4-18 · Transcript rendering (18b/18c)** — tool-cards, prose, activity, and
  scroll behave over real content (18a already GUI-verified).
- **P4-19 · Settings value-editors** — General/Model/Privacy/Theme/Keybindings/
  IDE/LSP editors reflect real settings and a write round-trips.
- **P4-20 · AskUserQuestion** — a live-turn `AskUserQuestion` renders the full
  interactive flow (not the raw-JSON permission card it used to degrade to).
- **P4-26 · Nav selection** — sidebar nav routing selects the right surface.

---

## After the pass

1. **Failures** → agent triages: headless-fixable (like CC-5's D1/E1) get a fix
   session; parked/design items (CC-2 tab-lifecycle, the cap reshape) are flagged,
   not silently fixed.
2. **All green** → run **P4-REVIEW** (the Phase-4 gate instrument) → open
   **Phase 5** (production hardening & release).

**Known parked (do not expect these to pass; they're deferred by ruling):** the
**C2 clean-close** behavior (tab vanishes on clean close / preview stays green) is
the operator-parked **CC-2** tab-lifecycle bug; **A2 catalog latency** (~30-51 s
external-session refresh) is an accepted #4 tuning tradeoff.
