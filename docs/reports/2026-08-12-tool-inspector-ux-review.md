# Tool inspector UX review

**Date:** 2026-08-12  
**Scope:** Desktop transcript tool-card `Inspector` affordance and its `ToolInspector` drawer  
**Status:** Design finding; no implementation changes

## Conclusion

The persistent **Inspector** footer button should be removed. It is a redundant,
visually overweight entry point to a generic side drawer that repeats information
the tool card already presents. The full-output capability is still useful, but
it should be available only when an output has been truncated and needs an
expanded view.

This finding concerns the tool-card inspector. It does not apply to the separate
session-level **Inspect metadata…** action, whose drawer presents session state
that is not otherwise co-located in the interface.

## Findings

### 1. The persistent Inspector entry point is redundant

Every expanded non-Agent tool card renders an `Inspector` footer action. Grouped
read and search members render the same action as well
(`app/renderer/src/TranscriptView.tsx:1224-1230`,
`app/renderer/src/TranscriptView.tsx:1518-1525`,
`app/renderer/src/TranscriptView.tsx:1650-1662`).

The same card body already has the purpose-built tool-specific view. In
addition, a truncated result shows an **Open full output** action in its reveal
band. Both entry points send the same projected tool row to the same inspector
drawer (`app/renderer/src/TranscriptView.tsx:1956-1962`,
`app/renderer/src/TranscriptView.tsx:2694-2728`).

The footer action therefore does not represent a separate task. It is a second,
always-visible route to an existing destination.

### 2. The footer button has too much visual weight

The control sits in a dedicated, bordered footer band and is styled as a boxed,
tinted action with padding and an outbound arrow
(`app/renderer/src/TranscriptView.tsx:1650-1662`). It reads as a primary or
important action even though its purpose is secondary and usually duplicative.

The result is unnecessary visual noise on every expanded tool card, especially
in read/search runs where many card members can expose the same control.

### 3. The destination is a generic duplicate of the card

`ToolInspector` uses one generic template for all tool families: tool name,
summary, status, raw structured input, optional diff, and output
(`app/renderer/src/ToolInspector.tsx:75-121`). Those fields substantially
overlap with the tool card the user has already expanded.

This duplication is particularly weak for file reads. The transcript card uses
the read-specific path, line-number, and source presentation, while the drawer
re-presents the same result in a generic output viewer. The drawer's search,
copy, and soft-wrap controls are useful capabilities, but they do not justify a
persistent universal Inspector button.

## Recommended direction

1. Remove the `Inspector` footer button and its enclosing footer band from
   standalone and grouped tool cards.
2. Keep the expanded tool card as the normal inspection surface for each tool.
3. Keep a single quiet **Open full output** action only when inline output is
   truncated. It may open an output-focused expanded surface containing search,
   copy, and soft-wrap controls, but should not first repeat generic metadata
   already visible on the card.
4. Retain the separate session-level metadata inspector. It contains distinct
   session facts such as permissions, workspace trust, effective settings, run
   controls, diagnostics, and message metadata
   (`app/renderer/src/MetadataInspector.tsx:151-294`,
   `app/renderer/src/MetadataInspector.tsx:311-526`).

## Scope note

No implementation change was made. This report records a product and interaction
design finding only.

## Verification

```text
VERIFICATION
- git diff --check → clean
- bun run --cwd /Users/pt/cat-code maps:lint → passed: 18 maps, 8 pre-existing
  recommendation warnings
Stale-reference sweep: Not applicable; this report introduces no rename,
removal, or interface change.
Not run: Desktop tests, typechecks, renderer build, and GUI verification. No
desktop code changed.
```
