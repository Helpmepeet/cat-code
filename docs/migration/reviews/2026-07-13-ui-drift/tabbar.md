# Tab bar drift — prototype vs impl (2026-07-13)

**Our:** `app/renderer/src/TabBar.tsx`
**Prototype:** `~/catcode_prototype/cat-app/TabBar.jsx`
**Built status:** built — `docs/migration/PARITY-LEDGER.md:225-273` (§03 TabBar, "🔁 adapted", 97% row at `PARITY-LEDGER.md:2431`: 22 built / 13 adapted / 8 real-added / 1 cut / 0 deferred / 0 missing of 44 rows). This is one of the most exhaustively pre-tracked surfaces in the ledger; most candidate gaps below are already rows there — only genuine untracked hex/px deltas are reported as new Findings.

## Scoreboard — H:0 M:2 L:6

## Findings (High → Low)

[Med] New-tab "+" button idle color: prototype paints it `#3f3f46`, a deliberately near-invisible "ghost" icon that only brightens on hover (`TabBar.jsx:110-111`) — ours uses `text-text-subtle` = `#71717a` (theme.css:50) at full opacity, always visible (`TabBar.tsx:126`). Two Tailwind-zinc steps brighter than intended (~zinc-700 → zinc-500), so the button reads as a normal control at rest instead of a quiet affordance. Hover state (`hover:text-accent` → `#f472b6`) already matches proto's `#f472b6` hover — only the idle tier is off. Fix: add a static darker class for this element only, e.g. `text-[#3f3f46]` (static arbitrary value, not interpolated — safe per Tailwind v4), or a new `--color-text-ghost` token if other surfaces want the same tier.

[Med] Inactive-tab title + Split/Unsplit idle label color: prototype uses `#52525b` (`TabBar.jsx:78` title, `:132` Split, `:151` Unsplit) — ours uses the same `text-text-subtle` = `#71717a` token (`TabBar.tsx:268` title, `:145` Split, `:157` Unsplit). One Tailwind-zinc step brighter (~zinc-600 → zinc-500) across every non-active tab and both split-cluster buttons, so the whole idle bar reads slightly louder than the reference's muted-chrome intent. Fix: same as above — a static `text-[#52525b]` on these idle-state spans, or a dedicated token, since `text-text-subtle` is shared app-wide and shouldn't be recalibrated just for this file.

[Low] `--color-shell-hover` token is `rgba(255,255,255,0.045)` (`theme.css:39`) vs the prototype's inactive-tab hover fill `rgba(255,255,255,0.025)` (`TabBar.jsx:68`) — ~1.8x the intended opacity, so hovering an inactive tab highlights more strongly than the reference. Fix: lower `--color-shell-hover` to `rgba(255,255,255,0.025)` (note: shared token — check other consumers before changing).

[Low] `--color-shell-active` token is `rgba(255,255,255,0.06)` (`theme.css:40`) vs the prototype's active-tab fill `rgba(255,255,255,0.05)` (`TabBar.jsx:63`) — one shade too strong. Fix: `0.05` if not shared elsewhere with a conflicting need.

[Low] Per-tab right-edge separator reuses `border-shell-seam` = `rgba(255,255,255,0.06)` (`TabBar.tsx:233`, theme.css:38) where the prototype's per-tab divider is a fainter dedicated `rgba(255,255,255,0.05)` (`TabBar.jsx:62`) — the outer container's bottom seam correctly matches 0.06 (`TabBar.jsx:38` vs `TabBar.tsx:103`), but the token is over-reused for the lighter internal divider. Fix: a second seam tier (e.g. `--color-shell-seam-soft: rgba(255,255,255,0.05)`) for internal dividers, or accept the 1-notch diff.

[Low] Tab padding/gap run 1px tighter than the reference on every axis: `pl-3 pr-1.5` = 12/6px (`TabBar.tsx:233`) vs prototype's `padding: '0 7px 0 13px'` = 13/7px (`TabBar.jsx:60`); `gap-1.5` = 6px (`TabBar.tsx:233`) vs prototype's `gap: 7` (`TabBar.jsx:59`). Fix: `pl-[13px] pr-[7px] gap-[7px]` if pixel-exact match is wanted, else accept as a sub-2px nit.

[Low] Active-tab title + Split/Unsplit hover text use `text-text-primary` = `#f4f4f5` (theme.css:48; `TabBar.tsx:268` title, `:145`/`:157` hover) vs the prototype's `#e4e4e7` for the same states (`TabBar.jsx:78,135,153`) — a shade brighter than the reference "primary" white. Fix: static `text-[#e4e4e7]` on these spans, or accept (both are near-white, low perceptibility).

[Low] Split/Unsplit cluster borders run ~2 points stronger than the reference: idle border `border-white/10` (`TabBar.tsx:145,157`) vs proto `rgba(255,255,255,0.08)` (`TabBar.jsx:131,149`); Unsplit hover border `hover:border-white/20` (`TabBar.tsx:157`) vs proto `rgba(255,255,255,0.18)` (`TabBar.jsx:153`); Split button horizontal padding `px-2.5` = 10px (`TabBar.tsx:145`) vs proto's 9px (`TabBar.jsx:130`). Fix: `border-white/8`, `hover:border-white/[0.18]`, `px-[9px]` if exactness is wanted.

## Deferred / intentional (not drift)

- Close-button hover-only reveal (`opacity-0 group-hover:opacity-100`, `TabBar.tsx:292`) vs prototype's always-visible dim × — DEFERRED/tracked: `PARITY-LEDGER.md:242` ("🔁 adapted... quieter bar", deliberate).
- Split duplicates the active session in the prototype vs ours opening the next un-panelled live session — INTENTIONAL: `PARITY-LEDGER.md:257,2131` (§0/HC1 — layout model forbids the same session in two panels).
- Drag-a-tab semantics: prototype drop replaces the whole target panel; ours splits off the drop edge — DEFERRED/tracked: `PARITY-LEDGER.md:2137` (adapted, P3-6).
- StatusDot / StatusChip / AttentionBadge / restart affordance / ARIA tablist+roving-tabindex / ⌘1-9 tooltip hints — all real-added, no prototype analog: `PARITY-LEDGER.md:267-273` (INTENTIONAL — genuine runtime-status and a11y capability the mock doesn't need).
- `draggingSessionId`-style global drag-tracking state (prototype `AppV2.jsx:98,503-504` feeds `WorkspaceLayout.jsx` drop highlighting) has no TabBar-side equivalent — INTENTIONAL/equivalent: the real `WorkspacePanels.tsx:129-131` achieves the same drop-target affordance via `event.dataTransfer.types.some(...)` on native `dragover` instead of app-level state; not a TabBar gap (out of this file's scope, verified in `WorkspacePanels.tsx`).
- Tab-roster reorder-on-restore bug (a restored session's tab jumps position) — tracked as known bug **CC-2** (`docs/migration/STATUS.md:26`, "restore/open must NOT reorder"), owner TBD — lives in `shellState.ts`, not a `TabBar.tsx` rendering defect, so out of this file's scope; noted for completeness only.

## Doc-drift notes

- `PARITY-LEDGER.md:234` marks the active-tab background fill "✅ built" citing the prototype's `rgba(255,255,255,0.05)` translating cleanly to `bg-shell-active` — the token is actually `0.06` (theme.css:40), a small but real mismatch the ledger's "✅ built" (not "🔁 adapted") label implies isn't there.
- `PARITY-LEDGER.md:235` calls the hover-background swap "equivalent UX" — the token (`0.045`) is materially higher than the prototype's literal (`0.025`), not just a mechanism change (imperative→CSS) as the row implies.
