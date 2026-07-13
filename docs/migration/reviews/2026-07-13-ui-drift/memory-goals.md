# Memory page + Goals page drift — prototype vs impl (2026-07-13)

**Our:** `app/renderer/src/MemoryPage.tsx`, `app/renderer/src/GoalsPage.tsx`
**Prototype:** `~/catcode_prototype/cat-app/MemoryPage.jsx`, `~/catcode_prototype/cat-app/GoalsPage.jsx`
**Built status:** built — P4-10 `✅ 2026-07-07` (`docs/migration/STATUS.md:273`), read-only `thread-goal.snapshot` + `memory.snapshot` seams, 62/0 focused tests. Both surfaces already carry an exhaustive per-element ledger (`docs/migration/PARITY-LEDGER.md` §22 GoalsPage lines 1524-1597, §23 MemoryPage lines 1599-1645) covering essentially every structural/architectural divergence as adapted/deferred/cut with P4-10 §0 as the owner. No explicit "GUI-VERIFIED (operator)" note exists for P4-10 in STATUS.md (unlike P4-9/P4-12) — worth a live pass, but not drift.

## Scoreboard — H:0 M:1 L:0

## Findings (High → Low)

[SEVERITY Med] Memory-type chip loses all color coding: prototype `MEM_TYPE` gives each auto-memory `type` a distinct hex via `MemTypeChip` — user `#a1a1aa`, feedback `#f472b6`, project `#60a5fa`, reference `#5eead4` (`MemoryPage.jsx:19-24,34-43`) — we render `memory.type` through the generic `Pill` component (`MemoryPage.tsx:188`), which is the exact same neutral `border-shell-seam bg-shell-hover text-text-subtle` style used for every other badge on the page — "included"/"direct", "N path rules", "truncated" (`MemoryPage.tsx:225-231`). All four memory types plus "untyped" render visually identical; the whole point of a "small color-coded chip" (prototype's own comment, `MemoryPage.jsx:18`) is lost. Fix: add a static per-type class map (same idiom already used to fix this exact class of bug in P4-9's Tasks panel — `TASK_COLOR_CLASS`/`AGENT_DOT_CLASS`, `STATUS.md:272`) — do not interpolate a hex into an arbitrary-value class (Tailwind v4 no-op trap). Existing tokens line up exactly: `user` → `text-source-user bg-source-user/10 border-source-user/25` (`theme.css:66` = `#a1a1aa`, exact match), `project` → `text-source-project bg-source-project/10 border-source-project/25` (`theme.css:67` = `#60a5fa`, exact match), `feedback` → `text-accent bg-accent/10 border-accent/25` (`theme.css:8` `--accent` = `#f472b6`, exact match), `reference` → `text-teal-300 bg-teal-300/10 border-teal-300/25` (Tailwind's default `teal-300` = `#5eead4`, exact match to the prototype hex — no new token needed).

## Deferred / intentional (not drift)

Both surfaces are heavily re-architected vs. the prototype by design (P4-10 §0), and every one of the following is already tracked with an owner in PARITY-LEDGER.md — none are new findings:
- GoalsPage is a single-session read-only `GoalCard`, not a cross-session roster — INTENTIONAL: the prototype's own header comment (`GoalsPage.jsx:3-22`) calls the roster "a deliberate divergence… DEMO-ONLY surface — wire to per-session ThreadGoal on migration"; ours does exactly that (`PARITY-LEDGER.md:1543`).
- Create/Replace/Pause/Resume/Clear goal actions, both modal dialogs, hover-reveal "open ›", row click-to-session-nav, spinner-ring/dimming — DEFERRED: `STATUS.md P4-10 §0` (writer boundary), ledger rows 1535-1587.
- Goal status tone mismatches (active=tone-good not pink, paused=text-subtle not amber, budget_limited=tone-warn not red, complete=accent not gray) — DEFERRED/adapted, `PARITY-LEDGER.md:1552-1555` (enum labels/values are source-accurate; only decorative tone differs, already logged).
- MemoryPage `/init` CTA, all "Open to edit" buttons + hover states + toast, `MemMeta` lines/bytes, MEMORY.md "index" row/badge, oversize-warning banner, team "shared" (teal) badge, precedence-hierarchy sentence — DEFERRED to the safe-writer boundary or CUT (content bodies withheld engine-side): `STATUS.md:226 §0`, `PARITY-LEDGER.md:1609-1629,1635,1637`.
- "Agent memory" section (per-agent dirs) — `❓ missing-no-owner`, `PARITY-LEDGER.md:1638-1639` — already flagged as needing a human ruling (cut-as-mock vs. real gap); not re-flagging here, two-strikes rule (§migration.md) means this should get a named owner if it surfaces in a third review.

## Doc-drift notes

- `PARITY-LEDGER.md:1631` marks `MemTypeChip` as "✅ built… 4 types match `MEMORY_TYPES`/`AutoMemoryType` exactly" — true for the type *taxonomy*, but the row omits that the per-type *color* (the actual differentiator a "chip" is for) was dropped entirely. Recommend amending that row to 🔁 adapted once the Med finding above is triaged, rather than leaving it read as fully built.
