# Desktop transcript virtualization design

**Date:** 2026-08-14
**Status:** Design decision, not implemented
**Scope:** `app/renderer/` transcript rendering only

## Decision

Proceed with transcript virtualization, but do not implement a conventional
row window.

The correct design is a **hierarchical render-leaf virtualizer**:

1. Bound the DOM inside every item that can itself grow without limit,
   especially assistant and reasoning Markdown, syntax-highlighted code, tool
   output, the full-output inspector, and expanded nested agent transcripts.
2. Virtualize the outer variable-height transcript items so transcript history
   and up to three visible workspace panels also have a fixed DOM cost.
3. Keep the current native pane scroller. Add one pane-local measurement and
   scroll-anchor coordinator rather than introducing a second transcript scroll
   surface.

This should land in stages. The first stage is the narrower, highest-value
intervention: virtualize Markdown blocks and other unbounded bodies. It directly
addresses the measured 4.7 GB single-turn failure and can ship before outer-row
virtualization. A measured stop gate then decides whether the outer layer earns
its complexity. If the narrow stage also keeps a three-panel, many-short-row
stress run within the targets below, defer the outer layer. The current source
makes that outcome possible but unlikely: every top-level item is still mounted
at `app/renderer/src/TranscriptView.tsx:346-360`.

A naive row virtualizer is not an acceptable partial implementation. One visible
`assistant-text` row sends its complete accumulated string through
`react-markdown` and syntax highlighting at
`app/renderer/src/TranscriptView.tsx:668-724`. The measured 4.7 GB case came from
one long streaming turn. Mounting only that row can therefore still mount an
unbounded DOM.

## Why this work is worth doing

The established reproduction is severe, fast, and attributable:

- At 3.9 GB, 3,653 MB was Chromium PartitionAlloc and only 182 MB was V8.
- The two-session workload grew from 144 MB and 852 regions to 3,974 MB and
  13,018 regions in about fifteen minutes.
- A fresh renderer reached a 4.7 GB peak during one long streaming turn.
- Completely unmounting transcripts and evicting JavaScript state did not return
  the committed PartitionAlloc pages.

The evidence is recorded in
`docs/reports/2026-08-14-renderer-memory-attribution.md:14-82`. A JavaScript-state
optimization can save only a small fraction of this memory. Preventing DOM,
layout-object, text-fragment, and highlight-span creation is the relevant lever.

This is not speculative optimization. The current behavior loses the renderer
that must paint the recovery UI and handle its buttons. A bounded rendering cost
is required for the recovery surface to remain usable.

## Current constraints verified in source

### One native pane scroller owns scroll behavior

`SessionPane` owns the transcript scroll element and its user-facing behavior:

- The scroll element is `transcriptScrollRef` at
  `app/renderer/src/App.tsx:4152` and `app/renderer/src/App.tsx:4584-4610`.
- A session bind jumps to the latest content at
  `app/renderer/src/App.tsx:4262-4269`.
- Bottom following, the 120 px bottom threshold, and the jump control are at
  `app/renderer/src/App.tsx:4341-4357`.

The virtualizer must integrate with this element. A nested transcript scroller
would change wheel, selection, jump-to-bottom, and session-switch behavior and
would diverge from the prototype.

### Display items are variable-height read-time derivations

`TranscriptRowsView` derives agent groups, reasoning runs, and tool runs, then
maps the complete result at `app/renderer/src/TranscriptView.tsx:305-360`.
Grouping is not stored protocol state:

- nested rows and their cross-slice identity cache:
  `app/renderer/src/transcriptProjector.ts:687-767`
- reasoning grouping: `app/renderer/src/reasoningLayout.ts:131-180`
- tool-run grouping: `app/renderer/src/toolRunLayout.ts:41-57,81-150`

The render plan must sit after these derivations. It must not truncate projector
state or move rendering concerns into the wire model.

### Stable identity already exists

Producer-derived row IDs and the cross-slice nested-row cache preserve unchanged
row identity during streaming. Commit `a70957a8` added the explicit test that an
unchanged nested row remains referentially identical across a changed session
slice. Grouped items also derive stable IDs from their first/source members.

The virtualizer must use these IDs. It must never key by array index, measured
position, or viewport slot, and it must never recycle one keyed DOM node as
unrelated transcript content.

### The terminal virtualizer is prior art, not a desktop implementation

The terminal runtime already has a row virtualizer:

- `src/components/VirtualMessageList.tsx:162-169,289-337` mounts a stable-keyed
  range with top and bottom spacers;
- `src/hooks/useVirtualScroll.ts:120-141` describes the same grow-only
  allocation problem in Ink and bounds mounted fibers/Yoga nodes;
- `src/hooks/useVirtualScroll.ts:142-218` keys measurements by item and treats
  width changes as height-cache invalidation;
- `src/hooks/useVirtualScroll.ts:314-455` uses estimated offsets, binary range
  lookup, overscan, and measured-height coverage;
- `src/components/VirtualMessageList.tsx:696-817` searches retained source data
  and mounts a target before precise navigation.

Use those behaviors as local test cases and design precedent. Do not import or
copy the hook wholesale. It is coupled to Ink `ScrollBoxHandle`, Yoga
`DOMElement` measurement, terminal-row units, pending scroll deltas, and
screen-cell search highlighting. It also explicitly has no general scroll-anchor
compensation (`src/hooks/useVirtualScroll.ts:132-135`) and cannot bound one giant
browser Markdown row.

The desktop implementation should share concepts, not runtime code. Extract a
platform-neutral prefix/range data structure only if both call sites can consume
it without importing Ink or desktop/browser types across package boundaries.
Otherwise keep the desktop coordinator local and pin equivalent behavior with
tests that cite the terminal prior art. This is not duplication of engine
session machinery; it is a different renderer with different measurement and
selection semantics.

### Some interaction state already survives remounts

Tool expansion and progressive inline-output reveal are stored above card
components by engine-minted `toolUseId` at
`app/renderer/src/toolCardExpansion.ts:15-24,30-65`. Remounting a tool card does
not need to lose those choices.

Other state is still component-local:

- reasoning-run collapse: `app/renderer/src/TranscriptView.tsx:3180-3202`
- reasoning-prose hide/show: `app/renderer/src/TranscriptView.tsx:3292-3314`
- short-lived copy confirmation in several row components

Meaningful user choices must move into a stable-ID interaction store before the
corresponding component is virtualized. Ephemeral hover and copy-confirmation
state may reset after an offscreen unmount; that does not alter transcript
content or a durable user choice.

### Existing tool-output windowing is necessary but not a hard DOM cap

Inline tool output initially renders 30 head lines and 6 tail lines
(`app/renderer/src/inlineOutputWindow.ts:21-32`), and reveal state survives a
remount (`app/renderer/src/TranscriptView.tsx:2306-2325`). However, reveal is
monotonic and eventually renders the complete output. The 340 px `max-height`
scroller at `app/renderer/src/TranscriptView.tsx:2297-2304` limits visible
geometry, not DOM allocation.

The full-output inspector also maps every line at
`app/renderer/src/ToolInspector.tsx:290-331`. Both paths need line-level
virtualization while keeping their current full-copy behavior.

### Markdown and highlighting are the largest unbounded leaf multipliers

Assistant prose parses the complete source with GFM and `rehype-highlight` at
`app/renderer/src/TranscriptView.tsx:641-724`. Highlighting emits one React span
tree for the tokenized code. Reasoning bodies have the same unbounded shape at
`app/renderer/src/TranscriptView.tsx:3108-3125` and
`app/renderer/src/TranscriptView.tsx:3292-3305`.

The prototype did contain a 60-line assistant collapse, but the operator removed
the real app's corresponding behavior because it fired too often for ordinary
code-heavy answers. That decision is recorded in
`docs/migration/PARITY-LEDGER.md:382`. This design must not reintroduce the
60-line collapse under a performance name. Ordinary content remains complete
and visually continuous; only its offscreen DOM is absent.

### Three visible panes multiply the cost

The workspace allows three panels at
`app/renderer/src/workspaceLayout.ts:3-5`, and `WorkspaceLayout` mounts every
panel's content at `app/renderer/src/WorkspacePanels.tsx:140-218`. Each pane
therefore needs its own virtualizer state, height index, width revision, scroll
anchor, bottom-lock state, focus pin, and selection pin. Limits and acceptance
numbers are per pane and for the three-pane total.

## Required invariant

> Source content may grow without bound, but the DOM created for one pane must be
> bounded by the viewport, fixed overscan, explicitly pinned focus/selection,
> and fixed per-leaf limits.

“Only N top-level rows” is not the invariant. Every mounted leaf must also be
bounded. A top-level row may contain an assistant response, a reasoning run, a
tool run, a revealed output, or a nested agent transcript that is much larger
than the viewport.

Use two budgets:

1. **Pane budget:** the number of mounted outer and Markdown render leaves.
2. **Leaf budget:** the maximum DOM children one leaf may create, including
   highlight spans, output lines, list items, table rows, and nested transcript
   children.

Initial tuning values should be conservative rather than API promises:

- at most 80 outer leaves per pane, including overscan;
- at most 120 Markdown leaves per pane;
- at most 200 rendered line/item/token children in one leaf;
- at most 200 additional contiguous leaves pinned for native selection;
- the focused leaf is always pinned separately.

The implementation may tune these downward after measurement. It must not make
them grow with transcript length.

## Architecture

### 1. Preserve authoritative data and add a renderer-only render plan

The complete `TranscriptState`, nested rows, grouping derivations, raw Markdown,
and full tool results remain in JavaScript state. Virtualization changes only
which derived leaves become DOM.

Add a pure render-plan layer after `groupAgentDelegates`, `groupReasoningRuns`,
and `groupToolRuns`. A plan entry has:

- stable `leafId` derived from producer identity and a semantic child identity;
- parent display-item ID and ancestor/group metadata;
- leaf kind;
- source revision or source-range identity;
- estimated height inputs;
- rendering payload for that bounded leaf;
- accessibility position metadata;
- the source row IDs it contains, for anchoring across regrouping.

The plan can represent composites without mounting all descendants:

- assistant/reasoning prose becomes Markdown-block leaves;
- a reasoning run becomes a small header plus step/body leaves;
- a tool run becomes its header plus bounded member/body leaves;
- an expanded agent card becomes its header plus recursively planned nested
  transcript leaves;
- inline output and the inspector become line/chunk leaves;
- ordinary small rows remain one leaf.

Grouping chrome must remain visually continuous. A composite wrapper may stay
mounted while its child leaves are windowed; that wrapper must contain only
small fixed chrome and top/bottom spacers. A giant composite cannot render all
of its children merely because its wrapper intersects the viewport.

Likely implementation modules are:

- `transcriptRenderPlan.ts`: pure plan types and derivation;
- `markdownRenderPlan.ts`: Markdown source to positioned bounded leaves;
- `transcriptVirtualizer.ts`: height index, range calculation, pinning, and
  anchor math;
- `TranscriptVirtualList.tsx`: component-only rendering boundary;
- changes to `TranscriptView.tsx`, `ToolInspector.tsx`, and `App.tsx`.

The exact file split may change, but production `.tsx` modules must continue to
export React components only at runtime. Helpers, hooks, constants, and stores
belong in adjacent `.ts` files to preserve the Fast Refresh boundary.

### 2. Build Markdown leaves before creating React DOM

Do not call `react-markdown` once for a complete giant response and hide its
children afterward. By then parsing and React-element construction have already
walked the complete tree, and a single code/list/table node may still be
unbounded.

Parse Markdown into a positioned syntax tree first, then convert only mounted
leaves to React. Use the same GFM grammar and preserve raw HTML being disabled.
The recommended implementation is to make the parser packages used by the
Markdown stack explicit direct dependencies rather than import undocumented
transitive packages. Adding `unified`/`remark-parse` or equivalent direct
packages requires the repository's normal dependency approval before
implementation.

The planner should:

1. Parse the complete source to positioned top-level blocks. Keeping an abstract
   syntax tree in V8 is acceptable; the measured V8 compartment was 182 MB. The
   goal is to prevent Blink DOM/layout construction.
2. Coalesce adjacent small blocks only up to a fixed node/character budget.
3. Cache unchanged completed blocks by stable row ID, source range, type, and
   content revision.
4. Treat the currently changing streaming tail as mutable. At most one render
   plan revision should commit per animation frame.
5. Avoid syntax-highlighting an unclosed streaming fence on every text delta.
   Render its visible tail plainly while open, then highlight bounded visible
   lines when the fence closes.
6. Reparse the settled complete response once at stream completion. Markdown
   reference definitions and a few block constructs can change earlier
   interpretation, so an append-only “settled prefix” must be an optimization,
   not a correctness assumption.

Special handling is required for one oversized syntax node:

- **fenced code:** tokenize into retained JavaScript data, but mount only visible
  line/token leaves; full-source copy remains available;
- **lists:** split at item boundaries, preserve ordered-list numbering, nesting,
  and visual spacing;
- **tables:** keep one semantic header and virtualize body-row groups with valid
  spacer rows;
- **blockquote:** split at child block boundaries while preserving quote chrome;
- **one pathological paragraph or inline token:** use a dedicated bounded text
  viewer once it exceeds the atomic-leaf ceiling. This is a rare visible
  adaptation, not the removed ordinary 60-line collapse. It must say that the
  body is windowed and retain a full-source copy action.

The last case is deliberately explicit. Unlimited native wrapping of one giant
text node creates unbounded Blink line fragments even though the DOM has few
elements. A hard leaf ceiling and perfect ordinary paragraph flow cannot both
be guaranteed for arbitrarily large atomic input.

### 3. Use a variable-height prefix-sum index per pane

Each pane keeps an ordered height index keyed by stable leaf ID. A Fenwick tree
or equivalent prefix-sum structure provides:

- total virtual height;
- offset for a leaf;
- leaf lookup for a scroll offset;
- logarithmic height updates after measurement;
- visible range plus fixed pixel overscan.

Each height record contains:

- estimated height;
- last measured height;
- content/layout revision;
- pane-width revision;
- leaf kind for estimator selection.

Measure mounted wrappers with `ResizeObserver`. Batch observer records into one
animation-frame update so one stream frame or panel resize cannot create a
measure/set-state loop. The first paint uses estimates; every later correction
uses the anchor algorithm below.

A width change invalidates wrapping-dependent measurements. Workspace divider
dragging and window resize therefore increment a pane-width revision. Cache by a
coarse width bucket only if measurement proves it stable; correctness must not
rely on two different widths wrapping identically.

### 4. Make anchor compensation the single owner of scroll correction

Before applying a plan mutation or a measurement batch, capture:

- whether the pane is bottom-locked;
- the first visible stable leaf;
- a source-row anchor ID contained by that leaf;
- its pixel offset from the viewport top;
- old prefix offsets and total height.

After updating the plan and height index:

```text
scrollTop += newOffset(anchor) - oldOffset(anchor)
```

Then apply these policies:

- If bottom-locked, bottom anchoring wins. After the measurement batch, set the
  final scroll position from the new total height so the bottom gap is zero.
- If not bottom-locked, compensate only for changes before the anchor.
- Growth below the anchor must not move the viewport.
- If grouping changes the display-item key, resolve the anchor through the
  contained source-row ID. Group items already expose their members.
- If the exact source row disappeared, fall forward to the next surviving row,
  then backward only if there is no successor.
- Width changes, image load, card expansion, reasoning toggles, tool-result
  arrival, grouping, restore/prepend, and streamed text use this one path.
- Disable browser scroll anchoring on the virtualized region if explicit
  compensation is active, otherwise Chromium may apply a second adjustment.

An unmounted item above the viewport may change while its cached height remains
stale. Do not eagerly mount it to measure. Its spacer remains stable while the
user reads. When it later approaches the viewport and is remeasured, compensate
against the current visible anchor before committing the correction.

`SessionPane` should retain product policy: the 120 px threshold, instant
session-bind jump, smooth explicit jump button, and the visible `atBottom`
state. The virtualizer should own total-size/measurement compensation. The
current row-count effect at `app/renderer/src/App.tsx:4270-4277,4341-4345` is
not sufficient once total height changes asynchronously.

### 5. Preserve interaction state independently of component lifetime

Generalize the current tool-card expansion store into a transcript interaction
store keyed by stable semantic IDs. It should retain only user-touched entries,
not one record per transcript leaf.

Retain:

- tool card expansion;
- inline-output reveal extent;
- reasoning-run collapse;
- reasoning-step hide/show;
- any explicit oversized-body window/reveal state.

The open inspector already stores only the inspected tool ID above the rows and
re-derives the current row at `app/renderer/src/TranscriptView.tsx:253-276`.
That is compatible with virtualization.

Pin the leaf containing `document.activeElement`. It must not unmount while a
button, link, or control inside it has focus. Release the pin on blur or when the
source row genuinely disappears. Do not keep every previously focused leaf.

### 6. Preserve native selection within a bounded corridor

Unlimited native cross-transcript selection and a strict DOM cap are mutually
incompatible. Chromium's `Selection` points at live DOM nodes; unmounting an
endpoint or a node inside the range truncates or destroys the range.

Preserve normal multi-row selection as follows:

1. Keep mounted leaves in source DOM order. Never use visual-only reordering.
2. On `selectstart`/`selectionchange`, identify the anchor and focus leaf IDs.
3. Pin the contiguous corridor between them, plus one viewport of overscan in
   the drag direction so native autoscroll reaches mounted text.
4. Grow the corridor as pointer selection autoscrolls.
5. Keep it pinned until selection collapses, copy completes, focus leaves the
   transcript, or the selected source disappears.
6. Cap the corridor at 200 leaves initially. The cap is tunable but must remain
   fixed with respect to transcript length.

This preserves ordinary native selection spanning rows and several viewports.
It deliberately trades away an arbitrarily large native selection that could
remount the entire transcript and recreate the failure. At the cap, stop
selection autoscroll and show a concise explanation directing the user to the
existing response/card full-copy controls. Never silently copy a partial range.

This is a visible parity adaptation:

- **🔁 adapted:** native cross-row selection remains exact within the fixed
  corridor; unbounded whole-transcript native selection is cut because it is
  structurally incompatible with the memory safety invariant.

A custom model-backed selection system could remove that limit, but it would
replace browser selection semantics, accessibility, hit testing, and clipboard
behavior. It is not justified for this fix.

### 7. Keep tool reveal and full-output behavior without mounting all lines

Progressive reveal should continue to change the logical amount available in
the inline body. It must no longer mean “create every revealed line as DOM.”
The 340 px output scroller renders only its visible line leaves and overscan.
The head/tail disclosure and true line numbers remain unchanged.

The full-output inspector keeps:

- complete source in JavaScript;
- full-output copy;
- wrap toggle;
- search over the complete line array;
- correct active-match navigation.

It virtualizes painted lines. Search navigation asks the line virtualizer to
scroll to the active index rather than attaching a ref to one of all mapped
lines. Selection in the inspector follows the same bounded-corridor rule.

### 8. Preserve display degradation and security behavior

Virtualization must remain downstream of the existing exhaustive row switches
and tolerant display fallbacks. Unknown runtime variants still render a quiet
fallback row; they do not throw because the planner does not recognize them.
Markdown raw HTML stays disabled, and rendering a subset must not add a raw-HTML
or URL path.

No transcript content, Markdown source, tool output, selection text, or source
snippets may enter operational health logs. Measurements added to diagnostics,
if any, are bounded numeric metadata only, such as mounted leaf count and
measured virtual height.

## Streaming and mutation behavior

### Bottom-locked streaming

When the user remains within the existing 120 px threshold:

1. append/project the frame;
2. update only the mutable tail plan;
3. render the bounded tail leaves;
4. batch measurements;
5. set the final scroll position from the new total virtual height.

The caret remains on the streaming tail. Offscreen settled Markdown is not
remounted or re-highlighted.

### Reading older content while the tail streams

When not bottom-locked:

- tail growth below the viewport changes total virtual height but not
  `scrollTop`;
- changes above the anchor preserve the anchor's viewport pixel offset;
- the jump-to-bottom control remains visible and retains the current live
  activity treatment;
- no stream frame may force the user back to the bottom.

### Regrouping and result arrival

A late tool result or a new adjacent tool can change component type and grouped
identity. Anchor recovery uses contained source-row IDs, and interaction state
uses `toolUseId`. The existing identity work is therefore an input to the
virtualizer, not something to replace.

### Session switch and split panels

A pane binding to another session keeps the current behavior: instant jump to
that session's latest content. There is no new “remember old scroll position”
feature.

Each split panel has an independent coordinator. Resizing one divider
invalidates height measurements for both adjacent panes because wrapping width
changed. The third pane is unaffected unless its width changes.

## Approaches rejected as complete fixes

The following can reduce paint or rerender work but do not cap DOM creation:

- row-only `react-window`, TanStack Virtual, or equivalent;
- `content-visibility: auto`;
- `IntersectionObserver` that hides whole rows only;
- CSS clipping, `max-height`, overflow, or collapsed bodies;
- `React.memo`, stable keys, and projector caches;
- measuring a giant row after first mounting it;
- larger overscan as a selection solution;
- retaining every row ever touched by a selection;
- progressive “reveal all” that permanently mounts all revealed lines;
- evicting JavaScript transcript state after the DOM has already allocated.

No new general virtualization dependency is recommended initially. The hard
parts here are semantic decomposition, state ownership, anchor compensation,
and selection. A list library does not solve the giant-row or grouped-composite
problem and would add an abstraction around the easier part. The existing
terminal `useVirtualScroll` should inform the implementation, but its Ink/Yoga
coupling and row-only unit make it unsuitable as the desktop hook.

## Implementation sequence and gates

### Stage 0: deterministic fixtures and pure-model tests

Before changing production rendering, add stress fixtures for:

- one append-only giant Markdown response;
- a huge fenced code block, list, table, blockquote, and single paragraph;
- thousands of mixed short rows;
- a huge revealed tool output and full-output inspector;
- a large expanded nested Agent transcript;
- one and three pane widths;
- bottom-locked streaming and reading older content during streaming;
- width changes and grouping changes above the viewport.

Test pure plan and height-index behavior without a browser:

- stable leaf IDs across append-only updates;
- fixed mounted-leaf bounds under 10x source growth;
- prefix sums and offset lookup;
- anchor compensation for insert, resize, regroup, and measurement correction;
- bottom anchoring;
- focus and selection pin release;
- interaction state surviving unmount/remount.

Implementation sessions that add or edit these tests must load the
`writing-cat-code-tests` skill.

### Stage 1: contain unbounded leaf bodies

Build, in this order:

1. positioned Markdown render plan;
2. bounded assistant and reasoning Markdown leaves;
3. open-fence streaming treatment and bounded highlighting;
4. line virtualization for inline tool output;
5. line virtualization for the full-output inspector;
6. recursive bounded handling for expanded nested transcript bodies;
7. generalized stable interaction state.

Keep the existing outer transcript map for this stage. This isolates the
highest-confidence memory intervention and keeps ordinary cross-row selection
unchanged outside giant composite bodies.

**Stage 1 measurement gate:** run the established one-long-turn workload and the
two-session file-summary reproduction. If these do not meet the primary memory
targets below, stop and attribute the remaining mounted DOM before adding outer
virtualization. Do not assume more list machinery will fix a leaf cap that did
not work.

Then run a separate three-pane workload with many short rows. If it remains
within the full targets and memory/region growth is flat as history grows 10x,
record that outer virtualization is not worth its selection and anchoring cost
and stop at Stage 1. This is the explicit cheaper-intervention exit.

### Stage 2: outer variable-height transcript virtualization

If many-short-row or three-pane growth fails the Stage 1 stop gate:

1. derive outer render leaves after current grouping;
2. add the pane-local prefix-sum height index;
3. render visible range, fixed overscan, and spacers;
4. integrate batched `ResizeObserver` measurements;
5. replace the current content-signature scroll correction with the shared
   anchor coordinator;
6. preserve instant session bind and explicit smooth jump behavior;
7. invalidate by pane-width revision.

Stage 2 is complete only when a 10x increase in historical rows does not
materially increase mounted transcript DOM.

### Stage 3: selection, focus, accessibility, and soak

Add and verify:

- bounded native selection corridor;
- focused-leaf pinning;
- keyboard traversal through mounted controls;
- correct source order and position metadata;
- rapid divider resize;
- rapid session switching;
- three simultaneous long transcripts;
- selection and focus during streamed height changes.

No current source-owned transcript Find implementation was found. Before Stage
2 ships, verify whether Electron's menu exposes native `findInPage` implicitly.
A browser-native find sees only mounted DOM. If the product currently promises
whole-transcript find, a model-backed transcript search is a separate
prerequisite; it must not be silently regressed as part of virtualization. The
terminal path at `src/components/VirtualMessageList.tsx:696-817` is useful prior
art: it searches retained source data, estimate-scrolls to mount the match, then
anchors precisely to the mounted element.

## Measurement plan and success thresholds

The operator runs live measurements. Implementation agents must not launch or
drive the desktop app without per-run authorization.

Use the established external method from
`docs/reports/2026-08-14-renderer-memory-attribution.md:117-130`:

- `footprint -p <renderer-pid>` for PartitionAlloc and V8 categories;
- `vmmap --summary <renderer-pid>` for region counts;
- do not open DevTools on a loaded renderer.

Record at the same points as the baseline: fresh launch, five minutes, ten
minutes, fifteen minutes, and settled turn completion. Record:

- total renderer footprint;
- PartitionAlloc resident and dirty bytes;
- V8 resident bytes;
- region count;
- mounted outer/Markdown/line leaves from bounded numeric instrumentation;
- renderer render-commit and responsiveness counters already available to the
  health path;
- visible anchor error and bottom gap in deterministic browser tests.

### Primary live targets

Under the same two-session, fifteen-minute reproduction:

- peak renderer footprint below **1.0 GB**, versus 3,974 MB;
- PartitionAlloc dirty below **700 MB**, versus 3.6 GB;
- region count below **3,000**, versus 13,018;
- no accelerating curve after the first five minutes;
- less than **5% region growth** during the final five minutes.

Under the one-long-streaming-turn reproduction:

- peak renderer footprint below **750 MB**, versus 4.7 GB;
- no allocation failure, renderer error boundary, or lost click handling;
- mounted leaf counts stay within their fixed budgets as source length grows.

Under a worst-case three-visible-pane run:

- total renderer footprint below **1.5 GB**;
- PartitionAlloc and mounted DOM grow approximately with three bounded
  viewports, not with total transcript history;
- after warm-up, footprint slope below **5 MB/minute**.

These are intentionally rough release thresholds, not expected exact plateaus.
A result that drops 3.97 GB to 2 GB is an improvement but not success: it leaves
the renderer on the same unbounded trajectory. The defining result is a curve
that flattens.

### Structural and interaction targets

- Increasing source transcript length by 10x increases mounted transcript DOM
  by no more than **15%** at a fixed viewport and state.
- No more than **12,000 transcript descendant elements per pane** or **36,000**
  across three panes during ordinary use.
- Anchor error is at most **2 px** after a settled measurement batch and at most
  **4 px cumulative** over 100 streamed, resized, and expanded updates.
- Bottom-locked gap is at most **2 px** after a measurement batch settles.
- No transcript-induced main-thread task exceeds **100 ms** in the stress
  fixture; p95 streaming render commit stays below **50 ms**.
- Tool expansion, inline reveal, reasoning collapse, and inspector identity
  survive scroll-out/remount and regrouping.
- Native copy is exact across at least three viewports and multiple row kinds;
  reaching the fixed corridor cap is disclosed, never silently truncated.

If the implementation cannot meet the leaf-count bound, do not accept good
memory from one short run as proof. If the count is bounded but PartitionAlloc
still climbs, inspect the mounted leaf types and Chromium allocations before
changing the architecture.

## Verification required for implementation

This document is docs-only. A later renderer implementation must run the full
`app/` battery from repository root:

```bash
bun test app/
bun run --cwd app typecheck
bun run --cwd app typecheck:sidecar
bun run --cwd app test:hardening
bun run --cwd app renderer:build
```

It must also run focused tests for the render plan, height index, scroll
anchoring, selection/focus pinning, interaction-state remount, Markdown
boundaries, inline output, and inspector. The implementation should invoke the
`verifying-cat-code-changes` skill and perform the exhaustive stale-reference
search required by `CLAUDE.md` before claiming completion.

Live memory acceptance remains operator-run because it requires launching the
app and driving the measured workload.

## Security, process model, and protocol impact

This design is renderer-local and read-only over already projected transcript
state.

- No protocol frame changes.
- No preload or host API changes are required for rendering.
- No renderer-authored engine state.
- No raw transcript or diagnostics content crosses a new boundary.
- Unix-domain socket transport, N-process sessions, raw `AppSessionEvent`
  fidelity, die-with-window lifetime, and the two-ID model remain unchanged.
- T4, T5a, T6/T6b, T7, HC1-HC4, directional frame limits, and `secretGuard` are
  untouched.

If numeric mounted-leaf instrumentation is added to the existing health bridge,
its closed schema and hardening allowlist must be updated in the normal way. It
must contain counts only. Virtualization itself does not require that bridge
change.

## Prototype parity and explicit deviations

Ordinary rendered content should be visually identical to the current app and
prototype grammar. Spacers are not visible UI. Markdown, syntax colors, grouping
chrome, tool reveal bands, inspector controls, copy actions, streaming caret,
scroll behavior, and jump-to-bottom behavior remain.

Explicit deviations:

- **🔁 adapted:** native selection is exact within a fixed contiguous corridor,
  not across an arbitrarily large transcript. This prevents selection from
  defeating the DOM cap.
- **🔁 adapted:** a single pathological atomic paragraph or inline token beyond
  the per-leaf ceiling uses a disclosed bounded viewer with full-source copy.
  This does not restore the rejected ordinary 60-line collapse.
- **🔁 adapted:** revealed tool output and full inspector output remain logically
  complete but paint only visible lines; this should have no visible difference
  except that very long output remains responsive.

No other visible parity cut is intended. Because this is an ad hoc design task,
not a dispatched migration surface session, there is no owned `STATUS.md` or
parity-ledger row to modify now. An implementation session must record these
adaptations in its own migration bookkeeping.

## Deliberately not solved

- Reclaiming PartitionAlloc pages after unmount. The measured allocator behavior
  makes prevention the goal.
- Reducing authoritative transcript or raw-message retention. V8 is not the
  dominant compartment, and source data is needed for restore, full copy,
  search, and remount.
- Replacing Markdown, GFM, or syntax highlighting with plain text globally.
- Changing transcript width or visual density to reduce wrapping.
- Remembering arbitrary old pane scroll positions across session switches.
- A custom whole-transcript selection engine.
- A new whole-transcript search UI unless the native-find verification finds a
  current behavior that Stage 2 would regress.
- Solving the separate renderer freeze mechanism. Virtualization should prevent
  the measured memory failure; it does not explain a freeze that occurs with
  flat memory and healthy render costs.

## Final implementation rule

Do not accept an implementation because it uses a library called a virtualizer
or because it mounts only a few top-level rows. Accept it only when:

1. every mounted leaf has a fixed DOM bound;
2. the same reproduction's PartitionAlloc and region curves flatten;
3. older-content anchoring and bottom-follow remain stable during streaming;
4. user-touched state survives remounts;
5. ordinary multi-row native selection still works, with the large-range trade
   disclosed rather than hidden.
