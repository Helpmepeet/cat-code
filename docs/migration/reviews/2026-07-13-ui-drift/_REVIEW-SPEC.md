# Whole-UI drift review — shared spec (2026-07-13)

Every area reviewer follows THIS spec. Your per-area prompt only adds the file mapping + scope.

## What you are doing
Compare OUR implementation against the PROTOTYPE SOURCE — **code-vs-code**, reading the JSX/TSX and
diffing values. You are a language model, not a vision model: read the source, do not rely on
screenshots. The prototype is a **design reference ONLY** — we port zero code and use Tailwind, never
inline `style={{}}`.

- Prototype: `/Users/pt/catcode_prototype/cat-app/*.jsx`
- Ours: `/Users/pt/cat-code/app/renderer/src/*.tsx`

## Rules for a fair review
1. Prototype uses inline `style={{}}`; we translate to Tailwind. Judge the **visual result** — px sizes,
   colors, font weights, gaps, radii, layout. Convert px→Tailwind and compare the numbers.
2. **Tailwind v4 dynamic-class trap:** an interpolated arbitrary class like `` text-[${hex}] `` silently
   NO-OPs (renders nothing) — that is a real bug. Static arbitrary values (`text-[#f472b6]`) are fine.
   Flag any interpolated arbitrary class you find.
3. **Verify token→hex.** Any Tailwind theme token you rely on (e.g. `--accent`, `--tone-warn`,
   `text-text-muted`, `text-text-subtle`, `--tone-danger`) must be confirmed against
   `app/renderer/src/theme.css`. A token resolving to a different hex than the prototype's literal is
   real drift.
4. **Built vs deferred FIRST.** Before reporting drift, check (a) whether the surface is actually built
   (not a stub) and (b) whether `docs/migration/PARITY-LEDGER.md` or `docs/migration/STATUS.md` marks
   parts as deferred / adapted / cut **with an owner**. Classify every gap as one of:
   - **DRIFT** — built, diverges from the prototype, no owner tracking it → goes in Findings.
   - **DEFERRED** — a real gap already tracked with an owner/backlog id → goes in the Deferred section, cite the ledger line. NOT new drift.
   - **INTENTIONAL** — a deliberate cat-code adaptation (real-data-only, security, provider filtering, etc.) → Deferred/Intentional section.
5. **Source over dated docs.** If a dated STATUS/ledger line contradicts current source, note it under
   "Doc-drift notes" — do not edit docs.
6. **Composer already covered.** The composer (Chat.jsx composer region, `ComposerActionsBar`,
   `ContextGauge`, `PermissionModeChip` face) was reviewed in
   `docs/migration/reviews/2026-07-13-composer-drift-review.md`. Do NOT re-review those. Cover only YOUR area.
7. **Read-only on source.** Do not edit any `.tsx`/`.ts`/`.jsx` source. You DO write exactly one report
   file (below).

## Output contract
**Step 1 — write your full report** to
`/Users/pt/cat-code/docs/migration/reviews/2026-07-13-ui-drift/<AREA-SLUG>.md` (slug given in your
prompt), using this exact template:

```
# <Area> drift — prototype vs impl (2026-07-13)

**Our:** <our files>
**Prototype:** <prototype files>
**Built status:** <built | partial | stub/deferred — one line, cite ledger/STATUS if relevant>

## Scoreboard — H:<n> M:<n> L:<n>

## Findings (High → Low)
[SEVERITY High|Med|Low] <element>: prototype does X (<proto file:line>) — we do Y (<our file:line>). Fix: <concrete Tailwind/prop change>.
... (one per finding; cite file:line on BOTH sides; give a concrete fix)

## Deferred / intentional (not drift)
- <item> — <DEFERRED: ledger/STATUS line | INTENTIONAL: reason>

## Doc-drift notes (optional)
- <stale STATUS/ledger line vs current source>
```

Severity: **High** = obviously wrong / broken / missing a whole element a user would notice;
**Med** = clearly off (wrong color family, wrong layout behavior, missing sub-element);
**Low** = small px/tint/timing nits. Only report genuine differences — if a value matches, don't list it.

**Step 2 — return to me a COMPACT summary only** (~10 lines max), exactly this shape:
`<AREA> | H:n M:n L:n | wrote <path>`
then 3 bullet one-liners for the top findings, then one line `Deferred: <…>`.
Do NOT paste the full report into your return message — it lives in the file.
