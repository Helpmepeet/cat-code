# TEXT-LEGIBILITY — two prototype values the desktop app overrides

**Status: DECIDED 2026-08-07 (operator, settled by eye on a live tuner).** Landed in
`f9f9f0f`; the tuner that produced the values was removed in `7d512c2`.

This exists for one reason: **two shipped values now differ from the prototype on purpose.**
Without this record the next session reads the mismatch as a porting error and "restores" it.
Both are tagged deviations under PROGRAM-PLAN §6 (parity is the default; a deviation is
flagged, never silent), not cuts and not drift.

| # | Prototype | Ships as | Why |
|---|---|---|---|
| **L1** | `--color-text-subtle/faint/ghost` = `#71717a` / `#52525b` / `#3f3f46` | `#98989f` / `#838389` / `#75757b` | All three failed WCAG AA against the app's own background; the first is the most-used text colour in the renderer. |
| **L2** | transcript + composer column capped at 740px (`Chat.jsx:402` `MSG_MAX`) | 1000px | `px-8` sits *inside* the cap, so the real content column was 676px. On a maximized window that stranded ~60% of the screen while tool rows and diffs truncated against the cap. |

Shared root cause, and the reason neither is a bug report against the porting work: **the
prototype is a browser mockup.** Its absolute values were chosen for a page viewed in a tab, and
they were ported faithfully. They do not survive a window the operator maximizes and reads for
hours. Fidelity to the prototype was never in question; fitness of the prototype's constants was.

---

## L1 — the resting greys

Measured against `--color-app-bg` `#09090b` before the change:

| token | hex | contrast | AA 4.5:1 | uses |
|---|---|---|---|---|
| `text-primary` | `#f4f4f5` | 18.10 | pass | 150 |
| `text-muted` | `#a1a1aa` | 7.76 | pass | 184 |
| `text-subtle` | `#71717a` | **4.12** | **fail** | **326** |
| `text-faint` | `#52525b` | **2.57** | **fail** | 57 |
| `text-ghost` | `#3f3f46` | **1.91** | **fail** | 27 |

`text-subtle` is the single most-used text colour in the renderer, outnumbering primary and
muted combined, and it sat below the floor. `faint` and `ghost` were below even the 3:1
non-text threshold. 410 usages in total.

Every value shipped is the prototype's moved **30% toward `--color-text-primary`** — one
uniform transform, chosen by the operator on a live tuner rather than picked per-token. Result:
6.94 / 5.28 / 4.35.

**Meaning did not change.** `faint`/`ghost` remain reserved for resting, ghost, and disabled
text. This lifted the ramp; it did not repurpose the steps.

Six hardcoded hex copies of these greys were converted to their tokens in the same change
(`ComposerActionsBar`, `PermissionModeChip`, `App`, `ComposerInput`). They had bypassed the
token layer, so leaving them would have stranded the old value in six places while the token
moved.

### Known consequence, deliberately not fixed

Lifting only the bottom three **compressed the top of the ramp**: `muted` 7.76 and `subtle`
6.94 are now 0.82 apart, where they were 3.64. Two tokens used 510 times combined are close to
perceptually redundant.

Left alone on purpose. Raising `muted` is a visual change the operator has not seen, and the
whole method here was to settle values by eye rather than by arithmetic. Revisit **only** if the
two greys start reading as one surface; the fix would be nudging `muted` up to restore
separation, not re-darkening `subtle`.

## L2 — the transcript column

The prototype centres the transcript at `maxWidth: MSG_MAX` with `padding: '24px 32px 0'`
(`Chat.jsx:1282`). That was ported exactly — 740px cap, `px-8`, `pt-6`. The trap is that the
padding is inside the cap, so the readable column was never 740px; it was 676px.

At 676px the transcript was **already at the upper end of a comfortable prose measure**
(~85–95 characters), so the cap was not too tight for prose. It was too tight for everything
else. The transcript is mostly not prose: tool rows, file paths, diffs, and code blocks are
tabular content, and they were being truncated (17 `truncate` calls in `TranscriptView` alone)
while several hundred pixels sat empty on both sides. One width was serving two kinds of content
with opposite needs.

**1000px was chosen by eye, with prose left uncapped** — the operator tried an independent
narrower cap on message text and preferred not to use it. Prose therefore now runs ~120
characters. That is a known trade, not an oversight: it was the alternative that was tested and
rejected. If long paragraphs later prove hard to track line-to-line, the fix is a prose-only
`max-width` inside the column, **not** re-narrowing the column and re-truncating the tool rows.

### Invariant

`TranscriptView` (list + `PreviewSkeleton`) and the `App` composer dock **must carry the same
value**. That shared number is what aligns the transcript's edges with the input's; changing one
alone visibly desynchronises them. Four call sites, all `max-w-[1000px]`.

## Related weight change (not a parity deviation)

Message prose and the composer moved `font-light` → `font-medium` in the same commit. Those
three sites were the only weight-300 text in the app while everything around them was 500/600/700
— the content was set lighter than its own labels, on the two surfaces that get read most. The
prototype's own body weight is light (`Chat.jsx:1282` `fontWeight: 200`), so this is a deviation
too, but a small one recorded here rather than in the table because it changes no token and no
layout.

`-webkit-font-smoothing: antialiased` (`theme.css`) was evaluated and **kept**. It thins strokes
on macOS, which is the wrong direction on a dark background, but the operator compensated with
weight instead and preferred the result. Noted so the next person does not re-litigate it as an
oversight.

## Verification at the time of landing

`bun run --cwd app typecheck` clean · `bun test app/` 2785 pass / 0 fail ·
`bun run --cwd app renderer:build` green · `bun run --cwd app test:hardening` 19/19.

Two tests asserted the old values and were updated with the change
(`ComposerActionsBar.test.tsx`, `App.test.tsx`).
