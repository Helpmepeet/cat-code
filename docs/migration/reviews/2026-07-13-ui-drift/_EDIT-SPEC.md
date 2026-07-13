# Color-fidelity adoption sweep — shared edit spec (2026-07-13)

You are APPLYING verified color fixes from the completed drift review. This is a narrow, low-risk
sweep — color/token only. Read your area report (`<area>.md`) for the findings and `_REVIEW-SPEC.md`
for the review rules. Prototype source: `/Users/pt/catcode_prototype/cat-app/*.jsx`. Ours:
`/Users/pt/cat-code/app/renderer/src/`.

## New/available theme tokens (added 2026-07-13 to `app/renderer/src/theme.css`)
- `text-text-faint` → `--color-text-faint: #52525b`  (resting/quiet labels — the t4 grey)
- `text-text-ghost` → `--color-text-ghost: #3f3f46`  (ghost/disabled/idle — the t5 grey)
- `text-accent-soft` / `bg-accent-soft` / `border-accent-soft` → `--color-accent-soft: #f9a8d4` (lighter active pink; already existed)
- `tone-info` is now blue `#60a5fa` (already fixed at the token level — do NOT touch it; if a surface
  used `tone="info"` for a blue thing it is already correct now).

## IN SCOPE — apply ONLY these finding categories from your report
1. **Grey adoption:** a RESTING / ghost / idle / disabled label currently on `text-text-subtle`
   (#71717a) whose prototype target is #52525b or #3f3f46 → switch to `text-text-faint` / `text-text-ghost`.
2. **accent-soft adoption:** where the prototype's target is the lighter pink `#f9a8d4` → use
   `text-accent-soft` (etc.) instead of full `text-accent`.
3. **Exact-hex / shade correction:** a Tailwind named shade one step off the prototype's literal →
   replace with the exact value: a static arbitrary class `text-[#hex]` OR the correct shade number
   (e.g. cyan-300→`text-[#22d3ee]`, `#f87171`→`text-[#ef4444]`, violet-300→violet-400).
4. **Static-map fix for a dynamic-class trap:** replace an interpolated `` `${…}` `` className with a
   static lookup map (each value a complete literal class string).
5. **Per-type tint restore via a STATIC hex→class map** (e.g. a type/status chip that lost its colors).

## OUT OF SCOPE — SKIP and list, do NOT touch
- Layout, spacing, sizing, radius, structure changes (unless the report gives an exact 1-value nit AND
  it is trivially safe — when in doubt, skip).
- Adding/removing/wiring components; missing card chrome; missing elements; behavior changes.
- Anything tagged Deferred / Intentional in your report.
- Any file NOT in your assigned ownership list (another agent owns it).

## Rules
- **Re-verify every target against the prototype source before editing** — open the `.jsx`, confirm the
  hex/shade/element. Do not trust the report blindly; if you cannot confirm, skip and note it.
- **Static Tailwind classes ONLY.** Never interpolate arbitrary values (`text-[${x}]` silently no-ops in
  v4). Verify any token→hex in `app/renderer/src/theme.css`.
- Keep each edit minimal; match surrounding style. One concern per edit.
- **After editing, run your area's focused test file(s)** (`bun test <path>`) and confirm green. If an
  edit changes a class a test asserts, update that test to the new class and say so.

## Report back (compact — do NOT paste whole files)
- One line per edit: `file:line  <before> → <after>   (verified vs <proto file:line>)`
- `SKIPPED (structural/out-of-scope): <one-liners>`
- Focused-test result: `<path> — N pass / M fail`
