# Plan panel + tasks dialog drift — prototype vs impl (2026-07-13)

**Our:** `app/renderer/src/PlanPanel.tsx` (+ `planState.ts`, `tone.ts`), `app/renderer/src/TasksDialog.tsx` (+ `tasksState.ts`, `agentIdentity.ts`)
**Prototype:** `~/catcode_prototype/cat-app/PlanPanel.jsx`, `~/catcode_prototype/cat-app/TasksPage.jsx`
**Built status:** both built and live-wired (`App.tsx:35` `PlanBar`/`PlanPanel`, `App.tsx:2125-2133`; `App.tsx:198` `TasksDialog`, `App.tsx:1639`). PlanPanel = `docs/migration/STATUS.md:274` P4-11 ✅ 2026-07-09, GUI-verified. Both surfaces are exhaustively pre-tracked: `PARITY-LEDGER.md` §24 (PlanPanel, 58 rows, 97% at `:2452`) and §21 (TasksPage, 45 rows, 80% at `:2449`) already dispose almost every element/UX-state gap as built/adapted/cut/deferred with citations. Only genuine untracked hex/px/shape deltas are reported below as new Findings.

## Scoreboard — H:0 M:2 L:2

## Findings (High → Low)

[Med] TaskRow mono-label title color is too dim: prototype's `isCmd` (bash/workflow/monitor) titles override to `color: '#c4c4c8'` while staying near-full brightness (`TasksPage.jsx:151-152`) — ours routes the same rows through `text-text-muted` = `#a1a1aa` (`theme.css:49`, `TasksDialog.tsx:200-204`). That's roughly Tailwind zinc-300 → zinc-400, a visible dimming applied to every Bash/Workflow/Monitor task's primary title text (not a decoration — the row's main content column), while Agent/Remote/Teammate/Dream titles stay at `text-text-primary` (`#f4f4f5`). Fix: give the mono branch its own lighter class, e.g. `text-zinc-300` (`#d4d4d8`, closest static Tailwind step to `#c4c4c8`) instead of reusing `text-text-muted`.

[Med] Plan-revise textarea gains a font-family the prototype never sets: prototype's revise `<textarea>` uses `fontFamily: 'inherit'` (`PlanPanel.jsx:275`), i.e. the ambient sans body font (`theme.css:73` `--font-sans` DM Sans) — nothing in the panel's ancestor chain sets a mono font, so this is a plain-text revision note. Ours adds `font-mono` explicitly (`PlanPanel.tsx:244`), rendering the same free-text revision instructions in DM Mono. This is a genuine, untracked typeface swap (not mentioned in `PARITY-LEDGER.md:1689`'s "real-backed" row, which only covers the wiring, not the font). Fix: drop `font-mono` from that `className` (`PlanPanel.tsx:244`) so it matches the plan-steps `<pre>`/prose treatment elsewhere in the same modal, which correctly stays non-mono for prose.

[Low] Header status pill shape + letter-spacing drift: prototype's `planning`/`executing` pill is a slightly-rounded rect (`borderRadius: 5`, `letterSpacing: '0.06em'`, `PlanPanel.jsx:212-213`) — ours renders it as a full stadium pill with looser tracking (`rounded-full ... tracking-wide`, `PlanPanel.tsx:159-163`; `tracking-wide` = `0.025em`, less than half the prototype's `0.06em`). At ~18px tall the corner-radius difference (5px vs effectively 9999px) reads as a distinctly rounder badge shape than the reference. Fix: `rounded-[5px] tracking-[0.06em]` in place of `rounded-full tracking-wide`.

[Low] Step row vertical rhythm runs tighter than the reference: prototype's read/checklist `StepRow` uses `padding: '7px 8px'`, `gap: 10`, `borderRadius: 9` (`PlanPanel.jsx:118`) — ours uses `px-2 py-1` (8px/4px — vertical padding roughly half), `gap-2` (8px), `rounded-md` (6px) (`PlanPanel.tsx:191`). Steps sit noticeably more cramped vertically than intended. Fix: `px-2 py-1.5 gap-2.5 rounded-lg` (≈8px/6px, 10px, 8px) to close the gap without going pixel-exact.

## Deferred / intentional (not drift)

- PlanBar/PlanPanel entirely repainted in the `info` tone (P0-2 accent/pink token) instead of the prototype's literal `PL_BLUE` (`#60a5fa`) hex, across the reopen bar, modal border, header icon/badge tint, and ApproveMenu highlight — INTENTIONAL, explicitly tracked: `PARITY-LEDGER.md:1653` ("Built with `info` tone tokens (P0-2 accent, not a literal blue)...") and `:1660`. Not re-flagged as drift.
- PlanPanel: persistent reopenable drawer, live per-step execution checklist (StepDot pending/running/done/blocked), inline step edit/add/remove/reorder, `plan.objective` summary, `executing · N/M` sub-state, `bypassPermissions` approve option, Tab focus-trap — all DEFERRED/CUT with reasons, `PARITY-LEDGER.md` §24 rows `1655,1656,1664,1667,1668,1671-1684,1687,1688,1696,1708` (no engine per-step state / no structured-edit write path / rejected at the security boundary).
- allowedPrompts header reworded away from "implies auto-grant" — INTENTIONAL security-driven copy change, `PARITY-LEDGER.md:1685` (Ant-gated `addRules`, renderer-authored rules forbidden by the security baseline).
- TasksDialog: "This session / All sessions" scope toggle, `ctrl+x ctrl+k` kill shortcut, Enter-to-inspect, per-type detail dialogs (Shell/Dream/Teammate/RemoteSession/AsyncAgent), "gated" dashed badge, `tpElapsed`/`tpTokens` helpers, `TP_IC` icon set — all DEFERRED/CUT with reasons, `PARITY-LEDGER.md` §21 rows `1483-1485,1500,1506-1509,1512,1513,1518-1520`.
- TasksDialog spinner idiom (`border-shell-seam border-t-text-muted`, `TasksDialog.tsx:236`) diverges from the prototype's literal `#3f3f46` ring — INTENTIONAL/systemic: the identical `border-shell-seam border-t-*` idiom is already established app-wide (`AccountsPage.tsx:317,498`, `StartupSurfaces.tsx:209`), not local drift to this file.
- Active/Completed grouping (vs the real Ink dialog's per-type grouping) — INTENTIONAL parity-default choice, `PARITY-LEDGER.md:1490`.
- Task kind-badge colors (new P0-2-era hex picks vs the prototype's literal oklch) — INTENTIONAL, `PARITY-LEDGER.md:1499`; all seven `TASK_COLOR_CLASS` entries verified to resolve to their Tailwind palette name exactly (e.g. `#fbbf24`→amber-400, `#60a5fa`→blue-400, `#c084fc`→purple-400 — checked against Tailwind's default palette, no drift in the color-class map itself).
- No Tailwind dynamic-class trap in either file: all tone/kind/state colors resolve through static enumerated maps (`toneClasses`, `taskColorClass`, `agentStateMeta`) — no interpolated arbitrary-value classes found.

## Doc-drift notes

None — both ledger sections (§24, §21) matched current source on every row checked; no stale claims found.
