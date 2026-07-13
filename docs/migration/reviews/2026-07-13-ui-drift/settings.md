# Settings (shell, fields, editors, extensions) drift — prototype vs impl (2026-07-13)

**Our:** `app/renderer/src/SettingsShell.tsx`, `SettingsField.tsx`, `SettingsEditors.tsx`, `SettingsExtensions.tsx` (+ shared `tone.ts`, `theme.css`)
**Prototype:** `~/catcode_prototype/cat-app/Settings.jsx`, `SettingsExtensions.jsx`
**Built status:** built. Shell/Field primitives ✅ P4-3, extension panels ✅ P4-12 (GUI-verified 2026-07-09), core value-editors (General/Model/Privacy/Theme, 13 controls) 🟡 P4-19 headless-GREEN + GUI-verified write round-trip (STATUS.md:304). Keybindings/IDE&LSP/model-list/output-style/accent/theme-preview panes and all extension writes/MCP-live/marketplace/Elicitation are explicitly split off with owners (see Deferred below) — real gaps, not silent cuts.

## Scoreboard — H:0 M:4 L:4

## Findings (High → Low)

[Med] Plugin "Update staged" pill renders in the wrong color family (pink, not blue): prototype's own `STATUS_TONES.info` is a distinct blue (`SettingsExtensions.jsx:20` — dot `#60a5fa` / text `#93c5fd`), matching the shared `Surfaces.jsx:791` Chip `info` tone (`color:'#bfdbfe'`, `accent:'#60a5fa'`). We render it via `<StatusPill tone="info" .../>` (`app/renderer/src/SettingsExtensions.tsx:255-258`) → `toneClasses('info')` (`app/renderer/src/tone.ts:89-97`) → `--color-tone-info: var(--tone-info)` → `--tone-info: var(--accent)` (`app/renderer/src/theme.css:28`), i.e. plain pink `#f472b6`. The justifying comment at `theme.css:26` ("the prototype has no distinct info hue") is factually wrong per both cited prototype sources. Fix: add a real `--tone-info: #60a5fa` (stop aliasing it to `--accent`) and give `tone.ts`'s `info` entry its own text/dot values instead of reusing the accent token.

[Med] Active-state text in both the Settings nav rail and the Plugins tab switcher uses `text-accent` (`#f472b6`) where the prototype's active/selected text is the lighter `#f9a8d4` — exactly the shade our own `--accent-soft` token exists for (`theme.css:9-13`, "active nav destination... sits one step brighter"), and exactly the pattern already used correctly elsewhere in this codebase (`app/renderer/src/Sidebar.tsx:470` `bg-accent/10 text-accent-soft`). Prototype: `Settings.jsx:727` (nav `color: on ? '#f9a8d4' : ...`), `SettingsExtensions.jsx:306` (tab `color: tab === k ? '#f9a8d4' : ...`). Ours: `app/renderer/src/SettingsShell.tsx:221` (nav active `text-accent`), `:231` (locked-icon active `text-accent`), `app/renderer/src/SettingsExtensions.tsx:208` (Plugins tab active `text-accent`). Fix: swap all three to `text-accent-soft`.

[Med] `ToggleSwitch` (`app/renderer/src/SettingsEditors.tsx:184-204`, the live control behind every boolean settings field) diverges from the prototype's `SwToggle` (`Settings.jsx:64-72`) in a way that hurts legibility, not just tint: prototype's off-track is a flat `rgba(255,255,255,0.1)` (10% white, `border:'none'`) with a `#71717a` gray knob, and the on-track knob is dark `#09090b` (a punched-through look on the pink fill). Ours uses a half-as-strong off-track `bg-shell-hover` (`rgba(255,255,255,0.045)`, `SettingsEditors.tsx:192`) plus an added `border-shell-seam`/`border-accent/40` ring not present in the source, and the knob is `bg-white` in BOTH states (`:198-201`) instead of tracking on/off like the prototype. Net effect: the off state reads as a near-invisible track with a bright white dot rather than a legible flat pill. Fix: drop the border classes, use `bg-white/10` for the off-track, full `bg-accent` (not `/80`) for on, and knob `bg-app-bg` on / `bg-text-subtle` off.

[Med] The "Managed by your organization" banner title (`app/renderer/src/SettingsShell.tsx:456`, `text-source-policy` → `#f87171`, full-saturation danger red) is noticeably stronger than the prototype's title, which uses the softer `#fca5a5` and reserves the saturated `#f87171` for the icon only (`Settings.jsx:418` icon vs `:420` title). Fix: `text-[#fca5a5]` (static arbitrary value, compliant with the dynamic-class rule) on the title span; keep the icon on `text-source-policy`.

[Low] Secondary/receded text throughout the shell renders one shade brighter than intended: the prototype uses two darker grays for de-emphasized labels — `#52525b` for field descriptions and `PaneSection` titles (`Settings.jsx:106`, `:131`) and `#3f3f46` for nav group headers (`Settings.jsx:718`) — but we only have one "subtle" tier (`--color-text-subtle: #71717a`), used at `app/renderer/src/SettingsField.tsx:184` (desc), `:222` (PaneSection title), and `app/renderer/src/SettingsShell.tsx:209` (nav group label). Field row labels/values are similarly a shade brighter (`text-text-primary` `#f4f4f5` vs the prototype's `#e4e4e7`, `Settings.jsx:103`). No single-line fix — this needs a 4th/5th gray tier in `theme.css` if the recessed hierarchy matters; flagging as a token-system gap rather than per-instance drift.

[Low] `ResolutionOrderLegend` / "Configuration sources" box (`app/renderer/src/SettingsField.tsx:238`, `bg-shell-hover` ≈ 4.5% white) is roughly twice as visible as the prototype's matching bar (`Settings.jsx:196`, `rgba(255,255,255,0.02)`).

[Low] `ToggleSwitch` is physically larger than the prototype's: `h-[22px] w-[38px]` (`SettingsEditors.tsx:188`) vs prototype's `34×19` (`Settings.jsx:67`).

[Low] The one live numeric control, `IntField` (transcript retention, `app/renderer/src/SettingsEditors.tsx:246-308`, wired via `privacy` pane / `cleanupPeriodDays`), is `text-right`-aligned (`:288`) and uses the default sans font, whereas the prototype's numeric-entry convention is left/default-aligned with a `mono` font override for raw numbers (`Settings.jsx:87-95` `SwText`, exercised with `mono width={100}` at `:187` for the closest analogous "Max output tokens" field — that exact field is deferred, but the convention it demonstrates isn't followed by our one live numeric control).

## Deferred / intentional (not drift)

- Keybindings, IDE & LSP, default-model select, output-style select, accent swatch, code theme/font, live theme preview canvas, share-session-data toggle, crash-reporting toggle — **DEFERRED (P4-19 split, owners named)**: `PARITY-LEDGER.md` rows 771-813, `STATUS.md` P4-19 "SPLIT/deferred (flagged)".
- MCP live connection status/counts/reconnect/auth, all extension writes (MCP add/remove, plugin/skill/hook enable-toggle), plugin marketplace browsing, `ElicitationDialog` — **DEFERRED, owner P4-12 §0 flags**: `STATUS.md:275`.
- Managed badge label reads "Managed" vs prototype "Policy" — **DEFERRED/flagged**: `STATUS.md:219`, `PARITY-LEDGER.md:2234`.
- General ▸ Display name / Default editor / On-startup / Max-output-tokens, Model ▸ Auto-compact, Privacy ▸ Share-session-data / Crash-reporting — no engine setting key exists; **DEFERRED (P4-19)**: `PARITY-LEDGER.md:771-787`.
- Nav item count badges (MCP·6, Plugins·4, …) dropped — **tracked adapted**: `PARITY-LEDGER.md:743`.
- Search input's leading magnifier icon dropped — **tracked adapted**: `PARITY-LEDGER.md:736`.
- "Native" category (Chrome/Desktop/Mobile/Voice) — **✂️ cut, tracked**: `PARITY-LEDGER.md:825`.
- Prototype's "Prototype controls" demo nav group — correctly omitted; not a real settings surface (prototype's own comment marks it demo-only, `Settings.jsx:636-640`). **INTENTIONAL**.
- Reset-to-default affordance exists in `Field` but no control yet supplies `modified`/`onReset` — **tracked dormant**: `PARITY-LEDGER.md:2241`.
- `IntField` surfaces its own inline error instead of the parent `Field`'s error slot — **INTENTIONAL**, documented in source (`SettingsEditors.tsx:15-16,244-245`).
- `ResolutionOrderLegend` moved from the prototype's GeneralPanel-only footer into a shared "Configuration sources" section (with a new `LayerSummary` of real on-disk layers) shown above the fields for every category that renders it — **INTENTIONAL upgrade**, tracked ✅ built: `PARITY-LEDGER.md:2236`.

## Doc-drift notes

- `theme.css:26` claims "the prototype has no distinct info hue" to justify aliasing `--tone-info` to `--accent`. This is contradicted by current source in two places: `SettingsExtensions.jsx:20` (`STATUS_TONES.info` = blue `#60a5fa`/`#93c5fd`) and `Surfaces.jsx:791` (Chip `info` tone, blue `#60a5fa`/`#bfdbfe`). See Finding M1.
