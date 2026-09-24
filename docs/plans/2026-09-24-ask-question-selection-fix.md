# Question card: selection fix and visual pass

Date: 2026-09-24
Status: plan only; no application changes made
Owner file: `app/renderer/src/AskQuestionFlow.tsx`
Mockup: [before and after](../design-html/2026-09-24-ask-user-question-before-after.html)

## Goal and scope

In a single-select question, the row that looks chosen must be the row that
Enter sends. Hovering must never change the answer or close the "Other" field.
After that, apply the approved visual changes from the mockup without making
the card taller.

Out of scope: the answer payload (`buildAskAnswerPayload`), the wire protocol,
the sidecar, and `PermissionPrompt`. Submit stays disabled until something is
picked, so a mouse click cannot send whichever row the pointer last passed over.

## Evidence

Found by reading the source. None of it has been reproduced by a test run yet;
the first implementation step does that.

The flow keeps two separate pieces of state: `cursor` (the highlighted row) and
`draft.optionIndices` (the pick). Three things move `cursor` without moving the
pick:

- `onMouseEnter` on every option row and on the Other row
- ArrowUp/ArrowDown, `j`/`k`, Ctrl-n/Ctrl-p
- Tab focus (`onFocus`)

`advance()` sends the pick whenever one exists and falls back to `cursor` only
when nothing is picked. The `rowTone` doc comment says the pink cursor tint
shows "which row one Enter would submit". That stops being true after the
first pick.

### Bug 1: Enter sends a row that is not highlighted

- Keyboard: press `1`, then ArrowDown twice, then Enter. Option 1 is sent while
  row 3 is highlighted. In single-select, arrows never change the pick, and
  Space toggles only in multi-select.
- Mouse: click row 1, rest the pointer on row 3, then press Enter. Option 1 is
  sent while rows 1 and 3 are both drawn in pink.
- Tab: pick row 1, then Tab to row 2. Enter on the focused row sends option 1.

No existing test covers pick, move, then Enter. `Enter submits an option
picked with the mouse` covers click then Enter only, and `one Enter selects
the highlighted option and submits` covers the case with nothing picked.

### Bug 2: hovering an option while typing Other can lose the text

The option row's `onMouseEnter` calls `setOtherActive(false)`. That unmounts
the focused input, so focus falls to `<body>`. `permissionKeysAreLive(body)`
returns true, so the next keys become card shortcuts. In single-select, typing
a digit then runs `toggleOption`, which picks that option and sets `other` to
`''`. Sequence: press `o`, type text, nudge the mouse over an option, type `2`.
The text is gone and option 2 is picked.

## Target behavior

| Situation | Today | After |
|---|---|---|
| Single-select, arrow keys after a pick | Highlight moves, pick stays, Enter sends the old pick | The pick moves with the highlight, and Enter sends the highlighted row |
| Single-select, nothing picked yet | Highlight on row 1, Enter sends row 1 | Unchanged. The first arrow key also picks the row it lands on |
| Pointer over a row | Moves the highlight, pink tint, closes the Other field | Grey hover wash only. Highlight, pick, and the Other field are untouched |
| Preview well | Follows the highlight, which the pointer moves | Follows the hovered row, and falls back to the highlighted row |
| Click a row | Picks it and focuses it | Unchanged |
| Tab, single-select | Every row is a tab stop, and focus moves the highlight only | One tab stop for the options (the picked row, else the highlighted row). Arrow keys move within the group |
| Enter on the Other row with the field closed and empty | Nothing | Opens the field |
| Multi-select | Separate highlight, Space toggles, Enter sends the picks | Unchanged, except that hover no longer moves the highlight |

## Decisions (recommendation first)

1. **Hover no longer moves the highlight.** One consequence: with nothing
   picked, pointing at row 3 and pressing Enter sends the keyboard-highlighted
   row (row 1 on arrival), not row 3. Hover-then-Enter without a click is rare.
   Allowing it is what makes the mouse and the keyboard disagree.
2. **Arrowing onto Other keeps the current pick until you type.** Typing already
   replaces a single-select pick (`setOtherText`), and Enter on that row opens
   the field instead of sending. The alternative, clearing the pick on arrival,
   is closer to strict radio behavior. However, it turns Submit grey whenever
   the user just passes over the row.

## Step 1: failing tests first

Add these to `AskQuestionFlow.dom.test.tsx`, using the existing `mountFlow`,
`press`, `optionRows`, `markerText`, and `checkedState` helpers. For hover,
dispatch `mouseover` with `bubbles: true`, as `UsagePage.dom.test.tsx` does.
Run them against today's code and record that each one fails for the stated
reason before changing anything.

1. **Arrows move a single-select pick.** Press `1`, ArrowDown twice, then Enter.
   Expect `[[{ optionIndices: [2] }]]`, with row 3 checked and row 1 not.
   Today this sends `[0]`.
2. **Hover does not move the highlight.** Mouse over row 3. Expect
   `data-ask-active` to stay on row 1, and Enter to send `[0]`. Today the
   highlight moves and Enter sends `[2]`.
3. **Hover keeps the Other field open.** Press `o`, type into the input, then
   mouse over row 1. Expect the input to stay mounted, focused, and holding its
   value. Today it unmounts.
4. **Single-select has one tab stop.** Only the picked row, or the highlighted
   row when nothing is picked, has `tabIndex` 0. Today every row is tabbable.
5. **Enter on the Other row opens the field.** Move to the Other row with
   ArrowDown, press Enter, and expect the input with no answer sent. Today
   nothing happens.
6. **Hover still shows a preview.** Mouse over an option that has a preview and
   expect its text in the card. Mouse out and expect the highlighted row's
   preview instead.

These existing tests must keep passing unchanged: `a chosen option stays chosen
when the cursor moves off it` (multi), `Tab-focusing a row moves the cursor onto
it` (multi), and `the full sequence preserves multi-select and reaches the third
preview option`. In that last test the arrows now pick Ternary, and Enter
advances the same way.

## Step 2: separate hover from the highlight

In `AskQuestionFlow.tsx`:

- Remove `onMouseEnter` from the option rows and from the Other row.
- Add a `hoverIndex` state, set by `onMouseEnter` and cleared by `onMouseLeave`,
  used only for the preview: `previewIndex = hoverIndex ?? cursor`. It never
  touches `cursor`, `otherActive`, or the draft.
- Draw hover with a CSS `hover:` wash on unchosen rows, so a picked row keeps
  its tint under the pointer.
- Keep `onFocus` moving the highlight. Focus is keyboard intent.

This fixes bug 2 and the mouse half of bug 1.

## Step 3: make the single-select pick follow the highlight

- Route the arrow, `j`/`k`, and Ctrl-n/Ctrl-p branches through one
  `moveCursor(next)`. In single-select, when `next` is an option row, it also
  sets the draft to that one option and clears `other`, which is what a click
  does today. Multi-select only moves the highlight.
- Roving tab stop for single-select. The option list gets `role="radiogroup"`
  with `aria-labelledby` pointing at the question heading. Each row gets
  `tabIndex={i === tabStop ? 0 : -1}`, where `tabStop` is the picked index, else
  `cursor`. Multi-select rows stay individually tabbable, and the Other row
  keeps its own tab stop.
- In `advance()`, when the highlight is on the Other row, the field is closed,
  and it has no text, open the field and return.
- Rewrite the `rowTone` and `markerClass` doc comments so they state the new
  rule: in single-select, the highlighted option is the answer Enter sends.

## Step 4: highlight styling (mockup change 3)

This step belongs with the fix, because a pink highlight next to a pink pick
is what made the bug look like two answers.

- `rowTone`: the highlight becomes a neutral `bg-text-primary/[0.05]` with no
  border. Chosen keeps the accent. Drop the per-row border ring.
- `markerClass`: a highlighted, unchosen marker uses `border-text-primary/50`
  instead of the accent.
- Update the static assertion in `AskQuestionFlow.test.tsx` (`a chosen row
  outranks the cursor row`), which pins `border-accent/25 bg-accent/[0.05]`.
  Keep its intent: chosen must outrank the highlight.

## Step 5: visual pass from the mockup (after yes/no per item)

Apply only the mockup changes that are approved. The values come from the
compact version. It is shorter than today in every mocked state: 21 to 23px
at normal widths, and 2 to 36px at phone width, where the preview state gains
the least.

| Part | Today | Mockup |
|---|---|---|
| Header | "QUESTION" kicker row, then a header pill row | One row: glyph, the question's header as the kicker, step dots and pending count on the right |
| Card border | `border-accent/[0.22]` | `border-white/[0.08]` (the light remap makes this a zinc hairline) |
| Card padding | `px-4 py-2.5` | 12px top, 10px bottom, 16px sides |
| Question | 14px, `leading-snug` | 15px, 20px line height, 6px above |
| Option list | 6px above, rows `px-2.5 py-1` plus a 1px border | 8px above, rows 5px 8px with no border, `-mx-2` so markers line up with the question |
| Label / description | 12px / 11px | 13px on 17px / 12px on 16px |
| Row digit | Bordered keycap | Plain digit, `text-text-ghost`, `text-text-muted` on the highlighted row |
| Other row | 12px muted, typing shows no field | 13px. Typing shows an inset field (1px `white/[0.1]` border, `black/30` wash, 6px radius) |
| Preview well | Blue border and heading | The permission card's well: `border-white/[0.07]`, `text-text-faint` heading |
| Footer | Submit left, Cancel far right, `mt-2 pt-2` | Both right-aligned, Cancel then Submit, same `mt-2 pt-2` |

## Verification

- Before any fix, run the Step 1 tests and confirm each one fails for its stated
  reason. After the fix, they pass.
- `bun test app/renderer/src/AskQuestionFlow.dom.test.tsx app/renderer/src/AskQuestionFlow.test.tsx app/renderer/src/askQuestionState.test.ts`
- `bun test app/` (this includes the `userVisibleText` check; no new strings are
  planned) and `bun run --cwd app typecheck`.
- No new modules or exports, so `renderer:build` is not required.
- Operator GUI check in Cat Code Dev, which needs authorization to launch:
  - Single-select: press 1, then ArrowDown, then Enter. The transcript shows
    option 2.
  - Click row 1, point at row 3, press Enter. Option 1 is sent, and row 3 shows
    only a grey wash.
  - Press `o`, type, nudge the mouse across the options. The field and its text
    stay.
  - Multi-select: Space and Enter behave as before.
  - Check both appearances.
- The shell used to write this plan had no `bun` on `PATH`. The implementing
  session needs it.
