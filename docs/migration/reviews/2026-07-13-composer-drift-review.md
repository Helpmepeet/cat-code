# Composer drift review — prototype vs. implementation (2026-07-13)

**Method.** Ten parallel code-vs-code reviewers, one per composer surface, each diffing our
implementation against the prototype **source** at `~/catcode_prototype/cat-app/`
(`Chat.jsx` = composer surface, `Surfaces.jsx` = shared chip primitives) — not screenshots.
Every finding cites `file:line` on **both** sides. Tailwind token→hex resolutions were verified
against `app/renderer/src/theme.css`; the Tailwind-v4 dynamic-class trap was checked on every
arbitrary class.

**How to use this doc.** §1 = do-first High fixes. §2 = cross-cutting fixes (one change repairs
several chips). §3 = the remaining Med/Low, **grouped by file** so you can fix a file in one pass.
§4 = confirmed-intentional deviations — do **not** "fix" these. §5 = doc-drift side notes.
§6 = suggested order. Prototype line refs are from the `Jun/Jul` prototype snapshot; re-verify
before editing since source moves.

## Scoreboard

| # | Surface | Our file | High | Med | Low |
|---|---|---|---:|---:|---:|
| 1 | Input row / textarea / focus rule / backdrop | `App.tsx` | 0 | 1 | 4 |
| 2 | Send / stop / attach buttons | `App.tsx`, `ComposerActionsBar.tsx` | 1 | 0 | 2 |
| 3 | Chip-rail structure / order / separators | `ComposerActionsBar.tsx` | 0 | 1 | 1 |
| 4 | ColumnChipFace grammar (`RAIL_FACE`) | `ComposerActionsBar.tsx` | 1 | 2 | 4 |
| 5 | Model chip + picker | `ComposerActionsBar.tsx` | 2 | 1 | 4 |
| 6 | Reasoning / effort chip | `ComposerActionsBar.tsx` | 0 | 2 | 2 |
| 7 | Fast ⚡ chip | `ComposerActionsBar.tsx` | 1 | 2 | 2 |
| 8 | Permission mode chip + popover | `PermissionModeChip.tsx` | 1 | 2 | 3 |
| 9 | Context donut gauge | `ContextGauge.tsx` | 0 | 1 | 1 |
| 10 | Active account face | `ComposerActionsBar.tsx` | 0 | 1 | 1 |
| | **Total (raw)** | | **6** | **13** | **24** |

Raw High count is 6, but the Fast-primitive High is reported by two reviewers (#4 + #7), so there
are **5 distinct High issues** (§1). Several Med/Low collapse into the cross-cutting fixes in §2.

Good news up front: the pieces that were most fiddly are **byte-exact** — send-button up-arrow SVG,
attach plus-icon, donut geometry (16×16 / R6.5 / stroke 3 / pink `#f472b6` headroom hue), placeholder
string+color+weight, input font/caret/gradient, `RAIL_FACE` padding/radius/size/weight, mode order +
all labels/descs, Ask/Auto/Bypass tints. The drift is concentrated in **interaction states**
(`open`/`cursor`/hover), **picker row grammar** (RadioRow), and the **Fast chip**.

---

## §1 — High-priority fixes (do first)

### H1. Fast chip is the wrong primitive, wrong color, and missing its on/off shape cue
*Reported by #4 and #7 (cross-confirmed).* Prototype `FastChip` (`Surfaces.jsx:694-718`) is **not**
built on `ColumnChipFace` — it is a bespoke **22×22 icon-only square button** (`padding:0`,
`borderRadius:5`, `justify-center`), amber `#fbbf24` when on / `#3f3f46` when off, and it toggles the
bolt's **`fill`** between `currentColor` (on) and `none` (off) as a second cue beyond color.
Ours reuses `RAIL_FACE` for both `FastFace` (`ComposerActionsBar.tsx:79-91`) and `FastChip`
(`:254-290`, className `:283`), tints it `text-accent` **pink** (`:82`, `:283`), and always renders
`fill="currentColor"` (`:86`, `:285`) — so it's a ~23×19px rounded rectangle, the wrong color family,
and on/off is color-only.
- **Fix:** give Fast its own face class — `inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-[5px] p-0 transition-colors` (mirror the Attach button at `:349`), not `RAIL_FACE`. Tint `text-tone-warn` (`--tone-warn:#fbbf24`, already used by Reasoning) on / `text-[#3f3f46]` off with a `hover:text-text-subtle` (`#71717a`) target. Toggle the SVG `fill` solid/hollow with on/off.

### H2. Composer send-slot never becomes a Stop button while generating
*Reported by #2.* Prototype swaps the same 30×30 send slot for a Stop icon while `isGenerating`
(`Chat.jsx:1413-1423`: `color:#f87171`, 13×13 filled `<rect x=6 y=6 w=12 h=12 rx=2>`). Ours always
renders the up-arrow (`App.tsx:2278-2303`); the only stop affordance is a **separate bordered text
button** `■ Stop` in the activity row (`App.tsx:2516-2524`, shown via `App.tsx:2165-2175`) — a
different control in a different place, not a re-skin of the toggle.
- **Fix:** while generating, render a 30×30 `rounded-lg` transparent button in the send slot with `text-tone-danger` (`#f87171`, `theme.css:27`) and a 13×13 `fill="currentColor"` rounded-rect (`rect x=6 y=6 w=12 h=12 rx=2`) wired to `stopTurn`. The elapsed/verb readout can stay in `ActivityIndicator`; the composer-corner icon itself must reflect generating state.

### H3. Model chip face shows the raw model id, not the friendly label
*Reported by #5.* Prototype `RunChip` renders `current.title` — e.g. `"GPT-5.4 Mini"`
(`Surfaces.jsx:93-97,101`). Ours shows the raw resolved string `gpt-5.6-terra`
(`ComposerActionsBar.tsx:151`, `{current ?? 'Model'}`). The wire **already carries** a friendly
label (`RunControlModelOption.label`, `protocol.ts:997-998`) and we already use it in the menu
(`:179`) — the face and menu just disagree.
- **Fix:** resolve the face text via `options.find(o => o.value === current)?.label ?? current`. Same root cause fixes the tooltip (§3, L-model-tooltip).

### H4. Model & Reasoning pickers drop the RadioRow visual grammar
*Reported by #5 (High) and #6 (Med).* Prototype menu rows are `RadioRow` (`Surfaces.jsx:272-299`):
14px tinted ring + 6px inner dot when active, title (weight 600/500), and a muted 10.5px description.
The **permission-mode popover already uses this correctly** (#8). But Model rows
(`ComposerActionsBar.tsx:162-185`) and Reasoning rows (`:227-244`) are bare text buttons — selection
is conveyed only by a bg tint / text-color swap, no radio glyph. (a11y `role="menuitemradio"` is
present but there's no visual affordance.)
- **Fix:** extract a shared `RadioRow`-style menu row (ring+dot tinted per item + title, optional desc) and use it in the Model and Reasoning popovers, as the mode popover does. Model options carry no `desc`/`tint` field on the wire (`protocol.ts:994-1001`) — that's a defensible real-data gap; the missing **ring+dot** is the actual fix.

### H5. Permission-mode chip has no pending-count badge
*Reported by #8.* Prototype shows an amber count badge on the chip face when `pendingPermissions > 0`
(`Surfaces.jsx:314-323`) plus a "N pending decision(s) · review →" popover footer (`:348-359`).
Ours has neither, and **the wire carries no pending field** — `PermissionContextSnapshot`
(`protocol.ts:420-428`) has `mode` / rules / `additionalWorkingDirectories` /
`isBypassPermissionsModeAvailable`, nothing pending-related.
- **Fix:** this is a **wire-contract addition** (a pending-count field, validated at the sidecar per the protocol rules), not a class tweak. Scope it as a small protocol task before the badge can render. If out of scope now, log it as deferred with an owner rather than leaving it silent.

---

## §2 — Cross-cutting fixes (one change repairs several chips)

### X1. `cursor: pointer` is missing on every rail face
*#4 (Med), #2 (Low).* Prototype `ColumnChipFace` sets `cursor:pointer` (`Surfaces.jsx:234`); native
`<button>` defaults to `default` and Tailwind Preflight adds no cursor rule. `RAIL_FACE`
(`ComposerActionsBar.tsx:54-55`) and all three interactive consumers (`:149,:217,:283`) lack it, and
the send button (`App.tsx:2281`) has no `cursor-pointer`/`disabled:cursor-default` either.
- **Fix:** add `cursor-pointer` to `RAIL_FACE`; add `cursor-pointer disabled:cursor-default` to the send button.

### X2. Popover-open state doesn't keep the trigger lit
*#4 (Med), #6 (Low), #9 (Low).* Prototype ties the face color to the `open` prop, not just `:hover`
— `color: open ? '#f4f4f5' : valueColor`, with `onMouseLeave` guarded by `if (!open)`
(`Surfaces.jsx:233,239`). Ours brightens **only** via CSS `:hover`: ModelChip (`:149`) and
ReasoningChip (`:217`) both compute `open` from `usePopover()` but never feed it into the className,
so moving the pointer off the trigger into the open menu reverts the trigger color. The donut `%`
(`ContextGauge.tsx`) has the same missing open-state (lower stakes — it has no popover yet).
- **Fix:** `` `${RAIL_FACE} ${open ? 'text-text-primary' : '<resting tint>'} hover:text-text-primary` `` for Model (`text-[#22d3ee]`) and Reasoning (`text-tone-warn`).

### X3. Menu header + popover panel styling drift (all composer popovers)
*#5 (Low ×2), #8 (Low).* Prototype `MenuHeader` (`Surfaces.jsx:268-269`) is `#52525b`,
`letterSpacing:0.13em`, `fontWeight:700`. Ours (`ComposerActionsBar.tsx:125-126`,
`PermissionModeChip.tsx:158-160`) is `text-text-subtle` (`#71717a`, lighter), `tracking-wide`
(~0.025em, much tighter), `font-semibold` (600). Prototype `PopoverHost` (`Surfaces.jsx:248-265`) is
296px / 10px pad / 12px radius / deep shadow `0 18px 40px rgba(0,0,0,.55)`; ours is 256px / `p-1.5` /
`rounded-lg` / `shadow-lg` (much flatter).
- **Fix (shared):** header → `font-bold tracking-[0.13em] text-zinc-600` (`zinc-600` = `#52525b` exact). Panel → widen toward `w-[296px]`, `rounded-xl`, and a deeper custom shadow. Applies to Model, Reasoning, and Mode popovers together.

### X4. `RailSep` color is opacity-derived, not the flat hex
*#3 (Low), #10 (Low).* Prototype `Sep` is literal `#3f3f46` (`Surfaces.jsx:751`); ours `RailSep`
(`ComposerActionsBar.tsx:60`) is `text-white/20` ≈ `#3a3a3c` over the app bg — imperceptible but
inconsistent with the file's own static-literal discipline.
- **Fix (optional):** `text-[#3f3f46]`.

### X5. `RAIL_FACE` transition is 150ms; prototype faces are 120ms
*#4 (Low), #2 (Low attach).* Prototype `transition: color 0.12s` (`Surfaces.jsx:236`, and the attach
button `Chat.jsx:1446`). Ours uses bare `transition-colors` → Tailwind default 150ms.
- **Fix (optional):** append `duration-[120ms]` to `RAIL_FACE` and the attach button.

---

## §3 — Remaining findings, grouped by file

### `ComposerActionsBar.tsx`
- **[Med] Reasoning per-tier tint lost** (#6): every tier renders `text-tone-warn` (`:217`, `:406`, and every active menu row `:238`), so Low/High/Max all read as the prototype's "medium" amber. Prototype graduates the tint per level — low `#fde68a`, med `#fbbf24`, high `#f59e0b`, max `#d97706` (`Surfaces.jsx:131-134`), on both the face `valueColor` and the active radio dot. **Fix:** static per-level Tailwind class map (like the existing `text-[#22d3ee]` discipline at `:149`).
- **[Med] Right-group can wrongly compress** (#3): the account+context wrapper is `min-w-0` (`:427`) but the prototype's is `flexShrink:0` (`Surfaces.jsx:770`) — under a narrow composer the whole group compresses instead of only the left chips degrading. **Fix:** add `shrink-0` to that wrapper.
- **[Med] Model per-row provider badge is dead weight** (#5): `:172,:181-183` renders "OpenAI"/"Anthropic" far-right on every row via `justify-between`; since anthropic is filtered out, it's always "OpenAI" — zero-information, and it introduces a right-column the prototype doesn't have. **Fix:** drop the badge (or repurpose only if a real distinguishing tag exists).
- **[Low] Read-only fallback faces get no hover-brighten** (#4): the P4-24 `<span>` fallbacks — model `:385-390`, reasoning `:405-410`, account `:429-434` — lack `hover:text-text-primary`, losing the tooltip-discoverability cue. **Fix:** add `hover:text-text-primary` if not intentional.
- **[Low] Model menu-header + popover dims** (#5): see X3.
- **[Low] Model face tooltip embeds raw id** (#5): `:147` `title={`Model: ${current}`}` — proto is static `title="Model"`. Fixed by H3's label resolution.
- **[Low] Model static cyan tint** (#5): `:149` fixed `text-[#22d3ee]`; proto varies tint per model (`Surfaces.jsx:93-96`). No per-model tint on the wire → acceptable adaptation, flagged only.
- **[Low] Reasoning face tooltip wording** (#6): `:215` dynamic `Reasoning effort: …` vs proto static `"Reasoning"`. Harmless / arguably better.
- **[Low] Fast off-state color + glyph** (#7): rests `text-text-subtle` (#71717a) → hovers white; proto rests `#3f3f46` → hovers `#71717a`. Different bolt path (Heroicons vs Feather "zap"). Rolled into H1.
- **[Low] `RAIL_FACE` latent gaps** (#4): no `gap-*` (proto `gap:6`) and truncation sits on the whole face rather than an inner value-span — both inert today (single child, no trailing) but bite when a chevron/trailing/multi-child face is added. **Fix:** add `gap-1.5`; wrap value text in its own `overflow-hidden text-ellipsis` span.
- **[Low] Account switcher popover missing** (#10): plain non-clickable `<span>` (`:428-435`); proto is a 372px switcher (provider header, per-account usage rows, "+ Add / Manage →", `Surfaces.jsx:601-686`). **Tracked → P4-5** (`STATUS.md` P4-24 entry; `phase4.md:419`), not silent drift.

### `App.tsx` (composer)
- **[Med] No multiline row treatment** (#1): proto sets `items-start` + top hairline `border-t rgba(255,255,255,.09)` + `pt-2` and gives the send wrapper `mt-auto` when the draft has a newline (`Chat.jsx:1394-1395,1412`); ours is always `items-end` with no conditional (`App.tsx:2228`). Not tracked in ledger/STATUS. **Fix:** derive `isMultiline = prompt.includes('\n')` and toggle `items-start pt-2 border-t border-white/[0.09]` vs `items-end`, plus `mt-auto` on the send wrapper.
- **[Low] Container inset** (#1): proto container adds `padding:'0 8px'` (`Chat.jsx:1320`) for a 12px edge inset; ours (`:2140`) has none, only the row's `px-1`. **Fix:** add `px-2` to the container.
- **[Low] Focus-rule radius doubled** (#1): `rounded-sm` = 4px on a 2px bar; proto `borderRadius:2`. **Fix:** `rounded-xs` (2px).
- **[Low] Focus-rule transition** (#1): `transition-colors` → 150ms; proto `0.25s`. **Fix:** add `duration-[250ms]`.
- **[Low] Focus-rule scope too wide** (#1): `.peer` wraps textarea **and** send button (`:2228` over `:2278-2303`), so `peer-focus-within` keeps the accent gradient lit while the send button holds focus; proto's `focused` is set only by the textarea's own `onFocus`/`onBlur`. Edge case. **Fix (optional):** scope `peer` to the text-entry wrapper only.
- **[Low] Send-button cursor** (#2): see X1.

### `PermissionModeChip.tsx`
- **[Med] Plan tint** (#8): `text-sky-400`/`bg-sky-400` (`#38bdf8`, `:61-62`) vs proto `#60a5fa` = `blue-400`. **Fix:** `text-blue-400` / `bg-blue-400`.
- **[Med] Accept-edits tint** (#8): `text-emerald-400`/`bg-emerald-400` (`#34d399`, `:54-55`) vs proto `#4ade80` = `green-400`. **Fix:** `text-green-400` / `bg-green-400`.
- **[Low] Radio-row list gap** (#8): proto wraps rows in `gap:2` (`Surfaces.jsx:341`); ours maps directly (`:161-221`). **Fix:** wrap in `<div className="flex flex-col gap-0.5">`.
- **[Low] "Mode" header style** (#8): see X3 → `font-bold tracking-[0.13em] text-zinc-600`.
- **[Low, note] Face omits icon + "Mode" label** (#8): deliberate "quiet face" composer-density adaptation, self-documented at `:137-139`. Flagged for completeness, no fix urged.

### `ContextGauge.tsx`
- **[Med] Warn threshold** (#9): fires at `>=65` (`:22`) but prototype switches at `>=70` (`Surfaces.jsx:474`). Danger `>=90` matches. **Fix:** `65` → `70`.
- **[Low] Open-state `%` color** (#9): proto snaps the digit to `#f4f4f5` when its popover is open; ours has no interactive/open state (no popover yet). Lower stakes; see X2.

---

## §4 — Confirmed intentional (do NOT "fix" these)

These were checked and are faithful or deliberately adapted with an owner/citation:

- **Anthropic models filtered out** of Model + Reasoning pickers (Codex/OpenAI only) — `runControlsDomain.ts:263-265`, user decision 2026-07-13.
- **"Extra high"** for `xhigh` and **per-model effort tiers** — matches cat-code `getEffortLevelLabel` / `getSupportedEffortLevels`. The **"Auto"** (provider-default) option is a deliberate improvement over the prototype's fabricated `available[2]` fallback.
- **Account face always grey, status in the tooltip** — exactly faithful: the prototype's `AccountChip` passes no `valueColor`, and `ColumnChipFace` never renders `dot`/`icon` (dead props in the prototype too). Health lives in the (deferred) popover.
- **Account switcher popover deferred → P4-5**; **TasksChip → P4-9**; **TokenWarning (auto-compact glyph) → P4-0** — tracked in `PARITY-LEDGER.md` / `STATUS.md`, not silent cuts.
- **Fast hide-when-off+unsupported / disabled-with-real-reason** — a real-data value-add over the prototype's always-on toggle, sourced from `src/utils/fastMode.ts`.
- **Recap icon removed** from the icon cluster — user decision 2026-07-13 (`ComposerActionsBar.tsx:44-45`).
- **Rules block removed** from the mode popover (prototype has none); **Bypass row launch-flag gated** (`CATCODE_ALLOW_BYPASS`), shown disabled when unavailable — security baseline.
- **Backdrop gradient-fade absent** — the real composer is a docked flex form, not an absolute overlay (`PARITY-LEDGER.md:443`, `🔁 adapted`).
- **Mode order + all five labels/titles/descriptions; Ask/Auto/Bypass tints; RadioRow geometry** — verified exact in the mode chip.
- **Fast-mode `cooldown` state** unvisualized — a *shared* gap (neither prototype nor our wire models it), not a drift.

## §5 — Doc-drift side notes (source disagrees with docs)

Surfaced by reviewers per the "source over dated docs" rule — fix when those rows are next touched:

- `STATUS.md` P4-24 "RICH EMPTY STATE + COMPOSER BAR" describes the account chip as having a **"status-tinted health dot"** — contradicts current source (unconditionally grey, no tint). The newer in-file comment (`ComposerActionsBar.tsx:36-40`) is correct.
- `PARITY-LEDGER.md:481` lists **"ide/lsp … still deferred"** as owed work, but the prototype's `ChipStrip` never renders an IDE/LSP chip (`ide`/`lsp` are destructured-but-unused, `Surfaces.jsx:747`) — nothing is actually owed.

## §6 — Suggested execution order

1. **§2 cross-cutting first** (X1 cursor, X2 open-state, X3 header/panel, X4 sep, X5 duration) — small edits to `RAIL_FACE` + shared popover primitives that clear a chunk of Med/Low across every chip at once.
2. **H1 Fast** (own primitive + amber + fill toggle) and **H3 Model label** — self-contained, high visual payoff.
3. **H4 RadioRow** — extract the shared menu row, wire Model + Reasoning; also lands the Reasoning per-tier tint (§3) and the Model dead-badge removal.
4. **H2 Stop-icon swap** — touches `App.tsx` send slot + stop wiring.
5. Per-file Med/Low mop-up (§3): mode tints, warn threshold `70`, multiline row, right-group `shrink-0`, focus-rule nits.
6. **H5 pending badge** and **account switcher (P4-5)** — need wire/protocol work; scope separately.

All findings are read-only observations; nothing in the codebase was modified by this review.
