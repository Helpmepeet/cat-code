---
name: transcript-redesign
description: Use when the user wants to visually redesign or compare cat-code transcript row components such as messages, tool calls, seams, notices, permissions, agent events, or long output.
---

# Transcript Row Redesign

## Mission

Redesign the existing cat-code transcript rows as a **clearly labeled visual inventory** in
one standalone HTML page.

Improve row anatomy, hierarchy, spacing, typography, state communication, and disclosure
while preserving coverage, meaning, and all data the current rows carry.

Do not invent a new transcript direction, conversation architecture, grouping model, or
session-level concept unless explicitly requested. Row-level merging, splitting, relocation,
and shared visual grammars are allowed when they produce a clearer treatment.

Proceed directly from source review to building. Do not ask the user to approve a direction,
plan, thesis, or visual treatment first. If none is supplied, choose a coherent treatment
and continue. Ask only when required source files are unavailable or the user's constraints
directly contradict each other.

## Source contract

Read the complete row set:

1. `/Users/pt/catcode_prototype/cat-app/Messages.jsx` is authoritative. Inspect
   `MessageRow` and every dispatched component.
2. `/Users/pt/catcode_prototype/transcript-row-inventory.html` is the coverage checklist.
   When they disagree, follow `Messages.jsx`.

## Prior work check — and deliberately diverge from it

This is where past runs went wrong: they never looked at what they were repeating, so every
redesign reached for the same marks and the same seam shape and called it done. Don't do that.

List `redesigns/` and for each existing file, open it just far enough to read its **treatment
signature** — how it handles state cues (glyph? weight? motion? position? color?), how it
draws session/turn seams, its row anatomy and disclosure model. You are not studying them to
learn from them; you are cataloguing what is already taken so you don't take it again.

Then, **before building, decide how THIS run differs** and commit to it in one line at the top
of your new file as an HTML comment: `<!-- treatment: … · differs from prior by … -->`. The
next run will read that line, so keep it honest and specific.

Looking similar to a prior redesign is a failure, not a neutral outcome. If your instinct is
to reuse the previous run's glyph vocabulary or seam shape, that instinct is the bug — the
whole point of a new sequence number is a genuinely different visual answer to the same rows.
Spend the bulk of the effort on the current rows; spend just enough on the priors to guarantee
you are not echoing them.

## Visual inventory

The output is **not a chronological conversation**. It is a row inspection page grouped
under the inventory's section names.

For every row:

- Map every inventory row family to at least one labeled sample.
- Show a visible human-readable row name such as `Bash / shell` or `Assistant message`.
- Keep the label outside the component as neutral inspection chrome.
- Separate samples with generous spacing and a neutral divider or container boundary.
- Optionally show the dispatch/type key in muted monospace.
- Label state variants and show collapsed/expanded versions where useful.

Do not force a one-to-one mapping. One sample may represent multiple row families, and one
family may have multiple samples. A combined sample must visibly list every source row it
represents so coverage remains obvious.

Do not add essays, legends, or thesis copy; section headings, row names, state captions, and
small data labels are allowed.

## Visual scope

Treat the source rows and their data as requirements. Treat the current rendering as one
possible solution, not the default starting point.

A correct redesign:

- Reconsiders what each row should emphasize, defer, group, or expose as an action.
- Establishes a coherent visual grammar across related row families.
- Improves scanability, hierarchy, state recognition, and disclosure.
- Reuses an existing pattern when it remains the strongest solution.
- Changes existing anatomy when another arrangement communicates the row better.
- Preserves every source field, state, action, and row attribution.

An incorrect redesign:

- Copies each existing row and changes only spacing, colors, borders, or radius.
- Reuses the previous redesign's glyph vocabulary or seam shape because it was already there
  (the convergence trap — same emoji/marks, same centered hairline, run after run).
- Preserves the existing information hierarchy without evaluating it.
- Applies one generic card structure to rows with materially different purposes.
- Introduces visual novelty without improving communication.
- Removes data, weakens state visibility, or invents session-level concepts.

Before finishing, inspect the result as a design alternative, not merely as a polished
version of the inventory. Revise rows whose hierarchy and interaction model were never
meaningfully reconsidered.

Allowed: reorder fields within the same row; refine density, type, surfaces, state cues,
disclosure, diffs, logs, diagnostics, images, and long output; merge related row treatments;
or split a complex row into clearly mapped parts.

**The marks and seam shapes in `Messages.jsx` are source data carrying MEANING, not a fixed
appearance you must copy.** The engine says "this is a read / this row is done / the context
compacted" — it does not say it must be drawn `≡` / `✓` / a centered hairline. Those are the
previous designer's answers, and reusing them is the single biggest reason past runs look
alike. Treat every one as a variable this run gets to re-answer:

- **State communication is not required to be a symbol.** Running/done/failed/denied can read
  through weight, motion, shape, position, a numeric digest, a surface change — whatever is
  clearest here. If you do use marks, choosing the same set as the last redesign is a miss.
- **Seams (session start, result, interrupted, compacted, snipped, turn duration) are not
  required to be a centered line-text-line divider.** They can be gutter events, a margin
  timeline, turn brackets, band transitions, or something else — as long as they still recede
  and never invent a new session-level concept. Redoing the centered hairline yet again is the
  seam equivalent of reusing the glyph set: it is the rut this skill exists to break.

This is not a license to be arbitrary — every choice still has to communicate the row better
than the current rendering, and pass the "incorrect redesign" test below. It is a standing
requirement that you actually *choose*, per run, rather than inherit.

Do not create a realistic transcript, session layout, turn dossier, evidence lane, or
alternate conversation model. Do not remove fields or lose source-row attribution.

Design system:

- `#09090b` background, zinc text, `#f472b6` accent.
- DM Sans for UI and DM Mono for code, paths, and metadata.
- No colored left border/status strip, generic icon-title-accent card, heavy shadow, or
  emoji status icon.

## Build

Create `redesigns/NN-<short-row-treatment>.html` using the next free sequence number. Never
overwrite an existing redesign or edit `cat-app/*`.

Use self-contained static HTML with inline CSS and vanilla JavaScript. Use no React, Babel,
modules, build step, or external JavaScript. Google Fonts may load DM Sans and DM Mono.

Required demonstrations:

- Rich assistant prose with heading, list, bold, inline code, and highlighted code block.
- Running, done, failed, denied, cancelled, truncated, and needs-permission states.
- Permission actions with visible `Enter`, `N`, and `Esc` hints.
- Practical, working expand/collapse for tools and long output.
- Grouped tools, multi-file diffs, and attachments attributable to their row family.

## Verify

1. Run `node --check` on the inline script.
2. Match every inventory builder key to a labeled sample or clearly labeled combined sample.
3. Confirm no sample is unlabeled or visually joined to the next sample.
4. Exercise collapse/expand and permission keyboard interactions.
5. Search for forbidden `border-left` status styling, React, Babel, modules, and external JS.
6. Divergence check: confirm the `<!-- treatment: … -->` line is present, and that this run's
   state cues and seam treatment are not a rerun of the nearest prior redesign's. If the glyph
   set or the seam shape matches a prior file, that is a fail — change it before finishing.
